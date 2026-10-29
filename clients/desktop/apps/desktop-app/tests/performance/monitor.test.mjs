import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import {
  CHROMIUM_WORK_METRICS,
  FRAME_BUDGET_METHOD,
  assertValidMonitoring,
  assertValidRendererSampling,
  assertValidResourceSampling,
  assertValidTypingSampling,
  buildFrameBudgetReport,
  buildSummary,
  diffWorkCounters,
  evaluateMainWithRetry,
  frameBudgetForWindow,
  normalizeAppMetrics,
  openRendererWorkSession,
  selectChromiumWorkMetrics,
  startPerformanceMonitor,
  summarizeLongAnimationFrames,
  summarizeSeries,
} from './monitor.mjs';
import { summarize } from './statistics.mjs';

function rawMonitoring(overrides = {}) {
  return {
    ipcSamples: [],
    resourceSamples: [],
    renderer: null,
    ...overrides,
  };
}

test('IPC timeout duration contributes to the outer latency ceiling', () => {
  const summary = buildSummary(
    rawMonitoring({
      ipcSamples: [
        { outerMs: 25, handlerMs: 20, timeout: false },
        { outerMs: 5_001, timeout: true },
      ],
    }),
  );

  assert.equal(summary.ipcOuterMs.max, 5_001);
  assert.equal(summary.ipcOuterMs.count, 2);
  assert.equal(summary.ipcTimeoutCount, 1);
});

test('IPC probe errors are counted separately from timeouts', () => {
  const summary = buildSummary(
    rawMonitoring({
      ipcSamples: [
        { outerMs: 25, handlerMs: 20, timeout: false },
        { outerMs: 30, error: 'preferences unavailable' },
      ],
    }),
  );

  assert.equal(summary.ipcErrorCount, 1);
  assert.equal(summary.ipcTimeoutCount, 0);
});

test('typing summaries keep handler, next-frame, and paint-confirmation latency separate', () => {
  const summary = buildSummary(
    rawMonitoring({
      renderer: {
        keyEventHandlerMs: [1, 3],
        keyToNextFrameMs: [8, 12],
        keyToPaintConfirmationMs: [24, 30],
      },
    }),
  );

  assert.equal(summary.rendererKeyEventHandlerMs.max, 3);
  assert.equal(summary.rendererKeyToNextFrameMs.max, 12);
  assert.equal(summary.rendererKeyToPaintConfirmationMs.max, 30);
  assert.equal('rendererInputToFrameMs' in summary, false);
});

test('transcript stage attribution is preserved in the monitoring summary', () => {
  const transcript = {
    schemaVersion: 1,
    startedAt: 10,
    stages: {
      turn_grouping: {
        count: 2,
        totalMs: 15,
        maxMs: 11,
        work: { messages: 100, groups: 10 },
      },
    },
    counters: { canonical_changes: 4 },
  };
  const summary = buildSummary(rawMonitoring({ renderer: { transcript } }));

  assert.deepEqual(summary.transcriptStages, transcript.stages);
  assert.deepEqual(summary.transcriptCounters, transcript.counters);
});

test('transcript attribution separates renderer, IPC, and process resources', () => {
  const summary = buildSummary(
    rawMonitoring({
      ipcSamples: [{ correlationId: 'ipc-1', outerMs: 12, timeout: false }],
      resourceSamples: [
        {
          processes: [
            {
              pid: 1,
              type: 'Browser',
              cpuPercent: 10,
              workingSetSizeKb: 2_048,
            },
            {
              pid: 2,
              type: 'Tab',
              cpuPercent: 20,
              workingSetSizeKb: 4_096,
            },
          ],
        },
      ],
      renderer: {
        transcript: {
          schemaVersion: 2,
          startedAt: 10,
          stages: {
            react_commit: { count: 1, totalMs: 2, maxMs: 2, work: {} },
          },
          counters: { loaded_message_rows: 40, loaded_bytes: 8_000 },
        },
      },
      mainTranscript: {
        schemaVersion: 1,
        process: 'main',
        stages: {
          range_read: {
            count: 1,
            totalMs: 5,
            maxMs: 5,
            work: { loadedRows: 40, loadedBytes: 8_000 },
          },
        },
        correlations: [],
      },
    }),
  );

  assert.deepEqual(summary.transcriptAttribution.renderer.stages, {
    react_commit: { count: 1, totalMs: 2, maxMs: 2, work: {} },
  });
  assert.equal(
    summary.transcriptAttribution.ipc.samples[0].correlationId,
    'ipc-1',
  );
  assert.equal(summary.transcriptAttribution.main.stages.range_read.maxMs, 5);
  assert.equal(
    summary.transcriptAttribution.processes.Browser.cpuPercent.max,
    10,
  );
  assert.equal(summary.transcriptAttribution.processes.Tab.workingSetMb.max, 4);
});

test('same-type sibling processes are aggregated once per sampling tick', () => {
  const summary = buildSummary(
    rawMonitoring({
      resourceSamples: [
        {
          processes: [
            { pid: 1, type: 'Tab', cpuPercent: 10, workingSetSizeKb: 2_048 },
            { pid: 2, type: 'Tab', cpuPercent: 20, workingSetSizeKb: 4_096 },
          ],
        },
        {
          processes: [
            { pid: 1, type: 'Tab', cpuPercent: 5, workingSetSizeKb: 1_024 },
            { pid: 2, type: 'Tab', cpuPercent: 7, workingSetSizeKb: 3_072 },
          ],
        },
      ],
    }),
  );

  assert.equal(
    summary.transcriptAttribution.processAggregation,
    'per-sample-type-total',
  );
  assert.equal(summary.transcriptAttribution.processes.Tab.cpuPercent.count, 2);
  assert.equal(summary.transcriptAttribution.processes.Tab.cpuPercent.max, 30);
  assert.equal(summary.transcriptAttribution.processes.Tab.workingSetMb.max, 6);
});

test('Electron CPU usage uses the ProcessMetric percentCPUUsage field', () => {
  const [metric] = normalizeAppMetrics([
    {
      pid: 42,
      type: 'Browser',
      cpu: { percentCPUUsage: 37.5 },
      memory: { workingSetSize: 2_048 },
    },
  ]);

  assert.equal(metric.cpuPercent, 37.5);
});

test('failed resource samples are excluded from usage summaries', () => {
  const summary = buildSummary(
    rawMonitoring({
      resourceSamples: [
        {
          processes: [
            { cpuPercent: 12, workingSetSizeKb: 2_048 },
            { cpuPercent: 8, workingSetSizeKb: 1_024 },
          ],
          retries: 1,
        },
        { processes: [], error: 'timeout' },
      ],
    }),
  );

  assert.equal(summary.totalCpuPercent.count, 1);
  assert.equal(summary.totalCpuPercent.max, 20);
  assert.equal(summary.totalWorkingSetMb.max, 3);
  assert.equal(summary.processCount.max, 2);
  assert.equal(summary.resourceSampleErrorCount, 1);
  assert.equal(summary.resourceFatalErrorCount, 1);
  assert.equal(summary.resourceTransientErrorCount, 0);
  assert.equal(summary.resourceValidSampleCount, 1);
  assert.equal(summary.resourceSampleRetryCount, 1);
  assert.throws(
    () => assertValidResourceSampling(summary),
    /Resource sampling was invalid: 1 fatal, 0 transient, 1 valid/,
  );
});

test('supervised process-tree summaries include utility native descendants', () => {
  const summary = buildSummary(
    rawMonitoring({
      nativeTreeSamples: [
        {
          processes: [
            { pid: 1, ppid: 0, cpuPercent: 4, rssKb: 2_048 },
            { pid: 2, ppid: 1, cpuPercent: 7, rssKb: 1_024 },
          ],
        },
      ],
    }),
  );

  assert.equal(summary.supervisedTreeCpuPercent.max, 11);
  assert.equal(summary.supervisedTreeWorkingSetMb.max, 3);
  assert.equal(summary.supervisedTreeProcessCount.max, 2);
  assert.equal(summary.nativeTreeSampleErrorCount, 0);
});

