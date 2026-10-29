import {
  ResumeQueueService,
  type ResumeQueueDependencies,
} from '../services/resume-queue-service';
import type {
  ResumeQueueSnapshot,
  ResumeQueueEntry,
  ResumeQueueItem,
} from '@canopy/desktop-shared/types';

const item = (chatId: string): ResumeQueueItem => ({
  target: {
    kind: 'chat' as const,
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
  },
  title: chatId,
  workspaceName: 'Project',
  interruptionId: '1',
});

interface Fixture {
  service: ResumeQueueService;
  dependencies: ResumeQueueDependencies;
  dispatch: jest.Mock<Promise<'resumed' | 'skipped'>, [ResumeQueueEntry]>;
  persist: jest.Mock<Promise<void>, [ResumeQueueSnapshot]>;
  disk: () => ResumeQueueSnapshot | undefined;
  advance: (milliseconds?: number) => void;
}
function fixture(saved?: ResumeQueueSnapshot): Fixture {
  let disk = saved;
  let now = 10000;
  const dispatch = jest
    .fn<Promise<'resumed' | 'skipped'>, [ResumeQueueEntry]>()
    .mockResolvedValue('resumed');
  const persist = jest.fn((snapshot: ResumeQueueSnapshot): Promise<void> => {
    disk = structuredClone(snapshot);
    return Promise.resolve();
  });
  const dependencies: ResumeQueueDependencies = {
    load: (): Promise<ResumeQueueSnapshot | null> =>
      Promise.resolve(disk ?? null),
    save: persist,
    dispatch,
    reconcile: () => Promise.resolve({ status: 'waiting' }),
    now: () => now,
    changed: jest.fn(),
  };
  const service = new ResumeQueueService(dependencies);
  return {
    service,
    dependencies,
    dispatch,
    persist,
    disk: (): ResumeQueueSnapshot | undefined => disk,
    advance: (milliseconds = 10000): void => {
      now += milliseconds;
    },
  };
}

