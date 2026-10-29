/** @jest-environment node */
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path';

// Settings pages run inside the desktop overlay as well as on the web. A raw
// `<a>` to an internal path bypasses the host's `SettingsLink`, so on desktop
// the renderer navigates away and lands on Home. Raw anchors may only open
// external pages in a new tab; everything internal goes through
// `SettingsLink`.

const SETTINGS_ROOT = join(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry): string[] => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === '__tests__' ? [] : sourceFiles(path);
      return entry.name.endsWith('.tsx') ? [path] : [];
    },
  );
}

/** Each raw `<a …>` opening tag in a file, with its line. */
function anchors(source: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  const pattern = /<a(?=[\s>])/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    // The opening tag ends at the first `>` outside a `{…}` expression.
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) break;
    }
    found.push({
      tag: source.slice(match.index, end + 1),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

describe('settings anchors', () => {
  it('route internal links through SettingsLink', () => {
    const offenders = sourceFiles(SETTINGS_ROOT).flatMap((file): string[] =>
      anchors(readFileSync(file, 'utf8'))
        .filter(
          ({ tag }): boolean =>
            !/\btarget="_blank"/.test(tag) || /\bhref="\//.test(tag),
        )
        .map(({ line }): string => `${relative(SETTINGS_ROOT, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
