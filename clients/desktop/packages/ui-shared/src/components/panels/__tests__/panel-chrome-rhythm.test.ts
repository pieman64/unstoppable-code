// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

const PANELS_CSS = readFileSync(
  path.join(process.cwd(), 'packages/ui-shared/src/styles/panels.css'),
  'utf8',
);

/**
 * The tab strip's trailing controls sit on a uniform 4px rhythm: the
 * add-panel button's `margin-left` and the chrome cluster's `gap` both use it.
 *
 * The in-strip `+` is anchored just outside the scrollable tab list, so once
 * the tabs fill the strip it butts directly against that cluster. Any
 * TRAILING padding on its wrapper stacks with the cluster's 4px margin — a
 * measured 6px gap after the `+` while every other gap stayed 4px. Leading
 * padding is fine (it separates the `+` from the last tab).
 */
describe('panel chrome spacing rhythm', () => {
  /**
   * Body of the rule whose selector STARTS a line.
   *
   * A substring search is not safe here: `.canopy-panel-add-tab-root {` is
   * also the tail of `.canopy-panel-collapsed-bar > .canopy-panel-add-tab-root
   * {`, so an unanchored match read the wrong rule and passed while the real
   * one was wrong.
   */
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

  it('gives the add-tab wrapper no trailing padding', () => {
    const body = ruleBody('.canopy-panel-add-tab-root {');
    const padding = /padding:\s*([^;]+);/.exec(body)?.[1]?.trim();
    expect(padding).toBeDefined();
    // Either explicit 4-value/'0 0 0 Npx' form, or an explicit padding-right
    // of 0 — what must never return is a symmetric `0 Npx`.
    expect(padding).not.toMatch(/^0\s+[1-9]/);
  });

  it('keeps one 4px rhythm for the trailing cluster', () => {
    expect(ruleBody('.canopy-panel-chrome {')).toMatch(/gap:\s*4px/);
    expect(
      ruleBody('.canopy-panel-group-title > .canopy-panel-add-tab-root,'),
    ).toMatch(/margin-left:\s*4px/);
  });
});

/**
 * The close button's rich tooltip wraps it in a `.canopy-panel-tab-close-slot`
 * span (CAN-2799). The icon-slot geometry (absolute, 12px/11px) and the
 * hover reveal must live on that wrapper so the button does not move and the
 * hidden slot never captures hover for a tooltip with no visible button.
 * Fill tabs (`data-tab-style='fill'`) float the same slot over the label's
 * right end instead.
 */
describe('panel tab close slot geometry', () => {
  const CLASSIC = ":not(:where([data-tab-style='fill'] *))";
  const FILL = ":where([data-tab-style='fill'] *)";

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

  it('positions the tooltip slot, not the button, in the icon slot', () => {
    const slot = ruleBody(`.canopy-panel-tab-close-slot${CLASSIC} {`);
    expect(slot).toMatch(/position:\s*absolute/);
    expect(slot).toMatch(/left:\s*12px/);
    expect(slot).toMatch(/top:\s*11px/);
    expect(slot).toMatch(/opacity:\s*0/);
    expect(slot).toMatch(/pointer-events:\s*none/);
    const button = ruleBody('.canopy-panel-tab-close {');
    expect(button).not.toMatch(/position:\s*absolute/);
    expect(button).not.toMatch(/opacity:\s*0/);
  });

  it('reveals the slot on tab hover and close-button focus', () => {
    expect(PANELS_CSS).toMatch(
      /\.canopy-panel-tab:hover \.canopy-panel-tab-close-slot,\n\.canopy-panel-tab-close-slot:has\(\.canopy-panel-tab-close:focus-visible\) \{/,
    );
  });

  it('withholds the whole slot for busy tabs', () => {
    expect(
      ruleBody(
        `.canopy-panel-tab:has(.canopy-panel-tab-icon [data-panel-tab-busy])\n  .canopy-panel-tab-close-slot${CLASSIC} {`,
      ),
    ).toMatch(/display:\s*none/);
  });

  it('floats the fill slot, not the button, over the label end', () => {
    // The probe places it and wraps it out of view on a narrow label.
    const probe = ruleBody(`.canopy-panel-tab-close-probe${FILL} {`);
    expect(probe).toMatch(/position:\s*absolute/);
    expect(probe).toMatch(/right:\s*-10px/);
    expect(probe).toMatch(/flex-wrap:\s*wrap/);
    expect(probe).toMatch(/overflow:\s*clip/);
    const slot = ruleBody(`.canopy-panel-tab-close-slot${FILL} {`);
    expect(slot).toMatch(/opacity:\s*0/);
    expect(slot).toMatch(/pointer-events:\s*none/);
    expect(ruleBody(`.canopy-panel-tab-close${FILL} {`)).not.toMatch(
      /position:\s*absolute/,
    );
  });

  it('withholds the fill slot, keeping its space, for busy tabs', () => {
    expect(
      ruleBody(
        `.canopy-panel-tab:has(.canopy-panel-tab-icon [data-panel-tab-busy])\n  .canopy-panel-tab-close-slot${FILL} {`,
      ),
    ).toMatch(/visibility:\s*hidden/);
  });
});
