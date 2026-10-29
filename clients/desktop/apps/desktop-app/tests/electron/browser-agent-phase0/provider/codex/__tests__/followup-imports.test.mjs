// Import-contract check for followup.mjs, an entry script that would start a
// native runtime if executed with a manifest. It is never imported here: every
// named import is parsed from its source and checked against the real module,
// and a manifest-less execution must stop at the context guard before any
// provider work (no native process is started).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'followup.mjs');

test('every named import in followup.mjs exists in its module', async () => {
  const source = await readFile(entry, 'utf8');
  const imports = [];
  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g,
  ))
    imports.push({
      specifier: match[2],
      names: match[1]
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    });
  assert.ok(imports.length >= 20, `parsed ${imports.length} imports`);
  for (const { specifier, names } of imports) {
    if (!specifier.startsWith('.') && !specifier.startsWith('node:')) continue;
    const target = specifier.startsWith('.')
      ? pathToFileURL(path.resolve(path.dirname(entry), specifier)).href
      : specifier;
    const mod = await import(target);
    for (const name of names)
      assert.ok(name in mod, `${specifier} does not export ${name}`);
  }
});

test('without the orchestrator manifest the entry refuses before any provider work', () => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run through provider-probe\.mjs/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|SyntaxError/);
});