describe('persistent resume queue', () => {
  it('checks automatic suppression inside serialized admission after Stop and Dismiss', async () => {
    const f = fixture();
    const stopped = { ...item('current'), accountProxyConnectionId: 'proxy' };
    await f.service.enqueue([stopped]);
    let entered: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    f.persist.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const earlierWrite = f.service.enqueue([item('other')]);
    await writing;
    const stop = f.service.control('stop');
    const dismiss = f.service.control('dismiss');
    const admission = f.service.enqueue([stopped], { automatic: true });
    release();
    await earlierWrite;
    await stop;
    await dismiss;
    await admission;
    expect(f.service.snapshot().entries).toHaveLength(0);
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('dismisses after 2000 historical suppressions while retaining current Stop intent', async () => {
    const f = fixture({
      version: 1,
      revision: 1,
      paused: false,
      entries: [],
      suppressedAutomaticResumes: Array.from({ length: 2000 }, (_, index) => ({
        targetKey: `chat:project/worktree/old-${index}`,
        interruptionId: '1',
      })),
    });
    const stopped = { ...item('current'), accountProxyConnectionId: 'proxy' };
    f.dependencies.readLiveAutomaticResumeInterruptionKeys = (): Promise<
      ReadonlySet<string>
    > =>
      Promise.resolve(
        new Set([
          'chat:project/worktree/old-0:1',
          'chat:project/worktree/current:1',
        ]),
      );
    await f.service.enqueue([stopped]);
    await f.service.control('stop');
    await expect(f.service.control('dismiss')).resolves.toMatchObject({
      entries: [],
    });
    expect(f.service.snapshot().suppressedAutomaticResumes).toContainEqual({
      targetKey: 'chat:project/worktree/current',
      interruptionId: '1',
    });
    expect(f.service.snapshot().suppressedAutomaticResumes).toHaveLength(2);
    f.dependencies.readLiveAutomaticResumeInterruptionKeys = (): Promise<
      ReadonlySet<string>
    > => Promise.resolve(new Set(['chat:project/worktree/current:1']));
    await f.service.pruneAutomaticResumeSuppressions();
    expect(f.service.snapshot().suppressedAutomaticResumes).toEqual([
      { targetKey: 'chat:project/worktree/current', interruptionId: '1' },
    ]);
  });
  it('keeps stopped proxy pipeline reasons suppressed when its queue history is dismissed', async () => {
    const f = fixture();
    await f.service.enqueue([
      {
        ...item('pipeline'),
        accountProxyConnectionId: 'proxy',
        interruptionId: 'reason-a,reason-b',
        target: {
          kind: 'pipeline',
          executionId: 'pipeline',
          statusReasonIds: ['reason-a', 'reason-b'],
        },
      },
    ]);
    await f.service.control('stop');
    await f.service.control('dismiss');
    const restored = fixture(f.disk());
    await restored.service.initialize();
    expect(restored.service.snapshot().entries).toHaveLength(0);
    expect(restored.service.snapshot().suppressedAutomaticResumes).toEqual(
      expect.arrayContaining([
        { targetKey: 'pipeline:pipeline', interruptionId: 'reason-a' },
        { targetKey: 'pipeline:pipeline', interruptionId: 'reason-b' },
      ]),
    );
  });

  it('does not erase Stop suppression when canonical interruption reads fail', async () => {
    const suppressed = [
      { targetKey: 'pipeline:unreadable', interruptionId: 'reason' },
    ];
    const f = fixture({
      version: 1,
      revision: 1,
      paused: false,
      entries: [],
      suppressedAutomaticResumes: suppressed,
    });
    f.dependencies.readLiveAutomaticResumeInterruptionKeys = (): Promise<
      ReadonlySet<string>
    > => Promise.reject(new Error('Unreadable execution'));
    await expect(f.service.pruneAutomaticResumeSuppressions()).rejects.toThrow(
      'Unreadable execution',
    );
    expect(f.service.snapshot().suppressedAutomaticResumes).toEqual(suppressed);
    expect(f.persist).not.toHaveBeenCalled();
  });

  it('allows ready work past a proxy that is still cooling down', async () => {
    const f = fixture();
    await f.service.enqueue([item('blocked'), item('ready')]);
    await f.service.tick((entry) => Promise.resolve(entry.title === 'ready'));
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0][0].title).toBe('ready');
    expect(f.service.snapshot().entries[0].status).toBe('waiting');
  });

  it('surfaces a scheduler failure without changing saved waiting work', async () => {
    const f = fixture();
    await f.service.enqueue([item('a')]);
    f.service.stop('Restart to retry');
    expect(f.service.snapshot()).toMatchObject({
      paused: true,
      error: 'Restart to retry',
    });
    expect(f.disk()).toMatchObject({
      paused: false,
      entries: [{ status: 'waiting' }],
    });
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('commits an ordered, deduplicated queue before returning and dispatches only one paced item', async () => {
    const f = fixture();
    await f.service.enqueue([item('a'), item('b'), item('a')]);
    expect(f.disk()?.entries.map((entry) => entry.title)).toEqual(['a', 'b']);
    expect(f.dispatch).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.disk()?.entries.map((entry) => entry.status)).toEqual([
      'resumed',
      'waiting',
    ]);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    f.advance(9999);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it('never overlaps handoffs and starts the delay after a slow dispatch finishes', async () => {
    const f = fixture();
    let release: ((value: 'resumed') => void) | undefined;
    f.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.enqueue([item('a'), item('b')]);
    const first = f.service.tick();
    while (!release) await Promise.resolve();
    f.advance(30000);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    release('resumed');
    await first;
    f.advance(9999);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.service.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it('supersedes a stale pending interruption for the same target', async () => {
    const f = fixture();
    await f.service.enqueue([item('a')]);
    await f.service.enqueue([{ ...item('a'), interruptionId: '2' }]);
    expect(f.service.snapshot().entries).toHaveLength(1);
    expect(f.service.snapshot().entries[0]).toMatchObject({
      interruptionId: '2',
      status: 'waiting',
    });
  });

  it('preserves terminal history until it is explicitly dismissed', async () => {
    const f = fixture();
    await f.service.enqueue([item('a')]);
    await f.service.tick();
    f.advance();
    await f.service.enqueue([item('b')]);
    expect(f.service.snapshot().entries.map((entry) => entry.title)).toEqual([
      'a',
      'b',
    ]);
    await f.service.tick();
    await f.service.control('dismiss');
    expect(f.service.snapshot().entries).toEqual([]);
  });

  it('accepts pause and additions during dispatch; paused state survives recreation', async () => {
    const f = fixture();
    let release: ((value: 'resumed') => void) | undefined;
    f.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.enqueue([item('a'), item('b')]);
    const tick = f.service.tick();
    while (release === undefined) await Promise.resolve();
    await f.service.control('pause');
    await f.service.enqueue([item('b'), item('c')]);
    release('resumed');
    await tick;
    const restarted = fixture(f.disk());
    await restarted.service.initialize();
    await restarted.service.tick();
    expect(restarted.dispatch).not.toHaveBeenCalled();
    expect(restarted.service.snapshot().paused).toBe(true);
    expect(
      restarted.service.snapshot().entries.map((entry) => entry.title),
    ).toEqual(['a', 'b', 'c']);
    await restarted.service.control('resume');
    await restarted.service.tick();
    expect(restarted.dispatch.mock.calls[0][0].title).toBe('b');
  });

  it('keeps an in-flight record while appending a newer interruption', async () => {
    const f = fixture();
    let release: ((value: 'resumed') => void) | undefined;
    f.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.enqueue([item('a')]);
    const tick = f.service.tick();
    while (release === undefined) await Promise.resolve();

    await f.service.enqueue([{ ...item('a'), interruptionId: '2' }]);

    expect(f.service.snapshot().entries).toMatchObject([
      { interruptionId: '1', status: 'resuming' },
      { interruptionId: '2', status: 'waiting' },
    ]);
    release('resumed');
    await tick;
    expect(f.service.snapshot().entries).toMatchObject([
      { interruptionId: '1', status: 'resumed' },
      { interruptionId: '2', status: 'waiting' },
    ]);
  });

  it('marks the durable claim as dispatching before a queued enqueue can supersede it', async () => {
    const f = fixture();
    let releaseClaim: (() => void) | undefined;
    const claim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    await f.service.enqueue([item('a')]);
    f.persist.mockImplementationOnce(async () => {
      await claim;
    });

    const tick = f.service.tick();
    while (f.persist.mock.calls.length < 2) await Promise.resolve();
    const enqueue = f.service.enqueue([{ ...item('a'), interruptionId: '2' }]);
    releaseClaim?.();

    await Promise.all([tick, enqueue]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().entries).toMatchObject([
      { interruptionId: '1', status: 'resumed' },
      { interruptionId: '2', status: 'waiting' },
    ]);
  });

  it('persists the in-flight identity, then reconciles it before continuing after a crash', async () => {
    const f = fixture();
    let inflight: ResumeQueueSnapshot | undefined;
    f.dispatch.mockImplementationOnce(() => {
      inflight = structuredClone(f.disk());
      return Promise.resolve('resumed');
    });
    await f.service.enqueue([item('a'), item('b')]);
    await f.service.tick();
    expect(inflight?.entries[0].status).toBe('resuming');
    const restarted = fixture(inflight);
    restarted.dependencies.reconcile = (): ReturnType<
      ResumeQueueDependencies['reconcile']
    > => Promise.resolve({ status: 'resumed' });
    await restarted.service.initialize();
    await restarted.service.tick();
    expect(restarted.dispatch.mock.calls.map(([entry]) => entry.title)).toEqual(
      ['b'],
    );
    expect(restarted.service.snapshot().entries[0].id).toBe(
      inflight?.entries[0].id,
    );
  });

  it('does not dispatch when the durable claim fails, and stops admission after shutdown', async () => {
    const f = fixture();
    await f.service.enqueue([item('a'), item('b')]);
    f.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.service.tick()).rejects.toThrow('disk full');
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.disk()?.entries[0].status).toBe('waiting');
    f.service.stop();
    f.advance();
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('keeps a failed startup in flight when shutdown interrupts it, then recovers it', async () => {
    const f = fixture();
    let fail: ((error: Error) => void) | undefined;
    f.dispatch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await f.service.enqueue([item('a'), item('b')]);
    const tick = f.service.tick();
    while (fail === undefined) await Promise.resolve();
    f.service.stop();
    fail(new Error('Chat scope is draining'));
    await tick;
    await f.service.flush();
    expect(f.disk()?.entries[0].status).toBe('resuming');
    const restarted = fixture(f.disk());
    await restarted.service.initialize();
    await restarted.service.tick();
    expect(restarted.dispatch.mock.calls[0][0].title).toBe('a');
  });

  it('isolates a failed item, respects dispatch readiness, and stops only remaining work', async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error('provider unavailable'));
    await f.service.enqueue([item('a'), item('b'), item('c')]);
    await f.service.tick(false);
    expect(f.dispatch).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.disk()?.entries[0]).toMatchObject({
      status: 'failed',
      error: 'provider unavailable',
    });
    await f.service.control('stop');
    expect(f.disk()?.entries.map((entry) => entry.status)).toEqual([
      'failed',
      'stopped',
      'stopped',
    ]);
  });

  it('rechecks asynchronous dispatch readiness inside serialized admission', async () => {
    const f = fixture();
    await f.service.enqueue([item('a')]);
    await f.service.tick(() => Promise.resolve(false));
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.service.snapshot().entries[0].status).toBe('waiting');
  });

  it('blocks admission immediately when pause is requested during durable claim persistence', async () => {
    const f = fixture();
    let releaseClaim: (() => void) | undefined;
    const claim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    await f.service.enqueue([item('a')]);
    f.persist.mockImplementationOnce(async () => {
      await claim;
    });

    const tick = f.service.tick();
    while (f.persist.mock.calls.length < 2) await Promise.resolve();
    const pause = f.service.control('pause');
    releaseClaim?.();

    await Promise.all([tick, pause]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.service.snapshot()).toMatchObject({
      paused: true,
      entries: [{ status: 'waiting' }],
    });
  });

  it('stops a durable claim when stop wins before provider handoff', async () => {
    const f = fixture();
    let releaseClaim: (() => void) | undefined;
    const claim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    await f.service.enqueue([item('a')]);
    f.persist.mockImplementationOnce(async () => {
      await claim;
    });

    const tick = f.service.tick();
    while (f.persist.mock.calls.length < 2) await Promise.resolve();
    const stop = f.service.control('stop');
    releaseClaim?.();

    await Promise.all([tick, stop]);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.service.snapshot()).toMatchObject({
      paused: true,
      entries: [{ status: 'stopped' }],
    });
    await f.service.control('resume');
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
