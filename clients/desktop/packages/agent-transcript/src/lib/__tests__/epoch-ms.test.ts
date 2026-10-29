import { normalizeEpochMs } from '../epoch-ms';

describe('normalizeEpochMs', () => {
  it('converts epoch seconds to milliseconds', () => {
    expect(normalizeEpochMs(1_710_000_300)).toBe(1_710_000_300_000);
  });

  it('passes milliseconds through', () => {
    expect(normalizeEpochMs(1_710_000_300_000)).toBe(1_710_000_300_000);
  });

  it('treats values just below 1e10 as seconds and 1e10 as milliseconds', () => {
    expect(normalizeEpochMs(1e10 - 1)).toBe((1e10 - 1) * 1000);
    expect(normalizeEpochMs(1e10)).toBe(1e10);
  });

  it.each([0, -1, -1_710_000_300, Number.NaN, Infinity, -Infinity])(
    'treats %s as missing',
    (value) => {
      expect(normalizeEpochMs(value)).toBeUndefined();
    },
  );
});
