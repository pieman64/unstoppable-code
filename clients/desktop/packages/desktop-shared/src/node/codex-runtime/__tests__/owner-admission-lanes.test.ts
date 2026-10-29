import {
  OwnerAdmissionLanes,
  type OwnerAdmissionLanesHost,
  type OwnerLaneFrame,
  type OwnerLaneFrameKind,
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
}

function fakeHost(owners: readonly string[]): FakeHost {
  const host: FakeHost = {
    live: new Set(owners),
    events: [],
    reports: [],
    warnings: [],
    admissionFailures: [],
    deliveryFailures: [],
    isLiveOwner: (owner) => host.live.has(owner),
    pauseSource: () => host.events.push('pause'),
    resumeSource: () => host.events.push('resume'),
    onSourcePauseChange: (paused) =>
      host.events.push(paused ? 'deadlines-suspended' : 'deadlines-resumed'),
    onAdmissionFailure: (error) => host.admissionFailures.push(error),
    onDeliveryFailure: (error) => host.deliveryFailures.push(error),
    reportLongHold: (report) => host.reports.push(report),
    warnLongHold: (message) => host.warnings.push(message),
  };
  return host;
}

function frame(
  log: string[],
  label: string,
  options: {
    kind?: OwnerLaneFrameKind;
    bytes?: number;
    admission?: Promise<void>;
  } = {},
): OwnerLaneFrame {
  return {
    kind: options.kind ?? 'notification',
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
