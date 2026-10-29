jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));

jest.mock('../portal-pr-delta', () => ({
  emitPrStatusDelta: jest.fn(),
}));

import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import { emitPrStatusDelta } from '../portal-pr-delta';
import {
  beginPrCreationProgress,
  cancelPrCreationProgress,
} from '../pr-creation-progress';
import {
  beginPrMergeProgress,
  clearPrMergeTracking,
  finishPrMergeProgress,
  getPrMergeProgress,
  getPrMergeProgressFeed,
  recordPrMergeProgress,
} from '../pr-merge-progress';

describe('PR merge progress projection', () => {
  afterEach(() => {
    finishPrMergeProgress('workspace', 'worktree');
    jest.clearAllMocks();
  });

  it('projects live phases and clears terminal progress', () => {
    expect(getPrMergeProgress('workspace', 'worktree')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });

    recordPrMergeProgress({
      projectId: 'workspace',
      worktreeId: 'worktree',
      phase: 'queued',
    });
    expect(schedulePortalStructuralSync).not.toHaveBeenCalled();

    beginPrMergeProgress('workspace', 'worktree');
    expect(getPrMergeProgress('workspace', 'worktree')).toEqual({
      mergingPr: true,
      mergePrPhase: 'checking_mergeability',
    });

    recordPrMergeProgress({
      projectId: 'workspace',
      worktreeId: 'worktree',
      phase: 'queued',
    });
    expect(getPrMergeProgress('workspace', 'worktree')).toEqual({
      mergingPr: true,
      mergePrPhase: 'queued',
    });

    // Production terminal emissions always name their repo (see the `done`
    // and `error` calls in `ipc/github.ts`), including in a single-repo
    // workspace.
    for (const phase of ['done', 'error'] as const) {
      recordPrMergeProgress({
        projectId: 'workspace',
        worktreeId: 'worktree',
        phase,
        repoId: 'repo-a',
        repoName: 'repo-a',
      });
      expect(getPrMergeProgress('workspace', 'worktree')).toEqual({
        mergingPr: true,
        mergePrPhase: 'queued',
      });
    }

    finishPrMergeProgress('workspace', 'worktree');
    expect(getPrMergeProgress('workspace', 'worktree')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });
    expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(3);
  });
});

