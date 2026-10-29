jest.mock('../lib/git', () => ({
  doesLocalBranchExist: jest.fn(),
  doesRemoteBranchExist: jest.fn(),
  getCurrentBranch: jest.fn(),
  getLocalDefaultBranch: jest.fn(),
  getRepoRootFromWorktree: jest.fn(),
  hasLocalCommit: jest.fn(),
}));
jest.mock('../lib/git-default-branch', () => ({
  resolveFreshDefaultBranch: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

import {
  doesLocalBranchExist,
  doesRemoteBranchExist,
  getLocalDefaultBranch,
  hasLocalCommit,
} from '../lib/git';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import {
  resolveEffectiveBaseBranchForRepo,
  resolveEffectiveBaseBranchesForWorktree,
  resolveRepoDefaultBranch,
} from '../lib/worktree-base-branches';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';

const mockedGetLocalDefaultBranch = jest.mocked(getLocalDefaultBranch);
const mockedHasLocalCommit = jest.mocked(hasLocalCommit);
const mockedDoesLocalBranchExist = jest.mocked(doesLocalBranchExist);
const mockedDoesRemoteBranchExist = jest.mocked(doesRemoteBranchExist);
const mockedResolveFreshDefaultBranch = jest.mocked(resolveFreshDefaultBranch);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

describe('resolveRepoDefaultBranch', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('falls back to the local default without excluding the current branch', async () => {
    mockedResolveFreshDefaultBranch.mockResolvedValue(null);
    mockedGetLocalDefaultBranch.mockResolvedValue('trunk');

    await expect(resolveRepoDefaultBranch('/repo')).resolves.toBe('trunk');

    expect(mockedGetLocalDefaultBranch).toHaveBeenCalledWith('/repo');
  });

  it('disables remote discovery for local-only callers', async () => {
    mockedResolveFreshDefaultBranch.mockResolvedValue('main');

    await expect(
      resolveRepoDefaultBranch('/repo', { allowRemoteLookup: false }),
    ).resolves.toBe('main');

    expect(mockedResolveFreshDefaultBranch).toHaveBeenCalledWith('/repo', {
      allowRemoteLookup: false,
    });
  });
});

describe('resolveEffectiveBaseBranchForRepo', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('recognizes a locally available tracked commit SHA as a diff base', async () => {
    const commitSha = 'a'.repeat(40);
    mockedReadWorkspaceConfig.mockResolvedValue({
      type: 'single-repo',
      repoPath: '/repo',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'worktree-1',
        branchName: 'canopy/fork',
        createdAt: '2026-09-10T00:00:00.000Z',
        trackedBaseBranch: commitSha,
      },
    ]);
    mockedHasLocalCommit.mockResolvedValue(true);
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);

    await expect(
      resolveEffectiveBaseBranchForRepo({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        repoPath: '/repo',
        allowRemoteLookup: false,
      }),
    ).resolves.toEqual({
      branch: commitSha,
      existsLocally: true,
      existsInRemote: false,
    });

    expect(mockedHasLocalCommit).toHaveBeenCalledWith('/repo', commitSha);
  });

  it('recognizes a 40-hex tracked branch when no same-named commit exists', async () => {
    const branchName = 'f'.repeat(40);
    mockedReadWorkspaceConfig.mockResolvedValue({
      type: 'single-repo',
      repoPath: '/repo',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'worktree-1',
        branchName: 'canopy/fork',
        createdAt: '2026-09-10T00:00:00.000Z',
        trackedBaseBranch: branchName,
      },
    ]);
    mockedHasLocalCommit.mockResolvedValue(false);
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);

    await expect(
      resolveEffectiveBaseBranchForRepo({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        repoPath: '/repo',
        allowRemoteLookup: false,
      }),
    ).resolves.toEqual({
      branch: branchName,
      existsLocally: true,
      existsInRemote: false,
    });
  });

  it('recognizes locally available tracked commit SHAs for multi-repo stats', async () => {
    const commitSha = 'b'.repeat(40);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'repo-1', name: 'Repo', repoPath: '/source/repo' }],
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'worktree-1',
        branchName: 'canopy/fork',
        createdAt: '2026-09-10T00:00:00.000Z',
        trackedRepoBaseBranches: { 'repo-1': commitSha },
      },
    ]);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        repoPath: '/worktree/repos/repo-1',
      },
    ]);
    mockedHasLocalCommit.mockResolvedValue(true);
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);

    await expect(
      resolveEffectiveBaseBranchesForWorktree({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        cwd: '/worktree',
        allowRemoteLookup: false,
      }),
    ).resolves.toEqual({
      'repo-1': {
        branch: commitSha,
        existsLocally: true,
        existsInRemote: false,
      },
    });

    expect(mockedHasLocalCommit).toHaveBeenCalledWith(
      '/worktree/repos/repo-1',
      commitSha,
    );
  });
});
