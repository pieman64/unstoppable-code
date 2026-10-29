import {
  isUsagePanelVariant,
  USAGE_PANEL_VARIANT_LABELS,
  USAGE_PANEL_VARIANTS,
} from '../usage-variants';

describe('usage panel variants', () => {
  it('exposes the six variants in a stable order', () => {
    expect(USAGE_PANEL_VARIANTS).toEqual([
      'all',
      'active-chat',
      'codex',
      'claude',
      'cursor',
      'copilot',
    ]);
  });

  it('labels every variant', () => {
    for (const variant of USAGE_PANEL_VARIANTS) {
      expect(USAGE_PANEL_VARIANT_LABELS[variant]).toBeTruthy();
    }
    expect(USAGE_PANEL_VARIANT_LABELS.all).toBe('Usage');
    expect(USAGE_PANEL_VARIANT_LABELS['active-chat']).toBe(
      'Usage (Active Chat)',
    );
    expect(USAGE_PANEL_VARIANT_LABELS.codex).toBe('Usage (Codex)');
    expect(USAGE_PANEL_VARIANT_LABELS.claude).toBe('Usage (Claude)');
    expect(USAGE_PANEL_VARIANT_LABELS.cursor).toBe('Usage (Cursor)');
  });

  it('guards the closed variant union', () => {
    for (const variant of USAGE_PANEL_VARIANTS) {
      expect(isUsagePanelVariant(variant)).toBe(true);
    }
    expect(isUsagePanelVariant('bogus')).toBe(false);
    expect(isUsagePanelVariant('')).toBe(false);
    expect(isUsagePanelVariant(undefined)).toBe(false);
  });
});
