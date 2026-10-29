import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkQualification,
  evaluateWorkRatchet,
  formatWorkRatchetVerdict,
  judgeWorkRatchet,
  readWorkRatchetInputs,
  summarizeWorkDeterminism,
  validateWorkCeilings,
  validateWorkMetricRegistry,
  workRatchetFingerprint,
} from './work-ratchet.mjs';

const LAYOUT = 'stress-transcript.work.chromium.LayoutCount';
const GROUPING = 'stress-transcript.work.transcript.turn_grouping.count';
const STREAM_LAYOUT = 'transcript-streaming-tail.work.chromium.LayoutCount';
const TASK_LAYOUT =
  'stress-transcript.work.task.open_stress_transcript_warm.chromium.LayoutCount';

function artifact({
  metrics = {},
  work = { transcript: {}, chromium: {} },
  scenarios = ['stress-transcript'],
  status = 'ok',
  config = { interactionIterations: 2 },
  environment = {},
  commit = 'abc123',
} = {}) {
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'counters',
    config,
    source: { commit, dirty: false },
    environment: {
      platform: 'darwin',
      architecture: 'arm64',
      electronVersion: '42.0.0',
      viewport: { width: 1400, height: 900 },
      windowVisible: false,
      ...environment,
    },
    scenarios: scenarios.map((name) => ({
      name,
      status,
      ...(work ? { work } : {}),
    })),
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [
        key,
        {
          value,
          unit: 'count',
          kind: 'count',
          direction: 'lower',
          description: key,
        },
      ]),
    ),
  };
}

function qualification(overrides = {}) {
  return {
    id: 'explore',
    date: '2026-09-28',
    platform: 'darwin-arm64',
    profile: 'counters',
    runs: 5,
    commits: ['abc123'],
    scenarios: ['stress-transcript'],
    ...overrides,
  };
}

function registry(metrics, extra = {}) {
  return {
    version: 1,
    scenarios: {
      'stress-transcript': { variant: 'sequential' },
      'transcript-streaming-tail': { variant: 'concurrent' },
    },
    qualifications: [qualification()],
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, entry]) => [
        key,
        {
          status: 'advisory',
          tolerancePercent: 1,
          determinism: [
            {
              qualification: 'explore',
              min: 10,
              max: 10,
              median: 10,
              spreadPercent: 0,
            },
          ],
          correlation: [],
          ...entry,
        },
      ]),
    ),
    ...extra,
  };
}

function ceilings(scenarios, fingerprint = workRatchetFingerprint(artifact())) {
  return {
    version: 1,
    profile: 'counters',
    platforms: {
      'darwin-arm64': { ...fingerprint, qualification: 'explore', scenarios },
    },
  };
}

function admittedGating(extra = {}) {
  return {
    status: 'gating',
    determinism: [
      {
        qualification: 'admit',
        min: 10,
        max: 10,
        median: 10,
        spreadPercent: 0,
      },
    ],
    correlation: [
      {
        summary: 'Fewer groupings lowered open_stress_transcript_warm p50',
        commits: ['aaa', 'bbb'],
      },
    ],
    ...extra,
  };
}

function withAdmission(value, scenarios = ['stress-transcript']) {
  value.qualifications.push(
    qualification({ id: 'admit', runs: 10, scenarios }),
  );
  return value;
}

test('the checked-in registry and ceilings are valid and consistent', () => {
  const inputs = readWorkRatchetInputs();
  assert.equal(inputs.registry.version, 1);
  assert.equal(inputs.ceilings.version, 1);
  assert.equal(inputs.ceilings.profile, 'counters');
});

test('registry validation enforces statuses, variants, and known evidence', () => {
  assert.doesNotThrow(() =>
    validateWorkMetricRegistry(registry({ [LAYOUT]: {} })),
  );
  assert.throws(
    () => validateWorkMetricRegistry({ ...registry({}), version: 2 }),
    /version 1/,
  );
  assert.throws(
    () => validateWorkMetricRegistry(registry({ [LAYOUT]: { status: 'on' } })),
    /status/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(registry({ 'stress-transcript.wall_ms': {} })),
    /not a work metric/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        registry({ 'cowork-default-50.work.chromium.Nodes': {} }),
      ),
    /no declared variant/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        registry({
          [LAYOUT]: {
            determinism: [
              {
                qualification: 'unknown',
                min: 1,
                max: 1,
                median: 1,
                spreadPercent: 0,
              },
            ],
          },
        }),
      ),
    /unknown qualification/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        registry({ [LAYOUT]: { tolerancePercent: -1 } }),
      ),
    /tolerancePercent/,
  );
});

