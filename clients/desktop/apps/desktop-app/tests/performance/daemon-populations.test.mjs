import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPlatformEndpointServices } from '@canopy/core-platform';
import {
  writeFilesFixture,
  POPULATION_PLAN,
  STANDALONE_POPULATIONS,
  abbaSchedule,
  assessStandaloneRun,
  classifyStandaloneTrial,
  coldPreflight,
  directoryTargets,
  shortTemporaryBase,
  standaloneDataRoot,
  standaloneDataRoots,
  summarizeFilesLaunches,
  summarizeStandalone,
  validateRunManifest,
  verifyArmPreparation,
} from './daemon-populations.mjs';

const identity = { pid: 41, startIdentity: 's-41', daemonEpoch: 'e-1' };

function cold(population, overrides = {}) {
  return {
    population,
    warmup: false,
    started: true,
    spawns: 1,
    readyMs: 120,
    healthState: 'ready',
    identity,
    preflight: {
      freshRoot: population === 'fresh-root-cold',
      descriptorPresent: false,
      priorOwnerState: population === 'fresh-root-cold' ? null : 'absent',
    },
    ...overrides,
  };
}

function warm(overrides = {}) {
  return {
    population: 'retained-warm-attach',
    warmup: false,
    started: false,
    spawns: 0,
    readyMs: 8,
    healthState: 'ready',
    identity,
    holderIdentity: { ...identity },
    holderPid: 10,
    attacherPid: 11,
    ...overrides,
  };
}

test('ABBA schedule declares warm-ups and balances arms by position', () => {
  const schedule = abbaSchedule();
  assert.equal(schedule.length, 42);
  assert.deepEqual(
    schedule.slice(0, 6).map(({ arm, warmup }) => `${arm}${warmup ? '*' : ''}`),
    ['off*', 'on*', 'off', 'on', 'on', 'off'],
  );
  for (const name of ['off', 'on']) {
    const measured = schedule.filter(
      (entry) => entry.arm === name && !entry.warmup,
    );
    assert.equal(measured.length, 20);
  }
  assert.throws(() => abbaSchedule({ launchesPerArm: 3 }), /even/);
});

test('each launch reads ten fresh fixture directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-fixture-'));
  assert.equal(POPULATION_PLAN.files.directories, 80);
  assert.equal(POPULATION_PLAN.files.filesPerDirectory, 120);
  try {
    // A reduced fixture keeps this test fast; the plan constants are above.
    await writeFilesFixture(root, { directories: 3, filesPerDirectory: 4 });
    const directories = await readdir(root);
    assert.deepEqual(directories.sort(), ['dir-00', 'dir-01', 'dir-02']);
    assert.equal((await readdir(join(root, 'dir-02'))).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (let launch = 0; launch < 12; launch += 1) {
    const targets = directoryTargets(launch);
    assert.equal(new Set(targets).size, 10);
  }
  assert.notDeepEqual(directoryTargets(0), directoryTargets(1));
  assert.deepEqual(directoryTargets(0), directoryTargets(8));
});

test('standalone classification proves coldness and warm identity, never relabels', () => {
  assert.equal(classifyStandaloneTrial(cold('fresh-root-cold')).class, 'cold');
  assert.equal(classifyStandaloneTrial(cold('reused-root-cold')).class, 'cold');
  assert.equal(classifyStandaloneTrial(warm()).class, 'warm');
  const rejected = [
    cold('fresh-root-cold', { preflight: undefined }),
    cold('reused-root-cold', {
      preflight: {
        freshRoot: false,
        descriptorPresent: true,
        priorOwnerState: 'absent',
      },
    }),
    cold('reused-root-cold', {
      preflight: {
        freshRoot: false,
        descriptorPresent: false,
        priorOwnerState: 'running',
      },
    }),
    cold('reused-root-cold', {
      preflight: {
        freshRoot: false,
        descriptorPresent: false,
        priorOwnerState: 'unverifiable',
      },
    }),
    cold('reused-root-cold', {
      preflight: {
        freshRoot: true,
        descriptorPresent: false,
        priorOwnerState: null,
      },
    }),
    cold('reused-root-cold', {
      preflight: {
        freshRoot: false,
        descriptorPresent: false,
        priorOwnerState: null,
      },
    }),
    cold('fresh-root-cold', {
      preflight: { freshRoot: true, priorOwnerState: null },
    }),
    cold('fresh-root-cold', { started: false, spawns: 0 }),
    cold('fresh-root-cold', { healthState: 'starting' }),
    warm({ spawns: 1 }),
    warm({ holderIdentity: { ...identity, startIdentity: 's-99' } }),
    warm({
      holderIdentity: { ...identity, daemonEpoch: undefined },
      identity: { ...identity, daemonEpoch: undefined },
    }),
    warm({ attacherPid: 10 }),
  ];
  for (const trial of rejected)
    assert.equal(classifyStandaloneTrial(trial).class, 'rejected');
  assert.equal(
    classifyStandaloneTrial(cold('fresh-root-cold', { warmup: true })).class,
    'excluded',
  );
  assert.equal(
    classifyStandaloneTrial({ ...warm(), error: 'boom' }).class,
    'failed',
  );
  assert.equal(
    classifyStandaloneTrial({ ...warm({ warmup: true }), error: 'boom' }).class,
    'failed',
  );
});

