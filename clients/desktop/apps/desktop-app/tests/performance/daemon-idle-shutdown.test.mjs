import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  EVIDENCE_PHASES,
  LIFECYCLE_DEFAULTS,
  POPULATION_DEFAULTS,
  REQUIREMENTS,
  SHUTDOWN_INPUTS,
  classifyIdentity,
  cleanupTrial,
  countSurvivors,
  daemonGroup,
  listProcessTable,
  measureIdleWindow,
  observePublication,
  parseProcessTable,
  publishIdleShutdown,
  resolvePopulation,
  runIdleShutdownPopulation,
  runnerExitCode,
  summarizeLaunches,
  treeDescendants,
  zombieDescendants,
} from './daemon-idle-shutdown.mjs';
import { createNativeResourceReader } from './process-resources.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const darwinOnly = { skip: process.platform !== 'darwin' };

async function poll(probe) {
  for (let i = 0; i < 200 && !(await probe()); i++) await delay(10);
}

/** For a process the code under test should already have killed. */
function killQuietly(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

test('requirement labels are document 05 bullets under the census keys', async () => {
  const read = (file) => readFile(path.join(repoRoot, file), 'utf8');
  const doc05 = await read(
    'docs/planning/2026-07-31-desktop-core-daemon/05-verification-and-rollout.md',
  );
  const section = doc05
    .split('## Performance verification')[1]
    .split('\n## ')[0];
  const census = await read(
    'scripts/core-daemon-census/performance-baseline.mjs',
  );
  for (const [key, text] of Object.entries(REQUIREMENTS)) {
    assert.match(section, new RegExp(`^- ${text}`, 'm'), key);
    assert.ok(census.includes(`${key}: '${text}'`), key);
  }
});

test('populations, lifecycle defaults and planned cycles are preserved', () => {
  assert.equal(resolvePopulation('standalone').status, 'collected');
  for (const arm of ['product-on', 'flag-off']) {
    const population = resolvePopulation(arm);
    assert.equal(population.status, 'unavailable');
    assert.match(population.reason, /CAN-4603/);
  }
  assert.throws(() => resolvePopulation('flag-on'), /Unknown population arm/);
  assert.deepEqual(
    [LIFECYCLE_DEFAULTS.reconnectGraceMs, LIFECYCLE_DEFAULTS.idleGraceMs],
    [10_000, 30_000],
  );
  assert.deepEqual(
    [POPULATION_DEFAULTS.cycles, POPULATION_DEFAULTS.idleWindowMs],
    [20, 60_000],
  );
});

test('process table rows parse lstart as UTC, keep zombies and reject malformed output', () => {
  const rows = parseProcessTable(
    [
      '  84310 83872 84294 S    Fri Oct 23 12:15:36 2026    ',
      '  84312 83872 84310 Z    Fri Oct 23 12:15:36 2026',
      '',
    ].join('\n'),
  );
  assert.equal(
    rows.get(84310).startSec,
    Date.UTC(2026, 9, 23, 12, 15, 36) / 1000,
  );
  assert.deepEqual(
    [...rows.values()].map(({ pid, zombie }) => [pid, zombie]),
    [
      [84310, false],
      [84312, true],
    ],
  );
  assert.deepEqual(
    zombieDescendants(rows, 84310).map(({ pid }) => pid),
    [84312],
  );
  assert.deepEqual(zombieDescendants(rows, 1), []);
  for (const bad of [
    '84310 S Fri',
    '1 1 1 S not a date',
    '1 1 1 S Fri Oct 23 12:15:36 2026\n1 1 1 S Fri Oct 23 12:15:36 2026',
  ])
    assert.throws(() => parseProcessTable(bad), /Invalid ps/);
});

const SEC = 1792746062;
const START = `${SEC}.123456`;

test('post-exit identities come from the process table, since native reads miss zombies', () => {
  const table = new Map(
    [
      [10, false, SEC],
      [11, true, SEC],
      [12, false, SEC + 5],
    ].map(([pid, zombie, startSec]) => [pid, { pid, zombie, startSec }]),
  );
  const status = (pid) => classifyIdentity({ pid, startSec: SEC }, table);
  // 12 is a reused PID: it started in another second.
  assert.deepEqual([10, 11, 12, 13].map(status), [
    'live',
    'zombie',
    'exited',
    'exited',
  ]);
  assert.equal(classifyIdentity({ pid: 10, startSec: SEC }, null), 'unknown');
});

test('survivor counts include late group members and are unknown without a table', () => {
  const descendants = [
    { pid: 10, status: 'exited' },
    { pid: 11, status: 'live' },
    { pid: 12, status: 'zombie' },
  ];
  const members = [
    { pid: 11, zombie: false },
    { pid: 20, zombie: false },
    { pid: 21, zombie: true },
  ];
  assert.deepEqual(countSurvivors(descendants, members), {
    orphanCount: 2,
    unreapedCount: 2,
    lateGroupMembers: members.slice(1),
  });
  assert.equal(countSurvivors(descendants, []).orphanCount, 1);
  // A retained identity exited and a live group member reused its PID.
  const reused = countSurvivors(
    [{ pid: 30, startSec: SEC, status: 'exited' }],
    [{ pid: 30, zombie: false, startSec: SEC + 5 }],
  );
  assert.deepEqual(
    [reused.orphanCount, reused.lateGroupMembers.length],
    [1, 1],
  );
  for (const reason of ['process_table_unavailable', 'process_group_recycled'])
    assert.deepEqual(countSurvivors(descendants, reason), {
      orphanCount: reason,
      unreapedCount: reason,
      lateGroupMembers: [],
    });
});

test('a reaped daemon whose PID is listed again has a recycled, unattributable group', () => {
  const table = new Map(
    [
      [10, 10],
      [20, 10],
    ].map(([pid, pgid]) => [pid, { pid, pgid, zombie: false, startSec: SEC }]),
  );
  assert.equal(daemonGroup(table, 10, true), 'process_group_recycled');
  assert.deepEqual(
    daemonGroup(table, 10, false).map(({ pid }) => pid),
    [10, 20],
  );
  table.delete(10);
  assert.deepEqual(
    daemonGroup(table, 10, true).map(({ pid }) => pid),
    [20],
  );
  assert.equal(daemonGroup(null, 10, true), 'process_table_unavailable');
});

test(
  'cleanup never signals a recycled group that leads with the reaped daemon PID',
  darwinOnly,
  async () => {
    const stranger = spawn('sleep', ['30'], {
      detached: true,
      stdio: 'ignore',
    });
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'idle-recycled-'));
    try {
      await poll(async () => (await listProcessTable()).has(stranger.pid));
      const record = await cleanupTrial(
        { pid: stranger.pid, exitCode: 0, signalCode: null },
        { identities: [] },
        { native: null, dataRoot, listTable: listProcessTable },
      );
      assert.equal(record.groupKilled, false);
      assert.deepEqual(record.killed, []);
      assert.equal(record.dataRootRemoved, true);
      assert.equal(stranger.exitCode ?? stranger.signalCode, null);
      process.kill(stranger.pid, 0);
    } finally {
      stranger.kill('SIGKILL');
    }
  },
);

