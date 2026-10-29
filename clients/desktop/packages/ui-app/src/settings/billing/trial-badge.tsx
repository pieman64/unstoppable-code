import type { JSX } from 'react';

/** Whole days remaining until an ISO instant, clamped at zero. */
export function trialDaysLeft(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}

export interface TrialBadgeProps {
  /** ISO instant when the trial ends. */
  endsAt: string;
  dataTestId?: string;
}

/**
 * The single trial-status pill shared by the account billing section and the
 * org Billing tab. Standardizes both on the "Trial: N days left" wording (which
 * reads more urgently than a raw end date). Uses an OUTLINED accent style
 * (vs the filled {@link import('./plan-pill').PlanPill}) so that where the two
 * pills sit side by side — the org Billing tab shows the plan name and the trial
 * countdown together — the solid plan pill stays the primary identity and the
 * trial status reads as a secondary, non-competing badge.
 */
export function TrialBadge({
  endsAt,
  dataTestId,
}: TrialBadgeProps): JSX.Element {
  const daysLeft = trialDaysLeft(endsAt);
  return (
    <span
      className="rounded-full border border-line-accent px-2 py-0.5 text-xs font-medium fg-accent"
      data-testid={dataTestId}
    >
      {`Trial: ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`}
    </span>
  );
}