test('a standalone warm-up is excluded only when its launch would pass', () => {
  const excluded = { class: 'excluded', reasons: ['declared warm-up'] };
  assert.deepEqual(classifyStandaloneTrial(warm({ warmup: true })), excluded);
  // The reused root's first launch creates the root, so coldness is not checked.
  assert.deepEqual(
    classifyStandaloneTrial(
      cold('reused-root-cold', {
        warmup: true,
        preflight: {
          freshRoot: true,
          descriptorPresent: false,
          priorOwnerState: null,
        },
      }),
    ),
    excluded,
  );
  assert.deepEqual(
    classifyStandaloneTrial(
      cold('fresh-root-cold', { warmup: true, preflight: undefined }),
    ),
    excluded,
  );
  for (const [trial, reasons] of [
    [
      cold('fresh-root-cold', { warmup: true, healthState: 'starting' }),
      ['health not ready'],
    ],
    [
      cold('reused-root-cold', { warmup: true, spawns: 0, started: false }),
      ['not one spawn'],
    ],
    [
      cold('fresh-root-cold', { warmup: true, readyMs: undefined }),
      ['ready time missing'],
    ],
    [warm({ warmup: true, spawns: 1 }), ['spawned']],
    [warm({ warmup: true, attacherPid: 10 }), ['not a new connection']],
  ])
    assert.deepEqual(classifyStandaloneTrial(trial), {
      class: 'rejected',
      reasons,
    });
});

test('arm preparation is cold, warm or rejected, never assumed cold', () => {
  const prepared = (overrides = {}) => ({
    disposableProfile: true,
    persistedChoice: true,
    choiceAfterFixtureRefresh: true,
    preparationProcessesExited: true,
    daemon: { ownerState: 'absent', descriptorPresent: false },
    preMeasurementDaemonReads: 0,
    ...overrides,
  });
  assert.equal(verifyArmPreparation(prepared(), 'on').status, 'cold');
  assert.equal(
    verifyArmPreparation(
      prepared({ persistedChoice: false, choiceAfterFixtureRefresh: false }),
      'off',
    ).status,
    'cold',
  );
  assert.equal(
    verifyArmPreparation(
      prepared({ daemon: { ownerState: 'running', descriptorPresent: true } }),
      'on',
    ).status,
    'warm',
  );
  assert.equal(
    verifyArmPreparation(prepared({ preMeasurementDaemonReads: 1 }), 'on')
      .status,
    'warm',
  );
  for (const change of [
    { preMeasurementDaemonReads: undefined },
    { persistedChoice: false },
    { choiceAfterFixtureRefresh: false },
    { preparationProcessesExited: false },
    { disposableProfile: false },
    { daemon: { ownerState: 'unverifiable', descriptorPresent: false } },
    { daemon: { ownerState: 'absent' } },
    { daemon: { ownerState: 'absent', descriptorPresent: true } },
  ])
    assert.equal(
      verifyArmPreparation(prepared(change), 'on').status,
      'rejected',
    );
});

