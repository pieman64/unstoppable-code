import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { waitForDelegations } from '../wait';
import { projectAgentRoute } from '../route';
import { routeFixture } from './fixtures';

describe('bounded managed wait', () => {
  let snapshots: Map<string, AgentDelegationSnapshot>;
  let listeners: Set<() => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    listeners = new Set();
    snapshots = new Map(
      ['a', 'b'].map((delegationId) => [
        delegationId,
        {
          delegationId,
          status: 'running',
          routeSnapshot: projectAgentRoute(routeFixture()),
          outputTruncated: false,
        },
      ]),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('settles even when a source cleanup callback throws', async () => {
    const waiting = waitForDelegations(
      { delegationIds: ['a'], timeoutMs: 0 },
      {
        getSnapshot: (id) => snapshots.get(id),
        subscribe: (): (() => void) => (): void => {
          throw new Error('cleanup failed');
        },
      },
    );
    expect(await waiting).toMatchObject({
      ok: true,
      value: { timedOut: true },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  function source(): Parameters<typeof waitForDelegations>[1] {
    return {
      getSnapshot: (id) => snapshots.get(id),
      subscribe: (listener) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    };
  }

  it('returns on the first completed child and releases subscriptions', async () => {
    const waiting = waitForDelegations(
      { delegationIds: ['a', 'b'], timeoutMs: 1_000 },
      source(),
    );
    const current = snapshots.get('b');
    if (!current) throw new Error('Missing child fixture');
    snapshots.set('b', {
      ...current,
      status: 'completed',
      finalText: 'Result',
    });
    for (const listener of Array.from(listeners)) listener();
    expect(await waiting).toMatchObject({
      ok: true,
      value: {
        timedOut: false,
        snapshots: [
          expect.objectContaining({ status: 'running' }),
          expect.objectContaining({ status: 'completed', finalText: 'Result' }),
        ],
      },
    });
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns immediately when a child becomes interrupted', async () => {
    const waiting = waitForDelegations(
      { delegationIds: ['a'], timeoutMs: 60_000 },
      source(),
    );
    const current = snapshots.get('a');
    if (!current) throw new Error('Missing child fixture');
    snapshots.set('a', {
      ...current,
      status: 'interrupted',
      error: {
        code: 'launch_uncertain',
        message: 'Child execution could not be confirmed.',
        retryable: false,
      },
    });
    for (const listener of Array.from(listeners)) listener();

    expect(await waiting).toMatchObject({
      ok: true,
      value: {
        timedOut: false,
        snapshots: [expect.objectContaining({ status: 'interrupted' })],
      },
    });
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out without modifying child state or consuming its result', async () => {
    const before = snapshots.get('a');
    const waiting = waitForDelegations(
      { delegationIds: ['a'], timeoutMs: 50 },
      source(),
    );
    await jest.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({
      ok: true,
      value: {
        timedOut: true,
        snapshots: [expect.objectContaining({ status: 'running' })],
      },
    });
    expect(snapshots.get('a')).toBe(before);
    expect(listeners.size).toBe(0);
  });

  it('aborts only the waiting caller and rejects unavailable child ids', async () => {
    const controller = new AbortController();
    const waiting = waitForDelegations(
      { delegationIds: ['a'], timeoutMs: 50 },
      source(),
      controller.signal,
    );
    controller.abort();
    expect(await waiting).toMatchObject({
      ok: false,
      error: { code: 'parent_unavailable' },
    });
    expect(snapshots.get('a')?.status).toBe('running');
    expect(listeners.size).toBe(0);
    expect(
      await waitForDelegations(
        { delegationIds: ['foreign'], timeoutMs: 0 },
        source(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('does not leak when subscription immediately reports a completion', async () => {
    const unsubscribe = jest.fn();
    const current = snapshots.get('a');
    if (!current) throw new Error('Missing child fixture');
    snapshots.set('a', { ...current, status: 'completed' });
    await waitForDelegations(
      { delegationIds: ['a'], timeoutMs: 50 },
      {
        ...source(),
        subscribe: (listener) => {
          listener();
          return unsubscribe;
        },
      },
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
