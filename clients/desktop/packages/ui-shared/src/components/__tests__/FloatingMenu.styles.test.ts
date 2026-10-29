// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

const TOKENS_SOURCE = readFileSync(
  path.join(
    process.cwd(),
    'packages/ui-shared/src/styles/canopy-tokens-core.css',
  ),
  'utf8',
);
const FLOATING_MENU_RULES = Array.from(
  TOKENS_SOURCE.matchAll(/\.canopy-floating-menu(?:\[[^\]]+\])? \{([^}]*)\}/g),
  (match) => match[1],
).join('\n');

describe('FloatingMenu styles', () => {
  it('defines the complete Tailwind v4 z-index utility namespace', () => {
    expect(TOKENS_SOURCE).toMatch(
      /@theme inline \{[\s\S]*--z-index-sticky: 100;[\s\S]*--z-index-drawer: 200;[\s\S]*--z-index-modal: 300;[\s\S]*--z-index-dropdown: 400;[\s\S]*--z-index-toast: 500;[\s\S]*--z-index-tooltip: 600;[\s\S]*--z-index-spotlight: 700;/,
    );
  });

  it('pins the semantic layer and exact entry-only motion contract', () => {
    expect(TOKENS_SOURCE).toContain('--z-index-dropdown: 400;');
    expect(TOKENS_SOURCE).toMatch(
      /z-index:\s*var\(\s*--z-index-dropdown\s*\);/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /@keyframes floating-menu-enter \{[\s\S]*?opacity: 0;[\s\S]*?transform: scale\(0\.97\);[\s\S]*?opacity: 1;[\s\S]*?transform: scale\(1\);[\s\S]*?\}/,
    );
    expect(TOKENS_SOURCE).toContain(
      'animation: floating-menu-enter 250ms cubic-bezier(0.22, 1, 0.36, 1) both;',
    );
    expect(TOKENS_SOURCE).toContain('will-change: opacity, transform;');
    expect(FLOATING_MENU_RULES).not.toContain('transition:');
  });

  it('removes entry motion for reduced motion and keeps the 32px row contract', () => {
    expect(TOKENS_SOURCE).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.canopy-floating-menu\[data-positioned='true'\] \{\s*animation: none;/,
    );
    expect(TOKENS_SOURCE).not.toMatch(
      /\.canopy-floating-menu \.canopy-dropdown-menu-item \{[\s\S]*?min-height: 44px;/,
    );
  });

  it('clips one overflow-aware native scroll viewport inside the rounded surface', () => {
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-floating-menu\[data-scroll-viewport='true'\] \{[\s\S]*?display: grid;[\s\S]*?grid-template-rows: minmax\(0, 1fr\);[\s\S]*?overflow: hidden;[\s\S]*?\}/,
    );
    // The viewport scrolls behind the shared OverlayScrollArea (hidden
    // native scrollbar, overlay thumb), so it declares neither `overflow-y`
    // nor a scrollbar gutter — the scrollbar never takes layout and menu
    // rows keep symmetric insets.
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-floating-menu-scroll-viewport \{[\s\S]*?min-width: 0;[\s\S]*?min-height: 0;[\s\S]*?overflow-x: hidden;[\s\S]*?overscroll-behavior: contain;[\s\S]*?border-radius: var\(--radius-md\);[\s\S]*?\}/,
    );
    const viewportRule =
      TOKENS_SOURCE.match(
        /\.canopy-floating-menu-scroll-viewport \{([^}]*)\}/,
      )?.[1] ?? '';
    expect(viewportRule).not.toContain('scrollbar-gutter');
  });

  it('keeps project and worktree pickers on the same width and scroll-gutter contract', () => {
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu \{[\s\S]*?width: min\([\s\S]*?max\([\s\S]*?var\(--canopy-picker-trigger-width, 0px\),[\s\S]*?var\(--canopy-picker-minimum-width, 13\.5rem\)[\s\S]*?\),[\s\S]*?var\(--canopy-picker-maximum-width, 20rem\),[\s\S]*?calc\(100vw - 16px\)[\s\S]*?\);[\s\S]*?min-width: 0;[\s\S]*?max-width: min\(\s*var\(--canopy-picker-maximum-width, 20rem\),\s*calc\(100vw - 16px\)\s*\);[\s\S]*?overflow: hidden;[\s\S]*?\}/,
    );
    // The picker list scrolls behind the shared OverlayScrollArea (hidden
    // native scrollbar, overlay thumb), so the rule declares no scrollbar
    // gutter at all — the scrollbar never participates in layout.
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu-list \{[\s\S]*?overscroll-behavior: contain;[\s\S]*?border-radius: var\(--radius-md\);[\s\S]*?\}/,
    );
    const pickerViewportRule =
      TOKENS_SOURCE.match(/\.canopy-picker-menu-list \{([^}]*)\}/)?.[1] ?? '';
    expect(pickerViewportRule).not.toContain('scrollbar-gutter');
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu-tabs \{[\s\S]*?min-width: 0;[\s\S]*?gap: 1px;[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: none;[\s\S]*?\}/,
    );
    expect(TOKENS_SOURCE).not.toMatch(
      /\.canopy-picker-menu-tabs \{[^}]*width:\s*100%;/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu-tab \{\s*flex: 1 0 auto;\s*\}/,
    );
    // List-content keeps a 4px bottom pad even when the list is last
    // (footerless), so scrolling to the end never crops the final row.
    // Vertical surface pad is zeroed so mid-clipped rows aren't parked above
    // a dead band under the rounded corner.
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu \{[\s\S]*?padding-top: 0;[\s\S]*?padding-bottom: 0;[\s\S]*?\}/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /\.canopy-picker-menu-list-content \{\s*padding-top: 4px;\s*padding-bottom: 4px;\s*\}/,
    );
    expect(TOKENS_SOURCE).not.toMatch(
      /\.canopy-picker-menu > \[data-overlay-scroll-area\]:last-child \.canopy-picker-menu-list-content \{\s*padding-bottom: 0;\s*\}/,
    );
    // The shared overlay rail decides visibility from the app/system setting.
    // A picker-specific hide rule must not override that decision.
    expect(TOKENS_SOURCE).not.toContain(
      '.canopy-picker-menu [data-overlay-scrollbar]',
    );
  });
});