test('standalone summary keeps attempts, failures, rejections and exclusions', () => {
  const trials = [
    { population: 'fresh-root-cold', class: 'excluded', readyMs: 500 },
    { population: 'fresh-root-cold', class: 'cold', readyMs: 100 },
    {
      population: 'fresh-root-cold',
      class: 'cold',
      readyMs: 200,
      exit: { censored: true, exitObservedMs: null },
    },
    { population: 'fresh-root-cold', class: 'rejected', readyMs: 1 },
    { population: 'fresh-root-cold', class: 'failed' },
    ...[
      { ...cold('fresh-root-cold'), warmup: true, healthState: 'starting' },
      { ...cold('fresh-root-cold'), warmup: true, error: 'timeout' },
    ].map((trial) => ({ ...trial, ...classifyStandaloneTrial(trial) })),
  ];
  const summary = summarizeStandalone(trials)['fresh-root-cold'];
  assert.deepEqual(summary, {
    attempts: 7,
    failures: 2,
    rejected: 2,
    excluded: 1,
    censoredExits: 1,
    readyMs: { count: 2, p50: 150, p95: 195, max: 200 },
  });
  assert.equal(
    summarizeStandalone(trials)['retained-warm-attach'].readyMs.count,
    0,
  );
});

test('a requested population without an admitted measured sample fails the run', () => {
  const plan = {
    repetitions: 1,
    warmups: 1,
    populations: ['fresh-root-cold', 'retained-warm-attach'],
  };
  const failedEverywhere = summarizeStandalone(
    plan.populations.flatMap((population) => [
      { population, warmup: true, class: 'failed' },
      { population, class: 'failed' },
    ]),
  );
  assert.deepEqual(assessStandaloneRun({ plan, summary: failedEverywhere }), {
    valid: false,
    reasons: [
      'fresh-root-cold: no admitted measured sample',
      'retained-warm-attach: no admitted measured sample',
    ],
  });
  const oneAdmitted = summarizeStandalone([
    { population: 'fresh-root-cold', class: 'cold', readyMs: 90 },
    { population: 'retained-warm-attach', class: 'rejected', readyMs: 4 },
    { population: 'retained-warm-attach', class: 'excluded', readyMs: 4 },
  ]);
  assert.deepEqual(
    assessStandaloneRun({ plan, summary: oneAdmitted }).reasons,
    ['retained-warm-attach: no admitted measured sample'],
  );
  // Unrequested populations never fail the run.
  assert.deepEqual(
    assessStandaloneRun({
      plan: { ...plan, populations: ['fresh-root-cold'] },
      summary: oneAdmitted,
    }),
    { valid: true, reasons: [] },
  );
  assert.equal(
    assessStandaloneRun({
      plan: { ...plan, repetitions: 0 },
      summary: summarizeStandalone([]),
    }).valid,
    false,
  );
  assert.deepEqual(
    assessStandaloneRun({ plan: { ...plan, populations: [] }, summary: {} })
      .reasons,
    ['no population requested'],
  );
});

test(
  'every standalone data root fits the daemon socket path limit',
  {
    skip: process.platform === 'win32' && 'POSIX socket roots',
  },
  () => {
    const endpoints = createPlatformEndpointServices('darwin');
    const plan = {
      populations: STANDALONE_POPULATIONS,
      warmups: POPULATION_PLAN.standalone.warmups,
      repetitions: POPULATION_PLAN.standalone.repetitions,
    };
    const socket = (dataRoot) =>
      endpoints.address({ dataRoot, endpointName: 'core' }).path;
    // The macOS per-user temporary directory the smoke run failed under.
    const longBase =
      '/private/var/folders/y0/sw7lxhh13xqgnyg4s0jv2ry00000gn/T/daemon-populations-AbC123';
    assert.throws(
      () => standaloneDataRoots(longBase, plan).forEach(socket),
      /Socket path too long/,
    );
    const base = shortTemporaryBase('darwin', tmpdir());
    assert.equal(base, '/tmp');
    // mkdtemp's six-character suffix under the realpath of /tmp.
    const roots = standaloneDataRoots(
      join('/private', base, 'daemon-populations-AbC123'),
      plan,
    );
    assert.equal(
      roots.length,
      plan.warmups + plan.repetitions + STANDALONE_POPULATIONS.length - 1,
    );
    for (const dataRoot of roots) assert.doesNotThrow(() => socket(dataRoot));
    assert.equal(shortTemporaryBase('win32', 'C:\\Temp'), 'C:\\Temp');
    assert.equal(shortTemporaryBase('linux', '/var/tmp'), '/tmp');
  },
);