test('resource sampling requires enough successful samples for a run', () => {
  assert.throws(
    () =>
      assertValidResourceSampling({
        resourceSampleErrorCount: 0,
        resourceTransientErrorCount: 0,
        resourceFatalErrorCount: 0,
        resourceValidSampleCount: 1,
      }),
    /Resource sampling was invalid: 0 fatal, 0 transient, 1 valid/,
  );
  assert.doesNotThrow(() =>
    assertValidResourceSampling({
      resourceSampleErrorCount: 0,
      resourceTransientErrorCount: 0,
      resourceFatalErrorCount: 0,
      resourceValidSampleCount: 2,
    }),
  );
});

test('resource sampling tolerates a bounded evaluator context reset rate with enough valid data', () => {
  const summary = buildSummary(
    rawMonitoring({
      resourceSamples: [
        ...Array.from({ length: 10 }, () => ({ processes: [] })),
        {
          processes: [],
          error:
            'electronApplication.evaluate: Execution context was destroyed',
        },
      ],
    }),
  );
  assert.equal(summary.resourceTransientErrorCount, 1);
  assert.equal(summary.resourceFatalErrorCount, 0);
  assert.doesNotThrow(() => assertValidResourceSampling(summary));
  assert.doesNotThrow(() =>
    assertValidResourceSampling({
      resourceSampleErrorCount: 4,
      resourceTransientErrorCount: 4,
      resourceFatalErrorCount: 0,
      resourceValidSampleCount: 252,
    }),
  );
  assert.throws(
    () =>
      assertValidResourceSampling({
        resourceSampleErrorCount: 3,
        resourceTransientErrorCount: 3,
        resourceFatalErrorCount: 0,
        resourceValidSampleCount: 100,
      }),
    /0 fatal, 3 transient, 100 valid/,
  );
});

test('renderer sampling rejects failed or missing snapshots', () => {
  assert.throws(
    () => assertValidRendererSampling({ rendererCollectionError: 'timeout' }),
    /Renderer sampling was invalid: timeout/,
  );
  assert.throws(
    () =>
      assertValidRendererSampling({
        rendererCollectionError: 'missing snapshot',
      }),
    /Renderer sampling was invalid: missing snapshot/,
  );
  assert.doesNotThrow(() =>
    assertValidRendererSampling({ rendererCollectionError: null }),
  );
});

test('monitoring validation includes renderer collection validity', () => {
  assert.throws(
    () =>
      assertValidMonitoring({
        resourceSampleErrorCount: 0,
        resourceValidSampleCount: 2,
        rendererCollectionError: 'renderer unavailable',
      }),
    /Renderer sampling was invalid: renderer unavailable/,
  );
});

test('typing sampling requires one complete renderer sample set per typed character', () => {
  const raw = {
    renderer: {
      keyEventHandlerMs: [1, 2],
      keyToNextFrameMs: [8, 9],
      keyToPaintConfirmationMs: [24, 25],
    },
  };
  const tasks = [
    { kind: 'type_during_pipeline_load', characters: 2 },
    { kind: 'navigate_during_pipeline_load' },
  ];

  assert.doesNotThrow(() => assertValidTypingSampling(raw, tasks));
  raw.renderer.keyToNextFrameMs.pop();
  assert.throws(
    () => assertValidTypingSampling(raw, tasks),
    /expected 2 samples.*"keyToNextFrame":1/,
  );
});

