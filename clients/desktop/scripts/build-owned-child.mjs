#!/usr/bin/env node

/**
 * Builds the owned-child addon (packages/core-platform/native/owned-child)
 * for both Darwin architectures with /usr/bin/clang against the headers of the Node running
 * this script. Nothing is downloaded. Darwin only: elsewhere nothing is built
 * and the platform reports owned children as unavailable.
 *
 * Usage: node scripts/build-owned-child.mjs [--out <file>]
 * Default output: .cache/native-owned-child/<platform>-<arch>/core-owned-child.node
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(
  root,
  'packages',
  'core-platform',
  'native',
  'owned-child',
  'src',
  'owned_child.c',
);
export const OWNED_CHILD_FILE = 'core-owned-child.node';
export const OWNED_CHILD_DEFAULT_OUTPUT = join(
  root,
  '.cache',
  'native-owned-child',
  `${process.platform}-${process.arch}`,
  OWNED_CHILD_FILE,
);
const CLANG = '/usr/bin/clang';
const ARCH = { arm64: 'arm64', x64: 'x86_64' };
// Matches the minimum macOS of the Node 24 release binaries.
const MACOS_MINIMUM = '13.5';

/** The running Node's own headers; a version mismatch fails rather than downloads. */
function nodeHeaders() {
  const include = resolve(dirname(process.execPath), '..', 'include', 'node');
  const header = join(include, 'node_version.h');
  if (!existsSync(header))
    throw new Error(`Node headers are missing beside ${process.execPath}`);
  const text = readFileSync(header, 'utf8');
  const part = (name) =>
    text.match(new RegExp(`#define NODE_${name}_VERSION (\\d+)`))?.[1];
  const version = ['MAJOR', 'MINOR', 'PATCH'].map(part).join('.');
  if (version !== process.versions.node)
    throw new Error(
      `Node headers are ${version}, expected ${process.versions.node}`,
    );
  return include;
}

/**
 * Builds the addon and returns its path, or `null` off Darwin. Compiles to a
 * unique temporary file and renames it into place, so concurrent builds to
 * the same output never observe a partial addon.
 */
export function buildOwnedChild({ out } = {}) {
  if (process.platform !== 'darwin') return null;
  if (!ARCH[process.arch])
    throw new Error(`Unsupported architecture ${process.arch}`);
  const target = resolve(root, out ?? OWNED_CHILD_DEFAULT_OUTPUT);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    execFileSync(
      CLANG,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-fPIC',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-arch',
        'arm64',
        '-arch',
        'x86_64',
        `-mmacosx-version-min=${MACOS_MINIMUM}`,
        '-DNAPI_VERSION=8',
        '-I',
        nodeHeaders(),
        '-o',
        temporary,
        source,
      ],
      {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          ...(process.env.DEVELOPER_DIR
            ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR }
            : {}),
        },
      },
    );
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

function parseOut(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error('--out requires a file path.');
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const built = buildOwnedChild({ out: parseOut(process.argv.slice(2)) });
    console.log(
      built
        ? `Done! Addon: ${built}`
        : `Owned child addon is Darwin-only; nothing built on ${process.platform}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
