import { roundMetric } from './statistics.mjs';

/**
 * The scaling assertions of the performance strategy's P0 section C
 * (methodology R5). Each is a ratio of work counters taken from one
 * scenario's own brackets, so it is as deterministic as the counters it
 * divides. A ratio above its bound means an O(n) cost per operation.
 *
 * All five are expected to be above their bounds today: nothing before the
 * P1, P2 and P7 fixes changes the chat write model, the renderer, or the code
 * graph. A ratio therefore always reports its value and an `overBound` marker
 * and never fails a run; its gate policy is its entry in `work-metrics.json`,
 * where every one of them is `advisory`. The phase that fixes a cost may
 * promote its ratio to `gating` once it qualifies (phase 02's rule).
 *
 * Ratios are recorded as `kind: 'count'` metrics with the unit `ratio`, under
 * the `scaling` work source: `<scenario>.work.scaling.<id>`.
 */

export const SCALING_WORK_SOURCE = 'scaling';

const RENDERER_COMPONENTS = Object.freeze([
  { name: 'reactCommits', source: 'react', counter: 'commits' },
  {
    name: 'reactPerformedWorkFibers',
    source: 'react',
    counter: 'performedWorkFibers',
  },
  {
    name: 'turnGroupingMessages',
    source: 'transcript',
    counter: 'turn_grouping.work.messages',
  },
]);

// Main-to-renderer bytes on the chat channels (`chat:event`,
// `chat:state-changed`, ...). Only the counters profile estimates bytes; a
// timed run records the messages alone.
const CHAT_SEND_BYTES = /^send\.chat:.+\.bytes$/;

const CODE_GRAPH_COMPONENTS = Object.freeze([
  'filesParsed',
  'rowsWritten',
  'resolverPasses',
]);

/** Task kinds of the sequential multi-chat streaming brackets. */
export const SEQUENTIAL_STREAM_TASK_KINDS = Object.freeze([
  'start_sequential_chat_turn',
  'sequential_chat_stream',
  'codex_output_early',
  'codex_output_late',
  'complete_sequential_chat_turn',
]);