test('a counter gates only after ten-run determinism and a correlation proof', () => {
  assert.doesNotThrow(() =>
    validateWorkMetricRegistry(
      withAdmission(registry({ [LAYOUT]: admittedGating() })),
    ),
  );
  // Five exploring runs cannot admit a counter.
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        registry({
          [LAYOUT]: admittedGating({
            determinism: [
              {
                qualification: 'explore',
                min: 10,
                max: 10,
                median: 10,
                spreadPercent: 0,
              },
            ],
          }),
        }),
      ),
    /ten-run determinism/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        withAdmission(
          registry({ [LAYOUT]: admittedGating({ correlation: [] }) }),
        ),
      ),
    /correlation/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        withAdmission(
          registry({
            [LAYOUT]: admittedGating({
              determinism: [
                {
                  qualification: 'admit',
                  min: 10,
                  max: 12,
                  median: 11,
                  spreadPercent: 18.182,
                },
              ],
            }),
          }),
        ),
      ),
    /ten-run determinism/,
  );
  // Concurrent variants report only; they never gate.
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        withAdmission(registry({ [STREAM_LAYOUT]: admittedGating() }), [
          'transcript-streaming-tail',
        ]),
      ),
    /concurrent/,
  );
});

test('determinism evidence counts only from a qualification that ran its scenario', () => {
  // A ten-run qualification of another scenario cannot admit this counter.
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        withAdmission(registry({ [LAYOUT]: admittedGating() }), [
          'transcript-streaming-tail',
        ]),
      ),
    /admit, which did not run stress-transcript/,
  );
  // Advisory evidence is held to the same rule.
  assert.throws(
    () => validateWorkMetricRegistry(registry({ [STREAM_LAYOUT]: {} })),
    /explore, which did not run transcript-streaming-tail/,
  );
  assert.throws(
    () =>
      validateWorkMetricRegistry(
        registry({}, { qualifications: [qualification({ scenarios: 'all' })] }),
      ),
    /scenario list/,
  );
});

test('ceiling validation requires registered work metrics and finite values', () => {
  const value = registry({ [LAYOUT]: {} });
  assert.doesNotThrow(() =>
    validateWorkCeilings(
      ceilings({ 'stress-transcript': { 'work.chromium.LayoutCount': 12 } }),
      value,
    ),
  );
  assert.throws(
    () =>
      validateWorkCeilings(
        ceilings({ 'stress-transcript': { 'work.chromium.Nodes': 12 } }),
        value,
      ),
    /no registry entry/,
  );
  assert.throws(
    () =>
      validateWorkCeilings(
        ceilings({
          'stress-transcript': { 'work.chromium.LayoutCount': Number.NaN },
        }),
        value,
      ),
    /finite/,
  );
  assert.throws(
    () =>
      validateWorkCeilings(
        { ...ceilings({}), profile: 'smoke' },
        registry({ [LAYOUT]: {} }),
      ),
    /counters profile/,
  );
});

test('an intentional ceiling increase carries a one-line reason for a recorded ceiling', () => {
  const policy = registry({ [LAYOUT]: {} });
  const withReason = (reasons) => {
    const value = ceilings({
      'stress-transcript': { 'work.chromium.LayoutCount': 12 },
    });
    value.platforms['darwin-arm64'].reasons = reasons;
    return value;
  };
  assert.doesNotThrow(() =>
    validateWorkCeilings(
      withReason({ [LAYOUT]: 'The sticky header now measures twice.' }),
      policy,
    ),
  );
  assert.throws(
    () =>
      validateWorkCeilings(
        withReason({ [GROUPING]: 'No ceiling is recorded for this counter.' }),
        policy,
      ),
    /has no ceiling/,
  );
  assert.throws(
    () => validateWorkCeilings(withReason({ [LAYOUT]: 'two\nlines' }), policy),
    /one-line reason/,
  );
  assert.throws(
    () => validateWorkCeilings(withReason({ [LAYOUT]: '  ' }), policy),
    /one-line reason/,
  );
  assert.throws(
    () => validateWorkCeilings(withReason(['not', 'a', 'map']), policy),
    /reasons must be a map/,
  );
});

