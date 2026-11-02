import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertIsolatedCanopyDataDir,
  buildElectronEnv,
  launchCanopy,
} from '../launchCanopy.mjs';

// A fake home so these cases never depend on the machine running them.
const HOME = path.join(path.sep, 'Users', 'someone');

test('does not inherit the running desktop crash reporter pipe', () => {
  const previous = process.env.CHROME_CRASHPAD_PIPE_NAME;
  process.env.CHROME_CRASHPAD_PIPE_NAME = '\\\\.\\pipe\\crashpad-parent-app';
  try {
    const env = buildElectronEnv(
      path.join(os.tmpdir(), 'canopy-crashpad-test'),
    );
    assert.equal(env.CHROME_CRASHPAD_PIPE_NAME, undefined);
  } finally {
    if (previous === undefined) delete process.env.CHROME_CRASHPAD_PIPE_NAME;
    else process.env.CHROME_CRASHPAD_PIPE_NAME = previous;
  }
});

function expectRejected(value, because) {
  assert.throws(
    () => assertIsolatedCanopyDataDir('CANOPY_DATA_DIR', value, HOME),
    /CANOPY_DATA_DIR/,
    because,
  );
}

// The incident this guards: a suite whose data dir resolved to the real
// `~/.canopy` rewrote `workspaces/index.json` from its own empty view and
// destroyed the developer's entire workspace list. Every brand namespace
// (`.canopy`, `.canopy-dev`, `.canopy-rc`) and every neighbouring tool
// namespace has the same shape, so the rule is the shape, not a brand list.
test('rejects a dot-namespace directly under the home directory', () => {
  for (const namespace of [
    '.canopy',
    '.canopy-dev',
    '.canopy-rc',
    '.canopy-secure',
    '.claude',
    '.codex',
    '.anything-at-all',
  ]) {
    expectRejected(
      path.join(HOME, namespace),
      `${namespace} is a real data namespace, not a test dir`,
    );
  }
});

test('rejects the home directory itself and any ancestor of it', () => {
  expectRejected(HOME, 'the home directory is never a test data dir');
  expectRejected(path.dirname(HOME), 'an ancestor of home is worse still');
  expectRejected(path.sep, 'the filesystem root is worse still');
});

test('rejects an empty or missing value', () => {
  // An unset/blank override makes the app fall back to the brand default,
  // which is exactly the real `~/.canopy` this guard exists to keep out.
  expectRejected(undefined, 'undefined falls back to the brand default');
  expectRejected('', 'empty falls back to the brand default');
  expectRejected('   ', 'whitespace falls back to the brand default');
});

test('rejects an unexpanded tilde path', () => {
  // `~` is shell syntax; Node resolves it against the cwd, so a literal
  // `~/.canopy` silently becomes a junk relative directory instead of home.
  expectRejected('~', 'a bare tilde never resolves to home');
  expectRejected('~/.canopy', 'an unexpanded tilde is a caller bug');
});

test('names the offending variable so the failure is actionable', () => {
  assert.throws(
    () =>
      assertIsolatedCanopyDataDir(
        'CANOPY_SECURE_DATA_DIR',
        path.join(HOME, '.canopy-secure'),
        HOME,
      ),
    (error) =>
      error instanceof Error &&
      error.message.includes('CANOPY_SECURE_DATA_DIR') &&
      error.message.includes(path.join(HOME, '.canopy-secure')),
    'the error must name the variable and the offending path',
  );
});

test('allows an ordinary temp directory', () => {
  assert.doesNotThrow(() =>
    assertIsolatedCanopyDataDir(
      'CANOPY_DATA_DIR',
      path.join(path.sep, 'tmp', 'canopy-electron-abc123'),
      HOME,
    ),
  );
});

test('allows a deep path inside a dot-namespace', () => {
  // Canopy keeps its own git worktrees under `~/.canopy/workspaces/...`, so a
  // repo-relative directory legitimately lives inside a namespace. Only the
  // namespace root itself is the data root that must never be written to.
  assert.doesNotThrow(() =>
    assertIsolatedCanopyDataDir(
      'CANOPY_DATA_DIR',
      path.join(
        HOME,
        '.canopy',
        'workspaces',
        'canopy',
        'worktrees',
        'dingo',
        '.playwright',
        'data',
      ),
      HOME,
    ),
  );
});

