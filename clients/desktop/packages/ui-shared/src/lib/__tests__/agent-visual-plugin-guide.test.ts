// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync, readdirSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import {
  AGENT_VISUAL_CDN_HOSTS,
  AGENT_VISUAL_THEME_VARIABLES,
} from '../agent-visual-html';

// The builtin-visualize plugin tells agents what a visual may load and which
// theme variables exist. Those facts are owned by this package, so the guide
// is checked against them here: changing the CDN allowlist or the injected
// variables must update the plugin in the same change.
const pluginRoot = path.resolve(
  __dirname,
  '../../../../../brand-templates/plugins/builtin-visualize',
);
const read = (file: string): string =>
  readFileSync(path.join(pluginRoot, file), 'utf8');

const recipeNames = readdirSync(path.join(pluginRoot, 'assets/recipes')).sort();
const recipes = recipeNames.map((name) => ({
  name,
  html: read(`assets/recipes/${name}`),
}));
const starter = read('assets/starter.html');
const references = readdirSync(path.join(pluginRoot, 'references')).map(
  (name) => ({ name, text: read(`references/${name}`) }),
);
const skill = read('skills/visualize/SKILL.md');
const everything = [
  { name: 'SKILL.md', text: skill },
  { name: 'starter.html', text: starter },
  ...references,
  ...recipes.map((recipe) => ({ name: recipe.name, text: recipe.html })),
];

/** Custom properties an example defines for its own layout. */
const LOCAL_PROPERTIES = new Set(['--weeks', '--row']);

/** Every match of a global pattern, as [whole, ...groups]. */
function matches(text: string, pattern: RegExp): string[][] {
  const found: string[][] = [];
  const regex = new RegExp(pattern.source, 'g');
  let match = regex.exec(text);
  while (match !== null) {
    found.push(match.map((part) => part ?? ''));
    match = regex.exec(text);
  }
  return found;
}

function themeKit(html: string): string | null {
  const start = html.indexOf('// theme-kit:start');
  const end = html.indexOf('// theme-kit:end');
  if (start < 0 || end < 0) return null;
  return html
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

function libraryTags(text: string): Array<{ url: string; tag: string }> {
  return matches(
    text,
    /<(?:script|link)\b[^>]*?(?:src|href)="(https:[^"]+)"[^>]*>/,
  ).map(([tag = '', url = '']) => ({ url, tag }));
}

it('names exactly the CDN hosts the frame allows', () => {
  const origins = new Set<string>();
  for (const { text } of everything) {
    for (const [origin = ''] of matches(text, /https:\/\/[a-z0-9.-]+/)) {
      origins.add(origin);
    }
  }
  expect(Array.from(origins).sort()).toEqual(
    [...AGENT_VISUAL_CDN_HOSTS].sort(),
  );
  for (const host of AGENT_VISUAL_CDN_HOSTS) {
    expect(skill).toContain(new URL(host).host);
  }
});

it('uses only theme variables the host injects, and documents every one', () => {
  const injected: ReadonlySet<string> = new Set(AGENT_VISUAL_THEME_VARIABLES);
  for (const { name, text } of everything) {
    const used = [
      ...matches(text, /var\((--[a-z0-9-]+)/),
      ...matches(text, /['`](--[a-z0-9-]+)['`]/),
    ].map(([, variable = '']) => variable);
    for (const variable of used) {
      // `--categorical-${n}` in the theme kit, and names cut by a template.
      if (variable.endsWith('-') || LOCAL_PROPERTIES.has(variable)) continue;
      expect({
        file: name,
        variable,
        injected: injected.has(variable),
      }).toEqual({ file: name, variable, injected: true });
    }
  }
  const theme = read('references/theme.md');
  for (const variable of AGENT_VISUAL_THEME_VARIABLES) {
    // The swatch colors are documented as a range.
    if (/^--categorical-[2-5]$/.test(variable)) continue;
    expect(theme).toContain(`\`${variable}\``);
  }
});

it('pins every library tag to a version with an integrity hash', () => {
  const hashes = new Map<string, string>();
  const sources = [
    ...recipes.map((recipe) => recipe.html),
    read('references/libraries.md'),
  ];
  let count = 0;
  for (const source of sources) {
    for (const { url, tag } of libraryTags(source)) {
      count += 1;
      expect(url).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+\/.+\.(?:js|css)$/,
      );
      const integrity = /integrity="(sha384-[A-Za-z0-9+/]{64})"/.exec(tag)?.[1];
      expect({ url, integrity: integrity !== undefined }).toEqual({
        url,
        integrity: true,
      });
      expect(tag).toContain('crossorigin="anonymous"');
      // One file, one hash, wherever the guide repeats it.
      expect(hashes.get(url) ?? integrity).toBe(integrity);
      if (integrity) hashes.set(url, integrity);
    }
  }
  expect(count).toBeGreaterThan(20);
});

it('loads no library by module import, which cannot carry an integrity hash', () => {
  for (const { name, text } of everything) {
    expect({
      file: name,
      imports: matches(
        text,
        /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`]https:/,
      ).length,
    }).toEqual({ file: name, imports: 0 });
  }
});

it('keeps the theme kit in each example identical to the starter', () => {
  const kit = themeKit(starter);
  expect(kit).not.toBeNull();
  const carriers = recipes.filter((recipe) => recipe.html.includes('viz.'));
  expect(carriers.length).toBeGreaterThan(0);
  for (const recipe of carriers) {
    expect({ name: recipe.name, same: themeKit(recipe.html) === kit }).toEqual({
      name: recipe.name,
      same: true,
    });
  }
});

it('lists every example in the skill and the recipe index', () => {
  const index = read('references/recipes.md');
  for (const name of recipeNames) {
    expect(skill).toContain(`\`${name}\``);
    expect(index).toContain(`\`${name}\``);
  }
  const mentioned = new Set(
    [skill, ...references.map((reference) => reference.text)].flatMap((text) =>
      matches(text, /`([a-z0-9-]+\.html)`/).map(([, file = '']) => file),
    ),
  );
  mentioned.delete('starter.html');
  expect(Array.from(mentioned).sort()).toEqual(recipeNames);
});

it.each(recipes)('$name follows the rules the guide gives', ({ html }) => {
  // Complete document, with nothing the frame blocks or the theme forbids.
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket\(/);
  expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  expect(html).not.toMatch(/prefers-color-scheme/);
  expect(html).not.toMatch(/\d(?:vh|vw)\b/);
  // No color literals outside the theme kit, which builds them from the theme.
  const kitStart = html.indexOf('// theme-kit:start');
  const kitEnd = html.indexOf('// theme-kit:end');
  const own =
    kitStart < 0 ? html : html.slice(0, kitStart) + html.slice(kitEnd);
  const styled = own.replace(/integrity="[^"]+"/g, '');
  expect(styled).not.toMatch(
    /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/,
  );
  expect(styled).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/);
  // Charts that animate by default must not: previews capture the first frame.
  if (/chart\.umd|echarts\.min/.test(html)) {
    expect(html).toContain('animation: false');
  }
});
