import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DAEMON_DRY_RUN_ID_ENV,
  DAEMON_FILES_DRY_RUN_ENV,
  DAEMON_FILES_FLAG,
  captureDaemonDryRunEvidence,
  closeCanopy,
  daemonFallbackCounters,
  daemonSocketBudget,
  endingWithDaemonDryRunEvidence,
  mergeE2eClientFeatureFlags,
  registerSupervisedProcessTree,
  resolveDefaultE2eClientFeatureFlags,
  trackDaemonDryRunLaunch,
} from '../launchCanopy.mjs';

test(
  'closeCanopy reaps the supervised tree when graceful Electron close stalls',
  { timeout: 1_000 },
  async () => {
    const calls = [];
    const electronApp = {
      close: () => new Promise(() => {}),
    };
    registerSupervisedProcessTree(electronApp, 4242);

    await closeCanopy(electronApp, 'C:\\test-data', {
      platform: 'darwin',
      gracefulCloseTimeoutMs: 1,
      scheduleTimeout: (callback) => {
        callback();
        return 1;
      },
      cancelTimeout: () => {},
      reapTree: async (pid) => calls.push(['reap', pid]),
      removeDataDir: async (dirPath) => calls.push(['remove', dirPath]),
    });

    assert.deepEqual(calls, [
      ['reap', 4242],
      ['remove', 'C:\\test-data'],
      ['remove', 'C:\\test-data-secure'],
    ]);
  },
);

test('closeCanopy does not reap a retired Windows PID after Playwright cleanup', async () => {
  const calls = [];
  let treeAlive = true;
  let now = 0;
  const electronApp = {
    async evaluate(callback) {
      return callback({
        app: {
          quit() {
            calls.push('quit');
          },
          exit(code) {
            calls.push(['exit', code]);
          },
        },
      });
    },
    async close() {
      calls.push('close');
    },
  };
  registerSupervisedProcessTree(electronApp, 4343);

  await closeCanopy(electronApp, 'C:\\test-data', {
    platform: 'win32',
    gracefulCloseTimeoutMs: 1,
    treeExists: () => treeAlive,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    reapTree: async () => {
      if (treeAlive) calls.push('reap');
    },
    removeDataDir: async () => {},
  });

  assert.deepEqual(calls, ['quit', ['exit', 0], 'close']);
});

test('Linux uses an isolated Chromium profile, X11 and libsecret without a mock keychain', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const args = platformElectronArgs('/tmp/canopy-launch', ['--some-flag'], {
    platform: 'linux',
    uid: () => 1000,
    euid: () => 1000,
  });
  assert.deepEqual(args, [
    '--user-data-dir=/tmp/canopy-launch/electron-profile',
    '--ozone-platform=x11',
    '--password-store=gnome-libsecret',
    '--some-flag',
  ]);
  assert.deepEqual(
    platformElectronArgs('/tmp/test', ['--some-flag'], { platform: 'darwin' }),
    ['--use-mock-keychain', '--some-flag'],
  );
  assert.deepEqual(
    platformElectronArgs('/tmp/test', ['--some-flag'], { platform: 'win32' }),
    ['--use-mock-keychain', '--some-flag'],
  );
});
for (const arg of [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--user-data-dir=/tmp/outside',
  '--user-data-dir',
  '--ozone-platform=wayland',
  '--password-store=basic',
  '--display=:0',
  '--use-mock-keychain',
]) {
  test(`Linux rejects unsafe launch argument ${arg}`, async () => {
    const { platformElectronArgs } = await import('../launchCanopy.mjs');
    assert.throws(
      () =>
        platformElectronArgs('/tmp/canopy-launch', [arg], {
          platform: 'linux',
          uid: () => 1000,
          euid: () => 1000,
        }),
      /Linux|isolated|sandbox/,
    );
  });
}
test('Linux rejects duplicate switches and retains a validated caller profile', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const opts = { platform: 'linux', uid: () => 1000, euid: () => 1000 };
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/test',
        ['--ozone-platform=x11', '--ozone-platform=x11'],
        opts,
      ),
    /duplicate/,
  );
  assert.ok(
    platformElectronArgs(
      '/tmp/test',
      ['--user-data-dir=/tmp/test/custom'],
      opts,
    ).includes('--user-data-dir=/tmp/test/custom'),
  );
});