test('rejects a temp-looking path whose existing ancestor resolves into a live namespace', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const liveNamespace = path.join(fakeHome, '.canopy');
  const apparentTempRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guard-symlink-'),
  );
  mkdirSync(liveNamespace);
  const linkedNamespace = path.join(apparentTempRoot, 'e2e');
  symlinkSync(liveNamespace, linkedNamespace, 'dir');

  assert.throws(
    () =>
      assertIsolatedCanopyDataDir('CANOPY_DATA_DIR', linkedNamespace, fakeHome),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );

  const linkedHome = path.join(apparentTempRoot, 'home');
  symlinkSync(fakeHome, linkedHome, 'dir');
  assert.throws(
    () =>
      assertIsolatedCanopyDataDir(
        'CANOPY_DATA_DIR',
        path.join(linkedHome, '.canopy'),
        fakeHome,
      ),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
});

test('rejects a live namespace symlinked to an external directory', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const externalDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guard-external-'),
  );
  const liveNamespace = path.join(fakeHome, '.canopy');
  symlinkSync(externalDataDir, liveNamespace, 'dir');

  assert.throws(
    () =>
      assertIsolatedCanopyDataDir('CANOPY_DATA_DIR', liveNamespace, fakeHome),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
  assert.throws(
    () =>
      assertIsolatedCanopyDataDir('CANOPY_DATA_DIR', externalDataDir, fakeHome),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
  assert.doesNotThrow(() =>
    assertIsolatedCanopyDataDir(
      'CANOPY_DATA_DIR',
      path.join(externalDataDir, 'workspaces', 'isolated-test'),
      fakeHome,
    ),
  );
});

test('rejects a case-variant live namespace on a case-insensitive volume', (t) => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'Canopy-guard-home-'));
  const liveNamespace = path.join(fakeHome, '.canopy');
  mkdirSync(liveNamespace);
  const basename = path.basename(fakeHome);
  const letterIndex = [...basename].findIndex((character) =>
    /[A-Za-z]/.test(character),
  );
  const letter = basename[letterIndex];
  const variantBasename =
    basename.slice(0, letterIndex) +
    (letter === letter.toUpperCase()
      ? letter.toLowerCase()
      : letter.toUpperCase()) +
    basename.slice(letterIndex + 1);
  const variantHome = path.join(path.dirname(fakeHome), variantBasename);
  let variantStat;
  try {
    variantStat = statSync(variantHome);
  } catch {
    t.skip('requires a case-insensitive filesystem');
    return;
  }
  const homeStat = statSync(fakeHome);
  if (variantStat.dev !== homeStat.dev || variantStat.ino !== homeStat.ino) {
    t.skip('requires a case-insensitive filesystem');
    return;
  }

  assert.throws(
    () =>
      assertIsolatedCanopyDataDir(
        'CANOPY_DATA_DIR',
        path.join(variantHome, '.CANOPY'),
        fakeHome,
      ),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
});

// The helper passing in isolation proves nothing if nobody calls it. These
// exercise the wiring in `buildElectronEnv`, which is the only chokepoint every
// launch goes through.
test('buildElectronEnv rejects a userDataDir inside a real namespace', () => {
  assert.throws(
    () => buildElectronEnv(path.join(os.homedir(), '.canopy')),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
});

test('buildElectronEnv rejects a data root repointed through extraEnv', () => {
  // `extraEnv` is spread after the defaults, so a spec can override the data
  // root; the guard runs on the final values precisely to catch that.
  assert.throws(
    () =>
      buildElectronEnv(mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-')), {
        CANOPY_DATA_DIR: path.join(os.homedir(), '.canopy-dev'),
      }),
    /CANOPY_DATA_DIR must point at an isolated test directory/,
  );
});

test('buildElectronEnv rejects an unsafe E2E user-data fallback', () => {
  assert.throws(
    () =>
      buildElectronEnv(mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-')), {
        CANOPY_E2E_USER_DATA_DIR: path.join(os.homedir(), '.canopy'),
      }),
    /CANOPY_E2E_USER_DATA_DIR must point at an isolated test directory/,
  );
});

test('buildElectronEnv accepts an ordinary temp userDataDir', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-ok-'));
  const env = buildElectronEnv(dir);
  assert.equal(env.CANOPY_DATA_DIR, dir);
  assert.equal(env.CANOPY_SECURE_DATA_DIR, `${dir}-secure`);
});

test('buildElectronEnv allows brand resolution only under an isolated effective HOME', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const harnessDir = path.join(fakeHome, '.canopy-dev');
  const electronUserDataDir = path.join(fakeHome, 'electron-user-data');
  mkdirSync(harnessDir);
  mkdirSync(electronUserDataDir);

  const env = buildElectronEnv(harnessDir, {
    HOME: fakeHome,
    CANOPY_DATA_DIR: '',
    CANOPY_E2E_USER_DATA_DIR: electronUserDataDir,
  });

  assert.equal(env.HOME, fakeHome);
  assert.equal(env.CANOPY_DATA_DIR, '');
  assert.equal(env.CANOPY_E2E_USER_DATA_DIR, electronUserDataDir);
});

