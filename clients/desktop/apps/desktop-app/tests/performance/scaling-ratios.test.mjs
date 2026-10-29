import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { comparePerformanceResults } from './comparison.mjs';
import {
  collectedWorkScopes,
  finalizeResult,
  performanceRunSucceeded,
} from './results.mjs';
import {
  SCALING_RATIO_DEFINITIONS,
  SEQUENTIAL_STREAM_TASK_KINDS,
  applyScalingRatios,
  computeScenarioScalingRatios,
  evaluateScalingRatio,
  formatScalingRatioLines,
  scalingRatioKey,
  taskKindWork,
  toolActiveTurnTaskKind,
} from './scaling-ratios.mjs';
import {
  evaluateWorkRatchet,
  validateWorkMetricRegistry,
} from './work-ratchet.mjs';

const registry = validateWorkMetricRegistry(
  JSON.parse(
    readFileSync(new URL('./work-metrics.json', import.meta.url), 'utf8'),
  ),
);

function task(kind, work, overrides = {}) {
  return { kind, status: 'ok', durationMs: 10, work, ...overrides };
}

/**
 * `transcript-active-turn-tools` with a whole-turn rewrite: bytes per event
 * grow with the active turn, as they do today.
 */
function activeTurnScenario({
  largeBytes = 4_000_000,
  largeCommits = 3_000,
} = {}) {
  return {
    name: 'transcript-active-turn-tools',
    status: 'ok',
    durationMs: 1_000,
    tasks: [
      task(toolActiveTurnTaskKind(10), {
        chatStorage: {
          'written.journal.bytes': 2_000,
          'written.activeSidecar.bytes': 2_000,
          'syncs.file': 100,
        },
        provider: { eventsIngested: 20 },
        react: { commits: 40, performedWorkFibers: 400 },
        transcript: { 'turn_grouping.work.messages': 200 },
      }),
      task(toolActiveTurnTaskKind(1_000), {
        chatStorage: {
          'written.journal.bytes': 200_000,
          'written.activeSidecar.bytes': largeBytes,
          'syncs.file': 10_000,
        },
        provider: { eventsIngested: 2_000 },
        react: { commits: largeCommits, performedWorkFibers: 80_000 },
        transcript: { 'turn_grouping.work.messages': 2_000_000 },
      }),
    ],
    work: {
      chatStorage: { 'written.journal.bytes': 202_000 },
      provider: { eventsIngested: 2_020 },
    },
  };
}

test('every P0 section C row is one advisory ratio in the registry', () => {
  assert.equal(SCALING_RATIO_DEFINITIONS.length, 5);
  assert.deepEqual(
    SCALING_RATIO_DEFINITIONS.map((definition) => definition.workstream),
    ['P1', 'P1', 'P2', 'P2', 'P7'],
  );
  for (const definition of SCALING_RATIO_DEFINITIONS) {
    const key = scalingRatioKey(definition);
    assert.equal(registry.metrics[key]?.status, 'advisory', key);
    assert.ok(registry.scenarios[definition.scenario]?.variant, key);
    assert.ok(definition.bound > 0 && definition.bound <= 1.1, key);
  }
  // The gating fixture of later phases is the sequential variant.
  assert.equal(
    registry.scenarios['multi-chat-streaming-sequential'].variant,
    'sequential',
  );
});

test('a ratio above its bound reports its value and marker without failing the run', () => {
  const scenario = activeTurnScenario();
  const ratios = computeScenarioScalingRatios(scenario);
  const bytes = ratios.find(
    (ratio) => ratio.id === 'chatStorageBytesPerEvent1000vs10',
  );
  // (4,200,000 / 2,000) / (4,000 / 20) = 2,100 / 200.
  assert.equal(bytes.status, 'computed');
  assert.equal(bytes.value, 10.5);
  assert.equal(bytes.overBound, true);
  assert.equal(bytes.bound, 1.1);

  const result = { scenarios: [scenario], profile: 'smoke' };
  assert.doesNotThrow(() => finalizeResult(result));
  const metric =
    result.metrics[
      'transcript-active-turn-tools.work.scaling.chatStorageBytesPerEvent1000vs10'
    ];
  assert.deepEqual(
    { ...metric, description: undefined },
    {
      value: 10.5,
      unit: 'ratio',
      kind: 'count',
      direction: 'lower',
      description: undefined,
      bound: 1.1,
      overBound: true,
      workstream: 'P1',
      advisory: true,
    },
  );
  // Reported, never a failure: the scenario keeps its verdict and the run
  // passes.
  assert.equal(scenario.status, 'ok');
  assert.equal(performanceRunSucceeded(result), true);
  assert.match(
    formatScalingRatioLines(result).join('\n'),
    /chatStorageBytesPerEvent1000vs10: 10\.5× \(bound 1\.1×, OVER BOUND; advisory, P1\)/,
  );
  // The ratchet reports registered advisory ratios and never fails on them.
  const verdict = evaluateWorkRatchet(
    { ...result, profile: 'counters', environment: {} },
    {
      registry,
      ceilings: { version: 1, profile: 'counters', platforms: {} },
    },
  );
  assert.equal(verdict.passed, true);
});

