import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import {
  assertInsideRoot,
  assertMissingCheckoutsPresent,
  assertRegistryTargets,
  attributeRegistryWindow,
  buildCodeReviewRegistryFixture,
  codeReviewRegistryPath,
  prepareCodeReviewRegistry,
  readRegistry,
  registryEventsOutsideWindows,
  removeMissingCheckout,
  serializeRegistry,
  startMainPingRenderer,
  stopMainPingRenderer,
  traceTimings,
  waitForProbedHandlerMain,
  withoutKeys,
} from './code-review-registry-scenario.mjs';
import { OPT_IN_SCENARIO_NAMES, parsePerformanceArgs } from './profiles.mjs';
import { assertReleaseLikeScenarioSupported } from './scenarios.mjs';

test('the registry fixture separates owners by project and worktree pair', () => {
  const fixture = buildCodeReviewRegistryFixture({
    workspaceId: 'demo-app',
    keepWorktreeId: 'demo-main',
    removedWorktreeIds: ['crr-delete-1', 'crr-missing-1'],
    matchingRows: 2,
    unrelatedRows: 6,
  });
  const { targets } = fixture.file;
  assert.equal(Object.keys(targets).length, 6 + 2 * 2);
  assert.deepEqual(fixture.matchingKeys, {
    'crr-delete-1': [
      'demo-app--crr-delete-1',
      'demo-app--crr-delete-1--legacy-1',
    ],
    'crr-missing-1': [
      'demo-app--crr-missing-1',
      'demo-app--crr-missing-1--legacy-1',
    ],
  });
  assert.equal(fixture.keepKey, 'demo-app--demo-main');
  assert.deepEqual(targets['perf-other-project--crr-delete-1'], {
    projectId: 'perf-other-project',
    worktreeId: 'crr-delete-1',
  });
  for (const keys of Object.values(fixture.matchingKeys))
    for (const key of keys) assert.ok(!fixture.unrelatedKeys.includes(key));
  const remaining = withoutKeys(targets, fixture.matchingKeys['crr-delete-1']);
  assert.equal(Object.keys(remaining).length, 8);
  assert.throws(() =>
    buildCodeReviewRegistryFixture({
      workspaceId: 'demo-app',
      keepWorktreeId: 'demo-main',
      removedWorktreeIds: [],
      matchingRows: 0,
      unrelatedRows: 1,
    }),
  );
});

test('registry row checks name missing, extra and changed keys', () => {
  const expected = { a: { projectId: 'p', worktreeId: 'a' } };
  assert.doesNotThrow(() =>
    assertRegistryTargets({ ...expected }, expected, 'x'),
  );
  assert.throws(
    () =>
      assertRegistryTargets(
        { a: { projectId: 'p', worktreeId: 'b' }, z: expected.a },
        expected,
        'After purge',
      ),
    /After purge: registry rows differ \(missing 0: ; extra 1: z; changed 1: a\)/,
  );
});

function event(op, kind, startedAt, ms) {
  return { op, kind, startedAt, endedAt: startedAt + ms, ms };
}

