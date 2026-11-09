import { useMemo, type JSX } from 'react';
import {
  Stack,
  CheckStatusBadge,
  LoadingSpinner,
  type CheckStatusBadgeStatus,
} from '@canopy/ui-shared/components';
import type {
  PullRequestSectionCheckDetail as CheckDetail,
  PullRequestSectionCheckStatus as CheckStatus,
} from '../activity/PullRequestSectionBody';

function toCheckStatusBadgeStatus(
  status: CheckStatus,
): CheckStatusBadgeStatus | null {
  switch (status) {
    case 'passing':
      return 'success';
    case 'failing':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

function CheckIcon({ status }: { status: CheckStatus }): JSX.Element {
  const mapped = toCheckStatusBadgeStatus(status);
  if (mapped === null) {
    return <LoadingSpinner tone="warning" />;
  }
  if (mapped === 'pending') {
    return (
      <CheckStatusBadge status="pending" pendingIcon={<LoadingSpinner />} />
    );
  }
  return <CheckStatusBadge status={mapped} />;
}

interface CheckDetailsListProps {
  readonly checkDetails: readonly CheckDetail[];
  /**
   * When true, the list is capped in height and scrolls its overflow. Used by
   * the top-bar CI hover popover and the framed activity card; the popped-out
   * (frameless) activity card renders the full list without a scroll cap.
   */
  readonly scrollable?: boolean;
  /** Tailwind max-height class for the scroll container. */
  readonly scrollMaxHeightClassName?: string;
}

/**
 * Shared "Checks (X/Y passing)" header plus the per-check list, ordered by
 * status priority (pending → failing → passing → neutral → none). Rendered both
 * inside the Pull Request activity card (`SingleRepoDetail`) and the worktree
 * top-bar CI hover popover so the two surfaces stay in sync.
 */
export function CheckDetailsList({
  checkDetails,
  scrollable = false,
  scrollMaxHeightClassName = 'max-h-70',
}: CheckDetailsListProps): JSX.Element {
  const sortedChecks = useMemo<CheckDetail[]>(() => {
    const priority: Record<CheckStatus, number> = {
      pending: 0,
      failing: 1,
      passing: 2,
      neutral: 3,
      none: 4,
    };
    return checkDetails
      .map((check, index) => ({ check, index }))
      .sort((a, b) => {
        const diff = priority[a.check.status] - priority[b.check.status];
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map(({ check }) => check);
  }, [checkDetails]);

  if (checkDetails.length === 0) {
    return <></>;
  }

  const passingCount = checkDetails.filter(
    (check) => check.status === 'passing',
  ).length;

  return (
    <Stack gap="tight">
      <p className="text-3xs font-semibold fg-secondary">
        Checks ({passingCount}/{checkDetails.length} passing)
      </p>
      <div
        className={
          scrollable
            ? `${scrollMaxHeightClassName} grid grid-cols-1 content-start gap-1 overflow-y-auto pr-1`
            : 'grid grid-cols-1 content-start gap-1 pr-1'
        }
      >
        {sortedChecks.map((check, index) => (
          // A flattened multi-repo list can repeat check names, so key by
          // name+position rather than name alone.
          <div
            key={`${check.name}::${index}`}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <CheckIcon status={check.status} />
              <span className="truncate fg-primary/80">{check.name}</span>
            </span>
            {check.detailsUrl && (
              <a
                href={check.detailsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 fg-secondary transition-colors hover:fg-primary"
              >
                view &rarr;
              </a>
            )}
          </div>
        ))}
      </div>
    </Stack>
  );
}
