import {
  waitForAgentReplyTurn,
  type AgentReplyWaitDeps,
  type AgentReplyWaitOptions,
  type AgentReplyWaitResult,
  type CurrentTurn,
  type TurnSettlement,
  type WatchedInput,
} from '../pipelines/agent-reply-wait';

type DepName = 'locate' | 'current' | 'settle';
type Sequence<T> = T | T[];

interface FakeDeps extends AgentReplyWaitDeps {
  emit(): void;
  locateCalls(): number;
  currentCalls(): number;
  settleCalls(): number;
  listenerCount(): number;
  /** Holds the next call to `name` open until the returned release runs. */
  block(name: DepName): () => void;
}

function sequence<T>(values: Sequence<T>): () => T {
  const list = Array.isArray(values) ? [...values] : [values];
  return () => {
    const value = list.length > 1 ? list.shift() : list[0];
    if (value === undefined) throw new Error('empty fake sequence');
    return value;
  };
}

function fakeDeps(
  options: {
    locate?: Sequence<WatchedInput>;
    current?: Sequence<CurrentTurn>;
    settle?: Sequence<TurnSettlement>;
    settleError?: Error;
    log?: string[];
  } = {},
): FakeDeps {
  const listeners = new Set<() => void>();
  const counts: Record<DepName, number> = { locate: 0, current: 0, settle: 0 };
  const gates: Partial<Record<DepName, Promise<void>>> = {};
  const nextLocate = sequence<WatchedInput>(
    options.locate ?? { kind: 'unknown' },
  );
  const nextCurrent = sequence<CurrentTurn>(
    options.current ?? { kind: 'none' },
  );
  const nextSettle = sequence<TurnSettlement>(
    options.settle ?? settled('pending'),
  );
  const pass = async (name: DepName): Promise<void> => {
    counts[name] += 1;
    const gate = gates[name];
    if (gate) {
      delete gates[name];
      await gate;
    }
  };
  return {
    async locateInput(): Promise<WatchedInput> {
      await pass('locate');
      return nextLocate();
    },
    async currentTurn(): Promise<CurrentTurn> {
      await pass('current');
      return nextCurrent();
    },
    async settle(turnId): Promise<TurnSettlement> {
      options.log?.push(`settle:${turnId}`);
      await pass('settle');
      if (options.settleError) throw options.settleError;
      return nextSettle();
    },
    onChange(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (): void => {
      Array.from(listeners).forEach((listener) => listener());
    },
    locateCalls: () => counts.locate,
    currentCalls: () => counts.current,
    settleCalls: () => counts.settle,
    listenerCount: () => listeners.size,
    block(name) {
      let release = (): void => undefined;
      gates[name] = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
  };
}

function settled(
  outcome: TurnSettlement['outcome'],
  endedTurnId = 'turn-1',
  abandoned = false,
): TurnSettlement {
  return { outcome, endedTurnId, abandoned };
}

function wait(
  deps: AgentReplyWaitDeps,
  options: Partial<AgentReplyWaitOptions> = {},
): Promise<AgentReplyWaitResult> {
  return waitForAgentReplyTurn(deps, {
    deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    ...options,
  });
}

async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

/** Fires a change and lets the coalesced evaluation run. */
async function change(deps: FakeDeps): Promise<void> {
  deps.emit();
  await jest.advanceTimersByTimeAsync(250);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('waitForAgentReplyTurn', () => {
  it('message_id whose turn already ended returns at once', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: [settled('completed')],
    });
    await expect(wait(deps, { messageId: 'msg-1' })).resolves.toEqual({
      kind: 'settled',
      turnId: 'turn-1',
      endedTurnId: 'turn-1',
      state: 'completed',
    });
    expect(deps.listenerCount()).toBe(0);
  });

  it('queued message waits for its turn to start and end', async () => {
    const deps = fakeDeps({
      locate: [{ kind: 'pending' }, { kind: 'turn', turnId: 'turn-2' }],
      settle: [settled('pending', 'turn-2'), settled('completed', 'turn-2')],
    });
    const result = wait(deps, { messageId: 'msg-2' });
    await flush();
    await change(deps); // picked up
    await change(deps); // settled
    await expect(result).resolves.toMatchObject({
      kind: 'settled',
      turnId: 'turn-2',
      state: 'completed',
    });
  });

  it('steered message waits for the turn it joined', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'root-turn' },
      settle: [
        settled('pending', 'root-turn'),
        settled('completed', 'root-turn'),
      ],
    });
    const result = wait(deps, { messageId: 'steered' });
    await flush();
    await change(deps);
    await expect(result).resolves.toMatchObject({
      kind: 'settled',
      turnId: 'root-turn',
      endedTurnId: 'root-turn',
    });
    expect(deps.locateCalls()).toBe(1);
  });

  it('no message_id and an idle chat returns the latest settled turn', async () => {
    const deps = fakeDeps({
      current: { kind: 'turn', turnId: 'latest' },
      settle: [settled('completed', 'latest')],
    });
    await expect(wait(deps)).resolves.toMatchObject({ turnId: 'latest' });
    expect(deps.locateCalls()).toBe(0);
  });

  it('no message_id and a running turn waits for that turn', async () => {
    const deps = fakeDeps({
      current: { kind: 'turn', turnId: 'running' },
      settle: [settled('pending', 'running'), settled('failed', 'running')],
    });
    const result = wait(deps);
    await flush();
    await change(deps);
    await expect(result).resolves.toMatchObject({
      turnId: 'running',
      state: 'failed',
    });
  });

  it('no message_id and a pending current turn keeps waiting until it binds', async () => {
    const deps = fakeDeps({
      current: [{ kind: 'pending' }, { kind: 'turn', turnId: 'late' }],
      settle: [settled('pending', 'late'), settled('completed', 'late')],
    });
    const result = wait(deps);
    await flush();
    await change(deps);
    expect(deps.currentCalls()).toBe(2);
    await change(deps);
    await expect(result).resolves.toMatchObject({ turnId: 'late' });
    expect(deps.currentCalls()).toBe(2);
  });

  it('an idle chat with no settled turn returns none', async () => {
    await expect(
      wait(fakeDeps({ current: { kind: 'none' } })),
    ).resolves.toEqual({ kind: 'none' });
  });

  it.each([
    [settled('failed'), 'failed'],
    [settled('cancelled'), 'cancelled'],
    [settled('cancelled', 'turn-1', true), 'interrupted'],
  ])('reports the turn outcome %j as %s', async (settlement, state) => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: settlement,
    });
    await expect(wait(deps, { messageId: 'm' })).resolves.toMatchObject({
      state,
    });
  });

  it('follows a resume chain and reports the turn that ended', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'interrupted-turn' },
      settle: [settled('completed', 'resume-turn')],
    });
    await expect(wait(deps, { messageId: 'm' })).resolves.toMatchObject({
      turnId: 'interrupted-turn',
      endedTurnId: 'resume-turn',
    });
  });

  it('keeps waiting while an interrupted turn awaits a resume', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: settled('pending'),
    });
    const result = wait(deps, {
      messageId: 'm',
      deadlineAt: Date.now() + 5_000,
    });
    await flush();
    await change(deps);
    await change(deps);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({
      kind: 'timed_out',
      turnId: 'turn-1',
    });
  });

  it('times out with the bound turn id', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: [settled('pending')],
    });
    const result = wait(deps, {
      messageId: 'm',
      deadlineAt: Date.now() + 1_000,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({
      kind: 'timed_out',
      turnId: 'turn-1',
    });
    expect(deps.listenerCount()).toBe(0);
  });

  it('times out without a turn id when the message never binds', async () => {
    const deps = fakeDeps({ locate: { kind: 'pending' } });
    const onPinned = jest.fn(() => Promise.resolve());
    const result = wait(deps, {
      messageId: 'm',
      deadlineAt: Date.now() + 1_000,
      onPinned,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ kind: 'timed_out' });
    expect(onPinned).not.toHaveBeenCalled();
  });

  it('times out at once when the deadline has already passed', async () => {
    const deps = fakeDeps({ locate: { kind: 'turn', turnId: 'turn-1' } });
    await expect(
      wait(deps, { messageId: 'm', deadlineAt: Date.now() - 1 }),
    ).resolves.toEqual({ kind: 'timed_out' });
    expect(deps.settleCalls()).toBe(0);
    expect(deps.locateCalls()).toBe(0);
  });

  it('ignores a settle result that lands after the deadline fired', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: settled('completed'),
    });
    const release = deps.block('settle');
    const result = wait(deps, {
      messageId: 'm',
      deadlineAt: Date.now() + 1_000,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    release();
    await flush();
    await expect(result).resolves.toEqual({
      kind: 'timed_out',
      turnId: 'turn-1',
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(deps.settleCalls()).toBe(1);
  });

  it('rejects with the abort reason when the run is cancelled and unsubscribes', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: settled('pending'),
    });
    const controller = new AbortController();
    const result = wait(deps, { messageId: 'm', signal: controller.signal });
    await flush();
    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(deps.listenerCount()).toBe(0);
    const calls = deps.settleCalls();
    deps.emit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(deps.settleCalls()).toBe(calls);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const deps = fakeDeps({ locate: { kind: 'turn', turnId: 'turn-1' } });
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(
      wait(deps, { messageId: 'm', signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(deps.locateCalls()).toBe(0);
    expect(deps.listenerCount()).toBe(0);
  });

  it('does not pin when the abort lands while locating', async () => {
    const deps = fakeDeps({ locate: { kind: 'turn', turnId: 'turn-1' } });
    const release = deps.block('locate');
    const controller = new AbortController();
    const onPinned = jest.fn(() => Promise.resolve());
    const result = wait(deps, {
      messageId: 'm',
      signal: controller.signal,
      onPinned,
    });
    await flush();
    controller.abort(new Error('stopped'));
    release();
    await expect(result).rejects.toThrow('stopped');
    await flush();
    expect(onPinned).not.toHaveBeenCalled();
    expect(deps.settleCalls()).toBe(0);
  });

  it('rejects with a dep error and unsubscribes', async () => {
    const error = new Error('state unavailable');
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settleError: error,
    });
    await expect(wait(deps, { messageId: 'm' })).rejects.toBe(error);
    expect(deps.listenerCount()).toBe(0);
  });

  it('coalesces a burst of commits into a bounded number of settle reads', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 't' },
      settle: [settled('pending')],
    });
    void wait(deps, { messageId: 'm' });
    await flush();
    for (let index = 0; index < 500; index += 1) deps.emit();
    await jest.advanceTimersByTimeAsync(250);
    expect(deps.settleCalls()).toBeLessThanOrEqual(3);
  });

  it('re-evaluates once more when a change lands during an evaluation', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 't' },
      settle: settled('pending'),
    });
    const release = deps.block('settle');
    void wait(deps, { messageId: 'm' });
    await flush();
    await change(deps);
    await change(deps);
    expect(deps.settleCalls()).toBe(1);
    release();
    await flush();
    expect(deps.settleCalls()).toBe(2);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(deps.settleCalls()).toBe(2);
  });

  it('uses a pinned turn without re-resolving the message', async () => {
    const deps = fakeDeps({ settle: [settled('completed', 'pinned')] });
    const onPinned = jest.fn(() => Promise.resolve());
    await expect(
      wait(deps, { messageId: 'm', pinnedTurnId: 'pinned', onPinned }),
    ).resolves.toMatchObject({ turnId: 'pinned' });
    expect(deps.locateCalls()).toBe(0);
    expect(onPinned).not.toHaveBeenCalled();
  });

  it('pins the turn once it binds', async () => {
    const log: string[] = [];
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: [settled('pending'), settled('pending'), settled('completed')],
      log,
    });
    const onPinned = jest.fn((turnId: string) => {
      log.push(`pin:${turnId}`);
      return Promise.resolve();
    });
    const result = wait(deps, { messageId: 'm', onPinned });
    await flush();
    await change(deps);
    await change(deps);
    await expect(result).resolves.toMatchObject({ state: 'completed' });
    expect(onPinned).toHaveBeenCalledTimes(1);
    expect(log[0]).toBe('pin:turn-1');
    expect(log[1]).toBe('settle:turn-1');
  });

  it('rejects when onPinned rejects', async () => {
    const deps = fakeDeps({ locate: { kind: 'turn', turnId: 'turn-1' } });
    const error = new Error('disk full');
    await expect(
      wait(deps, { messageId: 'm', onPinned: () => Promise.reject(error) }),
    ).rejects.toBe(error);
    expect(deps.settleCalls()).toBe(0);
  });

  it('reports an unknown message_id', async () => {
    await expect(
      wait(fakeDeps({ locate: { kind: 'unknown' } }), { messageId: 'nope' }),
    ).resolves.toEqual({ kind: 'unknown_message' });
  });

  it('reports a message that never ran', async () => {
    await expect(
      wait(fakeDeps({ locate: { kind: 'never_ran' } }), { messageId: 'm' }),
    ).resolves.toEqual({ kind: 'never_ran' });
  });

  it('rechecks without a change event', async () => {
    const deps = fakeDeps({
      locate: { kind: 'turn', turnId: 'turn-1' },
      settle: settled('pending'),
    });
    void wait(deps, { messageId: 'm' });
    await flush();
    expect(deps.settleCalls()).toBe(1);
    await jest.advanceTimersByTimeAsync(30_250);
    expect(deps.settleCalls()).toBe(2);
  });

  it('leaves no abort listener behind when subscribing throws', async () => {
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const deps: AgentReplyWaitDeps = {
      ...fakeDeps(),
      onChange: () => {
        throw new Error('subscribe failed');
      },
    };
    await expect(wait(deps, { signal: controller.signal })).rejects.toThrow(
      'subscribe failed',
    );
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });
});
