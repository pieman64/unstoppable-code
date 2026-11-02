jest.mock('../../lib/desktop-telemetry', () => ({
  recordGitCommitTelemetry: jest.fn(),
  recordPullRequestOpenedTelemetry: jest.fn(),
}));
import {
  recordGitCommitTelemetry,
  recordPullRequestOpenedTelemetry,
} from '../../lib/desktop-telemetry';
import { GitHubBrokerError } from '../../lib/github-broker/errors';
import { listWorkspaceWorktreeRepoEntries } from '../../lib/worktree-repo-entries';
import { registerWorktreePrActions } from '../pr-worktree-actions';
jest.mock('../../lib/github-pr', () => ({
  fetchPrStatusForWorktree: jest.fn(),
  createPrForRepo: jest.fn(),
  updatePrBaseBranchForRepo: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/tmp/workspace'),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));
jest.mock('../../lib/git-default-branch', () => ({
  resolveFreshDefaultBranch: jest.fn(),
}));
jest.mock('../../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: jest.fn(() =>
    Promise.resolve('/usr/bin/true'),
  ),
}));
jest.mock('../../lib/git', () => ({
  commitWithMessage: jest.fn(),
  getCurrentBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  pullBranchRebase: jest.fn(),
  pushBranch: jest.fn(),
  getPushRemoteUrlStrict: jest.fn(),
  stageAllChanges: jest.fn(),
}));
jest.mock('../../lib/worktree-precommit-failure-hook', () => ({
  triggerWorktreePrecommitFailureHook: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/github-poller', () => ({
  refreshNow: jest.fn().mockResolvedValue(null),
}));
const mockScheduleKnown = jest.fn(() => Promise.resolve());
jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleKnown: typeof mockScheduleKnown;
  } => ({ scheduleKnown: mockScheduleKnown }),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(() => false),
  enqueuePortalEvent: jest.fn(),
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
}));
jest.mock('../../lib/validation', () => ({
  validateId: jest.fn((value: string, field: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error(`Invalid ${field}`);
    }
  }),
}));
jest.mock('../pr-merge-progress', () => ({
  clearPrMergeProgressFeed: jest.fn(),
  getPrMergeProgressFeed: jest.fn(() => undefined),
}));

import {
  createPrForRepo,
  fetchPrStatusForWorktree,
  updatePrBaseBranchForRepo,
} from '../../lib/github-pr';
import { resolveFreshDefaultBranch } from '../../lib/git-default-branch';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import {
  commitWithMessage,
  getCurrentBranch,
  hasUncommittedChanges,
  pullBranchRebase,
  pushBranch,
  getPushRemoteUrlStrict,
  stageAllChanges,
} from '../../lib/git';
import {
  beginGitActionCancellationScope,
  finishGitActionCancellationScope,
  isGitActionActive,
  resetGitActionCancellationsForTests,
} from '../../ipc/git-action-cancellation';
import { acquireSplitLock, releaseSplitLock } from '../split-lock-service';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { triggerWorktreePrecommitFailureHook } from '../../lib/worktree-precommit-failure-hook';
import { refreshNow } from '../../lib/github-poller';
import {
  projectPortalPrStatus,
  registerPortalPrStatusProjection,
  createPullRequest,
  refreshPullRequestState,
  runPrAction,
} from '../pr-service';
import {
  beginPrCreationProgress,
  cancelPrCreationProgress,
  recordPrCreationProgress,
  rememberPortalPrState,
} from '../pr-creation-progress';
import { getPrMergeProgressFeed } from '../pr-merge-progress';
import { emitWorktreePrStatusChange } from '../../lib/pr-status-change-emitter';
import {
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../../portal/portal-event-bus';

const mockedIsCanopyPortalActive = jest.mocked(isCanopyPortalActive);
const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);

