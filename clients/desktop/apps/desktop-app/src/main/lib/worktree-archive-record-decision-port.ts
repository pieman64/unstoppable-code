import type { WorktreeData } from '@canopy/desktop-shared/types';
import { assertDestructiveRowIdentity } from './w5-destructive-recovery';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktree,
} from './workspace-persistence';
import {
  applyArchiveJournalTo,
  removesArchivedWorktree,
} from './worktree-record-decision-apply';
import type {
  ArchiveCleanupTombstoneDecision,
  ArchiveJournalDecision,
  ArchivedWorktreeRowRemovalDecision,
  WorktreeRecordTarget,
} from './worktree-record-decisions';

// The archive journal, row removal and cleanup tombstone members of
// `W5RecordDecisionPort` (W6c1), applied through the writers the records used,
// unchanged. Kept apart so the other ports' importers do not load it.

/**
 * Records the journal on the row at the id under the list lock. A row of
 * another incarnation than the running destructive lifecycle's is refused as
 * recovery-required before the write.
 */
export function applyArchiveJournalRecord(
  target: WorktreeRecordTarget,
  decision: ArchiveJournalDecision,
): Promise<boolean> {
  return updateWorkspaceWorktree(
    target.workspaceId,
    target.worktreeId,
    (row) => {
      assertDestructiveRowIdentity(row.createdAt);
      return applyArchiveJournalTo(row, decision);
    },
  );
}

/** Removes the row at the id under the list lock, tombstoning it. */
export async function applyArchivedWorktreeRowRemoval(
  target: WorktreeRecordTarget,
  decision: ArchivedWorktreeRowRemovalDecision,
): Promise<boolean> {
  const shouldRemove = (row: WorktreeData): boolean =>
    removesArchivedWorktree(row, target.worktreeId);
  const removed = decision.remainingWorktreeOrder
    ? await removeWorkspaceWorktrees(
        target.workspaceId,
        shouldRemove,
        decision.remainingWorktreeOrder,
        decision.expectedRemainingWorktreeOrder,
      )
    : await removeWorkspaceWorktrees(target.workspaceId, shouldRemove);
  return removed.length > 0;
}

/** Keeps a stale write from listing the archived incarnation again. */
export function applyArchiveCleanupTombstone(
  target: WorktreeRecordTarget,
  decision: ArchiveCleanupTombstoneDecision,
): Promise<void> {
  markWorkspaceWorktreeRecentlyRemoved(
    target.workspaceId,
    target.worktreeId,
    decision.createdAt,
  );
  return Promise.resolve();
}