test('advisory and evicted counters report exceeded ceilings without failing', () => {
  const inputs = {
    registry: registry({
      [LAYOUT]: {},
      [GROUPING]: { status: 'evicted' },
    }),
    ceilings: ceilings({
      'stress-transcript': {
        'work.chromium.LayoutCount': 100,
        'work.transcript.turn_grouping.count': 2,
      },
    }),
  };
  const verdict = evaluateWorkRatchet(
    artifact({ metrics: { [LAYOUT]: 150, [GROUPING]: 9 } }),
    inputs,
  );

  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(
    verdict.entries.map(({ key, status, outcome }) => [key, status, outcome]),
    [
      [LAYOUT, 'advisory', 'exceeded'],
      [GROUPING, 'evicted', 'exceeded'],
    ],
  );
  const text = formatWorkRatchetVerdict(verdict).join('\n');
  assert.match(text, /PASS/);
  assert.match(text, /advisory exceeded.*LayoutCount 150 > 100/);
});

test('gating counters fail beyond their tolerance and pass within it', () => {
  const inputs = {
    registry: withAdmission(
      registry({
        [LAYOUT]: admittedGating({ tolerancePercent: 5 }),
        [GROUPING]: admittedGating({ tolerancePercent: 0 }),
      }),
    ),
    ceilings: ceilings({
      'stress-transcript': {
        'work.chromium.LayoutCount': 100,
        'work.transcript.turn_grouping.count': 2,
      },
    }),
  };

  const within = evaluateWorkRatchet(
    artifact({ metrics: { [LAYOUT]: 104, [GROUPING]: 1 } }),
    inputs,
  );
  assert.equal(within.passed, true);
  assert.deepEqual(
    within.entries.map(({ outcome }) => outcome),
    ['within-tolerance', 'below'],
  );

  const exceeded = evaluateWorkRatchet(
    artifact({ metrics: { [LAYOUT]: 106, [GROUPING]: 2 } }),
    inputs,
  );
  assert.equal(exceeded.passed, false);
  assert.deepEqual(
    exceeded.failures.map(({ key, outcome }) => [key, outcome]),
    [[LAYOUT, 'exceeded']],
  );
  assert.match(formatWorkRatchetVerdict(exceeded).join('\n'), /FAIL/);

  // Only a drop beyond the tolerance asks for a lower ceiling.
  const lower = (value) =>
    evaluateWorkRatchet(artifact({ metrics: { [LAYOUT]: value } }), inputs)
      .entries[0];
  assert.equal(lower(96).outcome, 'within');
  assert.equal(lower(94).outcome, 'below');
  assert.doesNotMatch(
    formatWorkRatchetVerdict(
      evaluateWorkRatchet(
        artifact({ metrics: { [LAYOUT]: 96, [GROUPING]: 2 } }),
        inputs,
      ),
    ).join('\n'),
    /below their ceiling/,
  );
});

test('an absent counter is zero only when its source was collected', () => {
  const inputs = {
    registry: withAdmission(registry({ [LAYOUT]: admittedGating() })),
    ceilings: ceilings({
      'stress-transcript': { 'work.chromium.LayoutCount': 100 },
    }),
  };

  const collected = evaluateWorkRatchet(artifact(), inputs);
  assert.equal(collected.passed, true);
  assert.equal(collected.entries[0].value, 0);
  assert.equal(collected.entries[0].outcome, 'below');

  const uncollected = evaluateWorkRatchet(
    artifact({ work: { transcript: {}, errors: [{ source: 'chromium' }] } }),
    inputs,
  );
  assert.equal(uncollected.passed, false);
  assert.equal(uncollected.failures[0].outcome, 'missing');

  const failedScenario = evaluateWorkRatchet(
    artifact({ status: 'error', work: null }),
    inputs,
  );
  assert.equal(failedScenario.failures[0].outcome, 'missing');
  assert.equal(
    evaluateWorkRatchet(artifact({ status: 'error' }), inputs).failures[0]
      .outcome,
    'missing',
  );

  const notRun = evaluateWorkRatchet(artifact({ scenarios: [] }), inputs);
  assert.equal(notRun.passed, false);
  assert.equal(notRun.failures[0].outcome, 'not-run');
});

