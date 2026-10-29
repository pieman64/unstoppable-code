import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_WORK_SOURCES } from './monitor.mjs';
import {
  WORK_METRIC_SOURCES,
  buildScenarioMetrics,
  finalizeResult,
  isRepeatedResult,
  parseWorkMetricKey,
  performanceRunSucceeded,
  sampleIsComparable,
} from './results.mjs';

test('scenario metrics report typing phases separately from liveness task duration', () => {
  const metrics = buildScenarioMetrics({
    name: 'pipelines',
    durationMs: 1_000,
    tasks: [
      {
        kind: 'type_during_pipeline_load',
        status: 'ok',
        durationMs: 350,
        keyboardDispatchMs: 180,
        textCommitMs: 190,
        typingBurstMs: 220,
        typingBurstMsPerCharacter: 2.292,
      },
    ],
  });

  assert.equal(
    metrics['pipelines.task.type_during_pipeline_load.p95_ms'].value,
    350,
  );
  assert.equal(metrics['pipelines.typing.keyboard_dispatch.p95_ms'].value, 180);
  assert.equal(metrics['pipelines.typing.text_commit.p95_ms'].value, 190);
  assert.equal(
    metrics['pipelines.typing.burst_to_paint_confirmation.p95_ms'].value,
    220,
  );
  assert.deepEqual(
    metrics['pipelines.typing.burst_per_character.p95_ms_per_character'],
    {
      value: 2.292,
      unit: 'ms/character',
      kind: 'time',
      direction: 'lower',
      description: 'Typing burst per character p95',
      minRegressionAbsolute: 0.5,
    },
  );
});

test('every sampled measurement keeps the time kind, including sampled counts', () => {
  const metrics = buildScenarioMetrics({
    name: 'chats',
    durationMs: 1_000,
    launch: { firstWindowMs: 900, shellReadyMs: 1_200 },
    tasks: [{ kind: 'open_chat', status: 'ok', durationMs: 40 }],
    monitoring: {
      summary: {
        ipcOuterMs: { p95: 4, max: 9 },
        longTasks: { count: 2, max: 80 },
        longTaskTotalMs: 140,
        totalWorkingSetMb: { max: 900 },
        totalCpuPercent: { p95: 40, max: 70 },
        processCount: { max: 6 },
      },
    },
  });

  assert.ok(Object.keys(metrics).length > 8);
  for (const [key, entry] of Object.entries(metrics)) {
    assert.equal(entry.kind, 'time', key);
  }
  assert.equal(metrics['chats.renderer.long_tasks.count'].unit, 'count');
  assert.equal(metrics['chats.resources.processes.max_count'].unit, 'count');
});

function workScenario(overrides = {}) {
  return {
    name: 'stress-transcript',
    durationMs: 1_000,
    tasks: [
      {
        kind: 'open_stress_transcript_warm',
        status: 'ok',
        durationMs: 30,
        work: {
          transcript: {
            'turn_grouping.count': 1,
            'turn_grouping.work.messages': 400,
            'counters.loaded_bytes': 2_048,
          },
          chromium: { LayoutCount: 3, Nodes: -12 },
        },
      },
      {
        kind: 'open_stress_transcript_warm',
        status: 'unresponsive',
        durationMs: 7_000,
        work: {
          transcript: { 'turn_grouping.count': 2 },
          chromium: { LayoutCount: 5 },
        },
      },
      {
        kind: 'type_in_stress_transcript',
        status: 'ok',
        durationMs: 20,
        work: { transcript: {}, chromium: { RecalcStyleCount: 48 } },
      },
      { kind: 'type_in_stress_transcript', status: 'error', durationMs: 10 },
    ],
    work: {
      transcript: {
        'turn_grouping.count': 3,
        'turn_grouping.work.messages': 400,
        'counters.page_installs': 2,
        'counters.loaded_bytes': 4_096,
      },
      chromium: { LayoutCount: 30, RecalcStyleCount: 80, Frames: 1 },
    },
    ...overrides,
  };
}

