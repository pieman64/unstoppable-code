import type { WorktreeData } from '@canopy/desktop-shared/types';
import { updateWorkspaceWorktrees } from './workspace-persistence';
import {
  applyArchiveRestoreRecordTo,
  applyArchiveRestoreRemovalTo,
} from './worktree-record-decision-apply';
import type {
  ArchiveRestoreRecordDecided,
  ArchiveRestoreRecordDecision,
  ArchiveRestoreRecordOutcome,
  ArchiveRestoreRemovalDecision,
  ArchiveRestoreRemovalOutcome,
} from './worktree-record-decisions';

// The archive restore members of `W5RecordDecisionPort` (W6e1), applied
// through the list writer the records used, unchanged. Kept apart so the
// other ports' importers do not load it.

/** Leaves the locked update before its write and post-commit hooks. */
class IdentityChanged extends Error {}

/**
 * Adds a restore's staged row under the list lock, in the restore's boundary
 * step. Only a fully readable list proves its id absent (CAN-3803): any other
 * refuses with `WorktreeRegistryUnreadableError`. Another incarnation at the
 * id leaves the update before it writes or runs a hook, as the record's
 * refusal inside its updater did.
 */
export async function applyArchiveRestoreRecordDecision(
  workspaceId: string,
  decision: ArchiveRestoreRecordDecision,
): Promise<ArchiveRestoreRecordOutcome> {
  // Set by the updater, which runs under the list lock.
  const pass: { decided?: ArchiveRestoreRecordDecided; read: WorktreeData[] } =
    { read: [] };
  try {
    const worktrees = await updateWorkspaceWorktrees(
      workspaceId,
      (current) => {
        const next = applyArchiveRestoreRecordTo(current, decision);
        pass.decided = next.decided;
        pass.read = current;
        if (next.decided.status === 'identity-changed')
          throw new IdentityChanged();
        return next.worktrees;
      },
      { requireAuthoritativeRead: true },
    );
    return { decided: pass.decided, worktrees };
  } catch (error) {
    if (error instanceof IdentityChanged)
      return { decided: pass.decided, worktrees: pass.read };
    throw error;
  }
}

/** Removes a restore's destination row under the list lock; it opens no boundary step. */
export async function applyArchiveRestoreRemovalDecision(
  workspaceId: string,
  decision: ArchiveRestoreRemovalDecision,
): Promise<ArchiveRestoreRemovalOutcome> {
  // Set by the updater, which runs under the list lock.
  const pass = { removed: false };
  await updateWorkspaceWorktrees(workspaceId, (current) => {
    const next = applyArchiveRestoreRemovalTo(current, decision);
    pass.removed = next.removed;
    return next.worktrees;
  });
  return { status: pass.removed ? 'removed' : 'not-found' };
}
