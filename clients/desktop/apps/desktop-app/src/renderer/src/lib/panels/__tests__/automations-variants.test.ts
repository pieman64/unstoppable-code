import {
  isAutomationsPanelVariant,
  AUTOMATIONS_PANEL_VARIANT_LABELS,
  AUTOMATIONS_PANEL_VARIANTS,
} from '../automations-variants';

describe('automations panel variants', () => {
  it('exposes the four variants in a stable order', () => {
    expect(AUTOMATIONS_PANEL_VARIANTS).toEqual([
      'full',
      'upcoming',
      'overview',
      'completed',
    ]);
  });

  it('labels every variant', () => {
    for (const variant of AUTOMATIONS_PANEL_VARIANTS) {
      expect(AUTOMATIONS_PANEL_VARIANT_LABELS[variant]).toBeTruthy();
    }
    expect(AUTOMATIONS_PANEL_VARIANT_LABELS.full).toBe('Workflows');
    expect(AUTOMATIONS_PANEL_VARIANT_LABELS.upcoming).toBe(
      'Workflows (Schedule)',
    );
    expect(AUTOMATIONS_PANEL_VARIANT_LABELS.overview).toBe(
      'Workflows (Library)',
    );
    expect(AUTOMATIONS_PANEL_VARIANT_LABELS.completed).toBe('Workflows (Runs)');
  });

  it('guards the closed variant union', () => {
    for (const variant of AUTOMATIONS_PANEL_VARIANTS) {
      expect(isAutomationsPanelVariant(variant)).toBe(true);
    }
    expect(isAutomationsPanelVariant('bogus')).toBe(false);
    expect(isAutomationsPanelVariant('all')).toBe(false);
    expect(isAutomationsPanelVariant('')).toBe(false);
    expect(isAutomationsPanelVariant(undefined)).toBe(false);
  });
});
