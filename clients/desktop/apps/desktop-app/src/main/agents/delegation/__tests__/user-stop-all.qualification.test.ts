import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import {
  joinStopAll,
  stopAllUnderFence,
  type StopAllBroker,
  type StopAllChat,
} from '../user-stop-all';

const parent: DelegationParentContext = {
  harnessId: 'harness',
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  sessionKey: 'session',
  turnId: 'turn',
  toolCallId: 'tool',
  runtimeGeneration: 1,
  depth: 0,
};

function snapshot(
  delegationId: string,
  overrides: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot {
  return {
    delegationId,
    status: 'running',
    runGeneration: 1,
    ...overrides,
  } as AgentDelegationSnapshot;
}

/** A broker whose stops end the delegation and its subtree, after `gate` opens. */
function fakeBroker(
  initial: AgentDelegationSnapshot[],
  gate: Promise<void> = Promise.resolve(),
): StopAllBroker & { stops: string[] } {
  const records = new Map(initial.map((s) => [s.delegationId, s]));
  const stops: string[] = [];
  const end = (id: string): void => {
    const record = records.get(id);
    if (record) records.set(id, { ...record, status: 'cancelled' });
    for (const child of Array.from(records.values()))
      if (child.parentDelegationId === id) end(child.delegationId);
  };
  return {
    stops,
    list: () => Array.from(records.values()),
    stop: async (_parent, id) => {
      stops.push(id);
      await gate;
      end(id);
      return { ok: true, value: snapshot(id, { status: 'cancelled' }) };
    },
    activeCount: () => 0,
    queuedCount: () => 0,
  };
}

function chat(): StopAllChat & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    holdStopAllFence: () => {
      events.push('fence');
      return () => events.push('release');
    },
    fenceNotices: () => {
      events.push('notices');
      return Promise.resolve();
    },
    nextActivity: () => Promise.resolve(),
    retireWatchers: () => {
      events.push('watchers');
      return Promise.resolve();
    },
  };
}

describe('user stop-all (CAN-6000)', () => {
  it('stops each live subtree once under the fence and reports every delegation it stopped', async () => {
    const broker = fakeBroker([
      snapshot('a'),
      snapshot('a-child', { parentDelegationId: 'a' }),
      snapshot('b', { status: 'pending' }),
      snapshot('done', { status: 'completed' }),
    ]);
    const c = chat();

    const result = await stopAllUnderFence({ broker, parent, chat: c });

    expect(result).toEqual({
      ok: true,
      value: { stopped: 3, delegationIds: ['a', 'a-child', 'b'] },
    });
    expect(broker.stops.sort()).toEqual(['a', 'b']);
    expect(c.events).toEqual([
      'fence',
      'notices',
      'watchers',
      'watchers',
      'release',
    ]);
  });

  it('stopRoot stops each subtree top, and may fall back to the broker stop', async () => {
    const broker = fakeBroker([
      snapshot('live'),
      snapshot('queued', { status: 'pending', runGeneration: undefined }),
    ]);
    const viaRoot: string[] = [];

    const result = await stopAllUnderFence({
      broker,
      parent,
      chat: chat(),
      stopRoot: (top, brokerStop) => {
        viaRoot.push(top.delegationId);
        return brokerStop();
      },
    });

    expect(result.ok).toBe(true);
    expect(viaRoot.sort()).toEqual(['live', 'queued']);
    expect(broker.stops.sort()).toEqual(['live', 'queued']);
  });

  it('a refused root stop fails the stop-all and still releases the fence', async () => {
    const c = chat();
    const refusal: AgentDelegationResult<never> = {
      ok: false,
      error: { code: 'invalid_request', message: 'No.', retryable: false },
    };

    const result = await stopAllUnderFence({
      broker: fakeBroker([snapshot('a')]),
      parent,
      chat: c,
      stopRoot: () => Promise.resolve(refusal),
    });

    expect(result).toEqual(refusal);
    expect(c.events.at(-1)).toBe('release');
  });

  it('a second stop-all during the first changes nothing and reports the same set', async () => {
    let open: () => void = () => undefined;
    const broker = fakeBroker(
      [snapshot('a'), snapshot('b')],
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const starts: string[] = [];
    const start = (): ReturnType<typeof stopAllUnderFence> => {
      starts.push('start');
      return stopAllUnderFence({ broker, parent, chat: chat() });
    };

    const first = joinStopAll('chat-key', start);
    const second = joinStopAll('chat-key', start);
    open();
    const [a, b] = await Promise.all([first, second]);

    expect(b).toEqual(a);
    expect(a).toEqual({
      ok: true,
      value: { stopped: 2, delegationIds: ['a', 'b'] },
    });
    expect(starts).toHaveLength(1);
    expect(broker.stops.sort()).toEqual(['a', 'b']);

    // Once it settles, the next stop-all runs on its own and finds nothing live.
    await expect(joinStopAll('chat-key', start)).resolves.toEqual({
      ok: true,
      value: { stopped: 0, delegationIds: [] },
    });
    expect(starts).toHaveLength(2);
  });

  it('stop-alls for different chats do not join', async () => {
    let starts = 0;
    const start = (): ReturnType<typeof stopAllUnderFence> => {
      starts += 1;
      return stopAllUnderFence({
        broker: fakeBroker([snapshot('a')]),
        parent,
        chat: chat(),
      });
    };

    await Promise.all([
      joinStopAll('chat-1', start),
      joinStopAll('chat-2', start),
    ]);

    expect(starts).toBe(2);
  });
});
