import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePerformanceResults,
  compareRepeatedPerformanceResults,
} from './comparison.mjs';

function result(value, overrides = {}) {
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'smoke',
    config: { concurrentChats: 2 },
    environment: { windowVisible: false },
    scenarios: [{ name: 'chats', status: 'ok' }],
    metrics: {
      'chats.ipc.outer.p95_ms': { value, unit: 'ms', direction: 'lower' },
    },
    ...overrides,
  };
}

test('comparison flags a material relative regression', () => {
  const comparison = comparePerformanceResults(result(100), result(130));
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.regressions.length, 1);
  assert.deepEqual(comparison.regressedScenarios, ['chats']);
});

test('comparison flags a regression from a negative signed baseline', () => {
  const comparison = comparePerformanceResults(result(-100), result(-60));

  assert.equal(comparison.passed, false);
  assert.equal(comparison.regressions.length, 1);
  assert.equal(comparison.regressions[0]?.percent, 40);
});

test('comparison ignores timing noise below the absolute floor', () => {
  const comparison = comparePerformanceResults(result(5), result(10));
  assert.equal(comparison.passed, true);
  assert.equal(comparison.regressions.length, 0);
});

test('comparison honors a metric-specific floor for low-latency input signals', () => {
  const baseline = result(2);
  const current = result(4);
  baseline.metrics['chats.ipc.outer.p95_ms'].minRegressionAbsolute = 1;
  current.metrics['chats.ipc.outer.p95_ms'].minRegressionAbsolute = 1;

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.passed, false);
  assert.equal(comparison.regressions.length, 1);
});

test('comparison rejects artifacts from different benchmark schemas', () => {
  const comparison = comparePerformanceResults(
    result(100, { schemaVersion: 1 }),
    result(100),
  );
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['schemaVersion']);
});

test('comparison rejects mismatched workloads', () => {
  const comparison = comparePerformanceResults(
    result(100),
    result(100, { config: { concurrentChats: 8 } }),
  );
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['config']);
  assert.equal(comparison.passed, false);
});

test('comparison rejects failed scenarios and missing metrics', () => {
  const current = result(100);
  current.scenarios[0].status = 'error';
  current.metrics = {};
  const comparison = comparePerformanceResults(result(100), current);
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['scenarioStatus', 'metrics']);
});

test('comparison rejects diagnostic-only scenario artifacts', () => {
  const current = result(100);
  current.scenarios[0].status = 'diagnostic';

  const comparison = comparePerformanceResults(result(100), current);

  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['scenarioStatus']);
  assert.equal(comparison.passed, false);
});

test('comparison rejects metrics present only in the current result', () => {
  const current = result(100);
  current.metrics['chats.renderer.frame_delay.max_ms'] = {
    value: 25,
    unit: 'ms',
    direction: 'lower',
  };
  const comparison = comparePerformanceResults(result(100), current);
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['metrics']);
});

test('comparison normalizes the legacy omitted zero long-task maximum', () => {
  const baseline = result(100);
  baseline.metrics['chats.renderer.long_tasks.count'] = {
    value: 0,
    unit: 'count',
    direction: 'lower',
  };
  const current = structuredClone(baseline);
  current.metrics['chats.renderer.long_tasks.max_ms'] = {
    value: 0,
    unit: 'ms',
    direction: 'lower',
  };

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.passed, true);
});

function withWork(
  raw,
  counts,
  work = { transcript: {}, chromium: {} },
  tasks = undefined,
) {
  raw.scenarios[0].work = work;
  if (tasks) raw.scenarios[0].tasks = tasks;
  for (const [key, value] of Object.entries(counts)) {
    raw.metrics[key] = {
      value,
      unit: key.endsWith('_bytes') ? 'bytes' : 'count',
      kind: 'count',
      direction: 'lower',
      description: key,
    };
  }
  return raw;
}

