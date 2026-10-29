import { createEmptyCostTotals } from '@canopy/protocol/cost-view';
import {
  COST_BILLING_LABELS,
  COST_NOT_PRICED_LABEL,
  COST_SOURCE_LABELS,
  costBarScale,
  costBillingSegments,
  costSourceSegments,
  costTotalsSegments,
  formatCostAmount,
  formatCostDay,
  formatCostRunStart,
  formatCostShare,
  formatCostTotal,
  formatCostUpdated,
} from '../cost-format';

describe('cost format helpers', () => {
  it('formats amounts and totals with the cost panel zero and unpriced copy', () => {
    expect(formatCostAmount(0)).toBe('$0.00');
    expect(formatCostAmount(0.00234)).toBe('$0.0023');
    expect(formatCostAmount(-1)).toBe('$0.00');
    expect(formatCostAmount(Number.NaN)).toBe('$0.00');
    expect(formatCostTotal({ usd: 0, notPricedCount: 1 })).toBe(
      COST_NOT_PRICED_LABEL,
    );
    expect(formatCostTotal({ usd: 0, notPricedCount: 0 })).toBe('$0.00');
  });

  it('formats whole shares, including a visible nonzero sliver', () => {
    expect(formatCostShare(1, 0)).toBe('0%');
    expect(formatCostShare(0.5, 100)).toBe('<1%');
    expect(formatCostShare(1, 3)).toBe('33%');
  });

  it('builds labeled source and billing segments in protocol order', () => {
    const sources = costSourceSegments({
      chat: 2,
      pipeline: 0,
      subagents: 3,
      delegations: 4,
      background: 5,
    });
    expect(sources.map((segment) => segment.key)).toEqual([
      'chat',
      'pipeline',
      'subagents',
      'delegations',
      'background',
    ]);
    expect(sources.map((segment) => segment.label)).toEqual(
      Object.values(COST_SOURCE_LABELS),
    );
    expect(sources[1]?.value).toBe(0);
    expect(
      costSourceSegments(
        {
          chat: 2,
          pipeline: 0,
          subagents: 3,
          delegations: 4,
          background: 5,
        },
        ['background', 'chat'],
      ).map((segment) => segment.key),
    ).toEqual(['background', 'chat']);

    const billings = costBillingSegments({
      subscription: 1,
      ai_credits: 2,
      account_proxy: 7,
      api_key: 3,
      org_gateway: 4,
      local: 5,
      unknown: 6,
    });
    expect(billings.map((segment) => segment.key)).toEqual([
      'subscription',
      'ai_credits',
      'account_proxy',
      'api_key',
      'org_gateway',
      'local',
      'unknown',
    ]);
    expect(billings.map((segment) => segment.label)).toEqual(
      Object.values(COST_BILLING_LABELS),
    );

    const emptyTotals = createEmptyCostTotals();
    expect(costTotalsSegments(emptyTotals, 'source')).toEqual(
      costSourceSegments(emptyTotals.bySource),
    );
    expect(costTotalsSegments(emptyTotals, 'billing')).toEqual(
      costBillingSegments(emptyTotals.byBilling),
    );
  });

  it('clamps bar scale to 0..1 and returns zero without a positive maximum', () => {
    expect(costBarScale(5, 10)).toBe(0.5);
    expect(costBarScale(12, 10)).toBe(1);
    expect(costBarScale(-2, 10)).toBe(0);
    expect(costBarScale(1, 0)).toBe(0);
  });

  it('formats an ISO day in the local calendar without a timezone shift', () => {
    // Jest isolates process.env, so changing TZ here does not change Node's
    // timezone. Supply the local formatting default while honoring explicit
    // timezone options, including the ISO-day formatter's UTC override.
    const localDateFormat = jest
      .spyOn(Date.prototype, 'toLocaleDateString')
      .mockImplementation(function (this: Date, locales, options) {
        return new Intl.DateTimeFormat(locales, {
          timeZone: 'America/Los_Angeles',
          ...options,
        }).format(this);
      });
    try {
      expect(
        new Date('2026-10-01').toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
      ).toBe('Sep 30');
      expect(formatCostDay('2026-10-01')).toBe('Oct 1');
      expect(formatCostDay('2026-10-01T00:30:00.000Z')).toBe('Sep 30');
    } finally {
      localDateFormat.mockRestore();
    }
    expect(formatCostDay('2026-02-30')).toBeNull();
    expect(formatCostDay('2026-02-30T12:00:00.000Z')).toBeNull();
    expect(formatCostDay('not a day')).toBeNull();
  });

  it('formats freshness at each relative-time threshold', () => {
    const now = new Date(2026, 9, 8, 12, 0).getTime();
    const at = (elapsedMs: number): string =>
      new Date(now - elapsedMs).toISOString();

    expect(formatCostUpdated(null, now)).toBeNull();
    expect(formatCostUpdated('invalid', now)).toBeNull();
    expect(formatCostUpdated(at(59_999), now)).toBe('Updated just now');
    expect(formatCostUpdated(at(60_000), now)).toBe('Updated 1 min ago');
    expect(formatCostUpdated(at(59 * 60_000), now)).toBe('Updated 59 min ago');
    expect(formatCostUpdated(at(60 * 60_000), now)).toBe('Updated 1 hr ago');
    expect(formatCostUpdated(at(24 * 60 * 60_000), now)).toBe('Updated Oct 7');
  });

  it('formats run starts as today, yesterday, or an older local date', () => {
    const now = new Date(2026, 9, 8, 12, 0).getTime();
    const at = (
      year: number,
      month: number,
      day: number,
      hour: number,
      minute: number,
    ): string => new Date(year, month, day, hour, minute).toISOString();

    expect(formatCostRunStart(at(2026, 9, 8, 9, 12), now)).toBe(
      'Today 9:12 AM',
    );
    expect(formatCostRunStart(at(2026, 9, 7, 16, 31), now)).toBe(
      'Yesterday 4:31 PM',
    );
    expect(formatCostRunStart(at(2026, 9, 6, 16, 31), now)).toBe(
      'Oct 6 4:31 PM',
    );
  });
});

describe('account proxy billing', () => {
  it('names work the account proxy served', () => {
    expect(COST_BILLING_LABELS.account_proxy).toBe('Account proxy');
  });
});
