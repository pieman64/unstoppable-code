/**
 * The responsive taxonomy for the `/chat` surface, as a pure contract.
 *
 * Before this module the whole surface had exactly one breakpoint —
 * `useIsMobile()`'s `(max-width: 1023px)` — so a 360px phone and a 1000px
 * tablet received byte-identical layout. The tier splits that single boolean
 * into three named bands so a phone can be treated as a phone.
 *
 * This file is deliberately free of React and of every browser global. Three
 * consumers need the same numbers and must not disagree about them:
 *
 * - the client hook (`useLayoutTier()`), which subscribes to `matchMedia`;
 * - the web server route, which seeds the first paint from the request User
 *   Agent so the browser does not hydrate a desktop layout and then snap;
 * - tests, which assert the boundaries directly.
 *
 * A server component may import this module. It must never import a
 * `'use client'` file, which is why the tier lives here rather than beside the
 * hook.
 */

/** Phone, tablet, or desktop. There is deliberately no fourth band. */
export type LayoutTier = 'phone' | 'tablet' | 'desktop';

/** Every tier, narrow-to-wide. Order is part of the contract. */
export const LAYOUT_TIERS: readonly LayoutTier[] = [
  'phone',
  'tablet',
  'desktop',
];

/**
 * The widest viewport still treated as a phone, in CSS pixels.
 *
 * 639 is one below Tailwind's `sm` (640px) so the tier boundaries land on the
 * existing scale and no custom media query has to be introduced or kept in
 * sync with the utility classes.
 */
export const PHONE_MAX_WIDTH_PX = 639;

/**
 * The widest viewport still treated as a tablet, in CSS pixels.
 *
 * 1023 is one below Tailwind's `lg` (1024px), and is the same boundary
 * `useIsMobile()` has always used. Keeping it here is what lets `useIsMobile()`
 * be re-expressed as `useLayoutTier() !== 'desktop'` with no behavior change at
 * any existing call site.
 */
export const TABLET_MAX_WIDTH_PX = 1023;

/** `matchMedia` query that matches the phone tier and nothing else. */
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

// THERE IS DELIBERATELY NO `TABLET_MEDIA_QUERY`. One existed and was removed:
// nothing consumed it, and its presence invited exactly the wrong change.
// `useLayoutTier` subscribes to the phone query and the HISTORICAL mobile query
// (`max-width: 1023px`), then derives tablet as "mobile but not phone" — which
// is what keeps `useIsMobile()`'s original query string in the subscription set
// and makes its behaviour provably byte-identical at every existing call site.
// A tablet-specific query in the subscription set would quietly give that up.
// Re-add one only alongside a consumer that genuinely needs the band in
// isolation, and check that guarantee first.

/**
 * The historical `useIsMobile()` query, i.e. phone or tablet. Exported so the
 * hook and any server-side equivalent quote the same string.
 */
export const MOBILE_MEDIA_QUERY = `(max-width: ${TABLET_MAX_WIDTH_PX}px)`;

/**
 * The tier assumed when nothing better is known.
 *
 * `desktop` matches what `useMediaQuery` already returns for its server
 * snapshot (`false`, i.e. not mobile), so an unseeded render is unchanged from
 * today rather than newly wrong in a different direction.
 */
export const DEFAULT_LAYOUT_TIER: LayoutTier = 'desktop';

/** Maps a viewport width in CSS pixels onto its tier. */
export function layoutTierForWidth(width: number): LayoutTier {
  if (width <= PHONE_MAX_WIDTH_PX) {
    return 'phone';
  }
  if (width <= TABLET_MAX_WIDTH_PX) {
    return 'tablet';
  }
  return 'desktop';
}

/**
 * True for phone and tablet, false for desktop.
 *
 * This is exactly the predicate `useIsMobile()` answers, extracted so the two
 * cannot drift apart.
 */
export function isMobileLayoutTier(tier: LayoutTier): boolean {
  return tier !== 'desktop';
}

/** True only for the phone tier. */
export function isPhoneLayoutTier(tier: LayoutTier): boolean {
  return tier === 'phone';
}

/** Narrows an untrusted value (a prop, a query parameter) to a tier. */
export function isLayoutTier(value: unknown): value is LayoutTier {
  return LAYOUT_TIERS.some((tier): boolean => tier === value);
}

/**
 * Coerces an untrusted value to a tier, falling back to
 * {@link DEFAULT_LAYOUT_TIER}.
 */
export function normalizeLayoutTier(value: unknown): LayoutTier {
  return isLayoutTier(value) ? value : DEFAULT_LAYOUT_TIER;
}