test('work counters never pass through the relative timing rule', () => {
  const baseline = withWork(result(100), {
    'chats.work.chromium.LayoutCount': 100,
    'chats.work.transcript.counters.loaded_bytes': 1_000,
  });
  const current = withWork(result(100), {
    'chats.work.chromium.LayoutCount': 150,
    'chats.work.transcript.counters.loaded_bytes': 1_000,
  });

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(
    comparison.comparisons.map((entry) => entry.key),
    ['chats.ipc.outer.p95_ms'],
  );
  assert.deepEqual(comparison.workComparisons, [
    {
      key: 'chats.work.chromium.LayoutCount',
      unit: 'count',
      baseline: 100,
      current: 150,
      delta: 50,
      percent: 50,
    },
    {
      key: 'chats.work.transcript.counters.loaded_bytes',
      unit: 'bytes',
      baseline: 1_000,
      current: 1_000,
      delta: 0,
      percent: 0,
    },
  ]);
});

function bracketedTask(kind, work = { transcript: {}, chromium: {} }) {
  return { kind, status: 'ok', work };
}

test('work counters absent from one collected run compare as zero', () => {
  // Both runs bracketed every task of both kinds, so a counter one run never
  // moved is a measured zero there.
  const tasks = [bracketedTask('open_chat'), bracketedTask('type_in_chat')];
  const baseline = withWork(
    result(100),
    { 'chats.work.task.open_chat.transcript.turn_grouping.count': 2 },
    undefined,
    tasks,
  );
  const current = withWork(
    result(100),
    { 'chats.work.task.type_in_chat.transcript.turn_grouping.count': 1 },
    undefined,
    tasks,
  );

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, true);
  assert.deepEqual(
    comparison.workComparisons.map(({ key, baseline, current, delta }) => [
      key,
      baseline,
      current,
      delta,
    ]),
    [
      ['chats.work.task.open_chat.transcript.turn_grouping.count', 2, 0, -2],
      ['chats.work.task.type_in_chat.transcript.turn_grouping.count', 0, 1, 1],
    ],
  );
  assert.equal(comparison.workComparisons[0].percent, -100);
  assert.equal(comparison.workComparisons[1].percent, null);
});

test('task work counters stay unavailable unless both runs bracketed every task of that kind', () => {
  const baseline = withWork(
    result(100),
    { 'chats.work.task.open_chat.transcript.turn_grouping.count': 2 },
    undefined,
    [bracketedTask('open_chat')],
  );
  // A renamed task leaves no open_chat work to measure as zero.
  const renamed = withWork(result(100), {}, undefined, [
    bracketedTask('open_chat_cold'),
  ]);
  // One open_chat task lost its transcript bracket, so the kind's sum would
  // be partial.
  const partial = withWork(result(100), {}, undefined, [
    bracketedTask('open_chat'),
    bracketedTask('open_chat', { chromium: {} }),
  ]);

  for (const current of [renamed, partial]) {
    const comparison = comparePerformanceResults(baseline, current);
    assert.equal(comparison.compatible, true);
    assert.deepEqual(comparison.workComparisons, []);
    assert.deepEqual(comparison.workUnavailable, [
      'chats.work.task.open_chat.transcript',
    ]);
  }
});

test('work counters from a run that did not collect them stay unavailable, not incompatible', () => {
  // A baseline from before the work-metric layer has only timings.
  const baseline = result(100);
  const current = withWork(
    result(100),
    {
      'chats.work.chromium.LayoutCount': 12,
      'chats.work.transcript.counters.page_installs': 1,
    },
    { transcript: {}, errors: [{ source: 'chromium', message: 'timeout' }] },
  );

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.workComparisons, []);
  assert.deepEqual(comparison.workUnavailable, [
    'chats.work.chromium',
    'chats.work.transcript',
  ]);
});

test('artifacts without a metric kind compare as timings beside explicit time kinds', () => {
  const baseline = result(100);
  const current = result(130);
  current.metrics['chats.ipc.outer.p95_ms'].kind = 'time';

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.regressions.length, 1);
});

test('a metric that changes kind between runs is incompatible', () => {
  const baseline = result(100);
  const current = result(100);
  current.metrics['chats.ipc.outer.p95_ms'].kind = 'count';

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['metrics']);
});

test('a metric kind the comparator does not know is incompatible, not ignored', () => {
  const baseline = result(100);
  const current = result(100);
  for (const raw of [baseline, current]) {
    raw.metrics['chats.work.chromium.LayoutRatio'] = {
      value: 1.1,
      unit: 'ratio',
      kind: 'ratio',
      direction: 'lower',
    };
  }

  const comparison = comparePerformanceResults(baseline, current);

  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['metrics']);
});

