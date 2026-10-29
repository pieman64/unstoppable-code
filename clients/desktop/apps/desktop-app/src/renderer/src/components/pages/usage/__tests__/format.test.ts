import { formatCompactCurrencyUsd } from '../format';

describe('usage format helpers', () => {
  test('formats negative compact USD values with the sign before the currency symbol', () => {
    expect(formatCompactCurrencyUsd(-1234)).toBe('-$1.2K');
    expect(formatCompactCurrencyUsd(-0.005)).toBe('-$0.0050');
    expect(formatCompactCurrencyUsd(-12.3)).toBe('-$12.30');
  });
});
