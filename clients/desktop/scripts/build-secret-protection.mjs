#!/usr/bin/env node

/**
 * Builds the secret-protection addon (packages/core-platform/native/secret-protection)
 * the same way as the owned-child addon. The daemon builder stages it as an
 * inert companion; production does not bind it yet. Darwin, Windows and Linux.
 *
 * Usage: node scripts/build-secret-protection.mjs [--out <file>]
 * Default output: .cache/native-secret-protection/<platform>-<arch>/core-secret-protection.node
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
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
import {
  secretProtectionUnavailableReason,
  SecretProtectionToolchainUnavailable,
} from './lib/secret-protection-toolchain.mjs';
import { buildDarwinAddon } from './build-owned-child.mjs';
import { DAEMON_SECRET_PROTECTION_FILE } from '../packages/core-platform/src/execution-host/daemon-payload.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_PROTECTION_SOURCE = join(
  root,
  'packages',
  'core-platform',
  'native',
  'secret-protection',
  'src',
  'keychain_slots_darwin.c',
);
export const SECRET_PROTECTION_FILE = DAEMON_SECRET_PROTECTION_FILE;
export const SECRET_PROTECTION_DEFAULT_OUTPUT = join(
  root,
  '.cache',
  'native-secret-protection',
  `${process.platform}-${process.arch}`,
  SECRET_PROTECTION_FILE,
);

/** Missing prerequisites have a distinct error; compilation failures propagate. */
export function buildSecretProtection({
  out,
  testOut,
  fixtureOut,
  faultOut,
} = {}) {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return null;
  const unavailable = secretProtectionUnavailableReason();
  if (unavailable) throw new SecretProtectionToolchainUnavailable(unavailable);
  if (process.platform === 'win32')
    return buildWindowsSecretProtection({ out, testOut, fixtureOut, faultOut });
  if (process.platform === 'linux') return buildLinuxSecretProtection({ out });
  const built = buildDarwinAddon({
    source: SECRET_PROTECTION_SOURCE,
    out: out ?? SECRET_PROTECTION_DEFAULT_OUTPUT,
    libraries: ['-framework', 'Security', '-framework', 'CoreFoundation'],
  });
  if (built) chmodSync(built, 0o644);
  return built;
}

function buildWindowsSecretProtection({
  out,
  testOut,
  fixtureOut,
  faultOut,
} = {}) {
  if (process.platform !== 'win32') return null;
  const target = resolve(out ?? SECRET_PROTECTION_DEFAULT_OUTPUT);
  const source = join(root, 'packages/core-platform/native/secret-protection');
  const work = mkdtempSync(join(tmpdir(), 'secret-protection-gyp-'));
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    for (const file of [
      'binding.gyp',
      'src/credential_context_win32.h',
      'src/credential_context_win32.c',
      'src/credential_slots_win32.c',
      'src/credential_errors_win32.c',
      'src/credential_acl_fixture_win32.c',
      'src/credential_fault_fixture_win32.c',
    ]) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      copyFileSync(join(source, file), join(work, file));
    }
    execFileSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('node-gyp/bin/node-gyp.js')),
        'rebuild',
        `--directory=${work}`,
        `--target=${process.versions.node}`,
        `--arch=${process.arch}`,
      ],
      { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    copyFileSync(
      join(work, 'build/Release/core_secret_protection.node'),
      temporary,
    );
    renameSync(temporary, target);
    chmodSync(target, 0o644);
    if (fixtureOut) {
      mkdirSync(dirname(resolve(fixtureOut)), { recursive: true });
      copyFileSync(
        join(work, 'build/Release/credential_acl_fixture.node'),
        resolve(fixtureOut),
      );
    }
    if (faultOut) {
      mkdirSync(dirname(resolve(faultOut)), { recursive: true });
      copyFileSync(
        join(work, 'build/Release/credential_fault_fixture.node'),
        resolve(faultOut),
      );
    }
    if (testOut) {
      mkdirSync(dirname(resolve(testOut)), { recursive: true });
      copyFileSync(
        join(work, 'build/Release/credential_error_contract.exe'),
        resolve(testOut),
      );
    }
    return target;
  } finally {
    rmSync(temporary, { force: true });
    rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

/** Dynamically linked companion; never linked into the daemon executable. */
function buildLinuxSecretProtection({ out, fixture = false } = {}) {
  const include = resolve(dirname(process.execPath), '..', 'include', 'node');
  const header = join(include, 'node_version.h');
  if (!existsSync(header))
    throw new Error(`Node headers are missing beside ${process.execPath}`);
  const text = readFileSync(header, 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH']
    .map(
      (part) =>
        text.match(new RegExp(`#define NODE_${part}_VERSION (\\d+)`))?.[1],
    )
    .join('.');
  if (version !== process.versions.node)
    throw new Error(
      `Node headers are ${version}, expected ${process.versions.node}`,
    );
  const env = { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR ?? '/tmp' };
  const pkgConfig = (args) =>
    execFileSync('/usr/bin/pkg-config', args, {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  // Uses the unstable session encoder; 0.21.4 is the qualification floor.
  pkgConfig(['--atleast-version=0.21.4', 'libsecret-1']);
  const cflags = pkgConfig(['--cflags', 'libsecret-1'])
    .split(/\s+/)
    .filter(Boolean);
  const libs = pkgConfig(['--libs', 'libsecret-1'])
    .split(/\s+/)
    .filter(Boolean);
  const target = resolve(out ?? SECRET_PROTECTION_DEFAULT_OUTPUT);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    execFileSync(
      '/usr/bin/cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fPIC',
        '-shared',
        '-DNAPI_VERSION=8',
        '-pthread',
        ...(fixture ? ['-DSECRET_SERVICE_FIXTURE=1'] : []),
        '-I',
        include,
        ...cflags,
        '-o',
        temporary,
        SECRET_PROTECTION_SOURCE.replace(
          'keychain_slots_darwin.c',
          'secret_service_linux.c',
        ),
        ...libs,
      ],
      { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    renameSync(temporary, target);
    chmodSync(target, 0o644);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

function parseOut(argv, flag = '--out') {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${flag} requires a file path.`);
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2);
    const built = buildSecretProtection({
      out: parseOut(argv),
      ...(process.platform === 'win32'
        ? {
            testOut: parseOut(argv, '--test-out'),
            fixtureOut: parseOut(argv, '--fixture-out'),
            faultOut: parseOut(argv, '--fault-out'),
          }
        : {}),
    });
    const fixtureIndex = argv.indexOf('--fixture-out');
    if (
      (process.platform === 'darwin' || process.platform === 'linux') &&
      fixtureIndex !== -1
    ) {
      const fixture = argv[fixtureIndex + 1];
      if (!fixture || fixture.startsWith('--'))
        throw new Error('--fixture-out requires a file path.');
      if (process.platform === 'linux') {
        buildLinuxSecretProtection({ out: resolve(fixture), fixture: true });
      } else {
        buildDarwinAddon({
          source: SECRET_PROTECTION_SOURCE.replace(
            'keychain_slots_darwin.c',
            'keychain_slots_fixture.c',
          ),
          out: resolve(fixture),
          libraries: ['-framework', 'Security', '-framework', 'CoreFoundation'],
        });
      }
    }
    console.log(
      built
        ? `Done! Addon: ${built}`
        : `Secret protection addon supports Darwin, Windows and Linux; nothing built on ${process.platform}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