/** Task kind of one clean active-turn bracket in `transcript-active-turn-tools`. */
export function toolActiveTurnTaskKind(size) {
  return `tool_active_turn_${size}`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function unavailable(reason) {
  return { unavailable: reason };
}

/**
 * One source's counters summed over every completed task of `kind`, or null
 * when no task of that kind completed or one of them was not bracketed for
 * the source: a partial sum is not a measurement. Nor is a task marked
 * `settled: false`, whose bracket opened or closed with work still in flight
 * and may hold another bracket's work.
 */
export function taskKindWork(scenario, kind, source) {
  const tasks = (scenario?.tasks ?? []).filter(
    (task) => task.kind === kind && task.status !== 'error',
  );
  if (tasks.length === 0) return null;
  if (tasks.some((task) => task.settled === false)) return null;
  if (!tasks.every((task) => task.work?.[source])) return null;
  const totals = {};
  for (const task of tasks) {
    for (const [counter, value] of Object.entries(task.work[source])) {
      if (Number.isFinite(value))
        totals[counter] = (totals[counter] ?? 0) + value;
    }
  }
  return totals;
}

function sumMatching(counters, pattern) {
  return sum(
    Object.entries(counters ?? {})
      .filter(([counter]) => pattern.test(counter))
      .map(([, value]) => value),
  );
}

function kindsWork(scenario, kinds, source) {
  const totals = {};
  let found = false;
  for (const kind of kinds) {
    const tasks = (scenario?.tasks ?? []).filter(
      (task) => task.kind === kind && task.status !== 'error',
    );
    if (tasks.length === 0) continue;
    const work = taskKindWork(scenario, kind, source);
    if (!work) return null;
    found = true;
    for (const [counter, value] of Object.entries(work)) {
      totals[counter] = (totals[counter] ?? 0) + value;
    }
  }
  return found ? totals : null;
}

/**
 * `large / small`, with `null` when the small side did no work but the large
 * side did (no finite ratio) and 1 when neither did.
 */
function componentRatio(large, small) {
  if (!Number.isFinite(large) || !Number.isFinite(small)) return null;
  if (small === 0) return large === 0 ? 1 : null;
  return large / small;
}

function perEvent(counters, events) {
  return events > 0 ? counters / events : null;
}

function activeTurnInputs(scenario, sizes) {
  const [smallSize, largeSize] = sizes;
  const read = (size) => {
    const kind = toolActiveTurnTaskKind(size);
    const chatStorage = taskKindWork(scenario, kind, 'chatStorage');
    const provider = taskKindWork(scenario, kind, 'provider');
    return {
      kind,
      unsettled: (scenario?.tasks ?? []).some(
        (task) => task.kind === kind && task.settled === false,
      ),
      chatStorage,
      provider,
      react: taskKindWork(scenario, kind, 'react'),
      transcript: taskKindWork(scenario, kind, 'transcript'),
      events: provider?.eventsIngested ?? 0,
    };
  };
  return { small: read(smallSize), large: read(largeSize) };
}

function unsettledActiveTurn(sides) {
  const side = sides.find((candidate) => candidate.unsettled);
  return side
    ? unavailable(
        `${side.kind} did not settle before or after its turn, so its bracket may hold another turn's work`,
      )
    : null;
}

function chatStorageBytesRatio(scenario) {
  const { small, large } = activeTurnInputs(scenario, [10, 1_000]);
  const unsettled = unsettledActiveTurn([small, large]);
  if (unsettled) return unsettled;
  for (const side of [small, large]) {
    if (!side.chatStorage || !side.provider) {
      return unavailable(
        `${side.kind} has no complete chat-storage and provider brackets`,
      );
    }
    if (side.events === 0) {
      return unavailable(`${side.kind} ingested no provider events`);
    }
  }
  const smallBytes = sumMatching(small.chatStorage, /^written\..+\.bytes$/);
  const largeBytes = sumMatching(large.chatStorage, /^written\..+\.bytes$/);
  const value = componentRatio(
    perEvent(largeBytes, large.events),
    perEvent(smallBytes, small.events),
  );
  if (value === null) {
    return unavailable(`${small.kind} wrote no chat-storage bytes`);
  }
  return {
    value,
    inputs: {
      smallActiveTurnToolCalls: 10,
      largeActiveTurnToolCalls: 1_000,
      smallWrittenBytes: smallBytes,
      smallProviderEvents: small.events,
      largeWrittenBytes: largeBytes,
      largeProviderEvents: large.events,
    },
  };
}

function rendererWorkRatio(scenario) {
  const { small, large } = activeTurnInputs(scenario, [10, 1_000]);
  const unsettled = unsettledActiveTurn([small, large]);
  if (unsettled) return unsettled;
  for (const side of [small, large]) {
    if (!side.provider || side.events === 0) {
      return unavailable(`${side.kind} has no provider event bracket`);
    }
  }
  const components = {};
  const inputs = {
    smallProviderEvents: small.events,
    largeProviderEvents: large.events,
  };
  for (const component of RENDERER_COMPONENTS) {
    const smallWork = small[component.source];
    const largeWork = large[component.source];
    if (!smallWork || !largeWork) {
      components[component.name] = null;
      continue;
    }
    const smallValue = smallWork[component.counter] ?? 0;
    const largeValue = largeWork[component.counter] ?? 0;
    inputs[`small.${component.name}`] = smallValue;
    inputs[`large.${component.name}`] = largeValue;
    components[component.name] = componentRatio(
      perEvent(largeValue, large.events),
      perEvent(smallValue, small.events),
    );
  }
  // No renderer counter counts Markdown blocks yet; fibers that performed
  // work stand in for rendered block work until one exists.
  components.markdownBlocks = null;
  const measured = Object.values(components).filter((value) =>
    Number.isFinite(value),
  );
  if (measured.length === 0) {
    return unavailable('no renderer work component was measured');
  }
  return {
    value: Math.max(...measured),
    components,
    inputs,
    note: 'The value is the largest component ratio. Markdown blocks have no counter; performed-work fibers stand in for rendered block work.',
  };
}

function syncsPerEventRatio(scenario) {
  const chatStorage = kindsWork(
    scenario,
    SEQUENTIAL_STREAM_TASK_KINDS,
    'chatStorage',
  );
  const provider = kindsWork(
    scenario,
    SEQUENTIAL_STREAM_TASK_KINDS,
    'provider',
  );
  if (!chatStorage || !provider) {
    return unavailable(
      'the sequential stream brackets have no complete chat-storage and provider counts',
    );
  }
  const events = provider.eventsIngested ?? 0;
  if (events === 0) return unavailable('no provider events were ingested');
  const fileSyncs = chatStorage['syncs.file'] ?? 0;
  const directorySyncs = chatStorage['syncs.directory'] ?? 0;
  return {
    value: (fileSyncs + directorySyncs) / events,
    inputs: { fileSyncs, directorySyncs, providerEvents: events },
  };
}

function codexOutputRatio(scenario) {
  const read = (kind) => ({
    kind,
    ipc: taskKindWork(scenario, kind, 'ipc'),
    provider: taskKindWork(scenario, kind, 'provider'),
  });
  const early = read('codex_output_early');
  const late = read('codex_output_late');
  for (const side of [early, late]) {
    if (!side.ipc || !side.provider) {
      return unavailable(
        `${side.kind} has no complete IPC and provider brackets`,
      );
    }
    if ((side.provider.eventsIngested ?? 0) === 0) {
      return unavailable(`${side.kind} ingested no command-output updates`);
    }
  }
  // Only the chat channels carry an update; the other channels are timer
  // work that lands in whichever bracket it happens to overlap.
  const earlyBytes = sumMatching(early.ipc, CHAT_SEND_BYTES);
  const lateBytes = sumMatching(late.ipc, CHAT_SEND_BYTES);
  // Without byte estimates both sides are zero, which would read as a
  // flat ratio of 1 rather than as missing data.
  if (earlyBytes === 0) {
    return unavailable(
      'the early command-output updates have no IPC byte estimate; only the counters profile estimates bytes',
    );
  }
  const value = componentRatio(
    perEvent(lateBytes, late.provider.eventsIngested),
    perEvent(earlyBytes, early.provider.eventsIngested),
  );
  if (value === null) {
    return unavailable('the early command-output updates sent no IPC bytes');
  }
  return {
    value,
    inputs: {
      earlyIpcBytes: earlyBytes,
      earlyUpdates: early.provider.eventsIngested,
      lateIpcBytes: lateBytes,
      lateUpdates: late.provider.eventsIngested,
    },
  };
}

function codeGraphEditRatio(scenario) {
  const counters = scenario?.work?.codeGraph;
  if (!counters) return unavailable('the scenario recorded no code-graph work');
  const components = {};
  const inputs = {};
  for (const component of CODE_GRAPH_COMPONENTS) {
    const small = counters[`edit1.small.${component}`];
    const large = counters[`edit1.large.${component}`];
    if (!Number.isFinite(small) || !Number.isFinite(large)) {
      components[component] = null;
      continue;
    }
    inputs[`small.${component}`] = small;
    inputs[`large.${component}`] = large;
    components[component] = componentRatio(large, small);
  }
  const measured = Object.values(components).filter((value) =>
    Number.isFinite(value),
  );
  if (measured.length === 0) {
    return unavailable('no 1-file edit work was recorded for both fixtures');
  }
  return {
    value: Math.max(...measured),
    components,
    inputs: {
      ...inputs,
      smallFixtureFiles: counters['small.fixtureFiles'],
      largeFixtureFiles: counters['large.fixtureFiles'],
    },
    note: 'The value is the largest component ratio. The engine has no resolver work-unit counter; resolver passes run stand in for it.',
  };
}

/**
 * Definitions in P0 section C order. `bound` is inclusive: a ratio at or
 * below it passes. `flippedBy` names the phase expected to bring the ratio
 * under its bound.
 */
export const SCALING_RATIO_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'chatStorageBytesPerEvent1000vs10',
    scenario: 'transcript-active-turn-tools',
    workstream: 'P1',
    bound: 1.1,
    flippedBy: 'phase 10 (active turn from the journal, toggle on)',
    description:
      'Chat-storage bytes written per provider event at an active-turn size of 1,000 vs 10 tool calls',
    compute: chatStorageBytesRatio,
  }),
  Object.freeze({
    id: 'syncsPerProviderEvent',
    scenario: 'multi-chat-streaming-sequential',
    workstream: 'P1',
    bound: 1,
    flippedBy: 'phase 09 (delta journal write path, toggle on)',
    description:
      'Chat-storage file and directory syncs per provider event in the sequential variant',
    compute: syncsPerEventRatio,
  }),
  Object.freeze({
    id: 'rendererWorkPerEvent1000vs10',
    scenario: 'transcript-active-turn-tools',
    workstream: 'P2',
    bound: 1.1,
    flippedBy: 'phase 12 (renderer quick wins)',
    description:
      'Renderer per-update work (React commits, performed-work fibers, turn-grouping messages) with a large vs small loaded transcript',
    compute: rendererWorkRatio,
  }),
  Object.freeze({
    id: 'codexOutputIpcBytesPerUpdateLateVsEarly',
    scenario: 'multi-chat-streaming-sequential',
    workstream: 'P2',
    bound: 1.1,
    flippedBy: 'phase 14 (output deltas)',
    description:
      'Chat-channel IPC bytes per Codex command-output update late in a long output vs early',
    compute: codexOutputRatio,
  }),
  Object.freeze({
    id: 'codeGraphOneFileEditWorkLargeVsSmall',
    scenario: 'code-graph-small-edit',
    workstream: 'P7',
    bound: 1.1,
    flippedBy:
      'P7 (code-graph engine rewrite), which this run skips; stays advisory',
    description:
      'Code-graph work for a 1-file edit (files parsed, rows written, resolver passes) on the large vs small fixture',
    compute: codeGraphEditRatio,
  }),
]);