test('comparison rejects mixing headless and headed runs', () => {
  const comparison = comparePerformanceResults(
    result(100),
    result(100, { environment: { windowVisible: true } }),
  );
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.incompatibilities, ['environment']);
});

test('comparison rejects unknown or missing study mode and absent native evidence even on both inputs', () => {
  const baseline = result(100, {
    environment: {
      windowVisible: false,
      viewport: { width: 1400, height: 900 },
      studyWindowMode: 'hidden-native-1400x900-v1',
      studyViewportPreset: 'hidden-native-1400x900-v1',
    },
  });
  assert.equal(
    comparePerformanceResults(baseline, structuredClone(baseline)).compatible,
    false,
  );
  for (const mode of [undefined, 'unknown', 'headed-native-1000x640']) {
    const current = structuredClone(baseline);
    current.environment.studyWindowMode = mode;
    assert.equal(
      comparePerformanceResults(baseline, current).compatible,
      false,
    );
  }
});

test('matched hidden study comparison retains mode and unchanged thresholds before any metric analysis', () => {
  const state = {
    id: 1,
    webContentsId: 2,
    rendererPid: 3,
    url: 'file:///app/index.html',
    nativeUrl: 'file:///app/index.html',
    ownerMatches: true,
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    documentVisible: true,
    documentFocused: false,
    viewport: { width: 1400, height: 900 },
    contentBounds: { width: 1400, height: 900 },
  };
  const mode = 'hidden-native-1400x900-v1';
  const baseline = result(100, {
    environment: {
      studyWindowMode: mode,
      studyViewportPreset: mode,
      windowVisible: false,
      viewport: state.viewport,
    },
    scenarios: [
      {
        name: 'browser-panels',
        status: 'ok',
        windowEvidence: {
          mode,
          windowVisible: false,
          viewport: state.viewport,
          setup: { status: 'ready', before: state, after: state },
          atStart: state,
          atEnd: state,
        },
      },
    ],
  });
  const comparison = comparePerformanceResults(
    baseline,
    structuredClone(baseline),
    { maxRegressionPercent: 10, minRegressionMs: 20 },
  );
  assert.equal(comparison.passed, true);
  assert.equal(comparison.studyWindowMode, mode);
  assert.deepEqual(comparison.thresholds, {
    maxRegressionPercent: 10,
    minRegressionMs: 20,
  });
  for (const mutate of [
    (raw) => delete raw.environment.studyWindowMode,
    (raw) => delete raw.environment.studyViewportPreset,
    (raw) => (raw.environment.viewport.height = 640),
    (raw) => (raw.scenarios[0].windowEvidence.atEnd.visible = true),
    (raw) => (raw.scenarios[0].windowEvidence.setup.status = 'failed'),
  ]) {
    const current = structuredClone(baseline);
    mutate(current);
    Object.defineProperty(current, 'metrics', {
      get() {
        throw new Error('Must reject mode/evidence before metric analysis');
      },
    });
    assert.equal(comparePerformanceResults(baseline, current).passed, false);
  }
});

test('headless comparisons reject empty scenarios and unknown study presets', () => {
  const mode = 'hidden-native-1400x900-v1';
  for (const preset of [mode, 'unknown']) {
    const raw = result(100, {
      scenarios: [],
      environment: {
        studyViewportPreset: preset,
        windowVisible: false,
        viewport: { width: 1400, height: 900 },
        ...(preset === mode ? { studyWindowMode: mode } : {}),
      },
    });
    assert.equal(
      comparePerformanceResults(raw, structuredClone(raw)).compatible,
      false,
    );
  }
});

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A repeated-sample artifact with `samples[key]` timings per sample. */
function repeated(samples, { statuses = {}, counts = {}, ...overrides } = {}) {
  const count = Object.values(samples)[0].length;
  const names = [
    ...new Set(Object.keys(samples).map((key) => key.split('.')[0])),
  ];
  const metric = (value, fields) => ({
    value: median(value),
    direction: 'lower',
    samples: value,
    ...fields,
  });
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'smoke',
    config: { concurrentChats: 2 },
    environment: { windowVisible: false },
    repeat: {
      count,
      samples: Array.from({ length: count }, (_, index) => ({
        index,
        loadAverage: [3 + index, 3, 3],
      })),
    },
    scenarios: names.flatMap((name) =>
      Array.from({ length: count }, (_, sample) => ({
        name,
        sample,
        status: statuses[name]?.[sample] ?? 'ok',
        work: { chromium: {} },
        tasks: [],
      })),
    ),
    metrics: {
      ...Object.fromEntries(
        Object.entries(samples).map(([key, value]) => [
          key,
          metric(value, { unit: 'ms', kind: 'time' }),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(counts).map(([key, value]) => [
          key,
          metric(value, { unit: 'count', kind: 'count' }),
        ]),
      ),
    },
    ...overrides,
  };
}

const steady = (start, count = 7) =>
  Array.from({ length: count }, (_, index) => start + index);

test('repeated comparison: a clear regression is regressed and fails', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(500) }),
    repeated({ 'chats.wall_ms': steady(560) }),
  );
  assert.equal(comparison.mode, 'repeated');
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.verdict, 'regressed');
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressedScenarios, ['chats']);
  assert.equal(comparison.scenarios[0].metrics[0].verdict, 'regressed');
  assert.ok(Math.abs(comparison.headline.ratio - 563 / 503) < 1e-9);
  assert.deepEqual(comparison.hostLoad.baseline, { min: 3, max: 9 });
});

