// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

const PANELS_CSS = readFileSync(
  path.join(process.cwd(), 'packages/ui-shared/src/styles/panels.css'),
  'utf8',
);

/** Body of the rule whose selector starts a line (see panel-chrome-rhythm). */
function ruleBody(selectorLine: string): string {
  const pattern = new RegExp(
    `^${selectorLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'm',
  );
  const match = pattern.exec(PANELS_CSS);
  expect(match).not.toBeNull();
  const index = match?.index ?? 0;
  const open = PANELS_CSS.indexOf('{', index);
  const close = PANELS_CSS.indexOf('}', open);
  return PANELS_CSS.slice(open + 1, close);
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`)
    .exec(body)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
}

const FILL_ROW =
  ".canopy-panel-group-title:has(.canopy-panel-tab-bar[data-tab-style='fill'])";

/**
 * Nested pane corners: every rounded control inside a rounded pane surface
 * takes that surface's radius less the gap between their edges, so the arcs
 * stay concentric, and never drops below the 6px floor. jsdom has no layout,
 * so the formulas are pinned here; the Electron and Portal flows measure them.
 */
describe('nested pane corners (panels.css)', () => {
  it('defines the floor and the insets once', () => {
    const tokens = ruleBody(':root {');
    expect(declaration(tokens, '--canopy-panel-corner-floor')).toBe('6px');
    expect(declaration(tokens, '--canopy-panel-row-inset')).toBe('4px');
    expect(declaration(tokens, '--canopy-panel-close-inset')).toBe('2px');
    expect(declaration(tokens, '--canopy-panel-rail-inset')).toBe('7px');
  });

  it('nests the tab row tiles in the card: card less the row inset, at least the floor', () => {
    expect(
      declaration(ruleBody(`${FILL_ROW} {`), '--canopy-panel-tile-radius'),
    ).toBe(
      'max( calc(var(--inset-card-radius, 10px) - var(--canopy-panel-row-inset)), var(--canopy-panel-corner-floor) )',
    );
  });

  it('gives every control in the tab row, the Activity toggle included, the tile radius', () => {
    expect(PANELS_CSS).toMatch(
      /:is\(\s*\.canopy-panel-add-tab,\s*\.canopy-panel-chrome button,\s*\.canopy-panel-chrome-button\s*\) \{\s*border-radius: var\(--canopy-panel-tile-radius\);/,
    );
  });

  it('nests the tab close button in its tile, below the floor by exception', () => {
    // The one named exception to the corner floor: the × nests concentrically
    // (6px tab - 2px inset = 4px).
    expect(
      declaration(
        ruleBody(".canopy-panel-tab-close:where([data-tab-style='fill'] *) {"),
        'border-radius',
      ),
    ).toBe(
      'calc( var(--canopy-panel-tile-radius, 6px) - var(--canopy-panel-close-inset) )',
    );
  });

  it('gives a pane toolbar the tile radius of its fill-tab group', () => {
    expect(PANELS_CSS).toMatch(
      /\.canopy-panel-group:has\(\.canopy-panel-tab-bar\[data-tab-style='fill'\]\)\s*\.canopy-panel-toolbar\s*:is\(button, input\) \{\s*border-radius: max\(\s*calc\(var\(--inset-card-radius, 10px\) - var\(--canopy-panel-row-inset\)\),\s*var\(--canopy-panel-corner-floor\)\s*\);/,
    );
  });

  it('sits the side rail controls one inset from the rail top and sides, nested in its corner', () => {
    expect(
      declaration(
        ruleBody('.canopy-panel-collapsed-bar-vertical {'),
        'padding',
      ),
    ).toBe('var(--canopy-panel-rail-inset) 0');
    expect(
      declaration(
        ruleBody('.canopy-panel-collapsed-bar\n  :is('),
        'border-radius',
      ),
    ).toBe(
      'max( calc(var(--inset-card-radius, 10px) - var(--canopy-panel-rail-inset)), var(--canopy-panel-corner-floor) )',
    );
  });
});
