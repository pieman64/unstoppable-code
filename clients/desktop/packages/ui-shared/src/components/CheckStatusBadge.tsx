import type { JSX, ReactNode } from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/** Canonical check status — matches desktop's `CheckStatus` palette but
 * uses portable names instead of GitHub-specific verbs. */
export type CheckStatusBadgeStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral';

export interface CheckStatusBadgeProps {
  status: CheckStatusBadgeStatus;
  /** Optional pending-spinner override. Caller can pass a `<LoadingSpinner />`
   * if it wants animation; the default static dot avoids importing
   * runtime-only spinner CSS into this shared file. */
  pendingIcon?: ReactNode;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Optional override for the wrapper span class. */
  className?: string;
}

/**
 * Pure check-status glyph used for PR check rows, agent self-test feeds, and
 * other terse pass/fail indicators. Renders a check mark, X, dot, or pending
 * indicator depending on `status`.
 */
export function CheckStatusBadge({
  status,
  pendingIcon,
  dataTestId,
  className,
}: CheckStatusBadgeProps): JSX.Element {
  const wrapperClass = className ?? 'inline-flex items-center';
  if (status === 'success') {
    return (
      <span
        data-testid={dataTestId}
        className={`${wrapperClass} ${OPERATIONAL_STATUS_COLORS.success.foreground}`}
      >
        {'✓'}
      </span>
    );
  }
  if (status === 'failure') {
    return (
      <span
        data-testid={dataTestId}
        className={`${wrapperClass} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`}
      >
        {'✗'}
      </span>
    );
  }
  if (status === 'neutral') {
    return (
      <span
        data-testid={dataTestId}
        className={`${wrapperClass} ${OPERATIONAL_STATUS_COLORS.paused.foreground}`}
      >
        {'•'}
      </span>
    );
  }
  // pending — show the pending icon (caller-provided spinner or a quiet
  // ring) tinted with the shared unread/pending status color.
  return (
    <span
      data-testid={dataTestId}
      className={`${wrapperClass} ${OPERATIONAL_STATUS_COLORS.unread.foreground}`}
    >
      {pendingIcon ?? (
        <span className="inline-flex h-2.5 w-2.5 items-center justify-center">
          <span
            className={`h-1.5 w-1.5 rounded-full border ${OPERATIONAL_STATUS_COLORS.unread.border}`}
          />
        </span>
      )}
    </span>
  );
}
