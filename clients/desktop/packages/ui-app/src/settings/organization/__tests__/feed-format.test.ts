import {
  formatActor,
  formatCostUsd,
  formatDurationMs,
  formatRelativeTime,
  formatTokens,
} from '../feed-format';

describe('formatActor', () => {
  it('uses the display name when present', () => {
    expect(formatActor({ userId: '1', displayName: 'Ada Lovelace' })).toBe(
      'Ada Lovelace',
    );
  });

  it('falls back when the display name is null or blank', () => {
    expect(formatActor({ userId: '1', displayName: null })).toBe('A teammate');
    expect(formatActor({ userId: '1', displayName: '   ' })).toBe('A teammate');
  });
});

describe('formatCostUsd', () => {
  it('returns null for null / non-finite', () => {
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(Number.NaN)).toBeNull();
  });

  it('uses 4 digits for sub-dollar amounts and 2 otherwise', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.0123)).toBe('$0.0123');
    expect(formatCostUsd(12.5)).toBe('$12.50');
  });
});

describe('formatTokens', () => {
  it('compacts thousands and millions', () => {
    expect(formatTokens(null)).toBeNull();
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatDurationMs', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(-5)).toBeNull();
    expect(formatDurationMs(5000)).toBe('5s');
    expect(formatDurationMs(65000)).toBe('1m 5s');
    expect(formatDurationMs(120000)).toBe('2m');
    expect(formatDurationMs(3_600_000)).toBe('1h');
  });
});

describe('formatRelativeTime', () => {
  it('returns the raw input on an unparseable date', () => {
    expect(formatRelativeTime('not-a-date')).toBe('not-a-date');
  });

  it('renders a relative string for a recent instant', () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    expect(formatRelativeTime(tenSecondsAgo)).toMatch(/^\d+s ago$/);
  });
});
