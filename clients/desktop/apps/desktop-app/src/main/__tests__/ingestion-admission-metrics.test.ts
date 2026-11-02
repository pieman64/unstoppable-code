import {
  IngestionAdmissionMetrics,
  type IngestionAdmissionMetricsSnapshot,
} from '../agents/ingestion-admission-metrics';

interface ScheduledTask {
  callback: () => void;
  dueAt: number;
}

interface TestClock {
  advanceBy(milliseconds: number): void;
  cancel(handle: ReturnType<typeof setTimeout>): void;
  elapse(milliseconds: number): void;
  now(): number;
  pendingCount(): number;
  runDue(): void;
  schedule(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
}

function createClock(startAt = 0): TestClock {
  let currentTime = startAt;
  const scheduled = new Map<ReturnType<typeof setTimeout>, ScheduledTask>();

  function runDueTasks(targetTime: number, preserveCurrentTime: boolean): void {
    while (true) {
      let nextHandle: ReturnType<typeof setTimeout> | undefined;
      let nextTask: ScheduledTask | undefined;

      scheduled.forEach((task, handle) => {
        if (
          task.dueAt <= targetTime &&
          (nextTask === undefined || task.dueAt < nextTask.dueAt)
        ) {
          nextHandle = handle;
          nextTask = task;
        }
      });

      if (nextHandle === undefined || nextTask === undefined) {
        return;
      }

      scheduled.delete(nextHandle);
      clearTimeout(nextHandle);
      if (!preserveCurrentTime) {
        currentTime = nextTask.dueAt;
      }
      nextTask.callback();
    }
  }

  return {
    now: (): number => currentTime,
    schedule: (callback, delayMs): ReturnType<typeof setTimeout> => {
      const handle = setTimeout(() => undefined, 2_147_483_647);
      scheduled.set(handle, {
        callback,
        dueAt: currentTime + Math.max(0, delayMs),
      });
      return handle;
    },
    cancel: (handle): void => {
      scheduled.delete(handle);
      clearTimeout(handle);
    },
    advanceBy: (milliseconds): void => {
      const targetTime = currentTime + milliseconds;
      runDueTasks(targetTime, false);
      currentTime = targetTime;
    },
    elapse: (milliseconds): void => {
      currentTime += milliseconds;
    },
    runDue: (): void => {
      runDueTasks(currentTime, true);
    },
    pendingCount: (): number => scheduled.size,
  };
}

function createMetrics(
  clock: TestClock,
  onFlush: (snapshot: IngestionAdmissionMetricsSnapshot) => void,
  options: {
    dormant?: boolean;
    readBacklog?: () => { depth: number; oldestAgeMs: number };
  } = {},
): IngestionAdmissionMetrics {
  return new IngestionAdmissionMetrics({
    now: (): number => clock.now(),
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    cancel: (handle): void => clock.cancel(handle),
    onFlush,
    ...options,
  });
}

describe('IngestionAdmissionMetrics', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records one receipt-or-admission release latency per settled event', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(clock, (snapshot) =>
      snapshots.push(snapshot),
    );

    metrics.recordSettled(0, 5, 10);
    metrics.recordSettled(0, 12, 22);
    metrics.recordSettled(30, undefined, 50);
    metrics.recordSettled(0, undefined, 40);

    clock.advanceBy(10_000);

