import type { CanopyApi } from '@canopy/desktop-shared/types';
import type {
  CommitAndPushResponse,
  CreatePrResponse,
  PushOnlyResponse,
  RepoFailureResult,
} from '@canopy/desktop-shared/types/github';
import {
  probeGitHubConnected,
  settleGitHubLogin,
} from '@/lib/githubConnection';
import { settleGitHubConnectOffer } from '@/lib/githubConnectOffer';
import {
  hasPendingGitHubConnectOffer,
  useGitHubConnectOfferStore,
} from '@/stores/githubConnectOfferStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

jest.mock('@/lib/githubConnection', () => ({
  settleGitHubLogin: jest.fn(),
  probeGitHubConnected: jest.fn(),
}));

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const AUTH_ERROR = 'Authentication failed for https://github.com/acme/app.git';

function authFailure(repoId = 'repo-1', repoName = 'app'): RepoFailureResult {
  return {
    repoId,
    repoName,
    error: AUTH_ERROR,
    status: 'failed',
    failureCode: 'github_not_authenticated',
  };
}

function pushResponse(
  overrides: Partial<PushOnlyResponse> = {},
): PushOnlyResponse {
  return { repos: [], skippedRepos: [], failedRepos: [], ...overrides };
}

function commitResponse(
  overrides: Partial<CommitAndPushResponse> = {},
): CommitAndPushResponse {
  return {
    repos: [],
    skippedRepos: [],
    failedRepos: [],
    agentResolutionRepos: [],
    ...overrides,
  };
}

function prResponse(
  overrides: Partial<CreatePrResponse> = {},
): CreatePrResponse {
  return {
    repos: [],
    skippedRepos: [],
    localOnlyCommittedRepos: [],
    ...overrides,
  };
}

