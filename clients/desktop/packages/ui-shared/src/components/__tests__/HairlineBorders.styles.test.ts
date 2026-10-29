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

describe('hairline border token', () => {
  it('uses one physical-pixel-safe width at standard and Retina densities', () => {
    expect(TOKENS_SOURCE).toMatch(
      /:root \{[\s\S]*?--border-hairline: 1px;[\s\S]*?\}/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /@media only screen and \(-webkit-min-device-pixel-ratio: 2\),\s*only screen and \(min-resolution: 192dpi\) \{\s*:root \{\s*--border-hairline: 0\.5px;\s*\}\s*\}/,
    );
    expect(TOKENS_SOURCE).toContain(
      '--default-border-width: var(--border-hairline);',
    );
    expect(TOKENS_SOURCE).not.toContain('--default-border-width: 0.5px;');
  });
});
