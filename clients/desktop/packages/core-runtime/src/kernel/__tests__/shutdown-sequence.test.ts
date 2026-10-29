import {
  createShutdownSequence,
  type ShutdownPhase,
} from '../shutdown-sequence';

type PhaseId = ShutdownPhase['id'];
const ids: readonly PhaseId[] = [1, 2, 3, 4, 5, 6, 7];

const phase = (
  id: PhaseId,
  deadlineMs: number,
  run: ShutdownPhase['run'] = () => undefined,
): ShutdownPhase => ({ id, name: `phase-${id}`, deadlineMs, run });

describe('createShutdownSequence', () => {
  afterEach(() => jest.useRealTimers());

  it('validates deadlines, ordering, and unique ids', () => {
    for (const deadlineMs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        createShutdownSequence({ phases: [phase(1, deadlineMs)] }),
      ).toThrow(RangeError);
    expect(() =>
      createShutdownSequence({ phases: [phase(1, 1), phase(1, 1)] }),
    ).toThrow(RangeError);
    expect(() =>
      createShutdownSequence({ phases: [phase(2, 1), phase(1, 1)] }),
    ).toThrow(RangeError);
  });

  it('runs all seven phases in order and times each out at its deadline', async () => {
    jest.useFakeTimers();
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const phases = ids.map((id) =>
      phase(id, id * 100, (signal) => {
        started.push(id);
        signals.push(signal);
        return new Promise<void>(() => undefined);
      }),
    );
    const result = createShutdownSequence({ phases }).run('quit');
    for (const id of ids) {
      await jest.advanceTimersByTimeAsync(id * 100 - 1);
      expect(started).toEqual(ids.slice(0, id));
      expect(signals[id - 1].aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(signals[id - 1].aborted).toBe(true);
    }
    const report = await result;
    expect(report.reason).toBe('quit');
    expect(report.phases).toEqual(
      ids.map((id) => ({ id, status: 'timed_out', elapsedMs: id * 100 })),
    );
  });

  it('continues after a failure and reports mixed outcomes with injected now', async () => {
    let clock = 0;
    const order: number[] = [];
    const sequence = createShutdownSequence({
      now: () => clock,
      phases: [
        phase(1, 50, () => {
          order.push(1);
          clock += 5;
        }),
        phase(2, 50, () => {
          order.push(2);
          clock += 7;
          throw new Error('sync boom');
        }),
        phase(3, 50, () => {
          order.push(3);
          return Promise.reject(new Error('async boom'));
        }),
      ],
    });
    const report = await sequence.run('crash');
    expect(order).toEqual([1, 2, 3]);
    expect(report.phases).toEqual([
      { id: 1, status: 'completed', elapsedMs: 5 },
      { id: 2, status: 'failed', elapsedMs: 7, error: 'sync boom' },
      { id: 3, status: 'failed', elapsedMs: 0, error: 'async boom' },
    ]);
  });

  it('ignores phase array and record changes made after construction', async () => {
    jest.useFakeTimers();
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    const run1 = jest.fn(hang);
    const run2 = jest.fn(hang);
    const replacement = jest.fn();
    const phases: ShutdownPhase[] = [phase(1, 10, run1), phase(2, 20, run2)];
    const sequence = createShutdownSequence({ phases });
    phases[0].id = 7;
    phases[0].deadlineMs = Number.POSITIVE_INFINITY;
    phases[0].run = replacement;
    phases[1] = phase(5, 1, replacement);
    phases.push(phase(6, 1, replacement));
    const result = sequence.run('quit');
    await jest.advanceTimersByTimeAsync(30);
    expect(await result).toEqual({
      reason: 'quit',
      phases: [
        { id: 1, status: 'timed_out', elapsedMs: 10 },
        { id: 2, status: 'timed_out', elapsedMs: 20 },
      ],
    });
    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('ignores changes an earlier phase makes to later phases', async () => {
    jest.useFakeTimers();
    const run2 = jest.fn(() => new Promise<void>(() => undefined));
    const replacement = jest.fn();
    const second = phase(2, 20, run2);
    const phases: ShutdownPhase[] = [
      phase(1, 10, () => {
        second.id = 1;
        second.deadlineMs = 1_000;
        second.run = replacement;
        phases.length = 1;
        phases.push(phase(7, 1, replacement));
      }),
      second,
    ];
    const result = createShutdownSequence({ phases }).run('quit');
    await jest.advanceTimersByTimeAsync(19);
    expect(run2).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({
      reason: 'quit',
      phases: [
        { id: 1, status: 'completed', elapsedMs: 0 },
        { id: 2, status: 'timed_out', elapsedMs: 20 },
      ],
    });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('reports unprintable errors with a fallback and runs later phases', async () => {
    // Hooks may throw any value; `unknown` mirrors what the runner receives.
    const throwing =
      (reason: unknown): ShutdownPhase['run'] =>
      (): void => {
        throw reason;
      };
    const unprintable = throwing(Object.create(null));
    const throwingPrimitive = throwing({
      [Symbol.toPrimitive](): never {
        throw new Error('no primitive');
      },
    });
    const throwingMessage = (): Promise<void> => {
      const error = new Error('hidden');
      Object.defineProperty(error, 'message', {
        get(): never {
          throw new Error('no message');
        },
      });
      return Promise.reject(error);
    };
    const throwingPrototype = throwing(
      new Proxy(
        {},
        {
          getPrototypeOf(): never {
            throw new Error('no prototype');
          },
        },
      ),
    );
    const last = jest.fn();
    const report = await createShutdownSequence({
      now: () => 0,
      phases: [
        phase(1, 50, unprintable),
        phase(2, 50, throwingPrimitive),
        phase(3, 50, throwingMessage),
        phase(4, 50, throwingPrototype),
        phase(5, 50, last),
      ],
    }).run('crash');
    const failed = { status: 'failed', elapsedMs: 0, error: 'Unknown error' };
    expect(report.phases).toEqual([
      { id: 1, ...failed },
      { id: 2, ...failed },
      { id: 3, ...failed },
      { id: 4, ...failed },
      { id: 5, status: 'completed', elapsedMs: 0 },
    ]);
    expect(last).toHaveBeenCalledTimes(1);
  });

  it('runs method-style hooks against a frozen snapshot of their phase', async () => {
    const receivers: unknown[] = [];
    const seen: Array<Pick<ShutdownPhase, 'id' | 'name' | 'deadlineMs'>> = [];
    const second: ShutdownPhase = {
      id: 2,
      name: 'second',
      deadlineMs: 20,
      run(): void {
        receivers.push(this);
        seen.push({
          id: this.id,
          name: this.name,
          deadlineMs: this.deadlineMs,
        });
      },
    };
    const first: ShutdownPhase = {
      id: 1,
      name: 'first',
      deadlineMs: 10,
      run(): void {
        receivers.push(this);
        seen.push({
          id: this.id,
          name: this.name,
          deadlineMs: this.deadlineMs,
        });
        second.id = 7;
        second.name = 'changed-by-phase-1';
        second.deadlineMs = 99;
      },
    };
    const sequence = createShutdownSequence({ phases: [first, second] });
    first.id = 5;
    first.name = 'changed-after-construction';
    first.deadlineMs = 77;
    const report = await sequence.run('quit');
    expect(report.phases.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 1, status: 'completed' },
      { id: 2, status: 'completed' },
    ]);
    expect(seen).toEqual([
      { id: 1, name: 'first', deadlineMs: 10 },
      { id: 2, name: 'second', deadlineMs: 20 },
    ]);
    expect(receivers[0]).not.toBe(first);
    expect(receivers[1]).not.toBe(second);
    expect(receivers.every((receiver) => Object.isFrozen(receiver))).toBe(true);
  });

  it('honors finite deadlines beyond the platform timer maximum', async () => {
    jest.useFakeTimers();
    const maxTimerDelayMs = 2_147_483_647;
    const longDeadlineMs = maxTimerDelayMs * 2 + 10;
    const signals: AbortSignal[] = [];
    const hang = (signal: AbortSignal): Promise<void> => {
      signals.push(signal);
      return new Promise<void>(() => undefined);
    };
    const last = jest.fn();
    const result = createShutdownSequence({
      phases: [
        phase(1, maxTimerDelayMs, hang),
        phase(2, longDeadlineMs, hang),
        phase(3, maxTimerDelayMs + 1, last),
      ],
    }).run('quit');

    await jest.advanceTimersByTimeAsync(maxTimerDelayMs - 1);
    expect(signals[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(1);
    expect(signals[1].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(longDeadlineMs - 2);
    expect(signals[1].aborted).toBe(false);
    expect(last).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(signals[1].aborted).toBe(true);

    expect(await result).toEqual({
      reason: 'quit',
      phases: [
        { id: 1, status: 'timed_out', elapsedMs: maxTimerDelayMs },
        { id: 2, status: 'timed_out', elapsedMs: longDeadlineMs },
        { id: 3, status: 'completed', elapsedMs: 0 },
      ],
    });
    expect(last).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is idempotent and survives a late failure after timeout', async () => {
    jest.useFakeTimers();
    let rejectLate: (error: Error) => void = () => undefined;
    const run = jest.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectLate = reject;
        }),
    );
    const sequence = createShutdownSequence({ phases: [phase(1, 10, run)] });
    const first = sequence.run('a');
    const second = sequence.run('b');
    expect(second).toBe(first);
    await jest.advanceTimersByTimeAsync(10);
    const report = await first;
    expect(report.reason).toBe('a');
    expect(report.phases[0].status).toBe('timed_out');
    rejectLate(new Error('late'));
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