test('attribution claims only the registry sequence in a shared directory', () => {
  const events = [
    // The cleanup's list read.
    event('read', 'registry', 100, 0.2),
    // Another review-chat writer syncs the same directory.
    event('mkdir', 'dir', 101, 0.1),
    event('dir-open', 'dir', 102, 0.1),
    event('dir-fsync', 'dir', 102.2, 4),
    event('dir-close', 'dir', 106.3, 0.1),
    // The durable removal.
    event('read', 'registry', 110, 0.3),
    event('mkdir', 'dir', 110.5, 0.1),
    event('temp-open', 'registry-temp', 110.7, 0.2),
    event('temp-write', 'registry-temp', 111, 0.3),
    event('file-fsync', 'registry-temp', 111.4, 5),
    event('temp-close', 'registry-temp', 116.5, 0.1),
    event('rename', 'registry', 116.7, 0.2),
    event('dir-open', 'dir', 117, 0.1),
    event('dir-fsync', 'dir', 117.2, 6),
    event('dir-close', 'dir', 123.3, 0.1),
    // Outside the handler window.
    event('read', 'registry', 300, 1),
  ];
  const result = attributeRegistryWindow(events, {
    startedAt: 90,
    endedAt: 150,
  });
  assert.equal(result.handlerMs, 60);
  assert.equal(result.reads, 2);
  assert.equal(result.mutations, 1);
  assert.equal(result.orphanAccesses, 0);
  assert.equal(result.fileFsyncMs, 5);
  assert.equal(result.dirFsyncMs, 6);
  // Everything only a durable write does: file fsync and directory sync.
  assert.equal(result.dirSyncTotalMs, 6.2);
  assert.equal(result.durableFlushMs, 11.2);
  assert.equal(result.mkdirMs, 0.1);
  assert.equal(result.unattributedDirEvents, 4);
  assert.equal(result.unattributedDirMs, 4.3);
  assert.equal(result.ambiguousDirEvents, 0);
  // List read 0.2 plus the removal from 110 to 123.4.
  assert.equal(result.registrySpanMs, 13.6);
  assert.equal(result.nonRegistryHandlerMs, 46.4);
  assert.ok(result.registryIoMs <= result.registrySpanMs);
  assert.ok(result.registryNonIoMs >= 0);
  // The disjoint parts add up to the handler time.
  const parts =
    result.nonRegistryHandlerMs +
    result.registryNonIoMs +
    result.readMs +
    result.mkdirMs +
    result.writeInstallMs +
    result.durableFlushMs;
  assert.ok(Math.abs(parts - result.handlerMs) < 0.01, String(parts));
});

test('a foreign directory event inside a registry flush makes it ambiguous', () => {
  const result = attributeRegistryWindow(
    [
      event('read', 'registry', 10, 0.2),
      event('temp-open', 'registry-temp', 10.5, 0.1),
      event('file-fsync', 'registry-temp', 10.7, 3),
      event('temp-close', 'registry-temp', 13.8, 0.1),
      event('rename', 'registry', 14, 0.2),
      // A foreign writer opens the directory before the registry does.
      event('dir-open', 'dir', 14.25, 0.05),
      event('dir-open', 'dir', 14.3, 0.1),
      event('dir-fsync', 'dir', 14.5, 4),
      event('dir-close', 'dir', 18.6, 0.1),
    ],
    { startedAt: 0, endedAt: 30 },
  );
  assert.equal(result.mutations, 1);
  assert.equal(result.ambiguousDirEvents, 1);
});

test('registry events outside every handler window are counted', () => {
  const outside = registryEventsOutsideWindows(
    [
      event('read', 'registry', 5, 1),
      event('read', 'registry', 50, 1),
      event('rename', 'registry', 52, 1),
      event('read-sync', 'registry', 53, 1),
      event('dir-open', 'dir', 54, 1),
      event('plain-write', 'registry', 15, 1),
    ],
    [
      { startedAt: 0, endedAt: 20 },
      { startedAt: 100, endedAt: null },
    ],
  );
  assert.deepEqual(outside, { reads: 1, writes: 1 });
});

test('a plain write is a mutation with no durable flush', () => {
  const result = attributeRegistryWindow(
    [
      event('read', 'registry', 10, 0.2),
      event('mkdir', 'dir', 10.3, 0.1),
      event('plain-write', 'registry', 10.5, 0.4),
    ],
    { startedAt: 0, endedAt: 20 },
  );
  assert.equal(result.mutations, 1);
  assert.equal(result.durableFlushMs, 0);
  assert.equal(result.plainWriteMs, 0.4);
  assert.equal(result.mkdirMs, 0.1);
  assert.equal(result.writeInstallMs, 0.4);
  assert.equal(result.registrySpanMs, 0.9);
});

test('registry writes without a read are reported as orphans', () => {
  const result = attributeRegistryWindow(
    [event('rename', 'registry', 5, 0.1)],
    { startedAt: 0, endedAt: 10 },
  );
  assert.equal(result.orphanAccesses, 1);
});

test('trace timings are per-launch medians named by route', () => {
  const timings = traceTimings({
    purge: [
      { handlerMs: 30, durableFlushMs: 10, fileFsyncMs: 4 },
      { handlerMs: 50, durableFlushMs: 20, fileFsyncMs: 8 },
      { handlerMs: 40, durableFlushMs: 12, fileFsyncMs: 6 },
    ],
    register: [],
  });
  assert.equal(timings.purge_handler_ms, 40);
  assert.equal(timings.purge_durable_flush_ms, 12);
  assert.equal(timings.purge_file_fsync_ms, 6);
  assert.equal(timings.register_handler_ms, undefined);
});

