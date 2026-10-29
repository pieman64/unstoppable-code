// ---------------------------------------------------------------------------
// Human-readable labels for BillingCharge `kind` and `status`, shared by the
// account and org billing-history tables (`BillingHistoryTable`).
//
// The source of truth for these enums is the Prisma `BillingChargeKind` /
// `BillingChargeStatus` enums in `apps/web`. `ui-shared` is browser-safe and
// cannot import Prisma, so the unions are mirrored here and pinned to the schema
// by a compile-time assertion at the DTO boundary
// (`apps/web/src/lib/billing/charge-history-service.ts`): adding a new Prisma
// enum value fails the build until it is added to the matching union and label
// map below, so every current and future value has an explicit label.
//
// Unknown values (e.g. a new enum value reaching an older client) never render
// as a raw `SCREAMING_SNAKE` token — the fallback prettifies them to sentence
// case so the UI degrades gracefully instead of leaking the wire enum.
// ---------------------------------------------------------------------------

import type { BillingStatusTone } from './billing-status-tone';

/** Mirror of the Prisma `BillingChargeKind` enum. */
export type BillingChargeKind =
  | 'SUBSCRIPTION_RENEWAL'
  | 'CREDIT_TOP_UP'
  | 'ONE_TIME'
  | 'SEAT_PRORATION'
  | 'PLAN_CHANGE_PRORATION';

/** Mirror of the Prisma `BillingChargeStatus` enum. */
export type BillingChargeStatus =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REFUNDED';

/**
 * What the UI actually renders: the Prisma statuses plus the derived
 * `PARTIALLY_REFUNDED` state.
 *
 * `PARTIALLY_REFUNDED` deliberately has NO enum member. A charge only flips to
 * `REFUNDED` once its reversals cover the full amount (`refund-service.ts`); a
 * partial refund keeps `status: 'SUCCEEDED'` with a non-zero
 * `amountRefundedUsd`. Rendering the raw status alone would therefore report a
 * half-refunded charge as a plain "Succeeded" for its full amount, so the
 * display status is derived from the money via
 * {@link resolveBillingChargeDisplayStatus}.
 *
 * This stays a separate union from {@link BillingChargeStatus} on purpose: the
 * compile-time guard in `charge-history-service.ts` asserts that union is
 * EXACTLY the Prisma enum, and widening it would silently defeat that check.
 */
export type BillingChargeDisplayStatus =
  | BillingChargeStatus
  | 'PARTIALLY_REFUNDED';

/**
 * Curated labels for every known charge `kind`. Exhaustive over
 * {@link BillingChargeKind} — a missing key is a compile error, so a new enum
 * value cannot ship without a label.
 */
export const BILLING_CHARGE_KIND_LABELS: Readonly<
  Record<BillingChargeKind, string>
> = {
  SUBSCRIPTION_RENEWAL: 'Subscription renewal',
  CREDIT_TOP_UP: 'Credit purchase',
  ONE_TIME: 'One-time charge',
  SEAT_PRORATION: 'Added seat (prorated)',
  PLAN_CHANGE_PRORATION: 'Plan upgrade (prorated)',
};

/**
 * Curated labels for every known charge `status`. Exhaustive over
 * {@link BillingChargeStatus} — a missing key is a compile error.
 */
export const BILLING_CHARGE_STATUS_LABELS: Readonly<
  Record<BillingChargeStatus, string>
