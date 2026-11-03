import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadBrand } from '../../../../../scripts/brand/load-brand.mjs';
import { daemonBuildIdentity } from '../../../../../scripts/lib/check-migration-role-package.mjs';
import { writeSourcesRecord } from '../../../../../scripts/lib/core-daemon-sources.mjs';
import { coreDaemonFacts } from '../../../../../scripts/lib/dev-core-daemon.mjs';
import { stageE2eDaemon } from '../../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import {
  installProductDaemon,
  productDaemonTargets,
} from '../../../../../scripts/lib/e2e-daemon-product-bridge.mjs';
import {
  preflightLaneSocketRoot,
  prepareLaneDaemon,
  verifyDaemonDryRunLaunches,
} from '../global-setup.mjs';
import {
  DAEMON_DRY_RUN_ID_ENV,
  captureDaemonDryRunEvidence,
  closeCanopy,
  endingWithDaemonDryRunEvidence,
  trackDaemonDryRunLaunch,
} from '../launchCanopy.mjs';

const brand = loadBrand('canopy');
const NAME = `${brand.cliName}d`;
const identity = { platform: 'darwin', arch: 'arm64' };
const sourceSha = 'd'.repeat(40);
const DRY_RUN = { CANOPY_E2E_DAEMON_FILES_DRY_RUN: '1' };
// Main's snapshot before its first Files read (electron-daemon-files-access.ts).
const FILES_SNAPSHOT = {
  source: 'desktop-main-files-singleton-v1',
  route: null,
  counters: { route: {} },
};

