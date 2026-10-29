/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const GLOBALS_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'styles', 'globals.css'),
  'utf8',
);
const SHARED_SOURCE = readFileSync(
  join(process.cwd(), 'packages/ui-shared/src/styles/canopy-tokens-core.css'),
  'utf8',
);

describe('Settings navigation scroll occlusion', () => {
  it('masks scrolling rows without painting over the sidebar material', () => {
    const maskRule = SHARED_SOURCE.match(
      /\.settings-nav-scroll-mask \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(maskRule).toContain(
      'linear-gradient(to bottom, transparent 0, black 0.75rem)',
    );
    expect(maskRule).not.toContain('background');
    expect(GLOBALS_SOURCE).not.toContain('.settings-nav-scroll-fade');
  });

  it('fades page content across the whole window drag strip', () => {
    // The 40px (h-10) drag strip floats over the page and swallows pointer
    // input, so content must not read as solid until it has cleared it.
    const maskRule = GLOBALS_SOURCE.match(
      /\.settings-content-scroll-mask \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(maskRule).toContain(
      'linear-gradient(to bottom, transparent 0, black 2.5rem)',
    );
  });
});