test('monitor stop cancels pending sample delays', async () => {
  let pageEvaluateCalls = 0;
  const page = {
    async evaluate() {
      pageEvaluateCalls += 1;
      if (pageEvaluateCalls >= 2) {
        return {
          intervalDelaysMs: [],
          frameGapsMs: [],
          keyEventHandlerMs: [],
          keyToNextFrameMs: [],
          keyToPaintConfirmationMs: [],
          longTasks: [],
          jsHeapUsedBytes: [],
          ipcSamples: [{ outerMs: 12, handlerMs: 12, timeout: false }],
          transcript: {
            schemaVersion: 1,
            stages: {},
            counters: { page_installs: 2 },
          },
        };
      }
      return undefined;
    },
  };
  const electronApp = {
    async evaluate() {
      return [];
    },
  };
  const monitor = await startPerformanceMonitor({
    page,
    electronApp,
    sampleIntervalMs: 60_000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const startedAt = Date.now();
  const result = await monitor.stop();

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(result.raw.ipcSamples.length, 1);
  assert.equal(result.raw.resourceSamples.length, 1);
  assert.equal(result.raw.renderer.transcript.counters.page_installs, 2);
});

test('resource sampling retries one transient Electron evaluation context loss', async () => {
  let pageEvaluateCalls = 0;
  const page = {
    async evaluate() {
      pageEvaluateCalls += 1;
      if (pageEvaluateCalls === 2) return 1;
      if (pageEvaluateCalls >= 3) {
        return {
          intervalDelaysMs: [],
          frameGapsMs: [],
          inputToFrameMs: [],
          longTasks: [],
          jsHeapUsedBytes: [],
        };
      }
      return undefined;
    },
  };
  let appMetricsCalls = 0;
  const electronApp = {
    async evaluate() {
      appMetricsCalls += 1;
      if (appMetricsCalls === 2) {
        throw new Error(
          'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.',
        );
      }
      return [];
    },
  };
  const monitor = await startPerformanceMonitor({
    page,
    electronApp,
    sampleIntervalMs: 60_000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const result = await monitor.stop();

  assert.equal(appMetricsCalls, 4);
  assert.equal(result.raw.resourceSamples.length, 1);
  assert.equal(result.raw.resourceSamples[0].error, undefined);
  assert.equal(result.raw.resourceSamples[0].retries, 1);
  assert.equal(result.summary.resourceSampleErrorCount, 0);
  assert.equal(result.summary.resourceSampleRetryCount, 1);
});

test('study admission waits for running and retains queued observations; terminal-before-overlap fails', async () => {
  const { waitForInventoryAdmission } =
    await import('./browser-profiles-evidence.mjs');
  let now = 0;
  const observations = [];
  const statuses = ['queued', 'queued', 'running'];
  await waitForInventoryAdmission({
    observe: async () => {
      const job = { status: statuses.shift() };
      observations.push(job);
      return job;
    },
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
  });
  assert.deepEqual(
    observations.map((x) => x.status),
    ['queued', 'queued', 'running'],
  );
  await assert.rejects(
    waitForInventoryAdmission({
      observe: async () => ({ status: 'complete' }),
    }),
    /overlap/,
  );
  now = 0;
  await assert.rejects(
    waitForInventoryAdmission({
      observe: async () => ({ status: 'queued' }),
      now: () => now,
      pause: async (ms) => {
        now += ms;
      },
    }),
    /10000/,
  );
  assert.equal(now, 10000);
});

test('foreground readiness requires exact identity, document, content and decorated-window fit', async () => {
  const { foregroundReady } = await import('./browser-profiles-evidence.mjs');
  const state = {
    id: 1,
    webContentsId: 2,
    rendererPid: 3,
    ownerMatches: true,
    destroyed: false,
    minimized: false,
    visible: true,
    focused: true,
    url: 'file:///app/index.html',
    viewport: { width: 1000, height: 640 },
    documentVisible: true,
    documentFocused: true,
    contentBounds: { x: 0, y: 25, width: 1000, height: 640 },
    bounds: { x: 0, y: 0, width: 1000, height: 665 },
    display: { workArea: { x: 0, y: 0, width: 1024, height: 700 } },
  };
  assert(foregroundReady(state));
  for (const delta of [
    { focused: false },
    { ownerMatches: false },
    { documentVisible: false },
    { contentBounds: { width: 1024, height: 677 } },
    { bounds: { x: 0, y: 40, width: 1000, height: 665 } },
  ])
    assert(!foregroundReady({ ...state, ...delta }));
});

test('primary collector retains every frame and task boundary in its renderer clock without diagnostics', async () => {
  const { runInNewContext } = await import('node:vm');
  const { markRendererTask } = await import('./monitor.mjs');
  let now = 100,
    nextFrame = 1;
  const frames = new Map();
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    activeElement: { tagName: 'INPUT' },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const context = {
    document,
    performance: { now: () => now, timeOrigin: 12345 },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (fn) => {
      frames.set(nextFrame, fn);
      return nextFrame++;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  context.window = {
    ...context,
    api: { loadPreferences: async () => ({}) },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const page = {
    evaluate: (fn, arg) =>
      runInNewContext(
        `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`,
        context,
      ),
  };
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: {
      evaluate: async () => [
        {
          pid: 1,
          cpu: { percentCPUUsage: 1 },
          memory: { workingSetSize: 100 },
        },
      ],
    },
    sampleIntervalMs: 60000,
  });
  await markRendererTask(page, 'task:start:workspace');
  for (const timestamp of [101, 118, 318]) {
    now = timestamp + 1;
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(timestamp);
  }
  await markRendererTask(page, 'task:end:workspace:ok');
  const result = await monitor.stop();
  assert.deepEqual(Array.from(result.raw.renderer.frameGapsMs), [17, 200]);
  assert.deepEqual(
    Array.from(result.raw.renderer.frames, (x) => x.timestampMs),
    [101, 118, 318],
  );
  assert.deepEqual(
    Array.from(result.raw.renderer.frames, (x) => x.observedAtMs),
    [102, 119, 319],
  );
  assert.equal(result.raw.renderer.timeOrigin, 12345);
  assert.equal(result.raw.renderer.taskEvents.length, 2);
  assert.equal(result.raw.renderer.taskEvents[1].atMs, 319);
  assert.equal(result.raw.renderer.longTaskObserverAvailable, true);
  assert.equal(listeners.size, 0);
});

/** A React work query like the one E2E renderer builds install. */
function fakeReactWork(generation = 'page-1') {
  const state = { generation, resets: 0, commits: 0, performedWorkFibers: 0 };
  const snapshot = () => ({
    generation: `${state.generation}:${state.resets}`,
    counters: {
      commits: state.commits,
      performedWorkFibers: state.performedWorkFibers,
    },
  });
  return {
    state,
    query: {
      snapshot,
      reset() {
        state.resets += 1;
        state.commits = 0;
        state.performedWorkFibers = 0;
        return snapshot();
      },
    },
  };
}

async function fakeRendererPage({ reactWork = fakeReactWork().query } = {}) {
  const { runInNewContext } = await import('node:vm');
  const noop = () => undefined;
  const context = {
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      activeElement: null,
      addEventListener: noop,
      removeEventListener: noop,
    },
    performance: { now: () => 100, timeOrigin: 1 },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
    setInterval: () => 1,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  context.window = {
    ...context,
    api: { loadPreferences: async () => ({}) },
    addEventListener: noop,
    removeEventListener: noop,
    ...(reactWork ? { __CANOPY_REACT_WORK__: reactWork } : {}),
  };
  const page = {
    evaluate: (fn, arg) =>
      runInNewContext(
        `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`,
        context,
      ),
  };
  return { page, window: context.window };
}

/** The main-process work counters query E2E builds install. */
function fakeMainWorkCounters() {
  const state = {
    generation: 0,
    resets: [],
    counters: { ipc: {}, chatStorage: {}, provider: {}, route: {} },
  };
  const snapshot = () => ({
    generation: state.generation,
    ipc: { ...state.counters.ipc },
    chatStorage: { ...state.counters.chatStorage },
    provider: { ...state.counters.provider },
    route: { ...state.counters.route },
  });
  return {
    state,
    query: {
      snapshot,
      reset(options) {
        state.resets.push(JSON.parse(JSON.stringify(options ?? {})));
        state.generation += 1;
        state.counters = { ipc: {}, chatStorage: {}, provider: {}, route: {} };
        return snapshot();
      },
    },
  };
}

/**
 * Electron main for `electronApp.evaluate`: callbacks run in their own realm
 * with the Electron module as their first argument, as Playwright runs them.
 */
function fakeMainProcess({ workCounters = fakeMainWorkCounters().query } = {}) {
  const context = createContext({
    performance: { now: () => 1 },
    electron: { app: { getAppMetrics: () => [] } },
    ...(workCounters ? { __CANOPY_WORK_COUNTERS__: workCounters } : {}),
  });
  return {
    evaluate: async (fn, arg) =>
      runInContext(
        `(${fn.toString()})(electron, ${JSON.stringify(arg) ?? 'undefined'})`,
        context,
      ),
  };
}

function chromiumMetrics(values) {
  return Object.entries({
    Timestamp: 1,
    LayoutDuration: 0.25,
    RecalcStyleDuration: 0.5,
    ScriptDuration: 3,
    JSHeapUsedSize: 1_000_000,
    ...values,
  }).map(([name, value]) => ({ name, value }));
}

function fakeWorkSession({ enable, samples = [], detach } = {}) {
  const calls = [];
  const session = {
    async send(method) {
      calls.push(method);
      if (method === 'Performance.enable') {
        if (enable) await enable();
        return {};
      }
      if (method === 'Performance.getMetrics') {
        const next = samples.shift();
        if (next instanceof Error) throw next;
        return { metrics: chromiumMetrics(next ?? {}) };
      }
      throw new Error(`Unexpected CDP method ${method}`);
    },
    async detach() {
      calls.push('detach');
      if (detach) await detach();
    },
  };
  return { session, calls };
}

const IDLE_ELECTRON_APP = fakeMainProcess();

// VM-evaluated values come from another realm; compare their plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Chromium work metrics keep only the six work counters, never durations', () => {
  assert.deepEqual(CHROMIUM_WORK_METRICS, [
    'LayoutCount',
    'RecalcStyleCount',
    'Nodes',
    'JSEventListeners',
    'Documents',
    'Frames',
  ]);
  assert.deepEqual(
    selectChromiumWorkMetrics(
      chromiumMetrics({
        LayoutCount: 4,
        RecalcStyleCount: 9,
        Nodes: 1_200,
        JSEventListeners: 80,
        Documents: 2,
        Frames: 1,
        LayoutObjects: 900,
      }),
    ),
    {
      LayoutCount: 4,
      RecalcStyleCount: 9,
      Nodes: 1_200,
      JSEventListeners: 80,
      Documents: 2,
      Frames: 1,
    },
  );
  assert.deepEqual(
    selectChromiumWorkMetrics([{ name: 'Nodes', value: Number.NaN }]),
    {},
  );
});

test('work counter deltas keep the signed change of every observed counter in key order', () => {
  const delta = diffWorkCounters(
    { Nodes: 500, LayoutCount: 10, Documents: 1, Removed: 2 },
    { Nodes: 450, LayoutCount: 14, Documents: 1, Added: 3 },
  );
  // An unchanged counter is an explicit zero; a missing one counts as zero.
  assert.deepEqual(delta, {
    Added: 3,
    Documents: 0,
    LayoutCount: 4,
    Nodes: -50,
    Removed: -2,
  });
  assert.deepEqual(Object.keys(delta), [
    'Added',
    'Documents',
    'LayoutCount',
    'Nodes',
    'Removed',
  ]);
  assert.deepEqual(diffWorkCounters(undefined, { Nodes: 0 }), { Nodes: 0 });
  assert.deepEqual(diffWorkCounters({ Nodes: 1 }, { Nodes: Number.NaN }), {});
});

test('work counters use a dedicated renderer session and report per-bracket Chromium deltas', async () => {
  const { page, window } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession({
    samples: [
      { LayoutCount: 2, RecalcStyleCount: 5, Nodes: 1_000 },
      { LayoutCount: 6, RecalcStyleCount: 5, Nodes: 1_040 },
      { LayoutCount: 9, RecalcStyleCount: 8, Nodes: 990, Frames: 1 },
    ],
  });
  const targets = [];
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess(),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async (target) => {
      targets.push(target);
      return session;
    },
  });
  assert.deepEqual(targets, [page]);
  assert.deepEqual(calls, ['Performance.enable', 'Performance.getMetrics']);

  window.__CANOPY_TRANSCRIPT_PERF__.counters.page_installs = 1;
  window.__CANOPY_TRANSCRIPT_PERF__.stages.turn_grouping = {
    count: 1,
    totalMs: 4,
    maxMs: 4,
    work: { messages: 40 },
  };
  const sample = await monitor.sampleWork();
  assert.deepEqual(plain(sample), {
    transcript: {
      stages: {
        turn_grouping: {
          count: 1,
          totalMs: 4,
          maxMs: 4,
          work: { messages: 40 },
        },
      },
      counters: { page_installs: 1 },
    },
    chromium: {
      LayoutCount: 6,
      RecalcStyleCount: 5,
      Nodes: 1_040,
    },
    ipc: { generation: 1, counters: {} },
    chatStorage: { generation: 1, counters: {} },
    provider: { generation: 1, counters: {} },
    react: {
      generation: 'page-1:1',
      counters: { commits: 0, performedWorkFibers: 0 },
    },
    errors: [],
  });

  const result = await monitor.stop();
  assert.deepEqual(result.summary.chromiumWork, {
    Frames: 1,
    LayoutCount: 7,
    Nodes: -10,
    RecalcStyleCount: 3,
  });
  assert.deepEqual(result.summary.workErrors, []);
  assert.deepEqual(result.raw.work.chromium.start, {
    LayoutCount: 2,
    RecalcStyleCount: 5,
    Nodes: 1_000,
  });
  assert.deepEqual(calls, [
    'Performance.enable',
    'Performance.getMetrics',
    'Performance.getMetrics',
    'Performance.getMetrics',
    'detach',
  ]);
  await monitor.stop();
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('work counters ask main to estimate IPC bytes only when the caller opts in', async () => {
  const main = fakeMainWorkCounters();
  const { page } = await fakeRendererPage({
    reactWork: fakeReactWork().query,
  });
  const { session } = fakeWorkSession();

  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: main.query }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    estimateIpcBytes: true,
    newCDPSession: async () => session,
  });
  assert.deepEqual(main.state.resets, [{ estimateIpcBytes: true }]);
  // Later bracket reads snapshot without resetting, so the choice is made once.
  await monitor.sampleWork();
  assert.equal(main.state.resets.length, 1);
  await monitor.stop();
});

