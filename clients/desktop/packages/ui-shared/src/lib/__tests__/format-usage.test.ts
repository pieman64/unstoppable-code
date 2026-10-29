import {
  formatCost,
  formatDuration,
  formatTokenCount,
  formatUsageResetLabel,
  formatUsageResetWhen,
} from '../format-usage';

describe('formatTokenCount', () => {
  it('renders small counts verbatim', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('renders thousands with one decimal', () => {
    expect(formatTokenCount(1_000)).toBe('1.0k');
    expect(formatTokenCount(103_600)).toBe('103.6k');
  });

  it('promotes a count that would round to 1000.0k into millions', () => {
    expect(formatTokenCount(999_950)).toBe('1.0M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
});

describe('formatCost', () => {
  it('keeps four decimals below one cent', () => {
    expect(formatCost(0.0034)).toBe('$0.0034');
  });

  it('rounds to cents otherwise', () => {
    expect(formatCost(0.0234)).toBe('$0.02');
    expect(formatCost(13.5)).toBe('$13.50');
  });
});

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('renders minutes with a remainder only when there is one', () => {
    expect(formatDuration(83_000)).toBe('1m 23s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});

describe('formatUsageResetWhen', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);

  it('says when a limit resets, without the word "Resets"', () => {
    expect(formatUsageResetWhen(now + (2 * 60 + 45) * 60_000, now)).toBe(
      'in 2 hr 45 min',
    );
    expect(formatUsageResetWhen(now + 30 * 60_000, now)).toBe('in 30 min');
    expect(formatUsageResetWhen(now - 1, now)).toBe('soon');
    expect(formatUsageResetWhen(undefined, now)).toBeNull();
  });

  it('keeps the full sentence for screen readers and other readouts', () => {
    expect(formatUsageResetLabel(now + 3 * 60 * 60_000, now)).toBe(
      'Resets in 3 hr',
    );
  });
});
