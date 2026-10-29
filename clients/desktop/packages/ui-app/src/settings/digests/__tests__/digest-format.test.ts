import {
  DEFAULT_DIGEST_PREFERENCES,
  DIGEST_CADENCES,
  cadenceLabel,
  formatCredits,
  formatDigestPeriod,
} from '../digest-format';

describe('formatCredits', () => {
  it('renders a fractional report cost at two decimals', () => {
    expect(formatCredits(0.42)).toBe('0.42 credits');
    expect(formatCredits(12.5)).toBe('12.50 credits');
  });

  it('does not print six digits of ledger precision', () => {
    expect(formatCredits(0.418327)).toBe('0.42 credits');
  });

  it('refuses to round a real charge away to "0 credits"', () => {
    // A cheap report still cost something. Rendering it as 0 would read as a
    // claim that generation was free.
    expect(formatCredits(0.0004)).toBe('<0.01 credits');
  });

  it('renders an exact zero and whole amounts without trailing decimals', () => {
    expect(formatCredits(0)).toBe('0 credits');
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(3)).toBe('3 credits');
  });
});

describe('formatDigestPeriod', () => {
  it('renders a weekly period from its inclusive first day to its inclusive last day', () => {
    // periodEnd is EXCLUSIVE, so a Mon 00:00 -> next Mon 00:00 week must read
    // as "Mar 3 - Mar 9", never "Mar 3 - Mar 10".
    expect(
      formatDigestPeriod(
        '2026-03-02T00:00:00.000Z',
        '2026-03-09T00:00:00.000Z',
      ),
    ).toBe('Mar 2 – Mar 8, 2026');
  });

  it('collapses a single-day (daily) period to one date', () => {
    expect(
      formatDigestPeriod(
        '2026-03-02T00:00:00.000Z',
        '2026-03-03T00:00:00.000Z',
      ),
    ).toBe('Mar 2, 2026');
  });

  it('renders a full calendar month without spilling into the next one', () => {
    expect(
      formatDigestPeriod(
        '2026-02-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toBe('Feb 1 – Feb 28, 2026');
  });

  it('qualifies both ends with a year when the period crosses a year boundary', () => {
    expect(
      formatDigestPeriod(
        '2025-12-29T00:00:00.000Z',
        '2026-01-05T00:00:00.000Z',
      ),
    ).toBe('Dec 29, 2025 – Jan 4, 2026');
  });

  it('formats in UTC regardless of the viewer timezone', () => {
    // A UTC-midnight boundary formatted in a western zone would shift back a
    // day and mislabel every period; TZ is pinned to prove it does not.
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(
        formatDigestPeriod(
          '2026-03-02T00:00:00.000Z',
          '2026-03-09T00:00:00.000Z',
        ),
      ).toContain('Mar 2');
    } finally {
      process.env.TZ = previous;
    }
  });
});

describe('cadence metadata', () => {
  it('labels every cadence the API can return', () => {
    expect(cadenceLabel('DAILY')).toBe('Daily');
    expect(cadenceLabel('WEEKLY')).toBe('Weekly');
    expect(cadenceLabel('MONTHLY')).toBe('Monthly');
    // On-demand rows appear in the archive list even though they are never a
    // preference, so the display union must cover the fourth enum value.
    expect(cadenceLabel('ON_DEMAND')).toBe('On demand');
  });

  it('falls back to the raw value for an unknown cadence', () => {
    expect(cadenceLabel('QUARTERLY')).toBe('QUARTERLY');
  });

  it('mirrors the server default of weekly-only, anchored to Monday and the 1st', () => {
    expect(DEFAULT_DIGEST_PREFERENCES).toEqual({
      daily: false,
      weekly: true,
      monthly: false,
      weeklyAnchorDay: 1,
      monthlyAnchorDay: 1,
    });
  });

  it('exposes one entry per preference field', () => {
    expect(DIGEST_CADENCES.map((entry) => entry.field)).toEqual([
      'daily',
      'weekly',
      'monthly',
    ]);
  });

  it('describes the weekly and monthly cadences from their anchors', () => {
    const describeFor = (field: 'daily' | 'weekly' | 'monthly'): string => {
      const entry = DIGEST_CADENCES.find((item) => item.field === field);
      if (!entry) throw new Error(`missing cadence ${field}`);
      return entry.describe({
        daily: true,
        weekly: true,
        monthly: true,
        weeklyAnchorDay: 5,
        monthlyAnchorDay: 12,
      });
    };

    expect(describeFor('daily')).toBe(
      'Every morning, covering the previous day.',
    );
    expect(describeFor('weekly')).toBe(
      'Every Friday, covering the previous week.',
    );
    expect(describeFor('monthly')).toBe(
      'On the 12th, covering the previous calendar month.',
    );
  });
});
