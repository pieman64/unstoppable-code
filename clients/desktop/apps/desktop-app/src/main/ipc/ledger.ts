import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  LEDGER_ENTRY_TYPES,
  LEDGER_GRANTS,
  LEDGER_LIMITS,
  LEDGER_STATUSES,
  LedgerEntryTypeSchema,
  LedgerStatusSchema,
  LedgerUuidSchema,
  LedgerAddEntryParamsSchema,
  LedgerEntriesSearchParamsSchema,
  LedgerEntryGetParamsSchema,
  LedgerErrorDetailsSchema,
  LedgerOwnersListParamsSchema,
  LedgerRequestKeySchema,
  LedgerUpdateEntryParamsSchema,
  LedgerGlobalOwnerSchema,
  isSameLedgerGlobalOwner,
  type CanopyCallerDescriptor,
  type LedgerAuthorDetails,
  type LedgerContainer,
  type LedgerEntriesSearchParams,
  type LedgerEntriesSearchResult,
  type LedgerOrigin,
} from '@canopy/protocol/canopy-core';
import {
  LEDGER_FEED_AUDIENCES,
  LEDGER_FEED_PERIODS,
  isLedgerTaskViewScope,
  ledgerViewScopeKey,
  type LedgerFeedPage,
  type LedgerGlobalViewScope,
  type LedgerViewChange,
  type LedgerViewChangedEvent,
  type LedgerViewEntry,
  type LedgerViewOwnerPage,
  type LedgerViewReceipt,
  type LedgerViewResult,
  type LedgerViewScope,
  type LedgerViewSource,
} from '@canopy/protocol/ledger-view';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CanopyOperationError } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getFeatureFlagService } from '../feature-flags';
import { LEDGER_USER_ACTOR_DISPLAY_NAME } from '../ledger/actor-directory';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from '../ledger/caller-bindings';
import {
  onLedgerEntryChanged,
  onLedgerSyncChanged,
} from '../ledger/change-events';
import { readLedgerGlobalAccountId } from '../ledger/core-ledger-adapter';
import { getLedgerFeedService } from '../ledger/feed-host';
import type {
  LedgerFeedScopeIncarnation,
  LedgerFeedService,
} from '../ledger/feed-service';
import { ledgerDatabaseMayExist } from '../ledger/lifecycle';
import {
  resolveArchivedLedgerContainerCreatedAt,
  resolveLedgerContainerCreatedAt,
} from '../ledger/scope-bindings';
import { getLedgerStoreClient } from '../ledger/storage-client';
import { resolveLedgerViewSource } from '../ledger/source-resolver';
import {
  ledgerContainerForViewScope,
  ledgerViewScopeForContainer,
} from '../ledger/view-scope';
import { isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/*
 * The Ledger panel's reads (phase 10) and writes (phase 11). Each call goes
 * through the desktop dispatcher to `core.ledger.*` as the local user, with a
 * binding registered for that one call and only the grant its operation
 * needs, so the panel gets no shortcut into the Ledger service and every
 * write meets the same policy as an agent's. A write's request key is its
 * idempotency key, so retrying a draft never records it twice. Committed
 * changes reach every window as IDs and revisions only, at most once per
 * 100 ms.
 */

/** A read's user binding outlives the read by at most this. */
const USER_BINDING_TTL_MS = 60_000;
/** Committed changes are coalesced and broadcast at most this often. */
export const LEDGER_CHANGE_BROADCAST_INTERVAL_MS = 100;

const USER_AUTHOR_DETAILS: LedgerAuthorDetails = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

/** No database means nothing was ever recorded, in any scope. */
const EMPTY_SEARCH_RESULT: LedgerEntriesSearchResult = {
  entries: [],
  nextCursor: null,
  hasMore: false,
  watermark: '0',
  actors: [],
};

/** What the handlers need from the app; tests substitute their own. */
export interface LedgerIpcHost {
  /** `canopy-ledger-enabled`. */
  readonly isEnabled: () => boolean;
  /** False only when the Ledger database has certainly never been created. */
  readonly databaseMayExist: () => Promise<boolean>;
  readonly registry: () => {
    register(registration: LedgerCallerBindingRegistration): string;
    revoke(bindingId: string): boolean;
  };
  readonly container: (scope: LedgerViewScope) => LedgerContainer | null;
  /** Null when the container no longer exists. */
  readonly containerCreatedAt: (
    container: LedgerContainer,
  ) => Promise<string | null>;
  /**
   * The creation time of the container's one archived scope, for reads once
   * the container is gone from its registry. Null when there is none.
   */
  readonly archivedContainerCreatedAt: (
    container: LedgerContainer,
  ) => Promise<string | null>;
  readonly resolveSource: (
    scope: LedgerViewScope,
    origin: LedgerOrigin,
  ) => Promise<LedgerViewSource>;
  /** A stored scope by its ledger ID, read without minting; null if none. */
  readonly globalScope: (ledgerId: string) => Promise<{
    readonly container: LedgerContainer;
    readonly containerCreatedAt: string;
    readonly accountId: string | null;
  } | null>;
  /**
   * The account a global Ledger belongs to: the signed-in account's server
   * ID, or null when signed out. Throws when the account cannot be read.
   */
  readonly accountId: () => Promise<string | null>;
}

function isLedgerFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    );
  } catch {
    return false;
  }
}

