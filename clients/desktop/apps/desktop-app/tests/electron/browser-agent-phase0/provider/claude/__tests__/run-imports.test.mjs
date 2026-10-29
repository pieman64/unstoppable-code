// Import-contract check for run.mjs. run.mjs is an entry script that starts
// provider work when executed, so it is never imported here. Instead every
// import statement is parsed from its source and each named import is checked
// against the target module's real exports (no provider process is started).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runFile = path.join(here, '..', 'run.mjs');

function parseImports(source) {
  const imports = [];
  const pattern = /import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g;
  for (const match of source.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    imports.push({ specifier: match[2], names });
  }
  return imports;
}

test('every named import in run.mjs exists in its module', async () => {
  const source = await readFile(runFile, 'utf8');
  const imports = parseImports(source);
  assert.ok(imports.length >= 18, `parsed ${imports.length} imports`);
  for (const { specifier, names } of imports) {
    const target = specifier.startsWith('.')
      ? pathToFileURL(path.resolve(path.dirname(runFile), specifier)).href
      : specifier;
    const mod = await import(target);
    for (const name of names)
      assert.ok(name in mod, `${specifier} does not export ${name}`);
  }
});

test('run.mjs only imports from ../shared, sibling helpers, node built-ins, the SDK and relocation-safe seams', async () => {
  const source = await readFile(runFile, 'utf8');
  const specifiers = [...source.matchAll(/from\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  for (const specifier of specifiers) {
    const ok =
      specifier.startsWith('node:') ||
      specifier.startsWith('./') ||
      specifier.startsWith('../shared/') ||
      specifier === '@anthropic-ai/claude-agent-sdk';
    assert.ok(ok, `unexpected import ${specifier}`);
  }
  assert.ok(!/apps\/desktop-app|from\s*'electron'/.test(source));
  assert.ok(!/import\(\s*[^'`"]/.test(source), 'no computed dynamic imports');
});

test('no provider file imports apps/desktop-app modules or uses computed imports', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(path.join(here, '..'))).filter((name) =>
    name.endsWith('.mjs'),
  );
  assert.ok(files.includes('run.mjs') && files.length >= 12);
  for (const file of files) {
    const source = await readFile(path.join(here, '..', file), 'utf8');
    assert.ok(
      !/['"`][^'"`]*apps\/desktop-app[^'"`]*['"`]/.test(
        source.replace(/\/\/.*$/gm, ''),
      ),
      `${file} references apps/desktop-app`,
    );
    assert.ok(!/from\s*'electron'/.test(source), `${file} imports electron`);
    assert.ok(
      !/import\(\s*[^'`"\s)]/.test(source),
      `${file} has a computed dynamic import`,
    );
  }
});

test('the hard-coded repo depth appears nowhere: repo paths come from shared/constants', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(path.join(here, '..'))).filter((name) =>
    name.endsWith('.mjs'),
  )) {
    const source = await readFile(path.join(here, '..', file), 'utf8');
    assert.ok(
      !/\.\.\/\.\.\/\.\.\/\.\.\/\.\./.test(source),
      `${file} hard-codes the repository depth`,
    );
  }
});
