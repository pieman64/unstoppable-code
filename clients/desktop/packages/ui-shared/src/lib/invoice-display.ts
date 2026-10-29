// ---------------------------------------------------------------------------
// Invoice display helpers shared by the web billing surfaces.
//
// `InvoiceStatus` is declared HERE (not in the service) so the exhaustive
// `Record<InvoiceStatus, string>` label map below is the one compile-checked
// place a new status has to be labelled; the server imports the type back.
//
// THE TIMEZONE RULE LIVES IN THIS FILE. Invoices are period documents whose id
// (`YYYY-MM-DD`), number (`INV-YYYYMMDD`), issue date and period bounds are all
// derived from a billing-cycle start that is rarely UTC midnight. A local
// formatter would render `2026-03-07T00:30:00Z` as "Mar 6" for a UTC-8 viewer
// while the shareable URL says `2026-03-07`. Every invoice-LEVEL date therefore
// formats in UTC via the helpers below. Per-line-item `chargedAt` values are
// ordinary wall-clock timestamps and stay on the caller's local formatter,
// matching the Transactions list.
// ---------------------------------------------------------------------------

import { formatMonthDay } from './billing-format';
import type { BillingStatusTone } from './billing-status-tone';

/**
 * Honest billing status for an invoice window. The temporal state remains a
 * separate `isCurrent` boolean; `DUE` says an open personal renewal is unpaid,
 * while `FREE_TRIAL` explains a closed no-charge window.
 *
 * `NO_CHARGES` extends that same honesty rule to CLOSED periods. A closed window
 * can legitimately hold zero charges (a month whose only content was daily-drip
 * or grant ledger entries still produces a window), and calling that "Paid" on a
 * $0.00 document would be exactly the lie `isCurrent` exists to prevent.
 */
export type InvoiceStatus =
  | 'PAID'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'NO_CHARGES'
  | 'DUE'
  | 'FREE_TRIAL';

/** Exhaustive label map — a new `InvoiceStatus` fails the build without one. */
export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  PAID: 'Paid',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
  NO_CHARGES: 'No charges',
  DUE: 'Payment due',
  FREE_TRIAL: 'Free trial',
};

/**
 * Badge label for the in-progress period.
 *
 * Not "Upcoming" (Stripe) and not "Estimated" (AWS): Canopy bills in advance, so
 * the money for the open cycle is already collected and the totals shown are
 * actuals to date — neither upcoming nor an estimate.
 */
export const CURRENT_INVOICE_LABEL = 'Current';

/**
 * O(1) label lookup keyed by the raw wire string. Built once from the
 * compile-checked map above, so a new `InvoiceStatus` still cannot be added
 * without a label.
 */
const STATUS_LABELS_BY_KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(INVOICE_STATUS_LABELS),
);

/**
 * Exhaustive tone map — a new `InvoiceStatus` fails the build without one.
 *
 * `PAID` is `neutral` for the same reason `SUCCEEDED` is on the charge list: it
 * is nearly every closed invoice, so color there would drown the states that
 * need attention. The only accent in either list is the `Current` badge
 * ({@link CURRENT_INVOICE_LABEL}), which marks the one open period.
 */
export const INVOICE_STATUS_TONES: Readonly<
  Record<InvoiceStatus, BillingStatusTone>
> = {
  PAID: 'neutral',
  REFUNDED: 'info',
  PARTIALLY_REFUNDED: 'info',
  NO_CHARGES: 'neutral',
  DUE: 'warning',
  FREE_TRIAL: 'neutral',
};

/** O(1) tone lookup keyed by the raw wire string, built from the map above. */
const STATUS_TONES_BY_KEY: ReadonlyMap<string, BillingStatusTone> = new Map(
  Object.entries(INVOICE_STATUS_TONES),
);

/** Pill tone for an invoice status; unknown values render neutral. */
export function invoiceStatusTone(status: string): BillingStatusTone {
  return STATUS_TONES_BY_KEY.get(status) ?? 'neutral';
}

/**
 * True for the in-progress window whose renewal has not been paid (`DUE`). The
 * `Current` badge stays and the status renders beside it, so an overdue
 * renewal never reads as an open period with nothing owed (ECW-9231). Every
 * other current-window status is still replaced by the `Current` badge.
 */
export function isUnpaidCurrentInvoice(invoice: {
  isCurrent: boolean;
  status: string;
}): boolean {
  return invoice.isCurrent && invoice.status === 'DUE';
}

/** Map an invoice status to its label, prettifying an unknown value. */
export function humanizeInvoiceStatus(status: string): string {
  const known = STATUS_LABELS_BY_KEY.get(status);
  if (known !== undefined) {
    return known;
  }
  const spaced = status.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced === '') {
    return 'Unknown';
  }
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

interface UtcDateParts {
  year: string;
  month: string;
  day: string;
}

/** UTC calendar parts of an ISO instant, or null when unparseable. */
function utcDateParts(iso: string): UtcDateParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  const date = new Date(ms);
  return {
    year: String(date.getUTCFullYear()).padStart(4, '0'),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
  };
}

/**
 * The `YYYY-MM-DD` (UTC) invoice id — also the shareable URL segment. Derived
 * from the period start, so the id an in-progress period is given mid-cycle is
 * the one it keeps once the cycle closes.
 */
export function formatInvoiceId(iso: string): string {
  const parts = utcDateParts(iso);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : iso;
}

/** The derived display number `INV-YYYYMMDD` (UTC). No column, no index. */
export function formatInvoiceNumber(iso: string): string {
  const parts = utcDateParts(iso);
  return parts ? `INV-${parts.year}${parts.month}${parts.day}` : `INV-${iso}`;
}

/** Full "Mar 7, 2026" invoice-level date, always formatted in UTC. */
export function formatUtcDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Jul 7 – Aug 7" billing-period range, always formatted in UTC. */
export function formatUtcDateRange(startIso: string, endIso: string): string {
  return `${formatMonthDay(startIso, { timeZone: 'UTC' })} – ${formatMonthDay(
    endIso,
    { timeZone: 'UTC' },
  )}`;
}