const mockedFetchPrStatus = jest.mocked(fetchPrStatusForWorktree);
const mockedCreatePrForRepo = jest.mocked(createPrForRepo);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveFreshDefaultBranch = jest.mocked(resolveFreshDefaultBranch);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedStageAllChanges = jest.mocked(stageAllChanges);
const mockedCommitWithMessage = jest.mocked(commitWithMessage);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedTriggerWorktreePrecommitFailureHook = jest.mocked(
  triggerWorktreePrecommitFailureHook,
);
const mockedRefreshNow = jest.mocked(refreshNow);

describe('createPullRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeCwd.mockReturnValue(process.cwd());
    mockedResolveFreshDefaultBranch.mockResolvedValue('develop');
    mockedCreatePrForRepo.mockResolvedValue({
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
      created: true,
    });
  });

  it('uses fresh default-branch resolution instead of a hardcoded main fallback', async () => {
    await expect(
      createPullRequest({
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        title: 'Use the verified base',
        body: 'Avoid a stale local origin HEAD.',
        draft: false,
      }),
    ).resolves.toMatchObject({ baseBranch: 'develop' });

    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      source: 'manual',
      flow: 'portal',
      repoCount: 1,
    });
    expect(mockedResolveFreshDefaultBranch).toHaveBeenCalledWith(process.cwd());
    expect(mockedCreatePrForRepo).toHaveBeenCalledWith(
      process.cwd(),
      '',
      'Use the verified base',
      'Avoid a stale local origin HEAD.',
      'develop',
      false,
    );
    expect(mockedRefreshNow).toHaveBeenCalledWith('workspace-1', 'worktree-1');
  });
});

