import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';

jest.mock('../lib/git', () => ({
  fetchOrigin: jest.fn(),
  getRemoteUrl: jest.fn(),
}));

jest.mock('../lib/git-default-branch', () => ({
  resolveFreshDefaultBranch: jest.fn(),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  updateWorkspaceWorktrees: jest.fn(),
}));

import { fetchOrigin, getRemoteUrl } from '../lib/git';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { updateWorkspaceWorktrees } from '../lib/workspace-persistence';
import { updateDependentBaseBranchesForMergedWorktree } from '../lib/worktree-base-branch-updater';

const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedResolveFreshDefaultBranch = jest.mocked(resolveFreshDefaultBranch);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const ANY_ABORT_SIGNAL: unknown = expect.any(AbortSignal);

function worktree(
  id: string,
  overrides: Partial<WorktreeData> = {},
): WorktreeData {
  return {
    id,
    branchName: id,
    createdAt: `2026-05-21T00:00:00.000Z`,
    ...overrides,
  };
}

function singleRepoWorkspace(args: {
  id: string;
  repoPath: string;
  worktrees: WorktreeData[];
}): SidebarItem {
  return {
    type: 'single-repo',
    id: args.id,
    name: args.id,
    repoPath: args.repoPath,
    color: '#123456',
    worktrees: args.worktrees,
    collapsed: false,
    order: 0,
  };
}

function multiRepoWorkspace(args: {
  id: string;
  sourceRepoPath?: string;
  repos: Array<{ id: string; name: string; repoPath: string }>;
  worktrees: WorktreeData[];
}): SidebarItem {
  return {
    type: 'multi-repo',
    id: args.id,
    name: args.id,
    color: '#123456',
    repos: args.repos,
    worktrees: args.worktrees,
    collapsed: false,
    order: 0,
    sourceRepoPath: args.sourceRepoPath,
  };
}