describe('GitHub connect offer', () => {
  const pushOnly = jest.fn<Promise<PushOnlyResponse>, [unknown]>();
  const commitAndPush = jest.fn<Promise<CommitAndPushResponse>, [unknown]>();
  const createPr = jest.fn<Promise<CreatePrResponse>, [unknown]>();
  const generateCommitMessages = jest.fn();
  const loadPreferences = jest.fn();
  const addToast = jest.fn();
  const requestFastRefresh = jest.fn();
  const refreshWorktreeDiffStats = jest.fn();
  const settle = jest.mocked(settleGitHubLogin);
  const getWorktreePath = jest.fn();
  const getRepoSlug = jest.fn();

  function setBranch(branch: string): void {
    useProjectsStore.setState({
      repoBranches: {
        'project-a/wt-1': [
          { repoId: 'repo-1', repoName: 'app', branch },
          { repoId: 'repo-2', repoName: 'lib', branch },
        ],
      },
    } as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as { window?: unknown }).window = {
      api: {
        loadPreferences,
        getWorktreePath,
        getRepoSlug,
        github: { pushOnly, commitAndPush, createPr, generateCommitMessages },
      },
    };
    loadPreferences.mockResolvedValue({ reviewCommitMessage: false });
    getWorktreePath.mockResolvedValue('/repo');
    getRepoSlug.mockResolvedValue(null);
    jest.mocked(probeGitHubConnected).mockResolvedValue('connected');
    refreshWorktreeDiffStats.mockResolvedValue(undefined);
    requestFastRefresh.mockResolvedValue(undefined);
    useGitHubConnectOfferStore.setState({ offer: null });
    useGitHubStore.setState({
      creatingPr: new Set<string>(),
      creationProgress: {},
      committingAndPushing: new Set<string>(),
      mergingLocalBranches: new Set<string>(),
      mergingPr: new Set<string>(),
      gitStatsRefreshing: new Set<string>(),
      gitActionOperationIds: {},
      gitActionIpcPending: new Set<string>(),
      gitActionCancellationRequested: new Set<string>(),
      activeBranchSyncAction: {},
      commitPushProgress: {},
      commitReviewPending: {},
      addToast,
      requestFastRefresh,
    });
    useProjectsStore.setState({
      projects: [
        {
          id: 'project-a',
          name: 'Project A',
          type: 'project',
          worktrees: [{ id: 'wt-1' }],
        },
      ],
      refreshWorktreeDiffStats,
    } as never);
    setBranch('feature/login');
  });

  function errorToasts(): string[] {
    return addToast.mock.calls
      .filter(([, type]) => type === 'error')
      .map(([message]) => String(message));
  }

  it.each([
    ['push', false],
    ['commit', false],
    ['pr', false],
    ['push', true],
    ['commit', true],
    ['pr', true],
  ])(
    'waits for original %s cleanup before a settled retry, canceled: %s',
    async (kind, canceled) => {
      let finishRefresh: (() => void) | undefined;
      requestFastRefresh.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = (): void => resolve();
          }),
      );
      pushOnly.mockResolvedValue(pushResponse());
      createPr.mockResolvedValue(prResponse());
      const failure = { ...authFailure(), commitPrepared: true };
      if (kind === 'push')
        pushOnly.mockResolvedValueOnce(
          pushResponse({ failedRepos: [failure] }),
        );
      else if (kind === 'pr')
        createPr.mockResolvedValueOnce(prResponse({ failedRepos: [failure] }));
      else
        commitAndPush.mockResolvedValueOnce(
          commitResponse({ failedRepos: [failure] }),
        );
      const original =
        kind === 'push'
          ? useGitHubStore.getState().pushOnly('project-a', 'wt-1')
          : kind === 'pr'
            ? useGitHubStore.getState().createPr('project-a', 'wt-1')
            : useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
      settle.mockResolvedValue('connected');
      const retry = settleGitHubConnectOffer();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const phaseWhileRefreshing =
        useGitHubConnectOfferStore.getState().offer?.phase;
      const cancellation = canceled
        ? await useGitHubStore.getState().cancelGitAction('project-a', 'wt-1')
        : null;
      finishRefresh?.();
      await Promise.all([original, retry]);
      expect(finishRefresh).toBeDefined();
      expect(phaseWhileRefreshing).toBe('settling');
      if (canceled) expect(cancellation?.accepted).toBe(true);
      expect(kind === 'pr' ? createPr : pushOnly).toHaveBeenCalledTimes(
        kind === 'commit' ? (canceled ? 0 : 1) : canceled ? 1 : 2,
      );
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    },
  );

  it.each(['push', 'pr', 'commit', 'reviewed-pr'])(
    'does not offer again when a late auth result arrives after canceling %s',
    async (kind) => {
      if (kind === 'reviewed-pr') {
        loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
        generateCommitMessages.mockResolvedValue({
          repos: [{ repoId: 'repo-1', repoName: 'app', message: 'Review' }],
          skippedRepos: [],
          failedRepos: [],
        });
      }
      let finish: (() => void) | undefined;
      if (kind === 'push')
        pushOnly.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = (): void =>
                resolve(pushResponse({ failedRepos: [authFailure()] }));
            }),
        );
      else if (kind === 'pr')
        createPr.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = (): void =>
                resolve(prResponse({ failedRepos: [authFailure()] }));
            }),
        );
      else
        commitAndPush.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = (): void =>
                resolve(commitResponse({ failedRepos: [authFailure()] }));
            }),
        );
      window.api.github.cancelGitAction = jest
        .fn()
        .mockResolvedValue({ accepted: true, reason: 'cancel_requested' });
      const action =
        kind === 'push'
          ? useGitHubStore.getState().pushOnly('project-a', 'wt-1')
          : kind === 'pr' || kind === 'reviewed-pr'
            ? useGitHubStore.getState().createPr('project-a', 'wt-1')
            : useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (kind === 'reviewed-pr') {
        useGitHubStore
          .getState()
          .commitReviewPending['project-a/wt-1']?.resolve({ approved: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(finish).toBeDefined();
      await useGitHubStore.getState().cancelGitAction('project-a', 'wt-1');
      finish?.();
      await action;
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    },
  );

  describe('push', () => {
    it('preserves each known branch when auth-failed repositories use different branches', async () => {
      useProjectsStore.setState({
        repoBranches: {
          'project-a/wt-1': [
            { repoId: 'repo-1', repoName: 'app', branch: 'feature/app' },
            { repoId: 'repo-2', repoName: 'lib', branch: 'feature/lib' },
          ],
        },
      } as never);
      pushOnly.mockResolvedValueOnce(
        pushResponse({
          failedRepos: [authFailure(), authFailure('repo-2', 'lib')],
        }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      settle.mockResolvedValue('connected');
      pushOnly.mockResolvedValue(pushResponse());
      await settleGitHubConnectOffer();
      expect(pushOnly).toHaveBeenCalledTimes(3);
      expect(pushOnly.mock.calls[1]?.[0]).toMatchObject({
        repoIds: ['repo-1'],
        expectedHeadBranch: 'feature/app',
      });
      expect(pushOnly.mock.calls[2]?.[0]).toMatchObject({
        repoIds: ['repo-2'],
        expectedHeadBranch: 'feature/lib',
      });
    });
    it('does not revive a continuation canceled during credential settlement', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      let finish!: (connection: 'connected') => void;
      settle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const closing = settleGitHubConnectOffer();
      await useGitHubStore.getState().cancelGitAction('project-a', 'wt-1');
      finish('connected');
      await closing;
      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('stops after the project is deleted during sign-in', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      useProjectsStore.setState({ projects: [] });
      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();
      expect(pushOnly).toHaveBeenCalledTimes(1);
    });

    it('rejects conflicting actions on another worktree while the offer is pending', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      await useGitHubStore.getState().pushOnly('project-b', 'wt-2');
      await useGitHubStore.getState().createPr('project-b', 'wt-2');
      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(createPr).not.toHaveBeenCalled();
    });
    it('coalesces concurrent pushes before the first reply', async () => {
      let finish!: (response: PushOnlyResponse) => void;
      pushOnly.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      const second = useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      finish(pushResponse());
      await Promise.all([first, second]);
      expect(pushOnly).toHaveBeenCalledTimes(1);
    });

    it('cancels an offered continuation before any later close can retry', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      await useGitHubStore.getState().cancelGitAction('project-a', 'wt-1');
      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      expect(pushOnly).toHaveBeenCalledTimes(1);
    });

    it('retains the branch from before the IPC when it changes during the push', async () => {
      pushOnly.mockImplementationOnce(() => {
        setBranch('new-branch');
        return Promise.resolve(pushResponse({ failedRepos: [authFailure()] }));
      });
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation
          .expectedHeadBranch,
      ).toBe('feature/login');
      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();
      expect(pushOnly).toHaveBeenCalledTimes(1);
    });
    it('does not prompt after a successful push', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ repos: [{ repoId: 'repo-1', repoName: 'app' }] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('offers to connect instead of an error toast for an auth failure', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      expect(useGitHubConnectOfferStore.getState().offer).toMatchObject({
        phase: 'offered',
        continuation: {
          kind: 'push',
          projectId: 'project-a',
          worktreeId: 'wt-1',
          repoIds: ['repo-1'],
          expectedHeadBranch: 'feature/login',
        },
      });
      expect(errorToasts()).toEqual([]);
      expect(useGitHubStore.getState().committingAndPushing.size).toBe(0);
    });

    it('keeps unrelated failures as errors next to the offer', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({
          failedRepos: [
            authFailure(),
            {
              repoId: 'repo-2',
              repoName: 'lib',
              error: 'rejected (non-fast-forward)',
              status: 'failed',
            },
          ],
        }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation.repoIds,
      ).toEqual(['repo-1']);
      expect(errorToasts()).toEqual([
        'Push failed for 1 repo: lib (rejected (non-fast-forward))',
      ]);
    });

    it('retries only the auth-failed repositories once after connecting', async () => {
      pushOnly.mockResolvedValueOnce(
        pushResponse({
          repos: [{ repoId: 'repo-2', repoName: 'lib' }],
          failedRepos: [authFailure()],
        }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      settle.mockResolvedValue('connected');
      pushOnly.mockResolvedValueOnce(
        pushResponse({ repos: [{ repoId: 'repo-1', repoName: 'app' }] }),
      );
      await Promise.all([
        settleGitHubConnectOffer(),
        settleGitHubConnectOffer(),
      ]);

      expect(settle).toHaveBeenCalledTimes(1);
      expect(pushOnly).toHaveBeenCalledTimes(2);
      expect(pushOnly.mock.calls[1]?.[0]).toMatchObject({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        repoIds: ['repo-1'],
        expectedHeadBranch: 'feature/login',
      });
      expect(pushOnly.mock.calls[1]?.[0]).not.toHaveProperty(
        'establishUpstream',
      );
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      expect(useGitHubStore.getState().committingAndPushing.size).toBe(0);
    });

    it('stops with a message when GitHub is still not connected', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      settle.mockResolvedValue('disconnected');
      await settleGitHubConnectOffer();

      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith(
        'GitHub is not connected. Connect and try again.',
        'info',
        undefined,
        expect.objectContaining({ category: 'GitHub' }),
      );
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('does not treat a failed probe as a login', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      settle.mockResolvedValue('unknown');
      await settleGitHubConnectOffer();

      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('shows the ordinary error when the continuation fails on auth again', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();

      expect(pushOnly).toHaveBeenCalledTimes(2);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      expect(errorToasts()).toEqual([
        `Push failed for 1 repo: app (${AUTH_ERROR})`,
      ]);
    });

    it('stops when the branch changed during sign-in', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      setBranch('other');
      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();

      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith(
        'The branch changed. Start a new push.',
        'info',
        undefined,
        expect.anything(),
      );
    });

    it('connects without retrying when the branch is not known', async () => {
      useProjectsStore.setState({ repoBranches: {} } as never);
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation
          .expectedHeadBranch,
      ).toBeNull();

      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();

      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith(
        'GitHub is connected. Try again.',
        'info',
        undefined,
        expect.anything(),
      );
    });

    it('rejects a new push on the worktree while an offer is pending', async () => {
      pushOnly.mockResolvedValue(
        pushResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      expect(pushOnly).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith(
        'Finish connecting GitHub, then try again.',
        'info',
        undefined,
        expect.anything(),
      );
    });

    it('a project add offer is not the worktree’s, but still blocks a push', async () => {
      useGitHubConnectOfferStore.getState().requestOffer({
        operationId: 'op-org',
        kind: 'org-project-setup',
        projectId: 'project-a',
        accountEpoch: 0,
      });
      expect(hasPendingGitHubConnectOffer('project-a', 'wt-1')).toBe(false);
      pushOnly.mockResolvedValue(pushResponse());
      await useGitHubStore.getState().pushOnly('project-a', 'wt-1');

      expect(pushOnly).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith(
        'Finish connecting GitHub, then try again.',
        'info',
        undefined,
        expect.anything(),
      );
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation.operationId,
      ).toBe('op-org');
    });

    it('never replaces another operation’s pending offer', () => {
      const store = useGitHubConnectOfferStore.getState();
      const first = {
        operationId: 'op-1',
        kind: 'push' as const,
        projectId: 'project-a',
        worktreeId: 'wt-1',
        repoIds: ['repo-1'],
        expectedHeadBranch: 'main',
      };
      expect(store.requestOffer(first)).toBe('offered');
      expect(store.requestOffer(first)).toBe('coalesced');
      expect(store.requestOffer({ ...first, operationId: 'op-2' })).toBe(
        'busy',
      );
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation.operationId,
      ).toBe('op-1');
    });
  });

  describe('commit and push', () => {
    it('retains pull-first when fetch auth fails on already-prepared commits', async () => {
      commitAndPush.mockResolvedValueOnce(
        commitResponse({
          failedRepos: [{ ...authFailure(), commitPrepared: true }],
        }),
      );
      await useGitHubStore
        .getState()
        .commitAndPush('project-a', 'wt-1', { pullFirst: true });
      settle.mockResolvedValue('connected');
      pushOnly.mockResolvedValue(pushResponse());
      await settleGitHubConnectOffer();
      expect(pushOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          repoIds: ['repo-1'],
          pullFirst: true,
          expectedHeadBranch: 'feature/login',
        }),
      );
      expect(commitAndPush).toHaveBeenCalledTimes(1);
    });

    it.each([
      [false, false],
      [true, false],
      [true, true],
    ])(
      'requires explicit review for an unfinished commit after login, approved %s auth failure %s',
      async (approved, retryAuthFails) => {
        commitAndPush.mockResolvedValueOnce(
          commitResponse({
            failedRepos: [{ ...authFailure(), commitPrepared: false }],
            repos: [
              {
                repoId: 'repo-2',
                repoName: 'lib',
                status: 'success',
                operation: 'push',
              },
            ],
          }),
        );
        await useGitHubStore
          .getState()
          .commitAndPush('project-a', 'wt-1', { pullFirst: true });
        generateCommitMessages.mockResolvedValue({
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'app',
              message: 'Review pending changes',
            },
          ],
          skippedRepos: [],
          failedRepos: [],
        });
        commitAndPush.mockResolvedValue(
          commitResponse(
            retryAuthFails
              ? { failedRepos: [{ ...authFailure(), commitPrepared: false }] }
              : {},
          ),
        );
        settle.mockResolvedValue('connected');
        const retry = settleGitHubConnectOffer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const review =
          useGitHubStore.getState().commitReviewPending['project-a/wt-1'];
        review?.resolve({ approved });
        await retry;
        expect(review).toBeDefined();
        expect(generateCommitMessages).toHaveBeenCalledWith(
          expect.objectContaining({ repoIds: ['repo-1'] }),
        );
        expect(commitAndPush).toHaveBeenCalledTimes(approved ? 2 : 1);
        if (approved)
          expect(commitAndPush.mock.calls[1]?.[0]).toMatchObject({
            repoIds: ['repo-1'],
            pullFirst: true,
            expectedHeadBranch: 'feature/login',
            requireReviewedMessages: true,
          });
        expect(pushOnly).not.toHaveBeenCalled();
        expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      },
    );

    it('continues by pushing existing commits with upstream tracking', async () => {
      commitAndPush.mockResolvedValue(
        commitResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().commitAndPush('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation,
      ).toMatchObject({
        kind: 'push',
        establishUpstream: true,
      });
      expect(errorToasts()).toEqual([]);

      settle.mockResolvedValue('connected');
      pushOnly.mockResolvedValue(
        pushResponse({ repos: [{ repoId: 'repo-1', repoName: 'app' }] }),
      );
      await settleGitHubConnectOffer();

      expect(commitAndPush).toHaveBeenCalledTimes(1);
      expect(pushOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          repoIds: ['repo-1'],
          expectedHeadBranch: 'feature/login',
          establishUpstream: true,
        }),
      );
    });
  });

  describe('pull request', () => {
    it.each([false, true])(
      'retains completed reviewed stages when PR authentication fails early, mixed targets: %s',
      async (mixed) => {
        loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
        generateCommitMessages.mockResolvedValue({
          repos: [
            { repoId: 'repo-1', repoName: 'app', message: 'Original work' },
          ],
          skippedRepos: [],
          failedRepos: [],
        });
        commitAndPush.mockResolvedValue(
          commitResponse({
            repos: [
              {
                repoId: 'repo-1',
                repoName: 'app',
                operation: 'commit_and_push',
                status: 'success',
                commitHash: 'original-commit',
              },
            ],
          }),
        );
        createPr.mockResolvedValueOnce(
          prResponse({
            failedRepos: [
              { ...authFailure(), commitPrepared: false, pushCompleted: false },
              ...(mixed
                ? [
                    {
                      ...authFailure('repo-2', 'lib'),
                      commitPrepared: false,
                      pushCompleted: false,
                    },
                  ]
                : []),
            ],
          }),
        );
        const original = useGitHubStore
          .getState()
          .createPr('project-a', 'wt-1');
        await new Promise((resolve) => setTimeout(resolve, 0));
        useGitHubStore
          .getState()
          .commitReviewPending['project-a/wt-1']?.resolve({ approved: true });
        await original;
        const continuation =
          useGitHubConnectOfferStore.getState().offer?.continuation;
        if (mixed) {
          expect(continuation?.repoCommitPrepared).toEqual({
            'repo-1': true,
            'repo-2': false,
          });
          expect(continuation?.pushCompletedRepoIds).toEqual(['repo-1']);
          return;
        }
        // A second generation would include edits made during sign-in.
        generateCommitMessages.mockResolvedValue({
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'app',
              message: 'New edits during sign-in',
            },
          ],
          skippedRepos: [],
          failedRepos: [],
        });
        createPr.mockResolvedValue(prResponse());
        settle.mockResolvedValue('connected');
        const retry = settleGitHubConnectOffer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const secondReview =
          useGitHubStore.getState().commitReviewPending['project-a/wt-1'];
        secondReview?.resolve({ approved: false });
        await retry;
        expect(secondReview).toBeUndefined();
        expect(generateCommitMessages).toHaveBeenCalledTimes(1);
        expect(commitAndPush).toHaveBeenCalledTimes(1);
        expect(createPr).toHaveBeenCalledTimes(2);
        expect(createPr.mock.calls[1]?.[0]).toMatchObject({
          repoIds: ['repo-1'],
          skipCommit: true,
          skipPush: true,
          expectedHeadBranch: 'feature/login',
        });
      },
    );

    it('stops a resumed PR before committing if its branch changes during review', async () => {
      loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
      getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'app' });
      jest.mocked(probeGitHubConnected).mockResolvedValue('disconnected');
      generateCommitMessages.mockResolvedValue({
        repos: [{ repoId: 'repo-1', repoName: 'app', message: 'Review' }],
        skippedRepos: [],
        failedRepos: [],
      });
      commitAndPush.mockResolvedValue(commitResponse());
      createPr.mockResolvedValue(prResponse());
      await useGitHubStore.getState().createPr('project-a', 'wt-1', ['repo-1']);
      settle.mockResolvedValue('connected');
      const retry = settleGitHubConnectOffer();
      await new Promise((resolve) => setTimeout(resolve, 0));
      setBranch('different-branch');
      useGitHubStore
        .getState()
        .commitReviewPending['project-a/wt-1']?.resolve({ approved: true });
      await retry;
      expect(commitAndPush).not.toHaveBeenCalled();
      expect(createPr).not.toHaveBeenCalled();
      expect(useGitHubStore.getState().creatingPr.size).toBe(0);
    });

    it.each([false, true])(
      'keeps commit-message review after a disconnected preflight, retry auth failure: %s',
      async (retryAuthFails) => {
        loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
        getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'app' });
        jest.mocked(probeGitHubConnected).mockResolvedValue('disconnected');
        generateCommitMessages.mockResolvedValue({
          repos: [{ repoId: 'repo-1', repoName: 'app', message: 'feat' }],
          skippedRepos: [],
          failedRepos: [],
        });
        commitAndPush.mockResolvedValue(
          commitResponse(
            retryAuthFails
              ? { failedRepos: [authFailure()] }
              : {
                  repos: [
                    {
                      repoId: 'repo-1',
                      repoName: 'app',
                      operation: 'push',
                      status: 'success',
                    },
                  ],
                },
          ),
        );
        createPr.mockResolvedValue(prResponse());
        await useGitHubStore
          .getState()
          .createPr('project-a', 'wt-1', ['repo-1']);
        settle.mockResolvedValue('connected');
        const retry = settleGitHubConnectOffer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const review =
          useGitHubStore.getState().commitReviewPending['project-a/wt-1'];
        // Always settle the pending flow before asserting, including on red.
        review?.resolve({
          approved: true,
          messages: [
            { repoId: 'repo-1', repoName: 'app', message: 'reviewed' },
          ],
        });
        await retry;
        expect(review).toBeDefined();
        expect(commitAndPush).toHaveBeenCalledWith(
          expect.objectContaining({
            requireReviewedMessages: true,
            expectedHeadBranch: 'feature/login',
          }),
        );
        if (retryAuthFails) {
          expect(createPr).not.toHaveBeenCalled();
          expect(errorToasts()).toEqual([
            expect.stringContaining('Authentication failed'),
          ]);
        } else {
          expect(createPr).toHaveBeenCalledWith(
            expect.objectContaining({ skipCommit: true, skipPush: true }),
          );
          expect(errorToasts()).toEqual([]);
        }
        expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      },
    );

    it.each([
      ['same-head-pr', true],
      ['different-head-pr', true],
      ['different-head-push', true],
      ['same-head-pr', false],
      ['different-head-pr', false],
      ['different-head-push', false],
    ])(
      'stops later repositories after canceling the first continuation: %s',
      async (scenario, cancelledResponse) => {
        if (scenario !== 'same-head-pr') {
          useProjectsStore.setState({
            repoBranches: {
              'project-a/wt-1': [
                { repoId: 'repo-1', repoName: 'app', branch: 'feature/app' },
                { repoId: 'repo-2', repoName: 'lib', branch: 'feature/lib' },
              ],
            },
          } as never);
        }
        const failures = [authFailure(), authFailure('repo-2', 'lib')];
        const push = scenario === 'different-head-push';
        if (push) {
          pushOnly.mockResolvedValueOnce(
            pushResponse({ failedRepos: failures }),
          );
          await useGitHubStore.getState().pushOnly('project-a', 'wt-1');
        } else {
          createPr.mockResolvedValueOnce(
            prResponse({
              failedRepos: failures.map((repo) => ({
                ...repo,
                commitPrepared: true,
              })),
            }),
          );
          await useGitHubStore.getState().createPr('project-a', 'wt-1');
        }
        const cancelGitAction = jest
          .fn()
          .mockResolvedValue({ accepted: true, reason: 'cancel_requested' });
        window.api.github.cancelGitAction = cancelGitAction;
        let finishFirst: (() => void) | undefined;
        if (push) {
          pushOnly.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishFirst = (): void =>
                  resolve(
                    pushResponse({ cancelled: cancelledResponse === true }),
                  );
              }),
          );
          pushOnly.mockResolvedValue(pushResponse());
        } else {
          createPr.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishFirst = (): void =>
                  resolve(
                    prResponse({ cancelled: cancelledResponse === true }),
                  );
              }),
          );
          createPr.mockResolvedValue(prResponse());
        }
        settle.mockResolvedValue('connected');
        const retry = settleGitHubConnectOffer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(finishFirst).toBeDefined();
        const cancellation = await useGitHubStore
          .getState()
          .cancelGitAction('project-a', 'wt-1');
        finishFirst?.();
        await retry;
        expect(cancellation.accepted).toBe(true);
        expect(push ? pushOnly : createPr).toHaveBeenCalledTimes(2);
        expect(useGitHubStore.getState().gitActionOperationIds).toEqual({});
      },
    );

    it('preflights a single-repo worktree using its aggregate branch metadata', async () => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'project-a',
            name: 'App',
            type: 'single-repo',
            worktrees: [{ id: 'wt-1', branchName: 'feature/login' }],
          },
        ],
        repoBranches: {},
      } as never);
      getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'app' });
      jest.mocked(probeGitHubConnected).mockResolvedValue('disconnected');
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(createPr).not.toHaveBeenCalled();
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation,
      ).toMatchObject({
        repoIds: ['__single_repo__'],
        expectedHeadBranch: 'feature/login',
      });
      settle.mockResolvedValue('connected');
      createPr.mockResolvedValue(prResponse());
      await settleGitHubConnectOffer();
      expect(createPr).toHaveBeenCalledTimes(1);
    });
    it('resumes the correct commit stage for each auth-failed repository', async () => {
      createPr.mockResolvedValueOnce(
        prResponse({
          failedRepos: [
            { ...authFailure('repo-1'), commitPrepared: false },
            { ...authFailure('repo-2', 'lib'), commitPrepared: true },
          ],
        }),
      );
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      createPr.mockResolvedValue(prResponse());
      settle.mockResolvedValue('connected');
      await settleGitHubConnectOffer();
      expect(createPr).toHaveBeenCalledTimes(3);
      expect(createPr.mock.calls[1]?.[0]).toMatchObject({
        repoIds: ['repo-1'],
        skipCommit: false,
      });
      expect(createPr.mock.calls[2]?.[0]).toMatchObject({
        repoIds: ['repo-2'],
        skipCommit: true,
      });
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('omits the synthetic single-repo ID from the worktree path probe', async () => {
      useProjectsStore.setState({
        repoBranches: {
          'project-a/wt-1': [
            {
              repoId: '__single_repo__',
              repoName: 'app',
              branch: 'feature/login',
            },
          ],
        },
      } as never);
      createPr.mockResolvedValue(prResponse());
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(getWorktreePath).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
      });
    });
    it('offers before progress or mutation for a known GitHub repository', async () => {
      getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'app' });
      jest.mocked(probeGitHubConnected).mockResolvedValue('disconnected');
      await useGitHubStore.getState().createPr('project-a', 'wt-1', ['repo-1']);
      expect(createPr).not.toHaveBeenCalled();
      expect(commitAndPush).not.toHaveBeenCalled();
      expect(generateCommitMessages).not.toHaveBeenCalled();
      expect(useGitHubStore.getState().creatingPr.size).toBe(0);
      expect(useGitHubStore.getState().creationProgress).toEqual({});
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation,
      ).toMatchObject({ kind: 'pr', repoIds: ['repo-1'], skipCommit: false });
      settle.mockResolvedValue('connected');
      createPr.mockResolvedValueOnce(prResponse());
      await settleGitHubConnectOffer();
      expect(createPr).toHaveBeenCalledTimes(1);
      expect(createPr.mock.calls[0]?.[0]).not.toMatchObject({
        skipCommit: true,
      });
    });

    it('does not gate local origins or unavailable metadata', async () => {
      jest.mocked(probeGitHubConnected).mockResolvedValue('disconnected');
      getRepoSlug.mockResolvedValue(null);
      createPr.mockResolvedValueOnce(prResponse());
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(createPr).toHaveBeenCalledTimes(1);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    });

    it('coalesces concurrent PR requests during the connection preflight', async () => {
      createPr.mockResolvedValue(prResponse());
      await Promise.all([
        useGitHubStore.getState().createPr('project-a', 'wt-1'),
        useGitHubStore.getState().createPr('project-a', 'wt-1'),
      ]);
      expect(createPr).toHaveBeenCalledTimes(1);
    });

    it('keeps unrelated PR failures visible alongside an auth offer', async () => {
      createPr.mockResolvedValue(
        prResponse({
          failedRepos: [
            authFailure(),
            {
              repoId: 'repo-2',
              repoName: 'lib',
              error: 'network unavailable',
              status: 'failed',
            },
          ],
        }),
      );
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(errorToasts()).toEqual([
        'PR creation failed for 1 repo: lib (network unavailable)',
      ]);
    });
    it('offers to connect and continues without committing again', async () => {
      createPr.mockResolvedValueOnce(
        prResponse({ failedRepos: [authFailure()] }),
      );
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation,
      ).toMatchObject({
        kind: 'pr',
        repoIds: ['repo-1'],
      });
      expect(errorToasts()).toEqual([]);
      expect(
        useGitHubStore.getState().creationProgress['project-a/wt-1'],
      ).toBeUndefined();

      settle.mockResolvedValue('connected');
      createPr.mockResolvedValueOnce(prResponse());
      await settleGitHubConnectOffer();

      expect(createPr).toHaveBeenCalledTimes(2);
      expect(createPr.mock.calls[1]?.[0]).toMatchObject({
        repoIds: ['repo-1'],
        skipCommit: true,
        expectedHeadBranch: 'feature/login',
      });
      expect(useGitHubStore.getState().creatingPr.size).toBe(0);
    });

    it('keeps successful pull requests when another repository needs GitHub', async () => {
      createPr.mockResolvedValue(
        prResponse({
          repos: [
            {
              repoId: 'repo-2',
              repoName: 'lib',
              prUrl: 'https://github.com/acme/lib/pull/1',
              prNumber: 1,
              status: 'created',
            } as never,
          ],
          failedRepos: [authFailure()],
        }),
      );
      await useGitHubStore.getState().createPr('project-a', 'wt-1');
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation.repoIds,
      ).toEqual(['repo-1']);
    });

    it('continues only auth-failed repositories after a reviewed commit fails to push', async () => {
      loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
      generateCommitMessages.mockResolvedValue({
        repos: [{ repoId: 'repo-1', repoName: 'app', message: 'feat' }],
        skippedRepos: [],
        failedRepos: [],
      });
      commitAndPush.mockResolvedValue(
        commitResponse({ failedRepos: [authFailure()] }),
      );

      const run = useGitHubStore.getState().createPr('project-a', 'wt-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
      useGitHubStore
        .getState()
        .commitReviewPending['project-a/wt-1']?.resolve({ approved: true });
      await run;

      expect(createPr).not.toHaveBeenCalled();
      const offer = useGitHubConnectOfferStore.getState().offer;
      expect(offer?.continuation.kind).toBe('pr');
      expect(offer?.continuation.repoIds).toEqual(['repo-1']);
      expect(errorToasts()).toEqual([]);
    });

    it.each([false, true])(
      'finishes PRs for successful reviewed pushes without repeating their push, unrelated error: %s',
      async (unrelatedError) => {
        loadPreferences.mockResolvedValue({ reviewCommitMessage: true });
        generateCommitMessages.mockResolvedValue({
          repos: [{ repoId: 'repo-1', repoName: 'app', message: 'feat' }],
          skippedRepos: [],
          failedRepos: [],
        });
        commitAndPush.mockResolvedValue(
          commitResponse({
            repos: [
              {
                repoId: 'repo-2',
                repoName: 'lib',
                operation: 'push',
                status: 'success',
              },
            ],
            failedRepos: [
              authFailure(),
              ...(unrelatedError
                ? [
                    {
                      repoId: 'repo-3',
                      repoName: 'other',
                      error: 'network unavailable',
                      status: 'failed' as const,
                    },
                  ]
                : []),
            ],
          }),
        );
        const run = useGitHubStore.getState().createPr('project-a', 'wt-1');
        await new Promise((resolve) => setTimeout(resolve, 0));
        useGitHubStore
          .getState()
          .commitReviewPending['project-a/wt-1']?.resolve({ approved: true });
        await run;
        createPr.mockResolvedValue(prResponse());
        settle.mockResolvedValue('connected');
        await settleGitHubConnectOffer();
        expect(commitAndPush).toHaveBeenCalledTimes(1);
        expect(createPr).toHaveBeenCalledTimes(2);
        expect(createPr.mock.calls[0]?.[0]).toMatchObject({
          repoIds: ['repo-1'],
          skipCommit: true,
        });
        expect(createPr.mock.calls[0]?.[0]).not.toHaveProperty('skipPush');
        expect(createPr.mock.calls[1]?.[0]).toMatchObject({
          repoIds: ['repo-2'],
          skipCommit: true,
          skipPush: true,
        });
      },
    );
  });
});