test('work counters project into flat count metrics for the measured window', () => {
  const metrics = buildScenarioMetrics(workScenario());

  assert.deepEqual(
    metrics['stress-transcript.work.transcript.turn_grouping.count'],
    {
      value: 3,
      unit: 'count',
      kind: 'count',
      direction: 'lower',
      description:
        'Transcript turn_grouping stage runs over the measured window',
    },
  );
  assert.equal(
    metrics['stress-transcript.work.transcript.turn_grouping.work.messages']
      .value,
    400,
  );
  assert.equal(
    metrics['stress-transcript.work.transcript.counters.page_installs'].value,
    2,
  );
  assert.deepEqual(
    metrics['stress-transcript.work.transcript.counters.loaded_bytes'],
    {
      value: 4_096,
      unit: 'bytes',
      kind: 'count',
      direction: 'lower',
      description:
        'Transcript counter loaded_bytes change over the measured window',
    },
  );
  assert.equal(
    metrics['stress-transcript.work.chromium.LayoutCount'].kind,
    'count',
  );
  assert.equal(metrics['stress-transcript.work.chromium.Frames'].value, 1);
  // Sampled timings keep their own kind beside the new counters.
  assert.equal(metrics['stress-transcript.wall_ms'].kind, 'time');
});

test('work counters sum every completed task of a kind, including slow ones', () => {
  const metrics = buildScenarioMetrics(workScenario());
  const prefix = 'stress-transcript.work.task.open_stress_transcript_warm';

  // The unresponsive task completed its operation, so its work still counts;
  // only a failed operation has no work bracket.
  assert.equal(metrics[`${prefix}.transcript.turn_grouping.count`].value, 3);
  assert.equal(
    metrics[`${prefix}.transcript.turn_grouping.work.messages`].value,
    400,
  );
  assert.equal(metrics[`${prefix}.chromium.LayoutCount`].value, 8);
  assert.equal(metrics[`${prefix}.chromium.Nodes`].value, -12);
  assert.equal(
    metrics[`${prefix}.transcript.counters.loaded_bytes`].unit,
    'bytes',
  );
  assert.equal(
    metrics[
      'stress-transcript.work.task.type_in_stress_transcript.chromium.RecalcStyleCount'
    ].value,
    48,
  );
  assert.equal(
    metrics[`${prefix}.chromium.LayoutCount`].description,
    'Chromium LayoutCount change summed over completed open_stress_transcript_warm tasks',
  );
});

test('every counter the window observed is an explicit zero for task kinds that never moved it', () => {
  const metrics = buildScenarioMetrics(workScenario());
  const typing = 'stress-transcript.work.task.type_in_stress_transcript';

  assert.equal(metrics[`${typing}.transcript.turn_grouping.count`].value, 0);
  assert.equal(metrics[`${typing}.transcript.counters.page_installs`].value, 0);
  assert.equal(metrics[`${typing}.chromium.Frames`].value, 0);
  assert.equal(metrics[`${typing}.chromium.RecalcStyleCount`].value, 48);
  // Each scope reports the same counter set as the measured window.
  const counterSet = (scope) =>
    Object.keys(metrics)
      .filter((key) => key.startsWith(`${scope}.`))
      .map((key) => key.slice(scope.length + 1))
      .sort();
  for (const source of ['transcript', 'chromium']) {
    assert.deepEqual(
      counterSet(`${typing}.${source}`),
      counterSet(`stress-transcript.work.${source}`),
      source,
    );
  }
  assert.equal(
    metrics['stress-transcript.work.chromium.Frames'].description,
    'Chromium Frames change over the measured window',
  );
});

test('work counters are emitted only for sources collected over the whole scenario', () => {
  const scenario = workScenario();
  delete scenario.work.chromium;
  scenario.work.errors = [{ source: 'chromium', message: 'timeout' }];
  const metrics = buildScenarioMetrics(scenario);

  assert.equal(
    Object.keys(metrics).some((key) => key.includes('.chromium.')),
    false,
  );
  assert.ok(
    metrics[
      'stress-transcript.work.task.open_stress_transcript_warm.transcript.turn_grouping.count'
    ],
  );

  const withoutWork = buildScenarioMetrics(workScenario({ work: undefined }));
  assert.equal(
    Object.keys(withoutWork).some((key) => key.includes('.work.')),
    false,
  );
});

