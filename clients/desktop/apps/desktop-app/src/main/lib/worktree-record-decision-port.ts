import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
} from './workspace-persistence';
import {
  applyWorktreeListDecisionTo,
  applyWorktreeRowDecisionTo,
  planMergedBaseRetarget,
} from './worktree-record-decision-apply';
import type {
  WorktreeActivityRecordOutcome,
  WorktreeActivityWatermarkDecision,
  WorktreeAutoDeleteBaselineDecision,
  WorktreeBaseRetargetOutcome,
  WorktreeChatBadgesDecision,
  WorktreeChatBadgesRecordOutcome,
  WorktreeListDecision,
  WorktreeListDecisionOutcome,
  WorktreeMergedBaseRetargetDecision,
  WorktreeRecordOutcome,
  WorktreeRecordRowDecision,
  WorktreeRecordTarget,
  WorktreeRowDecision,
  WorktreeRowDecisionOutcome,
} from './worktree-record-decisions';

// The in-process `W5RecordDecisionPort` (W6-0): each decision is applied by
// the existing locked list writers, with its pure apply as the updater, so
// tombstone filtering, the sidebar group reconciler and the W5 commit hooks
// run as they did for the record functions' own updaters.

/** What the last pass of a row updater did. */
interface RowPass {
  /** Whether the updater ran: the row was in the list. */
  ran: boolean;
  /** The apply result; `null` for another incarnation. */
  next: WorktreeData | null;
  changed: boolean;
}

function rowOutcome(
  decision: WorktreeRowDecision,
  pass: RowPass,
  found: boolean,
): WorktreeRowDecisionOutcome {
  switch (decision.kind) {
    case 'activity.watermark':
      return {
        worktrees: pass.ran && pass.next ? [pass.next] : [],
        changed: pass.changed,
      };
    case 'chatBadges':
      if (!pass.ran) return { status: 'not-found' };
      return { status: pass.changed ? 'recorded' : 'unchanged' };
    case 'git.branch':
    case 'git.pr-status':
    case 'git.split-child-grouping':
    case 'git.split-original-retarget':
      // Git observations take `found` from the writer alone, even when the
      // updater never ran (`worktree` is then null).
      if (!found) return { status: 'not-found', worktree: null };
      return {
        status: pass.changed ? 'recorded' : 'unchanged',
        worktree: pass.next,
      };
    default:
      // Repair and reconcile follow the last pass alone: no pass, or another
      // incarnation (`null`), is `not-found`.
      if (pass.next === null) return { status: 'not-found', worktree: null };
      return {
        status: pass.changed ? 'recorded' : 'unchanged',
        worktree: pass.next,
      };
  }
}

/** Applies one row decision under the list lock. */
export async function applyWorktreeRowDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeActivityWatermarkDecision,
): Promise<WorktreeActivityRecordOutcome>;
export async function applyWorktreeRowDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeChatBadgesDecision,
): Promise<WorktreeChatBadgesRecordOutcome>;
export async function applyWorktreeRowDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeRecordRowDecision,
): Promise<WorktreeRecordOutcome>;
export async function applyWorktreeRowDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeRowDecision,
): Promise<WorktreeRowDecisionOutcome>;
export async function applyWorktreeRowDecision(
  target: WorktreeRecordTarget,
  decision: WorktreeRowDecision,
): Promise<WorktreeRowDecisionOutcome> {
  const pass: RowPass = { ran: false, next: null, changed: false };
  const found = await updateWorkspaceWorktree(
    target.workspaceId,
    target.worktreeId,
    (current) => {
      const next = applyWorktreeRowDecisionTo(current, decision, {
        now: new Date(),
      });
      pass.ran = true;
      pass.next = next;
      pass.changed = next !== null && next !== current;
      return next ?? current;
    },
  );
  return rowOutcome(decision, pass, found);
}

/** Applies one whole-list decision under the list lock. */
export async function applyWorktreeListDecision(
  workspaceId: string,
  decision: WorktreeAutoDeleteBaselineDecision,
): Promise<WorktreeActivityRecordOutcome>;
export async function applyWorktreeListDecision(
  workspaceId: string,
  decision: WorktreeMergedBaseRetargetDecision,
): Promise<WorktreeBaseRetargetOutcome>;
export async function applyWorktreeListDecision(
  workspaceId: string,
  decision: WorktreeListDecision,
): Promise<WorktreeListDecisionOutcome>;
export async function applyWorktreeListDecision(
  workspaceId: string,
  decision: WorktreeListDecision,
): Promise<WorktreeListDecisionOutcome> {
  if (decision.kind === 'git.merged-base-retarget') {
    // The updater can run again on a retry; report only the last pass.
    let updates: WorktreeBaseRetargetOutcome['updates'] = [];
    await updateWorkspaceWorktrees(workspaceId, (current) => {
      const plan = planMergedBaseRetarget(current, decision);
      updates = plan.updates.map((update) => ({
        projectId: workspaceId,
        ...update,
      }));
      return plan.worktrees;
    });
    return {
      status: updates.length > 0 ? 'recorded' : 'unchanged',
      updates,
    };
  }
  let changed = false;
  const worktrees = await updateWorkspaceWorktrees(workspaceId, (current) => {
    const next = applyWorktreeListDecisionTo(current, decision);
    changed = next !== current;
    return next;
  });
  return { worktrees, changed };
}