test('a ratio at or below its bound is reported without the marker', () => {
  const scenario = activeTurnScenario({
    largeBytes: 20_000,
    largeCommits: 4_000,
  });
  const [bytes] = computeScenarioScalingRatios(scenario);
  // (220,000 / 2,000) / (4,000 / 20) = 110 / 200.
  assert.equal(bytes.value, 0.55);
  assert.equal(bytes.overBound, false);
});

test('renderer work reports every component and the largest as its value', () => {
  const ratios = computeScenarioScalingRatios(activeTurnScenario());
  const renderer = ratios.find(
    (ratio) => ratio.id === 'rendererWorkPerEvent1000vs10',
  );
  assert.equal(renderer.status, 'computed');
  assert.deepEqual(renderer.components, {
    reactCommits: 0.75,
    reactPerformedWorkFibers: 2,
    turnGroupingMessages: 100,
    // No renderer counter counts Markdown blocks yet.
    markdownBlocks: null,
  });
  assert.equal(renderer.value, 100);
  assert.equal(renderer.overBound, true);
});

test('a missing bracket is unavailable, never a zero, and leaves the scope uncollected', () => {
  const scenario = activeTurnScenario();
  scenario.tasks = scenario.tasks.slice(0, 1);
  const ratios = applyScalingRatios(scenario);
  assert.equal(ratios.length, 2);
  for (const ratio of ratios) {
    assert.equal(ratio.status, 'unavailable');
    assert.equal(ratio.value, null);
    assert.equal(ratio.overBound, null);
    assert.match(ratio.reason, /tool_active_turn_1000/);
  }
  assert.equal(scenario.work.scaling, undefined);
  assert.equal(
    collectedWorkScopes(scenario).has(
      'transcript-active-turn-tools.work.scaling',
    ),
    false,
  );
  const result = { scenarios: [scenario] };
  finalizeResult(result);
  assert.equal(
    Object.keys(result.metrics).some((key) => key.includes('.scaling.')),
    false,
  );
  assert.match(formatScalingRatioLines(result)[0], /unavailable - /);
});

test('a sized bracket that did not settle is unavailable, never a measurement', () => {
  // The 100-call turn's leftover work was still in flight when the 1,000-call
  // bracket opened, so that bracket may hold another turn's work.
  const scenario = activeTurnScenario();
  scenario.tasks[1].settled = false;
  const ratios = applyScalingRatios(scenario);
  assert.equal(ratios.length, 2);
  for (const ratio of ratios) {
    assert.equal(ratio.status, 'unavailable');
    assert.equal(ratio.value, null);
    assert.match(ratio.reason, /tool_active_turn_1000 did not settle/);
  }
  assert.equal(scenario.work.scaling, undefined);
  assert.equal(
    taskKindWork(scenario, toolActiveTurnTaskKind(1_000), 'chatStorage'),
    null,
  );
  // A bracket that settled keeps its sum.
  assert.ok(taskKindWork(scenario, toolActiveTurnTaskKind(10), 'chatStorage'));
});

test('every computed ratio becomes the scaling work scope', () => {
  const scenario = activeTurnScenario();
  applyScalingRatios(scenario);
  assert.deepEqual(scenario.work.scaling, {
    chatStorageBytesPerEvent1000vs10: 10.5,
    rendererWorkPerEvent1000vs10: 100,
  });
  assert.ok(
    collectedWorkScopes(scenario).has(
      'transcript-active-turn-tools.work.scaling',
    ),
  );
});

test('a failing ratio computation is reported as unavailable', () => {
  const outcome = evaluateScalingRatio(
    {
      id: 'broken',
      scenario: 'transcript-active-turn-tools',
      workstream: 'P1',
      bound: 1.1,
      description: 'Broken',
      compute: () => {
        throw new Error('bad counters');
      },
    },
    activeTurnScenario(),
  );
  assert.equal(outcome.status, 'unavailable');
  assert.match(outcome.reason, /bad counters/);
});