test('Linux accepts one libsecret CLI switch and rejects conflicting switches', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const options = { platform: 'linux', uid: () => 1000, euid: () => 1000 };
  const args = platformElectronArgs(
    '/tmp/canopy-launch',
    ['--password-store=gnome-libsecret'],
    options,
  );
  assert.deepEqual(
    args.filter((arg) => arg.startsWith('--password-store')),
    ['--password-store=gnome-libsecret'],
  );
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/canopy-launch',
        ['--password-store=basic'],
        options,
      ),
    /gnome-libsecret/,
  );
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/canopy-launch',
        ['--password-store=gnome-libsecret', '--password-store=basic'],
        options,
      ),
    /duplicate/,
  );
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(
      platformElectronArgs('/tmp/canopy-launch', [], { platform }),
      ['--use-mock-keychain'],
    );
  }
});

test('the Files pin is offered by default and on only for the dry run', () => {
  assert.equal(
    resolveDefaultE2eClientFeatureFlags({})[DAEMON_FILES_FLAG],
    'offered',
  );
  for (const value of ['0', 'true', '', ' 1'])
    assert.equal(
      resolveDefaultE2eClientFeatureFlags({
        [DAEMON_FILES_DRY_RUN_ENV]: value,
      })[DAEMON_FILES_FLAG],
      'offered',
      value,
    );
  const dryRun = { [DAEMON_FILES_DRY_RUN_ENV]: '1' };
  assert.equal(
    resolveDefaultE2eClientFeatureFlags(dryRun)[DAEMON_FILES_FLAG],
    'on',
  );
  // Only the Files pin moves.
  const { [DAEMON_FILES_FLAG]: _on, ...others } =
    resolveDefaultE2eClientFeatureFlags(dryRun);
  const { [DAEMON_FILES_FLAG]: _offered, ...baseline } =
    resolveDefaultE2eClientFeatureFlags({});
  assert.deepEqual(others, baseline);
  // A spec's own pin wins over the dry run.
  const merged = JSON.parse(
    mergeE2eClientFeatureFlags(
      {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          [DAEMON_FILES_FLAG]: 'offered',
        }),
      },
      dryRun,
    ),
  );
  assert.equal(merged[DAEMON_FILES_FLAG], 'offered');
  assert.equal(
    JSON.parse(mergeE2eClientFeatureFlags({}, dryRun))[DAEMON_FILES_FLAG],
    'on',
  );
});

test('daemonFallbackCounters reports only nonzero daemon.fallback leaves', () => {
  assert.deepEqual(
    daemonFallbackCounters({
      counters: {
        route: {
          'files.roots.daemon.served': 3,
          'files.roots.daemon.failed.unavailable': 1,
          'files.roots.daemon.fallback.unavailable': 0,
          'files.directory.daemon.fallback.unavailable': 2,
          'files.directory.daemon.fallbacks': 9,
        },
        fallback: { daemon: { fallback: { total: 4 } } },
      },
      route: null,
    }),
    {
      'counters.route.files.directory.daemon.fallback.unavailable': 2,
      'counters.fallback.daemon.fallback.total': 4,
    },
  );
  assert.deepEqual(daemonFallbackCounters(null), {});
});

