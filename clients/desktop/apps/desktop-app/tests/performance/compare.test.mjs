import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRegressionDiagnosticInvocation,
  canOfferRegressionDiagnostics,
  combineSampleArtifacts,
  formatRepeatedComparisonLines,
  formatWorkComparisonLines,
  interleavedSchedule,
  assertMatchedScenarioConfigs,
  measuredBundleEntry,
  parseInterleavedArgs,
  readLaunchArtifact,
  runnerArgsFor,
} from './compare.mjs';
import { compareRepeatedPerformanceResults } from './comparison.mjs';

test('a sample launch never reads a file an earlier run left at its output path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-interleave-sample-'));
  try {
    const output = path.join(dir, 'sample-1-baseline-loaded-ui.json');
    // A reused --output-dir still holds the previous comparison's sample.
    writeFileSync(output, JSON.stringify({ stale: true }), 'utf8');
    assert.throws(
      () =>
        readLaunchArtifact(
          output,
          () => ({ status: 1, signal: null }),
          'The baseline sample 1/7 run of loaded-ui',
        ),
      /The baseline sample 1\/7 run of loaded-ui wrote no result \(exit 1\); stopping\./,
    );
    assert.equal(existsSync(output), false);

    // A launch that writes its artifact is read even when it exits non-zero,
    // so a failed sample still reaches the comparison's clean-sample check.
    const artifact = readLaunchArtifact(
      output,
      () => {
        writeFileSync(output, JSON.stringify({ fresh: true }), 'utf8');
        return { status: 1, signal: null };
      },
      'The candidate sample 2/7 run of loaded-ui',
    );
    assert.deepEqual(artifact, { fresh: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('work counter changes print beside the timing verdict, largest first', () => {
  const lines = formatWorkComparisonLines({
    workComparisons: [
      {
        key: 'chats.work.chromium.LayoutCount',
        unit: 'count',
        baseline: 100,
        current: 150,
        delta: 50,
        percent: 50,
      },
      {
        key: 'chats.work.chromium.Nodes',
        unit: 'count',
        baseline: 400,
        current: 400,
        delta: 0,
        percent: 0,
      },
      {
        key: 'chats.work.task.type_in_chat.transcript.turn_grouping.count',
        unit: 'count',
        baseline: 0,
        current: 2,
        delta: 2,
        percent: null,
      },
      {
        key: 'chats.work.transcript.counters.loaded_bytes',
        unit: 'bytes',
        baseline: 1_000,
        current: 900,
        delta: -100,
        percent: -10,
      },
    ],
    workUnavailable: ['pipelines.work.chromium'],
  });

  assert.deepEqual(lines, [
    'Work counters (reported only, not part of PASS/FAIL): 4 compared, 3 changed',
    'MORE chats.work.task.type_in_chat.transcript.turn_grouping.count | 0 count | 2 count | +2 (from zero)',
    'MORE chats.work.chromium.LayoutCount | 100 count | 150 count | +50 (50.0%)',
    'LESS chats.work.transcript.counters.loaded_bytes | 1000 bytes | 900 bytes | -100 (-10.0%)',
    'Work counters not collected by both runs: pipelines.work.chromium',
  ]);
  assert.deepEqual(formatWorkComparisonLines({ workComparisons: [] }), []);
  const limited = formatWorkComparisonLines(
    {
      workComparisons: [
        {
          key: 'a',
          unit: 'count',
          baseline: 1,
          current: 3,
          delta: 2,
          percent: 200,
        },
        {
          key: 'b',
          unit: 'count',
          baseline: 1,
          current: 2,
          delta: 1,
          percent: 100,
        },
      ],
    },
    { limit: 1 },
  );
  assert.deepEqual(limited.slice(1), [
    'MORE a | 1 count | 3 count | +2 (200.0%)',
    '... 1 more changed counter(s) in the comparison JSON',
  ]);
});

test('diagnostic replay passes artifact fields without a command shell', () => {
  const invocation = buildRegressionDiagnosticInvocation(
    'results/current & whoami.json',
    {
      profile: 'baseline & whoami',
      config: { concurrentChats: 8, preexistingWorktrees: 52 },
      environment: { windowVisible: false },
    },
    ['chats & whoami'],
    '/opt/pnpm/bin/pnpm.cjs',
  );

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(0, 7), [
    '/opt/pnpm/bin/pnpm.cjs',
    'run',
    'perf:desktop',
    '--profile',
    'baseline & whoami',
    '--scenarios',
    'chats & whoami',
  ]);
  assert.ok(invocation.args.includes('chats & whoami'));
  assert.ok(
    invocation.args.includes(
      path.join('results', 'current & whoami-regression-profile.json'),
    ),
  );
  assert.deepEqual(
    invocation.args.slice(
      invocation.args.indexOf('--preexisting-worktrees'),
      invocation.args.indexOf('--preexisting-worktrees') + 2,
    ),
    ['--preexisting-worktrees', '52'],
  );
});

test('diagnostic replay is offered only for compatible regressions', () => {
  assert.equal(
    canOfferRegressionDiagnostics({
      compatible: true,
      regressedScenarios: ['chats'],
    }),
    true,
  );
  assert.equal(
    canOfferRegressionDiagnostics({
      compatible: false,
      regressedScenarios: ['chats'],
    }),
    false,
  );
  assert.equal(
    canOfferRegressionDiagnostics({
      compatible: true,
      regressedScenarios: [],
    }),
    false,
  );
});

test('comparator diagnostics retain the exact recorded headed browser study preset', () => {
  const current = {
    profile: 'baseline',
    environment: {
      windowVisible: true,
      studyViewportPreset: 'headed-native-1000x640',
    },
  };
  const result = buildRegressionDiagnosticInvocation(
    '/tmp/current.json',
    current,
    ['browser-panels'],
    '/npm.js',
  );
  assert(result.args.includes('--headed'));
  assert.deepEqual(result.args.slice(-2), [
    '--browser-panels-viewport',
    '1000x640',
  ]);
  assert.throws(() =>
    buildRegressionDiagnosticInvocation(
      '/tmp/current.json',
      current,
      ['chats'],
      '/npm.js',
    ),
  );
});

test('comparator replay propagates headless study and rejects mixed or incomplete metadata', () => {
  const current = {
    profile: 'baseline',
    environment: {
      studyWindowMode: 'hidden-native-1400x900-v1',
      studyViewportPreset: 'hidden-native-1400x900-v1',
      windowVisible: false,
      viewport: { width: 1400, height: 900 },
    },
  };
  const run = (raw) =>
    buildRegressionDiagnosticInvocation(
      '/tmp/current.json',
      raw,
      ['browser-panels'],
      '/npm.js',
    );
  const invocation = run(current);
  assert(invocation.args.includes('--headless'));
  assert.deepEqual(invocation.args.slice(-2), [
    '--study-window-mode',
    'headless',
  ]);
  for (const delta of [
    { windowVisible: true },
    { studyWindowMode: undefined },
    { studyWindowMode: 'unknown' },
    { studyViewportPreset: 'headed-native-1000x640' },
    { viewport: { width: 1000, height: 640 } },
  ])
    assert.throws(() =>
      run({ ...current, environment: { ...current.environment, ...delta } }),
    );
});

test('code graph diagnostic replay preserves the measured corpus size', () => {
  const invocation = buildRegressionDiagnosticInvocation(
    'results/graph.json',
    {
      profile: 'baseline',
      config: {
        codeGraphBuildWorktrees: 3,
        codeGraphFixtureFilesPerWorktree: 3000,
      },
    },
    ['code-graph-concurrency'],
    '/opt/pnpm/bin/pnpm.cjs',
  );
  for (const [option, value] of [
    ['--code-graph-worktrees', '3'],
    ['--code-graph-files', '3000'],
  ]) {
    const index = invocation.args.indexOf(option);
    assert.notEqual(index, -1, `${option} must survive replay`);
    assert.equal(invocation.args[index + 1], value);
  }
});

const driverArgs = [
  '--interleaved',
  '--baseline-root',
  '/checkouts/base',
  '--candidate-root',
  '/checkouts/head',
  '--profile',
  'smoke',
  '--scenarios',
  'startup-settle,loaded-ui',
];

test('the interleaved driver names each build by checkout and shares one workload', () => {
  const plan = parseInterleavedArgs([
    ...driverArgs,
    '--repeat',
    '9',
    '--chats',
    '3',
    '--headless',
    '--alpha=0.01',
  ]);
  assert.equal(plan.baselineRoot, '/checkouts/base');
  assert.equal(plan.candidateRoot, '/checkouts/head');
  assert.equal(plan.repeat, 9);
  assert.equal(plan.order, 'abba');
  assert.equal(plan.releaseLike, false);
  assert.deepEqual(plan.verdictOptions, { alpha: 0.01 });
  assert.deepEqual(plan.runnerArgs, ['--chats', '3', '--headless']);
  assert.equal(plan.config.concurrentChats, 3);
  // Both sides get the same runner options; only the root differs per side.
  assert.deepEqual(runnerArgsFor(plan, ['loaded-ui']), [
    '--profile',
    'smoke',
    '--scenarios',
    'loaded-ui',
    '--no-diagnostics',
    '--chats',
    '3',
    '--headless',
  ]);
  const release = parseInterleavedArgs([...driverArgs, '--release-like']);
  assert.ok(runnerArgsFor(release, ['loaded-ui']).includes('--release-like'));
  assert.equal(parseInterleavedArgs(driverArgs).repeat, 7);
  assert.equal(parseInterleavedArgs(driverArgs).warmup, 1);
  assert.equal(
    parseInterleavedArgs([...driverArgs, '--warmup', '0']).warmup,
    0,
  );
});

test('the interleaved driver refuses options that would mix or taint the sides', () => {
  for (const option of [
    ['--output', 'x.json'],
    ['--release-like-root', '/x'],
    ['--e2e-root', '/x'],
    ['--headed'],
    ['--diagnose'],
    ['--git-attribution'],
    ['--startup-trace'],
    ['--live-startup-background'],
    ['--keep-data'],
  ])
    assert.throws(
      () => parseInterleavedArgs([...driverArgs, ...option]),
      /cannot be used with the interleaved driver/,
      option[0],
    );
  assert.throws(
    () => parseInterleavedArgs(driverArgs.slice(0, 3)),
    /--baseline-root and --candidate-root/,
  );
  assert.throws(
    () => parseInterleavedArgs(driverArgs.slice(0, 7)),
    /explicit --scenarios/,
  );
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--repeat', '1']),
    /at least 2/,
  );
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--warmup', '-1']),
    /--warmup/,
  );
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--order', 'random']),
    /--order/,
  );
  // Workload options are validated once, for both sides.
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--chats', '11']),
    /cannot exceed/,
  );
});

