import type { JSX } from 'react';
import { LoadingSpinner } from '../shared/loading';
import { GitActionProgressTooltip } from '../github/GitActionProgressTooltip';

interface WorktreePrProgressIndicatorProps {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The row's automation id, suffixed for a pinned copy by the caller. */
  readonly testId: string;
}

/**
 * The single right-rail loader a worktree row shows while its PR is being
 * created; hover keeps the rich progress detail. Shared by both rails.
 */
export function WorktreePrCreatingIndicator({
  projectId,
  worktreeId,
  testId,
}: WorktreePrProgressIndicatorProps): JSX.Element {
  return (
    <GitActionProgressTooltip
      projectId={projectId}
      worktreeId={worktreeId}
      action={{ type: 'create-pr' }}
      // Derived from the SAME (already-suffixed) `testId` the badge itself
      // carries, not a bare literal — a pinned copy's tooltip must not share
      // the in-flow row's id (CAN-3127-style collision).
      dataTestId={`${testId}-tooltip`}
    >
      <span
        role="img"
        aria-label="Creating pull request"
        tabIndex={0}
        className="focus-ring inline-flex h-3 w-3 shrink-0 items-center justify-center fg-secondary outline-none"
        data-testid={testId}
      >
        <LoadingSpinner />
      </span>
    </GitActionProgressTooltip>
  );
}

/** The same loader while the user's Merge click is being processed. */
export function WorktreePrMergingIndicator({
  projectId,
  worktreeId,
  testId,
}: WorktreePrProgressIndicatorProps): JSX.Element {
  return (
    <GitActionProgressTooltip
      projectId={projectId}
      worktreeId={worktreeId}
      action={{ type: 'merge-pr' }}
      // See `WorktreePrCreatingIndicator` above.
      dataTestId={`${testId}-tooltip`}
    >
      <span
        role="img"
        aria-label="Merging pull request"
        tabIndex={0}
        className="focus-ring inline-flex shrink-0 items-center fg-purple outline-none"
        data-testid={testId}
      >
        <LoadingSpinner />
      </span>
    </GitActionProgressTooltip>
  );
}