// snapshotFilesWorkCounters zero-fills every outcome; recordFilesRouteOutcome
// counts `daemon.bypassed` when a latched failure skipped the daemon (CAN-5541).
test('daemonFallbackCounters reports latched bypasses as in-process reads', () => {
  const route = {};
  for (const operation of ['roots', 'directory', 'file', 'search', 'link'])
    for (const outcome of [
      'daemon',
      'daemon.served',
      'daemon.bypassed',
      'daemon.fallback.start_failed',
      'daemon.fallback.connection_lost',
      'daemon.fallback.reconnect_failed',
    ])
      route[`files.${operation}.${outcome}`] = 0;
  route['files.directory.daemon'] = 3;
  route['files.directory.daemon.served'] = 1;
  route['files.directory.daemon.fallback.connection_lost'] = 1;
  route['files.directory.daemon.bypassed'] = 1;
  route['files.directory.daemon.bypassedish'] = 7;
  assert.deepEqual(
    daemonFallbackCounters({
      source: 'desktop-main-files-singleton-v1',
      route: null,
      counters: { generation: 0, overflow: 0, route },
    }),
    {
      'counters.route.files.directory.daemon.fallback.connection_lost': 1,
      'counters.route.files.directory.daemon.bypassed': 1,
    },
  );
});

// Main's snapshot before its first Files read (electron-daemon-files-access.ts).
const FILES_SNAPSHOT = {
  source: 'desktop-main-files-singleton-v1',
  route: null,
  counters: { route: {} },
};

function dryRunApp(evaluate) {
  return { evaluate, close: async () => {} };
}

function dryRunRoots(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dry-run-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    userDataDir: path.join(root, 'data'),
    directory: path.join(root, 'evidence'),
  };
}

const readLines = (directory) =>
  readdirSync(directory).flatMap((name) =>
    readFileSync(path.join(directory, name), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  );

test('closeCanopy records one dry-run line per launch before removing the data root', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  mkdirSync(path.join(userDataDir, 'runtime'), { recursive: true });
  writeFileSync(path.join(userDataDir, 'runtime', 'core.json'), '{}');
  const calls = [];
  const electronApp = dryRunApp(async () => {
    calls.push(['evaluate', existsSync(userDataDir)]);
    return {
      source: 'desktop-main-files-singleton-v1',
      // As `observe()` returns it without a cursor.
      route: {
        enabled: true,
        cursor: { observerId: 'o', sequence: 7 },
        dropped: 7,
        complete: false,
        entries: [],
      },
      counters: {
        route: {
          'files.roots.daemon': 2,
          'files.roots.daemon.served': 2,
          'files.directory.direct': 1,
          'files.directory.daemon.failed.unavailable': 0,
        },
      },
    };
  });
  await closeCanopy(electronApp, userDataDir, {
    daemonDryRun: {
      env: {
        [DAEMON_FILES_DRY_RUN_ENV]: '1',
        CANOPY_UI_TIMINGS_LANE: 'lane-a',
      },
      directory,
      testInfo: null,
    },
    removeDataDir: async (dirPath) => calls.push(['remove', dirPath]),
  });
  assert.deepEqual(calls, [
    ['evaluate', true],
    ['remove', userDataDir],
    ['remove', `${userDataDir}-secure`],
  ]);
  const [line, ...rest] = readLines(directory);
  assert.equal(rest.length, 0);
  assert.equal(line.lane, 'lane-a');
  assert.equal(line.descriptorPresent, true);
  assert.equal(line.routeEnabled, true);
  assert.equal(line.daemonServed, 2);
  assert.equal(line.direct, 1);
  assert.deepEqual(line.daemonFailed, {});
  assert.deepEqual(line.fallbacks, {});
  assert.equal(line.routeEventsRecorded, 7);
  assert.equal(line.evidenceError, null);
  assert.deepEqual(line.socket, daemonSocketBudget(userDataDir));
});

test('daemonSocketBudget measures the canonical data root against the platform limit', (t) => {
  // Short on every host, unlike some sandboxes' TMPDIR.
  const parent = mkdtempSync('/tmp/sock-budget-');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const probe = '/runtime/.000000000000';
  const canonical = realpathSync(parent);
  const fill = 103 - Buffer.byteLength(canonical) - probe.length - 1;
  const fits = path.join(parent, 'a'.repeat(fill));
  const over = path.join(parent, 'b'.repeat(fill + 1));
  mkdirSync(fits);
  mkdirSync(over);
  assert.deepEqual(daemonSocketBudget(fits, 'darwin'), {
    bytes: 103,
    limit: 103,
    fits: true,
  });
  assert.deepEqual(daemonSocketBudget(over, 'darwin'), {
    bytes: 104,
    limit: 103,
    fits: false,
  });
  // A link to the root is measured where it resolves.
  const link = path.join(canonical, 'l');
  symlinkSync(over, link);
  assert.equal(daemonSocketBudget(link, 'darwin').bytes, 104);
  // A removed root falls back to its lexical spelling.
  assert.equal(
    daemonSocketBudget('/gone/x', 'linux').bytes,
    Buffer.byteLength(`/gone/x${probe}`),
  );
  assert.equal(daemonSocketBudget(fits, 'win32'), null);
  assert.equal(daemonSocketBudget(undefined, 'darwin'), null);
});

