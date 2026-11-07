import { createHash } from 'node:crypto';
import {
  CORE_WORKSPACE_ITEM_KINDS,
  CORE_WORKSPACE_ITEM_RESOURCE,
  type CanopyErrorKind,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type CoreWorkspaceItem,
  type CoreWorkspaceItemImportErrorCode,
  type CoreWorkspaceItemImportOutcome,
  type CoreWorkspaceItemImportParams,
  type CoreWorkspaceItemImportResult,
  type CoreWorkspaceItemImportSource,
  type CoreWorkspaceItemKind,
  type CoreWorkspaceItemListResult,
  type CoreWorkspaceItemReadErrorCode,
  type CoreWorkspaceItemSourceError,
  type CoreWorkspaceItemSourceErrorCode,
  type CoreWorkspaceItemDeleteParams,
  type CoreWorkspaceItemDeleteResult,
  type CoreWorkspaceItemUpsertErrorCode,
  type CoreWorkspaceItemUpsertParams,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  decodeWorkspaceItemId,
  encodeStoredWorkspaceItemId,
  isAddressableWorkspaceItemScope,
  workspaceItemRefMatches,
  type CoreWorkspaceItemRef,
  type CoreWorkspaceItemScope,
} from './workspace-item-ids';

/*
 * `core.workspace.item.*` on one handler set that routes by kind. CAN-4105
 * serves `attachment` and the import; CAN-4152 adds `note` and `prompt`
 * providers (and the upsert/delete instructions) to the same router, with no
 * change to the get or list contract.
 */

/** How the host classifies a scope's workspace; shared by every kind. */
export type CoreWorkspaceItemScopeClass =
  /** A single- or multi-repository workspace. */
  | 'code'
  /** A Cowork or App Advisor workspace. */
  | 'workEntry'
  /** The read-only shared-container viewer. */
  | 'viewer';

/** Host port that resolves and validates scopes for every item kind. */
export interface CoreWorkspaceItemScopeHost {
  /** Validates the scope's IDs (throwing) and classifies its workspace. */
  classify(scope: CoreWorkspaceItemScope): CoreWorkspaceItemScopeClass;
  /** Whether a classify error rejected an ID. */
  isInvalidScope(error: unknown): boolean;
}

/** An admitted scope: its IDs fit and the host accepted them. */
export interface CoreWorkspaceItemAdmittedScope extends CoreWorkspaceItemScope {
  readonly scopeClass: CoreWorkspaceItemScopeClass;
}