export const DESKTOP_LEDGER_IPC_HOST: LedgerIpcHost = {
  isEnabled: isLedgerFlagEnabled,
  databaseMayExist: ledgerDatabaseMayExist,
  registry: getLedgerCallerBindingRegistry,
  container: ledgerContainerForViewScope,
  containerCreatedAt: resolveLedgerContainerCreatedAt,
  archivedContainerCreatedAt: async (container): Promise<string | null> =>
    (await ledgerDatabaseMayExist())
      ? resolveArchivedLedgerContainerCreatedAt(
          container,
          getLedgerStoreClient(),
        )
      : null,
  resolveSource: (scope, origin): Promise<LedgerViewSource> =>
    resolveLedgerViewSource(scope, origin),
  globalScope: async (ledgerId) => {
    const scope = await getLedgerStoreClient().getScope(ledgerId);
    return scope === null
      ? null
      : {
          container: scope.scope.container,
          containerCreatedAt: scope.containerCreatedAt,
          accountId: scope.accountId,
        };
  },
  accountId: readLedgerGlobalAccountId,
};

type ScopeResolution =
  | {
      readonly kind: 'ready';
      readonly scope: LedgerViewScope;
      readonly container: LedgerContainer;
      readonly containerCreatedAt: string;
    }
  /** Nothing was ever recorded: no database exists. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'done'; readonly result: LedgerViewResult<never> };

function invalidRequest(message: string): LedgerViewResult<never> {
  return { status: 'error', reason: 'INVALID_INPUT', message };
}

/** A global (workflow) Ledger's view scope, as the renderer sends it. */
const LedgerGlobalViewScopeSchema = z.strictObject({
  kind: z.literal('global'),
  owner: LedgerGlobalOwnerSchema,
  ledgerId: LedgerUuidSchema,
});

function readViewScope(value: unknown): LedgerViewScope | null {
  if (!isRecord(value)) return null;
  if ('kind' in value) {
    const global = LedgerGlobalViewScopeSchema.safeParse(value);
    return global.success ? global.data : null;
  }
  const { projectId, worktreeId } = value;
  try {
    validateId(projectId, 'project ID');
    validateId(worktreeId, 'worktree ID');
  } catch {
    return null;
  }
  return { projectId, worktreeId };
}

/**
 * The scope a panel call targets. There is deliberately no account check:
 * the panel reads this device's local canonical data whoever is signed in
 * (LD03), as the scope's chats, terminals and agent tools do. A scope's
 * account binding fences what it syncs (LD02) and what the Feed shows (LD03);
 * the renderer resets its retained views when the account changes.
 */
async function resolveScope(
  value: unknown,
  host: LedgerIpcHost,
  options: { readonly creates: boolean } = { creates: false },
): Promise<ScopeResolution> {
  const scope = readViewScope(value);
  if (scope === null) {
    return { kind: 'done', result: invalidRequest('Unknown Feed scope.') };
  }
  if (!host.isEnabled()) {
    return {
      kind: 'done',
      result: { status: 'unavailable', reason: 'disabled' },
    };
  }
  if (!isLedgerTaskViewScope(scope)) return resolveGlobalScope(scope, host);
  const container = host.container(scope);
  const liveCreatedAt =
    container === null ? null : await host.containerCreatedAt(container);
  // An archived container is gone from its registry, yet its Ledger stays
  // readable, as the Feed lists it. Writes still need the live container.
  const containerCreatedAt =
    container !== null && liveCreatedAt === null && !options.creates
      ? await host.archivedContainerCreatedAt(container)
      : liveCreatedAt;
  if (container === null || containerCreatedAt === null) {
    return {
      kind: 'done',
      result: { status: 'unavailable', reason: 'no_scope' },
    };
  }
  // A write (or the owners a write offers) creates the database; a read of
  // a database that was never created has nothing to find.
  if (!options.creates && !(await host.databaseMayExist())) {
    return { kind: 'empty' };
  }
  return { kind: 'ready', scope, container, containerCreatedAt };
}

