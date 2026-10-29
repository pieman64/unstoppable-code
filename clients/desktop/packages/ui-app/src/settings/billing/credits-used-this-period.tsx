import { type JSX } from 'react';
import { formatCredits, formatMonthDay } from '@canopy/ui-shared/lib';
import type { CreditsSummary } from '@canopy/protocol/settings/billing';

export interface CreditsUsedThisPeriodProps {
  summary: CreditsSummary;
  /** Test id for the line (account vs. org pool). */
  testId?: string;
}

/**
 * Period-to-date consumption line shared by the personal wallet card and the
 * org credit-pool card so both read identically. Deliberately plain text, NOT a
 * progress bar: the credit balance has no single cap or reset date to fill
 * toward — allotment credits expire at the subscription cycle boundary while
 * purchased/auto-top-up credits carry a 30-day-from-purchase validity
 * (`AI_CREDIT_VALIDITY_DAYS`, expired by the CAN-1224 daily sweeper
 * `credit-expiry-service.ts`) — so a bar's
 * used/total geometry would imply a bounded monthly quota that does not exist.
 * The auto-top-up spend meter remains a bar because spend-vs-monthly-limit IS a
 * real bounded quota with a real monthly reset.
 *
 * Usage is real consumption over the window the server resolved
 * (`usedThisCycleCredits`, Σ USAGE debits since `usagePeriodStart`). That window
 * is the account's live BILLING CYCLE when there is one — the owner's own
 * subscription, or, for an org-covered member, the covering org's cycle, since
 * their seat allotment is granted on the org's anchor — and falls back to the
 * UTC calendar month otherwise. With free access on there is no billing period
 * at all, so the server reports the 30 days ending now instead. `usagePeriodKind`
 * says which rule won and drives the copy. Renders nothing when no credits were
 * consumed in that window.
 *
 * The range formats in UTC for the same reason invoice dates do:
 * `usagePeriodStart` is rarely UTC midnight, so a local formatter would render
 * "Jul 6" for a UTC-8 viewer on a Jul 7 anchor and disagree with the invoice
 * for the same cycle on the same page.
 */
export function CreditsUsedThisPeriod({
  summary,
  testId,
}: CreditsUsedThisPeriodProps): JSX.Element | null {
  const usedCredits = Math.max(0, summary.usedThisCycleCredits);
  if (usedCredits <= 0) {
    return null;
  }

  return (
    <p className="mt-3 text-xs fg-secondary" data-testid={testId}>
      {usageLabel(formatCredits(usedCredits), summary)}
    </p>
  );
}

/** The line's copy for each window kind. Exhaustive over the wire union. */
function usageLabel(amount: string, summary: CreditsSummary): string {
  const kind = summary.usagePeriodKind;
  switch (kind) {
    case 'rolling-30-days':
      return `${amount} credits used in the last 30 days`;
    case 'calendar-month':
      return `${amount} credits used this month`;
    case 'billing-cycle':
      return summary.usagePeriodEnd !== null
        ? `${amount} credits used this billing period (${formatMonthDay(
            summary.usagePeriodStart,
            { timeZone: 'UTC' },
          )} – ${formatMonthDay(summary.usagePeriodEnd, {
            timeZone: 'UTC',
          })})`
        : `${amount} credits used this billing period`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
