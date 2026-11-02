import {
  beginGitActionCancellationScope,
  finishGitActionCancellationScope,
  type GitActionCancellationScope,
} from '../ipc/git-action-cancellation';
import { assertWritableScope } from '../lib/read-only-scope';
import { assertNotSplitLocked } from './split-lock-service';

interface GitActionTarget {
  projectId: string;
  worktreeId: string;
  operationId?: string;
}

/**
 * Registers a Git action on the worktree after refusing a Split-locked one.
 * Both steps are synchronous, while Split PR performs the inverse active-action
 * check immediately before acquiring its lock. Whichever path wins the
 * main-process turn excludes the other before either mutation can begin.
 */
export function beginExclusiveGitAction(
  target: GitActionTarget,
): GitActionCancellationScope {
  assertNotSplitLocked(
    target.projectId,
    target.worktreeId,
    'running a Git action',
  );
  return beginGitActionCancellationScope(target);
}

/**
 * Runs a Git mutation that has no cancel path (the Portal's commit, push and
 * pull) under the guards the desktop Git actions use: the read-only refusal,
 * the Split check and the worktree's Git-action lock, held until it settles.
 */
export async function runExclusiveGitMutation<T>(
  target: { projectId: string; worktreeId: string },
  run: () => Promise<T>,
): Promise<T> {
  assertWritableScope(target.projectId);
  const scope = beginExclusiveGitAction(target);
  try {
    return await run();
  } finally {
    finishGitActionCancellationScope(target, scope);
  }
}
