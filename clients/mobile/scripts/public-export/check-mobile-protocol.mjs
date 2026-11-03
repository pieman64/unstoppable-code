#!/usr/bin/env node
/** Public generated-binding integrity; intentionally contains no private source provenance. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const generatedDirectory = 'apps/mobile/lib/data/protocol/generated';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function generatedManifest(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const directory = join(root, generatedDirectory);
  // Reject linked ancestors as well as linked files.
  let ancestor = root;
  for (const part of generatedDirectory.split('/')) {
    ancestor = join(ancestor, part);
    if (lstatSync(ancestor).isSymbolicLink())
      throw new Error(`Symlink in generated-binding path: ${part}`);
  }
  const files = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      !entry.name.endsWith('.dart') ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    )
      throw new Error(`Invalid generated binding: ${entry.name}`);
    files[`${generatedDirectory}/${entry.name}`] = digest(
      readFileSync(join(directory, entry.name)),
    );
  }
  if (!Object.keys(files).length)
    throw new Error('No generated Dart bindings found');
  return { schemaVersion: 1, files };
}

export function checkMobileProtocol({
  sourceRoot,
  manifestPath,
  write = false,
}) {
  const actual = generatedManifest(sourceRoot);
  if (write) {
    writeFileSync(manifestPath, `${JSON.stringify(actual, null, 2)}\n`, {
      flag: 'wx',
    });
    return actual;
  }
  if (lstatSync(manifestPath).isSymbolicLink())
    throw new Error('Manifest must not be a symlink');
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    expected.schemaVersion !== 1 ||
    !expected.files ||
    typeof expected.files !== 'object' ||
    Array.isArray(expected.files) ||
    Object.keys(expected).some(
      (key) => !['schemaVersion', 'files'].includes(key),
    )
  )
    throw new Error('Invalid public generated-binding manifest');
  const expectedNames = Object.keys(expected.files).sort();
  const actualNames = Object.keys(actual.files).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames))
    throw new Error('Generated binding file set changed');
  for (const name of actualNames)
    if (
      !/^[a-f0-9]{64}$/.test(expected.files[name]) ||
      expected.files[name] !== actual.files[name]
    )
      throw new Error(`Generated binding digest mismatch: ${name}`);
  return actual;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const args = {
    source: '.',
    manifest: 'apps/mobile/protocol-generated.sha256.json',
  };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--check') continue;
    if (key === '--write') args.write = true;
    else if (['--source', '--manifest'].includes(key) && process.argv[i + 1])
      args[key.slice(2)] = process.argv[++i];
    else throw new Error(`Unknown/missing argument: ${key}`);
  }
  try {
    if (!args.source || !args.manifest)
      throw new Error('--source and --manifest are required');
    const result = checkMobileProtocol({
      sourceRoot: args.source,
      manifestPath: resolve(args.source, args.manifest),
      write: args.write,
    });
    console.log(
      `${args.write ? 'Wrote' : 'Verified'} ${Object.keys(result.files).length} generated binding digests.`,
    );
  } catch (e) {
    console.error(`MOBILE PROTOCOL BLOCKED: ${e.message}`);
    process.exitCode = 1;
  }
}