test('the interleaved schedule alternates which side launches first', () => {
  assert.deepEqual(
    interleavedSchedule(4).map(({ sides }) => sides.join('>')),
    [
      'baseline>candidate',
      'candidate>baseline',
      'baseline>candidate',
      'candidate>baseline',
    ],
  );
  assert.deepEqual(
    interleavedSchedule(3, 'alternate').map(({ sides }) => sides[0]),
    ['baseline', 'baseline', 'baseline'],
  );
});

test('each side launches its own bundle directory', () => {
  assert.equal(
    measuredBundleEntry('/c', false, {}),
    path.join('/c', 'out-e2e', 'main', 'index.js'),
  );
  assert.equal(
    measuredBundleEntry('/c', false, { CANOPY_E2E_OUT_DIR: 'out-e2e-x' }),
    path.join('/c', 'out-e2e-x', 'main', 'index.js'),
  );
  assert.equal(
    measuredBundleEntry('/c', true, {}),
    path.join('/c', 'out', 'main', 'index.js'),
  );
});

function sampleArtifact(scenario, wallMs, fields = {}) {
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'smoke',
    startedAt: `2026-09-30T00:00:0${Math.round(wallMs) % 10}.000Z`,
    completedAt: '2026-09-30T00:01:00.000Z',
    config: { startupSettleMs: 8000 },
    source: { measuredBuild: { root: '/checkouts/base', commit: 'abc' } },
    environment: { platform: 'darwin', windowVisible: false },
    caveats: ['e2e'],
    scenarios: [{ name: scenario, status: 'ok', durationMs: wallMs }],
    metrics: {
      [`${scenario}.wall_ms`]: {
        value: wallMs,
        unit: 'ms',
        kind: 'time',
        direction: 'lower',
        description: 'Complete scenario wall time',
      },
    },
    ...fields,
  };
}

