import {
  compactNumber,
  computeTrend,
  costBucketTotal,
  expectedBucketStarts,
  formatBucketTick,
  formatCardValue,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  pivotBuckets,
  seriesColor,
  SERIES_PALETTE,
  tokenBucketTotal,
} from '../format';
import type {
  TelemetryCostBucket,
  TelemetryTokenBucket,
} from '@canopy/protocol/telemetry';

describe('formatUsd', () => {
  it('uses 2 decimals for normal amounts', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('uses 4 decimals for sub-cent amounts', () => {
    expect(formatUsd(0.0034)).toBe('$0.0034');
  });

  it('compacts large amounts', () => {
    expect(formatUsd(12000)).toBe('$12.00K');
  });

  it('guards against non-finite input', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('formatTokens / formatCount / compactNumber', () => {
  it('compacts token counts', () => {
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(3_400_000)).toBe('3.4M');
    expect(formatTokens(950)).toBe('950');
  });

  it('groups integer counts', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('keeps small numbers exact', () => {
    expect(compactNumber(42, 1)).toBe('42');
  });

  it('promotes to the next unit when rounding carries across a boundary', () => {
    // 999_999_999 / 1e6 rounds to 1000.00, which must render as 1.00B, not
    // 1000.00M. Same carry at the K -> M boundary.
    expect(compactNumber(999_999_999, 2)).toBe('1.00B');
    expect(compactNumber(-999_999_999, 2)).toBe('-1.00B');
    expect(compactNumber(999_999, 2)).toBe('1.00M');
    // Non-boundary values are unaffected.
    expect(compactNumber(1_500_000, 2)).toBe('1.50M');
    expect(compactNumber(2_300, 1)).toBe('2.3K');
  });
});

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('renders minute and hour durations', () => {
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('2h 5m');
  });

  it('floors non-positive or non-finite input to 0s', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-100)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatPercent', () => {
  it('rounds the ratio to a whole percent', () => {
    expect(formatPercent(3, 4)).toBe('75%');
    expect(formatPercent(1, 3)).toBe('33%');
  });

  it('returns an em dash on a zero or non-finite denominator', () => {
    expect(formatPercent(5, 0)).toBe('—');
    expect(formatPercent(5, Number.NaN)).toBe('—');
    expect(formatPercent(Number.NaN, 4)).toBe('—');
  });
});

describe('formatCardValue', () => {
  it('routes by unit', () => {
    expect(formatCardValue(5, 'currency')).toBe('$5.00');
    expect(formatCardValue(1500, 'tokens')).toBe('1.5K');
    expect(formatCardValue(1500, 'count')).toBe('1,500');
  });
});

describe('computeTrend', () => {
  it('returns null delta when no prior value', () => {
    expect(computeTrend(10, null)).toEqual({
      deltaPct: null,
      direction: 'flat',
      label: '—',
    });
  });

  it('computes positive and negative deltas', () => {
    expect(computeTrend(110, 100)).toMatchObject({
      direction: 'up',
      label: '+10.0%',
    });
    expect(computeTrend(90, 100)).toMatchObject({
      direction: 'down',
      label: '-10.0%',
    });
  });

  it('treats a zero prior window as new growth', () => {
    expect(computeTrend(5, 0)).toMatchObject({ direction: 'up', label: 'New' });
    expect(computeTrend(0, 0)).toMatchObject({
      direction: 'flat',
      label: '0%',
    });
  });
});

describe('seriesColor', () => {
  it('wraps the palette', () => {
    expect(seriesColor(0)).toBe(SERIES_PALETTE[0]);
    expect(seriesColor(SERIES_PALETTE.length)).toBe(SERIES_PALETTE[0]);
  });
});

describe('pivotBuckets', () => {
  const buckets: TelemetryTokenBucket[] = [
    {
      bucketStartIso: '2026-06-02T00:00:00.000Z',
      key: 'claude',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    {
      bucketStartIso: '2026-06-01T00:00:00.000Z',
      key: 'claude',
      inputTokens: 20,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    {
      bucketStartIso: '2026-06-01T00:00:00.000Z',
      key: 'codex',
      inputTokens: 3,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ];

  it('pivots flat buckets into sorted rows with zero-filled keys', () => {
    const { rows, keys } = pivotBuckets(buckets, tokenBucketTotal);
    expect(keys).toEqual(['claude', 'codex']);
    expect(rows).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', claude: 20, codex: 4 },
      { bucket: '2026-06-02T00:00:00.000Z', claude: 15, codex: 0 },
    ]);
  });

  it('gap-fills a single active day across a 7-day daily range', () => {
    const single: TelemetryTokenBucket[] = [
      {
        bucketStartIso: '2026-06-04T00:00:00.000Z',
        key: 'claude',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    ];
    const { rows, keys } = pivotBuckets(single, tokenBucketTotal, {
      startIso: '2026-06-01T00:00:00.000Z',
      endIso: '2026-06-08T00:00:00.000Z',
      granularity: 'day',
    });
    expect(keys).toEqual(['claude']);
    expect(rows).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', claude: 0 },
      { bucket: '2026-06-02T00:00:00.000Z', claude: 0 },
      { bucket: '2026-06-03T00:00:00.000Z', claude: 0 },
      { bucket: '2026-06-04T00:00:00.000Z', claude: 15 },
      { bucket: '2026-06-05T00:00:00.000Z', claude: 0 },
      { bucket: '2026-06-06T00:00:00.000Z', claude: 0 },
      { bucket: '2026-06-07T00:00:00.000Z', claude: 0 },
    ]);
  });

  it('includes the partial leading bucket containing startMs', () => {
    // start falls mid-day; the day-aligned bucket that contains it is emitted.
    const single: TelemetryTokenBucket[] = [
      {
        bucketStartIso: '2026-06-03T00:00:00.000Z',
        key: 'claude',
        inputTokens: 2,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    ];
    const { rows } = pivotBuckets(single, tokenBucketTotal, {
      startIso: '2026-06-02T06:00:00.000Z',
      endIso: '2026-06-04T00:00:00.000Z',
      granularity: 'day',
    });
    expect(rows.map((r) => r.bucket)).toEqual([
      '2026-06-02T00:00:00.000Z',
      '2026-06-03T00:00:00.000Z',
    ]);
  });

  it('leaves buckets untouched when no grid is provided', () => {
    const { rows } = pivotBuckets(buckets, tokenBucketTotal);
    expect(rows).toHaveLength(2);
  });

  it('returns empty rows when buckets is empty even with a grid', () => {
    const { rows, keys } = pivotBuckets([], tokenBucketTotal, {
      startIso: '2026-06-01T00:00:00.000Z',
      endIso: '2026-06-08T00:00:00.000Z',
      granularity: 'day',
    });
    expect(rows).toEqual([]);
    expect(keys).toEqual([]);
  });
});

describe('expectedBucketStarts', () => {
  it('steps hourly grids in 1-hour multiples phased off the anchor', () => {
    expect(
      expectedBucketStarts(
        {
          startIso: '2026-06-01T00:00:00.000Z',
          endIso: '2026-06-01T03:00:00.000Z',
          granularity: 'hour',
        },
        '2026-06-01T02:00:00.000Z',
      ),
    ).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T01:00:00.000Z',
      '2026-06-01T02:00:00.000Z',
    ]);
  });

  it('phases hourly grids off a non-aligned anchor (leading bucket contains startMs)', () => {
    expect(
      expectedBucketStarts(
        {
          startIso: '2026-06-01T00:00:00.000Z',
          endIso: '2026-06-01T02:00:00.000Z',
          granularity: 'hour',
        },
        '2026-06-01T00:30:00.000Z',
      ),
    ).toEqual([
      '2026-05-31T23:30:00.000Z',
      '2026-06-01T00:30:00.000Z',
      '2026-06-01T01:30:00.000Z',
    ]);
  });

  it('steps weekly grids in 7-day multiples phased off the anchor', () => {
    expect(
      expectedBucketStarts(
        {
          startIso: '2026-06-01T00:00:00.000Z',
          endIso: '2026-06-22T00:00:00.000Z',
          granularity: 'week',
        },
        '2026-06-08T00:00:00.000Z',
      ),
    ).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-08T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    ]);
  });

  it('returns an empty grid for invalid input', () => {
    expect(
      expectedBucketStarts(
        {
          startIso: 'not-a-date',
          endIso: '2026-06-08T00:00:00.000Z',
          granularity: 'day',
        },
        '2026-06-01T00:00:00.000Z',
      ),
    ).toEqual([]);
  });
});