test('closeCanopy fails a dry-run launch that fell back, after its cleanup', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const removed = [];
  await assert.rejects(
    closeCanopy(
      dryRunApp(async () => ({
        ...FILES_SNAPSHOT,
        counters: { route: { 'files.roots.daemon.fallback.unavailable': 1 } },
      })),
      userDataDir,
      {
        daemonDryRun: {
          env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
          directory,
          testInfo: null,
        },
        removeDataDir: async (dirPath) => removed.push(dirPath),
      },
    ),
    /Files dry run: the daemon route fell back .*files\.roots\.daemon\.fallback\.unavailable/,
  );
  assert.deepEqual(removed, [userDataDir, `${userDataDir}-secure`]);
  const [line] = readLines(directory);
  assert.equal(line.descriptorPresent, false);
  assert.deepEqual(line.fallbacks, {
    'counters.route.files.roots.daemon.fallback.unavailable': 1,
  });
});

test('closeCanopy records unreadable dry-run evidence without failing the close', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  for (const evaluate of [
    async () => {
      throw new Error('Target page, context or browser has been closed');
    },
    () => new Promise(() => {}),
  ])
    await closeCanopy(dryRunApp(evaluate), userDataDir, {
      daemonDryRun: {
        env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
        directory,
        testInfo: null,
        timeoutMs: 5,
      },
      removeDataDir: async () => {},
    });
  assert.deepEqual(
    readLines(directory).map(({ evidenceError, counters }) => [
      evidenceError,
      counters,
    ]),
    [
      ['Target page, context or browser has been closed', null],
      ['Files evidence read timed out', null],
    ],
  );
});

test('closeCanopy records a snapshot outside main’s Files evidence contract as invalid', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const route = {
    enabled: false,
    cursor: { observerId: 'o', sequence: 0 },
    entries: [],
  };
  const cases = [
    [FILES_SNAPSHOT, null],
    [{ ...FILES_SNAPSHOT, route }, null],
    [null, 'no snapshot'],
    [undefined, 'no snapshot'],
    [[], 'no snapshot'],
    ['snapshot', 'no snapshot'],
    [{ ...FILES_SNAPSHOT, source: undefined }, 'source undefined'],
    [{ source: FILES_SNAPSHOT.source, counters: { route: {} } }, 'no route'],
    [{ ...FILES_SNAPSHOT, route: [] }, 'route.enabled'],
    [
      { ...FILES_SNAPSHOT, route: { ...route, enabled: 'yes' } },
      'route.enabled',
    ],
    [{ ...FILES_SNAPSHOT, route: { ...route, cursor: null } }, 'route.cursor'],
    [
      { ...FILES_SNAPSHOT, route: { ...route, cursor: { sequence: -1 } } },
      'route.cursor',
    ],
    [{ ...FILES_SNAPSHOT, counters: undefined }, 'counters.route'],
    [{ ...FILES_SNAPSHOT, counters: {} }, 'counters.route'],
    [{ ...FILES_SNAPSHOT, counters: { route: [] } }, 'counters.route'],
  ];
  for (const [snapshot] of cases)
    await closeCanopy(
      dryRunApp(async () => snapshot),
      userDataDir,
      {
        daemonDryRun: {
          env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
          directory,
          testInfo: null,
        },
        removeDataDir: async () => {},
      },
    );
  const lines = readLines(directory);
  assert.equal(lines.length, cases.length);
  cases.forEach(([snapshot, reason], index) => {
    const { evidenceError, evidenceInvalid } = lines[index];
    const label = JSON.stringify(snapshot);
    if (reason === null) {
      assert.equal(evidenceError, null, label);
      assert.equal(evidenceInvalid, false, label);
    } else {
      assert.match(
        evidenceError,
        new RegExp(`^Files evidence snapshot .*${reason}`),
        label,
      );
      assert.equal(evidenceInvalid, true, label);
    }
  });
  // A read that failed is unreadable, not invalid.
  await closeCanopy(
    dryRunApp(async () => {
      throw new Error('Target closed');
    }),
    userDataDir,
    {
      daemonDryRun: {
        env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
        directory,
        testInfo: null,
      },
      removeDataDir: async () => {},
    },
  );
  const last = readLines(directory).at(-1);
  assert.deepEqual(
    [last.evidenceError, last.evidenceInvalid],
    ['Target closed', false],
  );
});

