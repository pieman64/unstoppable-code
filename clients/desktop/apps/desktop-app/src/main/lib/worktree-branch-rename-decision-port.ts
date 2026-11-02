import type { WorktreeData } from '@canopy/desktop-shared/types';
import { updateWorkspaceWorktree } from './workspace-persistence';
import { applyWorktreeBranchRename } from './worktree-record-decision-apply';
import type {
  WorktreeBranchRenameDecision,
  WorktreeRecordOutcome,
  WorktreeRecordTarget,
} from './worktree-record-decisions';

// The branch rename member of `W5RecordDecisionPort` (W6f1), applied through
// the row writer the record used, unchanged. Kept apart so the other ports'
// importers do not load it.

/**
 * Records a rename on its row under the list lock, in the rename's boundary
 * step. `found` comes from the writer, the row from the updater's last pass.
 */
export async function applyWorktreeBranchRenameDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeBranchRenameDecision,
): Promise<WorktreeRecordOutcome> {
  const pass: { worktree: WorktreeData | null; changed: boolean } = {
    worktree: null,
    changed: false,
  };
  const found = await updateWorkspaceWorktree(
    target.workspaceId,
    target.worktreeId,
    (current) => {
      const next = applyWorktreeBranchRename(current, decision);
      pass.worktree = next;
      pass.changed = next !== current;
      return next;
    },
  );
  if (!found) return { status: 'not-found', worktree: null };
  return {
    status: pass.changed ? 'recorded' : 'unchanged',
    worktree: pass.worktree,
  };
}
