import type { BillingChrome } from '@canopy/protocol/settings/billing';
import type { BadgeTone } from '@canopy/ui-shared/components/Badge';
import { trialBadgeLabel } from './trial-badge-label';

/**
 * The subscription plan the account dropdown and the billing cards show, as
 * the shared `Badge`'s tone and label, so every surface shows the same plan.
 * Precedence mirrors the account menu: `displayPlan` (the highest-priced plan
 * across the user's own subscription and the orgs they manage, incl. a
 * trialing org) → an active trial countdown → the wallet-primary plan name.
 * Returns `null` when the billing chrome resolves no plan at all. A plan is
 * identity, so it is neutral; only a running trial takes the warning tone.
 */
export function subscriptionPlanBadge(
  chrome: BillingChrome | null,
): { tone: BadgeTone; label: string } | null {
  // Free app access has no plan or trial to show; the chrome clears them, and
  // this keeps a stray field from painting one.
  if (chrome?.freeAccess) {
    return null;
  }
  if (chrome?.displayPlan) {
    return { tone: 'neutral', label: chrome.displayPlan.displayName };
  }
  if (chrome?.trial?.active) {
    return { tone: 'warning', label: trialBadgeLabel(chrome.trial.endsAt) };
  }
  if (chrome?.planDisplayName) {
    return { tone: 'neutral', label: chrome.planDisplayName };
  }
  return null;
}
