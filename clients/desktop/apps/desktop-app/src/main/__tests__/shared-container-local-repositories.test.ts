jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/tmp/worktree'),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
  resolveWorktreeCodeGraphRepositories: jest.fn(),
}));

import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import {
  listWorkspaceWorktreeRepoEntries,
  resolveWorktreeCodeGraphRepositories,
} from '../lib/worktree-repo-entries';
import { listSharedContainerLocalRepositories } from '../shared-containers/local-repositories';

const listEntriesMock = jest.mocked(listWorkspaceWorktreeRepoEntries);
const resolveGraphRepositoriesMock = jest.mocked(
  resolveWorktreeCodeGraphRepositories,
);

describe('listSharedContainerLocalRepositories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveGraphRepositoriesMock.mockResolvedValue([]);
  });

  it('uses the canonical single-repository root fallback', async () => {
    listEntriesMock.mockResolvedValue([]);
    resolveGraphRepositoriesMock.mockResolvedValue([
      { repoId: WORKSPACE_ROOT_REPO_ID, rootPath: '/tmp/worktree' },
    ]);

    await expect(
      listSharedContainerLocalRepositories('project-1', 'worktree-1'),
    ).resolves.toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: WORKSPACE_ROOT_REPO_NAME,
        repoPath: '/tmp/worktree',
        relativePrefix: '',
      },
    ]);
  });

  it('preserves configured names and prefixes for multi-repository children', async () => {
    listEntriesMock.mockResolvedValue([
      {
        repoId: 'web',
        repoName: 'Web App',
        repoPath: '/tmp/worktree/repos/web',
      },
    ]);

    await expect(
      listSharedContainerLocalRepositories('project-1', 'worktree-1'),
    ).resolves.toEqual([
      {
        repoId: 'web',
        repoName: 'Web App',
        repoPath: '/tmp/worktree/repos/web',
        relativePrefix: 'repos/web',
      },
    ]);
    expect(resolveGraphRepositoriesMock).not.toHaveBeenCalled();
  });
});
