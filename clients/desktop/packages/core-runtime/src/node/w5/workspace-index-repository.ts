import {
  readWorkspaceIndex,
  type WorkspaceIndexRead,
  type WorkspaceIndexReadEntry,
} from '../workspace/read-formats';
import type { W5Resource } from './commit-log';
import { afterW5Commit } from './commit-scope';
import {
  isJsonObject,
  withUnknownFields,
  type PersistedFileAuthority,
  type W5FileStore,
} from './file-store';
import { withW5RepositoryLock } from './repository-locks';
import { diffW5Rows, equalW5Contents } from './revision-diff';
import type { W5StorageTarget } from './storage-target';

/**
 * Whether a workspace index read can prove a workspace's absence: `absent`
 * (no file yet) and `ok` are authoritative; `partial` (the file was valid
 * but at least one entry could not be normalized) and `unreadable` (I/O
 * error, invalid JSON or an unexpected shape) are not.
 */
export type WorkspaceIndexAuthority = PersistedFileAuthority | 'partial';

export interface WorkspaceIndexSnapshot<
  Entry extends WorkspaceIndexReadEntry<string> =
    WorkspaceIndexReadEntry<string>,
> {
  /** The entries this version can read, in file order. */
  entries: Entry[];
  authority: WorkspaceIndexAuthority;
}

/**
 * What an index update decided. With `entries` the index is replaced by them
 * (plus the data the repository keeps, see {@link WorkspaceIndexRepository});
 * without, nothing is written.
 */
export interface WorkspaceIndexChange<
  T,
  Entry extends WorkspaceIndexReadEntry<string> =
    WorkspaceIndexReadEntry<string>,
> {
  result: T;
  entries?: Entry[];
}

/**
 * The single reader and writer of `<data>/workspaces/index.json` (CAN-3800).
 *
 * A write keeps what this version cannot read: unknown fields of the file
 * and of every entry it rewrites, and entries it could not normalize (left
 * after the entries it writes). It never replaces an unreadable index, and
 * the backup beside it only ever holds a fully readable one. Updates are
 * serialized, so concurrent targeted updates each see the previous one.
 */
export interface WorkspaceIndexRepository<
  Entry extends WorkspaceIndexReadEntry<string> =
    WorkspaceIndexReadEntry<string>,
> {
  read(): Promise<WorkspaceIndexSnapshot<Entry>>;
  update<T>(
    change: (
      current: WorkspaceIndexSnapshot<Entry>,
    ) =>
      | WorkspaceIndexChange<T, Entry>
      | Promise<WorkspaceIndexChange<T, Entry>>,
  ): Promise<T>;
}

/**
 * The `core.workspace.update` index fields as stored, before the read
 * replaces a missing or malformed value with its default.
 */
export type StoredWorkspaceIndexFields = Readonly<
  Partial<
    Record<'color' | 'collapsed' | 'pinned' | 'activitySectionOrder', unknown>
  >
>;

export interface WorkspaceIndexStoredSnapshot<
  Entry extends WorkspaceIndexReadEntry<string> =
    WorkspaceIndexReadEntry<string>,
> extends WorkspaceIndexSnapshot<Entry> {
  /**
   * Each of `entries`' own stored fields, at the same position, so a
   * duplicate-id entry never reads another entry's.
   */
  storedFields: readonly StoredWorkspaceIndexFields[];
}

/** The repository with a read that also reports stored entry fields. */
export interface StoredWorkspaceIndexRepository<
  Entry extends WorkspaceIndexReadEntry<string> =
    WorkspaceIndexReadEntry<string>,
> extends WorkspaceIndexRepository<Entry> {
  readStored(): Promise<WorkspaceIndexStoredSnapshot<Entry>>;
}

export interface WorkspaceIndexRepositoryDeps<Section extends string> {
  store: W5FileStore;
  filePath: () => string;
  storage: W5StorageTarget;
  /** The host's activity sections; an empty or invalid order reads as unset. */
  normalizeActivitySectionOrder: (value: unknown) => Section[] | undefined;
  /** Runs after each committed write. */
  onCommitted: () => void;
  /** Runs when a write over an unreadable index is refused. */
  onRefused: () => void;
}

export class WorkspaceIndexUnreadableError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('The workspace index could not be read, so it was not rewritten');
    this.name = 'WorkspaceIndexUnreadableError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}

