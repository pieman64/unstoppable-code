import { TELEMETRY_TOOL_CATEGORIES } from '@canopy/protocol/telemetry';
import { COST_TAB_SPEC, TOOLS_TAB_SPEC } from '../tab-specs';

describe('Tools tab category labels', () => {
  it('covers every telemetry category with a brand-neutral built-in label', () => {
    expect(TOOLS_TAB_SPEC.chartCountSeries).toHaveLength(
      TELEMETRY_TOOL_CATEGORIES.length,
    );
    expect(TOOLS_TAB_SPEC.chartCountSeries).toContainEqual({
      value: 'tool_canopy',
      label: 'Built-in',
    });
  });
});

describe('Cost tab disclosure', () => {
  it('separates API-price dollar estimates from subscription allowance', () => {
    const body = COST_TAB_SPEC.notice?.body ?? '';
    expect(body).toContain(
      "Dollar amounts are API-price estimates. They don't measure subscription allowance",
    );
    expect(body).not.toContain('subscription credit usage');
  });

  it('marks models and speeds without rates unavailable instead of estimating them', () => {
    expect(COST_TAB_SPEC.notice?.body).toContain(
      'Models without published API pricing are excluded from cost totals and marked unavailable in the audit trail, as are speeds without rates in the pricing data.',
    );
  });
});
