import { createFastDiffStatsQueue } from '../projectsStore.fastDiffStatsQueue';

/** A refresh stub whose promises are resolved manually, in order. */
function deferredRefresh(): {
  refresh: (projectId: string, worktreeId: string) => Promise<void>;
  calls: Array<{ projectId: string; worktreeId: string }>;
  resolveNext: () => void;
} {
  const calls: Array<{ projectId: string; worktreeId: string }> = [];
  const resolvers: Array<() => void> = [];
  return {
    calls,
    refresh: (projectId, worktreeId): Promise<void> => {
      calls.push({ projectId, worktreeId });
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    resolveNext: (): void => {
      const next = resolvers.shift();
      if (next) next();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('createFastDiffStatsQueue', () => {
  it('refreshes an enqueued worktree', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    const queue = createFastDiffStatsQueue({ refresh, now: () => 0 });

    queue.enqueue('p', 'w');
    await flush();

    expect(calls).toEqual([{ projectId: 'p', worktreeId: 'w' }]);
    resolveNext();
    await flush();
  });

  it('dedupes and moves an already-queued worktree to the front', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    let clock = 0;
    const queue = createFastDiffStatsQueue({
      refresh,
      now: () => clock,
      skipIfFreshMs: 0,
    });

    queue.enqueue('a', '1');
    await flush();
    expect(calls).toEqual([{ projectId: 'a', worktreeId: '1' }]);

    queue.enqueue('b', '2');
    queue.enqueue('c', '3');
    queue.enqueue('b', '2');

    clock = 1;
    resolveNext();
    await flush();
    resolveNext();
    await flush();
    resolveNext();
    await flush();

    const order = calls.map((c) => `${c.projectId}/${c.worktreeId}`);
    expect(order).toEqual(['a/1', 'b/2', 'c/3']);
  });

  it('never runs two refreshes concurrently (single-flight)', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    const queue = createFastDiffStatsQueue({
      refresh,
      now: () => 0,
      skipIfFreshMs: 0,
    });

    queue.enqueue('a', '1');
    queue.enqueue('b', '2');
    await flush();

    expect(calls).toEqual([{ projectId: 'a', worktreeId: '1' }]);

    resolveNext();
    await flush();
    expect(calls).toEqual([
      { projectId: 'a', worktreeId: '1' },
      { projectId: 'b', worktreeId: '2' },
    ]);
    resolveNext();
    await flush();
  });

  it('skips a re-enqueue within the skip-if-fresh window', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    let clock = 1000;
    const queue = createFastDiffStatsQueue({
      refresh,
      now: () => clock,
      skipIfFreshMs: 1000,
    });

    queue.enqueue('a', '1');
    await flush();
    resolveNext();
    await flush();
    expect(calls).toHaveLength(1);

    clock = 1500;
    queue.enqueue('a', '1');
    await flush();
    expect(calls).toHaveLength(1);

    clock = 2600;
    queue.enqueue('a', '1');
    await flush();
    expect(calls).toHaveLength(2);
    resolveNext();
    await flush();
  });

  it('refreshes a new mutation even within the skip-if-fresh window', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    let clock = 1000;
    const queue = createFastDiffStatsQueue({
      refresh,
      now: () => clock,
      skipIfFreshMs: 1000,
    });

    queue.enqueue('a', '1');
    await flush();
    resolveNext();
    await flush();
    expect(calls).toHaveLength(1);

    clock = 1500;
    queue.enqueue('a', '1', { bypassFreshness: true });
    await flush();

    expect(calls).toHaveLength(2);
    resolveNext();
    await flush();
  });

  it('preserves a queued mutation bypass when a normal refresh dedupes it', async () => {
    const { refresh, calls, resolveNext } = deferredRefresh();
    let clock = 1000;
    const queue = createFastDiffStatsQueue({
      refresh,
      now: () => clock,
      skipIfFreshMs: 1000,
    });

    queue.enqueue('a', '1');
    await flush();
    resolveNext();
    await flush();

    clock = 1500;
    queue.enqueue('blocker', '1');
    await flush();
    queue.enqueue('a', '1', { bypassFreshness: true });
    queue.enqueue('a', '1');

    resolveNext();
    await flush();

    expect(calls).toEqual([
      { projectId: 'a', worktreeId: '1' },
      { projectId: 'blocker', worktreeId: '1' },
      { projectId: 'a', worktreeId: '1' },
    ]);
    resolveNext();
    await flush();
  });

  it('does not stall the queue when a refresh rejects', async () => {
    const calls: string[] = [];
    const queue = createFastDiffStatsQueue({
      refresh: (p, w): Promise<void> => {
        calls.push(`${p}/${w}`);
        return p === 'bad'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve();
      },
      now: () => 0,
      skipIfFreshMs: 0,
    });

    queue.enqueue('bad', '1');
    queue.enqueue('good', '2');
    await flush();

    expect(calls).toEqual(['bad/1', 'good/2']);
  });

  it('does not mark failed refreshes as fresh', async () => {
    const calls: string[] = [];
    let shouldReject = true;
    const queue = createFastDiffStatsQueue({
      refresh: (p, w): Promise<void> => {
        calls.push(`${p}/${w}`);
        if (shouldReject) {
          shouldReject = false;
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve();
      },
      now: () => 1000,
      skipIfFreshMs: 1000,
    });

    queue.enqueue('p', 'w');
    await flush();
    queue.enqueue('p', 'w');
    await flush();

    expect(calls).toEqual(['p/w', 'p/w']);
  });
});
