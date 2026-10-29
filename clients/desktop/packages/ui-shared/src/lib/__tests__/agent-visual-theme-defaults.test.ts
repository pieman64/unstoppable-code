/* eslint-disable no-restricted-imports -- The generated-token drift check intentionally launches the Node generator. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { AGENT_VISUAL_THEME_VARIABLES } from '../agent-visual-html';
import { AGENT_VISUAL_THEME_DEFAULTS } from '../agent-visual-theme-defaults';

// The built-in themes (`THEME_NAMES` in @canopy/desktop-shared). Listed here
// because this browser-safe package cannot import desktop code; the main-side
// theme test checks the table against `THEME_NAMES` itself.
const THEME_NAMES = [
  'default',
  'unstoppable',
  'dusk',
  'lime',
  'ocean',
  'retro',
  'neo',
  'forest',
] as const;

it('has every resolved visual token for every built-in theme and appearance', () => {
  for (const brand of Object.values(AGENT_VISUAL_THEME_DEFAULTS)) {
    for (const name of THEME_NAMES) {
      for (const appearance of ['light', 'dark'] as const) {
        const values = brand[name][appearance];
        expect(Object.keys(values).sort()).toEqual(
          [...AGENT_VISUAL_THEME_VARIABLES].sort(),
        );
        for (const value of Object.values(values))
          expect(value).not.toContain('var(');
      }
    }
  }
});

it('resolves different brand default recipes without changing named themes', () => {
  // The brands' default recipes differ in their accent.
  expect(
    AGENT_VISUAL_THEME_DEFAULTS.canopy.default.light['--bg-accent'],
  ).not.toBe(
    AGENT_VISUAL_THEME_DEFAULTS['unstoppable-code'].default.light[
      '--bg-accent'
    ],
  );
  expect(AGENT_VISUAL_THEME_DEFAULTS.canopy.ocean.dark).toEqual(
    AGENT_VISUAL_THEME_DEFAULTS['unstoppable-code'].ocean.dark,
  );
});

it('gives visuals six distinct chart colors that keep their hue across themes', () => {
  const chart = (values: Readonly<Record<string, string>>): string[] =>
    [1, 2, 3, 4, 5, 6].map(
      (slot) => values[`--chart-categorical-${slot}`] ?? '',
    );
  for (const appearance of ['light', 'dark'] as const) {
    const reference = chart(
      AGENT_VISUAL_THEME_DEFAULTS.canopy.default[appearance],
    );
    expect(new Set(reference).size).toBe(6);
    for (const brand of Object.values(AGENT_VISUAL_THEME_DEFAULTS)) {
      for (const name of THEME_NAMES) {
        expect(chart(brand[name][appearance])).toEqual(reference);
      }
    }
  }
  // The swatch colors, by contrast, change with the theme.
  const swatch = (name: (typeof THEME_NAMES)[number]): string | undefined =>
    AGENT_VISUAL_THEME_DEFAULTS.canopy[name].light['--categorical-1'];
  expect(swatch('retro')).not.toBe(swatch('default'));
});

it('matches the generator', () => {
  const root = resolve(__dirname, '../../../../..');
  expect(() =>
    execFileSync(
      process.execPath,
      [resolve(root, 'scripts/brand/generate-theme-tokens.mjs'), '--check'],
      { cwd: root },
    ),
  ).not.toThrow();
});