describe('PR merge progress feed', () => {
  afterEach(() => {
    cancelPrCreationProgress('ws', 'wt');
    clearPrMergeTracking('ws', 'wt');
    jest.clearAllMocks();
  });

  it('keeps one generation through an attempt and advances it on the next', () => {
    beginPrMergeProgress('ws', 'wt');
    const first = getPrMergeProgressFeed('ws', 'wt')?.generation ?? 0;
    expect(first).toBeGreaterThan(0);
    recordPrMergeProgress({ projectId: 'ws', worktreeId: 'wt', phase: 'done' });
    expect(getPrMergeProgressFeed('ws', 'wt')?.generation).toBe(first);
    finishPrMergeProgress('ws', 'wt');
    expect(getPrMergeProgressFeed('ws', 'wt')?.generation).toBe(first);

    beginPrMergeProgress('ws', 'wt');
    expect(getPrMergeProgressFeed('ws', 'wt')?.generation).toBeGreaterThan(
      first,
    );
  });

  it('accumulates steps and emits a pr_status delta per phase', () => {
    beginPrMergeProgress('ws', 'wt');
    expect(getPrMergeProgressFeed('ws', 'wt')).toMatchObject({
      steps: [],
      currentPhase: 'checking_mergeability',
    });
    expect(emitPrStatusDelta).toHaveBeenCalledTimes(1);

    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'waiting_mergeability',
      retryDelayMs: 4000,
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'merging',
    });

    expect(getPrMergeProgressFeed('ws', 'wt')).toMatchObject({
      steps: [
        { phase: 'waiting_mergeability', retryDelayMs: 4000 },
        { phase: 'merging' },
      ],
      currentPhase: 'merging',
    });
    expect(emitPrStatusDelta).toHaveBeenCalledTimes(3);
  });

  it('records terminal phases instead of dropping them', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'merging',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'merge conflict',
    });

    // The failure is recorded, but a single repo failing cannot end a
    // multi-repo operation whose other repos may still be merging.
    expect(getPrMergeProgressFeed('ws', 'wt')).toMatchObject({
      steps: [
        { phase: 'merging', repoId: 'repo-a', repoName: 'repo-a' },
        {
          phase: 'error',
          repoId: 'repo-a',
          repoName: 'repo-a',
          error: 'merge conflict',
        },
      ],
      currentPhase: 'merging',
    });
  });

  it('settles a failed single-repo merge in error at finish', () => {
    // Exactly the emissions `ipc/github.ts` produces when GitHub rejects the
    // only repo's merge: every step names the repo, and the outer
    // `refreshing_pr_status` / `done` pair never fires because no repo merged.
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'checking_mergeability',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'merging',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'Base branch was modified',
    });
    jest.clearAllMocks();

    finishPrMergeProgress('ws', 'wt');

    const feed = getPrMergeProgressFeed('ws', 'wt');
    expect(feed?.currentPhase).toBe('error');
    expect(feed?.steps).toHaveLength(3);
    // The card must be told, not left waiting for the next refresh.
    expect(emitPrStatusDelta).toHaveBeenCalledWith('ws', 'wt', {
      mergeProgress: feed,
    });
  });

  it('settles a partially failed multi-repo merge in error on the global done', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'boom',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'done',
      repoId: 'repo-b',
      repoName: 'repo-b',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'refreshing_pr_status',
    });
    recordPrMergeProgress({ projectId: 'ws', worktreeId: 'wt', phase: 'done' });

    expect(getPrMergeProgressFeed('ws', 'wt')?.currentPhase).toBe('error');
  });

  it('keeps a per-repo terminal step from ending the overall merge', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'merging',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'done',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    // repo-b is still working; the overall feed must not read as finished.
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'checking_mergeability',
      repoId: 'repo-b',
      repoName: 'repo-b',
    });

    expect(getPrMergeProgressFeed('ws', 'wt')?.currentPhase).toBe(
      'checking_mergeability',
    );
  });

  it('retains an errored feed past finish, and resets it on the next attempt', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'boom',
    });
    finishPrMergeProgress('ws', 'wt');

    expect(getPrMergeProgress('ws', 'wt')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });
    expect(getPrMergeProgressFeed('ws', 'wt')?.currentPhase).toBe('error');

    beginPrMergeProgress('ws', 'wt');
    expect(getPrMergeProgressFeed('ws', 'wt')).toMatchObject({
      steps: [],
      currentPhase: 'checking_mergeability',
    });
  });

  it('retains a successful feed on finish so clients can observe done', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'done',
      repoId: 'repo-a',
      repoName: 'repo-a',
    });
    recordPrMergeProgress({ projectId: 'ws', worktreeId: 'wt', phase: 'done' });
    jest.clearAllMocks();
    finishPrMergeProgress('ws', 'wt');

    expect(getPrMergeProgressFeed('ws', 'wt')).toMatchObject({
      currentPhase: 'done',
      steps: [
        {
          phase: 'done',
          repoId: 'repo-a',
          repoName: 'repo-a',
        },
        { phase: 'done' },
      ],
    });
    expect(emitPrStatusDelta).not.toHaveBeenCalled();
  });

  it('clears a terminal merge feed when PR creation begins', () => {
    beginPrMergeProgress('ws', 'wt');
    recordPrMergeProgress({
      projectId: 'ws',
      worktreeId: 'wt',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'boom',
    });
    finishPrMergeProgress('ws', 'wt');
    expect(getPrMergeProgressFeed('ws', 'wt')?.currentPhase).toBe('error');
    jest.clearAllMocks();

    beginPrCreationProgress('ws', 'wt');

    expect(getPrMergeProgressFeed('ws', 'wt')).toBeUndefined();
    expect(emitPrStatusDelta).toHaveBeenCalledWith('ws', 'wt', {
      mergeProgress: null,
    });
  });
});

describe('clearPrMergeTracking', () => {
  afterEach(() => {
    clearPrMergeTracking('ws3', 'wt3');
    jest.clearAllMocks();
  });

  it('drops both the progress and feed map entries for a worktree', () => {
    beginPrMergeProgress('ws3', 'wt3');
    recordPrMergeProgress({
      projectId: 'ws3',
      worktreeId: 'wt3',
      phase: 'error',
      repoId: 'repo-a',
      repoName: 'repo-a',
      error: 'boom',
    });

    // Sanity: both maps hold live state before clearing — the feed
    // accumulates independently of the progress projection, so a clear that
    // only dropped one map would leave the other pinned.
    expect(getPrMergeProgress('ws3', 'wt3')).toEqual({
      mergingPr: true,
      mergePrPhase: 'checking_mergeability',
    });
    expect(getPrMergeProgressFeed('ws3', 'wt3')).toMatchObject({
      steps: [
        {
          phase: 'error',
          repoId: 'repo-a',
          repoName: 'repo-a',
          error: 'boom',
        },
      ],
      currentPhase: 'checking_mergeability',
    });

    clearPrMergeTracking('ws3', 'wt3');

    expect(getPrMergeProgress('ws3', 'wt3')).toEqual({
      mergingPr: false,
      mergePrPhase: null,
    });
    expect(getPrMergeProgressFeed('ws3', 'wt3')).toBeUndefined();
  });
});
