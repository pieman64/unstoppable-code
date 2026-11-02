import { BADGE_TONE_CLASS, type BadgeTone } from './badge';

// ---------------------------------------------------------------------------
// Shared status-pill tones for the two billing surfaces that sit stacked in the
// same card: the invoice list (`InvoicesTable`) and the charge list
// (`BillingHistoryTable`). One vocabulary so `Paid` and `Succeeded` cannot
// drift into looking like different kinds of thing.
//
// COLOR IS RESERVED FOR THE EXCEPTIONS. The happy path (`Paid`, `Succeeded`) is
// the overwhelming majority of rows, so it renders `neutral`: a colored pill on
// every row is a stripe of green that says nothing, and it leaves no contrast
// budget for the one failed charge a reader actually needs to spot. `accent`,
// `warning`, `danger`, and `info` are therefore the rare states only.
//
// Pure strings, no React, so the tone maps can live next to the label maps in
// `billing-charge-display` / `invoice-display` and stay exhaustive over the
// mirrored enums.
// ---------------------------------------------------------------------------

/** Visual weight of a billing status pill. */
export type BillingStatusTone =
  | 'neutral'
  | 'accent'
  | 'warning'
  | 'danger'
  | 'info';

/**
 * Billing tone to shared badge tone. `accent` is kept for its name only and
 * paints info: badges never use the accent.
 */
export const BILLING_STATUS_BADGE_TONE: Readonly<
  Record<BillingStatusTone, BadgeTone>
> = {
  neutral: 'neutral',
  accent: 'info',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
};

/** Fill and ink per tone, from the shared badge. The badge owns the shape. */
export const BILLING_STATUS_TONE_CLASSES: Readonly<
  Record<BillingStatusTone, string>
> = {
  neutral: BADGE_TONE_CLASS.neutral,
  accent: BADGE_TONE_CLASS.info,
  warning: BADGE_TONE_CLASS.warning,
  danger: BADGE_TONE_CLASS.danger,
  info: BADGE_TONE_CLASS.info,
};
