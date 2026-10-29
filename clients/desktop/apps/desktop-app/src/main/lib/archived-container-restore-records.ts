import type { WorktreeData } from '@canopy/desktop-shared/types';
import { IdentifierValidationError, validateId } from './validation';
import { updateWorkspaceWorktrees } from './workspace-persistence';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import type { W5CommitOptions } from './w5-commit-scope';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';

/**
 * The destination worktree records of `core.archive.container.restore`
 * (CAN-3824): the row a files-only (version-3) archive restore adds to the
 * destination project's worktree list, and the removal of that row when the
 * restore rolls back. The restore's files, chats, Git state and archive
 * manifest stay in `archived-container-restore.ts`; only these list writes go
 * through here.
 *
 * Each record checks the destination identity (the staged id and its
 * `createdAt`) under the per-workspace worktree list lock, in the same write
 * that changes the list, so a concurrent create, update or archive keeps its
 * rows and fields, a repeated restore never adds a second row, and a rollback
 * never removes a row a later incarnation now owns. The unregistered restore
 * command owns caller revisions and receipts (CAN-3805); its row publication
 * joins a record-only transition, while rollback keeps its original path.
 */

/** The caller of a restore record. */
export type ArchiveRestoreRecordSource =
  /** `archived-containers:restore`, through `restoreArchivedContainer`. */
  'archived_container_restore';

const SOURCES: ReadonlySet<string> = new Set<ArchiveRestoreRecordSource>([
  'archived_container_restore',
]);

/** The row a files-only restore stages for its destination. */
export interface RestoredWorktreeRow {
  id: string;
  /** The staged incarnation; the destination identity with `id`. */
  createdAt: string;
  branchName: string;
  label: string;
  includedRepoIds?: readonly string[];
}

export interface RestoredWorktreeRecord {
  source: ArchiveRestoreRecordSource;
  workspaceId: string;
  /** The archived container the row is restored from. */
  archiveId: string;
  worktree: RestoredWorktreeRow;
}

/**
 * `recorded` added the row; `already-recorded` found the same incarnation in
 * the list (a repeated or concurrent restore) and wrote nothing.
 */
export type RestoredWorktreeRecordStatus = 'recorded' | 'already-recorded';

export interface RestoredWorktreeRecordOutcome {
  status: RestoredWorktreeRecordStatus;
  /** The committed row. */
  worktree: WorktreeData;
}

export type RestoredWorktreeRecordRefusal =
  | 'invalid-request'
  /** Another incarnation holds the staged id. */
  | 'identity-changed'
  /** The staged incarnation was archived in this process. */
  | 'destination-removed'
  /** The list could not be fully read, so the id's absence is unproven. */
  | 'worktrees-unavailable';

/** A restore record was refused; nothing was written. */
export class RestoredWorktreeRecordRefusedError extends Error {
  constructor(
    readonly reason: RestoredWorktreeRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RestoredWorktreeRecordRefusedError';
  }
}

function refuse(
  reason: RestoredWorktreeRecordRefusal,
  message: string,
): RestoredWorktreeRecordRefusedError {
  return new RestoredWorktreeRecordRefusedError(reason, message);
}

function admitIds(ids: Array<[string, string]>): void {
  try {
    for (const [value, label] of ids) validateId(value, label);
  } catch (error) {
    if (error instanceof IdentifierValidationError) {
      throw refuse('invalid-request', error.message);
    }
    throw error;
  }
}

