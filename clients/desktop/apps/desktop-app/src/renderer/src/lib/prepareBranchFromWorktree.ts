import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { useProjectsStore } from '@/stores/projectsStore';
import { useBranchFromStore } from '@/stores/branchFromStore';

export type BranchFromWorktreePreparation =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'failed'; retryable: true };

export interface PrepareBranchFromWorktreeOptions {
  uncommittedChanges?: 'prompt' | 'leave-in-source';
}

/**
 * Refreshes the source worktree's status. When that fails, says so under its
 * top bar, where branching started, unless a git action started meanwhile.
 */
async function refreshSourceStatus(
  projectId: string,
  worktreeId: string,
  showFailure: boolean,
): Promise<boolean> {
  // Load lazily: see the commit below.
  const { gitActionFailureRaiser } = await import('@/stores/githubStore');
  const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
  const refreshed = await useProjectsStore
    .getState()
    .refreshWorktreeDiffStatsVerified(projectId, worktreeId);
  if (!refreshed && showFailure) {
    raiseFailure({
      error:
        "Couldn't verify the source worktree's status. Try branching again.",
    });
  }
  return refreshed;
}

/**
 * Warn before branching from a dirty worktree and, when requested, finish the
 * existing local-only commit flow before allowing worktree creation to start.
 */
export async function prepareBranchFromWorktree(
  projectId: string,
  worktreeId: string,
  options: PrepareBranchFromWorktreeOptions = {},
): Promise<BranchFromWorktreePreparation> {
  const key = createDiffStatsKey(projectId, worktreeId);
  const refreshed = await refreshSourceStatus(
    projectId,
    worktreeId,
    options.uncommittedChanges !== 'leave-in-source',
  );
  if (!refreshed) return { status: 'failed', retryable: true };
  if (useProjectsStore.getState().uncommittedChanges[key] !== true) {
    return { status: 'ready' };
  }

  if (options.uncommittedChanges === 'leave-in-source') {
    return { status: 'ready' };
  }

  const choice = await useBranchFromStore
    .getState()
    .requestConfirmation(projectId, worktreeId);
  if (choice === null) return { status: 'cancelled' };
  if (choice === 'do-not-commit') return { status: 'ready' };

  // Load lazily to avoid adding githubStore to the chat/projects store module
  // initialization cycle. This is the same commit-only flow used by the Git
  // actions UI, including generated-message review when that preference is on.
  const { useGitHubStore } = await import('@/stores/githubStore');
  const gitHubState = useGitHubStore.getState();
  if (
    gitHubState.splitLockedWorktrees.has(key) ||
    gitHubState.committingAndPushing.has(key) ||
    gitHubState.creatingPr.has(key) ||
    gitHubState.mergingLocalBranches.has(key) ||
    gitHubState.mergingPr.has(key)
  ) {
    return { status: 'failed', retryable: true };
  }
  await useGitHubStore.getState().commitOnly(projectId, worktreeId);

  // commitOnly resolves for cancellation and handled failures too. Re-read
  // local Git state so branching proceeds only when every source repo is now
  // clean.
  const refreshedAfterCommit = await refreshSourceStatus(
    projectId,
    worktreeId,
    true,
  );
  if (!refreshedAfterCommit) return { status: 'failed', retryable: true };
  return useProjectsStore.getState().uncommittedChanges[key] !== true
    ? { status: 'ready' }
    : { status: 'failed', retryable: true };
}
