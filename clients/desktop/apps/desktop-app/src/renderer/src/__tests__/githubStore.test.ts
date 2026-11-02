import type {
  CanopyApi,
  InAppNotificationPreferences,
  OsNotificationPreferences,
  OsNotificationShowRequest,
  OsNotificationShowResponse,
} from '@canopy/desktop-shared/types';
import type {
  GitHubRateLimitEvent,
  PrStatusEvent,
  SplitPrPlanResult,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import {
  __resetForTests as resetOsNotifications,
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
} from '@/lib/osNotifications';
import { useActivityStore } from '@/stores/activityStore';
import {
  furthestCommitPushPhase,
  shouldShowWorktreeMergedState,
  useGitHubStore,
} from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSpaceNotificationStore } from '@/stores/spaceNotificationStore';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type { SpaceNotificationLevel } from '@canopy/protocol/space-notifications';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

describe('githubStore', () => {
  const ANY_STRING: unknown = expect.any(String);
  const loadPreferences = jest.fn();
  const createPr = jest.fn();
  const commitAndPush = jest.fn();
  const generateCommitMessages = jest.fn();
  const cancelGitAction = jest.fn();
  const requestFastRefresh = jest.fn();
  const requestKnownPrFastRefresh = jest.fn();
  const pushOnly = jest.fn();
  const pull = jest.fn();
  const mergeLocalBranches = jest.fn();
  const getChangedFiles = jest.fn();
  const refreshDiffStats = jest.fn();
  const refreshWorktreeDiffStats = jest.fn();
  const refreshWorktreeDiffStatsFromRemote = jest.fn();
  const refreshWorktreesDiffStatsFromRemote = jest.fn();
  const setChangedFiles = jest.fn();
  const planSplitPr = jest.fn<Promise<SplitPrPlanResult>, [unknown]>();

  const showOsNotificationMock = jest.fn<
    Promise<OsNotificationShowResponse>,
    [OsNotificationShowRequest]
  >();
  const onOsNotificationClickedMock = jest.fn(
    (): (() => void) => (): void => {},
  );
  const onOsNotificationClosedMock = jest.fn(
    (): (() => void) => (): void => {},
  );

  const allCategoriesEnabled = {
    chat: true,
    script: true,
    hook: true,
    gitCommit: true,
    gitPush: true,
    prCreate: true,
    pipeline: true,
    terminal: true,
    runComment: true,
    activation: true,
  };

  function applyDefaultInAppPreferences(): void {
    const inAppPreferences: InAppNotificationPreferences = {
      enabled: true,
      placement: 'bottom-right',
      categories: { ...allCategoriesEnabled },
    };
    refreshInAppNotificationPrefs(inAppPreferences);
  }

  function enableOsNotifications(): typeof showOsNotificationMock {
    showOsNotificationMock.mockClear();
    showOsNotificationMock.mockResolvedValue({ shown: true });
    const preferences: OsNotificationPreferences = {
      enabled: true,
      skipWhenFocused: false,
      defaultSound: 'System',
      categories: { ...allCategoriesEnabled },
      categorySounds: {
        chat: 'Default',
        script: 'Default',
        hook: 'Default',
        gitCommit: 'Default',
        gitPush: 'Default',
        prCreate: 'Default',
        pipeline: 'Default',
        terminal: 'Default',
        runComment: 'Default',
        activation: 'Default',
      },
    };
    refreshOsNotificationPrefs(preferences);
    applyDefaultInAppPreferences();
    return showOsNotificationMock;
  }

  function expectGitStateRefreshRequested(): void {
    expect(refreshWorktreeDiffStats).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      skipIfFresh: undefined,
    });
  }

  function openPrRepoStatus(
    repoId = 'repo-1',
    repoName = 'app',
  ): WorktreePrStatus['repos'][number] {
    return {
      repoId,
      repoName,
      status: {
        prNumber: 43,
        prUrl: `https://github.com/example/${repoName}/pull/43`,
        state: 'open',
        title: 'Externally created PR',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-05-05T12:00:00.000Z',
      },
    };
  }

  function prStatus(repos: WorktreePrStatus['repos']): WorktreePrStatus {
    return {
      lastCheckedAt: '2026-05-05T12:00:00.000Z',
      repos,
    };
  }

  function mergedPrRepoStatus(
    repoId = 'repo-1',
    repoName = 'app',
  ): WorktreePrStatus['repos'][number] {
    const repoStatus = openPrRepoStatus(repoId, repoName);
    if (!repoStatus.status) {
      throw new Error('Expected openPrRepoStatus fixture to include PR status');
    }

    return {
      ...repoStatus,
      status: {
        ...repoStatus.status,
        state: 'merged',
        mergedAt: '2026-05-05T12:00:00.000Z',
      },
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    (globalThis as { window?: unknown }).window = {
      api: {
        loadPreferences,
        showOsNotification: showOsNotificationMock,
        onOsNotificationClicked: onOsNotificationClickedMock,
        onOsNotificationClosed: onOsNotificationClosedMock,
        github: {
          createPr,
          commitAndPush,
          generateCommitMessages,
          cancelGitAction,
          requestFastRefresh,
          requestKnownPrFastRefresh,
          pushOnly,
          pull,
          mergeLocalBranches,
          planSplitPr,
          onSplitPrProgress: jest.fn(() => jest.fn()),
          onSplitLockChange: jest.fn(() => jest.fn()),
          getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
        },
        activity: {
          getChangedFiles,
        },
      },
    };

    useGitHubStore.setState({
      prStatuses: {},
      livePrStatusWorktreeKeys: new Set<string>(),
      creatingPr: new Set<string>(),
      creationProgress: {},
      committingAndPushing: new Set<string>(),
      mergingLocalBranches: new Set<string>(),
      gitStatsRefreshing: new Set<string>(),
      gitActionOperationIds: {},
      gitActionIpcPending: new Set<string>(),
      gitActionCancellationRequested: new Set<string>(),
      activeBranchSyncAction: {},
      commitPushProgress: {},
      commitReviewPending: {},
      splitPrPlans: {},
      splitPrResults: {},
      splitPrProgress: {},
      splitPrRefusals: {},
      splitPrExecuteFailures: {},
      splitLockedWorktrees: new Set<string>(),
      splitWorkflowSessions: new Set<string>(),
      planningSplitPr: new Set<string>(),
      splittingPr: new Set<string>(),
      toasts: [],
      notifications: [],
    });
    useProjectsStore.setState({ hasUnpushedCommits: {} } as never);
    useProjectsStore.setState({
      refreshDiffStats,
      refreshWorktreeDiffStats,
      refreshWorktreeDiffStatsFromRemote,
      refreshWorktreesDiffStatsFromRemote,
    } as never);
    useActivityStore.setState({ setChangedFiles } as never);

    refreshDiffStats.mockResolvedValue(undefined);
    refreshWorktreeDiffStats.mockResolvedValue(undefined);
    refreshWorktreeDiffStatsFromRemote.mockResolvedValue(undefined);
    refreshWorktreesDiffStatsFromRemote.mockResolvedValue(undefined);
    setChangedFiles.mockReturnValue(undefined);
    getChangedFiles.mockResolvedValue({ repos: [] });
    requestFastRefresh.mockResolvedValue(undefined);
    requestKnownPrFastRefresh.mockResolvedValue(false);
    loadPreferences.mockResolvedValue({ reviewCommitMessage: false });
    cancelGitAction.mockResolvedValue({
      accepted: true,
      reason: 'cancel_requested',
    });
    applyDefaultInAppPreferences();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    resetOsNotifications();
  });

  // CAN-3053 attempt-2: `livePrStatusWorktreeKeys` is the bookkeeping that
  // lets a row-override consumer tell a genuine live-confirmed `null` PR
  // status apart from `hydratePersistedPrStatuses`'s wholesale copy of the
  // renderer's own (possibly stale) `lastKnownPrStatus`. These tests pin the
  // three ways a key enters or leaves that set.
  describe('livePrStatusWorktreeKeys bookkeeping', () => {
    it('adds the key when a live PrStatusEvent arrives via onPrStatusUpdate', () => {
      let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;
      globalThis.window.api.github = {
        ...globalThis.window.api.github,
        onPrStatusUpdate: jest.fn((handler) => {
          prStatusHandler = handler;
          return jest.fn();
        }),
        onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
        onPrCreationProgress: jest.fn(() => jest.fn()),
        onCommitPushProgress: jest.fn(() => jest.fn()),
      };
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/repos/project-a',
            color: '#111111',
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/live',
                createdAt: '2026-05-04T12:00:00.000Z',
              },
            ],
            collapsed: false,
            order: 0,
          },
        ],
      });

      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/wt-1'),
      ).toBe(false);

      const cleanup = useGitHubStore.getState().subscribeToEvents();
      prStatusHandler?.({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        status: null,
      });

      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/wt-1'),
      ).toBe(true);
      cleanup();
    });

    it('does not add a key when hydratePersistedPrStatuses copies the snapshot, and resets any prior confirmed keys', () => {
      useGitHubStore.setState({
        livePrStatusWorktreeKeys: new Set(['project-a/previously-confirmed']),
      });
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project A',
            repoPath: '/repos/project-a',
            color: '#111111',
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature/hydrated',
                createdAt: '2026-05-04T12:00:00.000Z',
                lastKnownPrStatus: prStatus([openPrRepoStatus()]),
              },
            ],
            collapsed: false,
            order: 0,
          },
        ],
      });

      useGitHubStore
        .getState()
        .hydratePersistedPrStatuses(useProjectsStore.getState().projects);

      expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toEqual(
        prStatus([openPrRepoStatus()]),
      );
      // The key was never live-confirmed by this call, and a full hydration
      // resets any PREVIOUSLY confirmed keys too — they no longer describe
      // trustworthy live state once the wholesale snapshot copy has run.
      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/wt-1'),
      ).toBe(false);
      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/previously-confirmed'),
      ).toBe(false);
      expect(useGitHubStore.getState().livePrStatusWorktreeKeys.size).toBe(0);
    });

    it('marks the key confirmed on an explicit clearWorktreePrStatus (branch change), not just on a live event', () => {
      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/wt-1'),
      ).toBe(false);

      useGitHubStore.getState().clearWorktreePrStatus('project-a', 'wt-1');

      expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBeNull();
      expect(
        useGitHubStore
          .getState()
          .livePrStatusWorktreeKeys.has('project-a/wt-1'),
      ).toBe(true);
    });
  });

  it('does not show merged worktree state from stale done status alone', () => {
    expect(shouldShowWorktreeMergedState('done', null)).toBe(false);
    expect(
      shouldShowWorktreeMergedState('done', {
        lastCheckedAt: '2026-05-05T12:00:00.000Z',
        repos: [],
      }),
    ).toBe(false);
  });

  it('shows merged worktree state only when current PR status is merged', () => {
    expect(
      shouldShowWorktreeMergedState('done', {
        lastCheckedAt: '2026-05-05T12:00:00.000Z',
        repos: [
          {
            repoId: 'repo-1',
            repoName: 'app',
            status: {
              prNumber: 42,
              prUrl: 'https://github.com/example/app/pull/42',
              state: 'merged',
              title: 'Merged PR',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-05-05T12:00:00.000Z',
              mergedAt: '2026-05-05T12:00:00.000Z',
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      shouldShowWorktreeMergedState('done', {
        lastCheckedAt: '2026-05-05T12:00:00.000Z',
        repos: [
          {
            repoId: 'repo-1',
            repoName: 'app',
            status: {
              prNumber: 42,
              prUrl: 'https://github.com/example/app/pull/42',
              state: 'merged',
              title: 'Merged PR',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-05-05T12:00:00.000Z',
              mergedAt: '2026-05-05T12:00:00.000Z',
            },
          },
          {
            repoId: 'repo-2',
            repoName: 'api',
            status: {
              prNumber: 43,
              prUrl: 'https://github.com/example/api/pull/43',
              state: 'open',
              title: 'Open PR',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-05-05T12:00:00.000Z',
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldShowWorktreeMergedState('active', {
        lastCheckedAt: '2026-05-05T12:00:00.000Z',
        repos: [
          {
            repoId: 'repo-1',
            repoName: 'app',
            status: {
              prNumber: 42,
              prUrl: 'https://github.com/example/app/pull/42',
              state: 'merged',
              title: 'Merged PR',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-05-05T12:00:00.000Z',
              mergedAt: '2026-05-05T12:00:00.000Z',
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('surfaces the generic GitHub rate-limit event as a deduplicated GitHub-category toast', () => {
    let rateLimitHandler: ((event: GitHubRateLimitEvent) => void) | undefined;
    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn(() => jest.fn()),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onGitHubRateLimitError: jest.fn((handler) => {
        rateLimitHandler = handler;
        return jest.fn();
      }),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };

    const cleanup = useGitHubStore.getState().subscribeToEvents();

    const primary: GitHubRateLimitEvent = {
      kind: 'primary',
      message:
        'GitHub API rate limit reached. Requests will resume after 3:00 PM.',
      retryAt: '2026-07-20T15:00:00.000Z',
      retryAfterSeconds: 600,
    };
    rateLimitHandler?.(primary);
    // A redelivery for the same pause window (identical retryAt) must not
    // surface a second toast even though the retry countdown ticked down.
    rateLimitHandler?.({ ...primary, retryAfterSeconds: 590 });

    let toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].meta?.category).toBe('GitHub');
    expect(toasts[0].message).toContain('rate limit reached');

    // A new pause window (different retryAt) surfaces a fresh toast.
    rateLimitHandler?.({
      kind: 'secondary',
      message:
        'GitHub is temporarily throttling API requests. Retrying in 30s.',
      retryAt: '2026-07-20T15:30:00.000Z',
      retryAfterSeconds: 30,
    });
    toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1].meta?.category).toBe('GitHub');

    cleanup();
  });

  it('requests a known-PR fast refresh through the GitHub API', async () => {
    requestKnownPrFastRefresh.mockResolvedValue(true);

    await expect(
      useGitHubStore.getState().requestKnownPrFastRefresh('project-a', 'wt-1'),
    ).resolves.toBe(true);

    expect(requestKnownPrFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });
  });

  it('clears stale done state when an open PR status event arrives', () => {
    const openStatus: WorktreePrStatus = {
      lastCheckedAt: '2026-05-05T12:00:00.000Z',
      repos: [
        {
          repoId: 'repo-1',
          repoName: 'app',
          status: {
            prNumber: 43,
            prUrl: 'https://github.com/example/app/pull/43',
            state: 'open',
            title: 'Reused branch PR',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-05-05T12:00:00.000Z',
          },
        },
      ],
    };
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;
    const unsubscribe = jest.fn();

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return unsubscribe;
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/reused',
              createdAt: '2026-05-04T12:00:00.000Z',
              status: 'done',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      status: openStatus,
    });

    const project0 = useProjectsStore.getState().projects[0];
    const worktree =
      project0 && project0.type !== 'cowork'
        ? project0.worktrees.find((candidate) => candidate.id === 'wt-1')
        : undefined;
    expect(worktree?.status).toBeUndefined();
    expect(worktree?.lastKnownPrStatus).toBe(openStatus);
    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBe(
      openStatus,
    );

    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('refreshes the parent branch when a child PR transitions to merged', async () => {
    const openStatus = prStatus([openPrRepoStatus()]);
    const mergedStatus = prStatus([mergedPrRepoStatus()]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
    };
    useGitHubStore.setState({
      prStatuses: {
        'project-a/child': openStatus,
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'parent',
              branchName: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
            {
              id: 'child',
              branchName: 'feature/child',
              trackedBaseBranch: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      baseBranches: {
        'project-a/child': 'feature/parent',
      },
      repoBranches: {},
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'child',
      status: mergedStatus,
    });
    await Promise.resolve();

    expect(refreshWorktreesDiffStatsFromRemote).toHaveBeenCalledWith([
      { projectId: 'project-a', worktreeId: 'parent' },
    ]);
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'parent',
      skipIfFresh: undefined,
    });

    cleanup();
  });

  it('does not refresh the parent branch for an already-merged PR replay', async () => {
    const mergedStatus = prStatus([mergedPrRepoStatus()]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
    };
    useGitHubStore.setState({
      prStatuses: {
        'project-a/child': mergedStatus,
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'parent',
              branchName: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
            {
              id: 'child',
              branchName: 'feature/child',
              trackedBaseBranch: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      baseBranches: {
        'project-a/child': 'feature/parent',
      },
      repoBranches: {},
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'child',
      status: mergedStatus,
    });
    await Promise.resolve();

    expect(refreshWorktreesDiffStatsFromRemote).not.toHaveBeenCalled();
    expect(requestFastRefresh).not.toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'parent',
      skipIfFresh: undefined,
    });

    cleanup();
  });

  it('uses tracked per-repo base branches before aggregate fallback during parent refresh', async () => {
    const openStatus = prStatus([openPrRepoStatus('repo-2', 'api')]);
    const mergedStatus = prStatus([mergedPrRepoStatus('repo-2', 'api')]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
    };
    useGitHubStore.setState({
      prStatuses: {
        'project-a/child': openStatus,
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'project-a',
          name: 'Project A',
          color: '#111111',
          sourceRepoPath: '/repos/project-a',
          worktrees: [
            {
              id: 'parent',
              branchName: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
            {
              id: 'child',
              branchName: 'feature/child',
              trackedBaseBranch: 'develop',
              trackedRepoBaseBranches: {
                'repo-2': 'feature/parent',
              },
              createdAt: '2026-05-04T12:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      baseBranches: {},
      repoBranches: {},
    } as never);

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'child',
      status: mergedStatus,
    });
    await Promise.resolve();

    expect(refreshWorktreesDiffStatsFromRemote).toHaveBeenCalledWith([
      { projectId: 'project-a', worktreeId: 'parent' },
    ]);

    cleanup();
  });

  it('batches parent branch diff-stat refreshes after a child PR merges', async () => {
    const openStatus = prStatus([openPrRepoStatus()]);
    const mergedStatus = prStatus([mergedPrRepoStatus()]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
    };
    useGitHubStore.setState({
      prStatuses: {
        'project-a/child': openStatus,
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'parent-a',
              branchName: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
            {
              id: 'parent-b',
              branchName: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
            {
              id: 'child',
              branchName: 'feature/child',
              trackedBaseBranch: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      baseBranches: {
        'project-a/child': 'feature/parent',
      },
      repoBranches: {},
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'child',
      status: mergedStatus,
    });
    await Promise.resolve();

    expect(refreshWorktreesDiffStatsFromRemote).toHaveBeenCalledTimes(1);
    expect(refreshWorktreesDiffStatsFromRemote).toHaveBeenCalledWith([
      { projectId: 'project-a', worktreeId: 'parent-a' },
      { projectId: 'project-a', worktreeId: 'parent-b' },
    ]);
    expect(refreshWorktreeDiffStatsFromRemote).not.toHaveBeenCalled();
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'parent-a',
      skipIfFresh: undefined,
    });
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'parent-b',
      skipIfFresh: undefined,
    });

    cleanup();
  });

  it('refreshes dependent stats and a loaded changed-files list after its base is retargeted', async () => {
    let dependentBaseBranchesHandler:
      | ((event: {
          updates: Array<{
            projectId: string;
            worktreeId: string;
            previousBaseBranch: string;
            nextBaseBranch: string;
          }>;
        }) => void)
      | undefined;
    const changedFiles = { uncommitted: [], committed: [] };
    getChangedFiles.mockResolvedValue(changedFiles);

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn(() => jest.fn()),
      onDependentBaseBranchesUpdated: jest.fn((handler) => {
        dependentBaseBranchesHandler = handler;
        return jest.fn();
      }),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [
            {
              id: 'child',
              branchName: 'feature/child',
              trackedBaseBranch: 'feature/parent',
              createdAt: '2026-05-04T12:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
      baseBranches: { 'project-a/child': 'feature/parent' },
      repoBranches: {},
      baseBranchExistsLocally: {},
      baseBranchExistsInRemote: {},
    });
    useActivityStore.setState({
      changedFiles: {
        'project-a/child': {
          uncommitted: [],
          committed: [
            {
              path: 'inherited.ts',
              status: 'modified',
              insertions: 10,
              deletions: 1,
            },
          ],
        },
      },
      setChangedFiles,
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    dependentBaseBranchesHandler?.({
      updates: [
        {
          projectId: 'project-a',
          worktreeId: 'child',
          previousBaseBranch: 'feature/parent',
          nextBaseBranch: 'develop',
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshWorktreesDiffStatsFromRemote).toHaveBeenCalledWith([
      { projectId: 'project-a', worktreeId: 'child' },
    ]);
    expect(getChangedFiles).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'child',
    });
    expect(setChangedFiles).toHaveBeenCalledWith(
      'project-a',
      'child',
      changedFiles,
    );

    cleanup();
  });

  it('clears stale PR creation failure progress when every repo has a PR', () => {
    const openStatus = prStatus([openPrRepoStatus()]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };
    useGitHubStore.setState({
      creationProgress: {
        'project-a/wt-1': {
          currentPhase: 'error',
          steps: [
            {
              phase: 'error',
              error: 'failed to create PR',
              timestamp: 1,
            },
          ],
        },
      },
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      status: openStatus,
    });

    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBe(
      openStatus,
    );
    expect(
      useGitHubStore.getState().creationProgress['project-a/wt-1'],
    ).toBeUndefined();

    cleanup();
  });

  it('preserves active PR creation progress when PR status detects a PR', () => {
    const openStatus = prStatus([openPrRepoStatus()]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };
    useGitHubStore.setState({
      creatingPr: new Set(['project-a/wt-1']),
      creationProgress: {
        'project-a/wt-1': {
          currentPhase: 'pushing',
          steps: [
            {
              phase: 'pushing',
              repoName: 'app',
              timestamp: 1,
            },
          ],
        },
      },
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      status: openStatus,
    });

    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBe(
      openStatus,
    );
    expect(
      useGitHubStore.getState().creationProgress['project-a/wt-1'],
    ).toEqual({
      currentPhase: 'pushing',
      steps: [
        {
          phase: 'pushing',
          repoName: 'app',
          timestamp: 1,
        },
      ],
    });

    cleanup();
  });

  it('preserves stale PR creation failure progress for partial multi-repo PR status', () => {
    const partialStatus = prStatus([
      openPrRepoStatus('repo-1', 'app'),
      {
        repoId: 'repo-2',
        repoName: 'api',
        status: null,
      },
    ]);
    let prStatusHandler: ((event: PrStatusEvent) => void) | undefined;

    globalThis.window.api.github = {
      ...globalThis.window.api.github,
      onPrStatusUpdate: jest.fn((handler) => {
        prStatusHandler = handler;
        return jest.fn();
      }),
      onDependentBaseBranchesUpdated: jest.fn(() => jest.fn()),
      onPrCreationProgress: jest.fn(() => jest.fn()),
      onSplitPrProgress: jest.fn(() => jest.fn()),
      onCommitPushProgress: jest.fn(() => jest.fn()),
      onSplitLockChange: jest.fn(() => jest.fn()),
      getSplitLockState: jest.fn(() => Promise.resolve({ locked: [] })),
    };
    useGitHubStore.setState({
      creationProgress: {
        'project-a/wt-1': {
          currentPhase: 'error',
          steps: [
            {
              phase: 'error',
              repoName: 'api',
              error: 'failed to create PR',
              timestamp: 1,
            },
          ],
        },
      },
    });

    const cleanup = useGitHubStore.getState().subscribeToEvents();
    prStatusHandler?.({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      status: partialStatus,
    });

    expect(useGitHubStore.getState().prStatuses['project-a/wt-1']).toBe(
      partialStatus,
    );
    expect(
      useGitHubStore.getState().creationProgress['project-a/wt-1'],
    ).toEqual({
      currentPhase: 'error',
      steps: [
        {
          phase: 'error',
          repoName: 'api',
          error: 'failed to create PR',
          timestamp: 1,
        },
      ],
    });

    cleanup();
  });

  it('routes uncategorized toasts through the Pipeline OS notification category', () => {
    const notificationMock = enableOsNotifications();

    useGitHubStore.getState().addToast('Pipeline action failed', 'error');

    expect(notificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Canopy',
        body: 'Pipeline action failed',
      }),
    );
  });

  it('titles a Pipeline-category OS notification without a title Workflow', () => {
    const notificationMock = enableOsNotifications();

    useGitHubStore
      .getState()
      .addToast('Nightly checks finished.', 'success', undefined, {
        category: 'Pipeline',
      });

    expect(notificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Workflow',
        body: 'Nightly checks finished.',
      }),
    );
  });

  describe('per-space notification choices (CAN-3615)', () => {
    const scope = { projectId: 'project-a', worktreeId: 'wt-1' };
    function saveChoice(override: SpaceNotificationLevel | null): void {
      useSpaceNotificationStore.setState({
        snapshot: {
          ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
          accountKey: 'user-1',
          writesEnabled: true,
          spaces: {
            [spaceNotificationScopeKey(scope)]: {
              notificationSpaceId: 'space-1',
              revision: 1,
              override,
              transitions: [],
            },
          },
        },
      });
    }
    afterEach(() => {
      useSpaceNotificationStore.setState({
        snapshot: EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
        progress: {},
      });
    });

    it('records a muted toast in history with no popup, timer, or banner', () => {
      const notificationMock = enableOsNotifications();
      saveChoice('mute');
      useGitHubStore.setState({ toasts: [], notifications: [] });

      useGitHubStore.getState().addToast('Turn finished', 'info', undefined, {
        category: 'Chat',
        ...scope,
        notificationScope: { ...scope, eventClass: 'attention' },
      });

      expect(useGitHubStore.getState().toasts).toEqual([]);
      expect(useGitHubStore.getState().notifications).toEqual([
        expect.objectContaining({ message: 'Turn finished' }),
      ]);
      expect(jest.getTimerCount()).toBe(0);
      expect(notificationMock).not.toHaveBeenCalled();
    });

    it('lets attention and failures through Needs my attention but not routine work', () => {
      const notificationMock = enableOsNotifications();
      saveChoice('attention');
      useGitHubStore.setState({ toasts: [], notifications: [] });

      for (const eventClass of ['routine', 'failure', 'attention'] as const) {
        useGitHubStore.getState().addToast(eventClass, 'info', undefined, {
          category: 'Pipeline',
          ...scope,
          notificationScope: { ...scope, eventClass },
        });
      }

      expect(
        useGitHubStore.getState().toasts.map((toast) => toast.message),
      ).toEqual(['failure', 'attention']);
      expect(useGitHubStore.getState().notifications).toHaveLength(3);
      expect(notificationMock).toHaveBeenCalledTimes(2);
    });

    it('keeps today’s behavior for a space with no choice and for other spaces', () => {
      const notificationMock = enableOsNotifications();
      saveChoice('mute');
      useGitHubStore.setState({ toasts: [], notifications: [] });

      useGitHubStore.getState().addToast('Other space', 'info', undefined, {
        category: 'Chat',
        notificationScope: {
          projectId: 'project-a',
          worktreeId: 'wt-2',
          eventClass: 'routine',
        },
      });

      expect(useGitHubStore.getState().toasts).toHaveLength(1);
      expect(notificationMock).toHaveBeenCalledTimes(1);
    });

    it('records nothing for a muted toast whose category is off in-app, as before', () => {
      const notificationMock = enableOsNotifications();
      refreshInAppNotificationPrefs({
        enabled: true,
        placement: 'bottom-right',
        categories: { ...allCategoriesEnabled, chat: false },
      });
      saveChoice('mute');
      useGitHubStore.setState({ toasts: [], notifications: [] });

      useGitHubStore.getState().addToast('Turn finished', 'info', undefined, {
        category: 'Chat',
        notificationScope: { ...scope, eventClass: 'routine' },
      });

      expect(useGitHubStore.getState().notifications).toEqual([]);
      expect(notificationMock).not.toHaveBeenCalled();
    });
  });

  it('does not turn post-create refresh failures into PR create errors', async () => {
    createPr.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', prNumber: 1, prUrl: '' }],
      skippedRepos: [],
      localOnlyCommittedRepos: [],
    });
    refreshWorktreeDiffStats.mockRejectedValue(
      new Error('failed with exit code 1'),
    );

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    expect(createPr).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: undefined,
      operationId: ANY_STRING,
    });
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      skipIfFresh: undefined,
    });
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('still reports PR create IPC failures', async () => {
    createPr.mockRejectedValue(new Error('create failed'));

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    const toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    const toast = toasts[0];
    if (!toast) {
      throw new Error('Expected PR create failure toast');
    }
    expect(toast.message).toBe('create failed');
    expect(toast.type).toBe('error');
    expect(toast.meta?.category).toBe('PR Create');
    expect(toast.meta?.projectId).toBe('project-a');
    expect(toast.meta?.worktreeId).toBe('wt-1');
    expect(refreshWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('createPr with review commits approved messages before creating the PR', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'review me' }],
      failedRepos: [],
      skippedRepos: [],
    });
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          commitHash: 'abc123',
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });
    createPr.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', prNumber: 1, prUrl: '' }],
      skippedRepos: [],
      localOnlyCommittedRepos: [],
    });

    const flow = useGitHubStore
      .getState()
      .createPr('project-a', 'wt-1', ['repo-a']);
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }

    expect(
      useGitHubStore.getState().commitReviewPending['project-a/wt-1']
        ?.actionLabel,
    ).toBe('Commit, push & create PR');

    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'approved message' },
      ]);
    await flow;

    expect(generateCommitMessages).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-a'],
      operationId: ANY_STRING,
    });
    expect(commitAndPush).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      messages: [
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          message: 'approved message',
        },
      ],
      requireReviewedMessages: true,
      telemetryFlow: 'pull_request',
      repoIds: ['repo-a'],
      operationId: ANY_STRING,
    });
    expect(createPr).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-a'],
      operationId: ANY_STRING,
    });
    expect(commitAndPush.mock.invocationCallOrder[0]).toBeLessThan(
      createPr.mock.invocationCallOrder[0],
    );
  });

  it('createPr with review stops when commit message review is cancelled', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'review me' }],
      failedRepos: [],
      skippedRepos: [],
    });

    const flow = useGitHubStore.getState().createPr('project-a', 'wt-1');
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }

    useGitHubStore.getState().resolveCommitReview('project-a', 'wt-1', false);
    await flow;

    expect(commitAndPush).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().creatingPr.has('project-a/wt-1')).toBe(
      false,
    );
    expect(
      useGitHubStore.getState().creationProgress['project-a/wt-1'],
    ).toBeUndefined();
  });

  it('createPr with review marks progress as error when all message generation fails', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [],
      failedRepos: [
        {
          repoName: 'repo-a',
          error: 'generation failed',
        },
      ],
      skippedRepos: [],
    });

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    expect(createPr).not.toHaveBeenCalled();
    const progress =
      useGitHubStore.getState().creationProgress['project-a/wt-1'];
    expect(progress?.currentPhase).toBe('error');
    expect(progress?.steps).toContainEqual(
      expect.objectContaining({
        phase: 'error',
        error: 'Commit message generation failed; PR creation was aborted.',
      }),
    );
  });

  it('createPr with review aborts when no repos are eligible for review', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [],
      failedRepos: [],
      skippedRepos: [
        {
          repoName: 'repo-a',
          reason: 'no_remote_tracking',
        },
      ],
    });

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    expect(createPr).not.toHaveBeenCalled();
    const progress =
      useGitHubStore.getState().creationProgress['project-a/wt-1'];
    expect(progress?.currentPhase).toBe('error');
    expect(progress?.steps).toContainEqual(
      expect.objectContaining({
        phase: 'error',
        error:
          'Commit message review is required before PR creation, but no repositories were eligible for review.',
      }),
    );
  });

  it('createPr with review continues when clean repos have no uncommitted changes', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [],
      failedRepos: [],
      skippedRepos: [
        {
          repoName: 'repo-a',
          reason: 'no_uncommitted_changes',
        },
      ],
    });
    createPr.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', prNumber: 1, prUrl: '' }],
      skippedRepos: [],
      localOnlyCommittedRepos: [],
    });

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    expect(commitAndPush).not.toHaveBeenCalled();
    expect(createPr).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: undefined,
      operationId: ANY_STRING,
    });
  });

  it('createPr with review marks progress as error when commit and push fails', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'review me' }],
      failedRepos: [],
      skippedRepos: [],
    });
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc123',
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      failedRepos: [
        {
          repoName: 'repo-b',
          error: 'push failed',
          status: 'failed',
        },
      ],
      skippedRepos: [],
      agentResolutionRepos: [],
    });

    const flow = useGitHubStore.getState().createPr('project-a', 'wt-1');
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }

    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'approved message' },
      ]);
    await flow;

    expect(createPr).not.toHaveBeenCalled();
    const progress =
      useGitHubStore.getState().creationProgress['project-a/wt-1'];
    expect(progress?.currentPhase).toBe('error');
    expect(progress?.steps).toContainEqual(
      expect.objectContaining({
        phase: 'error',
        error: 'Commit & push failed; PR creation was aborted.',
      }),
    );
    expectGitStateRefreshRequested();
  });

  it('createPr with review marks progress as error when agent resolution is required', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'review me' }],
      failedRepos: [],
      skippedRepos: [],
    });
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc123',
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [
        {
          repoName: 'repo-b',
          chatId: 'chat-1',
          kind: 'rebase_conflict',
        },
      ],
    });

    const flow = useGitHubStore.getState().createPr('project-a', 'wt-1');
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }

    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'approved message' },
      ]);
    await flow;

    expect(createPr).not.toHaveBeenCalled();
    const progress =
      useGitHubStore.getState().creationProgress['project-a/wt-1'];
    expect(progress?.currentPhase).toBe('error');
    expect(progress?.steps).toContainEqual(
      expect.objectContaining({
        phase: 'error',
        error:
          'Commit & push requires agent resolution; PR creation was aborted.',
      }),
    );
    // The toast that announces the resolution chat is a shortcut back to it.
    // The chat id stays out of the metadata: with one present the OS
    // notification gate keys on that chat instead of the worktree and could
    // fire a native banner over the toast.
    const resolutionToast = useGitHubStore
      .getState()
      .toasts.find((toast) =>
        toast.message.includes('An agent chat has been started'),
      );
    expect(resolutionToast?.type).toBe('warning');
    expect(resolutionToast?.meta).toEqual(
      expect.objectContaining({ projectId: 'project-a', worktreeId: 'wt-1' }),
    );
    expect(resolutionToast?.meta?.chatId).toBeUndefined();
    expect(resolutionToast?.onClick).toBeDefined();
    expectGitStateRefreshRequested();
  });

  it('createPr with review aborts when commit and push skips an unsafe repo', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'review me' }],
      failedRepos: [],
      skippedRepos: [],
    });
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc123',
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      failedRepos: [],
      skippedRepos: [
        {
          repoName: 'repo-b',
          reason: 'no_remote_tracking',
        },
      ],
      agentResolutionRepos: [],
    });

    const flow = useGitHubStore
      .getState()
      .createPr('project-a', 'wt-1', ['repo-a', 'repo-b']);
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }

    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'approved message' },
      ]);
    await flow;

    expect(createPr).not.toHaveBeenCalled();
    const progress =
      useGitHubStore.getState().creationProgress['project-a/wt-1'];
    expect(progress?.currentPhase).toBe('error');
    expect(progress?.steps).toContainEqual(
      expect.objectContaining({
        phase: 'error',
        error:
          'Commit & push skipped repositories that require reviewed PR creation; PR creation was aborted.',
      }),
    );
    expectGitStateRefreshRequested();
  });

  it('surfaces partial commit-and-push failures and skips from the IPC response', async () => {
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc123',
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      failedRepos: [
        {
          repoName: 'repo-b',
          error: 'push failed',
          status: 'failed',
        },
      ],
      skippedRepos: [
        {
          repoName: 'repo-c',
          reason: 'no_remote_tracking',
        },
      ],
      agentResolutionRepos: [],
    });

    await useGitHubStore.getState().commitAndPush('project-a', 'wt-1');

    // Scoped to the acted-on worktree (not a global all-worktrees sweep).
    expect(refreshWorktreeDiffStats).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      skipIfFresh: undefined,
    });

    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toEqual(
      expect.arrayContaining([
        'Commit & push failed for 1 repo: repo-b (push failed)',
        'Commit & push skipped 1 repo: repo-c (no remote tracking branch)',
      ]),
    );
  });

  it('waits for the coordinated worktree refresh after commit/push', async () => {
    commitAndPush.mockResolvedValue({
      repos: [],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });
    // The projects-store refresh owns both diff stats and Changed Files now;
    // the GitHub fast refresh must wait for that coordinated local refresh.
    let releaseDiffStats: () => void = (): void => {};
    refreshWorktreeDiffStats.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseDiffStats = (): void => resolve(undefined);
      }),
    );

    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(refreshWorktreeDiffStats).toHaveBeenCalledWith('project-a', 'wt-1');
    expect(requestFastRefresh).not.toHaveBeenCalled();

    releaseDiffStats();
    await flow;
    expect(requestFastRefresh).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      skipIfFresh: undefined,
    });
  });

  it('marks git stats refreshing (button busy) until the refresh settles', async () => {
    commitAndPush.mockResolvedValue({
      repos: [],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });
    let releaseDiffStats: () => void = (): void => {};
    refreshWorktreeDiffStats.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseDiffStats = (): void => resolve(undefined);
      }),
    );

    const key = 'project-a/wt-1';
    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    // Mid-refresh: the action's busy flag stays set (no stale-clickable button),
    // and the dedicated refreshing flag is on (button shows "Refreshing…").
    expect(useGitHubStore.getState().committingAndPushing.has(key)).toBe(true);
    expect(useGitHubStore.getState().gitStatsRefreshing.has(key)).toBe(true);

    releaseDiffStats();
    await flow;

    // Both clear once the refresh settles.
    expect(useGitHubStore.getState().committingAndPushing.has(key)).toBe(false);
    expect(useGitHubStore.getState().gitStatsRefreshing.has(key)).toBe(false);
  });

  it('requests cancellation and refreshes after the mutation settles', async () => {
    let releaseCommit: (value: unknown) => void = (): void => {};
    commitAndPush.mockReturnValue(
      new Promise((resolve) => {
        releaseCommit = resolve;
      }),
    );

    const key = 'project-a/wt-1';
    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const operationId = useGitHubStore.getState().gitActionOperationIds[key];
    expect(operationId).toEqual(expect.any(String));

    const cancelling = useGitHubStore
      .getState()
      .cancelGitAction('project-a', 'wt-1');
    await expect(cancelling).resolves.toEqual({
      accepted: true,
      reason: 'cancel_requested',
    });
    expect(cancelGitAction).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      operationId,
    });
    expect(
      useGitHubStore.getState().gitActionCancellationRequested.has(key),
    ).toBe(true);

    releaseCommit({
      repos: [],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
      cancelled: true,
    });
    await flow;

    expectGitStateRefreshRequested();
    expect(useGitHubStore.getState().committingAndPushing.has(key)).toBe(false);
    expect(
      useGitHubStore.getState().gitActionOperationIds[key],
    ).toBeUndefined();
    expect(
      useGitHubStore.getState().gitActionCancellationRequested.has(key),
    ).toBe(false);
  });

  it('clears optimistic cancellation when the main process rejects it', async () => {
    let releaseCommit: (value: unknown) => void = (): void => {};
    commitAndPush.mockReturnValue(
      new Promise((resolve) => {
        releaseCommit = resolve;
      }),
    );
    cancelGitAction.mockResolvedValue({
      accepted: false,
      reason: 'not_active',
    });

    const key = 'project-a/wt-1';
    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(useGitHubStore.getState().gitActionIpcPending.has(key)).toBe(true);
    await expect(
      useGitHubStore.getState().cancelGitAction('project-a', 'wt-1'),
    ).resolves.toEqual({ accepted: false, reason: 'not_active' });
    expect(
      useGitHubStore.getState().gitActionCancellationRequested.has(key),
    ).toBe(false);

    releaseCommit({
      repos: [],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });
    await flow;

    expectGitStateRefreshRequested();
  });

  it('reports renderer-owned cancellation as accepted between IPC stages', async () => {
    cancelGitAction.mockResolvedValue({
      accepted: false,
      reason: 'not_active',
    });
    const key = 'project-a/wt-1';
    useGitHubStore.setState({
      gitActionOperationIds: { [key]: 'operation-1' },
      gitActionIpcPending: new Set<string>(),
    });

    await expect(
      useGitHubStore.getState().cancelGitAction('project-a', 'wt-1'),
    ).resolves.toEqual({ accepted: true, reason: 'cancel_requested' });
    expect(
      useGitHubStore.getState().gitActionCancellationRequested.has(key),
    ).toBe(true);
  });

  it('does not request cancellation during the refresh phase', async () => {
    const key = 'project-a/wt-1';
    useGitHubStore.setState({
      gitActionOperationIds: { [key]: 'operation-1' },
      gitStatsRefreshing: new Set([key]),
    });

    await expect(
      useGitHubStore.getState().cancelGitAction('project-a', 'wt-1'),
    ).resolves.toEqual({ accepted: false, reason: 'refreshing' });

    expect(cancelGitAction).not.toHaveBeenCalled();
    expect(
      useGitHubStore.getState().gitActionCancellationRequested.has(key),
    ).toBe(false);
  });

  it('shows generating_message while the backend generates the commit message (no review)', async () => {
    // Without review, the backend generates the message during commitAndPush,
    // so the optimistic phase must stay at generating_message — jumping ahead
    // to staging would pin the tooltip there via the monotonic phase clamp.
    let releaseCommit: () => void = (): void => {};
    commitAndPush.mockReturnValue(
      new Promise((resolve) => {
        releaseCommit = (): void =>
          resolve({
            repos: [],
            failedRepos: [],
            skippedRepos: [],
            agentResolutionRepos: [],
          });
      }),
    );

    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(
      useGitHubStore.getState().commitPushProgress['project-a/wt-1']
        ?.currentPhase,
    ).toBe('generating_message');

    releaseCommit();
    await flow;
  });

  it('advances to staging after an approved review (message already generated)', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'wip' }],
      failedRepos: [],
      skippedRepos: [],
    });
    let releaseCommit: () => void = (): void => {};
    commitAndPush.mockReturnValue(
      new Promise((resolve) => {
        releaseCommit = (): void =>
          resolve({
            repos: [],
            failedRepos: [],
            skippedRepos: [],
            agentResolutionRepos: [],
          });
      }),
    );

    const flow = useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }
    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'wip' },
      ]);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    // The reviewed message is passed to the backend, which skips generation
    // and starts at staging.
    expect(
      useGitHubStore.getState().commitPushProgress['project-a/wt-1']
        ?.currentPhase,
    ).toBe('staging');

    releaseCommit();
    await flow;
  });

  it('aborts reviewed commit flow when all repos fail to generate', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [],
      failedRepos: [
        {
          repoName: 'repo-a',
          error: 'generation failed',
        },
      ],
      skippedRepos: [],
    });

    await useGitHubStore.getState().commitAndPush('project-a', 'wt-1');

    expect(commitAndPush).not.toHaveBeenCalled();
    expect(refreshWorktreeDiffStats).not.toHaveBeenCalled();
    expect(requestFastRefresh).not.toHaveBeenCalled();
    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toContain(
      'Commit message generation failed for 1 repo: repo-a (generation failed)',
    );
  });

  it('commitOnly without review forwards repoIds and commitOnly: true', async () => {
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc',
          status: 'success',
          operation: 'commit',
        },
      ],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });

    await useGitHubStore.getState().commitOnly('project-a', 'wt-1', ['repo-a']);

    expect(commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        commitOnly: true,
        repoIds: ['repo-a'],
      }),
    );
    expect(refreshWorktreeDiffStats).toHaveBeenCalled();
  });

  it('commitOnly with review calls generateCommitMessages with repoIds', async () => {
    loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
    generateCommitMessages.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'wip' }],
      failedRepos: [],
      skippedRepos: [],
    });
    commitAndPush.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          commitHash: 'abc',
          status: 'success',
          operation: 'commit',
        },
      ],
      failedRepos: [],
      skippedRepos: [],
      agentResolutionRepos: [],
    });

    const promise = useGitHubStore
      .getState()
      .commitOnly('project-a', 'wt-1', ['repo-a']);

    // Wait until the review handshake has actually been registered on the
    // store before resolving it, otherwise the resolver from the awaited
    // Promise is not yet present.
    for (let i = 0; i < 30; i++) {
      if (useGitHubStore.getState().commitReviewPending['project-a/wt-1']) {
        break;
      }
      await Promise.resolve();
    }
    useGitHubStore
      .getState()
      .resolveCommitReview('project-a', 'wt-1', true, [
        { repoId: 'repo-a', repoName: 'repo-a', message: 'wip' },
      ]);
    await promise;

    expect(generateCommitMessages).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-a'],
      operationId: ANY_STRING,
      commitOnly: true,
    });
    expect(commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        commitOnly: true,
        repoIds: ['repo-a'],
        requireReviewedMessages: true,
        messages: [{ repoId: 'repo-a', repoName: 'repo-a', message: 'wip' }],
      }),
    );
    // Modal carries the commit-only action label.
    // (We can't assert this after `await promise` because the entry is
    // cleaned up in `finally`; we capture it pre-resolution instead.)
  });

  it('does not replace an active Git operation with a second commit flow', async () => {
    const key = 'project-a/wt-1';
    useGitHubStore.setState({
      committingAndPushing: new Set([key]),
      activeBranchSyncAction: { [key]: 'commit-and-push' },
      gitActionOperationIds: { [key]: 'existing-operation' },
    });

    await useGitHubStore.getState().commitOnly('project-a', 'wt-1');

    expect(generateCommitMessages).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().committingAndPushing).toEqual(
      new Set([key]),
    );
    expect(useGitHubStore.getState().activeBranchSyncAction[key]).toBe(
      'commit-and-push',
    );
    expect(useGitHubStore.getState().gitActionOperationIds[key]).toBe(
      'existing-operation',
    );
  });

  it('does not start a commit flow while Create PR is active', async () => {
    const key = 'project-a/wt-1';
    useGitHubStore.setState({
      creatingPr: new Set([key]),
      gitActionOperationIds: { [key]: 'create-pr-operation' },
    });

    await useGitHubStore.getState().commitOnly('project-a', 'wt-1');

    expect(generateCommitMessages).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().creatingPr).toEqual(new Set([key]));
    expect(useGitHubStore.getState().gitActionOperationIds[key]).toBe(
      'create-pr-operation',
    );
  });

  it('mergeLocalBranches refreshes diff/activity state on success', async () => {
    mergeLocalBranches.mockResolvedValue({
      repos: [
        {
          repoName: 'repo-a',
          branchName: 'feat',
          baseBranch: 'main',
          mergeCommitHash: 'def456',
          status: 'success',
        },
      ],
      skippedRepos: [],
      failedRepos: [],
    });

    await useGitHubStore
      .getState()
      .mergeLocalBranches('project-a', 'wt-1', ['repo-a']);

    expect(mergeLocalBranches).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-a'],
      operationId: ANY_STRING,
    });
    expect(refreshWorktreeDiffStats).toHaveBeenCalled();
    expect(requestFastRefresh).toHaveBeenCalled();
    const messages = useGitHubStore.getState().toasts.map((t) => t.message);
    expect(messages).toContain(
      'Merged 1 local-only repo into the default branch.',
    );
  });

  it('pushOnly renders no_remote_origin skips with a human-readable reason', async () => {
    pushOnly.mockResolvedValue({
      repos: [],
      skippedRepos: [
        {
          repoName: 'repo-a',
          reason: 'no_remote_origin',
        },
      ],
      failedRepos: [],
    });

    await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toEqual(
      expect.arrayContaining([
        'Push skipped 1 repo: repo-a (no origin remote)',
      ]),
    );
  });

  it('pull renders no_remote_origin skips with a human-readable reason', async () => {
    pull.mockResolvedValue({
      repos: [],
      skippedRepos: [
        {
          repoName: 'repo-a',
          reason: 'no_remote_origin',
        },
      ],
      failedRepos: [],
      agentResolutionRepos: [],
    });

    await useGitHubStore.getState().pull('project-a', 'wt-1');

    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toEqual(
      expect.arrayContaining([
        'Pull skipped 1 repo: repo-a (no origin remote)',
      ]),
    );
  });

  it('pull reports agent-started rebase resolution', async () => {
    pull.mockResolvedValue({
      repos: [],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [
        {
          repoName: 'repo-a',
          chatId: 'chat-1',
          kind: 'rebase_conflict',
        },
      ],
    });

    await useGitHubStore.getState().pull('project-a', 'wt-1');

    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toContain(
      'repo-a: rebase conflicts detected during pull. An agent chat has been started to resolve and finish the pull.',
    );
  });

  it('refreshes branch state when pull rejects after the remote branch is deleted', async () => {
    pull.mockRejectedValue(
      new Error("fatal: couldn't find remote ref feature-branch"),
    );

    await useGitHubStore.getState().pull('project-a', 'wt-1');

    expectGitStateRefreshRequested();
    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toContain("fatal: couldn't find remote ref feature-branch");
  });

  it('mergeLocalBranches surfaces actionable skips and per-repo failures', async () => {
    mergeLocalBranches.mockResolvedValue({
      repos: [],
      skippedRepos: [
        {
          repoName: 'repo-a',
          reason: 'has_remote_origin',
        },
        {
          repoName: 'repo-b',
          reason: 'uncommitted_changes',
        },
      ],
      failedRepos: [
        {
          repoName: 'repo-c',
          error: 'merge conflict',
          status: 'failed',
        },
      ],
    });

    await useGitHubStore.getState().mergeLocalBranches('project-a', 'wt-1');

    const toasts = useGitHubStore.getState().toasts;
    const messages = toasts.map((t) => t.message);
    // Routine `has_remote_origin` filter is suppressed; only the actionable
    // skip is toasted.
    expect(messages).toEqual(
      expect.arrayContaining([
        'Merge skipped 1 repo: repo-b (uncommitted changes)',
        'Merge failed for repo-c: merge conflict',
      ]),
    );
    expect(
      messages.some((message) => message.includes('has_remote_origin')),
    ).toBe(false);
    expect(
      messages.some((message) =>
        message.includes('repo-a (has remote origin)'),
      ),
    ).toBe(false);
    expect(refreshWorktreeDiffStats).toHaveBeenCalled();
    expect(requestFastRefresh).toHaveBeenCalled();
  });

  it('createPr emits info toasts for local-only commits and skipped repos', async () => {
    createPr.mockResolvedValue({
      repos: [{ repoId: 'repo-a', repoName: 'repo-a', prNumber: 1, prUrl: '' }],
      skippedRepos: [
        { repoId: 'repo-c', repoName: 'repo-c', reason: 'no_remote_origin' },
      ],
      localOnlyCommittedRepos: [
        { repoId: 'repo-b', repoName: 'repo-b', commitHash: 'abc' },
      ],
    });

    await useGitHubStore.getState().createPr('project-a', 'wt-1');

    const toasts = useGitHubStore.getState().toasts;
    const messages = toasts.map((t) => t.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Committed local-only changes in repo-b.',
        'Skipped PR creation for local-only repos: repo-c (no origin remote).',
      ]),
    );
    const commitToast = toasts.find((t) =>
      t.message.startsWith('Committed local-only'),
    );
    expect(commitToast?.meta?.category).toBe('Git Commit');
    const skipToast = toasts.find((t) =>
      t.message.startsWith('Skipped PR creation'),
    );
    expect(skipToast?.meta?.category).toBe('PR Create');
  });

  it('planSplitPr clears stale split results/progress for the key at attempt start', async () => {
    const key = 'project-a/wt-1';
    useGitHubStore.setState({
      splitPrResults: {
        [key]: {
          version: 1,
          originalPrNumber: 1,
          originalPrUrl: 'https://github.com/example/app/pull/1',
          originalBaseBranch: 'main',
          originalHeadBranch: 'feature/split',
          originalHeadSha: 'abc123',
          integrationBranch: 'split/integration',
          originalWorktreeId: 'wt-1',
          children: [],
          status: 'completed',
          createdAt: '2026-05-05T12:00:00.000Z',
          updatedAt: '2026-05-05T12:00:00.000Z',
        },
      },
      splitPrProgress: {
        [key]: [
          {
            projectId: 'project-a',
            worktreeId: 'wt-1',
            phase: 'cancelled',
          },
        ],
      },
    });

    planSplitPr.mockResolvedValue({
      status: 'ok',
      response: {
        plan: {
          finalGoal: 'Split the PR',
          concerns: [],
          children: [],
          parallelizable: '',
          landOrder: '',
          buildTestCommand: '',
          unassignedHunks: [],
        },
        snapshot: {
          baseRef: 'main',
          headRef: 'def456',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        },
        originalPr: {
          prNumber: 2,
          prUrl: 'https://github.com/example/app/pull/2',
          baseBranch: 'main',
          headBranch: 'feature/split-2',
          headSha: 'def456',
        },
      },
    });

    await useGitHubStore.getState().planSplitPr('project-a', 'wt-1');

    expect(useGitHubStore.getState().splitPrResults[key]).toBeUndefined();
    expect(useGitHubStore.getState().splitPrProgress[key]).toBeUndefined();
    expect(useGitHubStore.getState().splitPrPlans[key]).toBeUndefined();
  });

  it('stores a regenerated split plan only while the split workflow is still active', async () => {
    const key = 'project-a/wt-1';
    const response = {
      plan: {
        finalGoal: 'Split the PR',
        concerns: [],
        children: [],
        parallelizable: '',
        landOrder: '',
        buildTestCommand: '',
        unassignedHunks: [],
      },
      snapshot: {
        baseRef: 'main',
        headRef: 'def456',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      },
      originalPr: {
        prNumber: 2,
        prUrl: 'https://github.com/example/app/pull/2',
        baseBranch: 'main',
        headBranch: 'feature/split-2',
        headSha: 'def456',
      },
    };
    planSplitPr.mockResolvedValue({ status: 'ok', response });

    useGitHubStore.setState({
      splitLockedWorktrees: new Set([key]),
      splitWorkflowSessions: new Set([key]),
    });

    await useGitHubStore.getState().planSplitPr('project-a', 'wt-1');
    expect(useGitHubStore.getState().splitPrPlans[key]).toBe(response);

    useGitHubStore.setState({
      splitPrPlans: {},
      splitLockedWorktrees: new Set<string>(),
      splitWorkflowSessions: new Set<string>(),
    });

    await useGitHubStore.getState().planSplitPr('project-a', 'wt-1');
    expect(useGitHubStore.getState().splitPrPlans[key]).toBeUndefined();
  });
});

describe('furthestCommitPushPhase', () => {
  it('advances forward through the phase order', () => {
    expect(furthestCommitPushPhase('generating_message', 'staging')).toBe(
      'staging',
    );
    expect(furthestCommitPushPhase('staging', 'pushing')).toBe('pushing');
  });

  it('does not regress to an earlier phase (Staging stays past Generating)', () => {
    expect(furthestCommitPushPhase('staging', 'generating_message')).toBe(
      'staging',
    );
    expect(furthestCommitPushPhase('pushing', 'pulling')).toBe('pushing');
  });

  it('takes the incoming phase when there is no previous phase', () => {
    expect(furthestCommitPushPhase(undefined, 'pulling')).toBe('pulling');
  });

  it('lets error win and stay sticky', () => {
    expect(furthestCommitPushPhase('staging', 'error')).toBe('error');
    expect(furthestCommitPushPhase('error', 'pushing')).toBe('error');
  });

  it('keeps done from regressing', () => {
    expect(furthestCommitPushPhase('done', 'staging')).toBe('done');
    expect(furthestCommitPushPhase('pushing', 'done')).toBe('done');
  });
});