test('work counters reset the app counters at the window start and bracket them per sample', async () => {
  const main = fakeMainWorkCounters();
  const react = fakeReactWork();
  const { page } = await fakeRendererPage({ reactWork: react.query });
  const { session } = fakeWorkSession();
  // Counts from before the measured window are cleared by its reset.
  main.state.counters.ipc['invoke.boot:load'] = 40;
  react.state.commits = 12;

  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: main.query }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  // A timed window never pays for IPC byte estimation; only a caller that
  // needs byte counts asks for it.
  assert.deepEqual(main.state.resets, [{ estimateIpcBytes: false }]);
  assert.equal(react.state.resets, 1);

  main.state.counters.ipc['send.chat:event.main.messages'] = 2;
  main.state.counters.chatStorage.commits = 1;
  main.state.counters.provider.eventsIngested = 1;
  react.state.commits = 3;
  react.state.performedWorkFibers = 21;
  const sample = await monitor.sampleWork();
  assert.deepEqual(plain(sample.ipc), {
    generation: 1,
    counters: { 'send.chat:event.main.messages': 2 },
  });
  assert.deepEqual(plain(sample.chatStorage), {
    generation: 1,
    counters: { commits: 1 },
  });
  assert.deepEqual(plain(sample.provider), {
    generation: 1,
    counters: { eventsIngested: 1 },
  });
  assert.deepEqual(plain(sample.react), {
    generation: 'page-1:1',
    counters: { commits: 3, performedWorkFibers: 21 },
  });
  assert.deepEqual(sample.errors, []);

  main.state.counters.ipc['send.chat:event.main.messages'] = 5;
  main.state.counters.chatStorage['syncs.file'] = 4;
  react.state.commits = 4;
  const result = await monitor.stop();
  assert.deepEqual(plain(result.summary.appWork), {
    ipc: { 'send.chat:event.main.messages': 5 },
    chatStorage: { commits: 1, 'syncs.file': 4 },
    provider: { eventsIngested: 1 },
    react: { commits: 4, performedWorkFibers: 21 },
  });
  assert.deepEqual(result.summary.workErrors, []);
});

test('the routed-read counters stay out of the sampled app work', async () => {
  const main = fakeMainWorkCounters();
  const { page } = await fakeRendererPage({ reactWork: fakeReactWork().query });
  const { session } = fakeWorkSession();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: main.query }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  main.state.counters.route['files.roots.daemon'] = 1;
  main.state.counters.provider.eventsIngested = 1;
  const sample = await monitor.sampleWork();
  assert.equal(sample.route, undefined);
  const result = await monitor.stop();
  assert.deepEqual(Object.keys(plain(result.summary.appWork)).sort(), [
    'chatStorage',
    'ipc',
    'provider',
    'react',
  ]);
  assert.deepEqual(result.summary.workErrors, []);
});

test('the window keeps the routed-read counters as evidence of each read backend', async () => {
  const main = fakeMainWorkCounters();
  const { page } = await fakeRendererPage({ reactWork: fakeReactWork().query });
  const { session } = fakeWorkSession();
  // Reads before the measured window are cleared by its reset.
  main.state.counters.route['files.roots.direct'] = 4;
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: main.query }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  main.state.counters.route['files.roots.daemon'] = 1;
  main.state.counters.route['files.roots.daemon.served'] = 1;
  main.state.counters.route['files.directory.daemon'] = 2;
  const result = await monitor.stop();
  assert.deepEqual(plain(result.summary.routeWork), {
    'files.directory.daemon': 2,
    'files.roots.daemon': 1,
    'files.roots.daemon.served': 1,
  });
  assert.equal(result.summary.appWork.route, undefined);
  assert.deepEqual(result.summary.workErrors, []);
});

test('a build without routed-read counters records no route evidence and no error', async () => {
  const main = fakeMainWorkCounters();
  const withoutRoute = (snapshot) => {
    const copy = { ...snapshot };
    delete copy.route;
    return copy;
  };
  const legacy = {
    snapshot: () => withoutRoute(main.query.snapshot()),
    reset: (options) => withoutRoute(main.query.reset(options)),
  };
  const { page } = await fakeRendererPage({ reactWork: fakeReactWork().query });
  const { session } = fakeWorkSession();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: legacy }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  main.state.counters.provider.eventsIngested = 1;
  const result = await monitor.stop();
  assert.equal(Object.hasOwn(result.summary, 'routeWork'), false);
  assert.deepEqual(plain(result.summary.appWork.provider), {
    eventsIngested: 1,
  });
  assert.deepEqual(result.summary.workErrors, []);
});

test('route evidence is dropped when the counters reset inside the window', async () => {
  const main = fakeMainWorkCounters();
  const { page } = await fakeRendererPage({ reactWork: fakeReactWork().query });
  const { session } = fakeWorkSession();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: main.query }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  main.query.reset({});
  main.state.counters.route['files.roots.daemon'] = 1;
  const result = await monitor.stop();
  assert.equal(Object.hasOwn(result.summary, 'routeWork'), false);
  assert.ok(
    result.summary.workErrors.some(
      (error) =>
        error.source === 'ipc' &&
        error.message === 'counters were reset during the measured window',
    ),
  );
});

