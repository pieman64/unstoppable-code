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

/** Tailwind classes per tone. Background + foreground only; the pill component owns shape. */
export const BILLING_STATUS_TONE_CLASSES: Readonly<
  Record<BillingStatusTone, string>
> = {
  neutral: 'bg-muted fg-secondary',
  accent: 'bg-accent fg-emphasis',
  warning: 'bg-warning-subtle fg-warning',
  danger: 'bg-destructive-subtle fg-destructive',
  info: 'bg-info-subtle fg-info',
};
