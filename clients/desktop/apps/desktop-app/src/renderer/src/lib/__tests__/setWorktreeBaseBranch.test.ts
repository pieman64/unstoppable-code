/** @jest-environment jsdom */

import type {
  CanopyApi,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type {
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import { useBaseBranchChangeStore } from '@/stores/baseBranchChangeStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type {
  BaseBranchChangeError,
  SetWorktreeBaseBranchOptions,
} from '../setWorktreeBaseBranch';
import { setWorktreeBaseBranch } from '../setWorktreeBaseBranch';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const REPO_ID = 'repo-a';

const listBranches = jest.fn();
const updatePrBaseBranch = jest.fn();
const setTrackedBaseBranch = jest.fn();

function makeSingleRepoWorkspace(): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Project One',
    repoPath: '/repo',
    color: '#111111',
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/current',
        createdAt: new Date(0).toISOString(),
        trackedBaseBranch: 'main',
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function makeMultiRepoWorkspace(): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: PROJECT_ID,
    name: 'Project One',
    color: '#111111',
    repos: [{ id: REPO_ID, name: 'Repo A', repoPath: '/repo-a' }],
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/current',
        createdAt: new Date(0).toISOString(),
        trackedRepoBaseBranches: { [REPO_ID]: 'main' },
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function makePrStatus(
  overrides: Partial<PrStatusData> = {},
  repoId: string = PROJECT_ID,
): WorktreePrStatus {
  return {
    repos: [
      {
        repoId,
        repoName: repoId === REPO_ID ? 'Repo A' : 'Project One',
        status: {
          prNumber: 42,
          prUrl: 'https://example.test/pull/42',
          state: 'open',
          title: 'Feature',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'approved',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: new Date(0).toISOString(),
          baseRefName: 'main',
          ...overrides,
        },
      },
    ],
    lastCheckedAt: new Date(0).toISOString(),
  };
}

function branchResponse(
  name = 'develop',
  presence = { hasLocalRef: true, hasRemoteRef: false },
): { branches: Array<Record<string, unknown>> } {
  return {
    branches: [
      {
        name,
        isRemote: !presence.hasLocalRef,
        isCurrent: false,
        isUsedByWorktree: false,
        ...presence,
      },
    ],
  };
}

describe('setWorktreeBaseBranch', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listBranches,
        github: { updatePrBaseBranch },
      } satisfies Partial<CanopyApi>,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    listBranches.mockResolvedValue(branchResponse());
    updatePrBaseBranch.mockResolvedValue({
      success: true,
      prUrl: 'https://example.test/pull/42',
    });
    setTrackedBaseBranch.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeSingleRepoWorkspace()],
      hasHydratedProjects: true,
      setTrackedBaseBranch,
      uncommittedChanges: {},
    });
    useGitHubStore.setState({
      prStatuses: {},
      splitLockedWorktrees: new Set(),
      committingAndPushing: new Set(),
      creatingPr: new Set(),
      mergingLocalBranches: new Set(),
      mergingPr: new Set(),
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('sets an available local base branch and permits unrelated dirty state', async () => {
    useProjectsStore.setState({ uncommittedChanges: { [KEY]: true } });

    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: '  develop  ',
      }),
    ).resolves.toEqual({
      status: 'updated',
      baseBranch: 'develop',
      pullRequestUpdated: false,
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'develop',
      undefined,
      { existsLocally: true, existsInRemote: false },
    );
  });

  it.each(['', '   ', '-unsafe', 'HEAD'])(
    'rejects invalid base branch %p',
    async (baseBranch) => {
      await expect(
        setWorktreeBaseBranch({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch,
        }),
      ).rejects.toMatchObject<BaseBranchChangeError>({
        code: 'validation_failed',
      });
      expect(setTrackedBaseBranch).not.toHaveBeenCalled();
    },
  );

  it('rejects a branch that is no longer available locally or remotely', async () => {
    listBranches.mockResolvedValue({ branches: [] });

    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'missing',
      }),
    ).rejects.toMatchObject<BaseBranchChangeError>({
      code: 'validation_failed',
      retryable: true,
    });
  });

  it('guards project, worktree, and repository scope', async () => {
    useProjectsStore.setState({ projects: [] });
    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    useProjectsStore.setState({ projects: [makeSingleRepoWorkspace()] });
    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: 'missing',
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoId: REPO_ID,
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    useProjectsStore.setState({ projects: [makeMultiRepoWorkspace()] });
    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(
      setWorktreeBaseBranch({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoId: 'missing',
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('updates only the tracked base when the PR target is local-only or the user declines PR retargeting', async () => {
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const confirmUpdatePullRequest = jest.fn().mockResolvedValue('local-only');

    await setWorktreeBaseBranch(
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'develop',
      },
      { confirmUpdatePullRequest },
    );
    expect(confirmUpdatePullRequest).not.toHaveBeenCalled();
    expect(updatePrBaseBranch).not.toHaveBeenCalled();

    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    await setWorktreeBaseBranch(
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'release/next',
      },
      { confirmUpdatePullRequest },
    );
    expect(confirmUpdatePullRequest).toHaveBeenCalledTimes(1);
    expect(updatePrBaseBranch).not.toHaveBeenCalled();
  });

  it('updates the tracked base and matching open PR after confirmation', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: false,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        {
          confirmUpdatePullRequest: jest.fn().mockResolvedValue('update-pr'),
        },
      ),
    ).resolves.toMatchObject({ pullRequestUpdated: true });

    expect(setTrackedBaseBranch).toHaveBeenCalledTimes(1);
    expect(updatePrBaseBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      prNumber: 42,
      newBaseBranch: 'release/next',
    });
  });

  it('treats a closed confirmation as cancellation without writing', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        { confirmUpdatePullRequest: jest.fn().mockResolvedValue(null) },
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('does not write when the originating action is aborted during confirmation', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const controller = new AbortController();
    const confirmUpdatePullRequest = jest.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve('local-only');
    });
    const options: SetWorktreeBaseBranchOptions = {
      confirmUpdatePullRequest,
      signal: controller.signal,
    };

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        options,
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('clears a confirmation created for an already-aborted action', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const controller = new AbortController();
    controller.abort();

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        {
          requestId: 'already-aborted',
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(useBaseBranchChangeStore.getState().pending).toBeNull();
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('does not update the pull request when cancellation arrives during persistence', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const controller = new AbortController();
    setTrackedBaseBranch.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        {
          confirmUpdatePullRequest: jest.fn().mockResolvedValue('update-pr'),
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(setTrackedBaseBranch).toHaveBeenCalledTimes(1);
    expect(updatePrBaseBranch).not.toHaveBeenCalled();
  });

  it('announces a local-only PR mismatch only after persistence succeeds', async () => {
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const onLocalOnlyPullRequestMismatch = jest.fn();
    setTrackedBaseBranch.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'develop',
        },
        { onLocalOnlyPullRequestMismatch },
      ),
    ).rejects.toThrow('disk full');
    expect(onLocalOnlyPullRequestMismatch).not.toHaveBeenCalled();
  });

  it.each([
    'splitLockedWorktrees',
    'committingAndPushing',
    'creatingPr',
    'mergingLocalBranches',
    'mergingPr',
  ] as const)(
    'blocks PR retargeting while %s contains the worktree',
    async (field) => {
      listBranches.mockResolvedValue(
        branchResponse('release/next', {
          hasLocalRef: true,
          hasRemoteRef: true,
        }),
      );
      useGitHubStore.setState({
        prStatuses: { [KEY]: makePrStatus() },
        [field]: new Set([KEY]),
      });

      await expect(
        setWorktreeBaseBranch(
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            baseBranch: 'release/next',
          },
          {
            confirmUpdatePullRequest: jest.fn().mockResolvedValue('update-pr'),
          },
        ),
      ).rejects.toMatchObject({
        code: 'surface_unavailable',
        retryable: true,
      });
      expect(setTrackedBaseBranch).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale PR after confirmation and revalidates branch availability', async () => {
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const confirmUpdatePullRequest = jest.fn().mockImplementation(() => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makePrStatus({ prNumber: 43, baseRefName: 'develop' }),
        },
      });
      listBranches.mockResolvedValue({ branches: [] });
      return Promise.resolve('update-pr');
    });

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        { confirmUpdatePullRequest },
      ),
    ).rejects.toMatchObject({ code: 'stale_ui_state', retryable: true });
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('falls back to local-only when the remote branch disappears during confirmation', async () => {
    listBranches
      .mockResolvedValueOnce(
        branchResponse('release/next', {
          hasLocalRef: true,
          hasRemoteRef: true,
        }),
      )
      .mockResolvedValueOnce(
        branchResponse('release/next', {
          hasLocalRef: true,
          hasRemoteRef: false,
        }),
      );
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    const onBeforePullRequestUpdate = jest.fn();
    const onLocalOnlyPullRequestMismatch = jest.fn();

    await expect(
      setWorktreeBaseBranch(
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          baseBranch: 'release/next',
        },
        {
          confirmUpdatePullRequest: jest.fn().mockResolvedValue('update-pr'),
          onBeforePullRequestUpdate,
          onLocalOnlyPullRequestMismatch,
        },
      ),
    ).resolves.toEqual({
      status: 'updated',
      baseBranch: 'release/next',
      pullRequestUpdated: false,
    });
    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'release/next',
      undefined,
      { existsLocally: true, existsInRemote: false },
    );
    expect(onLocalOnlyPullRequestMismatch).toHaveBeenCalledTimes(1);
    expect(onBeforePullRequestUpdate).not.toHaveBeenCalled();
    expect(updatePrBaseBranch).not.toHaveBeenCalled();
  });

  it('scopes multi-repo validation, persistence, and PR updates to the requested repo', async () => {
    useProjectsStore.setState({ projects: [makeMultiRepoWorkspace()] });
    listBranches.mockResolvedValue(
      branchResponse('release/next', {
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    );
    useGitHubStore.setState({
      prStatuses: { [KEY]: makePrStatus({}, REPO_ID) },
    });

    await setWorktreeBaseBranch(
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoId: REPO_ID,
        baseBranch: 'release/next',
      },
      {
        confirmUpdatePullRequest: jest.fn().mockResolvedValue('update-pr'),
      },
    );

    expect(listBranches).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
    });
    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'release/next',
      REPO_ID,
      { existsLocally: true, existsInRemote: true },
    );
    expect(updatePrBaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: REPO_ID }),
    );
  });
});
