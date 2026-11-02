// Test-only source inspection; production renderer code stays browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

/**
 * Early access inset layout: the worktree page's left panel card sits flush
 * against the sidebar edge, where the main area and the worktree section clip
 * their content. A plain clip there cuts that card's edge line and shadow on
 * its left side only (its other sides have the layout's gap), so those two clip with
 * a margin instead. jsdom does no layout, so this pins the rule itself.
 */
const GLOBALS = readFileSync(
  path.join(
    process.cwd(),
    'apps/desktop-app/src/renderer/src/styles/globals.css',
  ),
  'utf8',
);

function ruleFor(selectorFragment: string): string {
  const start = GLOBALS.indexOf(selectorFragment);
  if (start === -1) throw new Error(`No rule for ${selectorFragment}`);
  const open = GLOBALS.indexOf('{', start);
  return GLOBALS.slice(start, GLOBALS.indexOf('}', open) + 1);
}

describe('inset window layout', () => {
  it('lets the panel grid’s left card show its edge past the clip', () => {
    const rule = ruleFor(
      "main[data-main-frame='split']:has([data-testid='panel-grid-root'])",
    );
    expect(rule).toContain("[data-testid='worktree-part']");
    // Kanban's stacked board and chat still scroll in a narrow window.
    expect(
      rule.match(
        /:not\(\s*:has\(\[data-testid='worktree-kanban-board'\]\)\s*\)/g,
      ),
    ).toHaveLength(2);
    expect(rule).toContain('overflow: clip;');
    // Room for the card's shadow (a 0.5px ring and a 1px blur).
    expect(rule).toMatch(/overflow-clip-margin: [2-9]px;/);
  });

  it('draws Settings as the same inset card', () => {
    const rule = ruleFor(
      ".settings-page-overlay[data-settings-layout='inset'] [data-settings-card]",
    );
    // One hairline of room on the left, so the nav does not clip the edge.
    expect(rule).toContain(
      'margin: 0 var(--inset-card-gap) var(--inset-card-gap) var(--border-hairline);',
    );
    expect(rule).toContain('border-radius: var(--inset-card-radius);');
    // The shared inset card shadow (the value only: the theme token check
    // reads a full shadow declaration here as a custom shadow).
    expect(rule).toContain('var(--inset-card-shadow, var(--shadow-2xs));');
  });
});