test('repeated comparison: a clear improvement is improved and passes', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(560) }),
    repeated({ 'chats.wall_ms': steady(500) }),
  );
  assert.equal(comparison.verdict, 'improved');
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.improvedScenarios, ['chats']);
});

test('repeated comparison: the same samples on both sides are inconclusive', () => {
  const samples = { 'chats.wall_ms': [510, 530, 500, 520, 505, 525, 515] };
  const comparison = compareRepeatedPerformanceResults(
    repeated(samples),
    repeated({ 'chats.wall_ms': [515, 500, 530, 505, 520, 510, 525] }),
  );
  assert.equal(comparison.verdict, 'inconclusive');
  assert.equal(comparison.passed, true);
  assert.ok(comparison.scenarios[0].guidance.length > 0);
});

test('repeated comparison: failed samples are left out and counted', () => {
  const candidate = steady(500);
  candidate[2] = 90_000;
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(500) }),
    repeated(
      { 'chats.wall_ms': candidate },
      { statuses: { chats: ['ok', 'ok', 'error'] } },
    ),
  );
  const [scenario] = comparison.scenarios;
  assert.deepEqual(scenario.excludedSamples, { baseline: 0, candidate: 1 });
  assert.deepEqual(scenario.sampleStatuses.candidate, { ok: 6, error: 1 });
  assert.equal(scenario.metrics[0].candidate.count, 6);
  assert.equal(scenario.metrics[0].candidate.max, 506);
  assert.notEqual(scenario.verdict, 'regressed');
  assert.match(scenario.guidance.join('\n'), /1 candidate sample\(s\) failed/);
});

test('repeated comparison: single-sample artifacts are underpowered, not judged', () => {
  const single = (value) => ({
    ...result(value),
    metrics: {
      'chats.wall_ms': { value, unit: 'ms', kind: 'time', direction: 'lower' },
    },
  });
  const comparison = compareRepeatedPerformanceResults(
    single(100),
    single(400),
  );
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.verdict, 'inconclusive');
  assert.equal(comparison.scenarios[0].metrics[0].reason, 'underpowered');
  assert.match(comparison.scenarios[0].guidance[0], /--repeat 4 or more/);
});

test('repeated comparison refuses mixed kinds, profiles and configurations', () => {
  const base = repeated({ 'chats.wall_ms': steady(500) });
  for (const [field, value] of [
    ['benchmarkKind', 'release-like'],
    ['profile', 'baseline'],
    ['config', { concurrentChats: 4 }],
  ]) {
    const comparison = compareRepeatedPerformanceResults(
      base,
      repeated({ 'chats.wall_ms': steady(900) }, { [field]: value }),
    );
    assert.equal(comparison.compatible, false, field);
    assert.ok(comparison.incompatibilities.includes(field), field);
    assert.equal(comparison.passed, false);
    assert.equal(comparison.verdict, 'inconclusive');
    assert.deepEqual(comparison.scenarios, []);
  }
  const study = compareRepeatedPerformanceResults(
    base,
    repeated(
      { 'chats.wall_ms': steady(500) },
      { environment: { windowVisible: false, studyWindowMode: 'x' } },
    ),
  );
  assert.ok(study.incompatibilities.includes('study'));
});