test('paths that resolve outside the scenario root are refused', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crr-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'crr-outside-'));
  try {
    mkdirSync(path.join(root, 'inner'));
    symlinkSync(outside, path.join(root, 'link'));
    assert.equal(
      assertInsideRoot(root, path.join(root, 'inner', 'file'), 'x'),
      path.join(realpathSync(root), 'inner', 'file'),
    );
    assert.throws(() => assertInsideRoot(root, root, 'Root'), /outside/);
    assert.throws(
      () => assertInsideRoot(root, path.join(root, '..', 'escape'), 'Parent'),
      /outside/,
    );
    assert.throws(
      () => assertInsideRoot(root, path.join(root, 'link', 'file'), 'Link'),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('both registry scenarios are opt-in, scoped and release-like capable', () => {
  for (const scenario of [
    'code-review-registry-cleanup',
    'code-review-registry-cleanup-trace',
  ]) {
    assert.ok(OPT_IN_SCENARIO_NAMES.includes(scenario));
    const { config } = parsePerformanceArgs([
      '--profile',
      'baseline',
      '--scenarios',
      scenario,
    ]);
    assert.equal(config.codeReviewRegistryDeleteCycles, 3);
    assert.equal(config.codeReviewRegistryMissingDeletes, 3);
    assert.equal(config.codeReviewRegistryMatchingRows, 2);
    assert.equal(config.codeReviewRegistryUnrelatedRows, 100);
    assert.equal(config.codeReviewRegistryRegisterIterations, 20);
    assert.doesNotThrow(() =>
      assertReleaseLikeScenarioSupported(scenario, true),
    );
  }
  const other = parsePerformanceArgs(['--scenarios', 'loaded-ui']).config;
  assert.equal(other.codeReviewRegistryDeleteCycles, undefined);
});

test('prepare seeds removable worktrees and the registry inside its root', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'crr-prepare-'));
  try {
    const fixture = prepareCodeReviewRegistry(userDataDir, {
      codeReviewRegistryDeleteCycles: 2,
      codeReviewRegistryMissingDeletes: 1,
      codeReviewRegistryMatchingRows: 2,
      codeReviewRegistryUnrelatedRows: 5,
      codeReviewRegistryRegisterIterations: 1,
    });
    assert.deepEqual(fixture.deleteIds, ['crr-delete-1', 'crr-delete-2']);
    assert.deepEqual(fixture.missingIds, ['crr-missing-1']);
    assert.equal(fixture.registryPath, codeReviewRegistryPath(userDataDir));
    const registry = readRegistry(fixture.registryPath);
    assert.equal(registry.text, serializeRegistry(fixture.registry.file));
    assert.equal(registry.text, fixture.seededRegistryText);
    assert.equal(Object.keys(registry.file.targets).length, 5 + 3 * 2);
    const ids = JSON.parse(
      readFileSync(fixture.worktreesPath, 'utf8'),
    ).worktrees.map((worktree) => worktree.id);
    assert.deepEqual(ids, [
      fixture.keepWorktreeId,
      'crr-delete-1',
      'crr-delete-2',
      'crr-missing-1',
    ]);
    const worktrees = path.join(fixture.workspaceRoot, 'worktrees');
    assert.ok(existsSync(path.join(worktrees, 'crr-delete-1', '.git')));
    assert.ok(existsSync(path.join(worktrees, 'crr-delete-2', '.git')));
    // Boot recovery archives a row whose checkout is gone at launch.
    assert.ok(existsSync(path.join(worktrees, 'crr-missing-1', '.git')));
    assert.equal(fixture.worktreesDir, worktrees);
    const branches = execFileSync(
      'git',
      ['branch', '--list', 'perf/crr-*', '--format=%(refname:short)'],
      { cwd: path.join(worktrees, 'crr-delete-1'), encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(branches, [
      'perf/crr-delete-1',
      'perf/crr-delete-2',
      'perf/crr-missing-1',
    ]);
    for (const key of [
      fixture.registry.keepKey,
      ...Object.values(fixture.registry.matchingKeys).flat(),
    ])
      assert.ok(existsSync(path.join(fixture.registryDir, `${key}.json`)), key);
    const root = realpathSync(userDataDir);
    for (const candidate of [
      fixture.workspaceRoot,
      realpathSync(fixture.registryDir),
      realpathSync(fixture.worktreesPath),
      realpathSync(fixture.registryPath),
    ])
      assert.ok(candidate.startsWith(`${root}${path.sep}`), candidate);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a missing-route checkout is removed only during the run, once', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'crr-missing-'));
  try {
    const fixture = prepareCodeReviewRegistry(userDataDir, {
      codeReviewRegistryDeleteCycles: 1,
      codeReviewRegistryMissingDeletes: 2,
      codeReviewRegistryMatchingRows: 1,
      codeReviewRegistryUnrelatedRows: 3,
      codeReviewRegistryRegisterIterations: 1,
    });
    const checkout = (id) => path.join(fixture.worktreesDir, id);
    assert.doesNotThrow(() => assertMissingCheckoutsPresent(fixture));
    assert.throws(
      () => removeMissingCheckout(fixture, 'crr-delete-1'),
      /crr-delete-1 is not a missing-checkout worktree/,
    );
    assert.throws(
      () => removeMissingCheckout(fixture, fixture.keepWorktreeId),
      /is not a missing-checkout worktree/,
    );
    removeMissingCheckout(fixture, 'crr-missing-1');
    assert.ok(!existsSync(checkout('crr-missing-1')));
    assert.ok(existsSync(path.join(checkout('crr-missing-2'), '.git')));
    assert.ok(existsSync(path.join(checkout('crr-delete-1'), '.git')));
    assert.throws(
      () => removeMissingCheckout(fixture, 'crr-missing-1'),
      /crr-missing-1 checkout was removed before its own route/,
    );
    // A checkout gone before the run would have been archived at boot.
    assert.throws(
      () => assertMissingCheckoutsPresent(fixture),
      /crr-missing-1 checkout\(s\) were gone at launch/,
    );
    // The registry and worktree records are untouched by the removal.
    assert.equal(
      readRegistry(fixture.registryPath).text,
      fixture.seededRegistryText,
    );
    assert.ok(
      JSON.parse(readFileSync(fixture.worktreesPath, 'utf8'))
        .worktrees.map((worktree) => worktree.id)
        .includes('crr-missing-1'),
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a missing-route checkout that resolves outside its directory is refused', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'crr-escape-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'crr-escape-out-'));
  try {
    const fixture = prepareCodeReviewRegistry(userDataDir, {
      codeReviewRegistryDeleteCycles: 1,
      codeReviewRegistryMissingDeletes: 1,
      codeReviewRegistryMatchingRows: 1,
      codeReviewRegistryUnrelatedRows: 3,
      codeReviewRegistryRegisterIterations: 1,
    });
    assert.throws(
      () =>
        removeMissingCheckout(
          { ...fixture, worktreesDir: outside },
          'crr-missing-1',
        ),
      /outside/,
    );
    assert.ok(
      existsSync(path.join(fixture.worktreesDir, 'crr-missing-1', '.git')),
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the handler wait wakes on completion and refuses a repeated call', async () => {
  const probeGlobal = '__crrWaitTest';
  const probe = { ipc: [], events: [], missing: [], waiters: new Set() };
  globalThis[probeGlobal] = probe;
  try {
    const finish = (entry) => {
      entry.endedAt = 2;
      for (const waiter of [...probe.waiters]) waiter();
    };
    const first = {
      channel: 'c',
      target: 'a',
      startedAt: 1,
      endedAt: null,
      ok: true,
    };
    probe.ipc.push(first);
    const waited = waitForProbedHandlerMain(null, {
      probeGlobal,
      channel: 'c',
      target: 'a',
      timeoutMs: 5_000,
    });
    assert.equal(probe.waiters.size, 1);
    finish(first);
    assert.deepEqual(await waited, { ...first });
    assert.equal(probe.waiters.size, 0);

    probe.ipc.push({ channel: 'c', target: 'b', startedAt: 3, endedAt: null });
    const repeated = waitForProbedHandlerMain(null, {
      probeGlobal,
      channel: 'c',
      target: 'b',
      timeoutMs: 5_000,
    });
    const second = { channel: 'c', target: 'b', startedAt: 4, endedAt: null };
    probe.ipc.push(second);
    finish(second);
    await assert.rejects(repeated, /ran 2 times for b/);

    await assert.rejects(
      waitForProbedHandlerMain(null, {
        probeGlobal,
        channel: 'c',
        target: 'never',
        timeoutMs: 10,
      }),
      /did not finish in 10 ms/,
    );
    assert.equal(probe.waiters.size, 0);
  } finally {
    delete globalThis[probeGlobal];
  }
});

const PING_TEST_GLOBAL = '__crrPingTest';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A renderer stand-in whose preferences IPC round trips the test settles by
 * hand. Helpers run as page.evaluate runs them: from their source text in a
 * separate global, with a JSON-serialized result.
 */
function pingRenderer() {
  const calls = [];
  let onCall = null;
  const api = {
    loadPreferences() {
      const call = Promise.withResolvers();
      calls.push(call);
      onCall?.();
      return call.promise;
    },
  };
  const context = vm.createContext({
    api,
    performance,
    setTimeout,
    clearTimeout,
  });
  return {
    api,
    calls,
    started: (count) =>
      calls.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => {
            onCall = () => calls.length >= count && resolve();
          }),
    ping: () => vm.runInContext(`globalThis.${PING_TEST_GLOBAL}`, context),
    async evaluate(helper, arg) {
      const run = vm.runInContext(`(${String(helper)})`, context);
      return JSON.parse(JSON.stringify((await run(arg)) ?? null));
    },
  };
}

const startPing = (renderer) =>
  renderer.evaluate(startMainPingRenderer, PING_TEST_GLOBAL);
const stopPing = (renderer, timeoutMs = 5_000) =>
  renderer.evaluate(stopMainPingRenderer, {
    pingGlobal: PING_TEST_GLOBAL,
    timeoutMs,
  });

test('stopping the ping keeps the slow round trip still in flight', async () => {
  const renderer = pingRenderer();
  await startPing(renderer);
  renderer.calls[0].resolve();
  await renderer.started(2);
  const tailStartedAt = performance.timeOrigin + performance.now();
  const stopped = stopPing(renderer);
  await delay(30);
  renderer.calls[1].resolve();
  const { samples, errors } = await stopped;
  assert.deepEqual(errors, []);
  assert.equal(samples.length, 2);
  assert.ok(samples[1].ms >= 25, `tail ${samples[1].ms} ms`);
  assert.ok(samples[1].startedAt <= tailStartedAt);
  // No round trip starts once stopped.
  await delay(40);
  assert.equal(renderer.calls.length, 2);
});

test('a round trip that fails after the stop is reported', async () => {
  const renderer = pingRenderer();
  await startPing(renderer);
  const stopped = stopPing(renderer);
  renderer.calls[0].reject(new Error('preferences refused'));
  assert.deepEqual(await stopped, {
    samples: [],
    errors: ['preferences refused'],
  });

  renderer.api.loadPreferences = () => {
    throw new Error('no preload');
  };
  await startPing(renderer);
  assert.deepEqual(await stopPing(renderer), {
    samples: [],
    errors: ['no preload'],
  });
});

test('a stop between round trips returns at once and starts no more', async () => {
  const renderer = pingRenderer();
  await startPing(renderer);
  renderer.calls[0].resolve();
  // Past the settled round trip, inside the 16 ms gap.
  await delay(0);
  assert.equal(renderer.ping().active, null);
  const { samples } = await stopPing(renderer);
  assert.equal(samples.length, 1);
  await delay(40);
  assert.equal(renderer.calls.length, 1);
});

test('a round trip that never settles fails the stop within its bound', async () => {
  const renderer = pingRenderer();
  await startPing(renderer);
  await assert.rejects(
    stopPing(renderer, 10),
    /A main IPC ping did not settle in 10 ms/,
  );
  renderer.calls[0].resolve();
});

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * Runs the main-side probe in a child Node process over real files: the
 * shared atomic writer is bundled to CommonJS, as the production main bundle
 * calls it (live `fs/promises` property reads), and every write and fsync
 * runs for real. The child prints its observations as JSON.
 */
function runProbeChild(root) {
  const bundle = path.join(root, 'atomic-file.cjs');
  buildSync({
    entryPoints: [
      path.join(
        REPO_ROOT,
        'packages/desktop-shared/src/node/lib/atomic-file.ts',
      ),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
  });
  const child = path.join(root, 'probe-child.mjs');
  writeFileSync(
    child,
    `
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const scenario = await import(${JSON.stringify(
      new URL('./code-review-registry-scenario.mjs', import.meta.url).href,
    )});
const fsp = process.getBuiltinModule('node:fs/promises');
const { writeFileAtomically } = createRequire(import.meta.url)(${JSON.stringify(bundle)});
const dir = path.join(${JSON.stringify(root)}, 'data', 'app-workspaces', 'code-review-chat', 'chats');
const registry = path.join(dir, 'registry.json');
mkdirSync(dir, { recursive: true });
writeFileSync(registry, JSON.stringify({ version: 1, targets: { a: {}, b: {} } }));
const mutate = async (update) => {
  const next = update(JSON.parse(await fsp.readFile(registry, 'utf8')));
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomically(registry, JSON.stringify(next), { encoding: 'utf8', durable: true });
};
const handlers = new Map([
  ['code-review:register', async (_event, request) => {
    await mutate((file) => ({ ...file, targets: { ...file.targets, [request.worktreeId]: {} } }));
    return 'registered';
  }],
  ['archived-containers:delete', async () => {
    await fsp.readFile(registry, 'utf8');
    // A foreign durable writer in the same directory.
    await writeFileAtomically(path.join(dir, 'foreign.json'), '{}', { durable: true });
    await mutate((file) => { delete file.targets.a; return file; });
  }],
  ['worktree:archive', async () => { throw new Error('refused'); }],
]);
const installed = scenario.codeReviewRegistryProbeMain(
  { ipcMain: { _invokeHandlers: handlers } },
  scenario.registryProbeOptions(true),
);
const probe = globalThis.__canopyCodeReviewRegistryProbe;
const registered = await handlers.get('code-review:register')(null, { worktreeId: 'c' });
await handlers.get('archived-containers:delete')(null, { containerId: 'a' });
let rejected = null;
try { await handlers.get('worktree:archive')(null, { worktreeId: 'w' }); }
catch (error) { rejected = error.message; }
// A write no probed handler made.
await mutate((file) => file);
const window = (channel) => probe.ipc.find((entry) => entry.channel === channel);
console.log(JSON.stringify({
  installed,
  registered,
  rejected,
  archiveEntry: window('worktree:archive'),
  register: scenario.attributeRegistryWindow(probe.events, window('code-review:register')),
  purge: scenario.attributeRegistryWindow(probe.events, window('archived-containers:delete')),
  outside: scenario.registryEventsOutsideWindows(probe.events, probe.ipc),
}));
`,
  );
  return JSON.parse(
    execFileSync(process.execPath, [child], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }),
  );
}

test('the main probe passes calls through and traces real durable writes', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crr-probe-')));
  try {
    const result = runProbeChild(root);
    assert.deepEqual(result.installed, { fsTrace: true, missing: [] });
    assert.equal(result.registered, 'registered');
    assert.equal(result.rejected, 'refused');
    assert.equal(result.archiveEntry.ok, false);
    assert.equal(result.archiveEntry.error, 'refused');
    assert.equal(result.archiveEntry.target, 'w');
    for (const name of ['register', 'purge']) {
      const trace = result[name];
      assert.equal(trace.mutations, 1, name);
      assert.equal(trace.orphanAccesses, 0, name);
      assert.equal(trace.errors, 0, name);
      assert.equal(trace.ambiguousDirEvents, 0, name);
      assert.ok(trace.fileFsyncMs > 0, `${name} file fsync`);
      assert.ok(trace.renameMs > 0, `${name} rename`);
      assert.equal(trace.plainWriteMs, 0, name);
      if (process.platform !== 'win32')
        assert.ok(trace.dirFsyncMs > 0, `${name} directory fsync`);
    }
    assert.equal(result.register.reads, 1);
    assert.equal(result.purge.reads, 2);
    // The foreign writer's directory open, fsync and close stay its own.
    assert.equal(
      result.purge.unattributedDirEvents,
      process.platform === 'win32' ? 0 : 3,
    );
    assert.deepEqual(result.outside, { reads: 1, writes: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