const row = (pid, fields = {}) => ({
  pid,
  ppid: 1,
  startId: START,
  state: 'live',
  residentBytes: '100',
  physicalFootprintBytes: '50',
  userCpuNs: '1000',
  systemCpuNs: '500',
  packageIdleWakeups: '10',
  interruptWakeups: '5',
  quantities: {
    openFileDescriptors: { status: 'ok', value: '7' },
    machIpcInUseNameEntries: { status: 'ok', value: '30' },
  },
  ...fields,
});
const snapshot = (processes, at, truncated = false) => ({
  processes,
  errors: [],
  truncated,
  monotonicStartMs: at,
  monotonicEndMs: at + 4,
});
const net = (received, sent = { status: 'ok', value: '40' }) => ({
  processes: [
    {
      pid: 10,
      startId: START,
      quantities: {
        nettopTcpUdpReceivedBytes: received,
        nettopTcpUdpSentBytes: sent,
      },
    },
  ],
});
const ok = (value) => ({ status: 'ok', value });
const measure = (raw = {}, zombies = []) =>
  measureIdleWindow(
    10,
    {
      start: snapshot([row(10)], 100),
      end: snapshot(
        [
          row(10, {
            userCpuNs: '4000',
            systemCpuNs: '600',
            packageIdleWakeups: '25',
          }),
        ],
        60_102,
      ),
      netStart: net(ok('100')),
      netEnd: net(ok('160')),
      ...raw,
    },
    zombies,
    60_000,
  );

test('an idle window publishes deltas and end levels, with diagnostics kept apart', () => {
  const measured = measure();
  assert.equal(measured.membership, 'stable');
  assert.deepEqual(measured.metrics, {
    idleCpuNs: 3100,
    idlePackageIdleWakeups: 15,
    idleInterruptWakeups: 0,
    idleNettopTcpUdpReceivedBytes: 60,
    idleNettopTcpUdpSentBytes: 0,
    openFileDescriptors: 7,
    machIpcInUseNameEntries: 30,
  });
  assert.deepEqual(measured.diagnostics, {
    residentBytes: 100,
    physicalFootprintBytes: 50,
  });
  assert.deepEqual(measured.timing, {
    nominalMs: 60_000,
    measuredMs: 60_002,
    cadenceErrorMs: 2,
    skewBoundMs: 4,
  });
});

test('incomplete window evidence leaves every total unknown, never zero', () => {
  const child = row(11, { ppid: 10 });
  for (const [raw, zombies, membership] of [
    [{ start: snapshot([row(10), child], 100) }, [], 'changed'],
    [
      { start: snapshot([], 100), end: snapshot([], 200) },
      [],
      'root_missing_or_zombie',
    ],
    [{}, [{ pid: 11 }], 'root_missing_or_zombie'],
    [{}, null, 'process_table_unavailable'],
    [{ end: snapshot([row(10)], 200, true) }, [], 'truncated'],
    // A tree member whose sample failed revalidation has no row of its own.
    [
      {
        end: {
          ...snapshot([row(10)], 200),
          errors: [{ pid: 11, startId: START, stage: 'revalidate', errno: 3 }],
        },
      },
      [],
      'member_unreadable',
    ],
  ]) {
    const measured = measure(raw, zombies);
    assert.equal(measured.membership, membership);
    for (const value of [
      ...Object.values(measured.metrics),
      ...Object.values(measured.diagnostics),
    ])
      assert.equal(value, `membership:${membership}`);
  }
});

test('an unknown total names its first cause, such as an absent nettop row or task_for_pid', () => {
  const absent = { status: 'unavailable', reason: 'pid_absent', value: null };
  const machError = {
    status: 'error',
    value: null,
    domain: 'mach',
    code: 5,
    stage: 'task_for_pid',
  };
  const end = snapshot(
    [
      row(10, {
        quantities: {
          openFileDescriptors: ok('7'),
          machIpcInUseNameEntries: machError,
        },
      }),
    ],
    60_102,
  );
  const measured = measure({ netEnd: net(absent, absent), end });
  assert.equal(measured.metrics.idleCpuNs, 0);
  assert.equal(
    measured.metrics.idleNettopTcpUdpReceivedBytes,
    'unavailable:pid_absent',
  );
  assert.equal(
    measured.metrics.machIpcInUseNameEntries,
    'error:task_for_pid:5',
  );
  assert.equal(
    measure({ netEnd: net(ok('90')) }).metrics.idleNettopTcpUdpReceivedBytes,
    'negative_delta',
  );
  assert.equal(
    measure({ netEnd: null }).metrics.idleNettopTcpUdpSentBytes,
    'network_unavailable',
  );
  const noCounter = snapshot([row(10, { interruptWakeups: null })], 60_102);
  assert.equal(
    measure({ end: noCounter }).metrics.idleInterruptWakeups,
    'counter_missing',
  );
});

test('launch summaries count unknowns by cause', () => {
  assert.deepEqual(summarizeLaunches([3, 'censored', 1, 2]), {
    launches: 4,
    observed: 3,
    unknown: 1,
    unknownReasons: { censored: 1 },
    p50: 2,
    p95: 2.9,
    max: 3,
  });
  assert.equal(summarizeLaunches(['censored']).max, null);
});