test('app counters that are missing or reset during the window are dropped with errors', async () => {
  const react = fakeReactWork('page-1');
  const { page, window } = await fakeRendererPage({ reactWork: react.query });
  const { session } = fakeWorkSession();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: fakeMainProcess({ workCounters: null }),
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  // A renderer reload installs a fresh hook with restarted counts.
  window.__CANOPY_REACT_WORK__ = fakeReactWork('page-2').query;
  const sample = await monitor.sampleWork();
  assert.equal(sample.ipc, undefined);
  assert.equal(plain(sample.react).generation, 'page-2:0');

  const result = await monitor.stop();
  assert.deepEqual(plain(result.summary.appWork), {});
  assert.deepEqual(result.summary.workErrors, [
    { source: 'ipc', message: 'reset: not installed' },
    { source: 'chatStorage', message: 'reset: not installed' },
    { source: 'provider', message: 'reset: not installed' },
    {
      source: 'react',
      message: 'counters were reset during the measured window',
    },
  ]);
});

test('a failed Performance.enable detaches the work session before reporting the error', async () => {
  const { session, calls } = fakeWorkSession({
    enable: async () => {
      throw new Error('Performance domain unavailable');
    },
  });
  await assert.rejects(
    openRendererWorkSession({}, { newCDPSession: async () => session }),
    /Performance domain unavailable/,
  );
  assert.deepEqual(calls, ['Performance.enable', 'detach']);
});

test('work sessions that cannot open leave timings running and report a Chromium error', async () => {
  const { page } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession({
    enable: async () => {
      throw new Error('Performance domain unavailable');
    },
  });
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  const sample = await monitor.sampleWork();
  assert.equal(sample.chromium, undefined);
  assert.deepEqual(plain(sample.transcript), { stages: {}, counters: {} });
  assert.match(sample.errors[0].message, /unavailable/);
  assert.equal(sample.errors[0].source, 'chromium');

  const result = await monitor.stop();
  assert.equal(result.summary.chromiumWork, undefined);
  assert.equal(result.summary.workErrors[0].source, 'chromium');
  assert.match(
    result.summary.workErrors[0].message,
    /Performance domain unavailable/,
  );
  assert.equal(result.summary.rendererCollectionError, null);
  assert.deepEqual(calls, ['Performance.enable', 'detach']);
});

test('stopping after a failed final Chromium sample still detaches the work session', async () => {
  const { page } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession({
    samples: [{ LayoutCount: 1 }, new Error('Target closed')],
    detach: async () => {
      throw new Error('Session already detached');
    },
  });
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  const result = await monitor.stop();
  assert.equal(calls.at(-1), 'detach');
  assert.equal(result.summary.chromiumWork, undefined);
  // A detach failure is reported but does not invalidate collected counts.
  assert.deepEqual(
    result.summary.workErrors.map(({ source, message }) => [source, message]),
    [
      ['chromium', 'Performance.getMetrics: Error: Target closed'],
      ['cleanup', 'detach: Error: Session already detached'],
    ],
  );
});

test('a work session that opens after its deadline is detached, not leaked', async () => {
  const { page } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession();
  let resolveSession;
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    probeTimeoutMs: 20,
    workCounters: true,
    newCDPSession: () =>
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
  });
  resolveSession(session);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeStop = [...calls];
  const result = await monitor.stop();

  // A session that arrives after the deadline is detached without enabling.
  assert.deepEqual(callsBeforeStop, ['detach']);
  assert.deepEqual(result.summary.workErrors, [
    { source: 'chromium', message: 'open: timed out after 20ms' },
  ]);
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('a work session whose Performance.enable never settles is detached at the deadline', async () => {
  const { page } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession({
    enable: () => new Promise(() => undefined),
  });
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    probeTimeoutMs: 20,
    workCounters: true,
    newCDPSession: async () => session,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeStop = [...calls];
  const result = await monitor.stop();

  // Detached before the measured window starts, not left attached through it.
  assert.deepEqual(callsBeforeStop, ['Performance.enable', 'detach']);
  assert.equal(result.summary.chromiumWork, undefined);
  assert.deepEqual(result.summary.workErrors, [
    { source: 'chromium', message: 'open: timed out after 20ms' },
  ]);
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('stopping closes the Chromium window and the renderer collector before detaching', async () => {
  const { page } = await fakeRendererPage();
  const { session, calls } = fakeWorkSession({
    samples: [{ LayoutCount: 1 }, { LayoutCount: 3 }],
  });
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    workCounters: true,
    newCDPSession: async () => session,
  });
  const evaluate = page.evaluate;
  page.evaluate = async (fn, arg) => {
    const value = await evaluate(fn, arg);
    calls.push('renderer.evaluate');
    return value;
  };

  const result = await monitor.stop();

  // Cleanup never lands inside a work window: the final Chromium and React
  // samples and the renderer collector's stop all come before the detach.
  assert.deepEqual(calls, [
    'Performance.enable',
    'Performance.getMetrics',
    'Performance.getMetrics',
    'renderer.evaluate',
    'renderer.evaluate',
    'detach',
  ]);
  assert.deepEqual(result.summary.chromiumWork, { LayoutCount: 2 });
});

test('monitors without work counters never open a CDP session', async () => {
  const { page } = await fakeRendererPage();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: IDLE_ELECTRON_APP,
    sampleIntervalMs: 60_000,
    newCDPSession: async () => {
      throw new Error('work counters were not requested');
    },
  });
  assert.equal(monitor.sampleWork, undefined);
  const result = await monitor.stop();
  assert.equal('chromiumWork' in result.summary, false);
  assert.equal('workErrors' in result.summary, false);
  assert.equal(result.raw.work, undefined);
});

test('study admission sizes and focuses only the native BrowserWindow owning the measured page', async () => {
  const { runInNewContext } = await import('node:vm');
  const { admitStudyWindow } = await import('./browser-profiles-evidence.mjs');
  const calls = [];
  let visible = false,
    focused = false,
    focusRequested = false,
    focusReads = 0;
  let content = { x: 0, y: 25, width: 1400, height: 900 };
  let bounds = { x: 0, y: 0, width: 1400, height: 925 };
  let viewport = { width: 1400, height: 900 };
  const native = {
    id: 7,
    webContents: {
      id: 8,
      getOSProcessId: () => 9,
      getURL: () => 'file:///app/index.html',
    },
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    isFocused: () => {
      focused = focusRequested && ++focusReads >= 2;
      return focused;
    },
    getContentBounds: () => content,
    getBounds: () => bounds,
    setContentSize: (w, h) => {
      calls.push(['size', w, h]);
      content = { ...content, width: w, height: h };
      bounds = { ...bounds, width: w, height: h + 25 };
    },
    setPosition: (x, y) => {
      calls.push(['position', x, y]);
      bounds = { ...bounds, x, y };
    },
    show: () => {
      visible = true;
      calls.push(['show']);
    },
    focus: () => {
      focusRequested = true;
      calls.push(['focus']);
    },
  };
  const page = {
    setViewportSize: async (value) => {
      viewport = value;
      calls.push(['viewport', value]);
    },
    bringToFront: async () => calls.push(['front']),
    evaluate: (fn) =>
      runInNewContext(`(${fn.toString()})()`, {
        location: { href: 'file:///app/index.html' },
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        devicePixelRatio: 1,
        document: { visibilityState: 'visible', hasFocus: () => focused },
        performance: { now: () => 10, timeOrigin: 100 },
      }),
  };
  const electronApp = {
    browserWindow: async (target) => {
      assert.equal(target, page);
      return {
        evaluate: (fn, arg) => fn(native, arg),
        dispose: async () => {},
      };
    },
    evaluate: (fn, arg) =>
      fn(
        {
          screen: {
            getDisplayMatching: () => ({
              id: 1,
              scaleFactor: 1,
              bounds: { x: 0, y: 0, width: 1024, height: 768 },
              workArea: { x: 0, y: 0, width: 1024, height: 700 },
            }),
          },
        },
        arg,
      ),
  };
  const evidence = {};
  const result = await admitStudyWindow(electronApp, page, evidence);
  assert.equal(result.id, 7);
  assert.equal(result.webContentsId, 8);
  assert.equal(evidence.status, 'admitted');
  assert.equal(evidence.observations.length, 2);
  assert.equal(evidence.observations[0].focused, false);
  assert.equal(evidence.observations[1].focused, true);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['size', 'position', 'show', 'focus', 'viewport', 'front'],
  );
  assert.deepEqual(calls[0], ['size', 1000, 640]);
});

