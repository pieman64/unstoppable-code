import type { DiffStatsBatchResponseItem } from '@canopy/desktop-shared/types';
import {
  buildDiffStatsChangeSignature,
  buildDiffStatsState,
  computeNextDiffStatsPollState,
  DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS,
  DIFF_STATS_BASE_POLL_INTERVAL_MS,
  DIFF_STATS_MAX_POLL_INTERVAL_MS,
  emptyDiffStatsState,
  getSidebarStatsRequestMode,
  planScheduledDiffStatsBatch,
  shouldPollSidebarStats,
  stabilizeDiffStatsState,
  type DiffStatsState,
} from '../projectsStore.diffStats';

function stateWithOneRepo(): DiffStatsState {
  return {
    ...emptyDiffStatsState(),
    diffStats: { 'project/worktree': { insertions: 1, deletions: 2 } },
    commitsAhead: { 'project/worktree': false },
    baseBranches: { 'project/worktree': 'main' },
    uncommittedChanges: { 'project/worktree': true },
    hasRemoteTracking: { 'project/worktree': true },
    hasOriginRemote: { 'project/worktree': true },
    hasBranchBeenPushed: { 'project/worktree': true },
    hasUnpushedCommits: { 'project/worktree': false },
    hasUnpulledCommits: { 'project/worktree': false },
    repoBranches: {
      'project/worktree': [
        {
          repoId: 'repo-1',
          repoName: 'Repo',
          branch: 'feature',
          baseBranch: 'main',
          insertions: 1,
          deletions: 2,
          commitsAhead: false,
          hasUncommittedChanges: true,
          hasRemoteTrackingBranch: true,
          hasBranchBeenPushed: true,
          hasUnpushedCommits: false,
          hasUnpulledCommits: false,
          baseBranchExistsLocally: true,
          baseBranchExistsInRemote: true,
          hasOriginRemote: true,
        },
      ],
    },
    baseBranchExistsLocally: { 'project/worktree': true },
    baseBranchExistsInRemote: { 'project/worktree': true },
  };
}

describe('stabilizeDiffStatsState', () => {
  it('reuses previous maps and values when the next state is equal', () => {
    const previous = stateWithOneRepo();
    const next = stateWithOneRepo();

    const result = stabilizeDiffStatsState(previous, next);

    expect(result.changed).toBe(false);
    expect(result.state).toBe(previous);
    expect(result.state.diffStats).toBe(previous.diffStats);
    expect(result.state.repoBranches).toBe(previous.repoBranches);
  });

  it('replaces only changed maps and preserves equal per-key values', () => {
    const previous = stateWithOneRepo();
    const next = {
      ...stateWithOneRepo(),
      diffStats: {
        ...previous.diffStats,
        'project/other': { insertions: 3, deletions: 0 },
      },
      repoBranches: {
        ...previous.repoBranches,
        'project/other': [
          {
            repoId: 'repo-2',
            repoName: 'Other',
            branch: 'feature',
          },
        ],
      },
    };

    const result = stabilizeDiffStatsState(previous, next);

    expect(result.changed).toBe(true);
    expect(result.state).not.toBe(previous);
    expect(result.state.diffStats).not.toBe(previous.diffStats);
    expect(result.state.diffStats['project/worktree']).toBe(
      previous.diffStats['project/worktree'],
    );
    expect(result.state.commitsAhead).toBe(previous.commitsAhead);
    expect(result.state.repoBranches['project/worktree']).toBe(
      previous.repoBranches['project/worktree'],
    );
  });
});

