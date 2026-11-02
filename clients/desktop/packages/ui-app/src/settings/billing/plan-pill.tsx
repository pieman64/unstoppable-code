import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/components/Badge';

export interface PlanPillProps {
  /** Display name of the current plan (e.g. "Business", "Individual", "Free"). */
  planDisplayName: string;
  dataTestId?: string;
}

/**
 * The plan name on the shared neutral Badge, shown in the account dropdown
 * and the billing cards. A plan is identity, not a state, so it never takes
 * the accent or a status colour; only a running trial
 * ({@link import('./trial-badge').TrialBadge}) is tinted.
 */
export function PlanPill({
  planDisplayName,
  dataTestId,
}: PlanPillProps): JSX.Element {
  return <Badge data-testid={dataTestId}>{planDisplayName}</Badge>;
}