function runtimeRoot(t, { artifact = false, localBuild = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lane-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targets = productDaemonTargets({
    runtimeRoot: root,
    brand,
    ...identity,
  });
  if (artifact) {
    const built = path.join(root, 'built');
    for (const [file, text, mode] of [
      [`daemon/${NAME}`, 'artifact-daemon', 0o755],
      [`daemon/${NAME}.identity.json`, '{}', 0o644],
      ['daemon/node-pty/package.json', '{}', 0o644],
      ['cli', 'cli', 0o755],
      ['core-owned-child.node', 'artifact-addon', 0o644],
    ]) {
      mkdirSync(path.dirname(path.join(built, file)), { recursive: true });
      writeFileSync(path.join(built, file), text);
      chmodSync(path.join(built, file), mode);
    }
    stageE2eDaemon({
      root,
      daemonDirectory: path.join(built, 'daemon'),
      daemonName: NAME,
      cliExecutable: path.join(built, 'cli'),
      ownedChildNativePath: path.join(built, 'core-owned-child.node'),
      sourceSha,
      ...identity,
    });
  }
  if (localBuild) {
    for (const [file, text, mode] of [
      [targets.executable, localBuild.daemon ?? 'local-daemon', 0o755],
      [`${targets.executable}.identity.json`, '{}', 0o644],
      [
        path.join(path.dirname(targets.executable), 'node-pty/package.json'),
        '{}',
        0o644,
      ],
      [targets.ownedChildNativePath, localBuild.addon ?? 'local-addon', 0o644],
    ]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      chmodSync(file, mode);
    }
  }
  return { root, targets };
}

// A `dev:core-daemon` output that matches its sources.
const freshLocalBuild = ({ runtimeRoot: root, platform, arch }) => {
  const targets = productDaemonTargets({
    runtimeRoot: root,
    brand,
    platform,
    arch,
  });
  return {
    ownedChild: {
      label: 'owned-child addon',
      path: targets.ownedChildNativePath,
      state: 'fresh',
    },
    daemon: { label: 'core daemon', path: targets.executable, state: 'fresh' },
  };
};

function prepare(root, overrides = {}) {
  const calls = { install: 0, smoke: [], warnings: [] };
  const result = prepareLaneDaemon({
    runtimeRoot: root,
    brand,
    ...identity,
    // Short on every host, unlike some sandboxes' TMPDIR.
    tmpdir: '/tmp',
    sourceSha: () => sourceSha,
    inspectLocalBuild: freshLocalBuild,
    install: (input) => {
      calls.install++;
      return installProductDaemon(input);
    },
    smoke: ({ executable }) => calls.smoke.push(executable),
    warn: (message) => calls.warnings.push(message),
    ...overrides,
  });
  return { result, calls };
}

test('stays inert unless the resolved Files pin is on', (t) => {
  const { root } = runtimeRoot(t, { artifact: true });
  for (const env of [
    {},
    { CI: 'true' },
    { CANOPY_E2E_DAEMON_FILES_DRY_RUN: '0', CI: 'true' },
  ]) {
    const { result, calls } = prepare(root, {
      env,
      // Even an unusable temporary directory is never inspected.
      tmpdir: path.join(root, 'missing', 'x'.repeat(120)),
    });
    assert.deepEqual(result, { state: 'inert' });
    assert.deepEqual(calls, { install: 0, smoke: [], warnings: [] });
  }
  assert.equal(existsSync(path.join(root, 'dist')), false);
  // An inert run never loads the brand, so a brand it cannot load is harmless.
  assert.deepEqual(
    prepareLaneDaemon({
      env: { CI: 'true', CANOPY_BRAND: 'no-such-brand' },
      runtimeRoot: root,
    }),
    { state: 'inert' },
  );
});

test('prefers the verified artifact, installs it and smokes the installed executable once', (t) => {
  const { root, targets } = runtimeRoot(t, { artifact: true });
  const { result, calls } = prepare(root, { env: { ...DRY_RUN, CI: 'true' } });
  assert.equal(result.state, 'ready');
  assert.equal(result.source, 'artifact');
  assert.equal(result.executable, realpathSync(targets.executable));
  assert.equal(readFileSync(targets.executable, 'utf8'), 'artifact-daemon');
  assert.equal(
    readFileSync(targets.ownedChildNativePath, 'utf8'),
    'artifact-addon',
  );
  assert.equal(calls.install, 1);
  assert.deepEqual(calls.smoke, [result.executable]);
  assert.equal(typeof result.installMs, 'number');
  assert.equal(typeof result.smokeMs, 'number');
});

test('reuses a byte-identical install and refuses a differing local build', (t) => {
  const { root, targets } = runtimeRoot(t, { artifact: true });
  prepare(root, { env: DRY_RUN });
  // A second invocation on the same runner reuses every file.
  const again = prepare(root, {
    env: DRY_RUN,
    install: (input) => {
      const installed = installProductDaemon(input);
      assert.ok(installed.entries.every(({ owned }) => !owned));
      return installed;
    },
  });
  assert.equal(again.result.state, 'ready');
  const { root: stale } = runtimeRoot(t, {
    artifact: true,
    localBuild: { daemon: 'stale local daemon' },
  });
  assert.throws(
    () => prepare(stale, { env: DRY_RUN }),
    /packaged daemon at .* differs from the verified artifact/,
  );
  assert.equal(readFileSync(targets.executable, 'utf8'), 'artifact-daemon');
});

test('otherwise uses a local build at the product paths without copying it', (t) => {
  const { root, targets } = runtimeRoot(t, { localBuild: {} });
  const { result, calls } = prepare(root, { env: { ...DRY_RUN, CI: 'true' } });
  assert.equal(result.source, 'local-build');
  assert.equal(result.executable, targets.executable);
  assert.equal(calls.install, 0);
  assert.deepEqual(calls.smoke, [targets.executable]);
  // A daemon without its identity or node-pty, or a non-executable one, is
  // not launchable.
  for (const missing of [
    `${targets.executable}.identity.json`,
    path.join(path.dirname(targets.executable), 'node-pty/package.json'),
  ]) {
    const { root: partial, targets: partialTargets } = runtimeRoot(t, {
      localBuild: {},
    });
    rmSync(missing.replace(root, partial));
    assert.ok(existsSync(partialTargets.executable));
    assert.throws(
      () => prepare(partial, { env: { ...DRY_RUN, CI: 'true' } }),
      /lane has no launchable daemon/,
      missing,
    );
  }
  chmodSync(targets.executable, 0o644);
  assert.throws(
    () => prepare(root, { env: { ...DRY_RUN, CI: 'true' } }),
    /lane has no launchable daemon/,
  );
});

test('a local build that no longer matches its sources is refused, in CI and locally', (t) => {
  const { root } = runtimeRoot(t, { localBuild: {} });
  const inspected = [];
  const staleAddon = (input) => {
    inspected.push(input);
    const statuses = freshLocalBuild(input);
    return {
      ...statuses,
      ownedChild: {
        ...statuses.ownedChild,
        state: 'stale',
        reason: 'has no source record, so its sources are unknown',
      },
    };
  };
  assert.throws(
    () =>
      prepare(root, {
        env: { ...DRY_RUN, CI: 'true' },
        inspectLocalBuild: staleAddon,
      }),
    /owned-child addon at .* has no source record.*pnpm run dev:core-daemon/,
  );
  assert.deepEqual(inspected[0], {
    runtimeRoot: root,
    env: { ...DRY_RUN, CI: 'true' },
    platform: identity.platform,
    arch: identity.arch,
  });
  // A stale build is no evidence of this checkout, so it is never smoked.
  const smoked = [];
  assert.throws(
    () =>
      prepare(root, {
        env: DRY_RUN,
        inspectLocalBuild: staleAddon,
        smoke: ({ executable }) => smoked.push(executable),
      }),
    /owned-child addon at .* has no source record.*Run pnpm run dev:core-daemon first/,
  );
  assert.deepEqual(smoked, []);
  // A check for another brand's paths does not vouch for this lane's.
  assert.throws(
    () =>
      prepare(root, {
        env: { ...DRY_RUN, CI: 'true' },
        inspectLocalBuild: (input) => ({
          ...freshLocalBuild(input),
          daemon: {
            label: 'core daemon',
            path: path.join(root, 'dist/core-daemon/otherd'),
            state: 'fresh',
          },
        }),
      }),
    /core daemon was checked at .*otherd, not .*canopyd/,
  );
  // A check that cannot run is no evidence either.
  assert.throws(
    () =>
      prepare(root, {
        env: { ...DRY_RUN, CI: 'true' },
        inspectLocalBuild: () => {
          throw new Error('CANOPY_BUILD_ID needs an explicit flavor');
        },
      }),
    /could not check the local build: CANOPY_BUILD_ID needs/,
  );
});

test('by default checks a local build against the source records dev:core-daemon writes', (t) => {
  const { root, targets } = runtimeRoot(t, { localBuild: {} });
  const version = '1.2.3';
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  const env = { ...DRY_RUN, CI: 'true' };
  const real = { env, inspectLocalBuild: undefined };
  assert.throws(
    () => prepare(root, real),
    /core daemon at .* has no source record.*owned-child addon at .* has no source record/,
  );
  const input = path.join(root, 'input.c');
  writeFileSync(input, 'int main;');
  const record = (artifactPath, facts) =>
    assert.ok(
      writeSourcesRecord({
        root,
        artifactPath,
        facts,
        inputs: [input],
        startedAtMs: Date.now() + 60_000,
      }).written,
    );
  const node = { node: process.version, ...identity };
  record(targets.ownedChildNativePath, node);
  record(
    targets.executable,
    coreDaemonFacts({
      identity: daemonBuildIdentity({ brand, version, env }),
      ...identity,
    }),
  );
  const { result, calls } = prepare(root, real);
  assert.equal(result.source, 'local-build');
  assert.deepEqual(calls.warnings, []);
  writeFileSync(input, 'int main();');
  assert.throws(
    () => prepare(root, real),
    /owned-child addon at .* is older than its source input\.c/,
  );
});

test('CI refuses a lane with no launchable daemon; a local run only warns', (t) => {
  const { root } = runtimeRoot(t);
  assert.throws(
    () => prepare(root, { env: { ...DRY_RUN, CI: 'true' } }),
    /Files dry run: lane has no launchable daemon/,
  );
  const { result, calls } = prepare(root, { env: DRY_RUN });
  assert.equal(result.state, 'missing');
  assert.equal(calls.smoke.length, 0);
  assert.match(calls.warnings[0], /lane has no launchable daemon/);
  assert.match(calls.warnings[0], /pnpm run dev:core-daemon/);
  // An addon without a daemon is not a launchable build either.
  const { root: addonOnly, targets } = runtimeRoot(t, { localBuild: {} });
  rmSync(targets.executable);
  assert.throws(
    () => prepare(addonOnly, { env: { ...DRY_RUN, CI: 'true' } }),
    /lane has no launchable daemon/,
  );
});

test('a failed smoke fails the setup', (t) => {
  const { root } = runtimeRoot(t, { localBuild: {} });
  assert.throws(
    () =>
      prepare(root, {
        env: DRY_RUN,
        smoke: () => {
          throw new Error('health/stop failed');
        },
      }),
    /health\/stop failed/,
  );
});

test('socket preflight fails fast when launch data roots are too deep to bind', (t) => {
  const parent = realpathSync(mkdtempSync('/tmp/sock-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  // Exactly at each limit passes; one byte more fails.
  const suffix = Buffer.byteLength(
    '/canopy-electron-XXXXXX/runtime/.000000000000',
  );
  for (const [platform, limit] of [
    ['darwin', 103],
    ['linux', 107],
  ]) {
    const fill = limit - suffix - Buffer.byteLength(parent) - 1;
    const fits = path.join(parent, 'a'.repeat(fill));
    const over = path.join(parent, 'b'.repeat(fill + 1));
    mkdirSync(fits);
    mkdirSync(over);
    assert.deepEqual(preflightLaneSocketRoot({ platform, tmpdir: fits }), {
      probe: path.join(fits, 'canopy-electron-XXXXXX/runtime/.000000000000'),
      bytes: limit,
      limit,
    });
    assert.throws(
      () => preflightLaneSocketRoot({ platform, tmpdir: over }),
      new RegExp(
        `${limit + 1}-byte daemon socket paths, over the ${platform} limit of ${limit}\\. Point TMPDIR at a shorter directory, such as /tmp, as the macOS CI lanes do\\.$`,
      ),
    );
  }
  assert.equal(
    preflightLaneSocketRoot({ platform: 'win32', tmpdir: parent }),
    null,
  );
  // The dry run checks it before anything is installed.
  const { root } = runtimeRoot(t, { artifact: true });
  const deep = path.join(parent, 'c'.repeat(80));
  mkdirSync(deep);
  assert.throws(
    () => prepare(root, { env: DRY_RUN, tmpdir: deep }),
    /over the darwin limit/,
  );
  assert.equal(existsSync(path.join(root, 'dist')), false);
});

test('the dry-run teardown fails when a registered launch has no evidence line', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dry-run-launches-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launch = (runId, title) => {
    const electronApp = {
      evaluate: async () => FILES_SNAPSHOT,
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, path.join(directory, 'data'), {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: runId },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    return electronApp;
  };
  // An earlier run's unclosed launch is not this run's concern.
  launch('earlier', 'left open');
  const closedDirectly = launch('run', 'closed directly');
  const leftOpen = launch('run', 'never closed');
  await closedDirectly.close();
  assert.throws(
    () => verifyDaemonDryRunLaunches({ runId: 'run', directory }),
    /^Error: Files dry run: 1 of 2 launches have no evidence line: x\.spec\.mjs > never closed \(retry 0\)$/,
  );
  await leftOpen.close();
  assert.deepEqual(verifyDaemonDryRunLaunches({ runId: 'run', directory }), {
    launches: 2,
    recorded: 2,
  });
  // A run with no launches, or no directory, passes.
  assert.deepEqual(
    verifyDaemonDryRunLaunches({
      runId: 'none',
      directory: path.join(directory, 'missing'),
    }),
    { launches: 0, recorded: 0 },
  );
  // A torn line fails the check instead of hiding a launch.
  writeFileSync(path.join(directory, 'launches-1.ndjson'), '{"runId":\n');
  assert.throws(
    () => verifyDaemonDryRunLaunches({ runId: 'run', directory }),
    /launches-1\.ndjson line 1 is not JSON/,
  );
});

test('the dry-run teardown fails on a fallback whose close failure a spec swallowed', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dry-run-fallbacks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launch = (title, snapshot) => {
    const electronApp = {
      evaluate: async () => snapshot,
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, path.join(directory, title), {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: 'run' },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    return electronApp;
  };
  const fellBack = {
    ...FILES_SNAPSHOT,
    counters: { route: { 'files.roots.daemon.fallback.unavailable': 2 } },
  };
  await launch('clean', FILES_SNAPSHOT).close();
  // A teardown helper that ends in `.catch(() => undefined)`.
  await launch('fell back', fellBack)
    .close()
    .catch(() => undefined);
  assert.throws(
    () => verifyDaemonDryRunLaunches({ runId: 'run', directory }),
    /^Error: Files dry run: 1 of 2 launches fell back: x\.spec\.mjs > fell back \(retry 0\) \{"counters\.route\.files\.roots\.daemon\.fallback\.unavailable":2\}$/,
  );
});

test('the dry-run teardown fails a launch without a valid Files evidence snapshot', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dry-run-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launch = async (title, snapshot) => {
    const electronApp = {
      evaluate: async () => snapshot,
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, path.join(directory, title), {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: title },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    await electronApp.close();
    return () => verifyDaemonDryRunLaunches({ runId: title, directory });
  };
  // A launch with no Files reads yet: no route, zeroed counters.
  assert.deepEqual((await launch('no reads', FILES_SNAPSHOT))(), {
    launches: 1,
    recorded: 1,
  });
  for (const [title, snapshot, reason] of [
    ['no evidence hook', null, 'no snapshot'],
    ['no counters', { ...FILES_SNAPSHOT, counters: null }, 'counters.route'],
    ['other source', { ...FILES_SNAPSHOT, source: 'other' }, 'source other'],
  ]) {
    const verify = await launch(title, snapshot);
    assert.throws(
      verify,
      new RegExp(
        `^Error: Files dry run: 1 of 1 launches have invalid evidence: x\\.spec\\.mjs > ${title} \\(retry 0\\) Files evidence snapshot .*${reason}`,
      ),
    );
  }
});

test('the dry-run teardown names launches that used the daemon from a data root too deep for its socket', async (t) => {
  if (process.platform === 'win32') return t.skip('named pipes have no limit');
  // Short on every host, unlike some sandboxes' TMPDIR.
  const directory = mkdtempSync('/tmp/dry-run-socket-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Lexical: over every Unix socket limit.
  const deepRoot = (title) => path.join('/gone', 'd'.repeat(200), title);
  const launch = async (runId, title, userDataDir, route) => {
    const electronApp = {
      evaluate: async () => ({ ...FILES_SNAPSHOT, counters: { route } }),
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, userDataDir, {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: runId },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    await electronApp.close().catch(() => undefined);
  };
  const failedRead = {
    'files.roots.daemon': 1,
    'files.roots.daemon.failed.unavailable': 1,
  };
  // A deep root is harmless while nothing reaches the daemon.
  await launch('idle', 'deep idle', deepRoot('idle'), {
    'files.roots.direct': 0,
  });
  await launch('idle', 'short reads', path.join(directory, 'a'), failedRead);
  assert.deepEqual(verifyDaemonDryRunLaunches({ runId: 'idle', directory }), {
    launches: 2,
    recorded: 2,
  });
  // Every failing kind is reported in one run, the socket cause first.
  await launch('deep', 'deep reads', deepRoot('reads'), failedRead);
  await launch('deep', 'deep fell back', deepRoot('fell'), {
    'files.roots.daemon': 1,
    'files.roots.daemon.fallback.unavailable': 1,
  });
  await launch('deep', 'short idle', path.join(directory, 'b'), {});
  const error = (() => {
    try {
      verifyDaemonDryRunLaunches({ runId: 'deep', directory });
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  const lines = error?.message.split('\n') ?? [];
  assert.equal(lines.length, 2, error?.message);
  assert.match(
    lines[0],
    /^Files dry run: 2 of 3 launches used the daemon from a data root too deep for its socket: x\.spec\.mjs > deep reads \(retry 0\) \d+ bytes over \d+; x\.spec\.mjs > deep fell back \(retry 0\) \d+ bytes over \d+\. Give the spec's data root a shorter mkdtemp prefix, or run under a shorter TMPDIR such as \/tmp\.$/,
  );
  assert.match(
    lines[1],
    /^Files dry run: 1 of 3 launches fell back: x\.spec\.mjs > deep fell back/,
  );
});

test('the dry-run teardown fails on a launch killed before its evidence was read', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dry-run-unreadable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Its evidence is readable only until `kill` ends it.
  const launch = (runId, title) => {
    let alive = true;
    const electronApp = {
      evaluate: async () => {
        if (!alive) throw new Error('Target closed');
        return FILES_SNAPSHOT;
      },
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, path.join(directory, title), {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: runId },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    const kill = async () => {
      alive = false;
    };
    return { electronApp, kill };
  };
  // The harness's `killAbruptly` reads the evidence first.
  const harnessKill = launch('run', 'harness kill');
  await endingWithDaemonDryRunEvidence(
    harnessKill.electronApp,
    harnessKill.kill,
  )();
  await closeCanopy(harnessKill.electronApp, path.join(directory, 'gone'), {
    daemonDryRun: { env: {} },
    removeDataDir: async () => {},
  });
  // So does a spec that captures it before its own SIGKILL or quit.
  const specKill = launch('run', 'captured spec kill');
  await captureDaemonDryRunEvidence(specKill.electronApp);
  await specKill.kill();
  await specKill.electronApp.close();
  // An untracked closeCanopy line in the same run is not a registered launch.
  writeFileSync(
    path.join(directory, 'launches-1.ndjson'),
    `${JSON.stringify({ runId: 'run', launchId: null, fallbacks: {} })}\n`,
  );
  assert.deepEqual(verifyDaemonDryRunLaunches({ runId: 'run', directory }), {
    launches: 2,
    recorded: 2,
  });
  // A kill the harness never saw leaves the close only an exited app to read.
  const uncaptured = launch('run', 'uncaptured spec kill');
  await uncaptured.kill();
  await uncaptured.electronApp.close();
  assert.throws(
    () => verifyDaemonDryRunLaunches({ runId: 'run', directory }),
    /^Error: Files dry run: 1 of 3 launches have unreadable evidence: x\.spec\.mjs > uncaptured spec kill \(retry 0\) Target closed\. A spec that ends the app itself must await captureDaemonDryRunEvidence\(electronApp\) first\.$/,
  );
});

test('the dry-run teardown fails a launch whose evidence read failed without a message', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dry-run-silent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [title, failure] of [
    ['empty message', new Error('')],
    ['empty string', ''],
    ['undefined', undefined],
  ]) {
    const electronApp = {
      evaluate: () => Promise.reject(failure),
      close: async () => {},
    };
    trackDaemonDryRunLaunch(electronApp, path.join(directory, 'data'), {
      directory,
      env: { ...DRY_RUN, [DAEMON_DRY_RUN_ID_ENV]: title },
      testInfo: { file: 'x.spec.mjs', titlePath: ['', title], retry: 0 },
    });
    await electronApp.close();
    assert.throws(
      () => verifyDaemonDryRunLaunches({ runId: title, directory }),
      new RegExp(
        `^Error: Files dry run: 1 of 1 launches have unreadable evidence: x\\.spec\\.mjs > ${title} \\(retry 0\\) Files evidence read failed`,
      ),
      title,
    );
  }
});
