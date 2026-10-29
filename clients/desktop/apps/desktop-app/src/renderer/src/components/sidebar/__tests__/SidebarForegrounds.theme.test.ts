/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const GLOBALS_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'styles', 'globals.css'),
  'utf-8',
);
// Shared sidebar row styles (the account avatar mask, the icon skeleton) live
// with the shared tokens so the web portal's identical row paints the same.
const SHARED_TOKENS_SOURCE = readFileSync(
  join(
    __dirname,
    ...Array<string>(8).fill('..'),
    'packages',
    'ui-shared',
    'src',
    'styles',
    'canopy-tokens-core.css',
  ),
  'utf-8',
);
const GENERATED_THEME_SOURCE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ui-shared',
    'src',
    'styles',
    'generated-theme-tokens.css',
  ),
  'utf-8',
);

describe('sidebar foreground hierarchy', () => {
  it('supports opaque and translucent window materials', () => {
    const opaqueMaterialRule = GLOBALS_SOURCE.match(
      /html\[data-platform='darwin'\] \.app-window-material \{([\s\S]*?)\n\}/,
    )?.[1];
    const translucentMaterialRule = GLOBALS_SOURCE.match(
      /html\[data-platform='darwin'\]\[data-sidebar-appearance='translucent'\][\s\S]*?\.app-window-material \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(opaqueMaterialRule).toContain(
      '--app-window-material-tint-opacity: 100%;',
    );
    expect(opaqueMaterialRule).toContain('-webkit-backdrop-filter: none;');
    expect(translucentMaterialRule).toContain(
      '--app-window-material-tint-opacity: 56%;',
    );
    expect(translucentMaterialRule).toContain(
      '-webkit-backdrop-filter: blur(8px) saturate(100%);',
    );
  });

  it('maps translucent sidebar semantics to generated alpha tokens', () => {
    const sidebarRule = GLOBALS_SOURCE.match(
      /html\[data-sidebar-appearance='translucent'\] \.app-sidebar-material \{([\s\S]*?)\}/,
    )?.[1];

    expect(sidebarRule).toContain('--fg-primary: var(--sidebar-fg-primary);');
    expect(sidebarRule).toContain(
      '--fg-secondary: var(--sidebar-fg-secondary);',
    );
    expect(sidebarRule).toContain('--fg-tertiary: var(--sidebar-fg-tertiary);');
    expect(sidebarRule).toContain(
      '--fg-quaternary: var(--sidebar-fg-quaternary);',
    );
  });

  it('cuts alert spacing out of the avatar instead of painting a sidebar-colored ring', () => {
    const avatarMaskRule = SHARED_TOKENS_SOURCE.match(
      /\.sidebar-account-avatar-attention-mask \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(avatarMaskRule).toContain('-webkit-mask-image: radial-gradient(');
    expect(avatarMaskRule).toContain('transparent 0 3.75px');
    expect(avatarMaskRule).toContain('black 4px');
    expect(avatarMaskRule).not.toContain('background');
    expect(avatarMaskRule).not.toContain('border');
  });

  it('uses neutral black alpha values in light mode', () => {
    const sidebarRule = GENERATED_THEME_SOURCE.match(
      /:root \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(sidebarRule).toContain('--sidebar-fg-primary: rgb(0 0 0);');
    expect(sidebarRule).toContain('--sidebar-fg-secondary: rgb(0 0 0 / 72%);');
    expect(sidebarRule).toContain('--sidebar-fg-tertiary: rgb(0 0 0 / 56%);');
    expect(sidebarRule).toContain('--sidebar-fg-quaternary: rgb(0 0 0 / 36%);');
  });

  it('uses neutral white alpha values in dark mode', () => {
    const sidebarRule = GENERATED_THEME_SOURCE.match(
      /:root\.dark \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(sidebarRule).toContain('--sidebar-fg-primary: rgb(255 255 255);');
    expect(sidebarRule).toContain(
      '--sidebar-fg-secondary: rgb(255 255 255 / 72%);',
    );
    expect(sidebarRule).toContain(
      '--sidebar-fg-tertiary: rgb(255 255 255 / 56%);',
    );
    expect(sidebarRule).toContain(
      '--sidebar-fg-quaternary: rgb(255 255 255 / 36%);',
    );
  });
});
