import {
  readWorkspaceIndex,
  type WorkspaceIndexRead,
} from '@canopy/core-runtime/node';
import { withW5RepositoryLock } from './w5-repository-locks';
import { afterW5Commit } from './w5-commit-scope';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import type {
  ActivitySectionId,
  ProjectData,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import type { AtomicFileStorage } from './atomic-file';
import {
  isJsonObject,
  withUnknownFields,
  type W5FileStore,
} from './w5-file-store';
import type { PersistedFileAuthority } from './workspace-persistence';
import { diffW5Rows, equalW5Contents } from './w5-revision-diff';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';

/**
 * Whether a workspace index read can prove a workspace's absence: `absent`
 * (no file yet) and `ok` are authoritative; `partial` (the file was valid
 * but at least one entry could not be normalized) and `unreadable` (I/O
 * error, invalid JSON or an unexpected shape) are not.
 */
export type WorkspaceIndexAuthority = PersistedFileAuthority | 'partial';

export interface WorkspaceIndexSnapshot {
  /** The entries this version can read, in file order. */
  entries: WorkspaceIndexEntry[];
  authority: WorkspaceIndexAuthority;
}

/**
 * What an index update decided. With `entries` the index is replaced by them
 * (plus the data the repository keeps, see {@link WorkspaceIndexRepository});
 * without, nothing is written.
 */
export interface WorkspaceIndexChange<T> {
  result: T;
  entries?: WorkspaceIndexEntry[];
}

/**
 * The single reader and writer of `<data>/workspaces/index.json` in desktop
 * main (CAN-3800).
 *
 * A write keeps what this version cannot read: unknown fields of the file
 * and of every entry it rewrites, and entries it could not normalize (left
 * after the entries it writes). It never replaces an unreadable index, and
 * the backup beside it only ever holds a fully readable one. Updates are
 * serialized, so concurrent targeted updates each see the previous one.
 */
export interface WorkspaceIndexRepository {
  read(): Promise<WorkspaceIndexSnapshot>;
  update<T>(
    change: (
      current: WorkspaceIndexSnapshot,
    ) => WorkspaceIndexChange<T> | Promise<WorkspaceIndexChange<T>>,
  ): Promise<T>;
}

export interface WorkspaceIndexRepositoryDeps {
  store: W5FileStore;
  filePath: () => string;
  storage: AtomicFileStorage;
  /** Runs after each committed write. */
  onCommitted: () => void;
  /** Runs when a write over an unreadable index is refused. */
  onRefused: () => void;
}

export class WorkspaceIndexUnreadableError extends Error {
  readonly cause?: unknown;
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

export function normalizeActivitySectionOrder(
  value: unknown,
): ProjectData['activitySectionOrder'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter(
    (entry): entry is ActivitySectionId =>
      typeof entry === 'string' && isActivitySectionId(entry),
  );
  return normalized.length > 0 ? normalized : undefined;
}

type LoadedWorkspaceIndex = WorkspaceIndexRead<ActivitySectionId> & {
  readError?: Error;
};

function encodeWorkspaceIndex(
  entries: readonly WorkspaceIndexEntry[],
  current: LoadedWorkspaceIndex,
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

export function createWorkspaceIndexRepository(
  deps: WorkspaceIndexRepositoryDeps,
): WorkspaceIndexRepository {
  async function load(): Promise<LoadedWorkspaceIndex> {
    const read = await deps.store.read(deps.filePath());
    return {
      ...readWorkspaceIndex(read, normalizeActivitySectionOrder),
      ...(read.state === 'unreadable' && read.error
        ? { readError: read.error }
        : {}),
    };
  }

  return {
    async read(): Promise<WorkspaceIndexSnapshot> {
      const { entries, authority } = await load();
      return { entries, authority };
    },
    update<T>(
      change: (
        current: WorkspaceIndexSnapshot,
      ) => WorkspaceIndexChange<T> | Promise<WorkspaceIndexChange<T>>,
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
          await afterW5Commit(deps.onCommitted);
          return decided.result;
        },
      );
    },
  };
}