test('repeated comparison accepts different sample counts per side', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(500, 7) }),
    repeated({ 'chats.wall_ms': steady(560, 8) }),
  );
  assert.equal(comparison.compatible, true);
  assert.deepEqual(comparison.samples, { baseline: 7, candidate: 8 });
  assert.equal(comparison.verdict, 'regressed');
});

test('repeated comparison reports work counters exactly and never judges them', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated(
      { 'chats.wall_ms': steady(500) },
      { counts: { 'chats.work.chromium.LayoutCount': Array(7).fill(100) } },
    ),
    repeated(
      { 'chats.wall_ms': steady(500) },
      { counts: { 'chats.work.chromium.LayoutCount': Array(7).fill(400) } },
    ),
  );
  assert.equal(comparison.verdict, 'inconclusive');
  assert.deepEqual(comparison.workComparisons, [
    {
      key: 'chats.work.chromium.LayoutCount',
      unit: 'count',
      baseline: 100,
      current: 400,
      delta: 300,
      percent: 300,
    },
  ]);
  assert.equal(comparison.scenarios[0].tests, 1);
});

test('the flat single-sample comparison still reads repeated artifacts by their medians', () => {
  const comparison = comparePerformanceResults(
    repeated({ 'chats.wall_ms': steady(500) }),
    repeated({ 'chats.wall_ms': steady(700) }),
  );
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.comparisons[0].baseline, 503);
  assert.equal(comparison.comparisons[0].current, 703);
  assert.equal(comparison.passed, false);
});

test('repeated comparison: a failed sample fails the comparison and is named', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(500) }),
    repeated(
      { 'chats.wall_ms': steady(500) },
      { statuses: { chats: ['ok', 'ok', 'error'] } },
    ),
  );
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.verdict, 'inconclusive');
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.nonOkSamples, {
    baseline: [],
    candidate: [{ scenario: 'chats', sample: 2, status: 'error' }],
  });
});

test('repeated comparison: an unresponsive sample fails the comparison but still counts', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated(
      { 'chats.wall_ms': steady(500) },
      { statuses: { chats: ['ok', 'unresponsive'] } },
    ),
    repeated({ 'chats.wall_ms': steady(500) }),
  );
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.nonOkSamples, {
    baseline: [{ scenario: 'chats', sample: 1, status: 'unresponsive' }],
    candidate: [],
  });
  // The slow sample's timing is still judged.
  assert.equal(comparison.scenarios[0].metrics[0].baseline.count, 7);
});

test('repeated comparison: a clean pair passes with no non-ok samples', () => {
  const comparison = compareRepeatedPerformanceResults(
    repeated({ 'chats.wall_ms': steady(500) }),
    repeated({ 'chats.wall_ms': steady(500) }),
  );
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.nonOkSamples, { baseline: [], candidate: [] });
});

test('repeated comparison: a metric with no comparable sample has a null value and is not counted', () => {
  const failed = repeated(
    { 'chats.wall_ms': steady(500, 2) },
    {
      counts: { 'chats.work.chromium.LayoutCount': [100, 100] },
      statuses: { chats: ['error', 'error'] },
    },
  );
  for (const metric of Object.values(failed.metrics)) metric.value = null;
  const comparison = compareRepeatedPerformanceResults(
    failed,
    repeated(
      { 'chats.wall_ms': steady(500, 2) },
      { counts: { 'chats.work.chromium.LayoutCount': [100, 100] } },
    ),
  );
  assert.equal(comparison.scenarios[0].tests, 0);
  // A null representative value is not read as a zero count.
  assert.deepEqual(comparison.workComparisons, []);
  assert.equal(comparison.passed, false);
});