const combineOptions = {
  count: 2,
  config: { startupSettleMs: 8000, pluginPickerPlugins: 170 },
  scenarios: ['startup-settle', 'loaded-ui'],
  label: 'interleaved baseline',
  interleaved: { side: 'baseline', order: 'abba' },
};

test('sample artifacts combine into the repeated-sample artifact shape', () => {
  const runs = [
    [1, 'loaded-ui', 60],
    [0, 'startup-settle', 1000],
    [0, 'loaded-ui', 50],
    [1, 'startup-settle', 1200],
  ].map(([sample, scenario, wallMs]) => ({
    sample,
    scenario,
    loadAverage: [sample + 1, 1, 1],
    artifact: sampleArtifact(scenario, wallMs),
  }));
  const combined = combineSampleArtifacts(runs, combineOptions);
  assert.equal(combined.repeat.count, 2);
  assert.deepEqual(combined.repeat.interleaved, {
    side: 'baseline',
    order: 'abba',
  });
  assert.deepEqual(
    combined.repeat.samples.map(({ index, loadAverage }) => [
      index,
      loadAverage[0],
    ]),
    [
      [0, 1],
      [1, 2],
    ],
  );
  assert.deepEqual(
    combined.scenarios.map(({ name, sample }) => `${sample}:${name}`),
    ['0:startup-settle', '0:loaded-ui', '1:startup-settle', '1:loaded-ui'],
  );
  assert.deepEqual(
    combined.metrics['startup-settle.wall_ms'].samples,
    [1000, 1200],
  );
  assert.equal(combined.metrics['startup-settle.wall_ms'].value, 1100);
  assert.deepEqual(combined.config, combineOptions.config);
  assert.equal(combined.benchmarkKind, 'e2e-relative');
  assert.equal(combined.caveats.length, 2);
});

