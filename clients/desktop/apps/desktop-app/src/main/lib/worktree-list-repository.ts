import {
  isWorkspaceWorktreeReadRow,
  readWorktreeList,
} from '@canopy/core-runtime/node';
import { withW5RepositoryLock } from './w5-repository-locks';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type { AtomicFileStorage } from './atomic-file';
import { diffW5Rows, equalW5Contents } from './w5-revision-diff';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  parseWorktreeReplica,
  serializeWorktreeReplica,
} from './worktree-replica-codec';
import {
  recordLocalWorktreeReplica,
  type LocalReplicaContext,
} from './worktree-replica-record';
import {
  isJsonObject,
  withUnknownFields,
  type W5FileStore,
} from './w5-file-store';

/** One read of a workspace's `worktrees.json`. */
export type WorktreeListRead =
  | { authority: 'absent' }
  | { authority: 'unreadable'; error?: Error }
  | {
      authority: 'ok';
      /** The rows this version can read, in file order. */
      worktrees: WorktreeData[];
      /**
       * False when rows it cannot read were left out, so the rows read do
       * not prove that a worktree is absent.
       */
      complete: boolean;
      /** Ids of the rows left out that carry a string id. */
      unreadableRowIds: string[];
      document: Record<string, unknown>;
      raw: string;
    };

/**
 * The single reader and writer of `<data>/workspaces/{id}/worktrees.json` in
 * desktop main (CAN-3803). It owns the file, not its policy: the host writer
 * keeps the per-workspace lock, stale-snapshot filtering, sidebar-group
 * reconciliation and post-commit invalidation around it.
 *
 * {@link replace} keeps what this version cannot read: unknown fields of the
 * file and of each row it keeps (matched by id), and rows without a string
 * `id`, `branchName` and `createdAt`, which stay after the rows written. A
 * known field a row leaves out is cleared. It never replaces an unreadable
 * list.
 */
export interface WorktreeListRepository {
  read(workspaceId: string): Promise<WorktreeListRead>;
  /**
   * Replaces the list with `worktrees`, given the read made under the same
   * host lock, and returns the contents written.
   */
  replace(
    workspaceId: string,
    worktrees: readonly WorktreeData[],
    previous: WorktreeListRead,
  ): Promise<string>;
}

export interface WorktreeListRepositoryDeps {
  store: W5FileStore;
  filePath: (workspaceId: string) => string;
  storage: AtomicFileStorage;
  /** Row fields this version reads. */
  knownRowFields: ReadonlySet<string>;
  /** Trusted host context, resolved only on a write that needs initial identity. */
  localReplicaContext?: (
    workspaceId: string,
  ) => Promise<LocalReplicaContext | undefined>;
}

export class WorktreeRegistryUnreadableError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('Worktree registry is unreadable');
    this.name = 'WorktreeRegistryUnreadableError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}

const LIST_FILE_KEYS: ReadonlySet<string> = new Set(['version', 'worktrees']);

function isWorktreeRow(value: unknown): value is WorktreeData {
  return isWorkspaceWorktreeReadRow(value);
}

export function parseWorktreeList(
  raw: string,
  workspaceId: string,
): WorktreeListRead {
  const read = readWorktreeList({ state: 'present', raw });
  if (read.authority !== 'ok') return read;
  return {
    ...read,
    worktrees: read.worktrees.map((row) => ({
      ...row,
      replica: parseWorktreeReplica(row.replica, workspaceId, row.id),
    })),
    raw,
  };
}

