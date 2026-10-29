import type { DiffStats } from '@canopy/desktop-shared/types';

interface DeleteConfirmationBypassParams {
  isDone: boolean;
  hasActiveSession?: boolean;
  isArchiveInProgress?: boolean;
  isPendingGitSetup: boolean;
  isRunningSetup: boolean;
  isTearingDown: boolean;
  stats?: DiffStats;
  hasUncommittedChanges?: boolean;
  hasCommitsAhead?: boolean;
  hasUnpushedCommits?: boolean;
}

export type DeleteAction = 'delete' | 'confirm' | 'disabled';

export function shouldBypassDeleteConfirmation({
  isDone,
  isPendingGitSetup,
  isRunningSetup,
  isTearingDown,
  stats,
  hasUncommittedChanges,
  hasCommitsAhead,
  hasUnpushedCommits,
}: DeleteConfirmationBypassParams): boolean {
  if (isDone) {
    return true;
  }

  if (isPendingGitSetup || isRunningSetup || isTearingDown || !stats) {
    return false;
  }

  const hasLineChanges = stats.insertions + stats.deletions > 0;
  return (
    !hasLineChanges &&
    hasUncommittedChanges === false &&
    hasCommitsAhead === false &&
    hasUnpushedCommits === false
  );
}

export function getDeleteAction(
  params: DeleteConfirmationBypassParams,
): DeleteAction {
  if (params.hasActiveSession === true || params.isArchiveInProgress === true) {
    return 'disabled';
  }

  return shouldBypassDeleteConfirmation(params) ? 'delete' : 'confirm';
}

interface ShowStandaloneDeleteParams {
  isDone: boolean;
  isPendingGitSetup: boolean;
  isRunningSetup: boolean;
  isTearingDown: boolean;
  stats?: DiffStats;
  hasUncommittedChanges?: boolean;
  hasCommitsAhead?: boolean;
  hasUnpushedCommits?: boolean;
  /**
   * True when this worktree was recently created and its diff stats are
   * expected to be populated imminently. Lets the button render right away for
   * a brand-new worktree without also showing it for every existing worktree
   * during the brief startup window where their stats are still `undefined`.
   */
  isFreshWorktree?: boolean;
}

// Visibility check for the hover-revealed Delete button. Known uncommitted work
// (confirmed `hasUncommittedChanges` flag or loaded line changes) always hides
// the button. When stats are missing we only render the button for freshly
// created worktrees — on app startup every worktree briefly has
// `stats === undefined`, and showing the button for all of them at once would
// be misleading. The strict `shouldBypassDeleteConfirmation` check stays in
// charge of skipping the confirmation dialog, so freshly created worktrees
// show the button immediately but still confirm until the stats batch reports
// back.
export function canShowStandaloneDeleteButton({
  isDone,
  isPendingGitSetup,
  isRunningSetup,
  isTearingDown,
  stats,
  hasUncommittedChanges,
  hasCommitsAhead,
  hasUnpushedCommits,
  isFreshWorktree = false,
}: ShowStandaloneDeleteParams): boolean {
  if (isDone) {
    return false;
  }

  if (isPendingGitSetup || isRunningSetup || isTearingDown) {
    return false;
  }

  if (hasUncommittedChanges === true) {
    return false;
  }

  if (hasCommitsAhead === true || hasUnpushedCommits === true) {
    return false;
  }

  if (stats === undefined) {
    return isFreshWorktree;
  }

  return stats.insertions + stats.deletions === 0;
}

const FRESH_WORKTREE_WINDOW_MS = 30_000;

/**
 * True when `createdAt` is within the last {@link FRESH_WORKTREE_WINDOW_MS}.
 * Used to identify worktrees whose diff stats are expected to populate
 * shortly after creation, so the standalone Delete button can render before
 * the stats batch round-trips.
 */
export function isWorktreeFresh(
  createdAt: string,
  nowMs: number = Date.now(),
): boolean {
  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs < FRESH_WORKTREE_WINDOW_MS;
}
