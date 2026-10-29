// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import { marketplaceKindToneClass } from '../../lib/marketplace-type-tabs';

const tokensCss = readFileSync(
  path.resolve(__dirname, '../canopy-tokens-core.css'),
  'utf8',
);

const KINDS: readonly UnifiedEntryKind[] = [
  'plugin',
  'app',
  'skill',
  'pipeline',
  'automation',
  'collection',
  'blueprint',
  'agent',
];

describe('Customize type label tones (CAN-4261)', () => {
  it.each(KINDS)(
    'defines the %s tone once in the shared token core',
    (kind) => {
      const role = marketplaceKindToneClass(kind).replace(/^fg-/, '');
      // The `fg-*` utility reads `--color-fg-*`, which maps the role.
      expect(tokensCss).toContain(`--color-fg-${role}: var(--fg-${role});`);
      expect(tokensCss).toMatch(new RegExp(`--fg-${role}:\\s`));
    },
  );

  it('builds the tones from the fixed chart hues, not theme swatches', () => {
    const definitions = tokensCss.match(/--fg-kind-[a-z]+:[^;]+;/g) ?? [];
    expect(definitions.length).toBeGreaterThanOrEqual(7);
    for (const definition of definitions) {
      expect(definition).not.toMatch(/var\(--categorical-/);
      expect(definition).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
  });

  it('keeps MCP servers off the cyan that reads as Skill blue in dark', () => {
    const hue = (role: string): string | undefined =>
      new RegExp(
        `--fg-kind-${role}:[^;]*var\\(--chart-categorical-(\\d)\\)`,
      ).exec(tokensCss)?.[1];
    expect(hue('skill')).toBe('1');
    expect(hue('mcp')).toBe('5');
    // Cyan (4) sits beside blue (1); no kind takes it.
    const hues = ['skill', 'workflow', 'plugin', 'mcp', 'collection', 'agent']
      .map(hue)
      .filter((value): value is string => value !== undefined);
    expect(hues).not.toContain('4');
    expect(new Set(hues).size).toBe(hues.length);
  });
});
