import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePerformanceResults,
  compareRepeatedPerformanceResults,
} from './comparison.mjs';
import {
  QUIT_LATENCY_TIMEOUT_MS,
  measureAppQuit,
  processExists,
  quitSummaryLines,
  scenarioWithQuit,
} from './quit-latency.mjs';
import {
  buildScenarioMetrics,
  finalizeResult,
  performanceRunSucceeded,
} from './results.mjs';
import {
  settlePerformanceScenario,
  smokeWorkloadCompleted,
} from './smoke-acceptance.mjs';

const QUIT_METRIC = 'startup-settle.quit.exit_ms';

/** A fake app and clock: the main process exits `exitAfterMs` after the quit. */
function fakeQuit({
  pid = 4242,
  exitAfterMs = Number.POSITIVE_INFINITY,
  pidError = null,
  quitError = null,
} = {}) {
  let clock = 0;
  let quitRequestedAt = null;
  const calls = [];
  const electronApp = {
    evaluate: async (fn) => {
      if (calls.length === 0) {
        // The first evaluate reads the main pid.
        calls.push('pid');
        if (pidError) throw pidError;
        return pid;
      }
      quitRequestedAt = clock;
      fn({ app: { quit: () => calls.push('quit') } });
      if (quitError) throw quitError;
      return undefined;
    },
  };
  const options = {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    exists: (candidate) => {
      assert.equal(candidate, pid);
      return quitRequestedAt === null || clock - quitRequestedAt < exitAfterMs;
    },
  };
  return { electronApp, options, quitCalls: calls };
}

test('times app.quit() to the Electron main process exit', async () => {
  const { electronApp, options, quitCalls } = fakeQuit({ exitAfterMs: 120 });

  const quit = await measureAppQuit(electronApp, {
    ...options,
    pollIntervalMs: 10,
  });

  assert.deepEqual(quitCalls, ['pid', 'quit']);
  assert.equal(quit.status, 'exited');
  assert.equal(quit.exitMs, 120);
  assert.equal(quit.timeoutMs, QUIT_LATENCY_TIMEOUT_MS);
});

test('a quit request that loses its connection as the app exits still measures', async () => {
  const { electronApp, options } = fakeQuit({
    exitAfterMs: 30,
    quitError: new Error('Target page, context or browser has been closed'),
  });

  const quit = await measureAppQuit(electronApp, {
    ...options,
    pollIntervalMs: 10,
  });

  assert.equal(quit.status, 'exited');
  assert.equal(quit.exitMs, 30);
});

test('a hung quit stops at the deadline and keeps the deadline as a lower bound', async () => {
  const { electronApp, options } = fakeQuit();

  const quit = await measureAppQuit(electronApp, {
    ...options,
    timeoutMs: 500,
    pollIntervalMs: 100,
  });

  assert.equal(quit.status, 'timed-out');
  assert.equal(quit.exitMs, 500);
  assert.equal(quit.timeoutMs, 500);
  assert.ok(
    buildScenarioMetrics({ name: 'startup-settle', quit })[QUIT_METRIC],
  );
});

test('an unreadable main pid is reported without requesting a quit', async () => {
  const { electronApp, options, quitCalls } = fakeQuit({
    pidError: new Error('Execution context was destroyed'),
  });

  const quit = await measureAppQuit(electronApp, options);

  assert.deepEqual(quitCalls, ['pid']);
  assert.equal(quit.status, 'unavailable');
  assert.equal(quit.exitMs, null);
  assert.match(quit.error, /Execution context was destroyed/);
  assert.equal(
    buildScenarioMetrics({ name: 'startup-settle', quit })[QUIT_METRIC],
    undefined,
  );
});

test(
  'a main process that never reports its pid is bounded by the deadline',
  {
    timeout: 5_000,
  },
  async () => {
    const calls = [];
    const electronApp = {
      evaluate: () => {
        calls.push('evaluate');
        return new Promise(() => {});
      },
    };

    const quit = await measureAppQuit(electronApp, { timeoutMs: 10 });

    assert.deepEqual(calls, ['evaluate']);
    assert.equal(quit.status, 'unavailable');
    assert.equal(quit.exitMs, null);
    assert.equal(quit.timeoutMs, 10);
    assert.match(quit.error, /did not report its pid within 10ms/);
  },
);

function completedStartup(quit) {
  return scenarioWithQuit(
    {
      name: 'startup-settle',
      status: 'ok',
      durationMs: 1_000,
      tasks: [],
      responsiveness: { passed: true, violations: [] },
    },
    quit,
  );
}

test('a quit that did not exit fails the workload even when cleanup succeeds', async () => {
  const settle = (record) =>
    settlePerformanceScenario('startup-settle', async (closeScenario) => {
      await closeScenario(async () => {});
      return record;
    });
  const exited = await settle(
    completedStartup({ status: 'exited', exitMs: 9_900, timeoutMs: 10_000 }),
  );
  assert.equal(smokeWorkloadCompleted(exited), true);
  assert.equal(performanceRunSucceeded({ scenarios: [exited] }), true);

  for (const quit of [
    { status: 'timed-out', exitMs: 10_000, timeoutMs: 10_000 },
    {
      status: 'unavailable',
      exitMs: null,
      timeoutMs: 10_000,
      error: 'Execution context was destroyed',
    },
  ]) {
    const scenario = await settle(completedStartup(quit));

    assert.equal(scenario.cleanupError, undefined);
    assert.equal(scenario.status, 'error', quit.status);
    assert.match(scenario.error, /quit/i);
    assert.equal(smokeWorkloadCompleted(scenario), false, quit.status);
    assert.equal(
      performanceRunSucceeded({ scenarios: [scenario] }),
      false,
      quit.status,
    );
    // The deadline stays a lower-bound metric.
    assert.equal(
      buildScenarioMetrics(scenario)[QUIT_METRIC]?.value,
      quit.exitMs ?? undefined,
    );
  }
});

