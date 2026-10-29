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

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(
    TOKENS_SOURCE.matchAll(
      new RegExp(`^${escaped} \\{([\\s\\S]*?)\\n\\}`, 'gm'),
    ),
    (match) => match[1],
  ).join('\n');
}

describe('Tooltip inverse tone styles', () => {
  it('registers the inverse tooltip surface and ink as utilities', () => {
    expect(TOKENS_SOURCE).toMatch(
      /@theme inline \{[\s\S]*--color-tooltip-inverse: var\(--bg-tooltip-inverse\);/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /@theme inline \{[\s\S]*--color-fg-tooltip-inverse: var\(--fg-tooltip-inverse\);/,
    );
  });

  it('keeps the reversed black tooltip in light mode', () => {
    const light = ruleBody(':root');
    expect(light).toContain('--bg-tooltip-inverse: var(--bg-inverse);');
    expect(light).toContain('--fg-tooltip-inverse: var(--bg-base);');
  });

  it('uses the regular dark tooltip surface in dark mode', () => {
    const dark = ruleBody(':root.dark');
    expect(dark).toContain('--bg-tooltip-inverse: var(--bg-quaternary);');
    expect(dark).toContain('--fg-tooltip-inverse: var(--fg-primary);');
  });
});