test('closeCanopy reads no dry-run evidence outside the dry run', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  await closeCanopy(
    dryRunApp(async () => assert.fail('evidence must not be read')),
    userDataDir,
    {
      daemonDryRun: { env: {}, directory, testInfo: null },
      removeDataDir: async () => {},
    },
  );
  assert.equal(existsSync(directory), false);
});

const FELL_BACK = {
  ...FILES_SNAPSHOT,
  counters: { route: { 'files.roots.daemon.fallback.unavailable': 1 } },
};

test('a direct electronApp.close() of a dry-run launch records its evidence and fails on a fallback', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const calls = [];
  const electronApp = {
    async evaluate() {
      calls.push('evaluate');
      return FELL_BACK;
    },
    async close(...args) {
      calls.push(['close', this === electronApp, ...args]);
    },
  };
  const launch = trackDaemonDryRunLaunch(electronApp, userDataDir, {
    directory,
    env: { [DAEMON_FILES_DRY_RUN_ENV]: '1', [DAEMON_DRY_RUN_ID_ENV]: 'run-1' },
    testInfo: null,
  });
  const [registered] = readLines(directory);
  assert.deepEqual(
    [registered.runId, registered.launchId],
    ['run-1', launch.launchId],
  );
  await assert.rejects(
    electronApp.close({ reason: 'spec' }),
    /Files dry run: the daemon route fell back/,
  );
  // The close still ran, after the evidence read.
  assert.deepEqual(calls, ['evaluate', ['close', true, { reason: 'spec' }]]);
  const line = readLines(directory).find(({ fallbacks }) => fallbacks);
  assert.equal(line.launchId, launch.launchId);
  assert.equal(line.runId, 'run-1');
  // Closing again neither rereads nor fails again.
  await electronApp.close();
  assert.equal(calls.filter((call) => call === 'evaluate').length, 1);
  assert.equal(
    readLines(directory).filter(({ fallbacks }) => fallbacks).length,
    1,
  );
});

test('closeCanopy of a tracked launch records once and reports its fallback once', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  let reads = 0;
  const electronApp = {
    async evaluate() {
      reads += 1;
      return FELL_BACK;
    },
    async close() {},
  };
  trackDaemonDryRunLaunch(electronApp, userDataDir, {
    directory,
    env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
    testInfo: null,
  });
  const removed = [];
  // No dry-run env passed: the tracked launch alone selects the check.
  const error = await closeCanopy(electronApp, userDataDir, {
    daemonDryRun: { env: {} },
    removeDataDir: async (dirPath) => removed.push(dirPath),
  }).catch((caught) => caught);
  assert.match(error.message, /^Files dry run: the daemon route fell back/);
  assert.equal(error instanceof AggregateError, false);
  assert.equal(reads, 1);
  assert.deepEqual(removed, [userDataDir, `${userDataDir}-secure`]);
});

