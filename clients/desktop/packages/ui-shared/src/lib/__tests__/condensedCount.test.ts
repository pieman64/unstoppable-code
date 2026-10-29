import { formatCondensedCount } from '../condensedCount';

describe('formatCondensedCount', () => {
  it('renders values below one thousand exactly', () => {
    expect(formatCondensedCount(0)).toBe('0');
    expect(formatCondensedCount(7)).toBe('7');
    expect(formatCondensedCount(999)).toBe('999');
  });

  it('truncates thousands to a k suffix', () => {
    expect(formatCondensedCount(1000)).toBe('1k');
    expect(formatCondensedCount(1234)).toBe('1k');
    expect(formatCondensedCount(12_345)).toBe('12k');
    expect(formatCondensedCount(999_999)).toBe('999k');
  });

  it('truncates millions to an M suffix', () => {
    expect(formatCondensedCount(1_000_000)).toBe('1M');
    expect(formatCondensedCount(1_234_567)).toBe('1M');
    expect(formatCondensedCount(999_999_999)).toBe('999M');
  });

  it('truncates billions to a B suffix', () => {
    expect(formatCondensedCount(1_000_000_000)).toBe('1B');
    expect(formatCondensedCount(1_234_567_890)).toBe('1B');
    expect(formatCondensedCount(45_000_000_000)).toBe('45B');
  });

  it('keeps the sign for negative values', () => {
    expect(formatCondensedCount(-12_345)).toBe('-12k');
    expect(formatCondensedCount(-999)).toBe('-999');
    expect(formatCondensedCount(-1_234_567)).toBe('-1M');
  });

  it('truncates fractional input toward zero before condensing', () => {
    expect(formatCondensedCount(999.9)).toBe('999');
    expect(formatCondensedCount(1999.9)).toBe('1k');
    expect(formatCondensedCount(-1999.9)).toBe('-1k');
  });

  it('falls back to 0 for non-finite input', () => {
    expect(formatCondensedCount(Number.NaN)).toBe('0');
    expect(formatCondensedCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