test('a task kind with an uncollected bracket reports no partial work sum', () => {
  const scenario = workScenario();
  delete scenario.tasks[1].work.chromium;
  const metrics = buildScenarioMetrics(scenario);
  const prefix = 'stress-transcript.work.task.open_stress_transcript_warm';

  assert.equal(metrics[`${prefix}.chromium.LayoutCount`], undefined);
  assert.equal(metrics[`${prefix}.transcript.turn_grouping.count`].value, 3);

  // A completed task without any bracket leaves both sources partial.
  const unbracketed = workScenario();
  unbracketed.tasks.push({
    kind: 'open_stress_transcript_warm',
    status: 'ok',
    durationMs: 25,
  });
  const partial = buildScenarioMetrics(unbracketed);
  assert.equal(
    Object.keys(partial).some((key) => key.startsWith(`${prefix}.`)),
    false,
  );
  assert.ok(
    partial[
      'stress-transcript.work.task.type_in_stress_transcript.chromium.RecalcStyleCount'
    ],
  );
});

test('app work counters project with their own sources, units, and descriptions', () => {
  const scenario = workScenario();
  scenario.work.ipc = {
    'invoke.chat:load-tabs': 1,
    'send.chat:state-changed.main.messages': 6,
    'send.chat:state-changed.main.bytes': 9_216,
  };
  scenario.work.chatStorage = {
    commits: 3,
    'syncs.file': 15,
    'written.journal.bytes': 2_048,
  };
  scenario.work.provider = { eventsIngested: 3, eventsApplied: 3 };
  scenario.work.react = { commits: 4, performedWorkFibers: 90 };
  scenario.tasks[0].work.ipc = { 'send.chat:state-changed.main.messages': 2 };
  scenario.tasks[1].work.ipc = { 'send.chat:state-changed.main.messages': 1 };
  scenario.tasks[0].work.react = { commits: 1, performedWorkFibers: 30 };
  scenario.tasks[1].work.react = { commits: 2, performedWorkFibers: 40 };
  const metrics = buildScenarioMetrics(scenario);
  const window = 'stress-transcript.work';
  const open = `${window}.task.open_stress_transcript_warm`;

  assert.deepEqual(
    metrics[`${window}.ipc.send.chat:state-changed.main.bytes`],
    {
      value: 9_216,
      unit: 'bytes',
      kind: 'count',
      direction: 'lower',
      description:
        'IPC send.chat:state-changed.main.bytes over the measured window',
    },
  );
  assert.equal(metrics[`${window}.ipc.invoke.chat:load-tabs`].unit, 'count');
  assert.equal(
    metrics[`${window}.chatStorage.written.journal.bytes`].description,
    'Chat storage written.journal.bytes over the measured window',
  );
  assert.equal(metrics[`${window}.chatStorage.commits`].value, 3);
  assert.equal(
    metrics[`${window}.provider.eventsIngested`].description,
    'Provider eventsIngested over the measured window',
  );
  assert.equal(
    metrics[`${window}.react.performedWorkFibers`].description,
    'React performedWorkFibers over the measured window',
  );
  assert.equal(
    metrics[`${open}.ipc.send.chat:state-changed.main.messages`].value,
    3,
  );
  assert.equal(metrics[`${open}.ipc.invoke.chat:load-tabs`].value, 0);
  assert.equal(metrics[`${open}.react.performedWorkFibers`].value, 70);
  // A task kind whose tasks were not bracketed for a source is not a zero.
  assert.equal(metrics[`${open}.chatStorage.commits`], undefined);
  assert.deepEqual(
    parseWorkMetricKey(`${open}.ipc.send.chat:state-changed.main.messages`),
    {
      scenario: 'stress-transcript',
      taskKind: 'open_stress_transcript_warm',
      source: 'ipc',
      counter: 'send.chat:state-changed.main.messages',
    },
  );
  for (const source of ['ipc', 'chatStorage', 'provider', 'react']) {
    assert.equal(
      parseWorkMetricKey(`${window}.${source}.x`)?.source,
      source,
      source,
    );
  }
});

test('per-process disk bytes project as window-only byte and count metrics', () => {
  const scenario = workScenario();
  scenario.work.disk = {
    'main.processes': 1,
    'main.readBytes': 65_536,
    'main.writtenBytes': 1_048_576,
    'claude.writtenBytes': 4_096,
    'total.writtenBytes': 1_052_672,
  };
  const metrics = buildScenarioMetrics(scenario);
  const window = 'stress-transcript.work';

  assert.deepEqual(metrics[`${window}.disk.main.writtenBytes`], {
    value: 1_048_576,
    unit: 'bytes',
    kind: 'count',
    direction: 'lower',
    description: 'Disk I/O main.writtenBytes over the measured window',
  });
  assert.equal(metrics[`${window}.disk.main.processes`].unit, 'count');
  // Disk bytes are sampled only at the window boundary, never per task.
  assert.equal(
    Object.keys(metrics).some(
      (key) => key.includes('.task.') && key.includes('.disk.'),
    ),
    false,
  );
  assert.equal(
    parseWorkMetricKey(`${window}.disk.claude.writtenBytes`)?.source,
    'disk',
  );
});

