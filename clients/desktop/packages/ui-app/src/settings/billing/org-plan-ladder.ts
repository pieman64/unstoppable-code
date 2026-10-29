import {
  BILLING_PLAN_KEYS,
  isPaidBillingPlanKey,
  type PaidBillingPlanKey,
} from '@canopy/protocol/billing';
import {
  billingPlanRank,
  planKeyOwnerScope,
} from '@canopy/protocol/settings/billing-plan-catalog';
import type { BillingSummary } from '@canopy/protocol/settings/billing';

/**
 * The org-scoped paid plan keys, cheapest first. Derived from the catalog
 * ({@link BILLING_PLAN_KEYS} order plus the seeded per-seat billing model that
 * {@link planKeyOwnerScope} reads) rather than hardcoded, so adding a tier above
 * Enterprise — or reordering the ladder — moves these CTAs with it instead of
 * stranding them on a stale key.
 */
export function orgPlanKeysByRank(): PaidBillingPlanKey[] {
  return BILLING_PLAN_KEYS.filter(isPaidBillingPlanKey)
    .filter((key) => planKeyOwnerScope(key) === 'org')
    .sort((a, b) => billingPlanRank(a) - billingPlanRank(b));
}

/** The entry org tier a not-yet-subscribed org buys (today: Business). */
export const ENTRY_ORG_PLAN_KEY: PaidBillingPlanKey =
  orgPlanKeysByRank()[0] ?? 'business';

/** The user-scoped paid tier the account subscribe CTA targets (`Pro`). */
export const PRO_PLAN_KEY: PaidBillingPlanKey = 'individual';

/**
 * The next org tier above `planKey`, or `null` when the org is already on the
 * top tier. `billingPlanRank` returns `-1` for an unknown/absent key, so a
 * free / no-plan org resolves to the entry tier.
 */
export function nextOrgTierAbove(
  planKey: string | null,
): PaidBillingPlanKey | null {
  const currentRank = planKey === null ? -1 : billingPlanRank(planKey);
  return (
    orgPlanKeysByRank().find((key) => billingPlanRank(key) > currentRank) ??
    null
  );
}

/** True while the org is on a not-yet-charged trial (flag or subscription status). */
export function isBillingSummaryTrialing(summary: BillingSummary): boolean {
  return summary.status === 'TRIALING' || (summary.trial?.active ?? false);
}
