import { formatCompactAge } from '../format-relative-time';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatCompactAge', () => {
  it.each([
    [0, '1m'],
    [59_000, '1m'],
    [MINUTE, '1m'],
    [59 * MINUTE, '59m'],
    [HOUR, '1h'],
    [23 * HOUR, '23h'],
    [DAY, '1d'],
    [6 * DAY, '6d'],
    [7 * DAY, '1w'],
    [21 * DAY, '3w'],
    [29 * DAY, '4w'],
    [30 * DAY, '1mo'],
    [69 * DAY, '2mo'],
    [364 * DAY, '12mo'],
    [365 * DAY, '1y'],
    [800 * DAY, '2y'],
  ])('formats %d ms ago as %s', (ago, label) => {
    expect(formatCompactAge(NOW - ago, NOW)).toBe(label);
  });

  it('accepts ISO strings', () => {
    expect(formatCompactAge(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe(
      '3h',
    );
  });

  it('reads future and invalid times as the first minute', () => {
    expect(formatCompactAge(NOW + HOUR, NOW)).toBe('1m');
    expect(formatCompactAge('not a date', NOW)).toBe('1m');
  });
});