/** Index fields this version reads; every other field is kept on write. */
const INDEX_FILE_KEYS: ReadonlySet<string> = new Set(['version', 'workspaces']);
const INDEX_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'type',
  'color',
  'collapsed',
  'order',
  'pinned',
  'activitySectionOrder',
]);

type LoadedWorkspaceIndex<Section extends string> =
  WorkspaceIndexRead<Section> & {
    readError?: Error;
  };

function encodeWorkspaceIndex<Section extends string>(
  entries: readonly WorkspaceIndexReadEntry<Section>[],
  current: LoadedWorkspaceIndex<Section>,
): string {
  const writtenIds = new Set(entries.map((entry) => entry.id));
  const workspaces = [
    ...entries.map((entry) =>
      withUnknownFields(
        entry,
        current.rawEntriesById.get(entry.id),
        INDEX_ENTRY_KEYS,
      ),
    ),
    // An entry that cannot be read is never shown, so no caller can mean to
    // remove it; it goes only when an entry with its id replaces it.
    ...current.unreadableEntries.filter(
      (rawEntry) =>
        typeof rawEntry.id !== 'string' || !writtenIds.has(rawEntry.id),
    ),
  ];
  return JSON.stringify(
    withUnknownFields(
      { version: 1, workspaces },
      current.document,
      INDEX_FILE_KEYS,
    ),
    null,
    2,
  );
}

export function createWorkspaceIndexRepository<Section extends string>(
  deps: WorkspaceIndexRepositoryDeps<Section>,
): StoredWorkspaceIndexRepository<WorkspaceIndexReadEntry<Section>> {
  type Entry = WorkspaceIndexReadEntry<Section>;

  async function load(): Promise<LoadedWorkspaceIndex<Section>> {
    const read = await deps.store.read(deps.filePath());
    return {
      ...readWorkspaceIndex(read, deps.normalizeActivitySectionOrder),
      ...(read.state === 'unreadable' && read.error
        ? { readError: read.error }
        : {}),
    };
  }

  return {
    async read(): Promise<WorkspaceIndexSnapshot<Entry>> {
      const { entries, authority } = await load();
      return { entries, authority };
    },
    async readStored(): Promise<WorkspaceIndexStoredSnapshot<Entry>> {
      const { entries, authority, rawEntries } = await load();
      return { entries, authority, storedFields: rawEntries };
    },
    update<T>(
      change: (
        current: WorkspaceIndexSnapshot<Entry>,
      ) =>
        | WorkspaceIndexChange<T, Entry>
        | Promise<WorkspaceIndexChange<T, Entry>>,
    ): Promise<T> {
      return withW5RepositoryLock(
        { kind: 'index', path: deps.filePath() },
        async (): Promise<T> => {
          const current = await load();
          const decided = await change({
            entries: current.entries,
            authority: current.authority,
          });
          if (decided.entries === undefined) return decided.result;
          // Rewriting from an index that could not be read would drop every
          // entry in it (CAN-3329).
          if (current.authority === 'unreadable') {
            deps.onRefused();
            throw new WorkspaceIndexUnreadableError(current.readError);
          }
          const filePath = deps.filePath();
          const contents = encodeWorkspaceIndex(decided.entries, current);
          if (equalW5Contents(current.raw, contents)) return decided.result;
          const next: unknown = JSON.parse(contents);
          const diff = diffW5Rows(
            current.document?.workspaces,
            isJsonObject(next) ? next.workspaces : undefined,
            true,
          );
          const advance: W5Resource[] = [
            ...(diff.collectionChanged
              ? [{ kind: 'workspaces' } as const]
              : []),
            ...diff.changedIds.map(
              (workspaceId): W5Resource => ({ kind: 'workspace', workspaceId }),
            ),
          ];
          let backup:
            | { path: string; contents: string; previousRaw: string | null }
            | undefined;
          if (current.authority === 'ok' && current.raw !== null) {
            const path = `${filePath}.bak`;
            const read = await deps.store.read(path);
            if (read.state === 'unreadable')
              throw new WorkspaceIndexUnreadableError(read.error);
            backup = {
              path,
              contents: current.raw,
              previousRaw: read.state === 'present' ? read.raw : null,
            };
          }
          await deps.store.replace(filePath, contents, deps.storage, {
            operation: 'w5.workspace_index.write',
            advance,
            previousRaw: current.raw,
            backup,
          });
          // A failed notification rejects the update; the write is not retried.
          await afterW5Commit(deps.onCommitted);
          return decided.result;
        },
      );
    },
  };
}