test('standalone data roots match the driver: fresh per trial, shared otherwise', () => {
  assert.deepEqual(
    standaloneDataRoots('/w', {
      populations: STANDALONE_POPULATIONS,
      warmups: 1,
      repetitions: 2,
    }),
    [
      'fresh-0',
      'fresh-1',
      'fresh-2',
      'reused-root-cold',
      'retained-warm-attach',
    ].map((name) => join('/w', name)),
  );
  assert.equal(
    standaloneDataRoot('/w', 'reused-root-cold', 7),
    join('/w', 'reused-root-cold'),
  );
  // The warm-attach holder root is checked even when no trial is planned.
  assert.deepEqual(
    standaloneDataRoots('/w', {
      populations: STANDALONE_POPULATIONS,
      warmups: 0,
      repetitions: 0,
    }),
    ['reused-root-cold', 'retained-warm-attach'].map((name) =>
      join('/w', name),
    ),
  );
});

test('cold preflight observes root freshness instead of assuming it', () => {
  const state = (rootPresent) => ({
    rootPresent,
    descriptorPresent: false,
    ownerState: rootPresent ? 'absent' : null,
  });
  const prior = { pid: 41, startIdentity: 's-41' };
  const classify = (population, preflight) =>
    classifyStandaloneTrial(cold(population, { preflight }));
  const fresh = (rootPresent) =>
    coldPreflight({
      population: 'fresh-root-cold',
      state: state(rootPresent),
      prior: null,
    });
  assert.equal(fresh(false).freshRoot, true);
  assert.equal(classify('fresh-root-cold', fresh(false)).class, 'cold');
  // A fresh-population root that already exists was used before.
  assert.deepEqual(classify('fresh-root-cold', fresh(true)), {
    class: 'rejected',
    reasons: ['root reused'],
  });
  const reused = (rootPresent, previous) =>
    coldPreflight({
      population: 'reused-root-cold',
      state: state(rootPresent),
      prior: previous,
    });
  assert.equal(classify('reused-root-cold', reused(true, prior)).class, 'cold');
  for (const preflight of [reused(false, prior), reused(true, null)]) {
    const result = classify('reused-root-cold', preflight);
    assert.equal(result.class, 'rejected');
    assert.ok(result.reasons.includes('root not reused'), result.reasons);
  }
  // Missing root evidence rejects either population.
  for (const population of ['fresh-root-cold', 'reused-root-cold']) {
    const preflight = coldPreflight({
      population,
      state: { descriptorPresent: false, ownerState: 'absent' },
      prior,
    });
    assert.equal(preflight.freshRoot, null);
    assert.deepEqual(classify(population, preflight).reasons, [
      'root state unverifiable',
    ]);
  }
});