/**
 * A global (workflow) Ledger, addressed by its `ledgerId`. It is never
 * minted here: a view only reads, corrects or updates what agents recorded.
 * The stored scope must be a global one of the same owner, bound to the
 * signed-in account (or the signed-out one while signed out), or the view
 * has no scope: another account's Ledger never answers.
 */
async function resolveGlobalScope(
  scope: LedgerGlobalViewScope,
  host: LedgerIpcHost,
): Promise<ScopeResolution> {
  const noScope: ScopeResolution = {
    kind: 'done',
    result: { status: 'unavailable', reason: 'no_scope' },
  };
  if (!(await host.databaseMayExist())) return noScope;
  const stored = await host.globalScope(scope.ledgerId);
  // An account that cannot be read is no account's: never the signed-out one.
  const accountId = await host.accountId().catch((): undefined => undefined);
  if (
    stored === null ||
    stored.container.kind !== 'global' ||
    !isSameLedgerGlobalOwner(stored.container.owner, scope.owner) ||
    stored.accountId !== accountId
  ) {
    return noScope;
  }
  return {
    kind: 'ready',
    scope,
    container: stored.container,
    containerCreatedAt: stored.containerCreatedAt,
  };
}

/**
 * Runs one call as the local user of the scope, through a binding registered
 * for that call only and holding only the given grant.
 */
async function asLocalUser<Result>(
  resolution: Extract<ScopeResolution, { kind: 'ready' }>,
  ipcCaller: CanopyCallerDescriptor,
  host: LedgerIpcHost,
  grant: CanopyCallerDescriptor['grants'][number],
  call: (caller: CanopyCallerDescriptor) => Promise<Result>,
): Promise<Result> {
  const registry = host.registry();
  const bindingId = registry.register({
    container: resolution.container,
    containerCreatedAt: resolution.containerCreatedAt,
    actor: {
      kind: 'user',
      originKey: 'local',
      displayName: LEDGER_USER_ACTOR_DISPLAY_NAME,
    },
    role: 'user',
    authorDetails: USER_AUTHOR_DETAILS,
    runtimeGeneration: 0,
    ttlMs: USER_BINDING_TTL_MS,
  });
  try {
    return await call({
      principalId: bindingId,
      clientInstanceId: ipcCaller.clientInstanceId,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: [grant],
    });
  } finally {
    registry.revoke(bindingId);
  }
}

function errorResult(error: unknown): LedgerViewResult<never> {
  if (error instanceof CanopyOperationError) {
    const details = LedgerErrorDetailsSchema.safeParse(error.payload.details);
    return {
      status: 'error',
      reason: details.success ? details.data.reason : 'UNKNOWN',
      message: error.payload.message,
    };
  }
  return {
    status: 'error',
    reason: 'UNKNOWN',
    message: 'The Feed could not be read.',
  };
}