test('every app source the monitor samples is a work metric source', () => {
  for (const source of APP_WORK_SOURCES) {
    assert.ok(WORK_METRIC_SOURCES.includes(source), source);
  }
});

test('work metric keys parse into scenario, scope, source, and counter', () => {
  assert.deepEqual(
    parseWorkMetricKey(
      'stress-transcript.work.transcript.turn_grouping.work.messages',
    ),
    {
      scenario: 'stress-transcript',
      taskKind: null,
      source: 'transcript',
      counter: 'turn_grouping.work.messages',
    },
  );
  assert.deepEqual(
    parseWorkMetricKey(
      'stress-transcript.work.task.type_in_stress_transcript.chromium.Nodes',
    ),
    {
      scenario: 'stress-transcript',
      taskKind: 'type_in_stress_transcript',
      source: 'chromium',
      counter: 'Nodes',
    },
  );
  assert.equal(parseWorkMetricKey('stress-transcript.wall_ms'), null);
  assert.equal(
    parseWorkMetricKey('stress-transcript.work.unknown.Nodes'),
    null,
  );
});

test('renderer key metrics use low-latency comparison floors', () => {
  const metrics = buildScenarioMetrics({
    name: 'pipelines',
    durationMs: 1_000,
    tasks: [],
    monitoring: {
      summary: {
        rendererKeyEventHandlerMs: { p95: 2, max: 4 },
        rendererKeyToNextFrameMs: { p95: 14, max: 18 },
        rendererKeyToPaintConfirmationMs: { p95: 29, max: 34 },
      },
    },
  });

  assert.equal(
    metrics['pipelines.renderer.key_event_handler.p95_ms']
      .minRegressionAbsolute,
    1,
  );
  assert.equal(
    metrics['pipelines.renderer.key_to_next_frame.p95_ms']
      .minRegressionAbsolute,
    5,
  );
  assert.equal(
    metrics['pipelines.renderer.key_to_paint_confirmation.p95_ms']
      .minRegressionAbsolute,
    5,
  );
});

test('renderer long-task metrics retain a stable zero-value schema', () => {
  const metrics = buildScenarioMetrics({
    name: 'startup-settle',
    durationMs: 1_000,
    tasks: [],
    monitoring: {
      summary: {
        longTasks: {
          count: 0,
          min: null,
          mean: null,
          p50: null,
          p95: null,
          p99: null,
          max: null,
        },
        longTaskTotalMs: 0,
      },
    },
  });

  assert.equal(metrics['startup-settle.renderer.long_tasks.count'].value, 0);
  assert.equal(metrics['startup-settle.renderer.long_tasks.max_ms'].value, 0);
  assert.equal(metrics['startup-settle.renderer.long_tasks.total_ms'].value, 0);
});

test('startup scenarios expose DOM, composer, and first-input launch milestones', () => {
  const metrics = buildScenarioMetrics({
    name: 'startup-settle',
    durationMs: 10_000,
    launch: {
      firstWindowMs: 900,
      domContentLoadedMs: 1_100,
      shellReadyMs: 1_400,
      composerReadyMs: 1_320,
      firstInputMs: 1_390,
      firstInputRelativeToShellMs: -10,
    },
    tasks: [],
  });

  assert.equal(
    metrics['startup-settle.launch.dom_content_loaded_ms'].value,
    1_100,
  );
  assert.equal(metrics['startup-settle.launch.composer_ready_ms'].value, 1_320);
  assert.equal(metrics['startup-settle.launch.first_input_ms'].value, 1_390);
  assert.equal(
    metrics['startup-settle.launch.shell_to_first_input_ms'].value,
    -10,
  );
});

