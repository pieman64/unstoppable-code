import type { WorktreePipelineStatus } from './WorktreeItem';

export interface ResolvePipelineStatusInput {
  worktreeKey: string;
  pipelineRunningWorktreeKeys: ReadonlySet<string>;
  pipelineUnseenWorktreeKeys: ReadonlySet<string>;
  pipelineUnseenFailedWorktreeKeys: ReadonlySet<string>;
  pipelinePausedWorktreeKeys: ReadonlySet<string>;
}

/**
 * Collapses the four pipeline key sets into the single status the sidebar row
 * renders.
 *
 * `paused` outranks `unseen` deliberately. A paused execution is still live and
 * blocked on the user — it will never finish on its own — whereas `unseen` only
 * records that a terminal result has not been acknowledged yet. Because
 * `isSeenEligibleStatus` counts `paused` as seen-eligible, a freshly paused run
 * joins the unseen set too; checking `unseen` first rendered a blocked run as
 * the green "Pipeline completed" glyph until the user happened to expand the
 * activity panel. `unseen-failure` stays above `paused` so a hard failure is
 * never masked by a pause on a different run.
 */
export function resolvePipelineStatus({
  worktreeKey,
  pipelineRunningWorktreeKeys,
  pipelineUnseenWorktreeKeys,
  pipelineUnseenFailedWorktreeKeys,
  pipelinePausedWorktreeKeys,
}: ResolvePipelineStatusInput): WorktreePipelineStatus | undefined {
  if (pipelineRunningWorktreeKeys.has(worktreeKey)) {
    return 'running';
  }
  if (pipelineUnseenFailedWorktreeKeys.has(worktreeKey)) {
    return 'unseen-failure';
  }
  if (pipelinePausedWorktreeKeys.has(worktreeKey)) {
    return 'paused';
  }
  if (pipelineUnseenWorktreeKeys.has(worktreeKey)) {
    return 'unseen';
  }
  return undefined;
}
