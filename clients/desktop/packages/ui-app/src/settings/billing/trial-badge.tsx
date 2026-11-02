import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/components/Badge';

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
 * The single trial-status badge shared by the account billing section and the
 * org Billing tab, worded "Trial: N days left" (which reads more urgently than
 * a raw end date). A trial runs out, so it takes the warning tone next to the
 * neutral {@link import('./plan-pill').PlanPill}.
 */
export function TrialBadge({
  endsAt,
  dataTestId,
}: TrialBadgeProps): JSX.Element {
  const daysLeft = trialDaysLeft(endsAt);
  return (
    <Badge tone="warning" data-testid={dataTestId}>
      {`Trial: ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`}
    </Badge>
  );
}
