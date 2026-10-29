import {
  createThreadCpuUtilizationSampler,
  createUtilizationSampler,
  startMainEventLoopMonitor,
  type EventLoopDelaySampler,
  type MainEventLoopStall,
  type MainThreadUtilization,
  type UtilizationSampler,
} from '../lib/main-event-loop-monitor';

const NS_PER_MS = 1_000_000;

/** Returns the queued utilization readings in order, then undefined. */
function scriptedUtilization(
  readings: Array<MainThreadUtilization | undefined>,
): UtilizationSampler {
  return {
    sample: (): MainThreadUtilization | undefined => readings.shift(),
  };
}

interface PendingProbe {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** A thread-pool probe whose calls stay pending until the test settles them. */
function controllableProbe(): {
  probe: () => Promise<void>;
  pending: PendingProbe[];
  calls: () => number;
} {
  const pending: PendingProbe[] = [];
  let calls = 0;
  return {
    probe: (): Promise<void> => {
      calls += 1;
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    pending,
    calls: (): number => calls,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

class FakeSampler implements EventLoopDelaySampler {
  public enabled = false;
  public resets = 0;
  public max = 0;
  public percentiles = new Map<number, number>();

  public enable(): boolean {
    this.enabled = true;
    return true;
  }

  public disable(): boolean {
    this.enabled = false;
    return true;
  }

  public reset(): void {
    this.resets += 1;
    this.max = 0;
    this.percentiles.clear();
  }

  public percentile(percentile: number): number {
    return this.percentiles.get(percentile) ?? 0;
  }

  public record(maxMs: number, p99Ms: number, p50Ms: number): void {
    this.max = maxMs * NS_PER_MS;
    this.percentiles.set(99, p99Ms * NS_PER_MS);
    this.percentiles.set(50, p50Ms * NS_PER_MS);
  }
}

describe('main event loop monitor', () => {
  let sampler: FakeSampler;
  let stalls: MainEventLoopStall[];

  beforeEach(() => {
    jest.useFakeTimers();
    sampler = new FakeSampler();
    stalls = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The delay tests exercise thresholds only; the load samplers are covered
  // below with injected readings.
  const quietSamplers = {
    createUtilizationSampler: (): UtilizationSampler => scriptedUtilization([]),
    threadPoolProbeIntervalMs: 0,
  };

  function start(): () => void {
    return startMainEventLoopMonitor({
      windowMs: 60_000,
      resolutionMs: 20,
      maxDelayThresholdMs: 1_000,
      p99DelayThresholdMs: 200,
      createSampler: () => sampler,
      ...quietSamplers,
      onStall: (stall) => stalls.push(stall),
    });
  }

  it('reports nothing while delays stay below both thresholds', () => {
    const stop = start();
    expect(sampler.enabled).toBe(true);
    sampler.record(420, 120, 22);

    jest.advanceTimersByTime(60_000);

    expect(stalls).toEqual([]);
    expect(sampler.resets).toBe(1);
    stop();
  });

  it('reports a long stall net of the sampling interval', () => {
    const stop = start();
    // Node's histogram includes the timer period: a 52 s block records as
    // the interval between ticks, so the stall is reported without it.
    sampler.record(52_020, 150, 22);

    jest.advanceTimersByTime(60_000);

    expect(stalls).toEqual([
      { windowMs: 60_000, maxDelayMs: 52_000, p99DelayMs: 130, p50DelayMs: 2 },
    ]);
    stop();
  });

  it('reports sustained jank from the 99th percentile alone', () => {
    const stop = start();
    sampler.record(640, 320, 40);

    jest.advanceTimersByTime(60_000);

    expect(stalls).toEqual([
      { windowMs: 60_000, maxDelayMs: 620, p99DelayMs: 300, p50DelayMs: 20 },
    ]);
    stop();
  });

  it('evaluates each window independently and stops sampling on stop', () => {
    const stop = start();
    sampler.record(3_020, 60, 21);
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);
    expect(stalls).toHaveLength(1);

    stop();
    expect(sampler.enabled).toBe(false);
    sampler.record(9_020, 60, 21);
    jest.advanceTimersByTime(120_000);
    expect(stalls).toHaveLength(1);
  });

  it('attaches main-thread utilization, pool-probe latency and the commit count to a stall', async () => {
    let clockMs = 1_000;
    let commits = 40;
    const probe = controllableProbe();
    const stop = startMainEventLoopMonitor({
      windowMs: 60_000,
      resolutionMs: 20,
      maxDelayThresholdMs: 1_000,
      p99DelayThresholdMs: 200,
      createSampler: () => sampler,
      createUtilizationSampler: () =>
        scriptedUtilization([
          { utilization: 0.6123, source: 'main-thread-cpu' },
        ]),
      threadPoolProbe: probe.probe,
      threadPoolProbeIntervalMs: 15_000,
      now: () => clockMs,
      readCommitCount: () => commits,
      onStall: (stall) => stalls.push(stall),
    });

    // Two completed probes (0.5 ms, and 12 ms for a failed call, which still
    // crossed the pool), then one still unfinished after 7 ms when the window
    // closes, reported apart from the completed latencies.
    jest.advanceTimersByTime(15_000);
    expect(probe.calls()).toBe(1);
    clockMs += 0.5;
    probe.pending[0]?.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(15_000);
    expect(probe.calls()).toBe(2);
    clockMs += 12;
    probe.pending[1]?.reject(new Error('ENOENT'));
    await flushMicrotasks();
    jest.advanceTimersByTime(15_000);
    expect(probe.calls()).toBe(3);
    commits = 97;
    sampler.record(1_520, 90, 21);
    clockMs += 7;
    jest.advanceTimersByTime(15_000);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toEqual({
      windowMs: 60_000,
      maxDelayMs: 1_500,
      p99DelayMs: 70,
      p50DelayMs: 1,
      utilization: { utilization: 0.612, source: 'main-thread-cpu' },
      threadPoolProbe: {
        count: 2,
        p50Ms: 0.5,
        p99Ms: 12,
        maxMs: 12,
        pendingMs: 7,
      },
      chatStorageCommitCount: 57,
    });
    stop();
  });

  it('never runs more than one probe at once and stops probing on stop', async () => {
    let clockMs = 0;
    const probe = controllableProbe();
    const stop = startMainEventLoopMonitor({
      windowMs: 60_000,
      createSampler: () => sampler,
      threadPoolProbe: probe.probe,
      threadPoolProbeIntervalMs: 2_000,
      now: () => clockMs,
      onStall: (stall) => stalls.push(stall),
    });

    jest.advanceTimersByTime(10_000);
    // A starved pool leaves the first probe pending; later ticks skip.
    expect(probe.calls()).toBe(1);
    clockMs += 9_000;
    probe.pending[0]?.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(2_000);
    expect(probe.calls()).toBe(2);

    stop();
    jest.advanceTimersByTime(60_000);
    expect(probe.calls()).toBe(2);
  });

  it('reports the probe and utilization for every window it evaluates, not only the first', async () => {
    let clockMs = 0;
    const probe = controllableProbe();
    const stop = startMainEventLoopMonitor({
      windowMs: 10_000,
      createSampler: () => sampler,
      createUtilizationSampler: () =>
        scriptedUtilization([
          { utilization: 0.25, source: 'main-thread-cpu' },
          { utilization: 0.9, source: 'main-thread-cpu' },
        ]),
      threadPoolProbe: probe.probe,
      threadPoolProbeIntervalMs: 7_000,
      now: () => clockMs,
      onStall: (stall) => stalls.push(stall),
    });

    jest.advanceTimersByTime(7_000);
    clockMs += 2;
    probe.pending[0]?.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(3_000);
    // Below both thresholds: nothing is reported, but the window is consumed.
    expect(stalls).toEqual([]);

    jest.advanceTimersByTime(4_000);
    clockMs += 300;
    probe.pending[1]?.resolve();
    await flushMicrotasks();
    sampler.record(2_020, 60, 21);
    jest.advanceTimersByTime(6_000);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.utilization).toEqual({
      utilization: 0.9,
      source: 'main-thread-cpu',
    });
    expect(stalls[0]?.threadPoolProbe).toEqual({
      count: 1,
      p50Ms: 300,
      p99Ms: 300,
      maxMs: 300,
    });
    // No commit counter was supplied, so no commit count is claimed.
    expect(stalls[0]).not.toHaveProperty('chatStorageCommitCount');
    stop();
  });

  it('omits probe statistics when no probe ran and keeps sampling when the probe throws synchronously', () => {
    const stop = startMainEventLoopMonitor({
      windowMs: 60_000,
      createSampler: () => sampler,
      threadPoolProbe: (): Promise<void> => {
        throw new Error('pool unavailable');
      },
      threadPoolProbeIntervalMs: 20_000,
      onStall: (stall) => stalls.push(stall),
    });
    sampler.record(3_020, 60, 21);

    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).not.toHaveProperty('threadPoolProbe');
    stop();
  });

  it('keeps sampling when the stall callback throws', () => {
    const stop = startMainEventLoopMonitor({
      windowMs: 60_000,
      resolutionMs: 20,
      maxDelayThresholdMs: 1_000,
      p99DelayThresholdMs: 200,
      createSampler: () => sampler,
      ...quietSamplers,
      onStall: () => {
        throw new Error('diagnostics unavailable');
      },
    });
    sampler.record(2_020, 60, 21);

    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
    expect(sampler.enabled).toBe(true);
    expect(sampler.resets).toBe(1);
    stop();
  });
});

describe('main thread utilization samplers', () => {
  it('derives utilization from main-thread CPU time over wall time', () => {
    let cpuMicros = 0;
    let wallMs = 0;
    const utilization = createThreadCpuUtilizationSampler({
      threadCpuMicros: () => cpuMicros,
      now: () => wallMs,
    });

    cpuMicros += 450_000;
    wallMs += 1_000;
    expect(utilization.sample()).toEqual({
      utilization: 0.45,
      source: 'main-thread-cpu',
    });
    // Rounding noise can make CPU time exceed wall time; clamp to one.
    cpuMicros += 2_050_000;
    wallMs += 2_000;
    expect(utilization.sample()).toEqual({
      utilization: 1,
      source: 'main-thread-cpu',
    });
    // No elapsed time yields no reading rather than a division by zero.
    expect(utilization.sample()).toBeUndefined();
  });

  it('uses libuv event-loop utilization only when Node drives the loop', () => {
    let idle = 0;
    let active = 0;
    const libuv = createUtilizationSampler({
      loopStart: () => 12,
      eventLoopUtilization: () => ({
        idle,
        active,
        utilization: active / Math.max(1, idle + active),
      }),
      threadCpuMicros: () => 0,
      now: () => 0,
    });
    idle += 300;
    active += 700;
    expect(libuv.sample()).toEqual({ utilization: 0.7, source: 'libuv' });

    // Electron's main process never starts Node's loop (`loopStart` is -1), so
    // libuv reports zeros there; main-thread CPU time is used instead.
    let cpuMicros = 0;
    let wallMs = 0;
    const electron = createUtilizationSampler({
      loopStart: () => -1,
      eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
      threadCpuMicros: () => cpuMicros,
      now: () => wallMs,
    });
    cpuMicros += 250_000;
    wallMs += 1_000;
    expect(electron.sample()).toEqual({
      utilization: 0.25,
      source: 'main-thread-cpu',
    });
  });
});
