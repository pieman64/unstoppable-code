jest.mock(
  '@canopy/desktop-instrumentation',
  (): {
    createDesktopInstrumentationOperationKey: (value: string) => string;
  } => ({
    createDesktopInstrumentationOperationKey: (value: string) =>
      `hashed:${value}`,
  }),
);

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  clearSlowActions,
  getSlowActionSnapshot,
  resetSlowActionTrackerForTests,
  subscribeSlowActions,
  trackSlowAction,
} from '../lib/slow-action-tracker';

function matchingContext(context: Record<string, unknown>): unknown {
  return expect.objectContaining(context);
}

describe('slow-action-tracker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
    resetSlowActionTrackerForTests();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetSlowActionTrackerForTests();
    jest.useRealTimers();
  });

  it('emits a visible record only after the slow threshold', async () => {
    const events: string[] = [];
    const unsubscribe = subscribeSlowActions((event) => {
      events.push(event.type);
    });

    let resolvePromise!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });
    const tracked = trackSlowAction(work, {
      id: 'slow-test',
      kind: 'ipc',
      label: 'Running test action',
      thresholdMs: 1_000,
      context: { channel: 'test-channel' },
      telemetryOperationName: 'canopy.ipc_action',
    });

    jest.advanceTimersByTime(999);
    expect(getSlowActionSnapshot().records).toEqual([]);
    expect(events).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(getSlowActionSnapshot().records).toMatchObject([
      {
        id: 'slow-test',
        label: 'Running test action',
        context: { channel: 'test-channel' },
      },
    ]);
    expect(events).toEqual(['added']);

    resolvePromise('done');
    await expect(tracked).resolves.toBe('done');
    expect(getSlowActionSnapshot().records).toEqual([]);
    expect(events).toEqual(['added', 'resolved']);

    unsubscribe();
  });

  it('records tracked action duration and threshold telemetry', async () => {
    let resolvePromise!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });
    const tracked = trackSlowAction(work, {
      id: 'slow-telemetry',
      kind: 'ipc',
      label: 'Running telemetry action',
      thresholdMs: 1_000,
      context: { channel: 'telemetry:test' },
      telemetryOperationName: 'canopy.ipc_action',
    });

    expect(startDesktopOperation).toHaveBeenCalledWith('canopy.ipc_action', {
      operationKey: 'hashed:tracked-action:ipc:slow-telemetry',
      context: matchingContext({
        channel: 'telemetry:test',
        status: 'started',
        threshold_ms: 1_000,
      }),
    });

    jest.advanceTimersByTime(1_000);
    expect(startDesktopOperation).toHaveBeenCalledWith('canopy.slow_action', {
      operationKey: 'hashed:slow-action-threshold:slow-telemetry:1779883200000',
      context: matchingContext({
        channel: 'telemetry:test',
        duration_ms: 1_000,
        exceeded_slow_threshold: true,
        status: 'threshold_exceeded',
      }),
    });
    expect(succeedDesktopOperation).toHaveBeenCalledWith(
      'canopy.slow_action',
      expect.objectContaining({
        operationKey:
          'hashed:slow-action-threshold:slow-telemetry:1779883200000',
      }),
    );

    jest.advanceTimersByTime(250);
    resolvePromise('done');
    await expect(tracked).resolves.toBe('done');

    expect(succeedDesktopOperation).toHaveBeenCalledWith('canopy.ipc_action', {
      operationKey: 'hashed:tracked-action:ipc:slow-telemetry',
      context: matchingContext({
        channel: 'telemetry:test',
        duration_ms: 1_250,
        exceeded_slow_threshold: true,
        status: 'success',
      }),
    });
  });

  it('records actual elapsed time when slow threshold telemetry fires late', () => {
    void trackSlowAction(new Promise(() => {}), {
      id: 'delayed-threshold-telemetry',
      kind: 'ipc',
      label: 'Running delayed telemetry action',
      thresholdMs: 1_000,
      context: { channel: 'telemetry:delayed' },
      telemetryOperationName: 'canopy.ipc_action',
    });

    jest.setSystemTime(new Date('2026-05-27T12:00:00.750Z'));
    jest.advanceTimersByTime(1_000);

    expect(startDesktopOperation).toHaveBeenCalledWith('canopy.slow_action', {
      operationKey:
        'hashed:slow-action-threshold:delayed-threshold-telemetry:1779883200000',
      context: matchingContext({
        channel: 'telemetry:delayed',
        duration_ms: 1_750,
        threshold_ms: 1_000,
        exceeded_slow_threshold: true,
        status: 'threshold_exceeded',
      }),
    });
  });

  it('records tracked action failures', async () => {
    await expect(
      trackSlowAction(Promise.reject(new Error('failed')), {
        id: 'failed-telemetry',
        kind: 'ipc',
        label: 'Running failed action',
        thresholdMs: 1_000,
        context: { channel: 'telemetry:failed' },
        telemetryOperationName: 'canopy.ipc_action',
      }),
    ).rejects.toThrow('failed');

    expect(failDesktopOperation).toHaveBeenCalledWith(
      'canopy.ipc_action',
      'error',
      {
        operationKey: 'hashed:tracked-action:ipc:failed-telemetry',
        context: matchingContext({
          channel: 'telemetry:failed',
          duration_ms: 0,
          status: 'failure',
        }),
      },
    );
  });

  it('does not emit for work that completes before the threshold', async () => {
    const events: string[] = [];
    subscribeSlowActions((event) => {
      events.push(event.type);
    });

    await expect(
      trackSlowAction(Promise.resolve('fast'), {
        kind: 'ipc',
        label: 'Running fast action',
        thresholdMs: 1_000,
        telemetryOperationName: 'canopy.ipc_action',
      }),
    ).resolves.toBe('fast');

    jest.advanceTimersByTime(1_000);
    expect(getSlowActionSnapshot().records).toEqual([]);
    expect(events).toEqual([]);
  });

  it('clears visible slow actions', () => {
    const events: string[] = [];
    subscribeSlowActions((event) => {
      events.push(event.type);
    });

    void trackSlowAction(new Promise(() => {}), {
      id: 'slow-test',
      kind: 'pipeline',
      label: 'Running pipeline',
      thresholdMs: 1,
      telemetryOperationName: 'canopy.ipc_action',
    });
    jest.advanceTimersByTime(1);

    expect(getSlowActionSnapshot().records).toHaveLength(1);
    clearSlowActions();
    expect(getSlowActionSnapshot().records).toEqual([]);
    expect(events).toEqual(['added', 'cleared']);
  });

  it('emits evicted and skips added when the newly visible record is immediately trimmed', () => {
    const events: string[] = [];
    subscribeSlowActions((event) => {
      events.push(event.type);
    });

    const baseTime = new Date('2026-05-27T12:00:00.000Z').getTime();
    for (let i = 0; i < 256; i += 1) {
      jest.setSystemTime(baseTime + i);
      void trackSlowAction(new Promise(() => {}), {
        id: `slow-kept-${i}`,
        kind: 'ipc',
        label: `Kept action ${i}`,
        thresholdMs: 1,
        telemetryOperationName: 'canopy.ipc_action',
      });
      jest.advanceTimersByTime(1);
    }

    expect(getSlowActionSnapshot().records).toHaveLength(256);
    expect(events).toHaveLength(256);
    expect(events.every((event) => event === 'added')).toBe(true);

    jest.setSystemTime(baseTime - 1);
    void trackSlowAction(new Promise(() => {}), {
      id: 'slow-evicted-before-added',
      kind: 'ipc',
      label: 'Evicted before added',
      thresholdMs: 1,
      telemetryOperationName: 'canopy.ipc_action',
    });
    jest.advanceTimersByTime(1);

    const snapshot = getSlowActionSnapshot();
    expect(snapshot.records).toHaveLength(256);
    expect(
      snapshot.records.some(
        (record) => record.id === 'slow-evicted-before-added',
      ),
    ).toBe(false);
    expect(events.slice(-1)).toEqual(['evicted']);
  });

  it('does not emit resolved after an already evicted record settles', async () => {
    const events: string[] = [];
    subscribeSlowActions((event) => {
      events.push(event.type);
    });

    const baseTime = new Date('2026-05-27T12:00:00.000Z').getTime();
    let resolveEvicted!: () => void;
    jest.setSystemTime(baseTime);
    const evictedPromise = new Promise<void>((resolve) => {
      resolveEvicted = resolve;
    });
    const trackedEvicted = trackSlowAction(evictedPromise, {
      id: 'slow-evicted-before-resolved',
      kind: 'ipc',
      label: 'Evicted before resolved',
      thresholdMs: 1,
      telemetryOperationName: 'canopy.ipc_action',
    });
    jest.advanceTimersByTime(1);

    for (let i = 0; i < 256; i += 1) {
      jest.setSystemTime(baseTime + i + 1);
      void trackSlowAction(new Promise(() => {}), {
        id: `slow-kept-after-eviction-${i}`,
        kind: 'ipc',
        label: `Kept action ${i}`,
        thresholdMs: 1,
        telemetryOperationName: 'canopy.ipc_action',
      });
      jest.advanceTimersByTime(1);
    }

    expect(events).toContain('evicted');
    expect(getSlowActionSnapshot().records).toHaveLength(256);
    expect(
      getSlowActionSnapshot().records.some(
        (record) => record.id === 'slow-evicted-before-resolved',
      ),
    ).toBe(false);

    resolveEvicted();
    await expect(trackedEvicted).resolves.toBeUndefined();

    expect(events.filter((event) => event === 'evicted')).toHaveLength(1);
    expect(events.filter((event) => event === 'resolved')).toHaveLength(0);
  });
});