test('combining refuses sample artifacts that mix kinds, builds or workloads', () => {
  const run = (sample, fields) => ({
    sample,
    scenario: 'loaded-ui',
    loadAverage: [1, 1, 1],
    artifact: sampleArtifact('loaded-ui', 50, fields),
  });
  for (const [fields, message] of [
    [{ benchmarkKind: 'release-like' }, /benchmarkKind/],
    [{ profile: 'baseline' }, /profile/],
    [
      { environment: { platform: 'darwin', windowVisible: true } },
      /environment.windowVisible/,
    ],
    [
      { source: { measuredBuild: { root: '/checkouts/head', commit: 'def' } } },
      /measured builds/,
    ],
    [{ config: { startupSettleMs: 15000 } }, /configuration: startupSettleMs/],
  ])
    assert.throws(
      () => combineSampleArtifacts([run(0), run(1, fields)], combineOptions),
      message,
    );
});

test('the repeated report prints verdicts, the headline and rerun guidance', () => {
  const side = (values) =>
    combineSampleArtifacts(
      values.map((wallMs, sample) => ({
        sample,
        scenario: 'loaded-ui',
        loadAverage: [4, 4, 4],
        artifact: sampleArtifact('loaded-ui', wallMs),
      })),
      { ...combineOptions, count: values.length, scenarios: ['loaded-ui'] },
    );
  const regressed = compareRepeatedPerformanceResults(
    side([500, 501, 502, 503, 504]),
    side([600, 601, 602, 603, 604]),
  );
  const lines = formatRepeatedComparisonLines(regressed, { profile: 'smoke' });
  assert.match(lines[0], /Mann-Whitney U with a Holm correction/);
  assert.match(lines[1], /baseline 5, candidate 5; 1-minute load average/);
  assert.match(lines[2], /geometric mean 1\.199x \(\+19\.9%\)/);
  assert.ok(lines.some((line) => line.startsWith('REGRESSED loaded-ui')));
  assert.ok(
    lines.some((line) => /^ {2}REGRESSED loaded-ui\.wall_ms/.test(line)),
  );
  assert.ok(
    lines.includes(
      '  Profile it: npm run perf:desktop -- --profile smoke --scenarios loaded-ui --diagnose',
    ),
  );
  assert.match(lines.at(-1), /^REGRESSED: 1 regressed, 0 improved/);

  const noisy = compareRepeatedPerformanceResults(
    side([500, 501]),
    side([600, 601]),
  );
  const noisyLines = formatRepeatedComparisonLines(noisy);
  assert.ok(noisyLines.some((line) => /Rerun: Underpowered/.test(line)));
  assert.match(noisyLines.at(-1), /^INCONCLUSIVE: 0 regressed/);
  assert.deepEqual(
    formatRepeatedComparisonLines({
      compatible: false,
      incompatibilities: ['profile'],
    }),
    ['Incompatible runs: profile'],
  );
});