describe('bucket totals', () => {
  it('sums all token categories', () => {
    const bucket: TelemetryTokenBucket = {
      bucketStartIso: 'x',
      key: 'claude',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 8,
    };
    expect(tokenBucketTotal(bucket)).toBe(15);
  });

  it('reads cost totals', () => {
    const bucket: TelemetryCostBucket = {
      bucketStartIso: 'x',
      key: 'claude',
      totalCostUsd: 1.25,
    };
    expect(costBucketTotal(bucket)).toBe(1.25);
  });
});

describe('formatBucketTick', () => {
  it('falls back to the raw value for invalid input', () => {
    expect(formatBucketTick('not-a-date', 'day')).toBe('not-a-date');
  });

  it('produces a short month/day label for valid dates', () => {
    expect(formatBucketTick('2026-06-15T12:00:00.000Z', 'day')).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}$/,
    );
  });

  it('labels a UTC-midnight day bucket in UTC, not the viewer local zone', () => {
    // Under a negative-offset TZ (e.g. America/Los_Angeles), a naive
    // local-zone render of this instant drifts back to "Jul 1". Rendering in
    // UTC keeps the label aligned with the UTC-bucketed rollup.
    expect(formatBucketTick('2026-07-02T00:00:00.000Z', 'day')).toBe('Jul 2');
  });

  it('labels an hourly UTC bucket in UTC', () => {
    // `\s` (not a literal space) before AM: Intl/ICU renders the AM/PM
    // separator as either a regular space or a narrow no-break space (U+202F)
    // depending on the Node/ICU build, so match either to avoid cross-version
    // brittleness while still asserting the UTC hour label.
    expect(formatBucketTick('2026-07-02T00:00:00.000Z', 'hour')).toMatch(
      /^Jul 2, 12\sAM$/,
    );
  });
});
