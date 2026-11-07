import { createHash } from 'node:crypto';
import {
  CoreWorkspaceItemTimestampSchema,
  type CoreWorkspaceItem,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
import {
  encodeStoredWorkspaceItemId,
  workspaceItemRefMatches,
  type CoreWorkspaceItemRef,
} from './workspace-item-ids';
import {
  workspaceItemNotFound,
  workspaceItemRevisionConflict,
  type CoreWorkspaceItemAdmittedScope,
  type CoreWorkspaceItemProvider,
} from './workspace-items';

/*
 * `note` and `prompt` providers for the `core.workspace.item.*` router. Notes
 * and prompts belong to the workspace scope only. The host stays the writer
 * and resolves each store from trusted state; the core computes revisions,
 * serializes each store and checks `expectedRevision` before every write.
 */

export type CoreWorkspaceTextItemKind = 'note' | 'prompt';

export interface CoreWorkspaceTextItemOrigin {
  readonly worktreeId?: string;
  readonly branchName?: string;
  readonly worktreeExists?: boolean;
}

/** One stored note or prompt, as its host reads it. */
export interface CoreWorkspaceTextItemEntry {
  /** The file stem; it keys the item ID. */
  readonly name: string;
  /** The stored or derived title, uncut. */
  readonly title: string;
  /** The store's own times, which may not be valid timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** RFC 3339 file times, used when a store time is not one. */
  readonly fileCreatedAt: string;
  readonly fileUpdatedAt: string;
  readonly origin: CoreWorkspaceTextItemOrigin;
  /** The stored bytes, a prompt's frontmatter included. */
  readonly raw: Uint8Array;
}

export interface CoreWorkspaceTextItemDocument extends CoreWorkspaceTextItemEntry {
  /** The Markdown body, without a prompt's frontmatter. */
  readonly content: string;
}

export interface CoreWorkspaceTextItemSave {
  /** The stored name of the item to update, or null to create one. */
  readonly name: string | null;
  readonly title: string;
  readonly content: string;
  readonly originWorktreeId: string | null;
}

/**
 * Host port for note and prompt stores. Hosts never return paths; unreadable
 * files are left out of `list` or fail it, as the store always has.
 */
export interface CoreWorkspaceTextItemsHost {
  /** An opaque key for the scope's store of the kind; equal for aliases. */
  storeKey(
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
  ): string;
  /** Every stored item, in the store's listing order. */
  list(
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
  ): Promise<readonly CoreWorkspaceTextItemEntry[]>;
  /**
   * One stored item by its exact stored name, or null when there is none. A
   * spelling the filesystem only resolves by folding case or normalization
   * is not the item: each item has one ID, and writes key on the name.
   */
  read(
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
    name: string,
  ): Promise<CoreWorkspaceTextItemDocument | null>;
  /** Write through the store's writer; returns the stored name. */
  save(
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
    input: CoreWorkspaceTextItemSave,
  ): Promise<string>;
  delete(
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
    name: string,
  ): Promise<void>;
}

// The item schema's `title` and `content` bounds.
const TITLE_MAX = 512;
const CONTENT_MAX = 2_000_000;

/**
 * The opaque revision: the first 48 bits of a digest of the kind, the stored
 * title and the stored bytes, so any edit to either changes it.
 */
export function workspaceTextItemRevision(
  kind: CoreWorkspaceTextItemKind,
  title: string,
  raw: Uint8Array,
): number {
  const digest = createHash('sha256')
    .update(kind, 'utf8')
    .update(Uint8Array.of(0))
    .update(title, 'utf8')
    .update(Uint8Array.of(0))
    .update(raw)
    .digest();
  return digest.readUIntBE(0, 6);
}

function cutTitle(title: string, name: string): string {
  const fallback = title === '' ? name.replace(/-/g, ' ') : title;
  if (fallback.length <= TITLE_MAX) return fallback;
  const cut = fallback.slice(0, TITLE_MAX);
  // Never end on half of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function validTime(value: string, fallback: string): string {
  return CoreWorkspaceItemTimestampSchema.safeParse(value).success
    ? value
    : fallback;
}

function itemOrigin(
  origin: CoreWorkspaceTextItemOrigin,
): CoreWorkspaceItem['origin'] {
  return {
    ...(origin.worktreeId !== undefined
      ? { worktreeId: origin.worktreeId }
      : {}),
    ...(origin.branchName !== undefined
      ? { branchName: origin.branchName.slice(0, 512) }
      : {}),
    ...(origin.worktreeExists !== undefined
      ? { worktreeExists: origin.worktreeExists }
      : {}),
  };
}

/** The canonical item, or null when its name has no item ID. */
export function workspaceTextItem(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
  entry: CoreWorkspaceTextItemEntry,
  content: string | null,
): CoreWorkspaceItem | null {
  const itemId = encodeStoredWorkspaceItemId({
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    kind,
    name: entry.name,
  });
  if (itemId === null) return null;
  if (content !== null && content.length > CONTENT_MAX)
    throw new CanopyOperationError({
      kind: 'resource_exhausted',
      message: `The ${kind} is larger than an item's content allows.`,
      retry: { kind: 'never' },
    });
  return {
    itemId,
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    kind,
    title: cutTitle(entry.title, entry.name),
    content,
    artifactId: null,
    mediaType: 'text/markdown',
    sizeBytes: null,
    origin: itemOrigin(entry.origin),
    revision: workspaceTextItemRevision(kind, entry.title, entry.raw),
    createdAt: validTime(entry.createdAt, entry.fileCreatedAt),
    updatedAt: validTime(entry.updatedAt, entry.fileUpdatedAt),
  };
}

/** One async mutex per key; callers run one at a time, in arrival order. */
export function createWorkspaceItemStoreLocks(): <Result>(
  key: string,
  operation: () => Promise<Result>,
) => Promise<Result> {
  const tails = new Map<string, Promise<void>>();
  return (key, operation) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

export type CoreWorkspaceTextItemProviders = Record<
  CoreWorkspaceTextItemKind,
  CoreWorkspaceItemProvider
>;

/**
 * The `note` and `prompt` providers over one host. Upserts, deletes and lists
 * of one store share its lock, since listing a store can rewrite its index.
 */
export function createWorkspaceTextItemProviders(
  host: CoreWorkspaceTextItemsHost,
): CoreWorkspaceTextItemProviders {
  const withStore = createWorkspaceItemStoreLocks();

  const forKind = (
    kind: CoreWorkspaceTextItemKind,
  ): CoreWorkspaceItemProvider => {
    const storeKey = (scope: CoreWorkspaceItemAdmittedScope): string | null =>
      scope.worktreeId === null
        ? JSON.stringify([kind, host.storeKey(scope, kind)])
        : null;
    const locked = <Result>(
      scope: CoreWorkspaceItemAdmittedScope,
      operation: () => Promise<Result>,
    ): Promise<Result> => {
      const key = storeKey(scope);
      if (key === null) return Promise.reject(workspaceItemNotFound());
      return withStore(key, operation);
    };
    /**
     * A write under the store's lock. Until `operation` calls `beginWrite`, an
     * abort rejects at once, so the call frees its idempotency key while it
     * still waits; the queued operation then writes nothing.
     */
    const lockedWrite = <Result>(
      scope: CoreWorkspaceItemAdmittedScope,
      signal: AbortSignal,
      operation: (beginWrite: () => void) => Promise<Result>,
    ): Promise<Result> => {
      if (signal.aborted) return Promise.reject(canopyCancelledError());
      return new Promise<Result>((resolve, reject) => {
        let writing = false;
        const onAbort = (): void => {
          if (!writing) reject(canopyCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void locked(scope, () =>
          operation(() => {
            if (signal.aborted) throw canopyCancelledError();
            writing = true;
          }),
        )
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
    };

    // A digest key is resolved by listing, which may repair the index, so
    // callers outside the lock pass a locked list.
    const find = async (
      ref: CoreWorkspaceItemRef,
      scope: CoreWorkspaceItemAdmittedScope,
      listStore: () => Promise<readonly CoreWorkspaceTextItemEntry[]>,
    ): Promise<CoreWorkspaceTextItemDocument | null> => {
      if (ref.key.form === 'name') return host.read(scope, kind, ref.key.name);
      const entry = (await listStore()).find((candidate) =>
        workspaceItemRefMatches(ref, candidate.name),
      );
      return entry ? host.read(scope, kind, entry.name) : null;
    };

    /** The stored item at the expected revision, inside the store's lock. */
    const current = async (
      ref: CoreWorkspaceItemRef,
      scope: CoreWorkspaceItemAdmittedScope,
      expectedRevision: number,
    ): Promise<CoreWorkspaceTextItemDocument> => {
      const document = await find(ref, scope, () => host.list(scope, kind));
      if (!document) throw workspaceItemNotFound();
      const revision = workspaceTextItemRevision(
        kind,
        document.title,
        document.raw,
      );
      if (revision !== expectedRevision)
        throw workspaceItemRevisionConflict(revision);
      return document;
    };

    /**
     * The item a save stored under `name`, as `get` returns it. The write has
     * landed and the call keeps its key, so a failed read answers
     * `same_idempotency_key`: a same-key repeat reads again and never writes.
     */
    const readBack = async (
      scope: CoreWorkspaceItemAdmittedScope,
      name: string,
    ): Promise<CoreWorkspaceItem> => {
      let stored: CoreWorkspaceTextItemDocument | null;
      try {
        stored = await host.read(scope, kind, name);
      } catch (error) {
        throw new CanopyOperationError(
          {
            kind: 'internal',
            message: `The saved ${kind} could not be read back.`,
            retry: { kind: 'same_idempotency_key' },
          },
          error,
        );
      }
      // A file gone since the save, or a name with no item ID, is not a
      // transient read failure, so a repeat is not advised.
      const item = stored
        ? workspaceTextItem(scope, kind, stored, stored.content)
        : null;
      if (!item)
        throw new CanopyOperationError({
          kind: 'internal',
          message: `The saved ${kind} could not be read back.`,
          retry: { kind: 'never' },
        });
      return item;
    };

    return {
      storeKey,
      async list(scope) {
        if (storeKey(scope) === null) return [];
        const entries = await locked(scope, () => host.list(scope, kind));
        const items: CoreWorkspaceItem[] = [];
        for (const entry of entries) {
          const item = workspaceTextItem(scope, kind, entry, null);
          if (item) items.push(item);
        }
        return items;
      },
      async get(ref, scope) {
        if (storeKey(scope) === null) return null;
        const document = await find(ref, scope, () =>
          locked(scope, () => host.list(scope, kind)),
        );
        return document
          ? workspaceTextItem(scope, kind, document, document.content)
          : null;
      },
      upsert(scope, ref, expectedRevision, write, signal, commit) {
        return lockedWrite(scope, signal, async (beginWrite) => {
          const existing =
            ref === null || expectedRevision === null
              ? null
              : await current(ref, scope, expectedRevision);
          beginWrite();
          const name = await host.save(scope, kind, {
            name: existing?.name ?? null,
            title: write.title,
            content: write.content,
            originWorktreeId: write.originWorktreeId,
          });
          // A same-key repeat after a failed read-back reads the item again
          // rather than saving a second time.
          commit(() => locked(scope, () => readBack(scope, name)));
          return readBack(scope, name);
        });
      },
      delete(ref, scope, expectedRevision, signal) {
        return lockedWrite(scope, signal, async (beginWrite) => {
          const existing = await current(ref, scope, expectedRevision);
          beginWrite();
          await host.delete(scope, kind, existing.name);
        });
      },
    };
  };

  return { note: forKind('note'), prompt: forKind('prompt') };
}
