jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

import { readdir } from 'node:fs/promises';
import { Dirent } from 'node:fs';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { isGitRepo } from '../lib/git';
import {
  listWorkspaceWorktreeRepoEntries,
  resolveWorktreeCodeGraphRepositories,
} from '../lib/worktree-repo-entries';
import { readWorkspaceConfig } from '../lib/workspace-persistence';

const mockedReaddir = jest.mocked(readdir);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);

const directoryEntry = (name: string): Dirent =>
  Object.assign(new Dirent(), {
    name,
    isDirectory: (): boolean => true,
  });

describe('listWorkspaceWorktreeRepoEntries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReaddir.mockResolvedValue([]);
    mockedIsGitRepo.mockResolvedValue(false);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
  });

  it('includes the project root when the worktree root is a git repo even if sourceRepoPath is missing', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    mockedReaddir.mockResolvedValue([directoryEntry('app')]);

    await expect(
      listWorkspaceWorktreeRepoEntries('workspace-1', '/worktrees/feature'),
    ).resolves.toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
        repoPath: '/worktrees/feature',
      },
      {
        repoId: 'app',
        repoName: 'App',
        repoPath: '/worktrees/feature/repos/app',
      },
    ]);
  });

  it('does not add a workspace-root entry for local-only non-git roots', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    mockedReaddir.mockResolvedValue([directoryEntry('app')]);

    await expect(
      listWorkspaceWorktreeRepoEntries('workspace-1', '/worktrees/feature'),
    ).resolves.toEqual([
      {
        repoId: 'app',
        repoName: 'App',
        repoPath: '/worktrees/feature/repos/app',
      },
    ]);
  });

  it('does not synthesize a root graph for an empty local-only multi-repo project', async () => {
    await expect(
      resolveWorktreeCodeGraphRepositories('workspace-1', '/worktrees/feature'),
    ).resolves.toEqual([]);
  });

  it('retains the synthetic root descriptor for a single-repository project', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/app',
      repos: [],
    });

    await expect(
      resolveWorktreeCodeGraphRepositories('workspace-1', '/worktrees/feature'),
    ).resolves.toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        rootPath: '/worktrees/feature',
      },
    ]);
  });
});
