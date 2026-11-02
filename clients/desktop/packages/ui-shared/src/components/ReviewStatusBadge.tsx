import type { JSX } from 'react';
import { badgeClassName, type BadgeTone } from '../lib/badge';

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
  { label: string; tone: BadgeTone }
> = {
  approved: { label: 'Approved', tone: 'success' },
  'changes-requested': { label: 'Changes requested', tone: 'warning' },
  pending: { label: 'Pending review', tone: 'neutral' },
  none: { label: 'No reviews', tone: 'neutral' },
};

/**
 * Review state next to a PR summary, on the shared Badge: approved is
 * success, changes requested is warning, and the rest are neutral. An
 * approval that is not ready to merge is neutral too.
 */
export function ReviewStatusBadge({
  status,
  label,
  approvedTone = 'success',
  dataTestId,
}: ReviewStatusBadgeProps): JSX.Element {
  const config = CONFIG[status];
  const tone: BadgeTone =
    status === 'approved' && approvedTone === 'muted' ? 'neutral' : config.tone;
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
      className={badgeClassName(tone)}
      data-badge-tone={tone}
      title={title}
      aria-label={ariaLabel}
    >
      {label ?? config.label}
    </span>
  );
}