test('code-graph build counts project as window-only counts and bytes', () => {
  const scenario = workScenario({ name: 'code-graph-small-edit' });
  scenario.work.codeGraph = {
    'edit1.small.filesParsed': 1,
    'edit1.small.rowsWritten': 4_000,
    'edit1.small.peakWalBytes': 1_048_576,
  };
  const metrics = buildScenarioMetrics(scenario);
  const window = 'code-graph-small-edit.work.codeGraph';
  assert.equal(metrics[`${window}.edit1.small.filesParsed`].unit, 'count');
  assert.equal(metrics[`${window}.edit1.small.peakWalBytes`].unit, 'bytes');
  assert.equal(
    metrics[`${window}.edit1.small.rowsWritten`].description,
    'Code graph edit1.small.rowsWritten over the measured window',
  );
  assert.deepEqual(parseWorkMetricKey(`${window}.edit1.small.filesParsed`), {
    scenario: 'code-graph-small-edit',
    taskKind: null,
    source: 'codeGraph',
    counter: 'edit1.small.filesParsed',
  });
  assert.equal(
    parseWorkMetricKey('code-graph-small-edit.work.scaling.ratio')?.source,
    'scaling',
  );
});

test('code-graph journey and build phases project as timing metrics', () => {
  const metrics = buildScenarioMetrics({
    name: 'code-graph-new-worktree',
    durationMs: 10_000,
    tasks: [],
    timings: {
      j7: { graph_usable_ms: 17_000, queue_wait_ms: 5_183, fixture: 'new' },
      new_worktree_build: { parse_ms: 900 },
    },
  });
  assert.deepEqual(
    metrics['code-graph-new-worktree.timing.j7.graph_usable_ms'],
    {
      value: 17_000,
      unit: 'ms',
      kind: 'time',
      direction: 'lower',
      description: 'j7 graph usable',
    },
  );
  assert.equal(
    metrics['code-graph-new-worktree.timing.new_worktree_build.parse_ms'].value,
    900,
  );
  // Only `_ms` names are timings.
  assert.equal(metrics['code-graph-new-worktree.timing.j7.fixture'], undefined);
});

test('startup journey milestones stay out of the flat metrics', () => {
  // A new timing key would make every earlier startup baseline incomparable,
  // so J1 and the App Advisor opening live only in `startupJourney`.
  const metrics = buildScenarioMetrics({
    name: 'startup-settle',
    durationMs: 10_000,
    tasks: [],
    startupJourney: {
      timings: {
        j1: { main_ready_ms: 430, react_mount_ms: 1_450 },
        app_advisor: { ready_ms: 900 },
      },
    },
  });
  assert.equal(
    Object.keys(metrics).some((key) => key.includes('.timing.')),
    false,
  );
});

test('a run passes unless a scenario failed or the ratchet failed', () => {
  const ok = { scenarios: [{ status: 'ok' }, { status: 'ok' }] };
  assert.equal(performanceRunSucceeded(ok), true);
  assert.equal(
    performanceRunSucceeded({ scenarios: [{ status: 'unresponsive' }] }),
    false,
  );
  assert.equal(
    performanceRunSucceeded({ ...ok, workRatchet: { passed: false } }),
    false,
  );
  assert.equal(
    performanceRunSucceeded({ ...ok, workRatchet: { passed: true } }),
    true,
  );
});

test('a repeated run keeps every sample and a median value per metric', () => {
  const record = (sample, status, durationMs) => ({
    name: 'loaded-ui',
    status,
    sample,
    durationMs,
    tasks: [],
  });
  const result = finalizeResult({
    repeat: { count: 4, samples: [] },
    scenarios: [
      record(0, 'ok', 100),
      record(1, 'unresponsive', 400),
      record(2, 'error', 9_000),
      record(3, 'ok', 200),
    ],
  });
  assert.equal(isRepeatedResult(result), true);
  const wall = result.metrics['loaded-ui.wall_ms'];
  assert.deepEqual(wall.samples, [100, 400, 9_000, 200]);
  // The failed sample stays in `samples` but not in the representative value.
  assert.equal(wall.value, 200);
  assert.equal(wall.kind, 'time');
  assert.equal(wall.unit, 'ms');
  assert.equal(sampleIsComparable(result, 'loaded-ui', 1), true);
  assert.equal(sampleIsComparable(result, 'loaded-ui', 2), false);
  assert.equal(sampleIsComparable(result, 'loaded-ui', 7), false);
  // Any failed or slow sample still fails the run.
  assert.equal(performanceRunSucceeded(result), false);
});

