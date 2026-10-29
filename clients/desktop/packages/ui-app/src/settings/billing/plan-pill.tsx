import type { JSX } from 'react';

export interface PlanPillProps {
  /** Display name of the current plan (e.g. "Business", "Individual", "Free"). */
  planDisplayName: string;
  dataTestId?: string;
}

/**
 * The non-trial subscription pill shown in the account dropdown when the user is
 * on a plan but not actively trialing. Shares the accent styling of {@link
 * import('./trial-badge').TrialBadge} so the pill slot reads consistently
 * whether it shows a trial countdown or a plan name.
 */
export function PlanPill({
  planDisplayName,
  dataTestId,
}: PlanPillProps): JSX.Element {
  return (
    <span
      className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium fg-accent"
      data-testid={dataTestId}
    >
      {planDisplayName}
    </span>
  );
}
