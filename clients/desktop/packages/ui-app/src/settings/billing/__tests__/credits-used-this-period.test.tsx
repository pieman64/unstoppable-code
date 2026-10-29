/**
 * Server-rendered tests for {@link CreditsUsedThisPeriod}. The component is a
 * plain text line, so `renderToString` is enough and keeps the suite free of a
 * DOM.
 *
 * The load-bearing case is the UTC one: `usagePeriodStart` is rarely UTC
 * midnight, so a local formatter would print "Jul 6" for a UTC-8 viewer on a
 * Jul 7 anchor and disagree with the invoice for the same cycle on the same
 * page.
 */
import { renderToString } from 'react-dom/server';
import { CreditsUsedThisPeriod } from '../credits-used-this-period';
import type { CreditsSummary } from '@canopy/protocol/settings/billing';

function makeSummary(overrides: Partial<CreditsSummary> = {}): CreditsSummary {
  return {
    balanceCredits: 100,
    balanceUsd: 100,
    split: {
      dripCredits: '0',
      allotmentCredits: '80',
      purchasedCredits: '20',
    },
    allotmentTotalCredits: 200,
    dailyDripCapCredits: 0,
    nextRefillAt: null,
    nextAllotmentAt: null,
    autoTopUp: {
      enabled: false,
      amountUsd: null,
      thresholdCredits: null,
      maxMonthlyUsd: null,
      disabledReason: null,
    },
    monthlySpentUsd: 0,
    usedThisCycleCredits: 0,
    usagePeriodStart: '2026-07-01T00:00:00.000Z',
    usagePeriodEnd: null,
    usagePeriodKind: 'calendar-month',
    monthlyResetAt: '2026-08-01T00:00:00.000Z',
    activeSource: 'canopy',
    udLinked: false,
    ...overrides,
  };
}

describe('CreditsUsedThisPeriod', () => {
  it('reads "used this billing period" with the cycle range', () => {
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({
          usedThisCycleCredits: 2561.69,
          usagePeriodStart: '2026-07-07T00:30:00.000Z',
          usagePeriodEnd: '2026-08-07T00:30:00.000Z',
          usagePeriodKind: 'billing-cycle',
        })}
      />,
    );
    expect(html).toContain('2,561.69 credits used this billing period');
    expect(html).toContain('Jul 7');
    expect(html).toContain('Aug 7');
  });

  it('formats the range in UTC regardless of the runner timezone', () => {
    // A 00:30Z anchor is the previous calendar day everywhere west of UTC.
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({
          usedThisCycleCredits: 1,
          usagePeriodStart: '2026-07-07T00:30:00.000Z',
          usagePeriodEnd: '2026-08-07T00:30:00.000Z',
          usagePeriodKind: 'billing-cycle',
        })}
      />,
    );
    expect(html).toContain('Jul 7');
    expect(html).not.toContain('Jul 6');
  });

  it('keeps the calendar-month copy for the fallback window', () => {
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({
          usedThisCycleCredits: 8.52,
          usagePeriodKind: 'calendar-month',
        })}
      />,
    );
    expect(html).toContain('8.52 credits used this month');
    expect(html).not.toContain('billing period');
  });

  it('reads "used in the last 30 days" for the free-access rolling window', () => {
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({
          usedThisCycleCredits: 2561.69,
          usagePeriodStart: '2026-09-08T12:00:00.000Z',
          usagePeriodEnd: '2026-10-08T12:00:00.000Z',
          usagePeriodKind: 'rolling-30-days',
        })}
        testId="billing-ai-credits-used"
      />,
    );
    expect(html).toBe(
      '<p class="mt-3 text-xs fg-secondary" data-testid="billing-ai-credits-used">2,561.69 credits used in the last 30 days</p>',
    );
    expect(html).not.toContain('billing period');
    expect(html).not.toContain('Sep 8');
  });

  it('renders nothing when no credits were consumed in the window', () => {
    expect(
      renderToString(
        <CreditsUsedThisPeriod
          summary={makeSummary({ usedThisCycleCredits: 0 })}
        />,
      ),
    ).toBe('');
  });

  it('drops the range when a billing cycle has no resolved end', () => {
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({
          usedThisCycleCredits: 4,
          usagePeriodStart: '2026-07-07T00:30:00.000Z',
          usagePeriodEnd: null,
          usagePeriodKind: 'billing-cycle',
        })}
      />,
    );
    expect(html).toContain('4 credits used this billing period');
    // No dangling empty parentheses.
    expect(html).not.toContain('(');
  });

  it('passes through the test id', () => {
    const html = renderToString(
      <CreditsUsedThisPeriod
        summary={makeSummary({ usedThisCycleCredits: 1 })}
        testId="billing-ai-credits-used"
      />,
    );
    expect(html).toContain('data-testid="billing-ai-credits-used"');
  });
});