test('closeCanopy tears down when the dry-run evidence cannot be written', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  // A file where the evidence directory belongs makes mkdir fail.
  mkdirSync(path.dirname(directory), { recursive: true });
  writeFileSync(directory, 'not a directory');
  const daemonDryRun = {
    env: { [DAEMON_FILES_DRY_RUN_ENV]: '1' },
    directory,
    testInfo: null,
  };
  const removed = [];
  await assert.rejects(
    closeCanopy(
      dryRunApp(async () => null),
      userDataDir,
      {
        daemonDryRun,
        removeDataDir: async (dirPath) => removed.push(dirPath),
      },
    ),
    (error) => ['EEXIST', 'ENOTDIR'].includes(error.code),
  );
  assert.deepEqual(removed, [userDataDir, `${userDataDir}-secure`]);
  // With a failing teardown too, both failures are reported.
  const error = await closeCanopy(
    dryRunApp(async () => null),
    userDataDir,
    {
      daemonDryRun,
      removeDataDir: async () => {
        throw new Error('remove failed');
      },
    },
  ).catch((caught) => caught);
  assert.ok(error instanceof AggregateError, String(error));
  assert.deepEqual(
    error.errors.map((failure) => failure.code ?? failure.message),
    [error.errors[0].code, 'remove failed'],
  );
  assert.ok(['EEXIST', 'ENOTDIR'].includes(error.errors[0].code));
});

// An app whose evidence read fails once it has been killed, as Playwright's does.
function killableDryRunApp(snapshot, calls) {
  let alive = true;
  return {
    app: {
      async evaluate() {
        calls.push('evaluate');
        if (!alive)
          throw new Error('Target page, context or browser has been closed');
        return snapshot;
      },
      async close() {
        calls.push('close');
      },
    },
    kill: async () => {
      calls.push('kill');
      alive = false;
      return 'killed';
    },
  };
}

const trackForRun = (electronApp, userDataDir, directory) =>
  trackDaemonDryRunLaunch(electronApp, userDataDir, {
    directory,
    env: { [DAEMON_FILES_DRY_RUN_ENV]: '1', [DAEMON_DRY_RUN_ID_ENV]: 'run' },
    testInfo: null,
  });

test('an abrupt kill of a dry-run launch records its evidence while the app is alive', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const calls = [];
  const { app, kill } = killableDryRunApp(FILES_SNAPSHOT, calls);
  const launch = trackForRun(app, userDataDir, directory);
  const killAbruptly = endingWithDaemonDryRunEvidence(app, kill);
  assert.equal(await killAbruptly(), 'killed');
  // The teardown that follows the kill neither rereads nor fails.
  await closeCanopy(app, userDataDir, {
    daemonDryRun: { env: {} },
    removeDataDir: async () => {},
  });
  assert.deepEqual(calls, ['evaluate', 'kill', 'close']);
  const evidence = readLines(directory).filter((line) => 'fallbacks' in line);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].launchId, launch.launchId);
  assert.equal(evidence[0].evidenceError, null);
});

test('an abrupt kill of a dry-run launch that fell back leaves the report to the teardown after it', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const calls = [];
  const { app, kill } = killableDryRunApp(FELL_BACK, calls);
  trackForRun(app, userDataDir, directory);
  // Callers such as crashKeepingData tear down right after the kill, so the
  // kill itself must not throw past that teardown.
  assert.equal(await endingWithDaemonDryRunEvidence(app, kill)(), 'killed');
  assert.deepEqual(calls, ['evaluate', 'kill']);
  const removed = [];
  await assert.rejects(
    closeCanopy(app, userDataDir, {
      daemonDryRun: { env: {} },
      removeDataDir: async (dirPath) => removed.push(dirPath),
    }),
    /Files dry run: the daemon route fell back/,
  );
  assert.deepEqual(calls, ['evaluate', 'kill', 'close']);
  assert.deepEqual(removed, [userDataDir, `${userDataDir}-secure`]);
  // Reported once: a second close neither rereads nor fails.
  await app.close();
  assert.equal(calls.filter((call) => call === 'evaluate').length, 1);
  // A failed kill is still the kill's own failure.
  const failing = killableDryRunApp(FELL_BACK, []);
  trackForRun(failing.app, userDataDir, directory);
  await assert.rejects(
    endingWithDaemonDryRunEvidence(failing.app, async () => {
      throw new Error('kill failed');
    })(),
    /^Error: kill failed$/,
  );
});