function hiddenWindowState() {
  return {
    ownerMatches: true,
    id: 7,
    webContentsId: 8,
    rendererPid: 9,
    url: 'file:///app/index.html',
    nativeUrl: 'file:///app/index.html',
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    documentVisible: true,
    documentFocused: false,
    viewport: { width: 1400, height: 900 },
    contentBounds: { width: 1400, height: 900 },
  };
}

test('hidden native predicate rejects missing identity, hidden document, activation and wrong geometry', async () => {
  const { headlessStudyWindowReady, assertHeadlessWindowEvidence } =
    await import('./browser-profiles-evidence.mjs');
  const state = hiddenWindowState();
  assert(headlessStudyWindowReady(state));
  for (const key of Object.keys(state))
    assert(!headlessStudyWindowReady({ ...state, [key]: undefined }), key);
  for (const delta of [
    { ownerMatches: false },
    { id: 0 },
    { id: 1.5 },
    { rendererPid: 0 },
    { visible: true },
    { focused: true },
    { destroyed: true },
    { minimized: true },
    { documentVisible: false },
    { nativeUrl: 'other' },
    { contentBounds: { width: 1400, height: 875 } },
    { viewport: { width: 1000, height: 640 } },
  ])
    assert(!headlessStudyWindowReady({ ...state, ...delta }));
  assert(headlessStudyWindowReady({ ...state, documentFocused: true }));
  const evidence = {
    mode: 'hidden-native-1400x900-v1',
    windowVisible: false,
    viewport: state.viewport,
    setup: { status: 'ready', before: state, after: state },
    atStart: state,
    atEnd: { ...state },
  };
  assertHeadlessWindowEvidence(evidence);
  for (const key of ['id', 'webContentsId', 'rendererPid', 'url', 'nativeUrl'])
    assert.throws(() =>
      assertHeadlessWindowEvidence({
        ...evidence,
        atEnd: {
          ...state,
          [key]: key.endsWith('Url') || key === 'url' ? 'changed' : 99,
        },
      }),
    );
});

async function hiddenSetupFixture() {
  const { runInNewContext } = await import('node:vm');
  const calls = [];
  const state = hiddenWindowState();
  state.contentBounds = { width: 1400, height: 875 };
  const native = {
    id: state.id,
    webContents: {
      id: state.webContentsId,
      getOSProcessId: () => state.rendererPid,
      getURL: () => state.nativeUrl,
    },
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    getContentBounds: () => state.contentBounds,
    getBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    setContentSize: (width, height) => {
      calls.push('size');
      state.contentBounds = { width, height };
    },
    ...Object.fromEntries(
      ['show', 'focus', 'hide', 'restore', 'setPosition'].map((name) => [
        name,
        () => {
          calls.push(name);
          throw new Error('Forbidden activation');
        },
      ]),
    ),
  };
  const page = {
    setViewportSize: async (value) => {
      calls.push('viewport');
      state.viewport = value;
    },
    bringToFront: async () => {
      calls.push('front');
      throw new Error('Forbidden activation');
    },
    evaluate: (fn) =>
      runInNewContext(`(${fn.toString()})()`, {
        location: { href: state.url },
        innerWidth: state.viewport.width,
        innerHeight: state.viewport.height,
        devicePixelRatio: 1,
        document: {
          visibilityState: state.documentVisible ? 'visible' : 'hidden',
          hasFocus: () => state.documentFocused,
        },
        performance: { now: () => 1, timeOrigin: 1 },
      }),
  };
  const electronApp = {
    browserWindow: async (target) => {
      assert.equal(target, page);
      return {
        evaluate: (fn, arg) => fn(native, arg),
        dispose: async () => {
          calls.push('dispose');
        },
      };
    },
    evaluate: (fn, arg) =>
      fn(
        {
          screen: {
            getDisplayMatching: () => ({
              id: 1,
              scaleFactor: 1,
              bounds: {},
              workArea: { width: 1, height: 1 },
            }),
          },
        },
        arg,
      ),
  };
  return { electronApp, page, state, calls };
}

test('headless setup sizes only the hidden owner and preserves honest native evidence without activation', async () => {
  const { setupHeadlessStudyWindow, headlessStudyWindowReady } =
    await import('./browser-profiles-evidence.mjs');
  const { electronApp, page, state, calls } = await hiddenSetupFixture();
  const evidence = {};
  const result = await setupHeadlessStudyWindow(electronApp, page, evidence);
  assert(headlessStudyWindowReady(result));
  assert.equal(evidence.before.contentBounds.height, 875);
  assert.equal(evidence.after.contentBounds.height, 900);
  assert.equal(evidence.after.documentFocused, false);
  assert.equal(evidence.status, 'ready');
  assert.deepEqual(
    calls.filter((name) => name !== 'dispose'),
    ['size', 'viewport'],
  );
  for (const key of ['visible', 'focused', 'minimized', 'destroyed']) {
    calls.length = 0;
    state[key] = true;
    await assert.rejects(setupHeadlessStudyWindow(electronApp, page, {}));
    assert(!calls.includes('size'));
    state[key] = false;
  }
});