test('buildElectronEnv rejects a blank data dir without a usable profile fallback', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const harnessDir = path.join(fakeHome, '.canopy-dev');
  mkdirSync(harnessDir);

  for (const fallback of ['', path.join(fakeHome, 'missing-profile')]) {
    assert.throws(
      () =>
        buildElectronEnv(harnessDir, {
          HOME: fakeHome,
          CANOPY_DATA_DIR: '',
          CANOPY_E2E_USER_DATA_DIR: fallback,
        }),
      /CANOPY_E2E_USER_DATA_DIR must be a non-empty existing directory/,
    );
  }
});

test('launch rejects a live namespace before any harness seeding mutates it', async () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const liveNamespace = path.join(fakeHome, '.canopy');
  mkdirSync(liveNamespace);
  writeFileSync(path.join(liveNamespace, 'sentinel'), 'untouched', 'utf8');
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await assert.rejects(
      launchCanopy({
        userDataDir: liveNamespace,
        // Deliberately point bundle resolution at an empty root so this test
        // proves the data-root guard wins without relying on a local build.
        rootPath: fakeHome,
      }),
      /CANOPY_DATA_DIR must point at an isolated test directory/,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  assert.deepEqual(readdirSync(liveNamespace), ['sentinel']);
});

test('launch rejects an unsafe E2E user-data fallback before harness mutation', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guard-launch-'),
  );
  writeFileSync(path.join(userDataDir, 'sentinel'), 'untouched', 'utf8');

  await assert.rejects(
    launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_USER_DATA_DIR: path.join(os.homedir(), '.canopy'),
      },
      // The guard must fail before bundle discovery or fixture seeding.
      rootPath: userDataDir,
    }),
    /CANOPY_E2E_USER_DATA_DIR must point at an isolated test directory/,
  );

  assert.deepEqual(readdirSync(userDataDir), ['sentinel']);
});

test('launch requires a usable profile fallback before harness mutation', async () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-guard-home-'));
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guard-launch-'),
  );
  writeFileSync(path.join(userDataDir, 'sentinel'), 'untouched', 'utf8');

  await assert.rejects(
    launchCanopy({
      userDataDir,
      env: {
        HOME: fakeHome,
        CANOPY_DATA_DIR: '',
        CANOPY_E2E_USER_DATA_DIR: '',
      },
      rootPath: userDataDir,
    }),
    /CANOPY_E2E_USER_DATA_DIR must be a non-empty existing directory/,
  );

  assert.deepEqual(readdirSync(userDataDir), ['sentinel']);
});

test('Linux identity validation precedes fixture mutation and bundle discovery', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-root-rejection-'));
  writeFileSync(path.join(dir, 'sentinel'), 'unchanged');
  await assert.rejects(
    launchCanopy({
      userDataDir: dir,
      rootPath: dir,
      platform: 'linux',
      uid: () => 0,
      euid: () => 1000,
    }),
    /non-root/,
  );
  assert.deepEqual(readdirSync(dir), ['sentinel']);
});
test('Linux session HOME/XDG overrides and provider isolation coexist', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-linux-env-'));
  const env = buildElectronEnv(dir, {
    HOME: '/tmp/private/home',
    XDG_CONFIG_HOME: '/tmp/private/config',
    XDG_RUNTIME_DIR: '/tmp/private/runtime',
  });
  assert.equal(env.HOME, '/tmp/private/home');
  assert.equal(env.XDG_RUNTIME_DIR, '/tmp/private/runtime');
  assert.equal(env.CANOPY_SECURE_DATA_DIR, `${dir}-secure`);
  assert.equal(env.CODEX_HOME, path.join(dir, 'provider-state', 'codex'));
});

test('LaunchDarkly startup fixtures allow an explicit client id only with a loopback endpoint', () => {
  const dir = path.join(os.tmpdir(), 'canopy-launchdarkly-startup-test');
  const env = buildElectronEnv(dir, {
    LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: 'e2e-startup-client',
    CANOPY_E2E_LAUNCHDARKLY_BASE_URL: 'http://127.0.0.1:12345',
  });
  assert.equal(env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID, 'e2e-startup-client');
  assert.throws(
    () =>
      buildElectronEnv(dir, {
        LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: 'e2e-startup-client',
        CANOPY_E2E_LAUNCHDARKLY_BASE_URL: 'https://example.com',
      }),
    /loopback/,
  );
});

test('LaunchDarkly startup fixtures still discard an inherited client id', () => {
  const previous = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'e2e-inherited-client';
  try {
    const env = buildElectronEnv(
      path.join(os.tmpdir(), 'canopy-inherited-ld-test'),
    );
    assert.equal(env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID, undefined);
  } finally {
    if (previous === undefined)
      delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    else process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = previous;
  }
});