test('publication observations retain counts, never names or tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'idle-publication-'));
  try {
    const runtime = path.join(root, 'runtime');
    assert.equal((await observePublication(runtime)).residue, false);
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'core.json'), '{}');
    await writeFile(path.join(runtime, 'abc.token'), 'secret');
    await writeFile(path.join(runtime, 'stray'), '');
    const seen = await observePublication(runtime, path.join(runtime, 'stray'));
    assert.deepEqual(seen, {
      descriptor: true,
      tokenFiles: 1,
      otherEntries: 1,
      endpoint: true,
      residue: true,
    });
    assert.ok(!JSON.stringify(seen).includes('secret'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const measuredTrial = (value, fields = {}) => ({
  outcome: 'measured',
  observer: [{ durationMs: 2, harnessCpuUs: 10 }],
  harnessLoad: { leaseRenewals: 4 },
  exit: { code: 0, signal: null, clean: true, censored: false },
  idle: {
    metrics: {
      idleCpuNs: value,
      machIpcInUseNameEntries: 'error:task_for_pid:5',
    },
    diagnostics: { residentBytes: 1 },
    timing: { cadenceErrorMs: 1, skewBoundMs: 2 },
  },
  shutdown: {
    metrics: { shutdownDrainMs: value, orphanCount: 0 },
    publicationResidue: false,
  },
  ...fields,
});

test('publication labels each metric with its requirement and keeps raw tallies', () => {
  const trials = [
    measuredTrial(999),
    measuredTrial(10),
    // Exited before publishing: never stopped, so not an unclean stop.
    {
      outcome: 'failed',
      reason: 'not_published',
      exit: { code: 0, signal: null },
      observer: [],
      cleanup: { errors: ['data root: EACCES'] },
    },
    { outcome: 'excluded', reason: 'preparation_residue', observer: [] },
    measuredTrial(30, { exit: { clean: false, censored: true } }),
  ];
  const context = { warmUpTrials: 1 };
  const artifact = publishIdleShutdown({
    arm: 'standalone',
    stop: 'signal',
    trials,
    context,
  });
  assert.deepEqual(
    artifact.requirements.map(({ requirement, status }) => [
      requirement,
      status,
    ]),
    [
      ['idle_resources', 'collected'],
      ['shutdown_drain', 'collected'],
      ['process_memory', 'unavailable'],
    ],
  );
  const [idle, shutdown] = artifact.requirements;
  assert.deepEqual(idle.metrics.idleCpuNs.values, [10, 30]);
  assert.deepEqual(idle.metrics.machIpcInUseNameEntries.unknownReasons, {
    'error:task_for_pid:5': 2,
  });
  assert.deepEqual(idle.metrics.openFileDescriptors.unknownReasons, {
    not_observed: 2,
  });
  assert.equal(shutdown.metrics.shutdownDrainMs.max, 30);
  assert.ok(!('idleGraceExitMs' in shutdown.metrics));
  assert.ok(!('residentBytes' in idle.metrics));
  assert.equal(artifact.diagnostics.approvedPrivateBytes, false);
  assert.equal(artifact.diagnostics.metrics.residentBytes.p50, 1);
  assert.equal(artifact.observation.overheadMs.p50, 2);
  const {
    attempts,
    admitted,
    warmUpExcluded,
    failures,
    exclusions,
    censored,
    uncleanExits,
    cleanupErrors,
  } = artifact.population;
  assert.deepEqual(
    {
      attempts,
      admitted,
      warmUpExcluded,
      failures,
      exclusions,
      censored,
      uncleanExits,
      cleanupErrors,
    },
    {
      attempts: 5,
      admitted: 2,
      warmUpExcluded: 1,
      failures: ['not_published'],
      exclusions: ['preparation_residue'],
      censored: 1,
      uncleanExits: 1,
      cleanupErrors: ['data root: EACCES'],
    },
  );
});

test('a refused arm writes an all-unavailable artifact without spawning', async () => {
  const artifact = await runIdleShutdownPopulation(
    { arm: 'flag-off', stop: 'signal', cycles: 2, warmUpTrials: 1 },
    {
      createDataRoot: () =>
        assert.fail('a refused arm must not prepare a profile'),
      context: {},
    },
  );
  assert.deepEqual(artifact.trials, []);
  for (const section of [
    ...artifact.requirements,
    artifact.observation,
    artifact.diagnostics,
  ]) {
    assert.equal(section.status, 'unavailable');
    assert.ok(!('metrics' in section));
  }
});

test('a refused arm still exits successfully', () => {
  const artifact = publishIdleShutdown({
    arm: 'product-on',
    stop: 'signal',
    trials: [],
    context: { cycles: 2, warmUpTrials: 1 },
  });
  assert.equal(runnerExitCode(artifact), 0);
});

test('a population with no admitted launch is failed, never collected', () => {
  const trials = [
    measuredTrial(5),
    { outcome: 'failed', reason: 'not_published', observer: [] },
    { outcome: 'excluded', reason: 'ambiguous_attribution', observer: [] },
  ];
  const artifact = publishIdleShutdown({
    arm: 'standalone',
    stop: 'signal',
    trials,
    context: { cycles: 2, warmUpTrials: 1 },
  });
  assert.equal(artifact.population.status, 'failed');
  assert.match(artifact.population.reason, /No launch was admitted/);
  assert.match(artifact.population.reason, /not_published/);
  assert.match(artifact.population.reason, /ambiguous_attribution/);
  assert.deepEqual(
    artifact.requirements.map(({ status }) => status),
    ['failed', 'failed', 'unavailable'],
  );
  for (const section of artifact.requirements.slice(0, 2)) {
    assert.equal(section.reason, artifact.population.reason);
    assert.ok(!('metrics' in section));
  }
  assert.equal(artifact.population.admitted, 0);
  assert.equal(runnerExitCode(artifact), 1);
});

test('an interrupted population keeps its admitted values and exits 128 + signal', () => {
  const artifact = publishIdleShutdown({
    arm: 'standalone',
    stop: 'signal',
    trials: [measuredTrial(5), measuredTrial(7)],
    context: { cycles: 3, warmUpTrials: 1 },
    interruptedBy: 'SIGINT',
  });
  assert.equal(artifact.population.status, 'interrupted');
  assert.match(artifact.population.reason, /SIGINT after 2 of 4 launches/);
  const [idle, shutdown] = artifact.requirements;
  assert.deepEqual(
    [idle.status, shutdown.status],
    ['interrupted', 'interrupted'],
  );
  assert.deepEqual(idle.metrics.idleCpuNs.values, [7]);
  assert.equal(runnerExitCode(artifact), 130);
});

test('a profile with runtime residue is excluded before spawn and still removed', async () => {
  const roots = [];
  const artifact = await runIdleShutdownPopulation(
    { arm: 'standalone', stop: 'signal', cycles: 1, warmUpTrials: 0 },
    {
      createDataRoot: async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'idle-residue-'));
        await mkdir(path.join(root, 'runtime'));
        await writeFile(path.join(root, 'runtime', 'core.json'), '{}');
        roots.push(root);
        return root;
      },
      spawnDaemon: () => assert.fail('a residue profile must not spawn'),
      context: {},
    },
  );
  assert.deepEqual(artifact.population.exclusions, ['preparation_residue']);
  assert.equal(artifact.trials[0].cleanup.dataRootRemoved, true);
  await assert.rejects(readFile(path.join(roots[0], 'runtime', 'core.json')));
});