test('headless setup deadline and abort prohibit later work and dispose late acquired handles', async () => {
  const { setupHeadlessStudyWindow } =
    await import('./browser-profiles-evidence.mjs');
  const { electronApp, page, calls } = await hiddenSetupFixture();
  const original = electronApp.browserWindow;
  let release;
  let acquisitions = 0;
  electronApp.browserWindow = async (target) => {
    const handle = await original(target);
    if (++acquisitions === 2)
      await new Promise((resolve) => {
        release = resolve;
      });
    return handle;
  };
  const evidence = {};
  await assert.rejects(
    setupHeadlessStudyWindow(electronApp, page, evidence, { timeoutMs: 200 }),
    /deadline/,
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(evidence.status, 'failed');
  assert.deepEqual(calls, ['dispose', 'dispose']);
  const controller = new AbortController();
  controller.abort(new Error('test abort'));
  await assert.rejects(
    setupHeadlessStudyWindow(
      electronApp,
      page,
      {},
      { signal: controller.signal },
    ),
    /test abort/,
  );
  assert.equal(acquisitions, 2);
});

test('hidden setup rejects identity changes before mutation and aborts before scheduling more work', async () => {
  const { setupHeadlessStudyWindow } =
    await import('./browser-profiles-evidence.mjs');
  for (const interrupt of [false, true]) {
    const { electronApp, page, state, calls } = await hiddenSetupFixture();
    const original = electronApp.browserWindow;
    const controller = new AbortController();
    let acquisitions = 0;
    electronApp.browserWindow = async (target) => {
      const handle = await original(target);
      if (++acquisitions === 2) {
        if (interrupt) controller.abort(new Error('mid-setup abort'));
        else state.rendererPid++;
      }
      return handle;
    };
    const evidence = {};
    await assert.rejects(
      setupHeadlessStudyWindow(electronApp, page, evidence, {
        signal: controller.signal,
      }),
      interrupt ? /mid-setup abort/ : /owner changed/,
    );
    assert.equal(evidence.status, 'failed');
    assert(!calls.includes('size'));
    assert(!calls.includes('viewport'));
  }
});

function productionAdapterFixture() {
  const state = hiddenWindowState();
  const identity = {
    appPath: '/stage/out/main',
    cwd: '/stage',
    argv: ['electron', '/stage/out/main/index.js'],
    resourcesPath: '/electron/Resources',
  };
  return {
    schemaVersion: 1,
    expectedArgv: [...identity.argv],
    launcherIdentity: {
      policy: 'playwright-explicit-executable-macos-v1',
      version: '1.58.2',
      sha256:
        'd230157151a460582734ae2ecac319b86f1b2b466864a083adfca71d4f80203c',
      sourcePath: '/reviewed/playwright/electron.js',
      executablePath: identity.argv[0],
    },
    launchId: '00000000-0000-4000-8000-000000000001',
    launchContractSha256: 'e'.repeat(64),
    adapterVersion: 'production-hidden-native-v1',
    adapterSha256: 'a'.repeat(64),
    productMainSha256: 'b'.repeat(64),
    productMainEntryPath: '/stage/out/main/index.js',
    launchEntryPath:
      '/stage/out/main/browser-profiles-production-headless-bootstrap.cjs',
    pid: 100,
    installed: true,
    lifetimeObservationIntact: true,
    valid: true,
    overflow: false,
    allWindowsObserved: true,
    productImported: true,
    calls: [],
    events: [],
    violations: [],
    liveWindowIds: [state.id],
    windows: [{ initial: state, current: state, readyToShow: 1 }],
    beforeImport: identity,
    currentIdentity: structuredClone(identity),
  };
}
test('release adapter rejects missing process/path identity and inconsistent all-window inventory', async () => {
  const { assertProductionHeadlessAdapter } =
    await import('./browser-profiles-evidence.mjs');
  assertProductionHeadlessAdapter(productionAdapterFixture());
  for (const mutate of [
    (x) => {
      delete x.beforeImport;
      delete x.currentIdentity;
    },
    (x) => {
      delete x.pid;
    },
    (x) => {
      x.liveWindowIds = [999];
    },
    (x) => {
      x.liveWindowIds = [];
    },
    (x) => {
      x.calls = [{ suppressed: true, method: 'arbitrary' }];
    },
  ]) {
    const value = productionAdapterFixture();
    mutate(value);
    assert.throws(() => assertProductionHeadlessAdapter(value));
  }
});
test('release adapter rejects activation, overflow, descriptor loss and mismatched source hashes', async () => {
  const { assertProductionHeadlessAdapter } =
    await import('./browser-profiles-evidence.mjs');
  for (const mutate of [
    (x) => {
      x.windows[0].initial.visible = true;
    },
    (x) => {
      x.windows[0].current.focused = true;
    },
    (x) => {
      x.overflow = true;
    },
    (x) => {
      x.installed = false;
    },
    (x) => {
      x.events.push({ id: 7, event: 'show' });
    },
    (x) => {
      x.productImported = false;
    },
    (x) => {
      x.currentIdentity.argv.push('extra');
    },
  ]) {
    const value = productionAdapterFixture();
    mutate(value);
    assert.throws(() => assertProductionHeadlessAdapter(value));
  }
  assert.throws(() =>
    assertProductionHeadlessAdapter(productionAdapterFixture(), {
      ...productionAdapterFixture(),
      adapterSha256: 'c'.repeat(64),
    }),
  );
});

test('native argv must equal the independently declared complete launch expectation', async () => {
  const { assertProductionHeadlessAdapter } =
    await import('./browser-profiles-evidence.mjs');
  const fixture = productionAdapterFixture();
  fixture.expectedArgv = [
    '/electron',
    '--inspect=0',
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--user-data-dir=/isolated',
    '/stage/out/main/index.js',
  ];
  fixture.beforeImport.argv = [...fixture.expectedArgv];
  fixture.currentIdentity.argv = [...fixture.expectedArgv];
  assertProductionHeadlessAdapter(fixture);
  for (const mutate of [
    (argv) => argv.filter((arg) => arg !== '--use-mock-keychain'),
    (argv) => [...argv.slice(0, -1), '--unexpected-chromium-flag', argv.at(-1)],
    (argv) => [argv[0], argv[2], argv[1], ...argv.slice(3)],
  ]) {
    const value = structuredClone(fixture);
    value.beforeImport.argv = mutate([...value.expectedArgv]);
    value.currentIdentity.argv = [...value.beforeImport.argv];
    assert.throws(() => assertProductionHeadlessAdapter(value));
  }
});

test('release evidence rejects missing or false native lifetime observation integrity', async () => {
  const { assertProductionHeadlessAdapter } =
    await import('./browser-profiles-evidence.mjs');
  for (const integrity of [undefined, false]) {
    const snapshot = productionAdapterFixture();
    snapshot.lifetimeObservationIntact = integrity;
    assert.throws(
      () => assertProductionHeadlessAdapter(snapshot),
      /lifetime observation/,
    );
  }
});

const frames = (timestamps) =>
  timestamps.map((timestampMs) => ({ timestampMs }));

test('frame budgets count 60 Hz and 120 Hz overruns inside a streamed-reply window', () => {
  // 16.7 ms cadence with one 50 ms and one 12 ms interval inside the window.
  const budget = frameBudgetForWindow(
    frames([0, 16.7, 33.4, 50.1, 100.1, 112.1, 128.8, 200]),
    { startAtMs: 20, endAtMs: 130 },
    [
      { startTime: 60, duration: 70, blockingDuration: 20 },
      { startTime: 150, duration: 90, blockingDuration: 40 },
    ],
  );
  // The frame before the window supplies the first interval.
  assert.equal(budget.frames, 5);
  assert.equal(budget.intervals, 5);
  // 50 ms is over both budgets; 16.7 ms is within the 60 Hz budget only.
  assert.equal(budget.over16_7Ms, 1);
  assert.equal(budget.over8_33Ms, 5);
  assert.equal(Math.round(budget.longestIntervalMs), 50);
  assert.ok(Math.abs(budget.trailingOpenIntervalMs - 1.2) < 1e-9);
  assert.deepEqual(budget.longAnimationFrames, {
    count: 1,
    totalBlockingMs: 20,
    maxDurationMs: 70,
  });
  // Timestamp rounding alone never counts as a missed budget: 120 Hz
  // intervals round to 8.3 or 8.4 ms, 60 Hz ones to 16.6 or 16.8 ms.
  const rounded = frameBudgetForWindow(frames([0, 8.4, 16.7, 25.1, 41.8]), {
    startAtMs: 0,
    endAtMs: 50,
  });
  assert.equal(rounded.over8_33Ms, 1);
  assert.equal(rounded.over16_7Ms, 0);
});

test('a streamed-reply window without frames reports an open interval, not a count', () => {
  const budget = frameBudgetForWindow([], { startAtMs: 10, endAtMs: 60 });
  assert.equal(budget.frames, 0);
  assert.equal(budget.intervals, 0);
  assert.equal(budget.longestIntervalMs, null);
  assert.equal(budget.trailingOpenIntervalMs, 50);
});

test('Long Animation Frame summaries attribute blocking time to scripts', () => {
  const summary = summarizeLongAnimationFrames(
    [
      {
        duration: 120,
        blockingDuration: 70,
        scripts: [
          {
            invoker: 'Response.json.then',
            invokerType: 'resolve-promise',
            sourceURL: 'file:///app/out/renderer/assets/entry-abc.js?x=1',
            sourceFunctionName: 'applyChanges',
            sourceCharPosition: 42,
            duration: 90,
            forcedStyleAndLayoutDuration: 5,
          },
        ],
      },
      {
        duration: 60,
        blockingDuration: 10,
        scripts: [
          {
            invoker: 'Response.json.then',
            invokerType: 'resolve-promise',
            sourceURL: 'file:///app/out/renderer/assets/entry-abc.js',
            sourceFunctionName: 'applyChanges',
            sourceCharPosition: 42,
            duration: 30,
            forcedStyleAndLayoutDuration: 0,
          },
        ],
      },
    ],
    { available: true, dropped: 3 },
  );
  assert.equal(summary.count, 2);
  assert.equal(summary.dropped, 3);
  assert.equal(summary.totalBlockingMs, 80);
  assert.equal(summary.blockingDurationMs.max, 70);
  assert.deepEqual(summary.topScripts, [
    {
      invokerType: 'resolve-promise',
      invoker: 'Response.json.then',
      sourceFunctionName: 'applyChanges',
      sourceURL: 'entry-abc.js',
      sourceCharPosition: 42,
      count: 2,
      totalDurationMs: 120,
      maxDurationMs: 90,
      forcedStyleAndLayoutMs: 5,
    },
  ]);
});

test('the frame-budget report is advisory and records the display refresh rate', () => {
  const report = buildFrameBudgetReport(
    {
      display: { source: 'electron-screen', refreshRateHz: 120 },
      renderer: {
        frames: frames([0, 8.3, 16.6, 41.6]),
        frameGapsMs: [8.3, 8.3, 25],
        longAnimationFrames: [],
      },
    },
    [
      { label: 'reply', start: { atMs: 0 }, end: { atMs: 45 } },
      { label: 'failed mark', start: { error: 'closed' }, end: { atMs: 9 } },
    ],
  );
  assert.equal(report.advisory, true);
  assert.equal(report.method, FRAME_BUDGET_METHOD);
  assert.match(report.method, /not compositor frames/);
  assert.deepEqual(report.budgetsMs, { hz60: 16.7, hz120: 8.33 });
  assert.equal(report.display.refreshRateHz, 120);
  assert.equal(report.observedFrameIntervalP50Ms, 8.3);
  assert.equal(report.replies.length, 1);
  assert.equal(report.replies[0].label, 'reply');
  assert.equal(report.replies[0].over16_7Ms, 1);
  assert.equal(report.unmeasuredReplies, 1);
});

/**
 * A renderer page whose `PerformanceObserver` supports Long Animation Frames
 * and lets the test deliver entries to each observer type.
 */
async function loafRendererPage() {
  const { runInNewContext } = await import('node:vm');
  const noop = () => undefined;
  const observers = new Map();
  const PerformanceObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe({ type }) {
      observers.set(type, this);
    }
    disconnect() {
      for (const [type, observer] of observers) {
        if (observer === this) observers.delete(type);
      }
    }
  };
  PerformanceObserver.supportedEntryTypes = [
    'longtask',
    'long-animation-frame',
  ];
  const context = {
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      activeElement: null,
      addEventListener: noop,
      removeEventListener: noop,
    },
    performance: { now: () => 100, timeOrigin: 1 },
    PerformanceObserver,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
    setInterval: () => 1,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  context.window = {
    ...context,
    api: { loadPreferences: async () => ({}) },
    addEventListener: noop,
    removeEventListener: noop,
  };
  const page = {
    evaluate: (fn, arg) =>
      runInNewContext(
        `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`,
        context,
      ),
  };
  return { page, observers };
}

