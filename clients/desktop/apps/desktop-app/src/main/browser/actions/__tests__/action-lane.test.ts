import {
  ActionLane,
  ActionLanePreDispatchError,
  ActionLaneDispatchTimeoutError,
  ActionLaneRegistry,
} from '../action-lane';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = (): void => {};
  let reject: (error: Error) => void = (): void => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('ActionLane', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs input in FIFO order with sequences while reads bypass a blocked lane', async () => {
    const gate = deferred<void>();
    const events: string[] = [];
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 3,
      isCurrent: (): boolean => true,
    });
    const first = lane.run(async ({ sequence, beginDispatch }) => {
      events.push(`first:${sequence}`);
      beginDispatch();
      expect(lane.currentAction()).toBe(1);
      await gate.promise;
      return 'one';
    });
    const second = lane.run(({ sequence, beginDispatch }) => {
      events.push(`second:${sequence}`);
      beginDispatch();
      return 'two';
    });
    await Promise.resolve();
    expect(events).toEqual(['first:1']);
    expect(await lane.runRead(() => 'read')).toBe('read');
    expect(events).toEqual(['first:1']);
    gate.resolve();
    expect(await first).toEqual({
      status: 'executed',
      sequence: 1,
      value: 'one',
    });
    expect(await second).toEqual({
      status: 'executed',
      sequence: 2,
      value: 'two',
    });
    expect(events).toEqual(['first:1', 'second:2']);
    expect(lane.currentAction()).toBeNull();
  });

  test('shares its sequence counter with independent reads without queueing them', async () => {
    const gate = deferred<void>();
    const events: number[] = [];
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 3,
      isCurrent: (): boolean => true,
    });
    const blocked = lane.run(async ({ sequence, beginDispatch }) => {
      events.push(sequence);
      beginDispatch();
      await gate.promise;
    });
    await Promise.resolve();
    expect(lane.reserveSequence()).toBe(2);
    const queued = lane.run(({ sequence }) => {
      events.push(sequence);
    });
    expect(events).toEqual([1]);
    gate.resolve();
    await blocked;
    await queued;
    expect(events).toEqual([1, 3]);
  });

  test('cancels a queued action without running it', async () => {
    const gate = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const first = lane.run(async () => {
      await gate.promise;
    });
    const abort = new AbortController();
    const action = jest.fn();
    const queued = lane.run(action, { signal: abort.signal });
    abort.abort();
    expect(await queued).toMatchObject({
      status: 'not_executed',
      reason: 'cancelled',
      code: 'cancelled',
      sequence: 2,
    });
    gate.resolve();
    await first;
    expect(action).not.toHaveBeenCalled();
  });

  test('fences stale runtimes at dequeue and immediately before dispatch', async () => {
    let current = true;
    const gate = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => current,
    });
    const first = lane.run(async () => {
      await gate.promise;
    });
    const queued = lane.run(({ beginDispatch }) => {
      beginDispatch();
    });
    current = false;
    gate.resolve();
    await first;
    expect(await queued).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });

    current = true;
    const beforeBoundary = lane.run(({ beginDispatch }) => {
      current = false;
      beginDispatch();
    });
    expect(await beforeBoundary).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
  });

  test('beginDispatch throws a typed rejection if cancelled before input', async () => {
    const abort = new AbortController();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = lane.run(
      ({ beginDispatch }) => {
        abort.abort();
        expect(() => beginDispatch()).toThrow(ActionLanePreDispatchError);
      },
      { signal: abort.signal },
    );
    expect(await result).toMatchObject({
      status: 'not_executed',
      reason: 'cancelled',
    });
  });

  test('typed dispatch timeout before the boundary remains non-execution', async () => {
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = await lane.run(() => {
      throw new ActionLaneDispatchTimeoutError('input timeout');
    });
    expect(result).toMatchObject({
      status: 'not_executed',
      reason: 'execution_failed',
      code: 'execution_failed',
      message: 'input timeout',
    });
  });

  test('a lane timeout before dispatch is retryable as timeout, not execution_failed', async () => {
    const body = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = lane.run(() => body.promise, { timeoutMs: 25 });
    await jest.advanceTimersByTimeAsync(25);
    expect(await result).toMatchObject({
      status: 'not_executed',
      reason: 'timeout',
      code: 'timeout',
    });
    body.resolve();
  });

  test('typed dispatch timeout after the boundary drains, quarantines and recovers', async () => {
    const command = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
      drainTimeoutMs: 100,
    });
    const cleanup = jest.fn();
    let actionSignal: AbortSignal | undefined;
    const first = lane.run(
      ({ beginDispatch, trackCommand, registerCleanup, signal }) => {
        actionSignal = signal;
        beginDispatch();
        void trackCommand(command.promise);
        registerCleanup(cleanup);
        throw new ActionLaneDispatchTimeoutError('input timeout');
      },
    );
    expect(await first).toMatchObject({
      status: 'outcome_unknown',
      reason: 'dispatch_timeout',
      detail: 'input timeout',
    });
    expect(actionSignal?.aborted).toBe(true);
    const next = jest.fn(({ beginDispatch }: { beginDispatch: () => void }) => {
      beginDispatch();
      return 2;
    });
    const second = lane.run(next);
    await jest.advanceTimersByTimeAsync(99);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({
      status: 'not_executed',
      reason: 'quarantined',
    });
    command.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(await lane.run(next)).toMatchObject({
      status: 'executed',
      value: 2,
    });
  });

  test('post-boundary abort, timeout, and runtime loss are unknown outcomes', async () => {
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const abort = new AbortController();
    const pending = deferred<void>();
    const aborted = lane.run(
      async ({ beginDispatch, signal }) => {
        beginDispatch();
        expect(signal.aborted).toBe(false);
        await pending.promise;
      },
      { signal: abort.signal },
    );
    await Promise.resolve();
    abort.abort();
    expect(await aborted).toMatchObject({
      status: 'outcome_unknown',
      reason: 'stopped_after_dispatch',
    });
    pending.resolve();
    await Promise.resolve();

    const timed = lane.run(
      async ({ beginDispatch }) => {
        beginDispatch();
        await new Promise<void>(() => {});
      },
      { timeoutMs: 50 },
    );
    await jest.advanceTimersByTimeAsync(50);
    expect(await timed).toMatchObject({
      status: 'outcome_unknown',
      reason: 'dispatch_timeout',
    });

    let current = true;
    const runtimeLane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => current,
    });
    const runtimeGate = deferred<void>();
    const lost = runtimeLane.run(async ({ beginDispatch }) => {
      beginDispatch();
      await runtimeGate.promise;
    });
    await Promise.resolve();
    current = false;
    runtimeGate.resolve();
    expect(await lost).toMatchObject({
      status: 'outcome_unknown',
      reason: 'runtime_lost',
    });
  });

  test('waits for a timed-out action body even without tracked commands', async () => {
    const bodyGate = deferred<void>();
    const events: string[] = [];
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
      drainTimeoutMs: 100,
    });
    const first = lane.run(
      async ({ beginDispatch }) => {
        beginDispatch();
        await bodyGate.promise;
        events.push('body returned');
      },
      { timeoutMs: 20 },
    );
    const second = lane.run(({ beginDispatch }) => {
      beginDispatch();
      events.push('second started');
    });
    await jest.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({
      status: 'outcome_unknown',
      reason: 'dispatch_timeout',
    });
    expect(events).toEqual([]);
    bodyGate.resolve();
    expect(await second).toMatchObject({ status: 'executed' });
    expect(events).toEqual(['body returned', 'second started']);
  });

  test('quarantines for a stuck action body and recovers when it returns', async () => {
    const bodyGate = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
      drainTimeoutMs: 40,
    });
    const first = lane.run(
      async ({ beginDispatch }) => {
        beginDispatch();
        await bodyGate.promise;
      },
      { timeoutMs: 20 },
    );
    await jest.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ status: 'outcome_unknown' });
    await jest.advanceTimersByTimeAsync(40);
    expect(await lane.run(() => 1)).toMatchObject({
      status: 'not_executed',
      reason: 'quarantined',
    });
    bodyGate.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(
      await lane.run(({ beginDispatch }) => {
        beginDispatch();
        return 2;
      }),
    ).toMatchObject({ status: 'executed', value: 2 });
  });

  test('runs cleanups before waiting for late commands, then admits the next action', async () => {
    const command = deferred<void>();
    const events: string[] = [];
    const abort = new AbortController();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const first = lane.run(
      async ({ beginDispatch, trackCommand, registerCleanup }) => {
        beginDispatch();
        void trackCommand(command.promise);
        registerCleanup(() => {
          events.push('cleanup');
        });
        await command.promise;
      },
      { signal: abort.signal },
    );
    const second = lane.run(() => {
      events.push('second');
    });
    await Promise.resolve();
    abort.abort();
    expect(await first).toMatchObject({ status: 'outcome_unknown' });
    await Promise.resolve();
    expect(events).toEqual(['cleanup']);
    command.resolve();
    await second;
    expect(events).toEqual(['cleanup', 'second']);
  });

  test('quarantines after bounded drain and reopens when commands settle', async () => {
    const command = deferred<void>();
    const abort = new AbortController();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
      drainTimeoutMs: 100,
    });
    const first = lane.run(
      async ({ beginDispatch, trackCommand }) => {
        beginDispatch();
        void trackCommand(command.promise);
        await command.promise;
      },
      { signal: abort.signal },
    );
    await Promise.resolve();
    abort.abort();
    expect(await first).toMatchObject({ status: 'outcome_unknown' });
    await jest.advanceTimersByTimeAsync(100);
    expect(await lane.run(() => 1)).toMatchObject({
      status: 'not_executed',
      reason: 'quarantined',
      code: 'execution_failed',
      message: 'Browser input is recovering. Try again shortly.',
    });
    expect(await lane.runRead(() => 7)).toBe(7);
    command.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(
      await lane.run(({ beginDispatch }) => {
        beginDispatch();
        return 2;
      }),
    ).toMatchObject({ status: 'executed', value: 2 });
  });

  test('throws after dispatch without wedging on a throwing cleanup', async () => {
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const failed = lane.run(({ beginDispatch, registerCleanup }) => {
      beginDispatch();
      registerCleanup(() => {
        throw new Error('cleanup failed');
      });
      throw new Error('dispatch failed');
    });
    expect(await failed).toMatchObject({
      status: 'outcome_unknown',
      reason: 'stopped_after_dispatch',
      detail: 'dispatch failed',
    });
    expect(
      await lane.run(({ beginDispatch }) => {
        beginDispatch();
        return 9;
      }),
    ).toMatchObject({ status: 'executed', value: 9 });
  });

  test('dispose refuses queued actions and late completion cannot resurrect the lane', async () => {
    const command = deferred<void>();
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const first = lane.run(async ({ beginDispatch, trackCommand }) => {
      beginDispatch();
      await trackCommand(command.promise);
    });
    const queued = lane.run(() => 'queued');
    await Promise.resolve();
    lane.dispose();
    expect(await first).toMatchObject({
      status: 'outcome_unknown',
      reason: 'runtime_lost',
    });
    expect(await queued).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
    command.resolve();
    await Promise.resolve();
    expect(await lane.run(() => 'late')).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
  });

  test('runs registered cleanup on successful and pre-dispatch exits', async () => {
    const cleaned: string[] = [];
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const success = await lane.run(({ beginDispatch, registerCleanup }) => {
      registerCleanup(() => {
        cleaned.push('success');
      });
      beginDispatch();
      return 1;
    });
    expect(success.status).toBe('executed');
    const failure = await lane.run(({ registerCleanup }) => {
      registerCleanup(() => {
        cleaned.push('failure');
      });
      throw new Error('preparation failed');
    });
    expect(failure).toMatchObject({
      status: 'not_executed',
      reason: 'execution_failed',
      message: 'preparation failed',
    });
    expect(cleaned).toEqual(['success', 'failure']);
  });

  test('replacement fences an active dispatch and ignores its late completion', async () => {
    const command = deferred<void>();
    const key = {};
    const registry = new ActionLaneRegistry();
    const original = registry.laneFor(key, 1, () => true);
    const running = original.run(async ({ beginDispatch, trackCommand }) => {
      beginDispatch();
      await trackCommand(command.promise);
    });
    await Promise.resolve();
    const replacement = registry.laneFor(key, 2, () => true);
    expect(await running).toMatchObject({
      status: 'outcome_unknown',
      reason: 'runtime_lost',
    });
    command.resolve();
    await Promise.resolve();
    expect(await original.run(() => 1)).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
    expect(
      await replacement.run(({ beginDispatch }) => {
        beginDispatch();
        return 2;
      }),
    ).toMatchObject({ status: 'executed', value: 2 });
  });

  test('registry reuses a generation, replaces stale lanes, and disposes explicitly', async () => {
    const key = {};
    const registry = new ActionLaneRegistry();
    const isCurrent = (): boolean => true;
    const original = registry.laneFor(key, 1, isCurrent);
    expect(registry.laneFor(key, 1, isCurrent)).toBe(original);
    const replacement = registry.laneFor(key, 2, isCurrent);
    expect(replacement).not.toBe(original);
    expect(await original.run(() => 1)).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
    registry.disposeFor(key);
    expect(await replacement.run(() => 1)).toMatchObject({
      status: 'not_executed',
      reason: 'runtime_lost',
    });
  });

  test('registry starts a fresh sequence source for a replacement generation', async () => {
    const key = {};
    const registry = new ActionLaneRegistry();
    const first = registry.laneFor(key, 1, (): boolean => true);
    expect(await first.run(() => 'first')).toMatchObject({ sequence: 1 });
    expect(first.reserveSequence()).toBe(2);
    const replacement = registry.laneFor(key, 2, (): boolean => true);
    expect(await replacement.run(() => 'replacement')).toMatchObject({
      sequence: 1,
    });
  });
});
