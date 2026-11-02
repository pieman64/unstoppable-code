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

const FILL = ":where([data-tab-style='fill'] *)";

/**
 * A crowded fill row: tabs shrink to a square, then the strip scrolls; the
 * "N running" chip and the `+` / ⌄ controls are drawn as sibling tiles.
 * jsdom has no layout, so the geometry these rules carry is pinned here.
 */
describe('crowded fill tab row (panels.css)', () => {
  it('stops shrinking a tab at a readable 96px, then scrolls', () => {
    const tab = ruleBody(`.canopy-panel-tab${FILL} {`);
    expect(declaration(tab, 'min-width')).toBe('96px');
    expect(declaration(tab, 'height')).toBe('28px');
  });

  it('scrolls the strip sideways once every tab is square', () => {
    const strip = ruleBody(`.canopy-panel-tab-strip${FILL} {`);
    expect(declaration(strip, 'overflow-x')).toBe('auto');
    expect(declaration(strip, 'gap')).toBe('4px');
  });

  it('fades a long title out instead of ending it in an ellipsis', () => {
    for (const selector of [
      `.canopy-panel-tab-title${FILL} {`,
      '.canopy-panel-tab-list-title {',
    ]) {
      const body = ruleBody(selector);
      expect(declaration(body, 'mask-image')).toBe(
        'linear-gradient(to right, #000 calc(100% - 8px), transparent)',
      );
      expect(declaration(body, 'text-overflow')).toBeUndefined();
    }
  });

  it('draws the "N running" chip with a tab\'s insets, corner and text', () => {
    const chip = ruleBody('.canopy-panel-tab-edge-count {');
    // 7px before the 14px glyph slot, 8px to the text, 12px after it.
    expect(declaration(chip, 'padding')).toBe('0 12px 0 7px');
    expect(declaration(chip, 'gap')).toBe('8px');
    expect(declaration(chip, 'height')).toBe('28px');
    expect(declaration(chip, 'font-size')).toBe('13px');
    expect(declaration(chip, 'border-radius')).toBe(
      'var(--canopy-panel-tile-radius, 6px)',
    );
    expect(
      declaration(ruleBody('.canopy-panel-tab-edge-count-icon {'), 'width'),
    ).toBe(declaration(ruleBody('.canopy-panel-tab-icon {'), 'width'));
  });

  it("keeps `+` and ⌄ on the row's 4px rhythm with the tabs' corner", () => {
    expect(
      declaration(ruleBody('.canopy-panel-tab-list-root {'), 'padding-left'),
    ).toBe('4px');
    // The row's last control takes the 4px trailing inset, whichever it is.
    expect(PANELS_CSS).toMatch(
      /> :is\(\s*\.canopy-panel-add-tab-root,\s*\.canopy-panel-tab-list-root\s*\):last-child:where\(\[data-tab-style='fill'\] \*\) \{\s*padding-right: 4px;/,
    );
    expect(PANELS_CSS).toMatch(
      /:is\(\s*\.canopy-panel-add-tab,\s*\.canopy-panel-chrome button,\s*\.canopy-panel-chrome-button\s*\) \{\s*border-radius: var\(--canopy-panel-tile-radius\);/,
    );
  });

  it("swaps a list row's dot for its close button, never on a running tab", () => {
    expect(PANELS_CSS).toMatch(
      /:is\(\s*\.canopy-panel-tab-list-row:hover,\s*\.canopy-panel-tab-list\[data-keyboard-moved\]\s*\.canopy-panel-tab-list-row\[data-highlighted='true'\]\s*\):not\(:has\(\[data-panel-tab-busy\]\)\)\s*\.canopy-panel-tab-list-close \{\s*visibility: visible;/,
    );
    expect(
      declaration(ruleBody('.canopy-panel-tab-list-close {'), 'position'),
    ).toBe('absolute');
  });

  it('never lets the browser draw its own search clear button', () => {
    const tokens = readFileSync(
      path.join(
        process.cwd(),
        'packages/ui-shared/src/styles/canopy-tokens-core.css',
      ),
      'utf8',
    );
    expect(tokens).toMatch(
      /input\[type='search'\]::-webkit-search-cancel-button,\s*input\[type='search'\]::-webkit-search-decoration \{\s*-webkit-appearance: none;\s*appearance: none;/,
    );
  });

  it('nests the list close button 4px inside the row, never below the floor', () => {
    const end = ruleBody('.canopy-panel-tab-list-end {');
    expect(declaration(end, 'right')).toBe('4px');
    expect(declaration(end, 'width')).toBe('24px');
    expect(
      declaration(ruleBody('.canopy-panel-tab-list-close {'), 'border-radius'),
    ).toBe(
      'max( calc(var(--radius-md) - 4px), var(--canopy-panel-corner-floor, 6px) )',
    );
    expect(
      declaration(
        ruleBody('.canopy-panel-tab-list-close:active {'),
        'background',
      ),
    ).toBe('var(--bg-quaternary)');
  });

  it('centres the list search between the list top and its divider', () => {
    expect(
      declaration(
        ruleBody('.canopy-panel-tab-list .canopy-picker-menu-search {'),
        'padding-top',
      ),
    ).toBe('0');
  });
});

describe('fill tab row polish (panels.css)', () => {
  it('fades a title only where it runs into the ×, over a fixed length, never from its start', () => {
    expect(PANELS_CSS).not.toMatch(/max-width: calc\(100% - clamp\(/);
    // The rule for tabs that draw an × (hovered, or selected with no marks),
    // never for a working tab.
    const rule =
      /\.canopy-panel-tab:is\(\s*:hover,\s*\[data-active='true'\]:not\(:has\(\.canopy-panel-tab-trailing:not\(:empty\)\)\)\s*\):has\(\.canopy-panel-tab-close-slot\):not\(\s*:has\(\.canopy-panel-tab-icon \[data-panel-tab-busy\]\)\s*\)\s*\.canopy-panel-tab-title:where\(\[data-tab-style='fill'\] \*\),[^{]*\{([^}]*)\}/.exec(
        PANELS_CSS,
      )?.[1] ?? '';
    // The box ends 2px before the × box, so short text never fades.
    expect(declaration(rule, 'max-width')).toBe('calc(100% - 16px)');
    // A fixed-length fade at the box's end, not a share of the tab.
    expect(declaration(rule, 'mask-image')).toBe(
      'linear-gradient( to right, #000 calc(100% - var(--canopy-panel-close-fade, 24px)), transparent )',
    );
    // Narrow tabs fade over 12px so a few letters stay readable.
    expect(PANELS_CSS).toMatch(
      /@container \(max-width: 140px\) \{\s*\.canopy-panel-tab-title:where\(\[data-tab-style='fill'\] \*\) \{\s*--canopy-panel-close-fade: 12px;/,
    );
  });

  it('shows the selected tab its × at rest only when it has no marks of its own', () => {
    const body = ruleBody(
      ".canopy-panel-tab[data-active='true']:not(\n    :has(.canopy-panel-tab-trailing:not(:empty))\n  )\n  .canopy-panel-tab-close-slot:where([data-tab-style='fill'] *) {",
    );
    expect(declaration(body, 'opacity')).toBe('1');
    // Marks (unsaved, lock, running, approval) give way to × only on hover
    // or keyboard focus, never just because the tab is selected.
    expect(PANELS_CSS).toMatch(
      /\.canopy-panel-tab:hover:has\(\s*\.canopy-panel-tab-close-slot\s*\):not\(\s*:has\(\.canopy-panel-tab-icon \[data-panel-tab-busy\]\)\s*\)\s*\.canopy-panel-tab-label\s*\.canopy-panel-tab-trailing:where\(\[data-tab-style='fill'\] \*\),/,
    );
  });

  it('hides ⌄ while every tab fits and dots it for unread tabs out of view', () => {
    expect(
      declaration(
        ruleBody('.canopy-panel-tab-list-root[data-hidden] {'),
        'display',
      ),
    ).toBe('none');
    const dot = ruleBody('.canopy-panel-tab-list-root::after {');
    expect(declaration(dot, 'width')).toBe('6px');
    expect(declaration(dot, 'background')).toBe('var(--bg-accent)');
    expect(declaration(dot, 'scale')).toBe('0');
    expect(
      declaration(
        ruleBody('.canopy-panel-tab-list-root[data-unread]::after {'),
        'scale',
      ),
    ).toBe('1');
  });

  it('draws the scrollbar as a 2px line on the hairline that grows to 6px', () => {
    const line = ruleBody(
      ".canopy-scroll-thumb:where(\n  [data-tab-style='fill'] .canopy-panel-tab-strip-wrap-unpinned > *\n) {",
    );
    expect(declaration(line, 'height')).toBe('2px');
    expect(declaration(line, 'bottom')).toBe('-1px');
    expect(PANELS_CSS).toMatch(
      /\.canopy-scroll-thumb\[data-overflow='true'\]\[data-active='true'\]:where\([\s\S]*?\) \{\s*bottom: -3px;\s*height: 6px;/,
    );
    expect(declaration(ruleBody('.canopy-scroll-track {'), 'height')).toBe(
      '8px',
    );
  });

  it("shows one mark per ⌄ list row: a row's own marks win over ✓ and the spinner", () => {
    const body = ruleBody(
      '.canopy-panel-tab-list-row:has(.canopy-panel-tab-list-trailing:not(:empty))',
    );
    expect(declaration(body, 'visibility')).toBe('hidden');
    expect(PANELS_CSS).toMatch(
      /\.canopy-panel-tab-list-row:has\(\.canopy-panel-tab-list-trailing:not\(:empty\)\)\s*:is\(\.canopy-panel-tab-list-check, \.canopy-panel-tab-list-busy\)/,
    );
  });
});