describe('pr-service portal projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('projects per-check details onto the portal pr_status payload', async () => {
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'repo-1',
          status: {
            prNumber: 42,
            prUrl: 'https://example.com/pr/42',
            state: 'open',
            baseRefName: 'main',
            title: 'Add portal fields',
            checkStatus: 'failing',
            checkDetails: [
              { name: 'lint', status: 'passing', detailsUrl: null },
              { name: 'tests', status: 'failing', detailsUrl: null },
              { name: 'docs', status: 'pending', detailsUrl: null },
              { name: 'skipped', status: 'neutral', detailsUrl: null },
              { name: 'untouched', status: 'none', detailsUrl: null },
            ],
            reviewStatus: 'changes_requested',
            reviewers: [],
            hasConflicts: false,
            commentCount: 3,
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });

    const state = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    expect(state.checkDetails).toEqual([
      { name: 'lint', status: 'success', detailsUrl: null },
      { name: 'tests', status: 'failure', detailsUrl: null },
      { name: 'docs', status: 'pending', detailsUrl: null },
      { name: 'skipped', status: 'neutral', detailsUrl: null },
      // `none` is meaningful only for the aggregate; per-check rows drop it.
    ]);
    expect(state.reviewStatus).toBe('changes-requested');
    expect(state.baseBranch).toBe('main');
    // No source data for the creation feed yet → field MUST stay undefined.
    expect(state.creationPhase).toBeUndefined();
    expect(state.creationProgress).toBeUndefined();
  });

  it('attaches the merge feed to the refreshed pr_status projection', async () => {
    jest.mocked(getPrMergeProgressFeed).mockReturnValue({
      steps: [{ phase: 'merging' }],
      currentPhase: 'merging',
    });

    const state = await refreshPullRequestState({
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
    });

    expect(state.mergeProgress).toEqual({
      steps: [{ phase: 'merging' }],
      currentPhase: 'merging',
    });
  });

  it('projects each check execution state onto the flat and per-repo payloads', async () => {
    const checkDetails = [
      {
        name: 'build',
        status: 'pending' as const,
        executionState: 'running' as const,
        detailsUrl: 'https://ci.example.com/build',
      },
      {
        name: 'e2e',
        status: 'failing' as const,
        executionState: 'timed_out' as const,
        detailsUrl: null,
      },
      {
        name: 'legacy',
        status: 'passing' as const,
        detailsUrl: null,
      },
    ];
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'acme-api',
          status: {
            prNumber: 42,
            prUrl: 'https://example.com/pr/42',
            state: 'open',
            title: 'Detailed checks',
            checkStatus: 'failing',
            checkDetails,
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-10-03T00:00:00.000Z',
            mergeable: true,
            mergeableState: 'blocked',
          },
        },
      ],
      lastCheckedAt: '2026-10-03T00:00:00.000Z',
    });

    const state = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    const expected = [
      {
        name: 'build',
        status: 'pending',
        executionState: 'running',
        detailsUrl: 'https://ci.example.com/build',
      },
      {
        name: 'e2e',
        status: 'failure',
        executionState: 'timed_out',
        detailsUrl: null,
      },
      // An older desktop's row has no detailed state; the key stays absent.
      { name: 'legacy', status: 'success', detailsUrl: null },
    ];
    expect(state.checkDetails).toEqual(expected);
    expect(state.repos?.[0]?.status?.checkDetails).toEqual(expected);
    // Summary status and merge readiness are untouched by the detail.
    expect(state.checkStatus).toBe('failing');
    expect(state.repos?.[0]?.status?.checkStatus).toBe('failing');
    expect(state.repos?.[0]?.status?.mergeReady).toBe(false);
  });

  it('projects the CAN-1528 L2 fields: detailsUrl, labels, mergeReady, repos', async () => {
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'acme-api',
          status: {
            prNumber: 42,
            prUrl: 'https://example.com/pr/42',
            state: 'open',
            baseRefName: 'main',
            title: 'Add portal fields',
            checkStatus: 'passing',
            checkDetails: [
              {
                name: 'lint',
                status: 'passing',
                detailsUrl: 'https://ci.example.com/lint',
              },
            ],
            reviewStatus: 'none',
            reviewers: [],
            labels: [
              { name: 'bug', color: 'd73a4a', description: 'Bug reports' },
            ],
            hasConflicts: false,
            mergeableState: 'clean',
            commentCount: 3,
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        },
        { repoId: 'repo-2', repoName: 'acme-web', status: null },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });

    const state = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    // Flat fields stay populated from the primary repo for old readers.
    expect(state.number).toBe(42);
    expect(state.checkDetails).toEqual([
      {
        name: 'lint',
        status: 'success',
        detailsUrl: 'https://ci.example.com/lint',
      },
    ]);
    expect(state.reviewStatus).toBe('none');
    expect(state.labels).toEqual([
      { name: 'bug', color: 'd73a4a', description: 'Bug reports' },
    ]);
    // `mergeableState: 'clean'` → ready via the shared isPrReadyToMerge.
    expect(state.mergeReady).toBe(true);
    // repos[] carries every repo, PR-less ones included.
    expect(state.repos).toHaveLength(2);
    expect(state.repos?.[0]).toMatchObject({
      repoId: 'repo-1',
      repoName: 'acme-api',
      status: {
        number: 42,
        url: 'https://example.com/pr/42',
        baseRefName: 'main',
        reviewStatus: 'none',
        mergeReady: true,
      },
    });
    expect(state.repos?.[1]).toEqual({
      repoId: 'repo-2',
      repoName: 'acme-web',
      status: null,
    });
  });

  it('attaches the creation feed and clears a stale error feed once every repo has a PR', async () => {
    const repoWithPr = {
      repoId: 'repo-1',
      repoName: 'acme-api',
      status: {
        prNumber: 7,
        prUrl: 'https://example.com/pr/7',
        state: 'open' as const,
        title: 'Feed',
        checkStatus: 'passing' as const,
        checkDetails: [],
        reviewStatus: 'approved' as const,
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-05-09T00:00:00.000Z',
      },
    };

    beginPrCreationProgress('workspace-1', 'lizard');
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'summarizing',
      repoName: 'acme-api',
    });
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'error',
      repoName: 'acme-web',
      error: 'push rejected',
    });
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'done',
    });

    // One repo still has no PR → the error feed is NOT stale yet.
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        repoWithPr,
        { repoId: 'repo-2', repoName: 'acme-web', status: null },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });
    const partial = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'lizard',
    });
    // Global done after a per-repo error keeps the feed in error, mirroring
    // the renderer reducer.
    expect(partial.creationProgress?.currentPhase).toBe('error');
    // `begin` seeds an empty feed; the three recorded events are the steps.
    expect(partial.creationProgress?.steps).toHaveLength(3);

    // Every repo has a PR now → the stale error feed is dropped.
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        repoWithPr,
        {
          repoId: 'repo-2',
          repoName: 'acme-web',
          status: { ...repoWithPr.status, prNumber: 8 },
        },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });
    const settled = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'lizard',
    });
    expect(settled.creationProgress).toBeNull();
  });

  it('retains successful creation progress until the matching repository has a PR', async () => {
    beginPrCreationProgress('workspace-1', 'lizard');
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'creating_pr',
      repoName: 'acme-api',
    });
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'done',
      repoName: 'acme-api',
    });
    recordPrCreationProgress({
      projectId: 'workspace-1',
      worktreeId: 'lizard',
      phase: 'done',
    });

    mockedFetchPrStatus.mockResolvedValue({
      repos: [{ repoId: 'repo-1', repoName: 'acme-api', status: null }],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });
    const pending = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'lizard',
    });
    expect(pending.creationProgress?.currentPhase).toBe('done');

    for (const staleState of ['closed', 'merged'] as const) {
      mockedFetchPrStatus.mockResolvedValue({
        repos: [
          {
            repoId: 'repo-1',
            repoName: 'acme-api',
            status: {
              prNumber: 6,
              prUrl: 'https://example.com/pr/6',
              state: staleState,
              title: 'Previous pull request',
              checkStatus: 'pending',
              checkDetails: [],
              reviewStatus: 'none',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
          },
        ],
        lastCheckedAt: '2026-05-09T00:00:00.000Z',
      });
      const stale = await refreshPullRequestState({
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'lizard',
      });
      expect(stale.creationProgress?.currentPhase).toBe('done');
    }

    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'acme-api',
          status: {
            prNumber: 7,
            prUrl: 'https://example.com/pr/7',
            state: 'open',
            title: 'Created',
            checkStatus: 'pending',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });
    const settled = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'lizard',
    });
    expect(settled.creationProgress).toBeNull();
  });

  it('pushes a fresh pr_status delta to an active portal after creation settles', async () => {
    mockedIsCanopyPortalActive.mockReturnValue(true);
    mockedFetchPrStatus.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'repo-1',
          status: {
            prNumber: 77,
            prUrl: 'https://example.com/pr/77',
            state: 'open',
            title: 'Fresh after create',
            checkStatus: 'pending',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-05-09T00:00:00.000Z',
    });

    await projectPortalPrStatus('workspace-1', 'gecko');

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    const event = mockedEnqueuePortalEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        scope: 'pr',
        entities: [
          {
            entityType: 'pr_status',
            localId: 'gecko',
            payload: { number: 77, reviewStatus: 'none' },
          },
        ],
      },
    });
  });

  it('clears remembered creation progress from the portal cancellation delta', () => {
    mockedIsCanopyPortalActive.mockReturnValue(true);
    rememberPortalPrState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'gecko',
      number: null,
      creationProgress: {
        steps: [{ phase: 'gathering_changes' }],
        currentPhase: 'gathering_changes',
      },
    });
    beginPrCreationProgress('workspace-1', 'gecko');
    jest.clearAllMocks();
    mockedIsCanopyPortalActive.mockReturnValue(true);

    cancelPrCreationProgress('workspace-1', 'gecko');

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueuePortalEvent.mock.calls[0][0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: { creationProgress: null },
          },
        ],
      },
    });
  });

  it('is a no-op without an active portal session', async () => {
    mockedIsCanopyPortalActive.mockReturnValue(false);
    await projectPortalPrStatus('workspace-1', 'gecko');
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
    expect(mockedFetchPrStatus).not.toHaveBeenCalled();
  });

  it('leaves checkDetails undefined when the desktop has no check data yet', async () => {
    mockedFetchPrStatus.mockResolvedValue(null);

    const state = await refreshPullRequestState({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });

    expect(state.checkDetails).toBeUndefined();
    expect(state.creationPhase).toBeUndefined();
    expect(mockedRefreshNow).not.toHaveBeenCalled();
  });

  it('records a Portal commit even when its push fails', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedHasUncommittedChanges.mockResolvedValue(true);
    jest.mocked(commitWithMessage).mockResolvedValue('commit-sha');
    mockedPushBranch.mockRejectedValueOnce(new Error('push failed'));
    await expect(
      runPrAction({
        action: 'commit_and_push',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        commitMessage: 'Commit',
      }),
    ).rejects.toThrow('push failed');
    expect(recordGitCommitTelemetry).toHaveBeenCalledTimes(1);
    expect(recordGitCommitTelemetry).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      source: 'manual',
      flow: 'portal',
      repoCount: 1,
    });
  });

  it('refreshes desktop PR status after a portal git mutation', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          name: 'Workspace 1',
          repoPath: '/tmp/workspace-1',
          color: 'blue',
          collapsed: false,
          order: 0,
          type: 'single-repo',
          worktrees: [],
        },
      ],
    });
    mockedPushBranch.mockResolvedValue(undefined);
    mockedFetchPrStatus.mockResolvedValue(null);

    await runPrAction({
      action: 'push',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
    });

    expect(mockedRefreshNow).toHaveBeenCalledWith('workspace-1', 'worktree-1');
  });

  it.each(['push', 'commit_and_push'] as const)(
    'schedules shared-container publication after a portal %s action',
    async (action) => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'workspace-1',
            name: 'Workspace 1',
            repoPath: '/tmp/workspace-1',
            color: 'blue',
            collapsed: false,
            order: 0,
            type: 'single-repo',
            worktrees: [],
          },
        ],
      });
      mockedPushBranch.mockResolvedValue(undefined);
      mockedHasUncommittedChanges.mockResolvedValue(false);
      mockedFetchPrStatus.mockResolvedValue(null);

      if (action === 'commit_and_push') {
        await runPrAction({
          action,
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
          commitMessage: 'Publish the current branch',
        });
      } else {
        await runPrAction({
          action,
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
        });
      }

      expect(mockScheduleKnown).toHaveBeenCalledWith(
        'workspace-1',
        'worktree-1',
      );
    },
  );

  it('passes getWindow to the precommit failure hook on commit failures', async () => {
    const error = Object.assign(new Error('commit failed'), {
      stderr: 'precommit failed',
    });
    const getWindow = jest.fn(() => null);
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          name: 'Workspace 1',
          repoPath: '/tmp/workspace-1',
          color: 'blue',
          collapsed: false,
          order: 0,
          type: 'single-repo',
          worktrees: [],
        },
      ],
    });
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedStageAllChanges.mockResolvedValue(undefined);
    mockedCommitWithMessage.mockRejectedValue(error);

    await expect(
      runPrAction(
        {
          action: 'commit_and_push',
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
          commitMessage: 'test commit',
        },
        { getWindow },
      ),
    ).rejects.toThrow('commit failed');

    expect(mockedTriggerWorktreePrecommitFailureHook).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        error,
        commitMessage: 'test commit',
        getWindow,
      }),
    );
  });
});

