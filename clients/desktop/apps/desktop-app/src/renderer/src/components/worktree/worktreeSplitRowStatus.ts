import { useShallow } from 'zustand/shallow';
import type { WorktreeSplitStatus } from '@canopy/ui-shared/components';
import { buildSplitRunningStatusLine } from '@/lib/split-progress';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';

/** The split-workflow facts a worktree row reads for its split badge. */
export interface WorktreeSplitRowFacts {
  /** Main holds the split lock for this worktree. */
  readonly splitLocked: boolean;
  /** The renderer's split presentation session is still open. */
  readonly sessionOpen: boolean;
  readonly planning: boolean;
  readonly splitting: boolean;
  readonly planPresent: boolean;
  readonly completed: boolean;
  /** Most recent in-flight phase label, when a split is running. */
  readonly runningLine: string | null;
}

export interface WorktreeSplitRowStatus {
  readonly splitStatus: WorktreeSplitStatus | undefined;
  readonly splitStatusMessage: string | undefined;
}

/**
 * The row's split badge and status line. The badge keys on `locked || session`
 * for presence (the presentation session outlives the lock so the finished
 * page can render), then mirrors the split workflow's own step derivation for
 * its color: planning/carving → active, a proposed plan awaiting approval →
 * review, a completed map → done.
 */
export function deriveWorktreeSplitRowStatus(
  facts: WorktreeSplitRowFacts,
): WorktreeSplitRowStatus {
  if (!facts.splitLocked && !facts.sessionOpen) {
    return { splitStatus: undefined, splitStatusMessage: undefined };
  }
  const splitStatus: WorktreeSplitStatus = facts.completed
    ? 'done'
    : facts.planning || facts.splitting
      ? 'active'
      : facts.planPresent
        ? 'review'
        : 'active';
  const splitStatusMessage =
    splitStatus === 'done'
      ? 'All child PRs created'
      : splitStatus === 'review'
        ? 'Waiting for your plan approval'
        : facts.planning
          ? 'Analyzing the PR diff'
          : (facts.runningLine ?? 'Preparing the split');
  return { splitStatus, splitStatusMessage };
}

/**
 * One row's split facts from the GitHub store. A single shallow selector of
 * primitives, so a progress event that does not change this row's phase
 * label re-renders nothing.
 */
export function useWorktreeSplitRowFacts(
  projectId: string,
  worktreeId: string,
): WorktreeSplitRowFacts {
  return useGitHubStore(
    useShallow((state): WorktreeSplitRowFacts => {
      const key = worktreeKey(projectId, worktreeId);
      return {
        splitLocked: state.splitLockedWorktrees.has(key),
        sessionOpen: state.splitWorkflowSessions.has(key),
        planning: state.planningSplitPr.has(key),
        splitting: state.splittingPr.has(key),
        planPresent: state.splitPrPlans[key] !== undefined,
        completed: state.splitPrResults[key]?.status === 'completed',
        runningLine: buildSplitRunningStatusLine(
          state.splitPrProgress[key] ?? [],
        ),
      };
    }),
  );
}
