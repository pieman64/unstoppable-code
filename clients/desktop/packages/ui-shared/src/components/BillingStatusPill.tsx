// ---------------------------------------------------------------------------
// The one status pill for both billing lists (`InvoicesTable`,
// `BillingHistoryTable`). They render stacked in the same card, so shape,
// size, and tone vocabulary are defined here once rather than per table.
//
// Tone selection lives with the label maps (`invoiceStatusTone`,
// `billingChargeStatusTone`) so a new enum value cannot ship without both a
// label and a tone; this component only renders what it is handed.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import {
  BILLING_STATUS_TONE_CLASSES,
  type BillingStatusTone,
} from '../lib/billing-status-tone';

export interface BillingStatusPillProps {
  /** Already-humanized label, e.g. `Paid`, `Succeeded`, `Current`. */
  label: string;
  tone: BillingStatusTone;
  'data-testid'?: string;
}

/** Small rounded status pill. Never wraps, so it cannot change a row's height. */
export function BillingStatusPill({
  label,
  tone,
  'data-testid': testId,
}: BillingStatusPillProps): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BILLING_STATUS_TONE_CLASSES[tone]}`}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
