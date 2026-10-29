import { deriveTerminalPrBadgeStatus } from '@canopy/ui-shared/lib/worktree-pr-status';
import {
  aggregateCheckStatus,
  isPrInMergeQueue,
  isPrReadyToMerge,
  type CheckStatus,
  type PrStatusData,
  type RepoPrStatus,
  type WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { WorktreeRowPrStatus } from '@canopy/ui-shared/components';

/** Merge queue badge fields for one PR; empty when it is not queued. */
export function mergeQueueBadgeFields(
  status: Pick<PrStatusData, 'state' | 'mergeQueue'>,
): Pick<
  WorktreeRowPrStatus,
  'inMergeQueue' | 'mergeQueuePosition' | 'mergeQueuePhase'
> {
  if (!isPrInMergeQueue(status)) return {};
  const position = status.mergeQueue?.position;
  const phase = status.mergeQueue?.phase;
  return {
    inMergeQueue: true,
    ...(typeof position === 'number' ? { mergeQueuePosition: position } : {}),
    ...(phase ? { mergeQueuePhase: phase } : {}),
  };
}

/**
 * The row's PR badge from desktop's live GitHub status. Shared by the legacy
 * `WorktreeItem` and the shared rail's desktop row overrides, so both rails
 * render the same badge, tooltip (including the PR body), and approval state.
 * `isMultiRepo` is the workspace's type: a multi-repo row summarizes its PRs
 * ("2 PRs") even when only one is open.
 */
export function deriveDesktopPrBadgeStatus(
  prStatus: WorktreePrStatus | null | undefined,
  isMultiRepo: boolean,
): WorktreeRowPrStatus | undefined {
  if (!prStatus) return undefined;
  const openRepos = prStatus.repos.filter(
    (
      repo,
    ): repo is RepoPrStatus & {
      status: NonNullable<RepoPrStatus['status']>;
    } =>
      repo.status !== null &&
      (repo.status.state === 'open' || repo.status.state === 'draft'),
  );
  if (openRepos.length === 0)
    return deriveTerminalPrBadgeStatus(
      prStatus.repos.map((repo) => repo.status),
      isMultiRepo,
    );
  const checkStatuses: CheckStatus[] = openRepos.map(
    (repo) => repo.status.checkStatus,
  );
  // Treat 'pending' (running) the same as 'none' — only 'passing' and
  // 'failing' matter for the badge dot.
  const effectiveStatus: CheckStatus = checkStatuses.includes('failing')
    ? 'failing'
    : checkStatuses.includes('passing')
      ? 'passing'
      : 'none';
  // Real aggregated CI status for the tooltip (keeps `pending`/`running`),
  // distinct from `effectiveStatus`, which collapses pending for the dot.
  const tooltipCiStatus = aggregateCheckStatus(checkStatuses);
  const totalUnresolved = openRepos.reduce(
    (sum, repo) => sum + (repo.status.unresolvedReviewThreadCount ?? 0),
    0,
  );
  const anyConflicts = openRepos.some((repo) => repo.status.hasConflicts);
  if (isMultiRepo) {
    const label = `${openRepos.length} ${openRepos.length === 1 ? 'PR' : 'PRs'}`;
    return {
      state: openRepos[0].status.state,
      checkStatus: effectiveStatus,
      ...(openRepos.some(
        (repo) => repo.status.reviewStatus === 'changes_requested',
      )
        ? { reviewStatus: 'changes_requested' as const }
        : openRepos.every((repo) => repo.status.reviewStatus === 'approved')
          ? { reviewStatus: 'approved' as const }
          : {}),
      isMergeReady: openRepos.every((repo) => isPrReadyToMerge(repo.status)),
      label,
      title: label,
      ciStatus: tooltipCiStatus,
      unresolvedCommentCount: totalUnresolved,
      hasConflicts: anyConflicts,
      // The row reads "in merge queue" only when every open PR is queued.
      // Position and phase are per-PR, so the summary never carries them.
      ...(openRepos.every((repo) => isPrInMergeQueue(repo.status))
        ? { inMergeQueue: true }
        : {}),
    };
  }
  const first = openRepos[0].status;
  return {
    state: first.state,
    checkStatus: effectiveStatus,
    reviewStatus: first.reviewStatus,
    isMergeReady: isPrReadyToMerge(first),
    url: first.prUrl,
    label: `PR #${first.prNumber}`,
    title: first.title,
    ...(first.body ? { description: first.body } : {}),
    ciStatus: tooltipCiStatus,
    unresolvedCommentCount: first.unresolvedReviewThreadCount ?? 0,
    hasConflicts: first.hasConflicts,
    ...mergeQueueBadgeFields(first),
  };
}