test('processExists sees this process and not an unused pid', () => {
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(2 ** 22 + 12_345), false);
});

test('the runner prints exits and flags every other outcome as an error', () => {
  assert.deepEqual(quitSummaryLines(undefined), []);
  assert.deepEqual(
    quitSummaryLines({ status: 'exited', exitMs: 812.4, timeoutMs: 10_000 }),
    [
      {
        error: false,
        text: '[perf]   quit: Electron exited 812ms after app.quit()',
      },
    ],
  );
  const [timedOut] = quitSummaryLines({
    status: 'timed-out',
    exitMs: 10_003,
    timeoutMs: 10_000,
  });
  assert.equal(timedOut.error, true);
  assert.match(timedOut.text, /TIMED OUT.*10000ms/);
  const [unavailable] = quitSummaryLines({
    status: 'unavailable',
    exitMs: null,
    timeoutMs: 10_000,
    error: 'gone',
  });
  assert.equal(unavailable.error, true);
  assert.match(unavailable.text, /not measured \(unavailable\): gone/);
});

function startupRecord(exitMs, sample) {
  return {
    name: 'startup-settle',
    status: 'ok',
    durationMs: 1_000,
    launch: { firstWindowMs: 900, shellReadyMs: 1_200 },
    tasks: [],
    quit: { status: 'exited', exitMs, timeoutMs: QUIT_LATENCY_TIMEOUT_MS },
    ...(sample === undefined ? {} : { sample }),
  };
}

function artifact(scenarios, repeat) {
  return finalizeResult({
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'smoke',
    config: { startupWorktrees: 8 },
    environment: { windowVisible: false },
    ...(repeat ? { repeat: { count: repeat, samples: [] } } : {}),
    scenarios,
  });
}

test('the quit time is a flat timing metric of the scenario', () => {
  const metrics = buildScenarioMetrics(startupRecord(640.25));

  assert.deepEqual(metrics[QUIT_METRIC], {
    value: 640.25,
    unit: 'ms',
    kind: 'time',
    direction: 'lower',
    description: 'App quit request to Electron main process exit',
  });
  assert.equal(
    buildScenarioMetrics({ ...startupRecord(1), quit: undefined })[QUIT_METRIC],
    undefined,
  );
});

test('a single-sample comparison flags a slower quit', () => {
  const comparison = comparePerformanceResults(
    artifact([startupRecord(600)]),
    artifact([startupRecord(5_600)]),
  );

  assert.equal(comparison.compatible, true);
  assert.deepEqual(
    comparison.regressions.map((entry) => entry.key),
    [QUIT_METRIC],
  );
});

test('the repeated comparison judges quit samples beside the launch timings', () => {
  const samples = (base) =>
    Array.from({ length: 7 }, (_, sample) =>
      startupRecord(base + sample * 3, sample),
    );
  const baseline = artifact(samples(600), 7);
  const candidate = artifact(samples(5_600), 7);
  assert.deepEqual(
    baseline.metrics[QUIT_METRIC].samples,
    [600, 603, 606, 609, 612, 615, 618],
  );

  const comparison = compareRepeatedPerformanceResults(baseline, candidate);

  const [scenario] = comparison.scenarios;
  const quit = scenario.metrics.find((record) => record.key === QUIT_METRIC);
  assert.equal(quit.baseline.count, 7);
  assert.equal(quit.candidate.count, 7);
  assert.equal(quit.verdict, 'regressed');
  assert.deepEqual(comparison.regressedScenarios, ['startup-settle']);
});

test('a repeated comparison fails on a sample whose quit timed out', () => {
  const samples = Array.from({ length: 7 }, (_, sample) =>
    startupRecord(600 + sample * 3, sample),
  );
  const timedOut = samples.map((record) =>
    record.sample === 3
      ? scenarioWithQuit(
          { ...record, quit: undefined },
          {
            status: 'timed-out',
            exitMs: QUIT_LATENCY_TIMEOUT_MS,
            timeoutMs: QUIT_LATENCY_TIMEOUT_MS,
          },
        )
      : record,
  );

  const comparison = compareRepeatedPerformanceResults(
    artifact(samples, 7),
    artifact(timedOut, 7),
  );

  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.nonOkSamples.candidate, [
    { scenario: 'startup-settle', sample: 3, status: 'error' },
  ]);
  const [scenario] = comparison.scenarios;
  assert.deepEqual(scenario.excludedSamples, { baseline: 0, candidate: 1 });
  const quit = scenario.metrics.find((record) => record.key === QUIT_METRIC);
  assert.equal(quit.candidate.count, 6);
});