test('an abrupt kill outside the dry run reads no evidence', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const calls = [];
  const { app, kill } = killableDryRunApp(FELL_BACK, calls);
  trackDaemonDryRunLaunch(app, userDataDir, {
    directory,
    env: {},
    testInfo: null,
  });
  assert.equal(await endingWithDaemonDryRunEvidence(app, kill)(), 'killed');
  assert.equal(
    await endingWithDaemonDryRunEvidence(undefined, async () => 'no app')(),
    'no app',
  );
  assert.deepEqual(calls, ['kill']);
  assert.equal(existsSync(directory), false);
});

test('captureDaemonDryRunEvidence reads a launch before a spec ends it itself', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const untracked = [];
  assert.equal(
    await captureDaemonDryRunEvidence(
      killableDryRunApp(FELL_BACK, untracked).app,
    ),
    null,
  );
  assert.deepEqual(untracked, []);

  const calls = [];
  const { app, kill } = killableDryRunApp(FILES_SNAPSHOT, calls);
  const launch = trackForRun(app, userDataDir, directory);
  const record = await captureDaemonDryRunEvidence(app);
  assert.equal(record.launchId, launch.launchId);
  assert.equal(record.evidenceError, null);
  // For example `process.kill(mainPid, 'SIGKILL')` or `app.quit()`.
  await kill();
  await app.close();
  assert.deepEqual(calls, ['evaluate', 'kill', 'close']);

  // A capture never throws, so it is safe in cleanup; the end that follows
  // reports the fallback, once.
  const fellBackCalls = [];
  const fellBack = killableDryRunApp(FELL_BACK, fellBackCalls);
  trackForRun(fellBack.app, userDataDir, directory);
  const fellBackRecord = await captureDaemonDryRunEvidence(fellBack.app);
  assert.deepEqual(fellBackRecord.fallbacks, {
    'counters.route.files.roots.daemon.fallback.unavailable': 1,
  });
  await fellBack.kill();
  await assert.rejects(
    closeCanopy(fellBack.app, userDataDir, {
      daemonDryRun: { env: {} },
      removeDataDir: async () => {},
    }),
    /Files dry run: the daemon route fell back/,
  );
  await fellBack.app.close();
  assert.deepEqual(fellBackCalls, ['evaluate', 'kill', 'close', 'close']);
});

test('captureDaemonDryRunEvidence leaves an unwritable record to the close that follows', async (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const calls = [];
  const { app, kill } = killableDryRunApp(FILES_SNAPSHOT, calls);
  trackForRun(app, userDataDir, directory);
  // A file where the evidence directory belongs makes the record's mkdir fail.
  rmSync(directory, { recursive: true });
  writeFileSync(directory, 'not a directory');
  // Specs call it outside any try, so a rejection would skip their teardown.
  assert.equal(await captureDaemonDryRunEvidence(app), null);
  await kill();
  const removed = [];
  await assert.rejects(
    closeCanopy(app, userDataDir, {
      daemonDryRun: { env: {} },
      removeDataDir: async (dirPath) => removed.push(dirPath),
    }),
    (error) => ['EEXIST', 'ENOTDIR'].includes(error.code),
  );
  assert.deepEqual(calls, ['evaluate', 'kill', 'close']);
  assert.deepEqual(removed, [userDataDir, `${userDataDir}-secure`]);
});

test('trackDaemonDryRunLaunch is inert outside the dry run', (t) => {
  const { userDataDir, directory } = dryRunRoots(t);
  const close = async () => {};
  const electronApp = { close };
  assert.equal(
    trackDaemonDryRunLaunch(electronApp, userDataDir, {
      directory,
      env: {},
      testInfo: null,
    }),
    null,
  );
  assert.equal(electronApp.close, close);
  assert.equal(existsSync(directory), false);
});