describe('adaptive diff-stats polling', () => {
  it('raises the active background cadence to ten minutes', () => {
    expect(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS).toBe(10 * 60_000);
    expect(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS).toBeGreaterThan(
      DIFF_STATS_BASE_POLL_INTERVAL_MS,
    );
  });

  const item = (
    overrides: Partial<DiffStatsBatchResponseItem> = {},
  ): DiffStatsBatchResponseItem => ({
    projectId: 'project',
    worktreeId: 'worktree',
    insertions: 1,
    deletions: 2,
    ...overrides,
  });

  it('always includes the foreground worktree and only due background worktrees', () => {
    const now = 1_000_000;
    const pollStates = new Map([
      [
        'project/bg-due',
        {
          intervalMs: 30_000,
          nextDueAtMs: now - 1,
          lastChangeSignature: 'sig',
        },
      ],
      [
        'project/bg-not-due',
        {
          intervalMs: 30_000,
          nextDueAtMs: now + 60_000,
          lastChangeSignature: 'sig',
        },
      ],
      [
        'project/foreground',
        {
          intervalMs: 30_000,
          nextDueAtMs: now + 60_000,
          lastChangeSignature: 'sig',
        },
      ],
      [
        'project/removed',
        {
          intervalMs: 30_000,
          nextDueAtMs: now,
          lastChangeSignature: 'sig',
        },
      ],
    ]);

    const plan = planScheduledDiffStatsBatch({
      worktrees: [
        { projectId: 'project', worktreeId: 'foreground' },
        { projectId: 'project', worktreeId: 'bg-due' },
        { projectId: 'project', worktreeId: 'bg-not-due' },
        { projectId: 'project', worktreeId: 'bg-new' },
      ],
      pollStates,
      activityAtMs: new Map(),
      foregroundKey: 'project/foreground',
      nowMs: now,
      batchLimit: 12,
    });

    expect(plan.batch).toEqual([
      // Foreground first, even though its own state is not due.
      { projectId: 'project', worktreeId: 'foreground' },
      // No poll state → due immediately (dueAt 0 sorts first).
      { projectId: 'project', worktreeId: 'bg-new' },
      { projectId: 'project', worktreeId: 'bg-due' },
    ]);
    expect(plan.prunedKeys).toEqual(['project/removed']);
  });

  it('caps the background batch and keeps overdue worktrees for later ticks', () => {
    const now = 1_000_000;
    const worktrees = Array.from({ length: 5 }, (_, index) => ({
      projectId: 'project',
      worktreeId: `wt-${index}`,
    }));
    const pollStates = new Map(
      worktrees.map((worktree, index) => [
        `project/${worktree.worktreeId}`,
        {
          intervalMs: 30_000,
          // All overdue; older index → longer overdue.
          nextDueAtMs: now - (5 - index) * 1_000,
          lastChangeSignature: 'sig',
        },
      ]),
    );

    const plan = planScheduledDiffStatsBatch({
      worktrees,
      pollStates,
      activityAtMs: new Map(),
      foregroundKey: null,
      nowMs: now,
      batchLimit: 2,
    });

    expect(plan.batch.map((wt) => wt.worktreeId)).toEqual(['wt-0', 'wt-1']);
  });

  it('moves inactive worktrees to the slow cadence and resets on change', () => {
    const now = 1_000_000;
    const signature = buildDiffStatsChangeSignature(item());
    const first = computeNextDiffStatsPollState({
      previous: undefined,
      signature,
      isForeground: false,
      isRecentlyActive: false,
      forceReset: false,
      nowMs: now,
    });
    expect(first.intervalMs).toBe(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS);

    const unchanged = computeNextDiffStatsPollState({
      previous: first,
      signature,
      isForeground: false,
      isRecentlyActive: false,
      forceReset: false,
      nowMs: now + first.intervalMs,
    });
    expect(unchanged.intervalMs).toBe(DIFF_STATS_MAX_POLL_INTERVAL_MS);

    const changedSignature = buildDiffStatsChangeSignature(
      item({ insertions: 42 }),
    );
    const afterChange = computeNextDiffStatsPollState({
      previous: unchanged,
      signature: changedSignature,
      isForeground: false,
      isRecentlyActive: false,
      forceReset: false,
      nowMs: now,
    });
    expect(afterChange.intervalMs).toBe(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS);
  });

  it('uses full stats for the foreground or a cache-cold background worktree', () => {
    expect(
      getSidebarStatsRequestMode(
        'project/foreground',
        'project/foreground',
        true,
      ),
    ).toBe('full');
    expect(
      getSidebarStatsRequestMode(
        'project/background',
        'project/foreground',
        true,
      ),
    ).toBe('diff_only');
    expect(getSidebarStatsRequestMode('project/background', null, true)).toBe(
      'diff_only',
    );
    expect(getSidebarStatsRequestMode('project/background', null, false)).toBe(
      'full',
    );
    expect(
      getSidebarStatsRequestMode(
        'project/background',
        'project/foreground',
        false,
      ),
    ).toBe('full');
  });

  it('polls only while the renderer is visible and focused', () => {
    expect(
      shouldPollSidebarStats({ visibilityState: 'visible', hasFocus: true }),
    ).toBe(true);
    expect(
      shouldPollSidebarStats({ visibilityState: 'visible', hasFocus: false }),
    ).toBe(false);
    expect(
      shouldPollSidebarStats({ visibilityState: 'hidden', hasFocus: true }),
    ).toBe(false);
  });

  it('keeps diff-only responses scoped to badge data', () => {
    const built = buildDiffStatsState(
      [item({ mode: 'diff_only', insertions: 9, deletions: 4 })],
      new Set(),
    );

    expect(built.diffStats).toEqual({
      'project/worktree': { insertions: 9, deletions: 4 },
    });
    expect(built.diffOnlyKeys).toEqual(new Set(['project/worktree']));
    expect(built.healthUpdates).toEqual(new Map());
    expect(built.commitsAhead).toEqual({});
    expect(built.uncommittedChanges).toEqual({});
  });

  it('keeps foreground fast while recent and force-reset background rows use the raised cadence', () => {
    const signature = buildDiffStatsChangeSignature(item());
    const backedOff = {
      intervalMs: DIFF_STATS_MAX_POLL_INTERVAL_MS,
      nextDueAtMs: 0,
      lastChangeSignature: signature,
    };
    expect(
      computeNextDiffStatsPollState({
        previous: backedOff,
        signature,
        isForeground: true,
        isRecentlyActive: false,
        forceReset: false,
        nowMs: 0,
      }).intervalMs,
    ).toBe(DIFF_STATS_BASE_POLL_INTERVAL_MS);
    expect(
      computeNextDiffStatsPollState({
        previous: backedOff,
        signature,
        isForeground: false,
        isRecentlyActive: false,
        forceReset: true,
        nowMs: 0,
      }).intervalMs,
    ).toBe(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS);
    expect(
      computeNextDiffStatsPollState({
        previous: backedOff,
        signature,
        isForeground: false,
        isRecentlyActive: true,
        forceReset: false,
        nowMs: 0,
      }).intervalMs,
    ).toBe(DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS);
  });

  it('prioritizes due worktrees by recent activity before inactive work', () => {
    const now = 2_000_000;
    const worktrees = ['inactive', 'recent', 'most-recent'].map(
      (worktreeId) => ({ projectId: 'project', worktreeId }),
    );
    const pollStates = new Map(
      worktrees.map((worktree) => [
        `project/${worktree.worktreeId}`,
        {
          intervalMs: 30_000,
          nextDueAtMs: now - 1,
          lastChangeSignature: 'sig',
        },
      ]),
    );

    const plan = planScheduledDiffStatsBatch({
      worktrees,
      pollStates,
      activityAtMs: new Map([
        ['project/recent', now - 20_000],
        ['project/most-recent', now - 1_000],
      ]),
      foregroundKey: null,
      nowMs: now,
      batchLimit: 3,
    });

    expect(plan.batch.map((worktree) => worktree.worktreeId)).toEqual([
      'most-recent',
      'recent',
      'inactive',
    ]);
  });
});
