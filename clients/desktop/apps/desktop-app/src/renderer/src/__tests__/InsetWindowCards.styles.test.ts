/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const GLOBALS_SOURCE = readFileSync(
  join(__dirname, '..', 'styles', 'globals.css'),
  'utf-8',
);

const FLOATING_SIDEBAR_SHADOW =
  'var(--border-hairline) 0 0 0 var(--inset-card-edge-color, var(--line-base)), 12px 0 24px -12px var(--sidebar-preview-shadow-color)';

interface CssRule {
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/** Top-level rules of the inset window layout, comments stripped. */
function insetLayoutRules(): CssRule[] {
  return topLevelRules().filter((rule) =>
    rule.selector.includes("[data-window-layout='inset']"),
  );
}

/** Every top-level rule of the stylesheet, comments stripped. */
function topLevelRules(): CssRule[] {
  const source = GLOBALS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = rulePattern.exec(source);
  while (match !== null) {
    const selector = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    {
      const declarations = new Map<string, string>();
      for (const declaration of (match[2] ?? '').split(';')) {
        const colon = declaration.indexOf(':');
        if (colon === -1) continue;
        declarations.set(
          declaration.slice(0, colon).trim(),
          declaration
            .slice(colon + 1)
            .replace(/\s+/g, ' ')
            .trim(),
        );
      }
      rules.push({ selector, declarations });
    }
    match = rulePattern.exec(source);
  }
  return rules;
}

describe('inset window layout cards', () => {
  const rules = insetLayoutRules();
  // A card is a surface the layout fills with the card color.
  const cards = rules.filter(
    (rule) => rule.declarations.get('background-color') === 'var(--bg-primary)',
  );

  it('frames every card in the window: pages, Settings, loading, panels', () => {
    const selectors = cards.map((card) => card.selector).join('\n');
    expect(cards).toHaveLength(4);
    expect(selectors).toContain("main[data-main-frame='card']");
    expect(selectors).toContain('.settings-page-overlay');
    expect(selectors).toContain('[data-panel-grid-loading]');
    expect(selectors).toContain('.canopy-panel-group');
  });

  it('gives every card the same radius, fill and edge', () => {
    for (const card of cards) {
      expect([
        card.selector,
        card.declarations.get('border-radius'),
        card.declarations.get('box-shadow'),
      ]).toEqual([
        card.selector,
        'var(--inset-card-radius)',
        'var(--inset-card-shadow)',
      ]);
      expect(card.declarations.has('border')).toBe(false);
      expect(card.declarations.has('outline')).toBe(false);
    }
  });

  it('draws no other shadow in the layout than the card edge, the resize handle and the floating sidebar', () => {
    const shadows = rules
      .filter((rule) => rule.declarations.has('box-shadow'))
      .map((rule) => rule.declarations.get('box-shadow'));
    expect(new Set(shadows)).toEqual(
      new Set([
        'var(--inset-card-shadow)',
        'var(--shadow-xl)',
        FLOATING_SIDEBAR_SHADOW,
      ]),
    );
  });

  it('frames Settings once: its page scroller is not a second card', () => {
    const settings = topLevelRules().filter((rule) =>
      rule.selector.includes("[data-testid='settings-content']"),
    );
    const framed = settings.filter((rule) =>
      ['background-color', 'box-shadow', 'border-radius', 'margin'].some(
        (property) => rule.declarations.has(property),
      ),
    );
    expect(framed.map((rule) => rule.selector)).toEqual([
      ".settings-page-overlay[data-settings-layout='inset'] [data-testid='settings-content']",
    ]);
    expect(framed[0]?.declarations.get('box-shadow')).toBe(
      'var(--inset-card-shadow, var(--shadow-2xs))',
    );
  });

  it('edges the floating sidebar on its right side only', () => {
    const preview = rules.find(
      (rule) =>
        rule.selector ===
        "[data-window-layout='inset'] .app-sidebar-material.app-sidebar-preview-surface",
    );
    expect(preview?.declarations.get('box-shadow')).toBe(
      FLOATING_SIDEBAR_SHADOW,
    );
    // Every layer is offset to the right with no spread ring and no inset
    // highlight, so nothing outlines the top, left or bottom.
    expect(FLOATING_SIDEBAR_SHADOW).not.toMatch(/(^|, )inset /);
    expect(FLOATING_SIDEBAR_SHADOW).not.toMatch(/(^|, )0 0 0 /);
  });

  it('dark mode: draws the tab row divider in the card edge color', () => {
    const edgeColor = rules.find((rule) =>
      rule.declarations.has('--inset-card-edge-color'),
    );
    expect(edgeColor?.selector).toBe(".dark [data-window-layout='inset']");
    const divider = rules.find(
      (rule) =>
        rule.declarations.get('border-bottom-color') ===
        'var(--inset-card-edge-color)',
    );
    // Dark only, and never while the tab row hides its divider.
    expect(divider?.selector).toBe(
      ".dark [data-window-layout='inset'] .canopy-panel-group:not([data-title-edge='top']) > .canopy-panel-group-title",
    );
  });

  it('defines the card edge once per color mode, outside the card', () => {
    // A page fills its card with its own background, which would paint over
    // a line drawn inside the card's edge.
    const edges = rules
      .filter((rule) => rule.declarations.has('--inset-card-shadow'))
      .map((rule) => [
        rule.selector,
        rule.declarations.get('--inset-card-shadow'),
      ]);
    expect(edges).toEqual([
      ["[data-window-layout='inset']", 'var(--shadow-2xs)'],
      [
        ".dark [data-window-layout='inset']",
        '0 0 0 var(--border-hairline) var(--inset-card-edge-color)',
      ],
    ]);
  });
});
