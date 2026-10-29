import type { JSX } from 'react';

/** Review summary states surfaced by both apps. The portable string
 * `changes-requested` is used in place of GitHub's `changes_requested` so
 * web/desktop callers can both map cleanly. */
export type ReviewStatusBadgeStatus =
  | 'approved'
  | 'changes-requested'
  | 'pending'
  | 'none';

export interface ReviewStatusBadgeProps {
  status: ReviewStatusBadgeStatus;
  /** Optional label override. Defaults to the canonical desktop wording. */
  label?: string;
  /** Mutes an approved review when the PR is not ready to merge. */
  approvedTone?: 'success' | 'muted';
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const CONFIG: Record<
  ReviewStatusBadgeStatus,
  { label: string; className: string }
> = {
  approved: { label: 'Approved', className: 'fg-success' },
  'changes-requested': {
    label: 'Changes requested',
    className: 'fg-destructive',
  },
  pending: { label: 'Pending review', className: 'fg-warning' },
  none: { label: 'No reviews', className: 'fg-secondary' },
};

/**
 * Pure review-status label rendered next to a PR summary. Variant maps to
 * a text color; no surrounding pill chrome to match the desktop visual.
 */
export function ReviewStatusBadge({
  status,
  label,
  approvedTone = 'success',
  dataTestId,
}: ReviewStatusBadgeProps): JSX.Element {
  const config = CONFIG[status];
  const className =
    status === 'approved' && approvedTone === 'muted'
      ? 'fg-secondary'
      : config.className;
  const title =
    status === 'approved' && approvedTone === 'muted'
      ? 'Has PR approval but is not ready to merge'
      : undefined;
  const ariaLabel =
    status === 'approved' && approvedTone === 'muted'
      ? 'Approved, not ready to merge'
      : undefined;
  return (
    <span
      data-testid={dataTestId}
      className={`text-xs ${className}`}
      title={title}
      aria-label={ariaLabel}
    >
      {label ?? config.label}
    </span>
  );
}
