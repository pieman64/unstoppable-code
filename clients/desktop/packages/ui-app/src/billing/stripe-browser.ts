// ---------------------------------------------------------------------------
// Stripe browser (`@stripe/stripe-js`) singleton (CAN-1022 / T3).
//
// CLIENT-SAFE: this module loads Stripe.js with the *publishable* key only
// (delivered from the server via the `StripePublishableKeyProvider` context).
// It deliberately lives in a separate file from the server-only `stripe.ts`
// so the two `Stripe` types don't collide and so no secret-key code is ever
// pulled into a client bundle.
//
// `loadStripe` should only run once per publishable key, so we memoize the
// returned promise. The `<Elements>` mount that consumes this is deferred to
// T7 (CAN-1026), which supplies a SetupIntent `clientSecret`.
// ---------------------------------------------------------------------------

import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';

let cached: { key: string; promise: Promise<StripeJs | null> } | null = null;

/**
 * Return a memoized Stripe.js instance promise for the given publishable key.
 * Reuses the cached promise when the key is unchanged; re-invokes `loadStripe`
 * when a different key is passed.
 */
export function getBrowserStripe(
  publishableKey: string,
): Promise<StripeJs | null> {
  if (cached && cached.key === publishableKey) {
    return cached.promise;
  }
  cached = { key: publishableKey, promise: loadStripe(publishableKey) };
  return cached.promise;
}

/** Reset the in-memory Stripe.js cache (test seam). */
export function resetBrowserStripeForTests(): void {
  cached = null;
}