test('a task counter is zero only when every task of its kind was bracketed', () => {
  const inputs = {
    registry: withAdmission(registry({ [TASK_LAYOUT]: admittedGating() })),
    ceilings: ceilings({
      'stress-transcript': {
        'work.task.open_stress_transcript_warm.chromium.LayoutCount': 100,
      },
    }),
  };
  const judge = (tasks, metrics = {}) => {
    const result = artifact({ metrics });
    result.scenarios[0].tasks = tasks;
    return evaluateWorkRatchet(result, inputs).entries[0].outcome;
  };
  const warm = {
    kind: 'open_stress_transcript_warm',
    status: 'ok',
    work: { transcript: {}, chromium: {} },
  };

  // A kind that ran in full and never moved the counter measured zero.
  assert.equal(judge([warm]), 'below');
  assert.equal(judge([warm], { [TASK_LAYOUT]: 100 }), 'within');
  // A failed task is not work that happened, so it does not void the kind.
  assert.equal(
    judge([warm, { ...warm, status: 'error', work: undefined }]),
    'below',
  );
  // A kind that did not run, was renamed, or ran partly unbracketed is missing,
  // never an improvement.
  assert.equal(judge([]), 'missing');
  assert.equal(judge([{ ...warm, kind: 'open_stress_transcript' }]), 'missing');
  assert.equal(judge([warm, { ...warm, work: { transcript: {} } }]), 'missing');
});

test('negative ceilings apply the tolerance toward a larger value', () => {
  const nodes = 'stress-transcript.work.chromium.Nodes';
  const inputs = {
    registry: withAdmission(
      registry({ [nodes]: admittedGating({ tolerancePercent: 10 }) }),
    ),
    ceilings: ceilings({ 'stress-transcript': { 'work.chromium.Nodes': -50 } }),
  };
  const within = evaluateWorkRatchet(
    artifact({ metrics: { [nodes]: -46 } }),
    inputs,
  );
  assert.equal(within.entries[0].allowed, -45);
  assert.equal(within.entries[0].outcome, 'within-tolerance');
  assert.equal(
    evaluateWorkRatchet(artifact({ metrics: { [nodes]: -44 } }), inputs).passed,
    false,
  );
});

test('ceilings recorded under a different workload or runtime are incompatible', () => {
  const advisory = {
    registry: registry({ [LAYOUT]: {} }),
    ceilings: ceilings({
      'stress-transcript': { 'work.chromium.LayoutCount': 100 },
    }),
  };
  const changed = artifact({
    metrics: { [LAYOUT]: 500 },
    config: { interactionIterations: 8 },
    environment: { electronVersion: '43.0.0' },
  });

  const advisoryVerdict = evaluateWorkRatchet(changed, advisory);
  assert.equal(advisoryVerdict.passed, true);
  assert.deepEqual(advisoryVerdict.incompatibilities, [
    'configSha256',
    'electronVersion',
  ]);
  assert.equal(advisoryVerdict.entries[0].outcome, 'incompatible');

  const gating = {
    registry: withAdmission(registry({ [LAYOUT]: admittedGating() })),
    ceilings: advisory.ceilings,
  };
  assert.equal(evaluateWorkRatchet(changed, gating).passed, false);
});

test('a counters run is judged against the checked-in inputs, and unreadable inputs fail it', () => {
  const inputs = {
    registry: registry({ [LAYOUT]: {} }),
    ceilings: ceilings({
      'stress-transcript': { 'work.chromium.LayoutCount': 100 },
    }),
  };
  const run = artifact({ metrics: { [LAYOUT]: 150 } });

  const judged = judgeWorkRatchet(run, () => inputs);
  assert.equal(judged.passed, true);
  assert.deepEqual(judged, evaluateWorkRatchet(run, inputs));

  const broken = judgeWorkRatchet(run, () => {
    throw new Error('The work metric registry must be version 1');
  });
  assert.deepEqual(broken, {
    passed: false,
    error: 'The work metric registry must be version 1',
  });
  assert.deepEqual(formatWorkRatchetVerdict(broken), [
    '[perf] Work-counter ratchet: FAIL - The work metric registry must be version 1',
  ]);

  // The default reader uses the checked-in registry and ceilings.
  assert.equal(judgeWorkRatchet(run).error, undefined);
});