    expect(snapshots).toEqual([
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 4,
        admissionReceiptSampleCount: 2,
        admissionLatencyP50Ms: 10,
        admissionLatencyP95Ms: 40,
        backlogDepth: 0,
        backlogPeakDepth: 0,
        backlogOldestAgeMs: 0,
      },
    ]);
    metrics.dispose();
  });

  it('uses bounded histogram storage with exact low buckets and 1% upper buckets', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(clock, (snapshot) =>
      snapshots.push(snapshot),
    );

    for (let index = 0; index < 100_000; index += 1) {
      metrics.recordSettled(0, undefined, 1_001 + index * 97);
    }

    expect(metrics.storedHistogramBucketCount).toBeLessThanOrEqual(5_000);
    expect(metrics.storedHistogramBucketCount).toBeLessThan(100_000);

    metrics.dispose();

    const quantileMetrics = createMetrics(clock, (snapshot) =>
      snapshots.push(snapshot),
    );
    for (const latencyMs of [1_400, 1_500, 1_600, 1_700, 1_800, 1_900]) {
      quantileMetrics.recordSettled(0, undefined, latencyMs);
    }

    clock.advanceBy(10_000);
    const snapshot = snapshots.at(-1);
    expect(snapshot?.admissionLatencyP50Ms).toBeGreaterThanOrEqual(1_600);
    expect(snapshot?.admissionLatencyP50Ms).toBeLessThanOrEqual(1_600 * 1.01);
    expect(snapshot?.admissionLatencyP95Ms).toBeGreaterThanOrEqual(1_900);
    expect(snapshot?.admissionLatencyP95Ms).toBeLessThanOrEqual(1_900 * 1.01);
    quantileMetrics.dispose();
  });

  it('keeps the actual window duration until flush and resets only flushed samples', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(clock, (snapshot) =>
      snapshots.push(snapshot),
    );

    metrics.recordSettled(0, 1, 11);
    clock.elapse(12_000);
    expect(metrics.flushDue()).toBe(true);

    metrics.recordSettled(0, undefined, 5);
    clock.elapse(9_999);
    expect(metrics.flushDue()).toBe(false);
    expect(snapshots).toHaveLength(1);

    clock.elapse(1);
    expect(metrics.flushDue()).toBe(true);
    expect(snapshots).toEqual([
      {
        admissionWindowMs: 12_000,
        admissionSampleCount: 1,
        admissionReceiptSampleCount: 1,
        admissionLatencyP50Ms: 10,
        admissionLatencyP95Ms: 10,
        backlogDepth: 0,
        backlogPeakDepth: 0,
        backlogOldestAgeMs: 0,
      },
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 1,
        admissionReceiptSampleCount: 0,
        admissionLatencyP50Ms: 5,
        admissionLatencyP95Ms: 5,
        backlogDepth: 0,
        backlogPeakDepth: 0,
        backlogOldestAgeMs: 0,
      },
    ]);
    metrics.dispose();
  });

  it('emits held backlog on cadence, with optional quantiles when there are no samples', () => {
    const clock = createClock();
    let backlog = { depth: 3, oldestAgeMs: 25 };
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      { readBacklog: () => backlog },
    );

    metrics.observeBacklog();
    backlog = { depth: 2, oldestAgeMs: 50 };
    clock.advanceBy(10_000);

    expect(snapshots).toEqual([
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 0,
        admissionReceiptSampleCount: 0,
        backlogDepth: 2,
        backlogPeakDepth: 3,
        backlogOldestAgeMs: 50,
      },
    ]);
    expect(clock.pendingCount()).toBe(1);

    clock.advanceBy(10_000);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({
      admissionWindowMs: 10_000,
      admissionSampleCount: 0,
      admissionReceiptSampleCount: 0,
      backlogDepth: 2,
      backlogPeakDepth: 2,
      backlogOldestAgeMs: 50,
    });

    backlog = { depth: 0, oldestAgeMs: 0 };
    clock.advanceBy(10_000);
    expect(snapshots).toHaveLength(2);
    expect(clock.pendingCount()).toBe(0);

    clock.advanceBy(20_000);
    expect(snapshots).toHaveLength(2);
    metrics.dispose();
  });

  it('waits for cadence before flushing a backlog that drained in-window', () => {
    const clock = createClock();
    let backlog = { depth: 1, oldestAgeMs: 10 };
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      { readBacklog: () => backlog },
    );

    metrics.observeBacklog();
    backlog = { depth: 0, oldestAgeMs: 0 };
    clock.elapse(9_999);
    expect(metrics.flushDue()).toBe(false);
    expect(snapshots).toHaveLength(0);

    clock.elapse(1);
    clock.runDue();
    expect(snapshots).toEqual([
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 0,
        admissionReceiptSampleCount: 0,
        backlogDepth: 0,
        backlogPeakDepth: 1,
        backlogOldestAgeMs: 10,
      },
    ]);
    expect(clock.pendingCount()).toBe(0);
    metrics.dispose();
  });

  it('does not create idle windows, and dispose cancels a pending timer', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      {
        readBacklog: () => ({ depth: 0, oldestAgeMs: 0 }),
      },
    );

    clock.elapse(60_000);
    expect(metrics.flushDue()).toBe(false);
    expect(clock.pendingCount()).toBe(0);
    expect(snapshots).toHaveLength(0);

    metrics.observeBacklog();
    expect(clock.pendingCount()).toBe(0);
    const held = createMetrics(clock, (snapshot) => snapshots.push(snapshot), {
      readBacklog: () => ({ depth: 1, oldestAgeMs: 10 }),
    });
    held.observeBacklog();
    expect(clock.pendingCount()).toBe(1);

    held.dispose();
    expect(clock.pendingCount()).toBe(0);
    clock.advanceBy(20_000);
    expect(snapshots).toHaveLength(0);
    metrics.dispose();
  });

  it('flushes the last partial window once when the session ends', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const metrics = createMetrics(clock, (snapshot) =>
      snapshots.push(snapshot),
    );

    metrics.flushFinal();
    expect(snapshots).toHaveLength(0);

    metrics.recordSettled(0, undefined, 20);
    clock.elapse(3_000);
    metrics.flushFinal();
    metrics.flushFinal();
    expect(snapshots).toEqual([
      expect.objectContaining({
        admissionWindowMs: 3_000,
        admissionSampleCount: 1,
        admissionLatencyP50Ms: 20,
      }),
    ]);
    expect(clock.pendingCount()).toBe(0);

    metrics.dispose();
    metrics.flushFinal();
    expect(snapshots).toHaveLength(1);
  });

  it('merges dormant prebind samples without resetting or duplicating the target window', () => {
    const clock = createClock();
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const target = createMetrics(clock, (snapshot) => snapshots.push(snapshot));
    target.recordSettled(0, 1, 11);
    clock.advanceBy(5_000);

    const prebind = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      { dormant: true },
    );
    prebind.recordSettled(0, undefined, 20);
    target.merge(prebind);
    target.merge(prebind);

    expect(clock.pendingCount()).toBe(1);
    clock.advanceBy(5_000);

    expect(snapshots).toEqual([
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 2,
        admissionReceiptSampleCount: 1,
        admissionLatencyP50Ms: 10,
        admissionLatencyP95Ms: 20,
        backlogDepth: 0,
        backlogPeakDepth: 0,
        backlogOldestAgeMs: 0,
      },
    ]);
    target.dispose();
    prebind.dispose();
  });

  it('keeps prebind backlog peaks while the session observation stays current', () => {
    const clock = createClock();
    let sessionBacklog = { depth: 2, oldestAgeMs: 10 };
    const prebindBacklog = { depth: 4, oldestAgeMs: 30 };
    const snapshots: IngestionAdmissionMetricsSnapshot[] = [];
    const target = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      { readBacklog: () => sessionBacklog },
    );
    target.observeBacklog();

    clock.elapse(1);
    const prebind = createMetrics(
      clock,
      (snapshot) => snapshots.push(snapshot),
      { dormant: true, readBacklog: () => prebindBacklog },
    );
    prebind.observeBacklog();
    target.merge(prebind);

    sessionBacklog = { depth: 3, oldestAgeMs: 20 };
    target.observeBacklog();
    clock.advanceBy(9_999);

    expect(snapshots).toEqual([
      {
        admissionWindowMs: 10_000,
        admissionSampleCount: 0,
        admissionReceiptSampleCount: 0,
        backlogDepth: 3,
        backlogPeakDepth: 4,
        backlogOldestAgeMs: 30,
      },
    ]);
    target.dispose();
    prebind.dispose();
  });

  it('swallows onFlush failures so diagnostics cannot break the cadence', () => {
    const clock = createClock();
    const metrics = createMetrics(clock, () => {
      throw new Error('diagnostic sink unavailable');
    });

    metrics.recordSettled(0, undefined, 5);
    expect(() => clock.advanceBy(10_000)).not.toThrow();
    expect(clock.pendingCount()).toBe(0);

    metrics.recordSettled(0, undefined, 6);
    expect(() => clock.advanceBy(10_000)).not.toThrow();
    metrics.dispose();
  });
});