function displayMainProcess() {
  const context = createContext({
    performance: { now: () => 1 },
    electron: {
      app: { getAppMetrics: () => [] },
      BrowserWindow: {
        getAllWindows: () => [{ getBounds: () => ({ x: 0, y: 0 }) }],
      },
      screen: {
        getDisplayMatching: () => ({ displayFrequency: 120, scaleFactor: 2 }),
        getPrimaryDisplay: () => ({ displayFrequency: 60, scaleFactor: 1 }),
      },
    },
  });
  return {
    evaluate: async (fn, arg) =>
      runInContext(
        `(${fn.toString()})(electron, ${JSON.stringify(arg) ?? 'undefined'})`,
        context,
      ),
  };
}

test('frame budgets are opt-in: Long Animation Frames and the refresh rate are recorded only when asked', async () => {
  const { page, observers } = await loafRendererPage();
  const monitor = await startPerformanceMonitor({
    page,
    electronApp: displayMainProcess(),
    sampleIntervalMs: 60_000,
    frameBudgets: true,
  });
  observers.get('long-animation-frame').callback({
    getEntries: () => [
      {
        startTime: 5,
        duration: 80,
        blockingDuration: 30,
        renderStart: 70,
        styleAndLayoutStart: 75,
        scripts: [
          {
            invoker: 'IdleCallback',
            invokerType: 'user-callback',
            sourceURL: 'file:///renderer/assets/index.js',
            sourceFunctionName: 'flush',
            sourceCharPosition: 9,
            duration: 60,
            executionStart: 6,
            forcedStyleAndLayoutDuration: 0,
            pauseDuration: 0,
          },
        ],
      },
    ],
  });
  const { raw, summary } = await monitor.stop();
  assert.deepEqual(plain(raw.display), {
    source: 'electron-screen',
    refreshRateHz: 120,
    scaleFactor: 2,
  });
  assert.equal(raw.renderer.longAnimationFrameObserverAvailable, true);
  assert.equal(raw.renderer.longAnimationFrames.length, 1);
  assert.equal(
    raw.renderer.longAnimationFrames[0].scripts[0].invoker,
    'IdleCallback',
  );
  assert.equal(summary.longAnimationFrames.count, 1);
  assert.equal(summary.longAnimationFrames.totalBlockingMs, 30);
  assert.equal(summary.display.refreshRateHz, 120);
  assert.equal(observers.size, 0);

  // Without the opt-in the collector and main keep their exact footprint.
  const plainPage = await loafRendererPage();
  const plainMonitor = await startPerformanceMonitor({
    page: plainPage.page,
    electronApp: displayMainProcess(),
    sampleIntervalMs: 60_000,
  });
  assert.equal(plainPage.observers.has('long-animation-frame'), false);
  const stopped = await plainMonitor.stop();
  assert.equal('longAnimationFrames' in stopped.raw.renderer, false);
  assert.equal('display' in stopped.raw, false);
  assert.equal('longAnimationFrames' in stopped.summary, false);
  assert.equal('display' in stopped.summary, false);
});

test('frame series of any length summarize like short ones', () => {
  const short = [3, 1, Number.NaN, 2];
  assert.deepEqual(summarizeSeries(short), summarize(short));
  // A 20-minute window of 120 Hz frames, more values than a spread call
  // accepts.
  const long = Array.from({ length: 150_000 }, (_, index) => (index % 7) + 1);
  const summary = summarizeSeries(long);
  assert.equal(summary.count, 150_000);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 7);
  assert.equal(summary.p50, 4);
  assert.ok(Math.abs(summary.mean - 4) < 0.001);
  assert.equal(
    buildSummary({
      ipcSamples: [],
      resourceSamples: [],
      renderer: { frameGapsMs: long.map((value) => value + 16) },
    }).rendererFrameDelayMs.count,
    150_000,
  );
});

test('a main-process read lost to the inspector is read again, other failures are not', async () => {
  // Playwright reports V8's "Promise was collected" under this message.
  const lost = () =>
    new Error(
      'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.',
    );
  const pauses = [];
  const pause = async (delayMs) => {
    pauses.push(delayMs);
  };
  let calls = 0;
  let retries = 0;
  const value = await evaluateMainWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw lost();
      return 'snapshot';
    },
    {
      pause,
      onRetry: () => {
        retries += 1;
      },
    },
  );
  assert.equal(value, 'snapshot');
  assert.equal(calls, 3);
  assert.equal(retries, 2);
  // Each retry waits longer, so a collection cycle can finish.
  assert.ok(pauses[1] > pauses[0]);

  // A closed app fails differently and is never retried.
  calls = 0;
  await assert.rejects(
    evaluateMainWithRetry(async () => {
      calls += 1;
      throw new Error('Target page, context or browser has been closed');
    }),
    /has been closed/,
  );
  assert.equal(calls, 1);

  // A persistent loss still fails once the retries are spent.
  calls = 0;
  await assert.rejects(
    evaluateMainWithRetry(
      async () => {
        calls += 1;
        throw lost();
      },
      { delaysMs: [1, 2], pause },
    ),
    /Execution context was destroyed/,
  );
  assert.equal(calls, 3);
});