test('a platform without ceilings has nothing to gate yet', () => {
  const verdict = evaluateWorkRatchet(
    artifact({
      metrics: { [LAYOUT]: 12 },
      environment: { platform: 'win32', architecture: 'x64' },
    }),
    {
      registry: registry({ [LAYOUT]: {} }),
      ceilings: ceilings({
        'stress-transcript': { 'work.chromium.LayoutCount': 1 },
      }),
    },
  );
  assert.equal(verdict.passed, true);
  assert.equal(verdict.platform, 'win32-x64');
  assert.deepEqual(verdict.entries, []);
  assert.match(
    formatWorkRatchetVerdict(verdict).join('\n'),
    /no ceilings recorded for win32-x64/,
  );
});

test('unregistered work counters are counted but never judged', () => {
  const verdict = evaluateWorkRatchet(
    artifact({
      metrics: {
        [LAYOUT]: 12,
        'stress-transcript.work.chromium.Nodes': 4,
      },
    }),
    {
      registry: registry({ [LAYOUT]: {} }),
      ceilings: ceilings({
        'stress-transcript': { 'work.chromium.LayoutCount': 12 },
      }),
    },
  );
  assert.equal(verdict.unregistered, 1);
  assert.equal(verdict.entries.length, 1);
});

test('determinism summaries use the spread over the median with absent counters as zero', () => {
  const runs = [
    { [LAYOUT]: 100, [GROUPING]: 3 },
    { [LAYOUT]: 101, [GROUPING]: 3 },
    { [LAYOUT]: 100 },
    { [LAYOUT]: 100, [GROUPING]: 3 },
    { [LAYOUT]: 99, [GROUPING]: 3 },
  ].map((metrics, index) =>
    artifact({ metrics, commit: index < 3 ? 'abc123' : 'def456' }),
  );

  const summary = summarizeWorkDeterminism(runs, {
    scenarios: ['stress-transcript'],
  });

  assert.equal(summary.runs, 5);
  assert.equal(summary.platform, 'darwin-arm64');
  assert.deepEqual(summary.commits, ['abc123', 'def456']);
  assert.equal(summary.dirty, false);
  runs[4].source.dirty = true;
  assert.equal(
    summarizeWorkDeterminism(runs, { scenarios: ['stress-transcript'] }).dirty,
    true,
  );
  assert.deepEqual(
    summary.rows.map(
      ({ key, min, max, median, spreadPercent, deterministic }) => [
        key,
        min,
        max,
        median,
        spreadPercent,
        deterministic,
      ],
    ),
    [
      [LAYOUT, 99, 101, 100, 2, false],
      [GROUPING, 0, 3, 3, 100, false],
    ],
  );

  const zeroMedian = summarizeWorkDeterminism(
    [{}, {}, { [LAYOUT]: 4 }].map((metrics) => artifact({ metrics })),
    { scenarios: ['stress-transcript'] },
  );
  assert.equal(zeroMedian.rows[0].spreadPercent, null);
  assert.equal(zeroMedian.rows[0].deterministic, false);
});

test('determinism summaries reject mismatched or incomplete runs', () => {
  assert.throws(
    () =>
      summarizeWorkDeterminism(
        [artifact(), artifact({ config: { interactionIterations: 8 } })],
        { scenarios: ['stress-transcript'] },
      ),
    /configSha256/,
  );
  assert.throws(
    () =>
      summarizeWorkDeterminism(
        [artifact(), artifact({ status: 'error', work: null })],
        { scenarios: ['stress-transcript'] },
      ),
    /stress-transcript.*did not collect work/,
  );
  assert.throws(
    () =>
      summarizeWorkDeterminism([artifact()], {
        scenarios: ['stress-transcript'],
      }),
    /at least two runs/,
  );
});

