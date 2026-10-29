#!/usr/bin/env node
/**
 * Bracketed micro-benchmark of the main-process load samplers
 * (`apps/desktop-app/src/main/lib/main-event-loop-monitor.ts`): the
 * thread-pool probe and the per-window utilization and commit readings.
 *
 * Each measurement runs the real monitor at an accelerated cadence inside a
 * bracket and subtracts an interleaved control bracket that runs the same
 * monitor without the sampler under test, so the delay histogram and timers
 * the monitor always had cancel out. The cost per event is then projected to
 * the production cadence (one probe every two seconds, one window every 30
 * seconds) as a share of one core of main-thread CPU. The acceptance budget
 * is 1%.
 *
 *   pnpm run perf:desktop:sampler-overhead [--repeats N] [--bracket-ms N] [--assert]
 *
 * Plain Node stands in for Electron main: the probe and readings are the same
 * code, and the utilization reading is forced to the main-thread CPU variant
 * Electron uses. Times are thread CPU (`process.threadCpuUsage()`), not wall.
 */
import { stat } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import * as activityModule from '../../../../packages/desktop-shared/src/node/chat-storage-activity.ts';
import * as monitorModule from '../../src/main/lib/main-event-loop-monitor.ts';

// tsx loads these TypeScript sources as CommonJS; take the exports from
// whichever shape the loader produced.
const activity = activityModule.default ?? activityModule;
const monitor = monitorModule.default ?? monitorModule;
const { chatStorageCommitTotal } = activity;
const {
  DEFAULT_THREAD_POOL_PROBE_INTERVAL_MS,
  createThreadCpuUtilizationSampler,
  startMainEventLoopMonitor,
} = monitor;

const PRODUCTION_WINDOW_MS = 30_000;
const BUDGET_PERCENT_OF_CORE = 1;

const { values } = parseArgs({
  options: {
    repeats: { type: 'string', default: '5' },
    'bracket-ms': { type: 'string', default: '3000' },
    assert: { type: 'boolean', default: false },
  },
});
const repeats = Math.max(1, Number(values.repeats));
const bracketMs = Math.max(500, Number(values['bracket-ms']));

function threadCpuMicros() {
  const usage = process.threadCpuUsage();
  return usage.user + usage.system;
}

function median(numbers) {
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** The production probe: `fs.stat` of the running executable. */
function statProbe() {
  return new Promise((resolve, reject) => {
    stat(process.execPath, (error) => (error ? reject(error) : resolve()));
  });
}

const noUtilization = () => ({ sample: () => undefined });
const threadCpuUtilization = () =>
  createThreadCpuUtilizationSampler({
    threadCpuMicros,
    now: () => performance.now(),
  });

/** Main-thread CPU spent while `options` runs the monitor for one bracket. */
async function bracket(options) {
  let events = 0;
  const count =
    (inner) =>
    (...args) => {
      events += 1;
      return inner(...args);
    };
  const stop = startMainEventLoopMonitor({
    onStall: () => undefined,
    maxDelayThresholdMs: Number.POSITIVE_INFINITY,
    p99DelayThresholdMs: Number.POSITIVE_INFINITY,
    ...options,
    ...(options.threadPoolProbe
      ? { threadPoolProbe: count(options.threadPoolProbe) }
      : {}),
    ...(options.countWindows
      ? {
          createUtilizationSampler: () => {
            const inner = options.createUtilizationSampler();
            return { sample: count(() => inner.sample()) };
          },
        }
      : {}),
  });
  // Let the first timers settle before the bracket opens.
  await delay(50);
  events = 0;
  const cpuBefore = threadCpuMicros();
  const wallBefore = performance.now();
  await delay(bracketMs);
  const cpuMicros = threadCpuMicros() - cpuBefore;
  const wallMs = performance.now() - wallBefore;
  const measuredEvents = events;
  stop();
  return { cpuMicros, wallMs, events: measuredEvents };
}

/** Interleaved control and treatment brackets; per-event cost in µs. */
async function measure(label, control, treatment) {
  const costs = [];
  const eventRates = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const base = await bracket(control);
    const test = await bracket(treatment);
    const events = Math.max(1, test.events);
    costs.push((test.cpuMicros - base.cpuMicros) / events);
    eventRates.push(test.events);
  }
  return {
    label,
    perEventMicros: median(costs),
    perEventMicrosRange: [Math.min(...costs), Math.max(...costs)],
    eventsPerBracket: median(eventRates),
  };
}

// The monitor's delay histogram and window timer run in every bracket; only
// the sampler under test differs between control and treatment.
const HOUR_MS = 3_600_000;
const probe = await measure(
  'thread-pool probe (fs.stat), per probe',
  {
    windowMs: HOUR_MS,
    threadPoolProbeIntervalMs: 0,
    createUtilizationSampler: noUtilization,
  },
  {
    windowMs: HOUR_MS,
    threadPoolProbe: statProbe,
    threadPoolProbeIntervalMs: 1,
    createUtilizationSampler: noUtilization,
  },
);
const window = await measure(
  'window readings (utilization, probe summary, commit count), per window',
  {
    windowMs: 2,
    threadPoolProbeIntervalMs: 0,
    createUtilizationSampler: noUtilization,
  },
  {
    windowMs: 2,
    threadPoolProbeIntervalMs: 0,
    createUtilizationSampler: threadCpuUtilization,
    readCommitCount: chatStorageCommitTotal,
    countWindows: true,
  },
);

const microsPerSecond =
  probe.perEventMicros * (1_000 / DEFAULT_THREAD_POOL_PROBE_INTERVAL_MS) +
  window.perEventMicros * (1_000 / PRODUCTION_WINDOW_MS);
const percentOfCore = (Math.max(0, microsPerSecond) / 1_000_000) * 100;
const report = {
  node: process.versions.node,
  platform: `${process.platform}-${process.arch}`,
  repeats,
  bracketMs,
  probe,
  window,
  production: {
    probeIntervalMs: DEFAULT_THREAD_POOL_PROBE_INTERVAL_MS,
    windowMs: PRODUCTION_WINDOW_MS,
    mainThreadMicrosPerSecond: microsPerSecond,
    percentOfOneCore: percentOfCore,
    budgetPercentOfOneCore: BUDGET_PERCENT_OF_CORE,
    withinBudget: percentOfCore < BUDGET_PERCENT_OF_CORE,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (values.assert && !report.production.withinBudget) process.exitCode = 1;