describe('poller-driven portal PR projection', () => {
  const mergedStatus = {
    repos: [
      {
        repoId: 'repo-1',
        repoName: 'repo-1',
        status: {
          prNumber: 4362,
          prUrl: 'https://github.com/acme/repo/pull/4362',
          state: 'merged' as const,
          title: 'Merged on GitHub',
          checkStatus: 'passing' as const,
          checkDetails: [],
          reviewStatus: 'approved' as const,
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-10-01T20:00:00.000Z',
        },
      },
    ],
    lastCheckedAt: '2026-10-01T20:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    registerPortalPrStatusProjection();
  });

  it('pushes the polled PR status to an active portal without re-fetching GitHub', () => {
    mockedIsCanopyPortalActive.mockReturnValue(true);

    emitWorktreePrStatusChange('workspace-1', 'sturgeon', mergedStatus);

    expect(mockedFetchPrStatus).not.toHaveBeenCalled();
    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueuePortalEvent.mock.calls[0][0]).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        scope: 'pr',
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'sturgeon',
        },
        entities: [
          {
            entityType: 'pr_status',
            localId: 'sturgeon',
            payload: {
              number: 4362,
              state: 'merged',
              repos: [
                {
                  repoId: 'repo-1',
                  status: { number: 4362, state: 'merged' },
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('pushes nothing without an active portal session', () => {
    mockedIsCanopyPortalActive.mockReturnValue(false);

    emitWorktreePrStatusChange('workspace-1', 'sturgeon', mergedStatus);

    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });
});

describe('GitHub authentication errors for remote callers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeCwd.mockReturnValue(process.cwd());
    mockedResolveFreshDefaultBranch.mockResolvedValue('main');
    jest
      .mocked(readAllSidebarItems)
      .mockResolvedValue({ version: 1, items: [] });
    jest
      .mocked(getPushRemoteUrlStrict)
      .mockResolvedValue('https://github.com/acme/repo.git');
  });

  it.each(['push', 'commit_and_push'] as const)(
    'directs %s credential failures to desktop',
    async (action) => {
      jest.mocked(hasUncommittedChanges).mockResolvedValue(false);
      jest
        .mocked(pushBranch)
        .mockRejectedValue(new Error('fatal: Authentication failed'));
      await expect(
        runPrAction({
          action,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          commitMessage: 'changes',
        }),
      ).rejects.toMatchObject({
        code: 'github_not_connected',
        message: 'Connect GitHub on the desktop, then retry.',
      });
      expect(commitWithMessage).not.toHaveBeenCalled();
    },
  );

  it('translates direct PR creation broker failures', async () => {
    mockedCreatePrForRepo.mockRejectedValue(
      new GitHubBrokerError('not_authenticated', 'Login required'),
    );
    await expect(
      createPullRequest({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        title: 'Title',
        body: 'Body',
      }),
    ).rejects.toMatchObject({ code: 'github_not_connected' });
    await expect(
      runPrAction({
        action: 'create',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        title: 'Title',
        body: 'Body',
      }),
    ).rejects.toMatchObject({ code: 'github_not_connected' });
  });

  // CAN-4109 golden: the Portal update_base_branch action keeps the direct
  // library call while the IPC channel moves to core.pullRequest.update.
  it('retargets each tracked PR through the library directly for update_base_branch', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/tmp/workspace');
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'ws-1',
          name: 'Workspace 1',
          type: 'single-repo',
          color: 'blue',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    } as never);
    mockedFetchPrStatus.mockResolvedValue({
      repos: [{ repoId: 'ws-1', status: { prNumber: 355 } }],
    } as never);
    jest.mocked(updatePrBaseBranchForRepo).mockResolvedValue({
      prUrl: 'https://github.com/acme/repo/pull/355',
    });

    await runPrAction({
      action: 'update_base_branch',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      baseBranch: 'release/2026-04',
    } as never);

    expect(updatePrBaseBranchForRepo).toHaveBeenCalledTimes(1);
    expect(updatePrBaseBranchForRepo).toHaveBeenCalledWith(
      '/tmp/workspace',
      355,
      'release/2026-04',
    );
  });

  it('keeps permission errors ordinary', async () => {
    jest
      .mocked(pushBranch)
      .mockRejectedValue(new Error('The requested URL returned error: 403'));
    await expect(
      runPrAction({
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'The requested URL returned error: 403',
    });
  });

  it.each([false, true])(
    'preserves successful pushes and unrelated failures even if status refresh fails: %s',
    async (refreshFails) => {
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'ws-1',
            name: 'Workspace 1',
            type: 'multi-repo',
            color: 'blue',
            repos: [],
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      jest.mocked(listWorkspaceWorktreeRepoEntries).mockResolvedValue([
        { repoId: 'repo-a', repoName: 'A', repoPath: '/tmp/a' },
        { repoId: 'repo-b', repoName: 'B', repoPath: '/tmp/b' },
        { repoId: 'repo-c', repoName: 'C', repoPath: '/tmp/c' },
      ]);
      jest.mocked(pushBranch).mockImplementation((path) => {
        if (path === '/tmp/b')
          return Promise.reject(new Error('Authentication failed'));
        if (path === '/tmp/c')
          return Promise.reject(new Error('non-fast-forward'));
        return Promise.resolve();
      });
      if (refreshFails)
        mockedFetchPrStatus.mockRejectedValueOnce(
          new Error('status unavailable'),
        );
      else mockedFetchPrStatus.mockResolvedValueOnce(null);
      const response = await runPrAction({
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      });
      expect(response).toMatchObject({
        mutationResult: {
          repos: [{ repoId: 'repo-a', repoName: 'A' }],
          failedRepos: [
            expect.objectContaining({
              repoId: 'repo-b',
              failureCode: 'github_not_connected',
            }),
            expect.objectContaining({
              repoId: 'repo-c',
              error: 'non-fast-forward',
            }),
          ],
        },
      });
      expect(pushBranch).toHaveBeenCalledTimes(3);
    },
  );

  it('translates create_auto results and retains partial successes', async () => {
    const success = {
      repoId: 'repo-a',
      repoName: 'A',
      prNumber: 42,
      prUrl: 'https://github.com/a/b/pull/42',
    };
    const failure = {
      repoId: 'repo-b',
      repoName: 'B',
      error: 'Login required',
      status: 'failed',
      failureCode: 'github_not_authenticated',
    } as const;
    const create = jest.fn().mockResolvedValue({
      repos: [],
      failedRepos: [failure],
      skippedRepos: [],
      localOnlyCommittedRepos: [],
    });
    registerWorktreePrActions({
      state: jest.fn().mockResolvedValue({
        busy: false,
        repos: [
          {
            repoId: 'repo-b',
            canCreate: true,
            baseBranch: 'main',
            headBranch: 'feature',
          },
        ],
      }),
      create,
      merge: jest.fn(),
    });
    const request = {
      action: 'create_auto',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      repoIds: ['repo-b'],
      expectedBaseBranch: 'main',
      expectedHeadBranch: 'feature',
    } as const;
    await expect(
      runPrAction({ ...request, repoIds: [...request.repoIds] }),
    ).rejects.toMatchObject({ code: 'github_not_connected' });
    create.mockResolvedValue({
      repos: [success],
      failedRepos: [failure],
      skippedRepos: [],
      localOnlyCommittedRepos: [],
    });
    await expect(
      runPrAction({ ...request, repoIds: [...request.repoIds] }),
    ).resolves.toMatchObject({
      repos: [success],
      failedRepos: [
        {
          ...failure,
          error: 'Connect GitHub on the desktop, then retry.',
          failureCode: 'github_not_connected',
        },
      ],
    });
  });
});

