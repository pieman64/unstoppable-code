import {
  isWorkspaceWorktreeReadRow,
  readWorktreeList,
  type WorkspaceWorktreeReadRow,
} from '../workspace/read-formats';
import type { WorktreeReplicaState } from '@canopy/protocol/worktree-replica';
import type { W5Resource } from './commit-log';
import {
  isJsonObject,
  withUnknownFields,
  type W5FileStore,
} from './file-store';
import { withW5RepositoryLock } from './repository-locks';
import { diffW5Rows, equalW5Contents } from './revision-diff';
import type { W5StorageTarget } from './storage-target';
import {
  parseWorktreeReplica,
  serializeWorktreeReplica,
} from './worktree-replica-codec';
import {
  recordLocalWorktreeReplica,
  type LocalReplicaContext,
} from './worktree-replica-record';

/** The list row fields the repository itself reads and writes. */
export interface W5WorktreeListRow {
  id: string;
  branchName: string;
  createdAt: string;
  restoredFromFilesOnlyArchiveId?: string;
  includedRepoIds?: readonly string[];
  /** Authority-owned local replicas; absent input is a legacy never-recorded row. */
  replica?: WorktreeReplicaState;
}

/** A row this version reads, with its replica decoded. */
export type W5WorktreeListReadRow = WorkspaceWorktreeReadRow & {
  replica: WorktreeReplicaState;
};

/** One read of a workspace's `worktrees.json`. */
export type WorktreeListRead<
  Row extends W5WorktreeListRow = W5WorktreeListRow,
> =
  | { authority: 'absent' }
  | { authority: 'unreadable'; error?: Error }
  | {
      authority: 'ok';
      /** The rows this version can read, in file order. */
      worktrees: Row[];
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
 * The single reader and writer of `<data>/workspaces/{id}/worktrees.json`
 * (CAN-3803). It owns the file, not its policy: the host writer keeps the
 * per-workspace lock, stale-snapshot filtering, sidebar-group reconciliation
 * and post-commit invalidation around it.
 *
 * {@link replace} keeps what this version cannot read: unknown fields of the
 * file and of each row it keeps (matched by id), and rows without a string
 * `id`, `branchName` and `createdAt`, which stay after the rows written. A
 * known field a row leaves out is cleared. It never replaces an unreadable
 * list.
 */
export interface WorktreeListRepository<
  Row extends W5WorktreeListRow = W5WorktreeListRow,
> {
  read(workspaceId: string): Promise<WorktreeListRead<Row>>;
  /**
   * Replaces the list with `worktrees`, given the read made under the same
   * host lock, and returns the contents written.
   */
  replace(
    workspaceId: string,
    worktrees: readonly Row[],
    previous: WorktreeListRead<Row>,
  ): Promise<string>;
}

/** Projects a row this version reads into the host's row type. */
export type W5WorktreeListRowProjection<Row extends W5WorktreeListRow> = (
  row: W5WorktreeListReadRow,
) => Row;

export interface WorktreeListRepositoryDeps<Row extends W5WorktreeListRow> {
  store: W5FileStore;
  filePath: (workspaceId: string) => string;
  storage: W5StorageTarget;
  /** Row fields this version reads. */
  knownRowFields: ReadonlySet<string>;
  readRow: W5WorktreeListRowProjection<Row>;
  /** Trusted host context, resolved only on a write that needs initial identity. */
  localReplicaContext?: (
    workspaceId: string,
  ) => Promise<LocalReplicaContext | undefined>;
}

export class WorktreeRegistryUnreadableError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
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

export function parseWorktreeList<Row extends W5WorktreeListRow>(
  raw: string,
  workspaceId: string,
  readRow: W5WorktreeListRowProjection<Row>,
): WorktreeListRead<Row> {
  const read = readWorktreeList({ state: 'present', raw });
  if (read.authority !== 'ok') return read;
  return {
    ...read,
    worktrees: read.worktrees.map((row) =>
      readRow({
        ...row,
        replica: parseWorktreeReplica(row.replica, workspaceId, row.id),
      }),
    ),
    raw,
  };
}

export function createWorktreeListRepository<Row extends W5WorktreeListRow>(
  deps: WorktreeListRepositoryDeps<Row>,
): WorktreeListRepository<Row> {
  return {
    async read(workspaceId: string): Promise<WorktreeListRead<Row>> {
      const read = await deps.store.read(deps.filePath(workspaceId));
      if (read.state === 'present')
        return parseWorktreeList(read.raw, workspaceId, deps.readRow);
      return read.state === 'unreadable'
        ? {
            authority: read.state,
            ...(read.error ? { error: read.error } : {}),
          }
        : { authority: read.state };
    },
    async replace(
      workspaceId: string,
      worktrees: readonly Row[],
      previous: WorktreeListRead<Row>,
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
            if (isWorkspaceWorktreeReadRow(row) && !rowsById.has(row.id)) {
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
                      !isWorkspaceWorktreeReadRow(row) &&
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