export function createWorktreeListRepository(
  deps: WorktreeListRepositoryDeps,
): WorktreeListRepository {
  return {
    async read(workspaceId: string): Promise<WorktreeListRead> {
      const read = await deps.store.read(deps.filePath(workspaceId));
      if (read.state === 'present')
        return parseWorktreeList(read.raw, workspaceId);
      return read.state === 'unreadable'
        ? {
            authority: read.state,
            ...(read.error ? { error: read.error } : {}),
          }
        : { authority: read.state };
    },
    async replace(
      workspaceId: string,
      worktrees: readonly WorktreeData[],
      previous: WorktreeListRead,
    ): Promise<string> {
      return withW5RepositoryLock(
        { kind: 'list', path: deps.filePath(workspaceId) },
        async (): Promise<string> => {
          // Rewriting from a list that could not be read would drop every row.
          if (previous.authority === 'unreadable') {
            throw new WorktreeRegistryUnreadableError(previous.error);
          }
          const document =
            previous.authority === 'ok' ? previous.document : undefined;
          const previousRows: unknown[] = Array.isArray(document?.worktrees)
            ? document.worktrees
            : [];
          const rowsById = new Map<string, Record<string, unknown>>();
          for (const row of previousRows) {
            if (
              isJsonObject(row) &&
              isWorktreeRow(row) &&
              !rowsById.has(row.id)
            ) {
              rowsById.set(row.id, row);
            }
          }
          const writtenIds = new Set(worktrees.map((worktree) => worktree.id));
          const needsIdentity = worktrees.some(
            (worktree) =>
              rowsById.get(worktree.id)?.replica === undefined &&
              (worktree.replica === undefined ||
                worktree.replica.state === 'never-recorded'),
          );
          const context = needsIdentity
            ? await deps.localReplicaContext?.(workspaceId)
            : undefined;
          const contents = JSON.stringify(
            withUnknownFields(
              {
                version: 1,
                worktrees: [
                  ...worktrees.map((worktree) => {
                    const old = rowsById.get(worktree.id);
                    const previousReplica = parseWorktreeReplica(
                      old?.replica,
                      workspaceId,
                      worktree.id,
                    );
                    const next =
                      old?.replica === undefined &&
                      context &&
                      (worktree.replica === undefined ||
                        worktree.replica.state === 'never-recorded')
                        ? recordLocalWorktreeReplica(
                            workspaceId,
                            worktree,
                            context,
                          )
                        : worktree.replica;
                    const row = withUnknownFields(
                      worktree,
                      old,
                      deps.knownRowFields,
                    );
                    delete row.replica;
                    // Replica identity is authority-owned. Omitted fields and malformed
                    // state survive every compatibility save, including stale ones.
                    const unchanged =
                      previousReplica.state === 'unreadable' ||
                      next === undefined ||
                      next.state !== 'recorded' ||
                      JSON.stringify(next) === JSON.stringify(previousReplica);
                    if (unchanged) {
                      if (old?.replica !== undefined) row.replica = old.replica;
                    } else {
                      if (
                        parseWorktreeReplica(next, workspaceId, worktree.id)
                          .state !== 'recorded'
                      )
                        throw new Error('Invalid worktree replica write');
                      row.replica = serializeWorktreeReplica(
                        next,
                        old?.replica,
                      );
                    }
                    return row;
                  }),
                  // A row that cannot be read is never shown, so no caller can
                  // mean to remove it; a row written with its id replaces it.
                  ...previousRows.filter(
                    (row) =>
                      !isWorktreeRow(row) &&
                      !(
                        isJsonObject(row) &&
                        typeof row.id === 'string' &&
                        writtenIds.has(row.id)
                      ),
                  ),
                ],
              },
              document,
              LIST_FILE_KEYS,
            ),
            null,
            2,
          );
          const previousRaw = previous.authority === 'ok' ? previous.raw : null;
          if (equalW5Contents(previousRaw, contents)) return contents;
          const oldDocument: unknown =
            previousRaw === null ? undefined : JSON.parse(previousRaw);
          const next: unknown = JSON.parse(contents);
          const diff = diffW5Rows(
            isJsonObject(oldDocument) ? oldDocument.worktrees : undefined,
            isJsonObject(next) ? next.worktrees : undefined,
            false,
          );
          const advance: W5Resource[] = [
            ...(diff.collectionChanged
              ? [{ kind: 'worktrees', workspaceId } as const]
              : []),
            ...diff.changedIds.map(
              (worktreeId): W5Resource => ({
                kind: 'worktree',
                workspaceId,
                worktreeId,
              }),
            ),
          ];
          await deps.store.replace(
            deps.filePath(workspaceId),
            contents,
            deps.storage,
            { operation: 'w5.worktree_list.write', advance, previousRaw },
          );
          return contents;
        },
        { join: true },
      );
    },
  };
}
