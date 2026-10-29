import { stat } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Low-overhead responsiveness signals for the Electron main process.
 *
 * A libuv timer ticks every `resolutionMs`. When anything occupies the main
 * thread — JavaScript, synchronous I/O, or native work on the same UI thread —
 * the next tick runs late and the histogram records the gap. macOS shows the
 * spinning wait cursor after roughly two seconds without event processing, so
 * a beachball appears here as a `maxDelayMs` of at least that long. Process CPU
 * averages cannot show these stalls.
 *
 * Two samplers describe the load a window was under, so a reported stall says
 * what the process was doing:
 *
 * - Utilization, the share of the window the main thread was busy. It catches
 *   "busy but not frozen", which the delay thresholds miss. Node's
 *   `performance.eventLoopUtilization()` needs Node to drive the libuv loop,
 *   and Electron's main process never does: Electron runs libuv without
 *   waiting from its own message pump, `nodeTiming.loopStart` stays -1, and
 *   the function reports zeros. There, the main thread's CPU time over wall
 *   time (`process.threadCpuUsage()`) stands in; `source` says which was used.
 * - A thread-pool probe: a trivial asynchronous `fs.stat` every few seconds.
 *   Main's asynchronous file work shares libuv's four pool threads, so a rising
 *   probe latency shows full syncs (`F_FULLFSYNC` on macOS) starving them.
 */

/** The subset of Node's `IntervalHistogram` this monitor reads. */
export interface EventLoopDelaySampler {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  /** Nanoseconds between timer ticks, including the resolution period. */
  readonly max: number;
  percentile(percentile: number): number;
}

export interface MainThreadUtilization {
  /** Share of the elapsed wall time the thread was busy, from 0 to 1. */
  utilization: number;
  /** `libuv`: Node's loop accounting. `main-thread-cpu`: thread CPU time. */
  source: 'libuv' | 'main-thread-cpu';
}

/** Reports utilization since the previous call (or since creation). */
export interface UtilizationSampler {
  sample(): MainThreadUtilization | undefined;
}

export interface ThreadPoolProbeStats {
  /** Probes that completed in the window. */
  count: number;
  p50Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  /** Age of a probe still unfinished when the window closed. */
  pendingMs?: number;
}

export interface MainEventLoopStall {
  windowMs: number;
  /** Longest delay beyond the sampling interval, in milliseconds. */
  maxDelayMs: number;
  p99DelayMs: number;
  p50DelayMs: number;
  utilization?: MainThreadUtilization;
  threadPoolProbe?: ThreadPoolProbeStats;
  /** Chat-storage commits published during the window. */
  chatStorageCommitCount?: number;
}

export interface MainEventLoopMonitorOptions {
  onStall: (stall: MainEventLoopStall) => void;
  windowMs?: number;
  resolutionMs?: number;
  /** A single delay at least this long is reported. */
  maxDelayThresholdMs?: number;
  /** Sustained jank: a 99th percentile at least this long is reported. */
  p99DelayThresholdMs?: number;
  createSampler?: (resolutionMs: number) => EventLoopDelaySampler;
  createUtilizationSampler?: () => UtilizationSampler;
  /**
   * A trivial asynchronous call that runs on libuv's thread pool. Its latency
   * is recorded whether it resolves or rejects: either way it crossed the pool.
   */
  threadPoolProbe?: () => Promise<unknown>;
  /** Milliseconds between probes; zero disables probing. */
  threadPoolProbeIntervalMs?: number;
  /** Monotonic clock, in milliseconds, for probe latency. */
  now?: () => number;
  /** Monotonic count of chat-storage commits, read at window boundaries. */
  readCommitCount?: () => number;
}

const NS_PER_MS = 1_000_000;
const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_MAX_DELAY_THRESHOLD_MS = 1_000;
const DEFAULT_P99_DELAY_THRESHOLD_MS = 200;
export const DEFAULT_THREAD_POOL_PROBE_INTERVAL_MS = 2_000;
/** Latencies kept per window; the default cadence produces fifteen. */
const MAX_PROBE_SAMPLES_PER_WINDOW = 256;

