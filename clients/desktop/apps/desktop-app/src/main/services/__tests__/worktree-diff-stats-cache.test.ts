jest.mock('../../lib/worktree-service', () => ({
  getWorktreeDiffStatsOnly: jest.fn(),
}));

jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../../portal/portal-event-bus', () => ({
  emitWorktreeDiffStatsDelta: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../shared-containers/local-repositories', () => ({
  listSharedContainerLocalRepositories: jest.fn(),
}));

jest.mock('../../lib/git', () => ({
  getRemoteTrackingCommitSha: jest.fn(),
}));

const mockScheduleKnown = jest.fn(() => Promise.resolve());
jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleKnown: typeof mockScheduleKnown;
  } => ({
    scheduleKnown: mockScheduleKnown,
  }),
}));

import { getWorktreeDiffStatsOnly } from '../../lib/worktree-service';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { emitWorktreeDiffStatsDelta } from '../../portal/portal-event-bus';
import { portalSnapshotWorkBudget } from '../../portal/portal-snapshot-work-budget';
import { getRemoteTrackingCommitSha } from '../../lib/git';
import { listSharedContainerLocalRepositories } from '../../shared-containers/local-repositories';
import {
  cancelPendingWorktreeDiffStatsRefreshes,
  getCachedWorktreeDiffStats,
  invalidateWorktreeDiffStats,
  primeWorktreeDiffStats,
  refreshMissingWorktreeDiffStats,
  requestAllWorktreeDiffStatsRefresh,
  requestWorkspaceWorktreeDiffStatsRefresh,
  refreshWorktreeDiffStats,
  refreshWorkspaceWorktreeDiffStats,
  removeCachedWorktreeDiffStats,
  removeCachedWorkspaceDiffStats,
  resetWorktreeDiffStatsCacheForTests,
} from '../worktree-diff-stats-cache';

const mockedGetWorktreeDiffStatsOnly = jest.mocked(getWorktreeDiffStatsOnly);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedEmitWorktreeDiffStatsDelta = jest.mocked(
  emitWorktreeDiffStatsDelta,
);
const mockedListRepositories = jest.mocked(
  listSharedContainerLocalRepositories,
);
const mockedGetRemoteTrackingCommitSha = jest.mocked(
  getRemoteTrackingCommitSha,
);

function sidebarWithWorktrees(
  count: number,
  workspaceId = 'workspace-1',
): Awaited<ReturnType<typeof readAllSidebarItems>> {
  return {
    version: 1 as const,
    items: [
      {
        type: 'single-repo' as const,
        id: workspaceId,
        name: 'One',
        color: '#000000',
        repoPath: '/one',
        collapsed: false,
        order: 0,
        worktrees: Array.from({ length: count }, (_, index) => ({
          id: `worktree-${index + 1}`,
          branchName: `branch-${index + 1}`,
          createdAt: 'now',
        })),
      },
    ],
  };
}

