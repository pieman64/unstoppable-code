/**
 * The per-owner in-flight budget of `OwnerAdmissionLanes` (group commit,
 * desktop performance phase 11). With a budget, an owner's lane delivers
 * further overlappable notifications while earlier admissions are pending,
 * in pipe order, up to a byte and a frame bound. Without one, the lane keeps
 * one pending admission per owner (`owner-admission-lanes.test.ts`).
 */
import {
  OwnerAdmissionLanes,
  type OwnerAdmissionLanesHost,
  type OwnerInFlightBudget,
  type OwnerLaneFrame,
  type OwnerLaneFrameKind,
  type StdoutHoldReport,
} from '../owner-admission-lanes';

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
  admissionFailures: Error[];
  warnings: string[];
}

function fakeHost(owners: readonly string[]): FakeHost {
  const host: FakeHost = {
    live: new Set(owners),
    events: [],
    reports: [],
    admissionFailures: [],
    warnings: [],
    isLiveOwner: (owner) => host.live.has(owner),
    pauseSource: () => host.events.push('pause'),
    resumeSource: () => host.events.push('resume'),
    onSourcePauseChange: () => undefined,
    onAdmissionFailure: (error) => host.admissionFailures.push(error),
    onDeliveryFailure: () => undefined,
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
    overlap?: boolean;
  } = {},
): OwnerLaneFrame {
  return {
    kind: options.kind ?? 'notification',
    overlap: options.overlap ?? true,
    measureBytes: () => options.bytes ?? 10,
    deliver: (): void | Promise<void> => {
      log.push(label);
      return options.admission;
    },
  };
}

function lanesWith(
  host: FakeHost,
  budget: () => OwnerInFlightBudget | undefined,
  limits: { highWaterBytes?: number; lowWaterBytes?: number } = {},
): OwnerAdmissionLanes<string> {
  return new OwnerAdmissionLanes(host, {
    highWaterBytes: limits.highWaterBytes ?? 1_000,
    lowWaterBytes: limits.lowWaterBytes ?? 500,
    longHoldThresholdMs: 1_000,
    ownerInFlight: budget,
  });
}