describe('updateDependentBaseBranchesForMergedWorktree', () => {
  let persistedWorktrees: Record<string, WorktreeData[]>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchOrigin.mockResolvedValue(undefined);
    mockedResolveFreshDefaultBranch.mockResolvedValue('main');
    persistedWorktrees = {};
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        const current = persistedWorktrees[workspaceId] ?? [];
        const updated = await updater(current);
        persistedWorktrees[workspaceId] = updated;
        return updated;
      },
    );
  });

  it('does not retarget dependents when the merged branch is the repo default', async () => {
    persistedWorktrees = {
      workspace: [
        worktree('release', {
          branchName: 'develop',
          trackedBaseBranch: 'main',
        }),
        worktree('feature', { trackedBaseBranch: 'develop' }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        singleRepoWorkspace({
          id: 'workspace',
          repoPath: '/repos/acme',
          worktrees: persistedWorktrees.workspace,
        }),
      ],
    });
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:acme/repo.git');
    mockedResolveFreshDefaultBranch.mockResolvedValue('develop');

    await expect(
      updateDependentBaseBranchesForMergedWorktree({
        mergedWorkspaceId: 'workspace',
        mergedWorktreeId: 'release',
        mergedRepoFullName: 'acme/repo',
        mergedBranchName: 'develop',
        mergedIntoBranchName: 'main',
      }),
    ).resolves.toEqual([]);

    expect(persistedWorktrees.workspace[1]?.trackedBaseBranch).toBe('develop');
    expect(mockedResolveFreshDefaultBranch).toHaveBeenCalledTimes(1);
    expect(mockedResolveFreshDefaultBranch).toHaveBeenCalledWith('/repos/acme');
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
  });

  it('updates matching single-repo worktrees across projects', async () => {
    persistedWorktrees = {
      merged: [worktree('feature-parent', { trackedBaseBranch: 'main' })],
      dependent: [
        worktree('child', { trackedBaseBranch: 'feature-parent' }),
        worktree('unrelated-base', { trackedBaseBranch: 'develop' }),
      ],
      other: [
        worktree('same-branch-name', { trackedBaseBranch: 'feature-parent' }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        singleRepoWorkspace({
          id: 'merged',
          repoPath: '/repos/acme',
          worktrees: persistedWorktrees.merged,
        }),
        singleRepoWorkspace({
          id: 'dependent',
          repoPath: '/repos/acme-copy',
          worktrees: persistedWorktrees.dependent,
        }),
        singleRepoWorkspace({
          id: 'other',
          repoPath: '/repos/other',
          worktrees: persistedWorktrees.other,
        }),
      ],
    });
    mockedGetRemoteUrl.mockImplementation((repoPath) => {
      if (repoPath === '/repos/other') {
        return Promise.resolve('git@github.com:acme/other.git');
      }
      return Promise.resolve('git@github.com:acme/repo.git');
    });

    const updates = await updateDependentBaseBranchesForMergedWorktree({
      mergedWorkspaceId: 'merged',
      mergedWorktreeId: 'feature-parent',
      mergedRepoFullName: 'acme/repo',
      mergedBranchName: 'feature-parent',
      mergedIntoBranchName: 'main',
    });

    expect(updates).toEqual([
      {
        projectId: 'dependent',
        worktreeId: 'child',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
    ]);
    expect(persistedWorktrees.dependent[0]?.trackedBaseBranch).toBe('main');
    expect(persistedWorktrees.dependent[1]?.trackedBaseBranch).toBe('develop');
    expect(persistedWorktrees.other[0]?.trackedBaseBranch).toBe(
      'feature-parent',
    );
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/acme-copy', {
      backgroundPriority: true,
      signal: ANY_ABORT_SIGNAL,
    });
    expect(mockedFetchOrigin).not.toHaveBeenCalledWith(
      '/repos/acme',
      expect.anything(),
    );
  });

  it('retains same-workspace children under the merged visual parent', async () => {
    persistedWorktrees = {
      workspace: [
        worktree('parent', {
          branchName: 'feature-parent',
          trackedBaseBranch: 'main',
          status: 'done',
        }),
        worktree('child', {
          branchName: 'feature-child',
          trackedBaseBranch: 'feature-parent',
        }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        singleRepoWorkspace({
          id: 'workspace',
          repoPath: '/repos/acme',
          worktrees: persistedWorktrees.workspace,
        }),
      ],
    });
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:acme/repo.git');

    const updates = await updateDependentBaseBranchesForMergedWorktree({
      mergedWorkspaceId: 'workspace',
      mergedWorktreeId: 'parent',
      mergedRepoFullName: 'acme/repo',
      mergedBranchName: 'feature-parent',
      mergedIntoBranchName: 'main',
    });

    expect(updates).toEqual([
      {
        projectId: 'workspace',
        worktreeId: 'child',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
        branchGroupingParentWorktreeId: 'parent',
      },
    ]);
    expect(persistedWorktrees.workspace[1]).toMatchObject({
      trackedBaseBranch: 'main',
      branchGroupingParentWorktreeId: 'parent',
    });
  });

  it('updates only matching repos in multi-repo worktrees and overlapping single-repo projects', async () => {
    persistedWorktrees = {
      multi: [
        worktree('child', {
          trackedRepoBaseBranches: {
            'repo-a': 'feature-parent',
            'repo-b': 'feature-parent',
          },
        }),
      ],
      single: [
        worktree('single-child', { trackedBaseBranch: 'feature-parent' }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        multiRepoWorkspace({
          id: 'multi',
          repos: [
            { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
            { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
          ],
          worktrees: persistedWorktrees.multi,
        }),
        singleRepoWorkspace({
          id: 'single',
          repoPath: '/repos/a-copy',
          worktrees: persistedWorktrees.single,
        }),
      ],
    });
    mockedGetRemoteUrl.mockImplementation((repoPath) => {
      if (repoPath === '/repos/a' || repoPath === '/repos/a-copy') {
        return Promise.resolve('https://github.com/acme/repo-a.git');
      }
      return Promise.resolve('https://github.com/acme/repo-b.git');
    });

    const updates = await updateDependentBaseBranchesForMergedWorktree({
      mergedWorkspaceId: 'current',
      mergedWorktreeId: 'feature-parent',
      mergedRepoFullName: 'ACME/repo-a',
      mergedBranchName: 'feature-parent',
      mergedIntoBranchName: 'main',
    });

    expect(updates).toEqual([
      {
        projectId: 'multi',
        worktreeId: 'child',
        repoId: 'repo-a',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
      {
        projectId: 'single',
        worktreeId: 'single-child',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
    ]);
    expect(persistedWorktrees.multi[0]?.trackedRepoBaseBranches).toEqual({
      'repo-a': 'main',
      'repo-b': 'feature-parent',
    });
    expect(persistedWorktrees.single[0]?.trackedBaseBranch).toBe('main');
    expect(mockedFetchOrigin).toHaveBeenCalledTimes(2);
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/a', {
      backgroundPriority: true,
      signal: ANY_ABORT_SIGNAL,
    });
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/a-copy', {
      backgroundPriority: true,
      signal: ANY_ABORT_SIGNAL,
    });
  });

  it('updates source-backed project root repo base branches per repo id', async () => {
    persistedWorktrees = {
      'source-workspace': [
        worktree('child', {
          trackedRepoBaseBranches: {
            [WORKSPACE_ROOT_REPO_ID]: 'feature-parent',
            child: 'feature-parent',
          },
        }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        multiRepoWorkspace({
          id: 'source-workspace',
          sourceRepoPath: '/repos/workspace-source',
          repos: [{ id: 'child', name: 'Child', repoPath: '/repos/child' }],
          worktrees: persistedWorktrees['source-workspace'],
        }),
      ],
    });
    mockedGetRemoteUrl.mockImplementation((repoPath) => {
      if (repoPath === '/repos/workspace-source') {
        return Promise.resolve('git@github.com:acme/workspace.git');
      }
      return Promise.resolve('git@github.com:acme/child.git');
    });

    await updateDependentBaseBranchesForMergedWorktree({
      mergedWorkspaceId: 'current',
      mergedWorktreeId: 'feature-parent',
      mergedRepoFullName: 'acme/workspace',
      mergedBranchName: 'feature-parent',
      mergedIntoBranchName: 'main',
    });

    expect(
      persistedWorktrees['source-workspace'][0]?.trackedRepoBaseBranches,
    ).toEqual({
      [WORKSPACE_ROOT_REPO_ID]: 'main',
      child: 'feature-parent',
    });
  });

  it('continues after a project persistence failure and returns applied updates', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    persistedWorktrees = {
      first: [worktree('first-child', { trackedBaseBranch: 'feature-parent' })],
      failing: [
        worktree('failing-child', { trackedBaseBranch: 'feature-parent' }),
      ],
      second: [
        worktree('second-child', { trackedBaseBranch: 'feature-parent' }),
      ],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        singleRepoWorkspace({
          id: 'first',
          repoPath: '/repos/first',
          worktrees: persistedWorktrees.first,
        }),
        singleRepoWorkspace({
          id: 'failing',
          repoPath: '/repos/failing',
          worktrees: persistedWorktrees.failing,
        }),
        singleRepoWorkspace({
          id: 'second',
          repoPath: '/repos/second',
          worktrees: persistedWorktrees.second,
        }),
      ],
    });
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:acme/repo.git');
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        if (workspaceId === 'failing') {
          throw new Error('persist failed');
        }
        const current = persistedWorktrees[workspaceId] ?? [];
        const updated = await updater(current);
        persistedWorktrees[workspaceId] = updated;
        return updated;
      },
    );

    const updates = await updateDependentBaseBranchesForMergedWorktree({
      mergedWorkspaceId: 'current',
      mergedWorktreeId: 'feature-parent',
      mergedRepoFullName: 'acme/repo',
      mergedBranchName: 'feature-parent',
      mergedIntoBranchName: 'main',
    });

    expect(updates).toEqual([
      {
        projectId: 'first',
        worktreeId: 'first-child',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
      {
        projectId: 'second',
        worktreeId: 'second-child',
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
    ]);
    expect(persistedWorktrees.first[0]?.trackedBaseBranch).toBe('main');
    expect(persistedWorktrees.failing[0]?.trackedBaseBranch).toBe(
      'feature-parent',
    );
    expect(persistedWorktrees.second[0]?.trackedBaseBranch).toBe('main');
    expect(warnSpy).toHaveBeenCalledWith(
      '[github-sync] failed to update dependent worktree base branches',
      expect.objectContaining({ workspaceId: 'failing' }),
    );
    warnSpy.mockRestore();
  });
});