function createDefaultSampler(resolutionMs: number): EventLoopDelaySampler {
  return monitorEventLoopDelay({ resolution: resolutionMs });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clampUtilization(value: number): number {
  return roundTo(Math.min(1, Math.max(0, value)), 3);
}

export interface ThreadCpuUtilizationSources {
  /** Cumulative CPU time of the calling thread, in microseconds. */
  threadCpuMicros: () => number;
  /** Monotonic wall clock, in milliseconds. */
  now: () => number;
}

/** Utilization as the calling thread's CPU time over elapsed wall time. */
export function createThreadCpuUtilizationSampler(
  sources: ThreadCpuUtilizationSources,
): UtilizationSampler {
  let previousCpuMicros = sources.threadCpuMicros();
  let previousWallMs = sources.now();
  return {
    sample(): MainThreadUtilization | undefined {
      const cpuMicros = sources.threadCpuMicros();
      const wallMs = sources.now();
      const elapsedMs = wallMs - previousWallMs;
      const busyMs = (cpuMicros - previousCpuMicros) / 1_000;
      previousCpuMicros = cpuMicros;
      previousWallMs = wallMs;
      if (!(elapsedMs > 0) || !Number.isFinite(busyMs)) return undefined;
      return {
        utilization: clampUtilization(busyMs / elapsedMs),
        source: 'main-thread-cpu',
      };
    },
  };
}

interface EventLoopUtilizationReading {
  idle: number;
  active: number;
  utilization: number;
}

export interface UtilizationSources extends ThreadCpuUtilizationSources {
  /** `performance.nodeTiming.loopStart`: at most zero when Node never ran its loop. */
  loopStart: () => number;
  eventLoopUtilization: () => EventLoopUtilizationReading;
}

/**
 * Node's own event-loop utilization when Node drives the libuv loop (a plain
 * Node host, such as a future daemon); main-thread CPU time otherwise, which
 * is always the case in Electron's main process.
 */
export function createUtilizationSampler(
  sources: UtilizationSources,
): UtilizationSampler {
  if (!(sources.loopStart() > 0)) {
    return createThreadCpuUtilizationSampler(sources);
  }
  let previous = sources.eventLoopUtilization();
  return {
    sample(): MainThreadUtilization | undefined {
      const current = sources.eventLoopUtilization();
      const idle = current.idle - previous.idle;
      const active = current.active - previous.active;
      previous = current;
      const elapsed = idle + active;
      if (!(elapsed > 0)) return undefined;
      return {
        utilization: clampUtilization(active / elapsed),
        source: 'libuv',
      };
    },
  };
}

function threadCpuMicros(): number {
  const usage = process.threadCpuUsage();
  return usage.user + usage.system;
}

const UNAVAILABLE_UTILIZATION: UtilizationSampler = {
  sample: (): undefined => undefined,
};

function createDefaultUtilizationSampler(): UtilizationSampler {
  try {
    return createUtilizationSampler({
      loopStart: () => performance.nodeTiming.loopStart,
      eventLoopUtilization: () => performance.eventLoopUtilization(),
      threadCpuMicros,
      now: () => performance.now(),
    });
  } catch {
    // A runtime without per-thread CPU accounting reports no utilization.
    return UNAVAILABLE_UTILIZATION;
  }
}

/** Runs a diagnostic read; a failing reader yields no value, never a throw. */
function safely<T>(read: (() => T) | undefined): T | undefined {
  if (read === undefined) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** `fs.stat` of the running executable: always present, never large. */
function defaultThreadPoolProbe(): Promise<void> {
  return new Promise((resolve, reject) => {
    stat(process.execPath, (error) => (error ? reject(error) : resolve()));
  });
}

/** Nearest-rank percentile of an ascending array. */
function percentileOf(sorted: readonly number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
}

function summarizeProbe(
  latencies: readonly number[],
  pendingMs: number | undefined,
): ThreadPoolProbeStats | undefined {
  if (latencies.length === 0 && pendingMs === undefined) return undefined;
  const stats: ThreadPoolProbeStats = { count: latencies.length };
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((left, right) => left - right);
    stats.p50Ms = roundTo(percentileOf(sorted, 50), 2);
    stats.p99Ms = roundTo(percentileOf(sorted, 99), 2);
    stats.maxMs = roundTo(sorted[sorted.length - 1] ?? 0, 2);
  }
  if (pendingMs !== undefined) stats.pendingMs = roundTo(pendingMs, 2);
  return stats;
}

/** Starts sampling and returns an idempotent stop function. */
export function startMainEventLoopMonitor(
  options: MainEventLoopMonitorOptions,
): () => void {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const resolutionMs = options.resolutionMs ?? DEFAULT_RESOLUTION_MS;
  const maxDelayThresholdMs =
    options.maxDelayThresholdMs ?? DEFAULT_MAX_DELAY_THRESHOLD_MS;
  const p99DelayThresholdMs =
    options.p99DelayThresholdMs ?? DEFAULT_P99_DELAY_THRESHOLD_MS;
  const now = options.now ?? ((): number => performance.now());
  const sampler = (options.createSampler ?? createDefaultSampler)(resolutionMs);
  const utilization = (
    options.createUtilizationSampler ?? createDefaultUtilizationSampler
  )();
  const probe = options.threadPoolProbe ?? defaultThreadPoolProbe;
  const probeIntervalMs =
    options.threadPoolProbeIntervalMs ?? DEFAULT_THREAD_POOL_PROBE_INTERVAL_MS;
  const readCommitCount = options.readCommitCount;
  // Node's histogram includes the timer period in every sample; report only
  // the delay beyond it.
  const netDelayMs = (nanoseconds: number): number =>
    Math.max(0, Math.round(nanoseconds / NS_PER_MS - resolutionMs));

  let stopped = false;
  let probeStartedAt: number | undefined;
  let probeLatencies: number[] = [];
  let windowCommitBase = safely(readCommitCount);

  const finishProbe = (startedAt: number): void => {
    // A probe that settles after its window closed still belongs to the pool
    // pressure of the window it completes in; only the current probe counts.
    if (stopped || probeStartedAt !== startedAt) return;
    probeStartedAt = undefined;
    const finishedAt = safely(now);
    if (
      finishedAt !== undefined &&
      probeLatencies.length < MAX_PROBE_SAMPLES_PER_WINDOW
    ) {
      probeLatencies.push(Math.max(0, finishedAt - startedAt));
    }
  };
  const runProbe = (): void => {
    // One probe at a time: a starved pool must not accumulate queued probes.
    if (probeStartedAt !== undefined) return;
    const startedAt = safely(now);
    if (startedAt === undefined) return;
    probeStartedAt = startedAt;
    let pending: Promise<unknown>;
    try {
      pending = probe();
    } catch {
      probeStartedAt = undefined;
      return;
    }
    void pending.then(
      (): void => finishProbe(startedAt),
      (): void => finishProbe(startedAt),
    );
  };

  sampler.enable();
  const timer = setInterval((): void => {
    const stall: MainEventLoopStall = {
      windowMs,
      maxDelayMs: netDelayMs(sampler.max),
      p99DelayMs: netDelayMs(sampler.percentile(99)),
      p50DelayMs: netDelayMs(sampler.percentile(50)),
    };
    sampler.reset();
    // Every window consumes its readings, reported or not, so the next window
    // describes only itself.
    const busy = safely(() => utilization.sample());
    const pendingStartedAt = probeStartedAt;
    const probeStats = summarizeProbe(
      probeLatencies,
      pendingStartedAt === undefined
        ? undefined
        : safely(() => Math.max(0, now() - pendingStartedAt)),
    );
    probeLatencies = [];
    const commitCount = safely(readCommitCount);
    const commitsInWindow =
      commitCount !== undefined && windowCommitBase !== undefined
        ? Math.max(0, commitCount - windowCommitBase)
        : undefined;
    windowCommitBase = commitCount;
    if (
      stall.maxDelayMs < maxDelayThresholdMs &&
      stall.p99DelayMs < p99DelayThresholdMs
    ) {
      return;
    }
    if (busy !== undefined && Number.isFinite(busy.utilization)) {
      stall.utilization = {
        utilization: clampUtilization(busy.utilization),
        source: busy.source,
      };
    }
    if (probeStats !== undefined) stall.threadPoolProbe = probeStats;
    if (commitsInWindow !== undefined) {
      stall.chatStorageCommitCount = commitsInWindow;
    }
    try {
      options.onStall(stall);
    } catch {
      // Diagnostics must never disturb sampling.
    }
  }, windowMs);
  timer.unref?.();
  const probeTimer =
    probeIntervalMs > 0 ? setInterval(runProbe, probeIntervalMs) : undefined;
  probeTimer?.unref?.();

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (probeTimer !== undefined) clearInterval(probeTimer);
    sampler.disable();
  };
}