/** One page of a scope's entries, for the Ledger panel. */
export async function searchLedgerEntriesForView(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerEntriesSearchResult>> {
  if (!isRecord(request)) return invalidRequest('Missing Feed request.');
  const params = LedgerEntriesSearchParamsSchema.safeParse(request.params);
  if (!params.success) return invalidRequest('Invalid Feed search.');
  try {
    const resolution = await resolveScope(request.scope, host);
    if (resolution.kind === 'done') return resolution.result;
    if (resolution.kind === 'empty') {
      return { status: 'ok', value: EMPTY_SEARCH_RESULT };
    }
    const value = await asLocalUser(
      resolution,
      ipcCaller,
      host,
      LEDGER_GRANTS.read,
      (caller) =>
        dispatcher.query('core.ledger.entries.search', params.data, { caller }),
    );
    return { status: 'ok', value };
  } catch (error) {
    return errorResult(error);
  }
}

/** One entry with a page of its history and its source, for the detail. */
export async function getLedgerEntryForView(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerViewEntry>> {
  if (!isRecord(request)) return invalidRequest('Missing Feed request.');
  const params = LedgerEntryGetParamsSchema.safeParse({
    entryId: request.entryId,
    includeHistory: true,
    ...(request.historyCursor === undefined
      ? {}
      : { historyCursor: request.historyCursor }),
  });
  if (!params.success) return invalidRequest('Invalid Feed entry.');
  try {
    const resolution = await resolveScope(request.scope, host);
    if (resolution.kind === 'done') return resolution.result;
    if (resolution.kind === 'empty') {
      return {
        status: 'error',
        reason: 'NOT_FOUND',
        message: 'This entry no longer exists.',
      };
    }
    const entry = await asLocalUser(
      resolution,
      ipcCaller,
      host,
      LEDGER_GRANTS.read,
      (caller) =>
        dispatcher.query('core.ledger.entry.get', params.data, { caller }),
    );
    let source: LedgerViewSource | null;
    try {
      source = await host.resolveSource(resolution.scope, entry.entry.origin);
    } catch {
      // The entry still reads; its source could not be checked right now.
      source = null;
    }
    return { status: 'ok', value: { entry, source } };
  } catch (error) {
    return errorResult(error);
  }
}

/** A write's request key, as the Ledger accepts an idempotency key. */
function readRequestKey(value: unknown): string | null {
  const parsed = LedgerRequestKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Adds an entry as the person using the panel. */
export async function addLedgerEntryForView(
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerViewReceipt>> {
  if (!isRecord(request)) return invalidRequest('Missing Feed request.');
  const requestKey = readRequestKey(request.requestKey);
  if (requestKey === null) return invalidRequest('Missing request key.');
  const params = LedgerAddEntryParamsSchema.safeParse(request.params);
  if (!params.success) return invalidRequest('Invalid Feed entry.');
  try {
    const resolution = await resolveScope(request.scope, host, {
      creates: true,
    });
    if (resolution.kind !== 'ready') {
      return resolution.kind === 'done'
        ? resolution.result
        : invalidRequest('Unknown Feed scope.');
    }
    // Agents record a global (workflow) Ledger; people only correct it.
    if (
      !isLedgerTaskViewScope(resolution.scope) &&
      params.data.supersedesEntryId === undefined
    ) {
      return invalidRequest('Workflow entries can only be corrected.');
    }
    const value = await asLocalUser(
      resolution,
      ipcCaller,
      host,
      LEDGER_GRANTS.write,
      (caller) =>
        dispatcher.instruction(
          'core.ledger.entry.add',
          { ...params.data, _meta: { idempotencyKey: requestKey } },
          { caller, metadata: { idempotencyKey: requestKey } },
        ),
    );
    return { status: 'ok', value };
  } catch (error) {
    return errorResult(error);
  }
}

/** Changes an entry's status or owner as the person using the panel. */
export async function updateLedgerEntryForView(
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerViewReceipt>> {
  if (!isRecord(request)) return invalidRequest('Missing Feed request.');
  const requestKey = readRequestKey(request.requestKey);
  if (requestKey === null) return invalidRequest('Missing request key.');
  const params = LedgerUpdateEntryParamsSchema.safeParse(request.params);
  if (!params.success) return invalidRequest('Invalid Feed change.');
  try {
    const resolution = await resolveScope(request.scope, host, {
      creates: true,
    });
    if (resolution.kind !== 'ready') {
      return resolution.kind === 'done'
        ? resolution.result
        : invalidRequest('Unknown Feed scope.');
    }
    const value = await asLocalUser(
      resolution,
      ipcCaller,
      host,
      LEDGER_GRANTS.write,
      (caller) =>
        dispatcher.instruction(
          'core.ledger.entry.update',
          { ...params.data, _meta: { idempotencyKey: requestKey } },
          { caller, metadata: { idempotencyKey: requestKey } },
        ),
    );
    return { status: 'ok', value };
  } catch (error) {
    return errorResult(error);
  }
}

/** One page of the owners the person using the panel may assign. */
export async function listLedgerOwnersForView(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerViewOwnerPage>> {
  if (!isRecord(request)) return invalidRequest('Missing Feed request.');
  const params = LedgerOwnersListParamsSchema.safeParse({
    limit: LEDGER_LIMITS.ownersPageMax,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  });
  if (!params.success) return invalidRequest('Invalid owner request.');
  try {
    const resolution = await resolveScope(request.scope, host, {
      creates: true,
    });
    if (resolution.kind !== 'ready') {
      return resolution.kind === 'done'
        ? resolution.result
        : invalidRequest('Unknown Feed scope.');
    }
    const value = await asLocalUser(
      resolution,
      ipcCaller,
      host,
      LEDGER_GRANTS.read,
      (caller) =>
        dispatcher.query('core.ledger.owners.list', params.data, { caller }),
    );
    return { status: 'ok', value };
  } catch (error) {
    return errorResult(error);
  }
}

const ACTOR_FILTER = z.enum(['anyone', 'you']);

/** A Feed search as the renderer sends it. */
const LedgerFeedRequestSchema = z.strictObject({
  audience: z.enum(LEDGER_FEED_AUDIENCES),
  query: z.string().max(4 * LEDGER_LIMITS.searchQueryMaxCodePoints),
  filters: z.strictObject({
    types: z.array(LedgerEntryTypeSchema).max(LEDGER_ENTRY_TYPES.length),
    statuses: z.array(LedgerStatusSchema).max(LEDGER_STATUSES.length),
    owner: ACTOR_FILTER,
    author: ACTOR_FILTER,
    period: z.enum(LEDGER_FEED_PERIODS),
    includeArchived: z.boolean(),
  }),
  cursor: z.string().min(1).max(128).optional(),
  refresh: z.boolean().optional(),
  peek: z.boolean().optional(),
});

const LedgerFeedEntryRequestSchema = z.strictObject({
  entryId: LedgerUuidSchema,
  historyCursor: z.string().min(1).max(16).optional(),
});

/**
 * One page of one of this device's scopes, for the Feed. The Feed lists the
 * scopes the Ledger store holds, so it names each by the container
 * incarnation the store records rather than the live registry: an archived
 * container is gone from its registry, yet its scope stays readable. Reads
 * only; every write still resolves its container through the registry.
 */
async function searchLedgerScopeForFeed(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  ipcCaller: CanopyCallerDescriptor,
  scope: LedgerViewScope,
  params: LedgerEntriesSearchParams,
  incarnation: LedgerFeedScopeIncarnation,
  host: LedgerIpcHost,
): Promise<LedgerViewResult<LedgerEntriesSearchResult>> {
  if (!host.isEnabled()) return { status: 'unavailable', reason: 'disabled' };
  try {
    if (!(await host.databaseMayExist())) {
      return { status: 'ok', value: EMPTY_SEARCH_RESULT };
    }
    const value = await asLocalUser(
      {
        kind: 'ready',
        scope,
        container: incarnation.container,
        containerCreatedAt: incarnation.containerCreatedAt,
      },
      ipcCaller,
      host,
      LEDGER_GRANTS.read,
      (caller) =>
        dispatcher.query('core.ledger.entries.search', params, { caller }),
    );
    return { status: 'ok', value };
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * One page of the global Feed. This device's scopes are read through the
 * dispatcher as the local user, one scope per call, as the Ledger panel reads
 * them; the Feed service merges them with the mirror's rows.
 */
export async function searchLedgerFeedForView(
  feed: Pick<LedgerFeedService, 'search'>,
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  ipcCaller: CanopyCallerDescriptor,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerFeedPage>> {
  if (!host.isEnabled()) return { status: 'unavailable', reason: 'disabled' };
  const parsed = LedgerFeedRequestSchema.safeParse(request);
  if (!parsed.success) return invalidRequest('Invalid Feed search.');
  try {
    return await feed.search(parsed.data, {
      searchScope: (scope, params, incarnation) =>
        searchLedgerScopeForFeed(
          dispatcher,
          ipcCaller,
          scope,
          params,
          incarnation,
          host,
        ),
    });
  } catch {
    return {
      status: 'error',
      reason: 'UNKNOWN',
      message: "Couldn't load the Feed.",
    };
  }
}

/** A Feed row of another device or a teammate, for the read-only detail. */
export async function getLedgerFeedEntryForView(
  feed: Pick<LedgerFeedService, 'getEntry'>,
  request: unknown,
  host: LedgerIpcHost = DESKTOP_LEDGER_IPC_HOST,
): Promise<LedgerViewResult<LedgerViewEntry>> {
  if (!host.isEnabled()) return { status: 'unavailable', reason: 'disabled' };
  const parsed = LedgerFeedEntryRequestSchema.safeParse(request);
  if (!parsed.success) return invalidRequest('Invalid Feed entry.');
  try {
    return await feed.getEntry(parsed.data);
  } catch {
    return {
      status: 'error',
      reason: 'UNKNOWN',
      message: "Couldn't load this entry.",
    };
  }
}

export interface LedgerChangeBroadcaster {
  push(change: LedgerViewChange): void;
  /** A scope's entries, or every scope's, changed how they sync. */
  pushSyncChange(scope: LedgerViewScope | 'all'): void;
  dispose(): void;
}

/**
 * Coalesces committed changes: one event at most every `intervalMs`, carrying
 * each changed entry once at its latest revision and each scope whose sync
 * changed once, or `all` in place of every scope.
 */
export function createLedgerChangeBroadcaster(
  send: (event: LedgerViewChangedEvent) => void,
  intervalMs: number = LEDGER_CHANGE_BROADCAST_INTERVAL_MS,
): LedgerChangeBroadcaster {
  const pending = new Map<string, LedgerViewChange>();
  const syncChanged = new Map<string, LedgerViewScope>();
  let allSyncChanged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0 && syncChanged.size === 0 && !allSyncChanged) {
      return;
    }
    const changes = Array.from(pending.values());
    const sync: readonly LedgerViewScope[] | 'all' | undefined = allSyncChanged
      ? 'all'
      : syncChanged.size > 0
        ? Array.from(syncChanged.values())
        : undefined;
    pending.clear();
    syncChanged.clear();
    allSyncChanged = false;
    send(sync === undefined ? { changes } : { changes, syncChanged: sync });
  };
  return {
    push(change): void {
      const key = JSON.stringify([
        ledgerViewScopeKey(change.scope),
        change.entryId,
      ]);
      const previous = pending.get(key);
      const latest =
        previous === undefined || previous.revision < change.revision
          ? change
          : previous;
      const titleResolved =
        previous?.titleResolved === true || change.titleResolved === true;
      pending.set(
        key,
        titleResolved ? { ...latest, titleResolved: true } : latest,
      );
      timer ??= setTimeout(flush, intervalMs);
    },
    pushSyncChange(scope): void {
      if (scope === 'all') allSyncChanged = true;
      else syncChanged.set(ledgerViewScopeKey(scope), scope);
      timer ??= setTimeout(flush, intervalMs);
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      syncChanged.clear();
      allSyncChanged = false;
    },
  };
}

let disposeChangeBroadcast: (() => void) | undefined;

export function registerLedgerHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[unknown], LedgerViewResult<LedgerEntriesSearchResult>>(
    IPC_CHANNELS.ledgerSearchEntries,
    (event: IpcMainInvokeEvent, request) =>
      searchLedgerEntriesForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerViewEntry>>(
    IPC_CHANNELS.ledgerGetEntry,
    (event: IpcMainInvokeEvent, request) =>
      getLedgerEntryForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerViewReceipt>>(
    IPC_CHANNELS.ledgerAddEntry,
    (event: IpcMainInvokeEvent, request) =>
      addLedgerEntryForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerViewReceipt>>(
    IPC_CHANNELS.ledgerUpdateEntry,
    (event: IpcMainInvokeEvent, request) =>
      updateLedgerEntryForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerViewOwnerPage>>(
    IPC_CHANNELS.ledgerListOwners,
    (event: IpcMainInvokeEvent, request) =>
      listLedgerOwnersForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerFeedPage>>(
    IPC_CHANNELS.ledgerFeedSearch,
    (event: IpcMainInvokeEvent, request) =>
      searchLedgerFeedForView(
        getLedgerFeedService(),
        dispatcher,
        resolveCaller(event),
        request,
      ),
  );
  registerIpcHandler<[unknown], LedgerViewResult<LedgerViewEntry>>(
    IPC_CHANNELS.ledgerFeedGetEntry,
    (_event: IpcMainInvokeEvent, request) =>
      getLedgerFeedEntryForView(getLedgerFeedService(), request),
  );
  disposeChangeBroadcast?.();
  const broadcaster = createLedgerChangeBroadcaster((event): void =>
    sendToAllWindows(IPC_CHANNELS.ledgerEntriesChanged, event),
  );
  const unsubscribe = onLedgerEntryChanged((change): void =>
    broadcaster.push({
      scope: ledgerViewScopeForContainer(change.container, change.ledgerId),
      entryId: change.entryId,
      revision: change.revision,
      ...(change.titleResolved === true ? { titleResolved: true } : {}),
    }),
  );
  const unsubscribeSync = onLedgerSyncChanged((change): void =>
    broadcaster.pushSyncChange(
      change.kind === 'scope'
        ? ledgerViewScopeForContainer(change.container, change.ledgerId)
        : 'all',
    ),
  );
  disposeChangeBroadcast = (): void => {
    unsubscribe();
    unsubscribeSync();
    broadcaster.dispose();
  };
}