function localSmokeRepeated(start, { load = 2, count = 7 } = {}) {
  const result = repeated({ 'chats.wall_ms': steady(start, count) });
  result.acceptancePolicy = 'local-smoke-v1';
  result.startedAt = '2026-10-09T00:00:00.000Z';
  result.completedAt = '2026-10-09T00:01:00.000Z';
  result.requestedScenarios = ['chats'];
  result.repeat.interleaved = {
    order: 'abba',
    runId: 'matched-run',
    warmup: 1,
  };
  result.environment.hostname = 'same-host';
  for (const scenario of result.scenarios) {
    scenario.durationMs = start;
    scenario.status = 'unresponsive';
    scenario.responsiveness = {
      passed: false,
      violations: [
        { metric: 'renderer.frame_delay.max_ms', value: 180, budgetMs: 100 },
      ],
    };
    scenario.hostMeasurement = {
      version: 1,
      platform: 'darwin',
      logicalCpuCount: 8,
      intervalMs: 1000,
      errors: [],
      samples: [
        { elapsedMs: 0, loadAverage: [load, load, load] },
        { elapsedMs: 1000, loadAverage: [load, load, load] },
      ],
    };
  }
  return result;
}

test('local smoke comparison allows unchanged slow builds and retains absolute breaches', () => {
  const comparison = compareRepeatedPerformanceResults(
    localSmokeRepeated(500),
    localSmokeRepeated(500),
  );
  assert.equal(comparison.passed, true);
  assert.equal(comparison.acceptance.verdict, 'pass');
  assert.equal(comparison.acceptance.absoluteLatency, 'exceeded');
  assert.equal(comparison.nonOkSamples.baseline.length, 7);
});

test('local smoke comparison still rejects a known regression', () => {
  const comparison = compareRepeatedPerformanceResults(
    localSmokeRepeated(500),
    localSmokeRepeated(900),
  );
  assert.equal(comparison.passed, false);
  assert.equal(comparison.acceptance.verdict, 'fail');
});

test('local smoke comparison reports saturation as inconclusive, without deleting samples', () => {
  const baseline = localSmokeRepeated(500);
  const candidate = localSmokeRepeated(900, { load: 9 });
  const comparison = compareRepeatedPerformanceResults(baseline, candidate);
  assert.equal(comparison.verdict, 'inconclusive');
  assert.equal(comparison.acceptance.verdict, 'inconclusive');
  assert.equal(comparison.passed, false);
  assert.match(comparison.acceptance.reasons.join(' '), /load/);
  assert.equal(candidate.scenarios.length, 7);
});

test('local smoke comparison cannot accept underpowered, unmatched or missing host evidence', () => {
  for (const mutate of [
    (r) => {
      delete r.scenarios[0].hostMeasurement;
    },
    (r) => {
      delete r.repeat.interleaved;
    },
    (r) => {
      r.environment.hostname = 'other-host';
    },
    (r) => {
      r.scenarios[0].status = 'error';
    },
  ]) {
    const candidate = localSmokeRepeated(500);
    mutate(candidate);
    assert.equal(
      compareRepeatedPerformanceResults(localSmokeRepeated(500), candidate)
        .passed,
      false,
    );
  }
  assert.equal(
    compareRepeatedPerformanceResults(
      localSmokeRepeated(500, { count: 2 }),
      localSmokeRepeated(500, { count: 2 }),
    ).passed,
    false,
  );
});

test('local smoke comparisons reject unrelated batches, missing samples, and hidden liveness failures', () => {
  for (const mutate of [
    (r) => {
      r.repeat.interleaved.runId = 'another-run';
    },
    (r) => {
      r.repeat.interleaved.warmup = 0;
    },
    (r) => {
      r.scenarios.pop();
    },
    (r) => {
      r.scenarios[0].hostMeasurement.samples[1].elapsedMs = 1;
    },
    (r) => {
      r.scenarios[0].responsiveness.violations.push({
        metric: 'ipc.error_count',
        value: 1,
      });
    },
    (r) => {
      r.scenarios[0].error = 'cleanup failed';
    },
    (r) => {
      r.metrics['chats.wall_ms'].samples[0] = null;
    },
  ]) {
    const candidate = localSmokeRepeated(500);
    mutate(candidate);
    assert.equal(
      compareRepeatedPerformanceResults(localSmokeRepeated(500), candidate)
        .passed,
      false,
    );
  }
});

test('local smoke requires the same number of paired samples on both sides', () => {
  const result = compareRepeatedPerformanceResults(
    localSmokeRepeated(500),
    localSmokeRepeated(500, { count: 8 }),
  );
  assert.equal(result.passed, false);
  assert.equal(result.acceptance.verdict, 'inconclusive');
});