test('an unreadable preflight or data root never loses the launches already taken', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'idle-preflight-'));
  let roots = 0;
  try {
    const artifact = await runIdleShutdownPopulation(
      { arm: 'standalone', stop: 'signal', cycles: 2, warmUpTrials: 0 },
      {
        createDataRoot: async () => {
          if (++roots === 2) throw new Error('disk full');
          return mkdtemp(path.join(scratch, 'root-'));
        },
        observePublication: async () => ({
          residue: null,
          error: 'error:EACCES',
        }),
        spawnDaemon: () =>
          assert.fail('an unreadable preflight must not spawn'),
        context: {},
      },
    );
    const [first, second] = artifact.trials;
    assert.deepEqual(
      [first.outcome, first.reason],
      ['excluded', 'preparation_unreadable'],
    );
    assert.equal(first.cleanup.dataRootRemoved, true);
    assert.deepEqual(
      [second.outcome, second.reason],
      ['failed', 'data_root_failed: disk full'],
    );
    assert.equal(artifact.population.attempts, 2);
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

/**
 * Publishes like the daemon and follows `behaviour`: `orphan` leaves a child
 * holding an unreaped zombie (`detached-orphan` and `member-unreadable`: in its
 * own group), `idle` exits once released, `residue` leaves its descriptor,
 * `ignore-term` never stops, `unclean` exits 1 on SIGTERM, `drain-spawn`
 * starts a detached child while stopping, and `crash-orphan` and
 * `crash-at-stop` exit 3 on SIGUSR2, which `runFake` sends inside the window
 * and during the release. Any other behaviour stops on SIGTERM.
 */
const FAKE_DAEMON = `
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [dataRoot, behaviour] = process.argv.slice(2);
const runtime = dataRoot + '/runtime';
mkdirSync(runtime, { recursive: true });
// A plain file stands in for the socket: temporary paths exceed sun_path.
const socket = runtime + '/e.sock';
writeFileSync(socket, '');
writeFileSync(runtime + '/a.token', 'secret');
writeFileSync(runtime + '/core.json', JSON.stringify({ pid: process.pid, endpoint: { kind: 'socket', path: socket } }));
if (behaviour.includes('orphan') || behaviour === 'member-unreadable')
  spawn('/bin/sh', ['-c', 'sleep 0 & exec sleep 30'], {
    stdio: 'ignore',
    detached: ['detached-orphan', 'member-unreadable'].includes(behaviour),
  }).unref();
const withdraw = () => {
  for (const name of ['core.json', 'a.token', 'e.sock']) rmSync(runtime + '/' + name, { force: true });
};
process.on('SIGUSR2', () => process.exit(3));
process.on('SIGTERM', () => {
  if (behaviour.includes('ignore-term')) return;
  // Starts after the pre-stop read, in its own group: outside the definition.
  if (behaviour === 'drain-spawn') {
    const late = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    writeFileSync(dataRoot + '/../leaked', String(late.pid));
  }
  if (!behaviour.includes('residue')) withdraw();
  process.exit(behaviour === 'unclean' ? 1 : 0);
});
// A short idle grace after release, like the daemon's 30-second one.
const idle = setInterval(() => {
  if (behaviour.includes('idle') && existsSync(dataRoot + '/released')) {
    clearInterval(idle);
    setTimeout(() => {
      withdraw();
      process.exit(0);
    }, 150);
  }
}, 20);
`;

async function runFake(behaviour, stop, overrides = {}, depOverrides = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'idle-fake-'));
  const script = path.join(scratch, 'fake-daemon.mjs');
  await writeFile(script, FAKE_DAEMON);
  let daemonPid = null;
  let attachedRoot = null;
  let firstTable = true;
  // The window's first table read follows its start snapshot, so a crash or
  // withdrawal here lands inside the window without depending on host timing.
  const listTable = async () => {
    const table = await listProcessTable();
    if (firstTable && behaviour === 'crash-orphan')
      process.kill(daemonPid, 'SIGUSR2');
    if (firstTable && behaviour === 'early-withdraw')
      await rm(path.join(attachedRoot, 'runtime', 'core.json'));
    firstTable = false;
    return table;
  };
  const native = await createNativeResourceReader();
  // Reports every live descendant only as a failed sample with its identity.
  const hidingNative = {
    read: (identities) => native.read(identities),
    async readTree(rootPid) {
      const sample = await native.readTree(rootPid);
      const hidden = sample.processes.filter(
        ({ pid, state }) => pid !== rootPid && state === 'live',
      );
      return {
        ...sample,
        processes: sample.processes.filter((row) => !hidden.includes(row)),
        errors: [
          ...sample.errors,
          ...hidden.map(({ pid, startId }) => ({
            pid,
            startId,
            stage: 'revalidate',
            errno: 3,
          })),
        ],
      };
    },
  };
  const leaked = [];
  try {
    const artifact = await runIdleShutdownPopulation(
      {
        ...POPULATION_DEFAULTS,
        arm: 'standalone',
        stop,
        cycles: 1,
        warmUpTrials: 0,
        idleWindowMs: 300,
        warmUpMs: 300,
        reapSettleMs: 200,
        censorMs: 1_500,
        ...overrides,
      },
      {
        createDataRoot: () => mkdtemp(path.join(scratch, 'root-')),
        spawnDaemon: (dataRoot) =>
          spawn(process.execPath, [script, dataRoot, behaviour], {
            stdio: 'ignore',
            detached: true,
          }),
        attach: async (descriptor, dataRoot) => {
          daemonPid = descriptor.pid;
          attachedRoot = dataRoot;
          return {
            renewals: () => 0,
            release: async () => {
              if (behaviour === 'release-fails')
                throw new Error('lease rejected');
              await writeFile(path.join(dataRoot, 'released'), '');
              // Like a dropped connection, a daemon that is gone fails release.
              process.kill(descriptor.pid, 0);
              if (behaviour === 'crash-at-stop') crashUnseen(descriptor.pid);
            },
          };
        },
        native: behaviour === 'member-unreadable' ? hidingNative : native,
        network: null,
        listTable,
        context: {},
        ...depOverrides,
      },
    );
    const late = await readFile(path.join(scratch, 'leaked'), 'utf8').catch(
      () => null,
    );
    if (late) leaked.push(Number(late));
    return { artifact, trial: artifact.trials[0], leaked };
  } finally {
    leaked.forEach(killQuietly);
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Crashes the daemon and blocks until it is a zombie, so the stop is sent
 * before Node has seen the exit.
 */
function crashUnseen(pid) {
  process.kill(pid, 'SIGUSR2');
  const state = () =>
    execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
  for (let i = 0; i < 1_000 && !state().includes('Z'); i++);
}

const SURVIVORS = ['exited', 'live', 'zombie'];
const FAKE_CASES = [
  {
    behaviour: 'orphan',
    residue: false,
    statuses: SURVIVORS,
    metrics: { orphanCount: 1, unreapedCount: 1 },
  },
  // Outside the daemon group, only the retained native identity finds the orphan.
  {
    behaviour: 'detached-orphan',
    residue: false,
    statuses: SURVIVORS,
    kills: 1,
    metrics: { orphanCount: 1, unreapedCount: 1 },
  },
  {
    behaviour: 'idle',
    stop: 'idle-grace',
    residue: false,
    statuses: ['exited'],
    metrics: { orphanCount: 0, unreapedCount: 0 },
  },
  {
    behaviour: 'residue',
    residue: true,
    statuses: ['exited'],
    metrics: { publicationWithdrawnMs: 'descriptor_not_withdrawn' },
  },
  {
    behaviour: 'ignore-term',
    censorMs: 400,
    residue: true,
    statuses: ['live'],
    kills: 1,
    metrics: { shutdownDrainMs: 'censored', orphanCount: 'censored' },
  },
  {
    behaviour: 'release-fails',
    outcome: 'failed',
    reason: 'release_failed: lease rejected',
    residue: false,
    statuses: ['exited'],
    metrics: { orphanCount: 0, unreapedCount: 0 },
  },
  {
    // Its release fails too; the crash is the reported cause.
    behaviour: 'crash-orphan',
    outcome: 'failed',
    reason: 'exited_before_stop',
    residue: true,
    statuses: SURVIVORS,
    metrics: {
      shutdownDrainMs: 'exited_before_stop',
      orphanCount: 1,
      unreapedCount: 1,
    },
  },
  // Withdrawn before the stop, so no withdrawal time is attributable to it.
  {
    behaviour: 'early-withdraw',
    residue: false,
    statuses: ['exited'],
    metrics: {
      publicationWithdrawnMs: 'descriptor_absent_before_stop',
      orphanCount: 0,
    },
  },
  // Unclean exits stay admitted; their timings are unknown, their counts not.
  {
    behaviour: 'unclean',
    residue: false,
    statuses: ['exited'],
    metrics: {
      shutdownDrainMs: 'unclean_exit:1',
      publicationWithdrawnMs: 'unclean_exit:1',
      orphanCount: 0,
      unreapedCount: 0,
    },
  },
  // Exits 3 before the SIGTERM lands, but after the crash check ran.
  {
    behaviour: 'crash-at-stop',
    residue: true,
    statuses: ['exited'],
    metrics: {
      shutdownDrainMs: 'unclean_exit:3',
      publicationWithdrawnMs: 'unclean_exit:3',
      orphanCount: 0,
      unreapedCount: 0,
    },
  },
  // Native reads report the orphan only as a failed sample with its identity.
  {
    behaviour: 'member-unreadable',
    residue: false,
    statuses: SURVIVORS,
    kills: 1,
    metrics: { orphanCount: 1, unreapedCount: 1 },
  },
  // A detached child started after the pre-stop read is outside the counted
  // identities: a stated limitation, which this case pins.
  {
    behaviour: 'drain-spawn',
    residue: false,
    statuses: ['exited'],
    leaks: 1,
    metrics: { orphanCount: 0, unreapedCount: 0 },
  },
];

for (const {
  behaviour,
  stop = 'signal',
  censorMs,
  outcome = 'measured',
  reason,
  residue,
  statuses,
  kills,
  leaks = 0,
  metrics,
} of FAKE_CASES)
  test(
    `fake daemon '${behaviour}' (${stop} stop) keeps its shutdown evidence through cleanup`,
    darwinOnly,
    async () => {
      const { artifact, trial, leaked } = await runFake(
        behaviour,
        stop,
        censorMs ? { censorMs } : {},
      );
      assert.equal(trial.outcome, outcome, trial.reason);
      assert.equal(trial.reason, reason);
      for (const [name, value] of Object.entries(metrics))
        assert.equal(trial.shutdown.metrics[name], value, name);
      const { descendants, publication } = trial.publication.settled;
      assert.deepEqual(
        descendants.map(({ status }) => status).sort(),
        statuses,
      );
      assert.equal(publication.residue, residue);
      if (kills !== undefined) assert.equal(trial.cleanup.killed.length, kills);
      assert.equal(leaked.length, leaks);
      assert.equal(trial.cleanup.dataRootRemoved, true);
      const table = await listProcessTable();
      assert.ok(
        [...table.values()].every(({ pgid }) => pgid !== trial.daemon.pid),
      );
      assert.equal(
        artifact.population.admitted,
        outcome === 'measured' ? 1 : 0,
      );
      // A run of successful reads of one phase is one entry with its count.
      const repeats = trial.observer.filter(
        (call, i, calls) =>
          call.ok &&
          calls[i - 1]?.ok &&
          call.kind === calls[i - 1].kind &&
          call.phase === calls[i - 1].phase,
      );
      assert.deepEqual(repeats, []);
      if (behaviour !== 'idle') return;
      const polls = trial.observer.filter((c) => c.phase === 'withdrawal');
      assert.ok(polls.length === 1 && polls[0].count > 1, polls.length);
      assert.equal(trial.idle.membership, 'stable');
      assert.ok(trial.shutdown.metrics.idleGraceExitMs >= 0);
      assert.ok(trial.shutdown.metrics.publicationWithdrawnMs >= 0);
      assert.equal(
        trial.idle.metrics.idleNettopTcpUdpReceivedBytes,
        'network_unavailable',
      );
    },
  );

// Each read fails once; `endOnly` hides the descendant from the start
// snapshot, so only identities retained from a later read can find it. An
// idle-grace stop would be censored here, since the fake never idles out.
// Survivor counts are unknown when a window read failed or never ran; a failed
// table read leaves the launch measured.
const PRE_STOP_FAILURES = [
  {
    failing: 'attach',
    attachFails: true,
    stop: 'idle-grace',
    survivors: 'not_observed:window-start',
  },
  {
    failing: 'start snapshot',
    treeCall: 1,
    survivors: 'unreadable:native:window-start',
  },
  {
    failing: 'end snapshot',
    treeCall: 2,
    survivors: 'unreadable:native:window-end',
  },
  {
    failing: 'start nettop',
    netCall: 1,
    survivors: 'not_observed:window-end',
  },
  { failing: 'end nettop', netCall: 2, endOnly: true, survivors: 1 },
  {
    failing: 'start table',
    tableCall: 1,
    outcome: 'measured',
    survivors: 'unreadable:process-table:window-start',
  },
  {
    failing: 'end table',
    tableCall: 2,
    outcome: 'measured',
    survivors: 'unreadable:process-table:window-end',
  },
];

for (const {
  failing,
  attachFails,
  stop = 'signal',
  treeCall,
  netCall,
  tableCall,
  endOnly,
  outcome = 'failed',
  survivors,
} of PRE_STOP_FAILURES)
  test(
    `a failed ${failing} read still stops and observes the daemon, then cleanup kills a detached descendant`,
    darwinOnly,
    async () => {
      const native = await createNativeResourceReader();
      const failure = `${failing} failed`;
      const orphans = new Set();
      const revalidated = [];
      let [treeCalls, netCalls, tableCalls] = [0, 0, 0];
      const listTable = async () => {
        if (++tableCalls === tableCall) throw new Error(failure);
        return listProcessTable();
      };
      const flaky = {
        async read(identities) {
          revalidated.push(...identities.map(({ pid }) => pid));
          return native.read(identities);
        },
        async readTree(rootPid) {
          if (++treeCalls === treeCall) throw new Error(failure);
          const snapshot = await native.readTree(rootPid);
          const descendants = snapshot.processes.filter(
            ({ pid, state }) => pid !== rootPid && state === 'live',
          );
          for (const { pid } of descendants) orphans.add(pid);
          if (!endOnly || treeCalls > 1) return snapshot;
          const processes = snapshot.processes.filter(
            ({ pid }) => pid === rootPid,
          );
          return { ...snapshot, processes };
        },
      };
      const network = {
        async read() {
          if (++netCalls === netCall) throw new Error(failure);
          return { processes: [] };
        },
      };
      const attach = async () => {
        // Lets the fake spawn its descendants before the launch fails.
        await delay(300);
        throw new Error(failure);
      };
      let trial = null;
      try {
        ({ trial } = await runFake(
          'detached-orphan',
          stop,
          {},
          {
            native: flaky,
            network,
            listTable,
            ...(attachFails && { attach }),
          },
        ));
        assert.ok(orphans.size > 0, 'a snapshot saw the detached child');
        assert.equal(trial.outcome, outcome);
        assert.equal(trial.reason, outcome === 'failed' ? failure : undefined);
        // The original failure stands, and the stop's evidence precedes cleanup.
        assert.deepEqual(
          [trial.exit.clean, trial.exit.censored],
          [true, false],
        );
        assert.equal(trial.shutdown.stop, 'signal');
        const { shutdownDrainMs, publicationWithdrawnMs } =
          trial.shutdown.metrics;
        assert.ok(shutdownDrainMs >= 0 && publicationWithdrawnMs >= 0);
        assert.equal(trial.publication.beforeStop.descriptor, true);
        const { descendants, publication } = trial.publication.settled;
        assert.equal(publication.residue, false);
        assert.deepEqual(
          descendants.map(({ status }) => status).sort(),
          SURVIVORS,
        );
        assert.deepEqual(
          [
            trial.shutdown.metrics.orphanCount,
            trial.shutdown.metrics.unreapedCount,
          ],
          [survivors, survivors],
        );
        for (const pid of orphans) {
          assert.ok(revalidated.includes(pid), `revalidated ${pid}`);
          assert.ok(trial.cleanup.killed.includes(pid), `killed ${pid}`);
        }
        assert.equal(trial.cleanup.dataRootRemoved, true);
      } finally {
        // A child that cleanup missed would otherwise outlive the test.
        for (const pid of orphans) {
          if (trial?.cleanup.killed.includes(pid)) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
  );

const MATRIX_TIMING = { warmUpMs: 150, idleWindowMs: 150, reapSettleMs: 100 };
const flatNetwork = {
  read: async (identities) => ({
    processes: identities.map(({ pid, startId }) => ({
      pid,
      startId,
      quantities: {
        nettopTcpUdpReceivedBytes: ok('0'),
        nettopTcpUdpSentBytes: ok('0'),
      },
    })),
  }),
};

/**
 * One `detached-orphan` launch whose first (kind, phase) read in `fault`
 * throws or aborts the run. Returns the trial and every descendant identity
 * any read saw, keyed by PID.
 */
async function runFaulted(fault) {
  const native = await createNativeResourceReader();
  const seen = new Map();
  let root = null;
  const note = (pid, startSec) => pid !== root && seen.set(pid, startSec);
  const recording = {
    read: (identities) => native.read(identities),
    async readTree(rootPid) {
      root = rootPid;
      const sample = await native.readTree(rootPid);
      for (const { pid, startId } of [...sample.processes, ...sample.errors])
        if (startId !== null) note(pid, Math.floor(Number(startId)));
      return sample;
    },
  };
  const listTable = async () => {
    const table = await listProcessTable();
    if (root)
      for (const { pid, startSec } of treeDescendants(table, root))
        note(pid, startSec);
    return table;
  };
  const controller = new AbortController();
  let pending = fault;
  const onRead = (kind, phase) => {
    if (pending?.kind !== kind || pending.phase !== phase) return;
    pending = null;
    if (fault.mode === 'abort') controller.abort('SIGINT');
    else throw new Error(`${kind} ${phase} fault`);
  };
  const { trial } = await runFake('detached-orphan', 'signal', MATRIX_TIMING, {
    native: recording,
    network: flatNetwork,
    listTable,
    onRead,
    signal: controller.signal,
  });
  return { trial, seen };
}

/** Seen identities still listed, live or zombie, with their own start second. */
async function listed(seen) {
  const table = await listProcessTable();
  return [...seen]
    .filter(([pid, startSec]) => table.get(pid)?.startSec === startSec)
    .map(([pid]) => pid);
}

test(
  'a read that fails or is interrupted at any phase leaves counts true or unknown, and cleanup still kills every descendant',
  darwinOnly,
  async (t) => {
    const startedMs = performance.now();
    const clean = await runFaulted(null);
    assert.equal(clean.trial.outcome, 'measured');
    assert.deepEqual(
      [
        clean.trial.shutdown.metrics.orphanCount,
        clean.trial.shutdown.metrics.unreapedCount,
      ],
      [1, 1],
    );
    const declared = new Set([
      ...Object.values(SHUTDOWN_INPUTS).flat(),
      ...EVIDENCE_PHASES,
    ]);
    const pairs = new Map(
      clean.trial.observer.map(({ kind, phase }) => [`${kind}@${phase}`, kind]),
    );
    assert.ok(pairs.size >= 10, [...pairs.keys()].join());
    for (const key of pairs.keys())
      assert.ok(declared.has(key.split('@')[1]), `${key} is undeclared`);
    for (const [key, kind] of pairs)
      for (const mode of ['throw', 'abort']) {
        const phase = key.split('@')[1];
        const { trial, seen } = await runFaulted({ kind, phase, mode });
        try {
          const label = `${mode} ${key}: ${trial.outcome} ${trial.reason}`;
          assert.ok(trial.cleanup.dataRootRemoved, label);
          await poll(async () => (await listed(seen)).length === 0);
          assert.deepEqual(await listed(seen), [], label);
          if (trial.outcome !== 'measured') continue;
          const { metrics } = trial.shutdown;
          for (const name of ['orphanCount', 'unreapedCount'])
            assert.ok(
              metrics[name] === 1 || typeof metrics[name] === 'string',
              `${label}: ${name} ${metrics[name]}`,
            );
          if (mode === 'abort') continue;
          const inputs = {
            orphanCount: SHUTDOWN_INPUTS.survivors,
            unreapedCount: SHUTDOWN_INPUTS.survivors,
            shutdownDrainMs: SHUTDOWN_INPUTS.drain,
            publicationWithdrawnMs: SHUTDOWN_INPUTS.publicationWithdrawnMs,
          };
          for (const [name, phases] of Object.entries(inputs))
            if (phases.includes(phase))
              assert.equal(typeof metrics[name], 'string', `${label}: ${name}`);
        } finally {
          (await listed(seen)).forEach(killQuietly);
        }
      }
    t.diagnostic(
      `${pairs.size} (kind, phase) pairs in ${Math.round(performance.now() - startedMs)} ms`,
    );
  },
);

test(
  'a fake population whose every launch fails exits non-zero',
  darwinOnly,
  async () => {
    const attach = async () => {
      throw new Error('attach refused');
    };
    const { artifact } = await runFake(
      'idle',
      'signal',
      { cycles: 2 },
      { attach },
    );
    assert.deepEqual(artifact.population.failures, [
      'attach refused',
      'attach refused',
    ]);
    assert.equal(artifact.requirements[0].status, 'failed');
    assert.equal(runnerExitCode(artifact), 1);
  },
);

// The fake never idles out, so only the interrupt's SIGTERM ends these stops.
for (const { when, abortIn } of [
  { when: 'during the lease release', abortIn: 0 },
  { when: 'while waiting out the idle grace', abortIn: 200 },
])
  test(
    `an interrupt ${when} SIGTERMs an idle-grace stop and is not admitted`,
    darwinOnly,
    async () => {
      const controller = new AbortController();
      const attach = async () => ({
        renewals: () => 0,
        release: async () => {
          setTimeout(() => controller.abort('SIGINT'), abortIn);
          await delay(abortIn ? 0 : 50);
        },
      });
      const { artifact, trial } = await runFake(
        'detached-orphan',
        'idle-grace',
        { censorMs: 10_000 },
        { attach, signal: controller.signal },
      );
      assert.equal(trial.outcome, 'failed');
      assert.equal(trial.reason, 'interrupted:SIGINT');
      assert.equal(trial.exit.clean, true);
      assert.equal(trial.shutdown.metrics.idleGraceExitMs, trial.reason);
      assert.deepEqual(
        [
          trial.shutdown.metrics.orphanCount,
          trial.shutdown.metrics.unreapedCount,
        ],
        [1, 1],
      );
      assert.equal(trial.cleanup.killed.length, 1);
      assert.equal(artifact.population.status, 'interrupted');
      assert.equal(artifact.population.admitted, 0);
      assert.equal(runnerExitCode(artifact), 130);
    },
  );

// Each abort lands after the population's own check and before the spawn.
for (const { when, signalName, exitCode, inPreflight } of [
  { when: 'during profile setup', signalName: 'SIGINT', exitCode: 130 },
  {
    when: 'during the publication preflight',
    signalName: 'SIGTERM',
    exitCode: 143,
    inPreflight: true,
  },
])
  test(`an interrupt ${when} spawns no daemon and removes its profile`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'idle-unstarted-'));
    const controller = new AbortController();
    const abort = () => controller.abort(signalName);
    let spawned = 0;
    let preflights = 0;
    try {
      const artifact = await runIdleShutdownPopulation(
        {
          ...POPULATION_DEFAULTS,
          arm: 'standalone',
          stop: 'signal',
          cycles: 3,
        },
        {
          createDataRoot: async () => {
            const dataRoot = await mkdtemp(path.join(scratch, 'root-'));
            if (!inPreflight) abort();
            return dataRoot;
          },
          observePublication: async (runtimeDirectory) => {
            preflights++;
            const seen = await observePublication(runtimeDirectory);
            if (inPreflight) abort();
            return seen;
          },
          spawnDaemon: () => {
            spawned++;
            throw new Error('spawned after the interrupt');
          },
          signal: controller.signal,
          context: {},
        },
      );
      assert.equal(spawned, 0);
      // The abort landed inside the one preflight that ran.
      if (inPreflight) assert.equal(preflights, 1);
      assert.equal(artifact.trials.length, 1);
      const [trial] = artifact.trials;
      assert.equal(trial.outcome, 'failed');
      assert.equal(trial.reason, `interrupted:${signalName}`);
      assert.equal(trial.preparation.residue, false);
      assert.equal(trial.exit, undefined);
      assert.equal(trial.cleanup.dataRootRemoved, true);
      assert.deepEqual(await readdir(scratch), []);
      assert.equal(artifact.population.status, 'interrupted');
      assert.equal(artifact.population.admitted, 0);
      assert.equal(runnerExitCode(artifact), exitCode);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

/**
 * Drives a runner like daemon-idle-shutdown-run.mjs over the fake daemon, with
 * a minute-long idle window, so a signal lands mid-trial.
 */
const FAKE_RUNNER = `
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [collectorUrl, resourcesUrl, daemonScript, scratch, output] = process.argv.slice(2);
const collector = await import(collectorUrl);
const { createNativeResourceReader } = await import(resourcesUrl);
const interruption = collector.interruptOnSignals();
let announced = false;
const artifact = await collector.runIdleShutdownPopulation(
  { ...collector.POPULATION_DEFAULTS, arm: 'standalone', stop: 'signal', cycles: 3,
    warmUpTrials: 0, warmUpMs: 300, idleWindowMs: 60_000, reapSettleMs: 200, censorMs: 1_500 },
  {
    createDataRoot: () => mkdtemp(join(scratch, 'root-')),
    spawnDaemon: (dataRoot) => spawn(process.execPath, [daemonScript, dataRoot, 'detached-orphan'], { stdio: 'ignore', detached: true }),
    attach: async () => ({ renewals: () => 0, release: async () => {} }),
    native: await createNativeResourceReader(),
    network: null,
    listTable: async () => {
      const table = await collector.listProcessTable();
      if (!announced) console.log('window');
      announced = true;
      return table;
    },
    signal: interruption.signal,
    context: {},
  },
);
await writeFile(output, JSON.stringify(artifact));
process.exitCode = collector.runnerExitCode(artifact);
interruption.dispose();
`;

test(
  'SIGTERM mid-trial stops new launches, observes and cleans up the active one, then exits 143',
  darwinOnly,
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'idle-signal-'));
    const daemonScript = path.join(scratch, 'fake-daemon.mjs');
    const runnerScript = path.join(scratch, 'fake-runner.mjs');
    const output = path.join(scratch, 'artifact.json');
    await writeFile(daemonScript, FAKE_DAEMON);
    await writeFile(runnerScript, FAKE_RUNNER);
    const url = (file) => new URL(file, import.meta.url).href;
    const runner = spawn(
      process.execPath,
      [
        runnerScript,
        url('./daemon-idle-shutdown.mjs'),
        url('./process-resources.mjs'),
        daemonScript,
        scratch,
        output,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let trial = null;
    try {
      runner.stdout.on('data', (chunk) => {
        if (String(chunk).includes('window')) runner.kill('SIGTERM');
      });
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => runner.kill('SIGKILL'), 30_000);
        runner.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      assert.deepEqual(exit, { code: 143, signal: null });
      const artifact = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(artifact.population.status, 'interrupted');
      assert.equal(artifact.population.interrupted, 'SIGTERM');
      assert.equal(artifact.trials.length, 1);
      [trial] = artifact.trials;
      assert.equal(trial.reason, 'interrupted:SIGTERM');
      assert.equal(trial.exit.clean, true);
      assert.ok(trial.shutdown.metrics.shutdownDrainMs >= 0);
      assert.deepEqual(
        trial.publication.settled.descendants
          .map(({ status }) => status)
          .sort(),
        SURVIVORS,
      );
      assert.equal(trial.cleanup.killed.length, 1);
      assert.equal(trial.cleanup.dataRootRemoved, true);
      await poll(async () => (await liveIdentities(trial)).length === 0);
      assert.deepEqual(await liveIdentities(trial), []);
    } finally {
      runner.kill('SIGKILL');
      // A descendant that cleanup missed would otherwise outlive the test.
      for (const pid of trial ? await liveIdentities(trial) : [])
        process.kill(pid, 'SIGKILL');
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

/** Runs daemon-idle-shutdown-run.mjs against a daemon path that never exists. */
function runRunner(scratch, args) {
  return new Promise((resolve) => {
    const runner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(import.meta.dirname, 'daemon-idle-shutdown-run.mjs'),
        '--executable',
        path.join(scratch, 'missing-daemon'),
        ...args,
      ],
      { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    runner.stderr.on('data', (chunk) => (stderr += chunk));
    runner.once('close', (code) => resolve({ code, stderr }));
  });
}

test('a runner whose setup fails leaves no earlier result at its output path', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'idle-runner-'));
  const output = path.join(scratch, 'artifact.json');
  try {
    await writeFile(output, '{"stale":true}');
    const { code } = await runRunner(scratch, ['--output', output]);
    assert.notEqual(code, 0);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a runner rejects a traversing --arm or --stop before removing any file', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'idle-runner-'));
  const desktop = path.join(repoRoot, '.performance', 'desktop');
  // Climbs from the default file name's first segment into scratch.
  const climb = (prefix, target) =>
    `x/${path.relative(path.join(desktop, `${prefix}x`), path.join(scratch, target))}`;
  const arm = climb('daemon-idle-shutdown-', 'arm-victim');
  const stop = climb('daemon-idle-shutdown-standalone-', 'stop-victim');
  const cases = [
    {
      args: ['--arm', arm],
      defaultName: `daemon-idle-shutdown-${arm}-signal.json`,
      victim: 'arm-victim-signal.json',
      message: /Error: --arm must be one of standalone, product-on, flag-off/,
    },
    {
      args: ['--stop', stop],
      defaultName: `daemon-idle-shutdown-standalone-${stop}.json`,
      victim: 'stop-victim.json',
      message: /Error: --stop must be one of signal, idle-grace/,
    },
  ];
  try {
    for (const { args, defaultName, victim, message } of cases) {
      const target = path.join(scratch, victim);
      assert.equal(path.join(desktop, defaultName), target);
      await writeFile(target, 'sentinel');
      const { code, stderr } = await runRunner(scratch, args);
      assert.notEqual(code, 0);
      assert.match(stderr, message);
      assert.equal(await readFile(target, 'utf8'), 'sentinel');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Retained identities still listed live with their own start second. */
async function liveIdentities(trial) {
  const table = await listProcessTable();
  return trial.identities
    .filter((identity) => classifyIdentity(identity, table) === 'live')
    .map(({ pid }) => pid);
}
