// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

const COMPONENT_SOURCE = readFileSync(
  path.join(
    process.cwd(),
    'packages/ui-shared/src/components/OverlayScrollArea.tsx',
  ),
  'utf8',
);
const TOKENS_SOURCE = readFileSync(
  path.join(
    process.cwd(),
    'packages/ui-shared/src/styles/canopy-tokens-core.css',
  ),
  'utf8',
);
const SCROLLBAR_HOOK_SOURCE = readFileSync(
  path.join(
    process.cwd(),
    'packages/ui-shared/src/lib/useAlwaysVisibleScrollbars.ts',
  ),
  'utf8',
);

/**
 * Regression guard for a silent, total scroll failure.
 *
 * The overlay rail needs a positioned wrapper, but expressing that as a
 * `relative` utility on the element broke every caller that positions the
 * area itself: Tailwind emits `.relative` after `.absolute`, so a caller's
 * `absolute inset-0` lost, `inset-0` went inert, the wrapper grew to content
 * height, and the surface stopped scrolling with no visual clue.
 *
 * The fix has two load-bearing halves — zero specificity AND the `base`
 * layer. An unlayered rule beats every layered Tailwind utility regardless
 * of specificity, so `:where()` alone is not enough.
 */
describe('OverlayScrollArea positioning contract', () => {
  it('keeps the React hook behind an explicit client boundary', () => {
    expect(SCROLLBAR_HOOK_SOURCE).toMatch(/^'use client';/);
  });

  it('never hard-codes a position utility on the wrapper', () => {
    const wrapperClass = COMPONENT_SOURCE.match(
      /className=\{`([^`]*)\$\{className\}`\}/,
    )?.[1];
    expect(wrapperClass).toBeDefined();
    expect(wrapperClass).not.toMatch(/\b(relative|absolute|fixed|sticky)\b/);
  });

  it('supplies the positioning context from a zero-specificity base-layer rule', () => {
    expect(TOKENS_SOURCE).toMatch(
      /@layer base \{\s*:where\(\[data-overlay-scroll-area\]\) \{\s*position: relative;\s*\}\s*\}/,
    );
  });
});