test('Files summary clusters warm reads by launch and never pools warm first use', () => {
  const launch = (overrides) => ({
    workload: 'visible',
    arm: 'on',
    warmup: false,
    status: 'admitted',
    preparation: 'cold',
    ...overrides,
  });
  const launches = [
    launch({ warmup: true, firstUseMs: 900, warmReadMs: [1] }),
    launch({ firstUseMs: 300, warmReadMs: [10, 12, 50] }),
    launch({ firstUseMs: 400, warmReadMs: [20, 22, 24] }),
    launch({ preparation: 'warm', firstUseMs: 30, warmReadMs: [16] }),
    launch({ status: 'rejected', firstUseMs: 1, warmReadMs: [1] }),
    launch({ arm: 'off', status: 'failed' }),
    launch({ workload: 'query', firstUseMs: 5, warmReadMs: [2] }),
  ];
  const { visible, query } = summarizeFilesLaunches(launches);
  const { on, off } = visible;
  assert.equal(on.attempts, 5);
  assert.equal(on.excluded, 1);
  assert.equal(on.rejected, 1);
  assert.equal(on.launches, 3);
  assert.deepEqual(on.firstUseMs, {
    cold: { count: 2, p50: 350, p95: 395, max: 400 },
    warm: { count: 1, p50: 30, p95: 30, max: 30 },
  });
  assert.equal(on.warmReads.observations, 7);
  assert.deepEqual(on.warmReads.launchMedianMs, {
    count: 3,
    p50: 16,
    p95: 21.4,
    max: 22,
  });
  assert.equal(off.failures, 1);
  assert.equal(off.launches, 0);
  assert.equal(query.on.firstUseMs.cold.max, 5);
  for (const gap of [
    { firstUseMs: undefined },
    { warmReadMs: [] },
    { preparation: undefined },
    { preparation: 'rejected' },
  ])
    assert.throws(
      () => summarizeFilesLaunches([{ ...launches[1], ...gap }]),
      /missing preparation or timings/,
    );
  assert.throws(
    () => summarizeFilesLaunches([{ ...launches[1], workload: undefined }]),
    /Unknown Files workload/,
  );
  for (const status of [undefined, 'excluded'])
    assert.throws(
      () => summarizeFilesLaunches([{ ...launches[0], status }]),
      /Unknown Files launch status/,
    );
});

test('failed and rejected Files warm-ups count as failures and rejections', () => {
  const launch = (overrides) => ({
    workload: 'query',
    arm: 'off',
    warmup: true,
    ...overrides,
  });
  const { off } = summarizeFilesLaunches([
    launch({ status: 'failed' }),
    launch({ status: 'rejected', firstUseMs: 1, warmReadMs: [1] }),
    // An admitted warm-up stays out of every distribution.
    launch({
      status: 'admitted',
      preparation: 'cold',
      firstUseMs: 900,
      warmReadMs: [900],
    }),
    launch({
      warmup: false,
      status: 'admitted',
      preparation: 'cold',
      firstUseMs: 40,
      warmReadMs: [4],
    }),
  ]).query;
  assert.deepEqual(
    {
      attempts: off.attempts,
      excluded: off.excluded,
      failures: off.failures,
      rejected: off.rejected,
      launches: off.launches,
    },
    { attempts: 4, excluded: 1, failures: 1, rejected: 1, launches: 1 },
  );
  assert.deepEqual(off.firstUseMs.cold, {
    count: 1,
    p50: 40,
    p95: 40,
    max: 40,
  });
  assert.equal(off.warmReads.observations, 1);
  assert.equal(off.warmReads.launchMedianMs.max, 4);
});

test('run manifest requires hashes, commit, brand, host load and observer overhead', () => {
  const manifest = {
    sourceSha: 'a'.repeat(40),
    brand: 'canopy',
    artifacts: { daemon: 'b'.repeat(64) },
    helpers: { driver: 'c'.repeat(64) },
    host: {
      version: 1,
      platform: 'darwin',
      logicalCpuCount: 8,
      intervalMs: 1000,
      samples: [
        { elapsedMs: 0, loadAverage: [1, 1, 1] },
        { elapsedMs: 1000, loadAverage: [1, 1, 1] },
      ],
      errors: [],
    },
    observerOverheadMs: { p95: 2 },
    cadence: { exitPollMs: 500 },
  };
  assert.deepEqual(validateRunManifest(manifest), {
    valid: true,
    reasons: [],
    hostLoad: 'valid',
  });
  assert.equal(
    validateRunManifest({ ...manifest, artifacts: {} }).valid,
    false,
  );
  assert.equal(
    validateRunManifest({ ...manifest, helpers: { driver: 'x' } }).valid,
    false,
  );
  assert.equal(validateRunManifest({ ...manifest, helpers: {} }).valid, false);
  assert.equal(validateRunManifest({ ...manifest, brand: '' }).valid, false);
  assert.equal(
    validateRunManifest({ ...manifest, host: undefined }).valid,
    false,
  );
  assert.equal(
    validateRunManifest({ ...manifest, observerOverheadMs: { p95: null } })
      .valid,
    false,
  );
  for (const cadence of [undefined, {}, { exitPollMs: null }])
    assert.ok(
      validateRunManifest({ ...manifest, cadence }).reasons.includes(
        'cadence missing',
      ),
    );
});
