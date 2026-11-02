import {
  OwnerAdmissionLanes,
  type OwnerAdmissionLanesHost,
  type OwnerLaneFrame,
  type OwnerLaneFrameKind,
  type CodexIngestionLagChange,
  type CodexIngestionLagSample,
  type StdoutHoldReport,
} from '../owner-admission-lanes';
import { RequestDeadline } from '../request-deadline';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface FakeHost extends OwnerAdmissionLanesHost<string> {
  live: Set<string>;
  events: string[];
  reports: StdoutHoldReport[];
  warnings: string[];
  admissionFailures: Error[];
  deliveryFailures: Error[];
  ingestionLagChanges: Array<{
    owner: string;
    change: CodexIngestionLagChange;
  }>;
  ingestionLagSamples: Array<{
    owner: string;
    sample: CodexIngestionLagSample;
  }>;
  onIngestionLagSample(owner: string, sample: CodexIngestionLagSample): void;
}

function fakeHost(owners: readonly string[]): FakeHost {
  const host: FakeHost = {
    live: new Set(owners),
    events: [],
    reports: [],
    warnings: [],
    admissionFailures: [],
    deliveryFailures: [],
    ingestionLagChanges: [],
    ingestionLagSamples: [],
    isLiveOwner: (owner) => host.live.has(owner),
    pauseSource: () => host.events.push('pause'),
    resumeSource: () => host.events.push('resume'),
    onSourcePauseChange: (paused) =>
      host.events.push(paused ? 'deadlines-suspended' : 'deadlines-resumed'),
    onAdmissionFailure: (error) => host.admissionFailures.push(error),
    onDeliveryFailure: (error) => host.deliveryFailures.push(error),
    reportLongHold: (report) => host.reports.push(report),
    warnLongHold: (message) => host.warnings.push(message),
    onIngestionLagChange: (owner, change) =>
      host.ingestionLagChanges.push({ owner, change }),
    onIngestionLagSample: (owner, sample) =>
      host.ingestionLagSamples.push({ owner, sample }),
  };
  return host;
}

function ingestionLagOutcomes(
  host: FakeHost,
): Array<'entered' | 'drained' | 'aborted'> {
  return host.ingestionLagChanges.map((entry) => entry.change.outcome);
}

function frame(
  log: string[],
  label: string,
  options: {
    kind?: OwnerLaneFrameKind;
    bytes?: number;
    admission?: Promise<void>;
    producedAtMs?: number;
    overlap?: boolean;
  } = {},
): OwnerLaneFrame {
  return {
    kind: options.kind ?? 'notification',
    producedAtMs: options.producedAtMs,
    overlap: options.overlap,
    measureBytes: () => options.bytes ?? 10,
    deliver: (): void | Promise<void> => {
      log.push(label);
      return options.admission;
    },
  };
}

const LIMITS = {
  highWaterBytes: 100,
  lowWaterBytes: 50,
  longHoldThresholdMs: 1_000,
};

