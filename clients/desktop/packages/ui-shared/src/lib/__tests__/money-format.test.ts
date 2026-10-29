import {
  compactNumber,
  formatCountExact,
  formatImpactScore,
  formatUsd,
  formatUsdExact,
} from '../money-format';

describe('formatUsdExact', () => {
  it('groups thousands and keeps the cents', () => {
    expect(formatUsdExact(6658.47)).toBe('$6,658.47');
    expect(formatUsdExact(1000)).toBe('$1,000.00');
    expect(formatUsdExact(1234567.89)).toBe('$1,234,567.89');
  });

  it('pads sub-thousand values to two decimals', () => {
    expect(formatUsdExact(999.5)).toBe('$999.50');
    expect(formatUsdExact(0)).toBe('$0.00');
  });

  it('keeps the small-value rule so a near-zero period is not $0.00', () => {
    expect(formatUsdExact(0.0043)).toBe('$0.0043');
    expect(formatUsdExact(0.004)).toBe('$0.0040');
  });

  it('renders a non-finite amount as $0.00', () => {
    expect(formatUsdExact(Number.NaN)).toBe('$0.00');
    expect(formatUsdExact(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });

  it('leaves formatUsd and compactNumber untouched', () => {
    // The dense Statistics tables and charts deliberately compact; adding an
    // exact sibling must not change what they render.
    expect(formatUsd(6658.47)).toBe('$6.66K');
    expect(compactNumber(6658.47, 2)).toBe('6.66K');
  });
});

describe('formatCountExact', () => {
  it('groups thousands with a pinned locale', () => {
    expect(formatCountExact(12345)).toBe('12,345');
    expect(formatCountExact(999)).toBe('999');
    expect(formatCountExact(12.4)).toBe('12');
    expect(formatCountExact(12.6)).toBe('13');
  });

  it('renders a non-finite count as 0', () => {
    expect(formatCountExact(Number.NaN)).toBe('0');
  });
});

describe('formatImpactScore', () => {
  // The whole point of this helper: the digest Team list and the Statistics
  // People table must render the same score identically. `formatCountExact`
  // (3 fraction digits by default) rendered 17.4567 as '17.457' while
  // Statistics rendered '17.5'.
  it('keeps a single decimal place', () => {
    expect(formatImpactScore(17.4567)).toBe('17.5');
    expect(formatImpactScore(17.4)).toBe('17.4');
    expect(formatImpactScore(17)).toBe('17');
  });

  it('groups thousands with a pinned locale', () => {
    expect(formatImpactScore(12345.67)).toBe('12,345.7');
  });

  it('renders a non-finite score as 0', () => {
    expect(formatImpactScore(Number.NaN)).toBe('0');
    expect(formatImpactScore(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
