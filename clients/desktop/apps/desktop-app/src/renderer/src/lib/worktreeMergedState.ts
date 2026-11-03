import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';

/**
 * Store-free merge predicates. `githubStore` re-exports them for its existing
 * callers; pure modules such as the readiness launch resolver import them from
 * here so they do not pull a store into their graph.
 */
export function hasMergedPr(
  status: WorktreePrStatus | null | undefined,
): boolean {
  if (!status) return false;
  const reposWithPrs = status.repos.filter((repo) => repo.status !== null);
  return (
    reposWithPrs.length > 0 &&
    reposWithPrs.every((repo) => repo.status?.state === 'merged')
  );
}

export function shouldShowWorktreeMergedState(
  worktreeStatus: 'active' | 'done' | undefined,
  prStatus: WorktreePrStatus | null | undefined,
): boolean {
  return worktreeStatus === 'done' && hasMergedPr(prStatus);
}