describe('OwnerAdmissionLanes', () => {
  it('tracks per-owner lag as queued frames wait and returns to zero when drained', async () => {
    let now = 10_000;
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const first = deferred();
    const second = deferred();

    lanes.dispatch('a', frame([], 'first', { admission: first.promise }));
    now = 11_000;
    lanes.dispatch('a', frame([], 'second', { admission: second.promise }));
    expect(lanes.ingestionLag('a')?.lagMs).toBe(1_000);
    now = 12_500;
    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 2_500,
      catchingUp: false,
      source: 'receipt',
    });

    first.resolve();
    await settle();
    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 1_500,
      catchingUp: false,
      source: 'receipt',
    });

    second.resolve();
    await settle();
    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 0,
      catchingUp: false,
      source: 'receipt',
    });
  });

  it('enters only above 5,000 ms and latches one episode through recovery until drain', async () => {
    let now = 100_000;
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const first = deferred();
    const second = deferred();
    lanes.dispatch(
      'a',
      frame([], 'first', {
        admission: first.promise,
        producedAtMs: 95_000,
      }),
    );

    expect(lanes.ingestionLag('a')?.lagMs).toBe(5_000);
    expect(host.ingestionLagChanges).toHaveLength(0);
    now = 100_001;
    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 5_001,
      catchingUp: true,
      source: 'provider',
    });
    expect(ingestionLagOutcomes(host)).toEqual(['entered']);

    now = 100_100;
    lanes.dispatch('a', frame([], 'second', { admission: second.promise }));
    first.resolve();
    await settle();
    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 0,
      catchingUp: true,
      source: 'receipt',
    });
    now = 105_101;
    expect(lanes.ingestionLag('a')?.catchingUp).toBe(true);
    expect(ingestionLagOutcomes(host)).toEqual(['entered']);

    second.resolve();
    await settle();
    expect(ingestionLagOutcomes(host)).toEqual(['entered', 'drained']);
    expect(host.ingestionLagChanges[1]?.change).toMatchObject({
      lagMs: 0,
      peakLagMs: 5_100,
      episodeMs: 5_100,
      thresholdMs: 5_000,
      source: 'receipt',
    });
  });

  it('samples only after strictly exceeding 5,000 ms using one clock read', () => {
    let now = 100_000;
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const hold = deferred();
    lanes.dispatch(
      'a',
      frame([], 'exact threshold', {
        admission: hold.promise,
        producedAtMs: 95_000,
      }),
    );

    expect(host.ingestionLagSamples).toEqual([]);
    now = 100_001;
    lanes.ingestionLag('a');
    expect(host.ingestionLagSamples).toEqual([
      {
        owner: 'a',
        sample: {
          lagMs: 5_001,
          source: 'provider',
          sampledAtMs: 100_001,
          catchingUp: true,
        },
      },
    ]);
    lanes.discardAll();
  });

  it('throttles active samples per owner during frequent evaluations on a short watch interval', () => {
    jest.useFakeTimers();
    try {
      let now = 100_000;
      const host = fakeHost(['a', 'b']);
      const lanes = new OwnerAdmissionLanes(
        host,
        { ...LIMITS, longHoldThresholdMs: 100 },
        () => now,
      );
      lanes.dispatch(
        'a',
        frame([], 'a', {
          admission: deferred().promise,
          producedAtMs: 94_999,
        }),
      );
      now = 100_500;
      lanes.dispatch(
        'b',
        frame([], 'b', {
          admission: deferred().promise,
          producedAtMs: 95_499,
        }),
      );

      expect(host.ingestionLagSamples.map((entry) => entry.owner)).toEqual([
        'a',
        'b',
      ]);
      for (let index = 0; index < 4; index += 1) {
        now += 100;
        jest.advanceTimersByTime(100);
        lanes.ingestionLag('a');
        lanes.ingestionLag('b');
      }
      expect(host.ingestionLagSamples).toHaveLength(2);

      now += 100;
      jest.advanceTimersByTime(100);
      expect(host.ingestionLagSamples).toHaveLength(3);
      expect(host.ingestionLagSamples[2]).toEqual({
        owner: 'a',
        sample: {
          lagMs: 6_001,
          source: 'provider',
          sampledAtMs: 101_000,
          catchingUp: true,
        },
      });

      for (let index = 0; index < 5; index += 1) {
        now += 100;
        jest.advanceTimersByTime(100);
      }
      expect(host.ingestionLagSamples).toHaveLength(4);
      expect(host.ingestionLagSamples[3]).toEqual({
        owner: 'b',
        sample: {
          lagMs: 6_001,
          source: 'provider',
          sampledAtMs: 101_500,
          catchingUp: true,
        },
      });
      lanes.discardAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('samples the decreasing lag and source of the current oldest outstanding frame', async () => {
    jest.useFakeTimers();
    try {
      let now = 100_000;
      const host = fakeHost(['a']);
      const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
      const first = deferred();
      const second = deferred();
      lanes.dispatch(
        'a',
        frame([], 'provider frame', {
          admission: first.promise,
          producedAtMs: 94_999,
        }),
      );
      lanes.dispatch(
        'a',
        frame([], 'receipt frame', { admission: second.promise }),
      );

      now = 100_600;
      first.resolve();
      await Promise.resolve();
      now = 101_000;
      jest.advanceTimersByTime(1_000);

      expect(host.ingestionLagSamples).toEqual([
        {
          owner: 'a',
          sample: {
            lagMs: 5_001,
            source: 'provider',
            sampledAtMs: 100_000,
            catchingUp: true,
          },
        },
        {
          owner: 'a',
          sample: {
            lagMs: 1_000,
            source: 'receipt',
            sampledAtMs: 101_000,
            catchingUp: true,
          },
        },
      ]);
      lanes.discardAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('immediately samples drained and aborted episodes without losing current abort lag', async () => {
    let now = 100_000;
    const host = fakeHost(['drained', 'aborted']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const drained = deferred();
    lanes.dispatch(
      'drained',
      frame([], 'drained', {
        admission: drained.promise,
        producedAtMs: 94_999,
      }),
    );

    now = 101_250;
    drained.resolve();
    await settle();
    expect(host.ingestionLagSamples.slice(0, 2)).toEqual([
      {
        owner: 'drained',
        sample: {
          lagMs: 5_001,
          source: 'provider',
          sampledAtMs: 100_000,
          catchingUp: true,
        },
      },
      {
        owner: 'drained',
        sample: {
          lagMs: 0,
          source: 'provider',
          sampledAtMs: 101_250,
          catchingUp: false,
        },
      },
    ]);

    const aborted = deferred();
    now = 110_000;
    lanes.dispatch(
      'aborted',
      frame([], 'aborted', {
        admission: aborted.promise,
        producedAtMs: 104_999,
      }),
    );
    now = 111_000;
    lanes.retire('aborted');
    expect(host.ingestionLagSamples.slice(2)).toEqual([
      {
        owner: 'aborted',
        sample: {
          lagMs: 5_001,
          source: 'provider',
          sampledAtMs: 110_000,
          catchingUp: true,
        },
      },
      {
        owner: 'aborted',
        sample: {
          lagMs: 6_001,
          source: 'provider',
          sampledAtMs: 111_000,
          catchingUp: false,
        },
      },
    ]);
  });

  it('isolates ingestion-lag sample observer failures from transitions and admission', async () => {
    const host = fakeHost(['a']);
    host.onIngestionLagSample = (): void => {
      throw new Error('sample observer failed');
    };
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => 100_000);
    const first = deferred();
    const second = deferred();
    const log: string[] = [];
    lanes.dispatch(
      'a',
      frame(log, 'first', {
        admission: first.promise,
        producedAtMs: 94_999,
      }),
    );
    lanes.dispatch('a', frame(log, 'second', { admission: second.promise }));

    first.resolve();
    await settle();
    second.resolve();
    await settle();

    expect(log).toEqual(['first', 'second']);
    expect(host.admissionFailures).toEqual([]);
    expect(ingestionLagOutcomes(host)).toEqual(['entered', 'drained']);
  });

  it('starts a fresh episode after drain and aborts entered episodes on discard or retirement', () => {
    let now = 100_000;
    const host = fakeHost(['discarded', 'retired']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const discardedHold = deferred();
    lanes.dispatch(
      'discarded',
      frame([], 'discarded', {
        admission: discardedHold.promise,
        producedAtMs: 90_000,
      }),
    );
    expect(lanes.ingestionLag('discarded')?.catchingUp).toBe(true);
    lanes.discardAll();
    expect(ingestionLagOutcomes(host)).toEqual(['entered', 'aborted']);

    const secondLanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const retiredHold = deferred();
    secondLanes.dispatch(
      'retired',
      frame([], 'retired', {
        admission: retiredHold.promise,
        producedAtMs: 90_000,
      }),
    );
    secondLanes.retire('retired');
    expect(ingestionLagOutcomes(host)).toEqual([
      'entered',
      'aborted',
      'entered',
      'aborted',
    ]);

    const drainedLanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const first = deferred();
    drainedLanes.dispatch(
      'discarded',
      frame([], 'first episode', {
        admission: first.promise,
        producedAtMs: 90_000,
      }),
    );
    first.resolve();
    return settle().then(() => {
      now = 110_000;
      const second = deferred();
      drainedLanes.dispatch(
        'discarded',
        frame([], 'second episode', {
          admission: second.promise,
          producedAtMs: 90_000,
        }),
      );
      expect(ingestionLagOutcomes(host)).toEqual([
        'entered',
        'aborted',
        'entered',
        'aborted',
        'entered',
        'drained',
        'entered',
      ]);
      drainedLanes.discardAll();
    });
  });

  it('keeps lag and episodes independent for each owner', () => {
    const now = 100_000;
    const host = fakeHost(['a', 'b']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    lanes.dispatch(
      'a',
      frame([], 'a', {
        admission: deferred().promise,
        producedAtMs: 90_000,
      }),
    );
    lanes.dispatch('b', frame([], 'b', { admission: deferred().promise }));

    expect(lanes.ingestionLag('a')).toEqual({
      lagMs: 10_000,
      catchingUp: true,
      source: 'provider',
    });
    expect(lanes.ingestionLag('b')).toEqual({
      lagMs: 0,
      catchingUp: false,
      source: 'receipt',
    });
    expect(host.ingestionLagChanges.map((entry) => entry.owner)).toEqual(['a']);
    lanes.discardAll();
  });

  it('uses older valid provider timestamps and falls back to receipt time for malformed or future values', () => {
    const now = 50_000;
    const host = fakeHost(['provider', 'nan', 'zero', 'infinite', 'future']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    lanes.dispatch(
      'provider',
      frame([], 'provider', {
        admission: deferred().promise,
        producedAtMs: 45_000,
      }),
    );
    expect(lanes.ingestionLag('provider')).toEqual({
      lagMs: 5_000,
      catchingUp: false,
      source: 'provider',
    });

    const invalidTimestamps: Array<[string, number]> = [
      ['nan', Number.NaN],
      ['zero', 0],
      ['infinite', Number.POSITIVE_INFINITY],
      ['future', now + 1],
    ];
    for (const [owner, producedAtMs] of invalidTimestamps) {
      lanes.dispatch(
        owner,
        frame([], owner, {
          admission: deferred().promise,
          producedAtMs,
        }),
      );
      expect(lanes.ingestionLag(owner)).toEqual({
        lagMs: 0,
        catchingUp: false,
        source: 'receipt',
      });
    }
    lanes.discardAll();
  });

  it('uses the existing watch timer to enter a quiet held lane episode', () => {
    jest.useFakeTimers();
    try {
      let now = 100_000;
      const host = fakeHost(['a']);
      const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
      lanes.dispatch(
        'a',
        frame([], 'quiet', { admission: deferred().promise }),
      );

      now = 105_001;
      jest.advanceTimersByTime(1_000);
      expect(ingestionLagOutcomes(host)).toEqual(['entered']);
      expect(lanes.ingestionLag('a')).toEqual({
        lagMs: 5_001,
        catchingUp: true,
        source: 'receipt',
      });
      lanes.discardAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('delivers synchronously when the owner lane is clear', () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    lanes.dispatch('a', frame(log, 'a1'));
    lanes.dispatch('a', frame(log, 'a2'));
    expect(log).toEqual(['a1', 'a2']);
    expect(lanes.isBusy('a')).toBe(false);
  });

  it('holds only the owner whose admission is pending and keeps its FIFO order', async () => {
    const host = fakeHost(['a', 'b']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: first.promise }));
    lanes.dispatch('a', frame(log, 'a2'));
    lanes.dispatch('b', frame(log, 'b1'));
    lanes.dispatch('a', frame(log, 'a3', { admission: second.promise }));
    lanes.dispatch('a', frame(log, 'a4', { kind: 'response' }));
    lanes.dispatch('b', frame(log, 'b2'));
    expect(log).toEqual(['a1', 'b1', 'b2']);
    expect(lanes.isBusy('a')).toBe(true);
    expect(lanes.isBusy('b')).toBe(false);

    first.resolve();
    await settle();
    expect(log).toEqual(['a1', 'b1', 'b2', 'a2', 'a3']);
    second.resolve();
    await settle();
    expect(log).toEqual(['a1', 'b1', 'b2', 'a2', 'a3', 'a4']);
    expect(lanes.isBusy('a')).toBe(false);
  });

  it('pauses the source above high water and resumes at low water', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    lanes.dispatch('a', frame(log, 'a0', { admission: hold.promise }));
    for (let index = 1; index <= 10; index += 1) {
      lanes.dispatch('a', frame(log, `a${String(index)}`, { bytes: 10 }));
    }
    // 100 bytes retained is not above the 100-byte high-water mark.
    expect(host.events).toEqual([]);
    lanes.dispatch('a', frame(log, 'a11', { bytes: 10 }));
    expect(host.events).toEqual(['pause', 'deadlines-suspended']);
    expect(lanes.isSourcePaused()).toBe(true);

    hold.resolve();
    await settle();
    expect(host.events).toEqual([
      'pause',
      'deadlines-suspended',
      'deadlines-resumed',
      'resume',
    ]);
    expect(lanes.isSourcePaused()).toBe(false);
    expect(log).toHaveLength(12);
  });

  it('resumes once a held owner drains below low water, not when the queue empties', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    lanes.dispatch('a', frame(log, 'a0', { admission: first.promise }));
    lanes.dispatch('a', frame(log, 'a1', { bytes: 40 }));
    lanes.dispatch(
      'a',
      frame(log, 'a2', { bytes: 40, admission: second.promise }),
    );
    lanes.dispatch('a', frame(log, 'a3', { bytes: 40 }));
    expect(host.events).toEqual(['pause', 'deadlines-suspended']);
    first.resolve();
    await settle();
    // a1 and a2 delivered; a3 (40 bytes) is still retained behind a2.
    expect(log).toEqual(['a0', 'a1', 'a2']);
    expect(host.events).toEqual([
      'pause',
      'deadlines-suspended',
      'deadlines-resumed',
      'resume',
    ]);
    second.resolve();
    await settle();
    expect(log).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  it('admits one oversized frame alone and pauses until it drains', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    lanes.dispatch('a', frame(log, 'a0', { admission: hold.promise }));
    lanes.dispatch('a', frame(log, 'huge', { bytes: 10_000 }));
    expect(host.events).toEqual(['pause', 'deadlines-suspended']);
    hold.resolve();
    await settle();
    expect(log).toEqual(['a0', 'huge']);
    expect(lanes.isSourcePaused()).toBe(false);
  });

  it('does not hold for owners that are not live', () => {
    const host = fakeHost([]);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    lanes.dispatch('gone', frame(log, 'g1', { admission: hold.promise }));
    lanes.dispatch('gone', frame(log, 'g2'));
    expect(log).toEqual(['g1', 'g2']);
    hold.reject(new Error('late failure is not fatal'));
    expect(host.admissionFailures).toEqual([]);
  });

  it('drains a retired owner on a microtask without holding again', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    const later = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: hold.promise }));
    lanes.dispatch('a', frame(log, 'a2', { admission: later.promise }));
    lanes.dispatch('a', frame(log, 'a3'));
    host.live.delete('a');
    lanes.retire('a');
    expect(log).toEqual(['a1']);
    await Promise.resolve();
    expect(log).toEqual(['a1', 'a2', 'a3']);
    expect(lanes.isBusy('a')).toBe(false);
    hold.reject(new Error('detached'));
    later.reject(new Error('detached'));
    await settle();
    expect(host.admissionFailures).toEqual([]);
  });

  it('reports an admission rejection while the owner holds its lane', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: hold.promise }));
    hold.reject(new Error('commit failed'));
    await settle();
    expect(host.admissionFailures.map((error) => error.message)).toEqual([
      'commit failed',
    ]);
  });

  it('routes a synchronous delivery error from a queued frame to the host', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const hold = deferred();
    lanes.dispatch('a', frame([], 'a1', { admission: hold.promise }));
    lanes.dispatch('a', {
      kind: 'notification',
      measureBytes: () => 1,
      deliver: () => {
        throw new Error('reducer failed');
      },
    });
    hold.resolve();
    await settle();
    expect(host.deliveryFailures.map((error) => error.message)).toEqual([
      'reducer failed',
    ]);
  });

  it('discards retained frames, ends a source pause, and ignores late settlements', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const hold = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: hold.promise }));
    lanes.dispatch('a', frame(log, 'a2', { bytes: 500 }));
    expect(lanes.isSourcePaused()).toBe(true);
    expect(lanes.discardAll()).toBe(true);
    expect(host.events).toEqual([
      'pause',
      'deadlines-suspended',
      'deadlines-resumed',
    ]);
    expect(lanes.isSourcePaused()).toBe(false);
    hold.reject(new Error('after discard'));
    await settle();
    expect(log).toEqual(['a1']);
    expect(host.admissionFailures).toEqual([]);
    expect(lanes.discardAll()).toBe(false);
  });

  it('reports a long hold once at its end and warns once while it is pending', () => {
    jest.useFakeTimers();
    try {
      const host = fakeHost(['a']);
      const lanes = new OwnerAdmissionLanes(host, LIMITS);
      const hold = deferred();
      lanes.dispatch('a', frame([], 'a1', { admission: hold.promise }));
      lanes.dispatch('a', frame([], 'a2', { bytes: 7 }));
      lanes.dispatch('a', frame([], 'a3', { kind: 'response', bytes: 5 }));
      jest.advanceTimersByTime(999);
      expect(host.warnings).toEqual([]);
      jest.advanceTimersByTime(1_000);
      expect(host.warnings).toHaveLength(1);
      expect(host.warnings[0]).toContain('owner admission held for');
      expect(host.warnings[0]).toContain('2 frame(s), 12 bytes');
      expect(host.warnings[0]).toContain('JSON-RPC response');
      jest.advanceTimersByTime(5_000);
      expect(host.warnings).toHaveLength(1);
      expect(host.reports).toEqual([]);
      lanes.discardAll();
      expect(host.reports).toEqual([
        {
          holdKind: 'owner-admission',
          holdOutcome: 'discarded',
          holdDurationMs: 6_999,
          queuedFrameCount: 2,
          queuedFrameBytes: 12,
          responseQueued: true,
        },
      ]);
      expect(host.warnings).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rate-limits long-hold warnings and reports the suppressed count', () => {
    jest.useFakeTimers();
    try {
      const host = fakeHost(['a', 'b', 'c']);
      const lanes = new OwnerAdmissionLanes(host, LIMITS);
      for (const owner of ['a', 'b']) {
        lanes.dispatch(
          owner,
          frame([], owner, { admission: deferred().promise }),
        );
      }
      jest.advanceTimersByTime(1_000);
      expect(host.warnings).toHaveLength(1);
      jest.advanceTimersByTime(30_000);
      lanes.dispatch('c', frame([], 'c', { admission: deferred().promise }));
      jest.advanceTimersByTime(1_000);
      expect(host.warnings).toHaveLength(2);
      expect(host.warnings[1]).toContain('suppressed 1 similar warning');
      lanes.discardAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a long byte-cap pause with all-owner counts', async () => {
    let now = 0;
    const host = fakeHost(['a', 'b']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS, () => now);
    const holdA = deferred();
    const holdB = deferred();
    lanes.dispatch('a', frame([], 'a0', { admission: holdA.promise }));
    lanes.dispatch('b', frame([], 'b0', { admission: holdB.promise }));
    lanes.dispatch('a', frame([], 'a1', { bytes: 60 }));
    lanes.dispatch('b', frame([], 'b1', { bytes: 60, kind: 'response' }));
    expect(lanes.isSourcePaused()).toBe(true);
    now = 2_500;
    holdA.resolve();
    holdB.resolve();
    await settle();
    expect(host.reports).toEqual(
      expect.arrayContaining([
        {
          holdKind: 'stdout-byte-cap',
          holdOutcome: 'released',
          holdDurationMs: 2_500,
          queuedFrameCount: 2,
          queuedFrameBytes: 120,
          responseQueued: true,
        },
      ]),
    );
    lanes.discardAll();
  });

  it('settles a drain once the frames read before it are admitted, while later frames stay pending', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    const later = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: first.promise }));
    lanes.dispatch('a', frame(log, 'a2', { admission: second.promise }));
    const drain = lanes.whenDrained('a');
    expect(drain).toBeDefined();
    let drained = false;
    void drain?.then(() => {
      drained = true;
    });
    lanes.dispatch('a', frame(log, 'a3', { admission: later.promise }));

    first.resolve();
    await settle();
    expect(log).toEqual(['a1', 'a2']);
    expect(drained).toBe(false);

    second.resolve();
    await settle();
    // a3 reached the lane after the drain began: its pending admission does
    // not extend the drain.
    expect(log).toEqual(['a1', 'a2', 'a3']);
    expect(drained).toBe(true);
    expect(lanes.isBusy('a')).toBe(true);

    later.resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(false);
  });

  it('never leaves an unobserved drain as an unhandled rejection when the worker goes away', async () => {
    const host = fakeHost(['a']);
    const lanes = new OwnerAdmissionLanes(host, LIMITS);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const hold = deferred();
      lanes.dispatch('a', frame([], 'a1', { admission: hold.promise }));
      // The caller drops the drain without observing it.
      expect(lanes.whenDrained('a')).toBeDefined();
      lanes.discardAll();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('RequestDeadline', () => {
  it('expires after its timeout', () => {
    jest.useFakeTimers();
    try {
      const onExpire = jest.fn();
      const deadline = new RequestDeadline(100, onExpire);
      deadline.start(false);
      jest.advanceTimersByTime(99);
      expect(onExpire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps only its remaining budget across a suspension', () => {
    jest.useFakeTimers();
    try {
      const onExpire = jest.fn();
      const deadline = new RequestDeadline(100, onExpire);
      deadline.start(false);
      jest.advanceTimersByTime(60);
      deadline.suspend();
      expect(deadline.isSuspended()).toBe(true);
      jest.advanceTimersByTime(10_000);
      expect(onExpire).not.toHaveBeenCalled();
      deadline.resume();
      jest.advanceTimersByTime(39);
      expect(onExpire).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts suspended and never expires once cancelled', () => {
    jest.useFakeTimers();
    try {
      const onExpire = jest.fn();
      const deadline = new RequestDeadline(100, onExpire);
      deadline.start(true);
      jest.advanceTimersByTime(1_000);
      expect(onExpire).not.toHaveBeenCalled();
      deadline.resume();
      deadline.cancel();
      deadline.resume();
      jest.advanceTimersByTime(1_000);
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