function admitSource(source: string): void {
  if (!SOURCES.has(source)) {
    throw refuse('invalid-request', 'Unknown archive restore record source');
  }
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function admitRecord(record: RestoredWorktreeRecord): void {
  admitSource(record.source);
  admitIds([
    [record.workspaceId, 'workspaceId'],
    [record.worktree.id, 'restoreStaging.id'],
  ]);
  const { createdAt, branchName, label, includedRepoIds } = record.worktree;
  if (
    !isNonBlank(record.archiveId) ||
    !isNonBlank(createdAt) ||
    !isNonBlank(branchName) ||
    typeof label !== 'string' ||
    (includedRepoIds !== undefined &&
      (!Array.isArray(includedRepoIds) ||
        !includedRepoIds.every((repoId) => typeof repoId === 'string')))
  ) {
    throw refuse('invalid-request', 'Invalid restored worktree record');
  }
}

function toRow(record: RestoredWorktreeRecord): WorktreeData {
  const { id, branchName, createdAt, label, includedRepoIds } = record.worktree;
  return {
    id,
    branchName,
    createdAt,
    label,
    restoredFromFilesOnlyArchiveId: record.archiveId,
    ...(includedRepoIds === undefined
      ? {}
      : { includedRepoIds: [...includedRepoIds] }),
  };
}

/**
 * Adds the staged destination row of a files-only restore after the rows the
 * list holds when the write runs. A row with the staged id and `createdAt`
 * already there is the same destination (an interrupted or concurrent
 * restore of this archive) and is reported `already-recorded`; a row with the
 * staged id and another `createdAt` is refused, and so is a staged row this
 * process archived, which the list would otherwise drop silently. Success is
 * reported only for a row the list holds after the commit.
 */
async function stageRestoredWorktree(
  record: RestoredWorktreeRecord,
): Promise<RestoredWorktreeRecordOutcome> {
  admitRecord(record);
  const row = toRow(record);
  const { id, createdAt } = row;
  // Set by the updater, which runs under the list lock.
  const decided: { outcome?: RestoredWorktreeRecordOutcome } = {};
  let persisted: WorktreeData[];
  try {
    persisted = await updateWorkspaceWorktrees(
      record.workspaceId,
      (worktrees) => {
        const existing = worktrees.find((worktree) => worktree.id === id);
        if (existing) {
          if (existing.createdAt !== createdAt) {
            throw refuse(
              'identity-changed',
              `Staged recovery worktree ${id} no longer matches its destination identity; the archived container was preserved.`,
            );
          }
          decided.outcome = { status: 'already-recorded', worktree: existing };
          return worktrees;
        }
        decided.outcome = { status: 'recorded', worktree: row };
        return [...worktrees, row];
      },
      // Proving the staged id is absent needs every row (CAN-3803).
      { requireAuthoritativeRead: true },
    );
  } catch (error) {
    if (error instanceof WorktreeRegistryUnreadableError) {
      throw refuse(
        'worktrees-unavailable',
        `The worktree list could not be fully read, so staged recovery worktree ${id} was not recorded; the archived container was preserved.`,
      );
    }
    throw error;
  }
  const committed = persisted.find(
    (worktree) => worktree.id === id && worktree.createdAt === createdAt,
  );
  if (!decided.outcome || !committed) {
    throw refuse(
      'destination-removed',
      `Staged recovery worktree ${id} was removed before it could be recorded; the archived container was preserved.`,
    );
  }
  return decided.outcome;
}

export function recordRestoredWorktree(
  record: RestoredWorktreeRecord,
  commit?: W5CommitOptions,
): Promise<RestoredWorktreeRecordOutcome> {
  return commitW5BoundaryStep(
    commit,
    commit ? w5CompositionLocks({ lists: [record.workspaceId] }) : [],
    () => stageRestoredWorktree(record),
  );
}

export interface RestoredWorktreeRemoval {
  source: ArchiveRestoreRecordSource;
  workspaceId: string;
  worktreeId: string;
  /** The incarnation the restore recorded. */
  createdAt: string;
}

/**
 * `removed` took the row out of the list; `not-found` found no row of that
 * incarnation (removed, never recorded or replaced) and wrote nothing.
 */
export type RestoredWorktreeRemovalStatus = 'removed' | 'not-found';

/**
 * Removes the destination row a failed files-only restore recorded, only
 * while the list still holds the incarnation the restore created. A row the
 * user or a later restore now owns is left alone, so the caller keeps its
 * files too.
 */
export async function removeRestoredWorktreeRecord(
  removal: RestoredWorktreeRemoval,
): Promise<{ status: RestoredWorktreeRemovalStatus }> {
  admitSource(removal.source);
  admitIds([
    [removal.workspaceId, 'workspaceId'],
    [removal.worktreeId, 'worktreeId'],
  ]);
  if (!isNonBlank(removal.createdAt)) {
    throw refuse(
      'invalid-request',
      'A restored worktree removal needs the recorded createdAt',
    );
  }
  // Set by the updater, which runs under the list lock.
  const decided: { status: RestoredWorktreeRemovalStatus } = {
    status: 'not-found',
  };
  await updateWorkspaceWorktrees(removal.workspaceId, (worktrees) => {
    const destination = worktrees.find(
      (worktree) => worktree.id === removal.worktreeId,
    );
    if (!destination || destination.createdAt !== removal.createdAt) {
      return worktrees;
    }
    decided.status = 'removed';
    return worktrees.filter((worktree) => worktree !== destination);
  });
  return { status: decided.status };
}