describe('worktree diff stats cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWorktreeDiffStatsCacheForTests();
    mockedListRepositories.mockResolvedValue([]);
    mockedGetRemoteTrackingCommitSha.mockResolvedValue(null);
  });

  afterEach(() => {
    resetWorktreeDiffStatsCacheForTests();
    jest.useRealTimers();
  });

  it('delegates invalidation to the debounced shared-container publisher', async () => {
    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockScheduleKnown).toHaveBeenCalledWith('workspace-1', 'worktree-1');
  });

  it.each(['worktree removal', 'workspace removal', 'cancellation'] as const)(
    'discards queued warming after %s',
    async (reason) => {
      mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(1));
      mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
        insertions: 3,
        deletions: 2,
      });
      portalSnapshotWorkBudget.setForegroundBusy(true);
      const sweep = refreshWorkspaceWorktreeDiffStats('workspace-1');
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalled();
        if (reason === 'worktree removal')
          removeCachedWorktreeDiffStats('workspace-1', 'worktree-1');
        else if (reason === 'workspace removal')
          removeCachedWorkspaceDiffStats('workspace-1');
        else cancelPendingWorktreeDiffStatsRefreshes();
      } finally {
        portalSnapshotWorkBudget.setForegroundBusy(false);
        await sweep;
      }
      expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalled();
      expect(mockedEmitWorktreeDiffStatsDelta).not.toHaveBeenCalled();
    },
  );

  it.each(['worktree removal', 'workspace removal', 'cancellation'] as const)(
    'discards a bounded-map target still waiting after %s',
    async (reason) => {
      mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(5));
      let releaseFirst: () => void = () => undefined;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      mockedGetWorktreeDiffStatsOnly
        .mockImplementationOnce(async () => {
          await first;
          return { insertions: 3, deletions: 2 };
        })
        .mockResolvedValue({ insertions: 3, deletions: 2 });

      const sweep = refreshWorkspaceWorktreeDiffStats('workspace-1');
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
        if (reason === 'worktree removal') {
          removeCachedWorktreeDiffStats('workspace-1', 'worktree-5');
        } else if (reason === 'workspace removal') {
          removeCachedWorkspaceDiffStats('workspace-1');
        } else {
          cancelPendingWorktreeDiffStatsRefreshes();
        }
      } finally {
        releaseFirst();
        await sweep;
      }

      expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalledWith(
        'workspace-1',
        'worktree-5',
      );
      expect(
        getCachedWorktreeDiffStats('workspace-1', 'worktree-5'),
      ).toBeUndefined();
    },
  );

  it('keeps cold misses absent and shares a per-generation refresh', async () => {
    let resolveStats:
      | ((value: { insertions: number; deletions: number }) => void)
      | undefined;
    mockedGetWorktreeDiffStatsOnly.mockImplementation(
      () =>
        new Promise((resolve): void => {
          resolveStats = resolve;
        }),
    );

    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toBeUndefined();
    const first = refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    const second = refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(first).toBe(second);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    resolveStats?.({ insertions: 3, deletions: 2 });
    await first;
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toMatchObject({
      insertions: 3,
      deletions: 2,
    });
    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenCalledTimes(1);
  });

  it('delegates a successful periodic refresh to publication tracking', async () => {
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 3,
      deletions: 2,
    });

    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockScheduleKnown).toHaveBeenCalledWith('workspace-1', 'worktree-1');
  });

  it('delegates a no-HEAD diff-stat failure to publication tracking', async () => {
    mockedGetWorktreeDiffStatsOnly.mockRejectedValue(
      new Error('fatal: ambiguous argument HEAD'),
    );

    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockScheduleKnown).toHaveBeenCalledWith('workspace-1', 'worktree-1');
  });

  it('schedules every successful poll even when diff totals and the pushed base are unchanged', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 3,
      deletions: 2,
    });
    mockedListRepositories.mockResolvedValue([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        repoPath: '/repo',
        relativePrefix: '',
      },
    ]);
    let trackingSha = 'a'.repeat(40);
    mockedGetRemoteTrackingCommitSha.mockImplementation(() =>
      Promise.resolve(trackingSha),
    );

    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    mockScheduleKnown.mockClear();
    trackingSha = 'b'.repeat(40);
    now += 6_000;
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(mockScheduleKnown).toHaveBeenCalledTimes(1);

    mockScheduleKnown.mockClear();
    now += 6_000;
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(mockScheduleKnown).toHaveBeenCalledTimes(1);
    expect(mockedGetRemoteTrackingCommitSha).toHaveBeenCalledWith('/repo');
  });

  it('preserves the last good value on failure and delegates every completed refresh', async () => {
    mockedGetWorktreeDiffStatsOnly.mockResolvedValueOnce({
      insertions: 4,
      deletions: 1,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    mockedGetWorktreeDiffStatsOnly.mockRejectedValueOnce(
      new Error('git failed'),
    );
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toMatchObject({
      insertions: 4,
      deletions: 1,
    });
    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenCalledTimes(1);
  });

  it('delegates same-valued replacement generations to publication tracking', async () => {
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 4,
      deletions: 1,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');

    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenCalledTimes(2);
    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenLastCalledWith(
      'workspace-1',
      'worktree-1',
      1,
    );
  });

  it('primes a fresh generation and delegates it to publication tracking', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000);
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 1,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    mockedGetWorktreeDiffStatsOnly.mockClear();
    mockedEmitWorktreeDiffStatsDelta.mockClear();

    primeWorktreeDiffStats('workspace-1', 'worktree-1', {
      insertions: 7,
      deletions: 3,
    });

    expect(getCachedWorktreeDiffStats('workspace-1', 'worktree-1')).toEqual({
      insertions: 7,
      deletions: 3,
      refreshedAt: 2_000,
      generation: 1,
    });
    expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalled();
    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      1,
    );
    nowSpy.mockRestore();
  });

  it('skips fresh same-generation refreshes but refreshes after invalidation', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    mockedGetWorktreeDiffStatsOnly.mockResolvedValueOnce({
      insertions: 2,
      deletions: 1,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    mockedGetWorktreeDiffStatsOnly.mockClear();
    nowSpy.mockReturnValue(2_000);

    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalled();

    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    mockedGetWorktreeDiffStatsOnly.mockResolvedValueOnce({
      insertions: 3,
      deletions: 1,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toMatchObject({
      insertions: 3,
      generation: 1,
    });
    nowSpy.mockRestore();
  });

  it('prevents an older generation from overwriting or emitting', async () => {
    let resolveOld:
      | ((value: { insertions: number; deletions: number }) => void)
      | undefined;
    mockedGetWorktreeDiffStatsOnly
      .mockImplementationOnce(
        () =>
          new Promise((resolve): void => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ insertions: 9, deletions: 5 });
    const oldRefresh = refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    resolveOld?.({ insertions: 1, deletions: 1 });
    await oldRefresh;
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toMatchObject({
      insertions: 9,
      deletions: 5,
      generation: 1,
    });
    expect(mockedEmitWorktreeDiffStatsDelta).toHaveBeenCalledTimes(1);
  });

  it('removes cached state synchronously', async () => {
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    removeCachedWorktreeDiffStats('workspace-1', 'worktree-1');
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toBeUndefined();
  });

  it('project removal invalidates flight-only cold refreshes', async () => {
    const { removeCachedWorkspaceDiffStats } =
      await import('../worktree-diff-stats-cache');
    let resolveStats:
      | ((value: { insertions: number; deletions: number }) => void)
      | undefined;
    mockedGetWorktreeDiffStatsOnly.mockReturnValue(
      new Promise((resolve) => {
        resolveStats = resolve;
      }),
    );
    const flight = refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    removeCachedWorkspaceDiffStats('workspace-1');
    resolveStats?.({ insertions: 5, deletions: 2 });
    await flight;
    expect(
      getCachedWorktreeDiffStats('workspace-1', 'worktree-1'),
    ).toBeUndefined();
    expect(mockedEmitWorktreeDiffStatsDelta).not.toHaveBeenCalled();
  });

  it('refreshes only worktrees in the requested project', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'One',
          color: '#000000',
          repoPath: '/one',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'worktree-1', branchName: 'one', createdAt: 'now' },
            { id: 'worktree-2', branchName: 'two', createdAt: 'now' },
          ],
        },
        {
          type: 'single-repo',
          id: 'workspace-2',
          name: 'Two',
          color: '#000000',
          repoPath: '/two',
          collapsed: false,
          order: 1,
          worktrees: [
            { id: 'worktree-3', branchName: 'three', createdAt: 'now' },
          ],
        },
      ],
    });
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });

    await refreshWorkspaceWorktreeDiffStats('workspace-1');

    expect(mockedGetWorktreeDiffStatsOnly.mock.calls).toEqual([
      ['workspace-1', 'worktree-1'],
      ['workspace-1', 'worktree-2'],
    ]);
  });

  it('defers a second fleet request until the sweep floor', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(41));
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });

    await requestAllWorktreeDiffStatsRefresh();
    await jest.advanceTimersByTimeAsync(6_000);
    const deferred = requestAllWorktreeDiffStatsRefresh();

    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(41);
    await jest.advanceTimersByTimeAsync(23_999);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(41);
    await jest.advanceTimersByTimeAsync(1);
    await deferred;
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(82);
  });

  it('shares an in-flight fleet sweep and schedules one follow-up', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(1));
    let resolveFirst:
      | ((value: { insertions: number; deletions: number }) => void)
      | undefined;
    mockedGetWorktreeDiffStatsOnly
      .mockImplementationOnce(
        () =>
          new Promise((resolve): void => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ insertions: 2, deletions: 0 });

    const first = requestAllWorktreeDiffStatsRefresh();
    await jest.advanceTimersByTimeAsync(0);
    const second = requestAllWorktreeDiffStatsRefresh();
    const third = requestAllWorktreeDiffStatsRefresh();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    resolveFirst?.({ insertions: 1, deletions: 0 });
    await first;
    await jest.advanceTimersByTimeAsync(29_999);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(2);
  });

  it('refreshes only cache-cold worktrees after structure changes', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(2));
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });
    await refreshWorktreeDiffStats('workspace-1', 'worktree-1');
    await refreshWorktreeDiffStats('workspace-1', 'worktree-2');
    mockedGetWorktreeDiffStatsOnly.mockClear();

    await refreshMissingWorktreeDiffStats();
    expect(mockedGetWorktreeDiffStatsOnly).not.toHaveBeenCalled();

    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(3));
    await refreshMissingWorktreeDiffStats();
    expect(mockedGetWorktreeDiffStatsOnly.mock.calls).toEqual([
      ['workspace-1', 'worktree-3'],
    ]);
  });

  it('throttles failed cache-cold refreshes to the sweep floor', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(1));
    mockedGetWorktreeDiffStatsOnly.mockRejectedValue(new Error('git failed'));

    await refreshMissingWorktreeDiffStats();
    await refreshMissingWorktreeDiffStats();
    await jest.advanceTimersByTimeAsync(29_999);
    await refreshMissingWorktreeDiffStats();

    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await refreshMissingWorktreeDiffStats();

    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(2);
  });

  it('keeps a 41-worktree structure-change storm within one sweep budget', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(41));
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });
    await requestAllWorktreeDiffStatsRefresh();

    for (let second = 0; second < 60; second += 1) {
      invalidateWorktreeDiffStats(
        'workspace-1',
        `worktree-${(second % 41) + 1}`,
      );
      await refreshMissingWorktreeDiffStats();
      await jest.advanceTimersByTimeAsync(1_000);
    }

    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(41);
  });

  it('does not let invalidation bypass the fleet sweep floor', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(1));
    let resolveFirst:
      | ((value: { insertions: number; deletions: number }) => void)
      | undefined;
    mockedGetWorktreeDiffStatsOnly.mockImplementationOnce(
      () =>
        new Promise((resolve): void => {
          resolveFirst = resolve;
        }),
    );

    const first = requestAllWorktreeDiffStatsRefresh();
    await jest.advanceTimersByTimeAsync(0);
    invalidateWorktreeDiffStats('workspace-1', 'worktree-1');
    const repeated = requestAllWorktreeDiffStatsRefresh();

    expect(repeated).toBe(first);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    resolveFirst?.({ insertions: 1, deletions: 0 });
    await first;
    await jest.advanceTimersByTimeAsync(29_999);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(2);
  });

  it('applies independent sweep floors per workspace', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        ...sidebarWithWorktrees(1, 'workspace-1').items,
        ...sidebarWithWorktrees(1, 'workspace-2').items,
      ],
    });
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });

    await requestWorkspaceWorktreeDiffStatsRefresh('workspace-1');
    await requestWorkspaceWorktreeDiffStatsRefresh('workspace-2');
    const deferred = requestWorkspaceWorktreeDiffStatsRefresh('workspace-1');

    expect(mockedGetWorktreeDiffStatsOnly.mock.calls).toEqual([
      ['workspace-1', 'worktree-1'],
      ['workspace-2', 'worktree-1'],
    ]);
    await jest.advanceTimersByTimeAsync(30_000);
    await deferred;
    expect(mockedGetWorktreeDiffStatsOnly.mock.calls).toEqual([
      ['workspace-1', 'worktree-1'],
      ['workspace-2', 'worktree-1'],
      ['workspace-1', 'worktree-1'],
    ]);
  });

  it('cancels a deferred fleet sweep', async () => {
    jest.useFakeTimers();
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithWorktrees(1));
    mockedGetWorktreeDiffStatsOnly.mockResolvedValue({
      insertions: 1,
      deletions: 0,
    });
    await requestAllWorktreeDiffStatsRefresh();
    const deferred = requestAllWorktreeDiffStatsRefresh();

    cancelPendingWorktreeDiffStatsRefreshes();
    await jest.advanceTimersByTimeAsync(30_000);
    await deferred;

    expect(mockedGetWorktreeDiffStatsOnly).toHaveBeenCalledTimes(1);
  });
});