test('qualification records evidence and ceilings without ever raising a ceiling', () => {
  const nodes = 'stress-transcript.work.chromium.Nodes';
  const runs = [100, 100, 101, 100, 100].map((value) =>
    artifact({ metrics: { [LAYOUT]: value, [GROUPING]: 3, [nodes]: 7 } }),
  );
  const summary = summarizeWorkDeterminism(runs, {
    scenarios: ['stress-transcript'],
  });
  const base = registry({});
  base.qualifications = [];
  const first = applyWorkQualification({
    registry: base,
    ceilings: { version: 1, profile: 'counters', platforms: {} },
    summary,
    id: 'explore',
    date: '2026-09-28',
    note: 'Exploring runs of the work-metric harness.',
  });

  assert.deepEqual(first.registry.qualifications, [
    {
      id: 'explore',
      date: '2026-09-28',
      platform: 'darwin-arm64',
      profile: 'counters',
      runs: 5,
      commits: ['abc123'],
      dirty: false,
      fingerprint: workRatchetFingerprint(artifact()),
      scenarios: ['stress-transcript'],
      note: 'Exploring runs of the work-metric harness.',
    },
  ]);
  assert.deepEqual(first.registry.metrics[LAYOUT], {
    status: 'advisory',
    tolerancePercent: 1,
    determinism: [
      {
        qualification: 'explore',
        min: 100,
        max: 101,
        median: 100,
        spreadPercent: 1,
      },
    ],
    correlation: [],
  });
  const platform = first.ceilings.platforms['darwin-arm64'];
  assert.deepEqual(platform.scenarios['stress-transcript'], {
    'work.chromium.LayoutCount': 101,
    'work.chromium.Nodes': 7,
    'work.transcript.turn_grouping.count': 3,
  });
  assert.equal(platform.qualification, 'explore');
  validateWorkMetricRegistry(first.registry);
  validateWorkCeilings(first.ceilings, first.registry);

  // A repeat of the same qualification replaces its evidence. A higher
  // maximum never raises a ceiling; a lower one tightens it.
  const rerun = summarizeWorkDeterminism(
    [130, 130, 130, 130, 130].map((value) =>
      artifact({ metrics: { [LAYOUT]: value, [GROUPING]: 2 } }),
    ),
    { scenarios: ['stress-transcript'] },
  );
  const second = applyWorkQualification({
    registry: first.registry,
    ceilings: first.ceilings,
    summary: rerun,
    id: 'explore',
    date: '2026-09-29',
  });
  assert.equal(second.registry.qualifications.length, 1);
  assert.equal(second.registry.qualifications[0].date, '2026-09-29');
  assert.equal(second.registry.metrics[LAYOUT].determinism.length, 1);
  assert.equal(second.registry.metrics[LAYOUT].determinism[0].max, 130);
  // Evidence the repeated qualification no longer produced is withdrawn.
  assert.deepEqual(second.registry.metrics[nodes].determinism, []);
  assert.deepEqual(
    second.ceilings.platforms['darwin-arm64'].scenarios['stress-transcript'],
    {
      'work.chromium.LayoutCount': 101,
      'work.chromium.Nodes': 7,
      'work.transcript.turn_grouping.count': 2,
    },
  );
  assert.deepEqual(second.notRaised, [
    { key: LAYOUT, ceiling: 101, observedMax: 130 },
  ]);
});

test('qualification writes no ceiling for a counter that is not deterministic', () => {
  const summary = summarizeWorkDeterminism(
    [100, 130, 100, 100, 100].map((value) =>
      artifact({ metrics: { [LAYOUT]: value } }),
    ),
    { scenarios: ['stress-transcript'] },
  );
  const base = registry({});
  base.qualifications = [];
  const { registry: updated, ceilings: updatedCeilings } =
    applyWorkQualification({
      registry: base,
      ceilings: { version: 1, profile: 'counters', platforms: {} },
      summary,
      id: 'explore',
      date: '2026-09-28',
    });
  assert.equal(updated.metrics[LAYOUT].determinism[0].spreadPercent, 30);
  assert.deepEqual(
    updatedCeilings.platforms['darwin-arm64'].scenarios['stress-transcript'] ??
      {},
    {},
  );
});

test('qualification refuses scenarios whose variant has not been declared', () => {
  const summary = summarizeWorkDeterminism(
    [artifact(), artifact()].map((value) => {
      value.scenarios[0].name = 'loaded-ui';
      return value;
    }),
    { scenarios: ['loaded-ui'] },
  );
  assert.throws(
    () =>
      applyWorkQualification({
        registry: registry({}),
        ceilings: { version: 1, profile: 'counters', platforms: {} },
        summary,
        id: 'explore',
        date: '2026-09-28',
      }),
    /loaded-ui.*variant/,
  );
});
