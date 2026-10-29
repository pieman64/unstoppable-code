// Keeps the relocation list exact: the scripts/probes entry wrapper imports
// only Node built-ins, and only the listed files in this tree import Electron
// or apps/desktop-app modules. Those files are why the tree must move under
// apps/desktop-app (check:electron-boundary); nothing else may add to them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function specifiers(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'|import\(\s*'([^']+)'\s*\)|require(?:\.resolve)?\(\s*'([^']+)'\s*\)/g,
  )) {
    found.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  // Computed imports would hide a dependency from the boundary check.
  assert.doesNotMatch(
    source,
    /import\(\s*[^'\s)]/,
    `${path.relative(here, file)} uses a computed import`,
  );
  return found;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith('.mjs') ? [full] : [];
  });
}

const crossesBoundary = (specifier) =>
  specifier === 'electron' ||
  specifier.startsWith('electron/') ||
  specifier.includes('apps/desktop-app/') ||
  specifier.startsWith('../../../mock-server/');

test('the entry wrapper imports only Node built-ins', () => {
  const wrapper = path.resolve(
    here,
    '../../../../../../scripts/probes/browser-agent-phase0/browser-probe.mjs',
  );
  for (const specifier of specifiers(wrapper)) {
    assert.match(specifier, /^node:/, specifier);
  }
});

test('only the listed files cross the Electron boundary', () => {
  const crossing = walk(here)
    .filter((file) => specifiers(file).some(crossesBoundary))
    .map((file) => path.relative(here, file).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(crossing, [
    'app/binding.mjs',
    'app/lab.mjs',
    'app/main.mjs',
    'run.mjs',
  ]);
});

test('pure modules stay free of Electron and app imports', () => {
  for (const dir of ['net', 'fixtures']) {
    for (const file of walk(path.join(here, dir))) {
      for (const specifier of specifiers(file)) {
        assert.ok(
          specifier.startsWith('node:') || specifier.startsWith('./'),
          `${path.relative(here, file)} imports ${specifier}`,
        );
      }
    }
  }
});