test('sequential streaming ratios read syncs per event and Codex output bytes per update', () => {
  const stream = (kind, syncs, events, extra = {}) =>
    task(kind, {
      chatStorage: { 'syncs.file': syncs, 'syncs.directory': 1 },
      provider: { eventsIngested: events },
      ipc: {},
      ...extra,
    });
  const scenario = {
    name: 'multi-chat-streaming-sequential',
    status: 'ok',
    tasks: [
      stream('start_sequential_chat_turn', 9, 1),
      stream('sequential_chat_stream', 79, 10),
      stream('codex_output_early', 7, 8, {
        ipc: {
          'send.chat:event.main.bytes': 80_000,
          // Timer work on another channel is not part of an update.
          'send.resource-monitor:snapshot.main.bytes': 3_000,
        },
      }),
      stream('codex_output_late', 7, 8, {
        ipc: { 'send.chat:event.main.bytes': 1_600_000 },
      }),
      stream('complete_sequential_chat_turn', 9, 1),
    ],
    work: { chatStorage: {}, provider: {} },
  };
  const ratios = Object.fromEntries(
    computeScenarioScalingRatios(scenario).map((ratio) => [ratio.id, ratio]),
  );
  // (111 file + 5 directory syncs) / 28 events.
  assert.equal(ratios.syncsPerProviderEvent.value, 4.143);
  assert.equal(ratios.syncsPerProviderEvent.overBound, true);
  assert.equal(ratios.codexOutputIpcBytesPerUpdateLateVsEarly.value, 20);
  assert.deepEqual(
    [...SEQUENTIAL_STREAM_TASK_KINDS].sort(),
    [...new Set(scenario.tasks.map((entry) => entry.kind))].sort(),
  );
});

test('a timed run without IPC byte estimates leaves the Codex output ratio unavailable', () => {
  const stream = (kind, ipc) =>
    task(kind, {
      chatStorage: { 'syncs.file': 7, 'syncs.directory': 1 },
      provider: { eventsIngested: 8 },
      ipc,
    });
  // Timed profiles count messages but never estimate their bytes.
  const messages = { 'send.chat:event.main.messages': 8 };
  const ratios = Object.fromEntries(
    computeScenarioScalingRatios({
      name: 'multi-chat-streaming-sequential',
      status: 'ok',
      tasks: [
        stream('start_sequential_chat_turn', {}),
        stream('sequential_chat_stream', {}),
        stream('codex_output_early', messages),
        stream('codex_output_late', messages),
        stream('complete_sequential_chat_turn', {}),
      ],
      work: { chatStorage: {}, provider: {} },
    }).map((ratio) => [ratio.id, ratio]),
  );
  const codex = ratios.codexOutputIpcBytesPerUpdateLateVsEarly;
  assert.equal(codex.status, 'unavailable');
  assert.match(codex.reason, /counters profile/);
  assert.equal(ratios.syncsPerProviderEvent.status, 'computed');
});

test('the code-graph ratio compares a 1-file edit on the large and small fixtures', () => {
  const [ratio] = computeScenarioScalingRatios({
    name: 'code-graph-small-edit',
    status: 'ok',
    tasks: [],
    work: {
      codeGraph: {
        'edit1.small.filesParsed': 1,
        'edit1.large.filesParsed': 1,
        'edit1.small.rowsWritten': 4_000,
        'edit1.large.rowsWritten': 52_000,
        'edit1.small.resolverPasses': 8,
        'edit1.large.resolverPasses': 8,
        'small.fixtureFiles': 1_000,
        'large.fixtureFiles': 13_000,
      },
    },
  });
  assert.equal(ratio.id, 'codeGraphOneFileEditWorkLargeVsSmall');
  assert.deepEqual(ratio.components, {
    filesParsed: 1,
    rowsWritten: 13,
    resolverPasses: 1,
  });
  assert.equal(ratio.value, 13);
  assert.equal(ratio.overBound, true);
  assert.equal(ratio.inputs.largeFixtureFiles, 13_000);
});

test('a task kind with an unbracketed task has no work sum', () => {
  const scenario = {
    tasks: [
      task('a', {
        provider: { eventsIngested: 1 },
        chatStorage: { commits: 2 },
      }),
      task('a', { provider: { eventsIngested: 3 } }),
      // A failed task is not a completed one; it neither adds nor voids.
      task('a', undefined, { status: 'error' }),
    ],
  };
  assert.deepEqual(taskKindWork(scenario, 'a', 'provider'), {
    eventsIngested: 4,
  });
  assert.equal(taskKindWork(scenario, 'a', 'chatStorage'), null);
  assert.equal(taskKindWork(scenario, 'missing', 'provider'), null);
});

test('the comparator reports ratios exactly as counts, never as timing regressions', () => {
  const run = (value) => {
    const scenario = activeTurnScenario({ largeBytes: value });
    const result = {
      schemaVersion: 2,
      suite: 'desktop-app-performance',
      benchmarkKind: 'e2e-relative',
      profile: 'smoke',
      config: {},
      environment: {},
      scenarios: [scenario],
    };
    finalizeResult(result);
    return result;
  };
  const comparison = comparePerformanceResults(run(4_000_000), run(40_000));
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.regressions.length, 0);
  const entry = comparison.workComparisons.find((candidate) =>
    candidate.key.endsWith('.scaling.chatStorageBytesPerEvent1000vs10'),
  );
  assert.equal(entry.unit, 'ratio');
  assert.equal(entry.baseline, 10.5);
  assert.equal(entry.current, 0.6);
});