/** The read side of one item kind, behind the shared scope admission. */
export interface CoreWorkspaceItemProvider {
  /**
   * The store the scope keeps this kind in, or null when the scope holds
   * none. Stable per store, so it can key locks.
   */
  storeKey(scope: CoreWorkspaceItemAdmittedScope): string | null;
  /** Every item of the kind in the scope, in its listing order. */
  list(
    scope: CoreWorkspaceItemAdmittedScope,
  ): Promise<readonly CoreWorkspaceItem[]>;
  /** The item a decoded ID names, or null when it does not exist. */
  get(
    ref: CoreWorkspaceItemRef,
    scope: CoreWorkspaceItemAdmittedScope,
  ): Promise<CoreWorkspaceItem | null>;
  /**
   * Create (`ref` null) or update an item at `expectedRevision`, returning it
   * as read back. Kinds without it answer `kindUnavailable` to `upsert`.
   * A call aborted before its write starts throws `cancelled`, writing nothing.
   * Once the write lands it calls `commit` with a read-back that writes
   * nothing, so a same-key repeat never writes twice.
   */
  upsert?(
    scope: CoreWorkspaceItemAdmittedScope,
    ref: CoreWorkspaceItemRef | null,
    expectedRevision: number | null,
    write: CoreWorkspaceItemWrite,
    signal: AbortSignal,
    commit: CoreWorkspaceItemReplayCommit<CoreWorkspaceItem>,
  ): Promise<CoreWorkspaceItem>;
  /**
   * Delete an item at `expectedRevision`; kinds without it answer
   * `kindUnavailable`. Aborts as `upsert` does.
   */
  delete?(
    ref: CoreWorkspaceItemRef,
    scope: CoreWorkspaceItemAdmittedScope,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The written fields of a text item `upsert`. */
export interface CoreWorkspaceItemWrite {
  readonly title: string;
  readonly content: string;
  readonly originWorktreeId: string | null;
}

/** One top-level file of an attachments store, as its host lists it. */
export interface CoreWorkspaceAttachmentEntry {
  readonly name: string;
  readonly sizeBytes: number;
  /** RFC 3339; the file's creation time. */
  readonly createdAt: string;
}

export type CoreWorkspaceAttachmentImportSource =
  | { readonly kind: 'host'; readonly handle: string }
  | {
      readonly kind: 'item';
      readonly scope: CoreWorkspaceItemAdmittedScope;
      readonly name: string;
    };

/** Attachment host failures the core tells apart; anything else is by errno. */
export type CoreWorkspaceAttachmentHostFailure =
  | 'unknownHandle'
  | 'filenameInvalid';

/**
 * Host port for attachment stores. The host resolves each store from trusted
 * state and stays the writer; params never carry its paths.
 */
export interface CoreWorkspaceAttachmentsHost {
  /** An opaque key for the scope's store (the core decides when one exists). */
  storeKey(scope: CoreWorkspaceItemAdmittedScope): string;
  /** The store's top-level files, newest first; a missing store is empty. */
  list(
    scope: CoreWorkspaceItemAdmittedScope,
  ): Promise<readonly CoreWorkspaceAttachmentEntry[]>;
  /** Copy one source into the scope's store under a fresh unique name. */
  importSource(
    scope: CoreWorkspaceItemAdmittedScope,
    source: CoreWorkspaceAttachmentImportSource,
  ): Promise<CoreWorkspaceAttachmentEntry>;
  classifyFailure(error: unknown): CoreWorkspaceAttachmentHostFailure | null;
}

export interface CoreWorkspaceItemHandlerOptions {
  readonly scopes: CoreWorkspaceItemScopeHost;
  readonly attachments: CoreWorkspaceAttachmentsHost;
  /** Providers for the other kinds (CAN-4152). */
  readonly providers?: Partial<
    Record<
      Exclude<CoreWorkspaceItemKind, 'attachment'>,
      CoreWorkspaceItemProvider
    >
  >;
  /** Import keys replayed in memory; defaults to 256. */
  readonly replayLimit?: number;
}

export interface CoreWorkspaceItemHandlers {
  queries: {
    'core.workspace.item.get': CanopyQueryHandler<
      'core.workspace.item.get',
      CanopyHandlerContext
    >;
    'core.workspace.item.list': CanopyQueryHandler<
      'core.workspace.item.list',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.workspace.item.import': CanopyInstructionHandler<
      'core.workspace.item.import',
      CanopyHandlerContext
    >;
    'core.workspace.item.upsert': CanopyInstructionHandler<
      'core.workspace.item.upsert',
      CanopyHandlerContext
    >;
    'core.workspace.item.delete': CanopyInstructionHandler<
      'core.workspace.item.delete',
      CanopyHandlerContext
    >;
  };
}

const NEVER = { kind: 'never' } as const;
export const CORE_WORKSPACE_ITEM_REPLAY_LIMIT = 256;

export type CoreWorkspaceItemErrorCode =
  | CoreWorkspaceItemReadErrorCode
  | CoreWorkspaceItemImportErrorCode
  | CoreWorkspaceItemUpsertErrorCode;

export function workspaceItemError(
  kind: CanopyErrorKind,
  code: CoreWorkspaceItemErrorCode,
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError({ kind, code, message, retry: NEVER }, cause);
}

/**
 * Shared scope admission: the ID bound, the host's ID validation and the
 * viewer refusal (`scopeUnavailable` for reads, `readOnlyScope` for writes),
 * the same for every kind.
 */
export function admitWorkspaceItemScope(
  scopes: CoreWorkspaceItemScopeHost,
  scope: CoreWorkspaceItemScope,
  kind: CoreWorkspaceItemKind,
  access: 'read' | 'write',
): CoreWorkspaceItemAdmittedScope {
  if (!isAddressableWorkspaceItemScope(scope, kind))
    throw workspaceItemError(
      'invalid_argument',
      'core.workspace.item.invalidScope',
      'The workspace and worktree IDs are too long to address items.',
    );
  let scopeClass: CoreWorkspaceItemScopeClass;
  try {
    scopeClass = scopes.classify(scope);
  } catch (error) {
    if (!scopes.isInvalidScope(error)) throw error;
    const message =
      error instanceof Error && error.message
        ? error.message.slice(0, 4_096)
        : 'The workspace or worktree ID is invalid.';
    throw workspaceItemError(
      'invalid_argument',
      'core.workspace.item.invalidScope',
      message,
      error,
    );
  }
  if (scopeClass === 'viewer')
    throw access === 'read'
      ? workspaceItemError(
          'capability_unavailable',
          'core.workspace.item.scopeUnavailable',
          'Items in this workspace cannot be read through this operation.',
        )
      : workspaceItemError(
          'failed_precondition',
          'core.workspace.item.readOnlyScope',
          'This workspace is read-only.',
        );
  return {
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    scopeClass,
  };
}

export function workspaceItemNotFound(): CanopyOperationError {
  return workspaceItemError(
    'not_found',
    'core.workspace.item.notFound',
    'The workspace item does not exist.',
  );
}

export function workspaceItemRevisionConflict(
  currentRevision: number,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'core.workspace.item.revisionConflict',
    message: 'The workspace item changed. Refresh it and try again.',
    details: { currentRevision },
    retry: { kind: 'after_refresh', resource: CORE_WORKSPACE_ITEM_RESOURCE },
  });
}

