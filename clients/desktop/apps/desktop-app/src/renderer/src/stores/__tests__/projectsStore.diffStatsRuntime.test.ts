import { emptyDiffStatsState } from '../projectsStore.diffStats';
import {
  diffStatsRuntimeTestExports,
  markWorktreeDiffStatsActivity,
  parsePersistedDiffStatsCache,
  updatePersistedDiffStatsState,
  worktreeDiffStatsActivityAtMs,
  worktreeDiffStatsPollStates,
} from '../projectsStore.diffStatsRuntime';

describe('persisted diff-stats runtime cache', () => {
  it('hydrates validated Git details, activity, and poll state', () => {
    const now = 2_000_000;
    const state = {
      ...emptyDiffStatsState(),
      diffStats: { 'project/worktree': { insertions: 4, deletions: 2 } },
      commitsAhead: { 'project/worktree': true },
      baseBranches: { 'project/worktree': 'main' },
      repoBranches: {
        'project/worktree': [
          {
            repoId: 'root',
            repoName: 'Root',
            branch: 'feature/cache',
            insertions: 4,
          },
        ],
      },
    };

    const parsed = parsePersistedDiffStatsCache(
      JSON.stringify({
        version: 1,
        savedAtMs: now - 1_000,
        state,
        activityAtMs: { 'project/worktree': now - 500 },
        pollStates: {
          'project/worktree': {
            intervalMs: 30_000,
            nextDueAtMs: now + 29_000,
            lastChangeSignature: 'signature',
          },
        },
      }),
      now,
    );

    expect(parsed?.state).toEqual(state);
    expect(parsed?.activityAtMs['project/worktree']).toBe(now - 500);
    expect(parsed?.pollStates['project/worktree']).toEqual({
      intervalMs: 30_000,
      nextDueAtMs: now + 29_000,
      lastChangeSignature: 'signature',
    });
  });

  it('rejects malformed and expired cache files', () => {
    const now = 50_000_000_000;
    expect(parsePersistedDiffStatsCache('{bad json', now)).toBeNull();
    expect(
      parsePersistedDiffStatsCache(
        JSON.stringify({
          version: 1,
          savedAtMs: now - diffStatsRuntimeTestExports.maxCacheAgeMs - 1,
          state: emptyDiffStatsState(),
          activityAtMs: {},
          pollStates: {},
        }),
        now,
      ),
    ).toBeNull();
  });

  it('flushes the latest snapshot for immediate restarts', () => {
    jest.useFakeTimers();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    try {
      worktreeDiffStatsActivityAtMs.clear();
      worktreeDiffStatsPollStates.clear();
      const state = {
        ...emptyDiffStatsState(),
        diffStats: { 'project/worktree': { insertions: 7, deletions: 3 } },
      };
      updatePersistedDiffStatsState(state);
      markWorktreeDiffStatsActivity('project', 'worktree', 42_000);
      worktreeDiffStatsPollStates.set('project/worktree', {
        intervalMs: 30_000,
        nextDueAtMs: 72_000,
        lastChangeSignature: 'latest',
      });

      diffStatsRuntimeTestExports.flush();

      const raw = values.get(diffStatsRuntimeTestExports.storageKey);
      expect(raw).toBeDefined();
      const parsed = parsePersistedDiffStatsCache(raw ?? '');
      expect(parsed?.state).toEqual(state);
      expect(parsed?.activityAtMs['project/worktree']).toBe(42_000);
      expect(parsed?.pollStates['project/worktree']?.lastChangeSignature).toBe(
        'latest',
      );
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
      jest.useRealTimers();
    }
  });

  it('does not persist cache state from the App Advisor renderer', () => {
    jest.useFakeTimers();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { search: '?surface=app-advisor' } },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    try {
      updatePersistedDiffStatsState({
        ...emptyDiffStatsState(),
        diffStats: { 'project/worktree': { insertions: 9, deletions: 1 } },
      });
      markWorktreeDiffStatsActivity('project', 'worktree', 43_000);

      diffStatsRuntimeTestExports.flush();
      jest.runOnlyPendingTimers();

      expect(values.has(diffStatsRuntimeTestExports.storageKey)).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'localStorage');
      jest.useRealTimers();
    }
  });
});
