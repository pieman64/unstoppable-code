import { resumeUsageLimitedChatsWith } from '../ipc/usage-limited-chats';

describe('resumeUsageLimitedChatsWith', () => {
  it('dispatches Continue per target and aggregates failures', async () => {
    const dispatched: string[] = [];
    const cleared: string[] = [];
    const res = await resumeUsageLimitedChatsWith(
      {
        targets: [
          { projectId: 'a', worktreeId: 'w', chatId: 'c1' },
          { projectId: 'a', worktreeId: 'w', chatId: 'c2' },
        ],
      },
      {
        // ResumeDeps requires Promise<void>-returning fakes; these are
        // intentionally synchronous under the hood.
        // eslint-disable-next-line @typescript-eslint/require-await
        dispatchContinue: async (t) => {
          if (t.chatId === 'c2') throw new Error('boom');
          dispatched.push(t.chatId);
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        clearRegistryAndBanner: async (t) => {
          cleared.push(t.chatId);
        },
      },
    );
    expect(dispatched).toEqual(['c1']);
    expect(cleared).toEqual(['c1']); // cleared only after a successful dispatch
    expect(res.resumedCount).toBe(1);
    expect(res.failedTargets.map((t) => t.chatId)).toEqual(['c2']);
  });

  // The clear runs after the dispatch, so a resumed turn that immediately
  // re-hits the usage limit can record a NEW entry before it. The orchestrator
  // hands the clear the instant the resume began so it can tell that newer
  // record apart from the stale one it is meant to remove.
  it('gives the clear a resume-start timestamp taken before the dispatch', async () => {
    const seen: Array<{ chatId: string; resumeStartedAt: number }> = [];
    let dispatchedAt = 0;
    const before = Date.now();
    await resumeUsageLimitedChatsWith(
      { targets: [{ projectId: 'a', worktreeId: 'w', chatId: 'c1' }] },
      {
        dispatchContinue: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          dispatchedAt = Date.now();
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        clearRegistryAndBanner: async (t, resumeStartedAt) => {
          seen.push({ chatId: t.chatId, resumeStartedAt });
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.chatId).toBe('c1');
    expect(seen[0]?.resumeStartedAt).toBeGreaterThanOrEqual(before);
    // Taken BEFORE the dispatch: anything the dispatched turn records is newer.
    expect(seen[0]?.resumeStartedAt).toBeLessThanOrEqual(dispatchedAt);
  });

  it('resumes all targets when every dispatch succeeds', async () => {
    const res = await resumeUsageLimitedChatsWith(
      { targets: [{ projectId: 'a', worktreeId: 'w', chatId: 'c1' }] },
      {
        dispatchContinue: async () => {},
        clearRegistryAndBanner: async () => {},
      },
    );
    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
  });
});

it('serializes simultaneous resume triggers and allows retry after a failed dispatch', async () => {
  const target = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'concurrent',
  };
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatchContinue = jest.fn(async () => {
    await blocked;
  });
  const deps = {
    dispatchContinue,
    clearRegistryAndBanner: jest.fn(() => Promise.resolve(undefined)),
  };
  const first = resumeUsageLimitedChatsWith({ targets: [target] }, deps);
  expect(
    await resumeUsageLimitedChatsWith({ targets: [target] }, deps),
  ).toMatchObject({ resumedCount: 0, failedTargets: [target] });
  release();
  expect(await first).toMatchObject({ resumedCount: 1 });
  const failing = {
    ...deps,
    dispatchContinue: jest.fn(() => Promise.reject(new Error('offline'))),
  };
  expect(
    await resumeUsageLimitedChatsWith({ targets: [target] }, failing),
  ).toMatchObject({ resumedCount: 0 });
  expect(
    await resumeUsageLimitedChatsWith({ targets: [target] }, deps),
  ).toMatchObject({ resumedCount: 1 });
});