function kindUnavailable(kind: CoreWorkspaceItemKind): CanopyOperationError {
  return workspaceItemError(
    'capability_unavailable',
    'core.workspace.item.kindUnavailable',
    `Workspace items of kind ${kind} are not available.`,
  );
}

function attachmentItem(
  scope: CoreWorkspaceItemScope,
  entry: CoreWorkspaceAttachmentEntry,
): CoreWorkspaceItem {
  const itemId = encodeStoredWorkspaceItemId({
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    kind: 'attachment',
    name: entry.name,
  });
  // Admission bounds the scope, and a listed file always has a name.
  if (itemId === null) throw new Error('Unaddressable attachment.');
  // Attachments are write-once: one revision, created when last updated.
  return {
    itemId,
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    kind: 'attachment',
    title: entry.name,
    content: null,
    artifactId: null,
    mediaType: null,
    sizeBytes: entry.sizeBytes,
    origin: {},
    revision: 0,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

export interface CoreWorkspaceAttachmentProvider extends CoreWorkspaceItemProvider {
  findEntry(
    ref: CoreWorkspaceItemRef,
    scope: CoreWorkspaceItemAdmittedScope,
  ): Promise<CoreWorkspaceAttachmentEntry | null>;
}

/** The `attachment` provider over the host's stores. */
export function createAttachmentItemProvider(
  host: CoreWorkspaceAttachmentsHost,
): CoreWorkspaceAttachmentProvider {
  // A code workspace keeps attachments per worktree only.
  const storeKey = (scope: CoreWorkspaceItemAdmittedScope): string | null =>
    scope.worktreeId === null && scope.scopeClass !== 'workEntry'
      ? null
      : host.storeKey(scope);
  const findEntry = async (
    ref: CoreWorkspaceItemRef,
    scope: CoreWorkspaceItemAdmittedScope,
  ): Promise<CoreWorkspaceAttachmentEntry | null> => {
    if (storeKey(scope) === null) return null;
    const entries = await host.list(scope);
    return (
      entries.find((entry) => workspaceItemRefMatches(ref, entry.name)) ?? null
    );
  };
  return {
    storeKey,
    findEntry,
    async list(scope) {
      if (storeKey(scope) === null) return [];
      return (await host.list(scope)).map((entry) =>
        attachmentItem(scope, entry),
      );
    },
    async get(ref, scope) {
      const entry = await findEntry(ref, scope);
      return entry ? attachmentItem(scope, entry) : null;
    },
  };
}

function cursorDigest(
  scope: CoreWorkspaceItemScope,
  kinds: readonly CoreWorkspaceItemKind[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.workspaceId, scope.worktreeId, kinds]))
    .digest('hex')
    .slice(0, 16);
}

function readCursor(cursor: string | null, digest: string): number {
  if (cursor === null) return 0;
  const match = /^c1\.([0-9a-f]{16})\.(0|[1-9][0-9]{0,8})$/.exec(cursor);
  if (!match || match[1] !== digest)
    throw workspaceItemError(
      'invalid_argument',
      'core.workspace.item.invalidCursor',
      'The cursor does not belong to this list.',
    );
  return Number(match[2]);
}

const SOURCE_FAILURES: Record<
  CoreWorkspaceItemSourceErrorCode,
  { kind: CanopyErrorKind; message: string }
