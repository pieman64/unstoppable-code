/** Stable public plan identifiers (the `key` column on `billing_plans`). */
export type BillingPlanKey = 'free' | 'individual' | 'business' | 'enterprise';

/** A paid (non-`free`) plan key — the only keys card capture may grant. */
export type PaidBillingPlanKey = Exclude<BillingPlanKey, 'free'>;

/** Every valid plan key, in catalog order. */
export const BILLING_PLAN_KEYS: readonly BillingPlanKey[] = [
  'free',
  'individual',
  'business',
  'enterprise',
];

/** Narrow an arbitrary value to a known {@link BillingPlanKey}. */
export function isBillingPlanKey(value: unknown): value is BillingPlanKey {
  return (
    typeof value === 'string' && BILLING_PLAN_KEYS.some((key) => key === value)
  );
}

/**
 * Narrow an arbitrary value to a paid (non-`free`) plan key. This is the guard
 * the card-capture confirm path uses to validate a caller-supplied tier: only a
 * real plan that can actually be purchased may be granted, and `free` is
 * rejected (there is nothing to charge / subscribe for).
 */
export function isPaidBillingPlanKey(
  value: unknown,
): value is PaidBillingPlanKey {
  return isBillingPlanKey(value) && value !== 'free';
}