test('the interleaved driver validates its own repeat and warm-up counts', () => {
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--repeat', '101']),
    /--repeat cannot exceed 100/,
  );
  assert.equal(
    parseInterleavedArgs([...driverArgs, '--repeat', '100']).repeat,
    100,
  );
  assert.throws(
    () => parseInterleavedArgs([...driverArgs, '--warmup', '101']),
    /--warmup cannot exceed 100/,
  );
  assert.equal(
    parseInterleavedArgs([...driverArgs, '--warmup', '100']).warmup,
    100,
  );
  assert.throws(
    () =>
      parseInterleavedArgs(
        driverArgs.map((arg) => (arg === 'smoke' ? 'counters' : arg)),
      ),
    /counters profile judges one run/,
  );
  // Children still run one launch each.
  const plan = parseInterleavedArgs(driverArgs);
  assert.ok(!runnerArgsFor(plan, ['loaded-ui']).includes('--repeat'));
});

const scopedPlanArgs = [
  ...driverArgs.slice(0, -1),
  'loaded-ui,multi-chat-streaming',
];

test('a scenario-scoped override reaches only the scenarios that own it', () => {
  const plan = parseInterleavedArgs([
    ...scopedPlanArgs,
    '--multi-chat-streaming-ms',
    '5000',
  ]);
  assert.equal(plan.config.multiChatStreamingMs, 5000);
  assert.deepEqual(runnerArgsFor(plan, ['loaded-ui']), [
    '--profile',
    'smoke',
    '--scenarios',
    'loaded-ui',
    '--no-diagnostics',
  ]);
  assert.deepEqual(runnerArgsFor(plan, ['multi-chat-streaming']), [
    '--profile',
    'smoke',
    '--scenarios',
    'multi-chat-streaming',
    '--no-diagnostics',
    '--multi-chat-streaming-ms',
    '5000',
  ]);
  // The inline form is scoped the same way.
  const inline = parseInterleavedArgs([
    ...scopedPlanArgs,
    '--multi-chat-streaming-ms=5000',
  ]);
  assert.ok(
    !runnerArgsFor(inline, ['loaded-ui']).some((arg) =>
      arg.startsWith('--multi-chat'),
    ),
  );
  assert.equal(
    plan.scenarioConfigs['loaded-ui'].multiChatStreamingMs,
    undefined,
  );
  assert.equal(
    plan.scenarioConfigs['multi-chat-streaming'].multiChatStreamingMs,
    5000,
  );
});

test('scenario-scoped switches reach only the scenarios that read them', () => {
  const plan = parseInterleavedArgs([
    ...driverArgs.slice(0, -1),
    'loaded-ui,chat-switch-catch-up,background-streaming',
    '--cold-background-streams',
    '--chat-switch-hover-ms',
    '250',
  ]);
  assert.deepEqual(runnerArgsFor(plan, ['loaded-ui']), [
    '--profile',
    'smoke',
    '--scenarios',
    'loaded-ui',
    '--no-diagnostics',
  ]);
  assert.ok(
    runnerArgsFor(plan, ['background-streaming']).includes(
      '--cold-background-streams',
    ),
  );
  assert.equal(
    plan.scenarioConfigs['chat-switch-catch-up'].chatSwitchHoverMs,
    250,
  );
  assert.equal(plan.scenarioConfigs['loaded-ui'].chatSwitchHoverMs, undefined);
  assert.throws(
    () =>
      parseInterleavedArgs([...driverArgs, '--chat-switch-hover-ms', '250']),
    /--chat-switch-hover-ms option requires the chat-switch-catch-up/,
  );
});

test('the up-front check rejects a scoped override no requested scenario owns', () => {
  assert.throws(
    () =>
      parseInterleavedArgs([
        ...driverArgs,
        '--multi-chat-streaming-ms',
        '5000',
      ]),
    /--multi-chat-streaming-ms option requires the multi-chat-streaming/,
  );
});

test('sample artifacts are checked against their own scenario configuration', () => {
  const scenarioConfigs = {
    'loaded-ui': { startupSettleMs: 8000 },
    'multi-chat-streaming': {
      startupSettleMs: 8000,
      multiChatStreamingMs: 5000,
    },
  };
  const options = {
    count: 1,
    config: { startupSettleMs: 8000, multiChatStreamingMs: 5000 },
    scenarioConfigs,
    scenarios: ['loaded-ui', 'multi-chat-streaming'],
    label: 'interleaved baseline',
    interleaved: { side: 'baseline', order: 'abba' },
  };
  const run = (scenario, config) => ({
    sample: 0,
    scenario,
    loadAverage: [1, 1, 1],
    artifact: sampleArtifact(scenario, 50, { config }),
  });
  const combined = combineSampleArtifacts(
    [
      run('loaded-ui', scenarioConfigs['loaded-ui']),
      run('multi-chat-streaming', scenarioConfigs['multi-chat-streaming']),
    ],
    options,
  );
  assert.equal(combined.config.multiChatStreamingMs, 5000);
  // A scoped key a scenario should carry but lacks, or carries wrongly, mixes.
  assert.throws(
    () =>
      combineSampleArtifacts(
        [run('multi-chat-streaming', scenarioConfigs['loaded-ui'])],
        options,
      ),
    /configuration: multiChatStreamingMs/,
  );
  assert.throws(
    () =>
      combineSampleArtifacts(
        [run('loaded-ui', scenarioConfigs['multi-chat-streaming'])],
        options,
      ),
    /configuration: multiChatStreamingMs/,
  );
});

