#!/usr/bin/env node

/**
 * Builds the owned-child addon (packages/core-platform/native/owned-child)
 * against the headers of the Node running this script. Darwin compiles
 * src/owned_child.c for both architectures with /usr/bin/clang, and Linux for
 * the host architecture with /usr/bin/cc, each with the Node install's own
 * headers; nothing is downloaded. Windows builds src/owned_child_win.c with the
 * root node-gyp, as the pipe-security addon does. Elsewhere nothing is built
 * and the platform reports owned children as unavailable.
 *
 * Usage: node scripts/build-owned-child.mjs [--out <file>] [--probe-out <file>]
 * Default output: .cache/native-owned-child/<platform>-<arch>/core-owned-child.node
 * `--probe-out` also builds the Windows suite's test-only job probe.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNED_CHILD_DIRECTORY = join(
  root,
  'packages',
  'core-platform',
  'native',
  'owned-child',
);
const OWNED_CHILD_SOURCE = join(OWNED_CHILD_DIRECTORY, 'src', 'owned_child.c');
export const OWNED_CHILD_FILE = 'core-owned-child.node';
export const OWNED_CHILD_DEFAULT_OUTPUT = join(
  root,
  '.cache',
  'native-owned-child',
  `${process.platform}-${process.arch}`,
  OWNED_CHILD_FILE,
);
const CLANG = '/usr/bin/clang';
const CC = '/usr/bin/cc';
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
 * Builds the addon and returns its path, or `null` off Darwin, Linux and
 * Windows. The result is renamed into place, so concurrent builds to the same
 * output never observe a partial addon.
 */
export function buildOwnedChild({ out } = {}) {
  const target = out ?? OWNED_CHILD_DEFAULT_OUTPUT;
  if (process.platform === 'win32')
    return buildWindowsAddon({
      directory: OWNED_CHILD_DIRECTORY,
      files: [
        'binding.gyp',
        join('src', 'owned_child_win.c'),
        join('src', 'confined_read_win.c'),
        join('src', 'confined_read_win.h'),
        join('src', 'recycle_item_win.c'),
        join('src', 'recycle_item_win.h'),
        join('src', 'migration_image_win.c'),
        join('src', 'migration_image_win.h'),
        join('src', 'migration_fs_win.c'),
        join('src', 'migration_fs_win.h'),
      ],
      product: 'core_owned_child.node',
      out: target,
    });
  if (process.platform === 'linux')
    return buildLinuxAddon({ source: OWNED_CHILD_SOURCE, out: target });
  return buildDarwinAddon({
    source: OWNED_CHILD_SOURCE,
    out: target,
    // Audit-token accessors for the launcher channel's peer evidence.
    libraries: ['-lbsm'],
  });
}

/** The Windows suite's test-only job probe, or `null` off Windows. */
export function buildOwnedChildProbe({ out }) {
  return buildWindowsAddon({
    directory: join(OWNED_CHILD_DIRECTORY, 'probe'),
    files: ['binding.gyp', 'owned_child_probe.c'],
    product: 'owned_child_probe.node',
    out,
  });
}

/** Builds one universal Darwin Node-API addon from one C source. */
export function buildDarwinAddon({ source, out, libraries }) {
  if (process.platform !== 'darwin') return null;
  if (!ARCH[process.arch])
    throw new Error(`Unsupported architecture ${process.arch}`);
  return compileInto(out, (temporary) =>
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
        ...libraries,
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
    ),
  );
}

/**
 * Builds one Linux Node-API addon for the host architecture from one C
 * source. Node-API symbols resolve against the loading process.
 */
function buildLinuxAddon({ source, out }) {
  if (process.platform !== 'linux') return null;
  return compileInto(out, (temporary) =>
    execFileSync(
      CC,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-fPIC',
        '-shared',
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
        },
      },
    ),
  );
}

/** Runs `compile` into a private temporary file, then renames it to `out`. */
function compileInto(out, compile) {
  const target = resolve(root, out);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    compile(temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

/**
 * Builds one node-gyp target from a private copy of its sources, so parallel
 * builds never share a build directory and no build output lands in the
 * checkout. Windows keeps a loaded `.node` mapped: replacing an output that a
 * running process loaded fails with a clear error instead of a partial file.
 */
function buildWindowsAddon({ directory, files, product, out }) {
  if (process.platform !== 'win32') return null;
  const target = resolve(root, out);
  mkdirSync(dirname(target), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'owned-child-gyp-'));
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    for (const file of files) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      copyFileSync(join(directory, file), join(work, file));
    }
    const nodeGyp = fileURLToPath(
      import.meta.resolve('node-gyp/bin/node-gyp.js'),
    );
    execFileSync(
      process.execPath,
      [
        nodeGyp,
        'rebuild',
        `--directory=${work}`,
        `--target=${process.versions.node}`,
        `--arch=${process.arch}`,
      ],
      { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const built = join(work, 'build', 'Release', product);
    if (!existsSync(built))
      throw new Error(`node-gyp produced no addon at ${built}`);
    copyFileSync(built, temporary);
    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : '';
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
        throw new Error(
          `Cannot replace ${target}: a running process has it loaded. Stop that process or build to another --out file.`,
        );
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
    rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
  return target;
}

function parseOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a file path.`);
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2);
    const built = buildOwnedChild({ out: parseOption(argv, '--out') });
    console.log(
      built
        ? `Done! Addon: ${built}`
        : `Owned child addon is Darwin, Linux and Windows only; nothing built on ${process.platform}.`,
    );
    const probeOut = parseOption(argv, '--probe-out');
    if (probeOut) {
      const probe = buildOwnedChildProbe({ out: probeOut });
      console.log(
        probe
          ? `Done! Probe: ${probe}`
          : `Owned child probe is Windows only; nothing built on ${process.platform}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