describe('OwnerAdmissionLanes per-owner in-flight budget', () => {
  it('keeps several admissions of one owner pending, delivered in pipe order', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 100, frames: 8 }));
    const log: string[] = [];
    const admissions = [deferred(), deferred(), deferred()];
    lanes.dispatch('a', frame(log, 'a1', { admission: admissions[0].promise }));
    lanes.dispatch('a', frame(log, 'a2', { admission: admissions[1].promise }));
    lanes.dispatch('a', frame(log, 'a3', { admission: admissions[2].promise }));
    lanes.dispatch('a', frame(log, 'a4'));
    // All four were delivered at once, in order, with three admissions
    // pending.
    expect(log).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(lanes.isBusy('a')).toBe(true);
    // Admissions may settle in any order; the lane clears with the last.
    admissions[1].resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(true);
    admissions[0].resolve();
    admissions[2].resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(false);
    expect(host.admissionFailures).toEqual([]);
  });

  it('bounds the frames and bytes in flight and delivers the rest in order', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 30, frames: 8 }));
    const log: string[] = [];
    const admissions = [1, 2, 3, 4, 5].map(() => deferred());
    admissions.forEach((admission, index): void => {
      lanes.dispatch(
        'a',
        frame(log, `a${index + 1}`, { admission: admission.promise }),
      );
    });
    // Thirty bytes: three frames of ten in flight; the others wait.
    expect(log).toEqual(['a1', 'a2', 'a3']);
    admissions[0].resolve();
    await settle();
    expect(log).toEqual(['a1', 'a2', 'a3', 'a4']);
    admissions[1].resolve();
    admissions[2].resolve();
    await settle();
    expect(log).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    admissions[3].resolve();
    admissions[4].resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(false);

    // The frame bound, with bytes to spare.
    const counted = lanesWith(fakeHost(['a']), () => ({
      bytes: 1_000,
      frames: 2,
    }));
    const second: string[] = [];
    const held = [deferred(), deferred(), deferred()];
    held.forEach((admission, index): void => {
      counted.dispatch(
        'a',
        frame(second, `c${index + 1}`, { admission: admission.promise }),
      );
    });
    expect(second).toEqual(['c1', 'c2']);
    held[1].resolve();
    await settle();
    expect(second).toEqual(['c1', 'c2', 'c3']);
  });

  it('delivers a frame larger than the budget alone', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 30, frames: 8 }));
    const log: string[] = [];
    const small = deferred();
    const large = deferred();
    lanes.dispatch('a', frame(log, 'small', { admission: small.promise }));
    lanes.dispatch(
      'a',
      frame(log, 'large', { bytes: 500, admission: large.promise }),
    );
    lanes.dispatch('a', frame(log, 'after'));
    expect(log).toEqual(['small']);
    small.resolve();
    await settle();
    // Admitted alone; the next frame waits for it.
    expect(log).toEqual(['small', 'large']);
    large.resolve();
    await settle();
    expect(log).toEqual(['small', 'large', 'after']);
  });

  it('never lets a response, a server request or a barrier notification overtake or overlap', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 1_000, frames: 8 }));
    const log: string[] = [];
    const first = deferred();
    const terminal = deferred();
    lanes.dispatch('a', frame(log, 'n1', { admission: first.promise }));
    lanes.dispatch('a', frame(log, 'response', { kind: 'response' }));
    // Behind a retained frame, later notifications keep their place.
    lanes.dispatch('a', frame(log, 'n2'));
    lanes.dispatch(
      'a',
      frame(log, 'request', { kind: 'server-request', overlap: false }),
    );
    expect(log).toEqual(['n1']);
    first.resolve();
    await settle();
    expect(log).toEqual(['n1', 'response', 'n2', 'request']);

    // A notification that may not overlap (a turn boundary) waits for every
    // pending admission, and nothing is delivered beside its own admission.
    const pending = deferred();
    lanes.dispatch('a', frame(log, 'n3', { admission: pending.promise }));
    lanes.dispatch(
      'a',
      frame(log, 'turn-completed', {
        overlap: false,
        admission: terminal.promise,
      }),
    );
    lanes.dispatch('a', frame(log, 'n4'));
    expect(log.slice(4)).toEqual(['n3']);
    pending.resolve();
    await settle();
    expect(log.slice(4)).toEqual(['n3', 'turn-completed']);
    terminal.resolve();
    await settle();
    expect(log.slice(4)).toEqual(['n3', 'turn-completed', 'n4']);
  });

  it('counts frames in flight toward the global byte cap', async () => {
    const host = fakeHost(['a', 'b']);
    const lanes = lanesWith(host, () => ({ bytes: 100, frames: 8 }), {
      highWaterBytes: 50,
      lowWaterBytes: 20,
    });
    const log: string[] = [];
    const admissions = [1, 2, 3, 4, 5, 6].map(() => deferred());
    admissions.forEach((admission, index): void => {
      lanes.dispatch(
        'a',
        frame(log, `a${index + 1}`, { admission: admission.promise }),
      );
    });
    // Sixty bytes are in flight for one owner: above the fifty-byte cap.
    expect(log).toHaveLength(6);
    expect(host.events).toEqual(['pause']);
    expect(lanes.isSourcePaused()).toBe(true);
    // Another owner is still delivered what was already read.
    lanes.dispatch('b', frame(log, 'b1'));
    expect(log).toContain('b1');
    for (const admission of admissions.slice(0, 4)) admission.resolve();
    await settle();
    expect(host.events).toEqual(['pause', 'resume']);
    for (const admission of admissions.slice(4)) admission.resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(false);
  });

  it('keeps a rejected admission connection-fatal with several pending', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 100, frames: 8 }));
    const log: string[] = [];
    const admissions = [deferred(), deferred(), deferred()];
    admissions.forEach((admission, index): void => {
      lanes.dispatch(
        'a',
        frame(log, `a${index + 1}`, { admission: admission.promise }),
      );
    });
    lanes.dispatch('a', frame(log, 'queued', { kind: 'response' }));
    admissions[1].reject(new Error('commit failed'));
    await settle();
    expect(host.admissionFailures.map((error) => error.message)).toEqual([
      'commit failed',
    ]);
    // Reported once; the other admissions settling later change nothing and
    // nothing retained is delivered past the failure.
    admissions[0].resolve();
    admissions[2].reject(new Error('also failed'));
    await settle();
    expect(host.admissionFailures).toHaveLength(1);
    expect(log).toEqual(['a1', 'a2', 'a3']);
  });

  it('detaches every pending admission when the owner is retired or the worker goes away', async () => {
    const host = fakeHost(['a']);
    const lanes = lanesWith(host, () => ({ bytes: 100, frames: 8 }), {
      highWaterBytes: 15,
      lowWaterBytes: 5,
    });
    const log: string[] = [];
    const admissions = [deferred(), deferred()];
    admissions.forEach((admission, index): void => {
      lanes.dispatch(
        'a',
        frame(log, `a${index + 1}`, { admission: admission.promise }),
      );
    });
    lanes.dispatch('a', frame(log, 'queued', { kind: 'response' }));
    expect(lanes.isSourcePaused()).toBe(true);
    host.live.delete('a');
    lanes.retire('a');
    await settle();
    // The retained frame is delivered without waiting, the bytes in flight
    // are released, and a late rejection is not connection-fatal.
    expect(log).toEqual(['a1', 'a2', 'queued']);
    expect(lanes.isBusy('a')).toBe(false);
    expect(lanes.isSourcePaused()).toBe(false);
    admissions[0].reject(new Error('late'));
    admissions[1].resolve();
    await settle();
    expect(host.admissionFailures).toEqual([]);

    const second = fakeHost(['a']);
    const discarded = lanesWith(second, () => ({ bytes: 100, frames: 8 }));
    const pending = [deferred(), deferred()];
    pending.forEach((admission, index): void => {
      discarded.dispatch(
        'a',
        frame(log, `d${index + 1}`, { admission: admission.promise }),
      );
    });
    expect(discarded.discardAll()).toBe(true);
    expect(discarded.isBusy('a')).toBe(false);
    pending[0].reject(new Error('worker gone'));
    await settle();
    expect(second.admissionFailures).toEqual([]);
  });

  it('holds one admission per owner when no budget applies, and follows the budget as it changes', async () => {
    const host = fakeHost(['a']);
    const current: { budget?: OwnerInFlightBudget } = {};
    const lanes = lanesWith(host, () => current.budget);
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    lanes.dispatch('a', frame(log, 'a1', { admission: first.promise }));
    lanes.dispatch('a', frame(log, 'a2', { admission: second.promise }));
    // No budget: exactly one pending admission.
    expect(log).toEqual(['a1']);
    // The budget turning on does not let a frame jump the queue.
    current.budget = { bytes: 100, frames: 8 };
    lanes.dispatch('a', frame(log, 'a3'));
    expect(log).toEqual(['a1']);
    first.resolve();
    await settle();
    expect(log).toEqual(['a1', 'a2', 'a3']);
    second.resolve();
    await settle();
    expect(lanes.isBusy('a')).toBe(false);
  });

  describe('long-hold reporting', () => {
    const fakeTimers = (): void => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
    };
    afterEach(() => {
      jest.useRealTimers();
    });
    const ownerReports = (host: FakeHost): StdoutHoldReport[] =>
      host.reports.filter((report) => report.holdKind === 'owner-admission');

    it('does not report a busy owner whose overlapping admissions each settle quickly', async () => {
      fakeTimers();
      const host = fakeHost(['a']);
      const lanes = lanesWith(host, () => ({ bytes: 1_000, frames: 8 }));
      const log: string[] = [];
      const admissions: Deferred[] = [];
      // Threshold 1 s. Nine admissions start 300 ms apart and each settles
      // after 600 ms, so one is always pending for 3 s.
      for (let index = 0; index < 9; index += 1) {
        const admission = deferred();
        admissions.push(admission);
        lanes.dispatch(
          'a',
          frame(log, `a${index + 1}`, { admission: admission.promise }),
        );
        jest.advanceTimersByTime(300);
        if (index >= 1) {
          admissions[index - 1].resolve();
          await settle();
          expect(lanes.isBusy('a')).toBe(true);
        }
      }
      jest.advanceTimersByTime(300);
      admissions[8].resolve();
      await settle();
      expect(log).toHaveLength(9);
      expect(lanes.isBusy('a')).toBe(false);
      expect(host.warnings).toEqual([]);
      expect(ownerReports(host)).toEqual([]);
    });

    it('reports one slow admission by its own duration when it settles, while the owner stays busy', async () => {
      fakeTimers();
      const host = fakeHost(['a']);
      const lanes = lanesWith(host, () => ({ bytes: 1_000, frames: 8 }));
      const log: string[] = [];
      const early = deferred();
      const slow = deferred();
      const late = deferred();
      lanes.dispatch('a', frame(log, 'a1', { admission: early.promise }));
      jest.advanceTimersByTime(400);
      lanes.dispatch('a', frame(log, 'a2', { admission: slow.promise }));
      jest.advanceTimersByTime(400);
      early.resolve();
      await settle();
      // 800 ms: only the slow admission (pending 400 ms) remains. The watch
      // runs each second and sees it 1600 ms old at 2000 ms.
      jest.advanceTimersByTime(1_300);
      expect(host.warnings).toHaveLength(1);
      expect(host.warnings[0]).toContain('owner admission held for 1.6s');
      lanes.dispatch('a', frame(log, 'a3', { admission: late.promise }));
      jest.advanceTimersByTime(300);
      // 2400 ms: the slow admission settles after 2000 ms; a3 is pending.
      slow.resolve();
      await settle();
      expect(lanes.isBusy('a')).toBe(true);
      expect(ownerReports(host)).toEqual([
        expect.objectContaining({
          holdOutcome: 'released',
          holdDurationMs: 2_000,
        }),
      ]);
      jest.advanceTimersByTime(300);
      late.resolve();
      await settle();
      expect(lanes.isBusy('a')).toBe(false);
      expect(ownerReports(host)).toHaveLength(1);
      expect(host.warnings).toHaveLength(1);
    });

    it('reports a stall of several overlapping admissions once', async () => {
      fakeTimers();
      const host = fakeHost(['a']);
      const lanes = lanesWith(host, () => ({ bytes: 1_000, frames: 8 }));
      const log: string[] = [];
      const admissions = [deferred(), deferred(), deferred()];
      admissions.forEach((admission, index): void => {
        lanes.dispatch(
          'a',
          frame(log, `a${index + 1}`, { admission: admission.promise }),
        );
        jest.advanceTimersByTime(100);
      });
      jest.advanceTimersByTime(1_700);
      // 2000 ms: all three settle together, pending 2000, 1900 and 1800 ms.
      admissions.forEach((admission) => admission.resolve());
      await settle();
      expect(lanes.isBusy('a')).toBe(false);
      expect(ownerReports(host)).toEqual([
        expect.objectContaining({
          holdOutcome: 'released',
          holdDurationMs: 2_000,
        }),
      ]);
    });
  });
});
