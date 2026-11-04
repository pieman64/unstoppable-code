/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

function source(file: string): string {
  return readFileSync(join(__dirname, '..', file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

const CORE = source('canopy-tokens-core.css');

function skeletonTheme(): string {
  const match =
    /\[skullet-bar\], \[skullet-loading\], \[skullet-rect\] \{([^}]*)\}/.exec(
      CORE,
    );
  if (!match?.[1]) {
    throw new Error('missing the skullet theme block');
  }
  return match[1];
}

describe('skeleton styles', () => {
  // skullet's built-in colors are raw alpha mixes and its default motion is a
  // sweep mixed from a highlight color; Canopy skeletons take a token fill and
  // a plain pulse instead.
  it('themes skullet with the muted token and a slow pulse', () => {
    const theme = skeletonTheme();
    expect(theme).toContain('--skullet-base: var(--bg-muted);');
    expect(theme).toContain('--skullet-highlight: var(--bg-subtle);');
    expect(theme).toContain('--skullet-animation: pulse;');
    expect(theme).toContain('--skullet-speed: slow;');
    expect(theme).toContain('--skullet-radius: 9999px;');
    expect(theme).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|color-mix/i);
  });

  it('draws a kept element in its own ink', () => {
    expect(CORE).toContain(
      '[skullet-loading] [skullet-own] { -webkit-text-fill-color: currentcolor; }',
    );
  });

  it('draws a measured icon with the small radius, not square', () => {
    expect(CORE).toContain(
      '[skullet-loading] svg { border-radius: var(--radius-sm); }',
    );
  });

  it.each(['canopy-tokens.css', 'canopy-tokens.web.css'])(
    '%s loads skullet’s stylesheet, so no skeleton injects one at runtime',
    (file) => {
      expect(source(file)).toContain("@import 'skullet/styles.css';");
    },
  );
});
