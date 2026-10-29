// Test-only source inspection; production ui-rich remains browser-only.

import { readFileSync } from 'node:fs';

import path from 'node:path';

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), 'utf8');
}

const CANVAS_SOURCES = [
  'packages/ui-rich/src/diagram/DiagramCanvas.tsx',
  'packages/ui-rich/src/diagram/DiagramCanvas.module.css',
];

const THEME_SOURCES = [
  'packages/ui-shared/src/styles/canopy-tokens-core.css',
  'packages/ui-shared/src/styles/generated-theme-tokens.css',
];

describe('diagram canvas theme variables', () => {
  it('only references variables the shared theme defines', () => {
    const defined = new Set(
      THEME_SOURCES.flatMap((file) =>
        Array.from(read(file).matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]),
      ),
    );
    const used = new Set(
      CANVAS_SOURCES.flatMap((file) =>
        Array.from(
          read(file).matchAll(/var\((--[\w-]+)/g),
          (match) => match[1],
        ),
      ),
    );

    expect(used.size).toBeGreaterThan(0);
    expect(Array.from(used).filter((name) => !defined.has(name))).toEqual([]);
  });
});