test('a metric a sample did not report is null in that sample', () => {
  const result = finalizeResult({
    repeat: { count: 2, samples: [] },
    scenarios: [
      {
        name: 'startup-settle',
        status: 'ok',
        sample: 0,
        durationMs: 10,
        launch: { shellReadyMs: 50 },
        tasks: [],
      },
      {
        name: 'startup-settle',
        status: 'ok',
        sample: 1,
        durationMs: 12,
        tasks: [],
      },
    ],
  });
  assert.deepEqual(result.metrics['startup-settle.launch.shell_ms'].samples, [
    50,
    null,
  ]);
  assert.equal(result.metrics['startup-settle.launch.shell_ms'].value, 50);
});

test('a single-sample run keeps the original metric shape', () => {
  const result = finalizeResult({
    scenarios: [{ name: 'chats', status: 'ok', durationMs: 42, tasks: [] }],
  });
  assert.equal(isRepeatedResult(result), false);
  assert.equal(result.repeat, undefined);
  assert.deepEqual(result.metrics['chats.wall_ms'], {
    value: 42,
    unit: 'ms',
    kind: 'time',
    direction: 'lower',
    description: 'Complete scenario wall time',
  });
  assert.equal(result.scenarios[0].sample, undefined);
});

test('a metric with no comparable sample has a null value and keeps its samples', () => {
  const result = finalizeResult({
    repeat: { count: 2, samples: [] },
    scenarios: [
      {
        name: 'loaded-ui',
        status: 'error',
        sample: 0,
        durationMs: 9_000,
        tasks: [],
      },
      {
        name: 'loaded-ui',
        status: 'error',
        sample: 1,
        durationMs: 8_000,
        tasks: [],
      },
    ],
  });
  const wall = result.metrics['loaded-ui.wall_ms'];
  assert.deepEqual(wall.samples, [9_000, 8_000]);
  assert.equal(wall.value, null);
  assert.equal(wall.unit, 'ms');
  assert.equal(wall.kind, 'time');
});

function localSmoke(overrides = {}) {
  return {
    profile: 'smoke',
    benchmarkKind: 'e2e-relative',
    acceptancePolicy: 'local-smoke-v1',
    startedAt: '2026-10-09T00:00:00.000Z',
    completedAt: '2026-10-09T00:01:00.000Z',
    requestedScenarios: ['loaded-ui'],
    scenarios: [
      {
        name: 'loaded-ui',
        status: 'unresponsive',
        durationMs: 1000,
        tasks: [],
        responsiveness: {
          passed: false,
          violations: [
            {
              metric: 'renderer.frame_delay.max_ms',
              value: 180,
              budgetMs: 100,
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

test('local smoke keeps a timing breach without failing a completed workload', () => {
  const result = localSmoke();
  assert.equal(performanceRunSucceeded(result), true);
  assert.equal(result.scenarios[0].status, 'unresponsive');
});

test('local smoke never excuses errors, missing scenarios, or hard liveness failures', () => {
  for (const metric of [
    'ipc.error_count',
    'renderer.next_paint.timeout_count',
    'task.type.duration_ms',
    'unknown',
  ]) {
    const result = localSmoke();
    result.scenarios[0].responsiveness.violations[0].metric = metric;
    assert.equal(performanceRunSucceeded(result), false, metric);
  }
  for (const scenarios of [
    [],
    [{ name: 'loaded-ui', status: 'error' }],
    [{ name: 'other', status: 'ok' }],
  ]) {
    assert.equal(performanceRunSucceeded(localSmoke({ scenarios })), false);
  }
  assert.equal(
    performanceRunSucceeded(localSmoke({ benchmarkKind: 'release-like' })),
    false,
  );
});

test('local smoke cannot accept a partial artifact or incomplete responsiveness evidence', () => {
  for (const mutate of [
    (r) => {
      delete r.completedAt;
    },
    (r) => {
      r.scenarios[0].responsiveness = { passed: false, violations: [] };
    },
    (r) => {
      r.scenarios[0].tasks.push({
        status: 'ok',
        durationMs: 6000,
        responsivenessBudgetMs: 5000,
      });
    },
  ]) {
    const run = localSmoke();
    mutate(run);
    assert.equal(performanceRunSucceeded(run), false);
  }
});
