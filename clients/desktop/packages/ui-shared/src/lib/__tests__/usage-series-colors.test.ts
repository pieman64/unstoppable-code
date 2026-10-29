import {
  CONTEXT_SERIES_COLORS,
  COST_BILLING_COLORS,
  COST_SOURCE_COLORS,
  USAGE_SERIES_NEUTRALS,
} from '../usage-series-colors';

describe('usage series colors', () => {
  it('preserves the composer context meter colors and order', () => {
    expect(CONTEXT_SERIES_COLORS).toEqual([
      'var(--primitive-blue-500)',
      'var(--primitive-orange-500)',
      'var(--primitive-green-500)',
      'var(--primitive-purple-500)',
      'var(--primitive-pink-500)',
      'var(--primitive-cyan-500)',
    ]);
  });

  it('keeps colored source and billing series on distinct hues', () => {
    const neutralColors: readonly string[] = Object.values(
      USAGE_SERIES_NEUTRALS,
    );
    const coloredBillingColors = Object.values(COST_BILLING_COLORS).filter(
      (color) => !neutralColors.includes(color),
    );

    expect(
      Object.values(COST_SOURCE_COLORS).filter((color) =>
        coloredBillingColors.includes(color),
      ),
    ).toEqual([]);
  });
});