> = {
  'core.workspace.item.invalidItemId': {
    kind: 'invalid_argument',
    message: 'The source item ID is malformed.',
  },
  'core.workspace.item.kindUnavailable': {
    kind: 'capability_unavailable',
    message: 'Only attachment items can be imported.',
  },
  'core.workspace.item.sourceNotFound': {
    kind: 'not_found',
    message: 'The import source does not exist.',
  },
  'core.workspace.item.sourceNotFile': {
    kind: 'invalid_argument',
    message: 'The import source is not a regular file.',
  },
  'core.workspace.item.sourceAccessDenied': {
    kind: 'permission_denied',
    message: 'The import source cannot be read.',
  },
  'core.workspace.item.filenameInvalid': {
    kind: 'invalid_argument',
    message: 'The source file name cannot be stored.',
  },
  'core.workspace.item.writeFailed': {
    kind: 'internal',
    message: 'The attachment could not be written.',
  },
};

function failed(
  code: CoreWorkspaceItemSourceErrorCode,
): CoreWorkspaceItemImportOutcome {
  const error: CoreWorkspaceItemSourceError = {
    code,
    ...SOURCE_FAILURES[code],
  };
  return { status: 'failed', error };
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

// By errno; the copy reports source and target failures alike, so a
// target-side EACCES also reads as an unreadable source.
function sourceFailureCode(
  error: unknown,
  host: CoreWorkspaceAttachmentsHost,
): CoreWorkspaceItemSourceErrorCode {
  const failure = host.classifyFailure(error);
  if (failure === 'unknownHandle') return 'core.workspace.item.sourceNotFound';
  if (failure === 'filenameInvalid')
    return 'core.workspace.item.filenameInvalid';
  switch (errnoCode(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'core.workspace.item.sourceNotFound';
    // macOS copyfile reports a directory source as ENOTSUP.
    case 'EISDIR':
    case 'ENOTSUP':
      return 'core.workspace.item.sourceNotFile';
    case 'EACCES':
    case 'EPERM':
      return 'core.workspace.item.sourceAccessDenied';
    default:
      return 'core.workspace.item.writeFailed';
  }
}

/**
 * Marks a keyed call's effect as landed. `finish` completes the call without
 * repeating the effect, for a same-key repeat after the call still failed.
 */
export type CoreWorkspaceItemReplayCommit<Result> = (
  finish: () => Promise<Result>,
) => void;

export interface CoreWorkspaceItemReplayCache<Result> {
  /**
   * Run a keyed instruction once per principal and key: a repeat with the
   * same params returns the first result, other params fail with
   * `conflict` / `idempotencyKeyReused`. A refused call frees its key; one
   * that failed after `commit` keeps it, and a repeat runs only `finish`.
   */
  run(
    context: Pick<CanopyHandlerContext, 'caller' | 'metadata'>,
    params: unknown,
    execute: (commit: CoreWorkspaceItemReplayCommit<Result>) => Promise<Result>,
  ): Promise<Result>;
}

interface ReplayEntry<Result> {
  readonly fingerprint: string;
  /** Null after a committed call failed, until a repeat runs `finish`. */
  result: Promise<Result> | null;
  finish: (() => Promise<Result>) | null;
}

/** The in-memory replay rule shared by the item instructions. */
export function createWorkspaceItemReplayCache<Result>(
  limit = CORE_WORKSPACE_ITEM_REPLAY_LIMIT,
): CoreWorkspaceItemReplayCache<Result> {
  const entries = new Map<string, ReplayEntry<Result>>();
  const track = (
    key: string,
    entry: ReplayEntry<Result>,
    result: Promise<Result>,
  ): Promise<Result> => {
    entry.result = result;
    result.catch(() => {
      if (entries.get(key) !== entry || entry.result !== result) return;
      if (entry.finish) entry.result = null;
      else entries.delete(key);
    });
    return result;
  };
  return {
    run(context, params, execute) {
      const idempotencyKey = context.metadata.idempotencyKey;
      // The dispatcher refuses a keyed instruction without a key first.
      if (typeof idempotencyKey !== 'string') return execute(() => undefined);
      const key = JSON.stringify([context.caller.principalId, idempotencyKey]);
      // A digest, so an entry never keeps a second copy of large params.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(params))
        .digest('base64url');
      const existing = entries.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          return Promise.reject(
            workspaceItemError(
              'conflict',
              'core.workspace.item.idempotencyKeyReused',
              'This idempotency key was used with different params.',
            ),
          );
        if (existing.result) return existing.result;
        if (existing.finish) return track(key, existing, existing.finish());
      }
      const entry: ReplayEntry<Result> = {
        fingerprint,
        result: null,
        finish: null,
      };
      const result = execute((finish) => {
        entry.finish = finish;
      });
      entries.set(key, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return track(key, entry, result);
    },
  };
}

export function createCoreWorkspaceItemHandlers(
  options: CoreWorkspaceItemHandlerOptions,
): CoreWorkspaceItemHandlers {
  const { scopes, attachments: host } = options;
  const attachmentProvider = createAttachmentItemProvider(host);
  const provider = (
    kind: CoreWorkspaceItemKind,
  ): CoreWorkspaceItemProvider | undefined =>
    kind === 'attachment' ? attachmentProvider : options.providers?.[kind];
  const imports = createWorkspaceItemReplayCache<CoreWorkspaceItemImportResult>(
    options.replayLimit,
  );

  /** Resolves `null`, deciding nothing, when the call is already aborted. */
  const importOne = async (
    scope: CoreWorkspaceItemAdmittedScope,
    source: CoreWorkspaceItemImportSource,
    signal: AbortSignal,
  ): Promise<CoreWorkspaceItemImportOutcome | null> => {
    if (signal.aborted) return null;
    let hostSource: CoreWorkspaceAttachmentImportSource;
    if (source.kind === 'host') hostSource = source;
    else {
      const ref = decodeWorkspaceItemId(source.itemId);
      if (!ref) return failed('core.workspace.item.invalidItemId');
      if (ref.kind !== 'attachment')
        return failed('core.workspace.item.kindUnavailable');
      let entry: CoreWorkspaceAttachmentEntry | null = null;
      let sourceScope: CoreWorkspaceItemAdmittedScope | null = null;
      try {
        sourceScope = admitWorkspaceItemScope(
          scopes,
          ref,
          'attachment',
          'read',
        );
        entry = await attachmentProvider.findEntry(ref, sourceScope);
      } catch {
        // An unreadable or invalid source scope has no such item.
      }
      if (signal.aborted) return null;
      if (!entry || !sourceScope)
        return failed('core.workspace.item.sourceNotFound');
      hostSource = { kind: 'item', scope: sourceScope, name: entry.name };
    }
    try {
      const entry = await host.importSource(scope, hostSource);
      return { status: 'imported', item: attachmentItem(scope, entry) };
    } catch (error) {
      return failed(sourceFailureCode(error, host));
    }
  };

  const runImport = async (
    params: CoreWorkspaceItemImportParams,
    signal: AbortSignal,
  ): Promise<CoreWorkspaceItemImportResult> => {
    const scope = admitWorkspaceItemScope(
      scopes,
      { workspaceId: params.workspaceId, worktreeId: params.worktreeId },
      'attachment',
      'write',
    );
    if (attachmentProvider.storeKey(scope) === null)
      throw workspaceItemError(
        'failed_precondition',
        'core.workspace.item.unsupportedScope',
        'This scope does not hold attachments.',
      );
    const outcomes: CoreWorkspaceItemImportOutcome[] = [];
    let stopped = false;
    for (const source of params.sources) {
      // The copy in flight completes; the key replays what landed.
      const outcome: CoreWorkspaceItemImportOutcome | null = stopped
        ? null
        : await importOne(scope, source, signal);
      if (outcome === null && outcomes.length === 0)
        throw canopyCancelledError();
      outcomes.push(outcome ?? { status: 'notAttempted' });
      stopped ||= outcome === null || outcome.status === 'failed';
    }
    return { outcomes };
  };

  const upserts = createWorkspaceItemReplayCache<CoreWorkspaceItem>(
    options.replayLimit,
  );
  const deletes = createWorkspaceItemReplayCache<CoreWorkspaceItemDeleteResult>(
    options.replayLimit,
  );

  const runUpsert = async (
    params: CoreWorkspaceItemUpsertParams,
    signal: AbortSignal,
    commit: CoreWorkspaceItemReplayCommit<CoreWorkspaceItem>,
  ): Promise<CoreWorkspaceItem> => {
    const kindProvider = provider(params.kind);
    if (!kindProvider?.upsert) throw kindUnavailable(params.kind);
    const requested = {
      workspaceId: params.workspaceId,
      worktreeId: params.worktreeId,
    };
    const scope = admitWorkspaceItemScope(
      scopes,
      requested,
      params.kind,
      'write',
    );
    if (kindProvider.storeKey(scope) === null)
      throw workspaceItemError(
        'failed_precondition',
        'core.workspace.item.unsupportedScope',
        `This scope does not hold ${params.kind} items.`,
      );
    if (params.content === null || params.artifactId !== null)
      throw new CanopyOperationError({
        kind: 'invalid_argument',
        message: 'A note or prompt needs string content and no artifactId.',
        retry: NEVER,
      });
    if ((params.itemId === null) !== (params.expectedRevision === null))
      throw new CanopyOperationError({
        kind: 'invalid_argument',
        message:
          'An update needs both itemId and expectedRevision; a create needs neither.',
        retry: NEVER,
      });
    let ref: CoreWorkspaceItemRef | null = null;
    if (params.itemId !== null) {
      ref = decodeWorkspaceItemId(params.itemId);
      if (
        !ref ||
        ref.kind !== params.kind ||
        ref.workspaceId !== requested.workspaceId ||
        ref.worktreeId !== requested.worktreeId
      )
        throw workspaceItemError(
          'invalid_argument',
          'core.workspace.item.invalidItemId',
          'The item ID is malformed or names another kind or scope.',
        );
    }
    return kindProvider.upsert(
      scope,
      ref,
      params.expectedRevision,
      {
        title: params.title,
        content: params.content,
        originWorktreeId: params.originWorktreeId,
      },
      signal,
      commit,
    );
  };

  const runDelete = async (
    { itemId, expectedRevision }: CoreWorkspaceItemDeleteParams,
    signal: AbortSignal,
  ): Promise<CoreWorkspaceItemDeleteResult> => {
    const ref = decodeWorkspaceItemId(itemId);
    if (!ref)
      throw workspaceItemError(
        'invalid_argument',
        'core.workspace.item.invalidItemId',
        'The item ID is malformed.',
      );
    const kindProvider = provider(ref.kind);
    if (!kindProvider?.delete) throw kindUnavailable(ref.kind);
    const scope = admitWorkspaceItemScope(scopes, ref, ref.kind, 'write');
    if (kindProvider.storeKey(scope) === null) throw workspaceItemNotFound();
    await kindProvider.delete(ref, scope, expectedRevision, signal);
    return { deleted: true };
  };

  return {
    queries: {
      'core.workspace.item.get': async ({ itemId }) => {
        const ref = decodeWorkspaceItemId(itemId);
        if (!ref)
          throw workspaceItemError(
            'invalid_argument',
            'core.workspace.item.invalidItemId',
            'The item ID is malformed.',
          );
        const kindProvider = provider(ref.kind);
        if (!kindProvider) throw kindUnavailable(ref.kind);
        const scope = admitWorkspaceItemScope(scopes, ref, ref.kind, 'read');
        const item =
          kindProvider.storeKey(scope) === null
            ? null
            : await kindProvider.get(ref, scope);
        if (!item)
          throw workspaceItemError(
            'not_found',
            'core.workspace.item.notFound',
            'The workspace item does not exist.',
          );
        return item;
      },
      'core.workspace.item.list': async ({
        workspaceId,
        worktreeId,
        kinds,
        cursor,
        limit,
      }): Promise<CoreWorkspaceItemListResult> => {
        const requested = { workspaceId, worktreeId };
        const ordered = CORE_WORKSPACE_ITEM_KINDS.filter((kind) =>
          kinds.includes(kind),
        );
        const digest = cursorDigest(requested, ordered);
        const offset = readCursor(cursor, digest);
        const providers = ordered.map((kind) => {
          const kindProvider = provider(kind);
          if (!kindProvider) throw kindUnavailable(kind);
          return kindProvider;
        });
        // `attachment` is the longest kind, so its bound covers every kind.
        const scope = admitWorkspaceItemScope(
          scopes,
          requested,
          'attachment',
          'read',
        );
        const items: CoreWorkspaceItem[] = [];
        for (const kindProvider of providers)
          if (kindProvider.storeKey(scope) !== null)
            items.push(...(await kindProvider.list(scope)));
        const end = offset + limit;
        return {
          items: items.slice(offset, end),
          nextCursor: end < items.length ? `c1.${digest}.${end}` : null,
        };
      },
    },
    instructions: {
      'core.workspace.item.import': (params, context) =>
        imports.run(context, params, () => runImport(params, context.signal)),
      'core.workspace.item.upsert': (params, context) =>
        upserts.run(context, params, (commit) =>
          runUpsert(params, context.signal, commit),
        ),
      'core.workspace.item.delete': (params, context) =>
        deletes.run(context, params, () => runDelete(params, context.signal)),
    },
  };
}