export function scalingRatioKey(definition) {
  return `${definition.scenario}.work.${SCALING_WORK_SOURCE}.${definition.id}`;
}

/**
 * Evaluates one ratio for a scenario. Never throws: a counter that is
 * missing, or a compute step that fails, is reported as `unavailable`, and a
 * value above the bound is reported with `overBound: true`.
 */
export function evaluateScalingRatio(definition, scenario) {
  const base = {
    id: definition.id,
    key: scalingRatioKey(definition),
    scenario: definition.scenario,
    workstream: definition.workstream,
    bound: definition.bound,
    flippedBy: definition.flippedBy,
    description: definition.description,
  };
  let outcome;
  try {
    outcome = definition.compute(scenario);
  } catch (error) {
    outcome = unavailable(
      `ratio computation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!outcome || outcome.unavailable || !Number.isFinite(outcome.value)) {
    return {
      ...base,
      status: 'unavailable',
      value: null,
      overBound: null,
      reason: outcome?.unavailable ?? 'the ratio has no finite value',
    };
  }
  const value = roundMetric(outcome.value);
  return {
    ...base,
    status: 'computed',
    value,
    overBound: value > definition.bound,
    ...(outcome.components
      ? {
          components: Object.fromEntries(
            Object.entries(outcome.components).map(([name, component]) => [
              name,
              Number.isFinite(component) ? roundMetric(component) : null,
            ]),
          ),
        }
      : {}),
    inputs: outcome.inputs,
    ...(outcome.note ? { note: outcome.note } : {}),
  };
}

/** The ratios defined for this scenario, evaluated against its work. */
export function computeScenarioScalingRatios(scenario) {
  if (!scenario?.work || scenario.status === 'error') return [];
  return SCALING_RATIO_DEFINITIONS.filter(
    (definition) => definition.scenario === scenario.name,
  ).map((definition) => evaluateScalingRatio(definition, scenario));
}

/**
 * Records the scenario's ratios as `scenarios[].scalingRatios` and, only when
 * every one of them was computed, as the `scaling` work scope. A scope with a
 * missing ratio would read that ratio as a measured zero.
 */
export function applyScalingRatios(scenario) {
  const ratios = computeScenarioScalingRatios(scenario);
  if (ratios.length === 0) return ratios;
  scenario.scalingRatios = ratios;
  if (ratios.every((ratio) => ratio.status === 'computed')) {
    scenario.work[SCALING_WORK_SOURCE] = Object.fromEntries(
      ratios.map((ratio) => [ratio.id, ratio.value]),
    );
  } else {
    delete scenario.work[SCALING_WORK_SOURCE];
  }
  return ratios;
}

/**
 * Flat metrics for the scenario's computed ratios. They are advisory
 * reports; `work-metrics.json` holds their gate policy.
 */
export function scalingRatioMetrics(scenario) {
  const metrics = {};
  for (const ratio of scenario?.scalingRatios ?? []) {
    if (ratio.status !== 'computed') continue;
    metrics[ratio.key] = {
      value: ratio.value,
      unit: 'ratio',
      kind: 'count',
      direction: 'lower',
      description: `${ratio.description} (bound ${ratio.bound}×)`,
      bound: ratio.bound,
      overBound: ratio.overBound,
      workstream: ratio.workstream,
      advisory: true,
    };
  }
  return metrics;
}

/** One report line per ratio a run evaluated. */
export function formatScalingRatioLines(result) {
  const lines = [];
  for (const scenario of result?.scenarios ?? []) {
    for (const ratio of scenario.scalingRatios ?? []) {
      lines.push(
        ratio.status === 'computed'
          ? `[perf] Scaling ratio ${ratio.key}: ${ratio.value}× (bound ${ratio.bound}×, ${ratio.overBound ? 'OVER BOUND' : 'within bound'}; advisory, ${ratio.workstream})`
          : `[perf] Scaling ratio ${ratio.key}: unavailable - ${ratio.reason}`,
      );
    }
  }
  return lines;
}