> = {
  PENDING: 'Pending',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

/**
 * Curated labels for every status the UI can render, including the derived
 * `PARTIALLY_REFUNDED`. Exhaustive over {@link BillingChargeDisplayStatus} — a
 * missing key is a compile error.
 */
export const BILLING_CHARGE_DISPLAY_STATUS_LABELS: Readonly<
  Record<BillingChargeDisplayStatus, string>
> = {
  ...BILLING_CHARGE_STATUS_LABELS,
  PARTIALLY_REFUNDED: 'Partially refunded',
};

/**
 * Prettify an unknown `SCREAMING_SNAKE`/`kebab` enum token to sentence case
 * (`SOME_NEW_KIND` → `Some new kind`). Empty/whitespace input returns `''`.
 */
export function humanizeEnumToken(raw: string): string {
  const spaced = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced === '') {
    return '';
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function lookupLabel(
  labels: Readonly<Record<string, string>>,
  raw: string,
): string {
  // `hasOwnProperty` (not a plain `labels[raw]` truthiness check) so a raw value
  // that collides with an inherited key — `__proto__`, `toString`, `constructor`
  // — never returns a prototype-chain member (a function/object that would break
  // rendering); such tokens fall through to the sentence-case fallback instead.
  if (Object.prototype.hasOwnProperty.call(labels, raw)) {
    return labels[raw];
  }
  return humanizeEnumToken(raw);
}

/** Human-readable label for a charge `kind`, falling back for unknown values. */
export function humanizeBillingChargeKind(kind: string): string {
  return lookupLabel(BILLING_CHARGE_KIND_LABELS, kind);
}

/**
 * Human-readable label for a charge status, falling back for unknown values.
 *
 * Accepts the derived `PARTIALLY_REFUNDED` as well as the raw Prisma statuses,
 * so callers can pass {@link resolveBillingChargeDisplayStatus} output straight
 * through.
 */
export function humanizeBillingChargeStatus(status: string): string {
  return lookupLabel(BILLING_CHARGE_DISPLAY_STATUS_LABELS, status);
}

/**
 * Fold a charge's raw status and its reversed total into the status the UI
 * should render.
 *
 * - reversals cover the whole charge → `REFUNDED` (this is also what the server
 *   writes, so the derivation simply agrees with it)
 * - some money reversed, some still collected → `PARTIALLY_REFUNDED`
 * - nothing reversed, or a non-`SUCCEEDED`/`REFUNDED` status → unchanged
 *
 * A `PENDING`/`FAILED` charge is never re-labelled: there is no collected money
 * to reverse, so a stray refunded amount on one is a server-side anomaly the UI
 * must not paper over. `amountRefundedUsd` is clamped to `amountUsd` so an
 * over-refund still reads as fully refunded rather than something stranger.
 */
export function resolveBillingChargeDisplayStatus(
  status: string,
  amountUsd: number,
  amountRefundedUsd: number | null | undefined,
): string {
  if (status !== 'SUCCEEDED' && status !== 'REFUNDED') {
    return status;
  }
  const refunded = amountRefundedUsd ?? 0;
  if (!Number.isFinite(refunded) || refunded <= 0) {
    return status;
  }
  if (!Number.isFinite(amountUsd) || refunded >= amountUsd) {
    return 'REFUNDED';
  }
  return 'PARTIALLY_REFUNDED';
}

/**
 * Pill tone per charge `status`. Exhaustive over {@link BillingChargeStatus} —
 * a missing key is a compile error, so a new status cannot ship untoned.
 *
 * `SUCCEEDED` is deliberately `neutral`: it is nearly every row, and coloring
 * it would spend the reader's whole contrast budget on the outcome they already
 * expect. See `billing-status-tone.ts`.
 */
export const BILLING_CHARGE_STATUS_TONES: Readonly<
  Record<BillingChargeStatus, BillingStatusTone>
> = {
  PENDING: 'warning',
  SUCCEEDED: 'neutral',
  FAILED: 'danger',
  REFUNDED: 'info',
};

/**
 * Tones for every status the UI can render. `PARTIALLY_REFUNDED` shares
 * `REFUNDED`'s `info` tone: both say "money came back", and splitting them into
 * two accents would spend contrast on a distinction the label already makes.
 */
export const BILLING_CHARGE_DISPLAY_STATUS_TONES: Readonly<
  Record<BillingChargeDisplayStatus, BillingStatusTone>
> = {
  ...BILLING_CHARGE_STATUS_TONES,
  PARTIALLY_REFUNDED: 'info',
};

/** O(1) tone lookup keyed by the raw wire string, built from the map above. */
const TONES_BY_STATUS_KEY: ReadonlyMap<string, BillingStatusTone> = new Map(
  Object.entries(BILLING_CHARGE_DISPLAY_STATUS_TONES),
);

/** Pill tone for a charge `status`; unknown values render neutral. */
export function billingChargeStatusTone(status: string): BillingStatusTone {
  return TONES_BY_STATUS_KEY.get(status) ?? 'neutral';
}
