import type { JSX } from 'react';
import type { BillingChrome } from '@canopy/protocol/settings/billing';
import { PlanPill } from './plan-pill';
import { TrialBadge } from './trial-badge';

/**
 * The subscription pill shared by the account dropdown and the billing cards so
 * every surface shows the same plan. Precedence mirrors the account menu:
 * `displayPlan` (the highest-priced plan across the user's own subscription and
 * the orgs they manage, incl. a trialing org) → an active trial countdown → the
 * wallet-primary plan name. Renders `fallback` (default `null`) when the billing
 * chrome resolves no plan at all — the menu passes its low-signal role chip
 * there; the billing cards pass nothing.
 */
export function SubscriptionPlanPill({
  chrome,
  dataTestId,
  fallback = null,
}: {
  chrome: BillingChrome | null;
  dataTestId?: string;
  fallback?: JSX.Element | null;
}): JSX.Element | null {
  // Free app access has no plan or trial to show; the chrome clears them, and
  // this keeps a stray field from painting one.
  if (chrome?.freeAccess) {
    return fallback;
  }
  if (chrome?.displayPlan) {
    return (
      <PlanPill
        planDisplayName={chrome.displayPlan.displayName}
        dataTestId={dataTestId}
      />
    );
  }
  if (chrome?.trial?.active) {
    return <TrialBadge endsAt={chrome.trial.endsAt} dataTestId={dataTestId} />;
  }
  if (chrome?.planDisplayName) {
    return (
      <PlanPill
        planDisplayName={chrome.planDisplayName}
        dataTestId={dataTestId}
      />
    );
  }
  return fallback;
}
