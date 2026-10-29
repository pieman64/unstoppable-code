/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

// Settings draws every glyph from the shared app icon set. Two marks are
// exceptions, each kept outside this folder: the product's own (`BrandLogo`),
// since the icon manifest has no Canopy logo, and Grok's (`GrokLogo`), since
// the manifest has no Grok glyph.
const SETTINGS_DIR = join(__dirname, '..');
const SOURCES = readdirSync(SETTINGS_DIR)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({
    name,
    source: readFileSync(join(SETTINGS_DIR, name), 'utf8'),
  }));

function matches(source: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const global = new RegExp(pattern.source, 'g');
  for (let match = global.exec(source); match; match = global.exec(source)) {
    found.push(match[1] ?? match[0]);
  }
  return found;
}

describe('Settings icons', () => {
  it('imports icons only from the app icon set', () => {
    const offenders = SOURCES.flatMap(({ name, source }) =>
      matches(
        source,
        /import\s+\{[^}]*\}\s+from\s+'(@canopy\/ui-shared\/icons|@\/components\/(?:Claude|Codex|Ollama|Cursor|Linear)Logo)'/,
      ).map((path) => `${name}: ${path}`),
    );
    expect(offenders).toEqual([]);
  });

  it('draws no hand-rolled SVG glyphs', () => {
    const offenders = SOURCES.filter(({ source }) =>
      source.includes('<svg'),
    ).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('asks the provider icon helper for its compact glyph', () => {
    const offenders = SOURCES.flatMap(({ name, source }) =>
      matches(source, /<AgentProviderIcon\b[^>]*>/)
        .filter((tag) => !/\bcentral\b/.test(tag))
        .map(() => name),
    );
    expect(offenders).toEqual([]);
  });
});