// Portal commit, push and pull mutate the same checkout the desktop Git
// actions do, so they take the same worktree lock, Split check and read-only
// refusal (CAN-4108 PR0).
describe('Portal Git mutations share the desktop Git-action guards', () => {
  const singleRepoSidebar = {
    version: 1 as const,
    items: [
      {
        id: 'workspace-1',
        name: 'Workspace 1',
        repoPath: '/tmp/workspace-1',
        color: 'blue',
        collapsed: false,
        order: 0,
        type: 'single-repo' as const,
        worktrees: [],
      },
    ],
  };
  const target = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
  const SPLIT_LOCK_MESSAGE: unknown = expect.stringContaining(
    'running a Git action',
  );
  type MutationAction = 'push' | 'commit_and_push' | 'pull';
  const request = (
    action: MutationAction,
    workspaceLocalId = 'workspace-1',
  ): Parameters<typeof runPrAction>[0] =>
    action === 'commit_and_push'
      ? {
          action,
          workspaceLocalId,
          worktreeLocalId: 'worktree-1',
          commitMessage: 'Commit',
        }
      : { action, workspaceLocalId, worktreeLocalId: 'worktree-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    resetGitActionCancellationsForTests();
    mockedReadAllSidebarItems.mockResolvedValue(singleRepoSidebar);
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedCommitWithMessage.mockResolvedValue('sha');
    mockedPushBranch.mockResolvedValue(undefined);
    jest.mocked(getCurrentBranch).mockResolvedValue('feature');
    jest.mocked(pullBranchRebase).mockResolvedValue(undefined);
    mockedFetchPrStatus.mockResolvedValue(null);
  });

  afterEach(() => {
    resetGitActionCancellationsForTests();
    releaseSplitLock(target.projectId, target.worktreeId);
  });

  function expectNoGitMutation(): void {
    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();
    expect(pullBranchRebase).not.toHaveBeenCalled();
  }

  it.each(['push', 'commit_and_push', 'pull'] as const)(
    'refuses %s while a desktop Git action holds the worktree',
    async (action) => {
      const scope = beginGitActionCancellationScope(target);
      try {
        await expect(runPrAction(request(action))).rejects.toMatchObject({
          code: 'execution_failed',
          message: 'A Git action is already active for this worktree',
        });
      } finally {
        finishGitActionCancellationScope(target, scope);
      }
      expectNoGitMutation();
    },
  );

  it.each(['push', 'commit_and_push', 'pull'] as const)(
    'refuses %s while a Split PR locks the worktree',
    async (action) => {
      acquireSplitLock(target.projectId, target.worktreeId);
      await expect(runPrAction(request(action))).rejects.toMatchObject({
        code: 'execution_failed',
        message: SPLIT_LOCK_MESSAGE,
      });
      expectNoGitMutation();
    },
  );

  it.each(['push', 'commit_and_push', 'pull'] as const)(
    'refuses %s in a read-only shared-container scope',
    async (action) => {
      await expect(
        runPrAction(request(action, 'shared-container-viewer')),
      ).rejects.toMatchObject({
        code: 'execution_failed',
        message: 'Shared-container recipient workspaces are read-only',
      });
      expectNoGitMutation();
    },
  );

  it.each(['push', 'commit_and_push', 'pull'] as const)(
    'holds the worktree Git-action lock while %s runs, then releases it',
    async (action) => {
      const observed: boolean[] = [];
      const record = (): void => {
        observed.push(isGitActionActive(target));
      };
      mockedPushBranch.mockImplementation(() => {
        record();
        return Promise.resolve();
      });
      jest.mocked(pullBranchRebase).mockImplementation(() => {
        record();
        return Promise.resolve();
      });

      await runPrAction(request(action));

      expect(observed).toEqual([true]);
      expect(isGitActionActive(target)).toBe(false);
    },
  );

  it.each(['push', 'commit_and_push', 'pull'] as const)(
    'reads the PR status for %s only after releasing the lock',
    async (action) => {
      const observed: boolean[] = [];
      mockedFetchPrStatus.mockImplementation(() => {
        observed.push(isGitActionActive(target));
        return Promise.resolve(null);
      });
      mockedRefreshNow.mockImplementation(() => {
        observed.push(isGitActionActive(target));
        return Promise.resolve(null);
      });

      await runPrAction(request(action));

      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((active) => !active)).toBe(true);
    },
  );

  it('releases the lock after a failed Portal push', async () => {
    mockedPushBranch.mockRejectedValue(new Error('push failed'));
    await expect(runPrAction(request('push'))).rejects.toThrow('push failed');
    expect(isGitActionActive(target)).toBe(false);
  });
});