test('baseline and candidate configurations are compared per scenario', () => {
  const side = (configs) =>
    Object.entries(configs).map(([scenario, config]) => ({
      sample: 0,
      scenario,
      loadAverage: [1, 1, 1],
      artifact: sampleArtifact(scenario, 50, { config }),
    }));
  const same = {
    'loaded-ui': { startupSettleMs: 8000 },
    'multi-chat-streaming': {
      startupSettleMs: 8000,
      multiChatStreamingMs: 5000,
    },
  };
  assert.doesNotThrow(() =>
    assertMatchedScenarioConfigs(side(same), side(same)),
  );
  assert.throws(
    () =>
      assertMatchedScenarioConfigs(
        side(same),
        side({
          ...same,
          'multi-chat-streaming': {
            startupSettleMs: 8000,
            multiChatStreamingMs: 9000,
          },
        }),
      ),
    /multi-chat-streaming.*multiChatStreamingMs/,
  );
});

test('the repeated report names every failed or unresponsive sample', () => {
  const side = (statuses) =>
    combineSampleArtifacts(
      statuses.map((status, sample) => ({
        sample,
        scenario: 'loaded-ui',
        loadAverage: [4, 4, 4],
        artifact: sampleArtifact('loaded-ui', 500 + sample, {
          scenarios: [{ name: 'loaded-ui', status, durationMs: 500 + sample }],
        }),
      })),
      { ...combineOptions, count: statuses.length, scenarios: ['loaded-ui'] },
    );
  const comparison = compareRepeatedPerformanceResults(
    side(['ok', 'ok', 'unresponsive', 'ok', 'ok']),
    side(['ok', 'error', 'ok', 'ok', 'ok']),
  );
  assert.equal(comparison.passed, false);
  const lines = formatRepeatedComparisonLines(comparison);
  const report = lines.join('\n');
  assert.match(report, /FAILED: 2 sample\(s\) did not run cleanly/);
  assert.match(report, /baseline loaded-ui sample 3: unresponsive/);
  assert.match(report, /candidate loaded-ui sample 2: error/);
  assert.match(lines.at(-1), /^(INCONCLUSIVE|REGRESSED|IMPROVED): /);
  const clean = compareRepeatedPerformanceResults(
    side(['ok', 'ok', 'ok', 'ok', 'ok']),
    side(['ok', 'ok', 'ok', 'ok', 'ok']),
  );
  assert.ok(
    !formatRepeatedComparisonLines(clean).join('\n').includes('FAILED'),
  );
});

test('diagnostic replay runs a native pnpm executable directly', () => {
  const invocation = buildRegressionDiagnosticInvocation(
    'results/current.json',
    { profile: 'smoke', config: {}, environment: { windowVisible: false } },
    ['chats'],
    '/corepack/pnpm/12.11.2/pnpm-native',
  );
  assert.equal(invocation.command, '/corepack/pnpm/12.11.2/pnpm-native');
  assert.deepEqual(invocation.args.slice(0, 4), [
    'run',
    'perf:desktop',
    '--profile',
    'smoke',
  ]);
});

test('the interleaved driver rejects incomplete local smoke artifacts before combining them', () => {
  const artifact = sampleArtifact('loaded-ui', 50, {
    acceptancePolicy: 'local-smoke-v1',
  });
  delete artifact.completedAt;
  assert.throws(
    () =>
      combineSampleArtifacts(
        [
          {
            sample: 0,
            scenario: 'loaded-ui',
            loadAverage: [1, 1, 1],
            artifact,
          },
        ],
        { ...combineOptions, count: 1, scenarios: ['loaded-ui'] },
      ),
    /incomplete/i,
  );
});
