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

/** Selectors of every rule that turns the outline off. */
function outlineNoneSelectors(css: string): string[] {
  const selectors: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/outline:\s*none/.test(match[2] ?? '')) {
      selectors.push((match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
    }
  }
  return selectors;
}

describe('invalid focus outline', () => {
  const invalidRules = outlineNoneSelectors(TOKENS_SOURCE).filter((selector) =>
    selector.includes("[aria-invalid='true']"),
  );

  it('drops the accent outline only on dropdowns that draw the destructive halo', () => {
    expect(invalidRules).toEqual([
      ":is(select, [role='combobox']).focus-ring[aria-invalid='true']:focus-visible",
    ]);
  });

  it('keeps the outline on any other invalid element with focus-ring', () => {
    // A hand-written input that only has `focus-ring` must still show focus
    // while it is invalid.
    expect(invalidRules).not.toContain(
      ".focus-ring[aria-invalid='true']:focus-visible",
    );
  });
});
