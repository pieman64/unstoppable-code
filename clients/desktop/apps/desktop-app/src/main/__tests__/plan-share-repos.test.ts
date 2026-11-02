jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
  getCurrentBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

import { SINGLE_REPO_USAGE_REPO_ID } from '@canopy/desktop-shared/types';
import {
  getCurrentBranch,
  getRemoteDefaultBranch,
  getRemoteUrl,
} from '../lib/git';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import {
  buildSharedPlanRepositoryRefs,
  sanitizeRemoteUrl,
} from '../lib/plan-share-repos';

const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

describe('plan share repo snapshots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetCurrentBranch.mockResolvedValue('feature');
    mockedGetRemoteDefaultBranch.mockResolvedValue('main');
  });

  it('strips credentials from URL remotes and rejects unparsable remotes', () => {
    expect(
      sanitizeRemoteUrl('https://user:token@github.com/acme/repo.git'),
    ).toBe('https://github.com/acme/repo.git');
    expect(
      sanitizeRemoteUrl(
        'https://github.com/acme/repo.git?access_token=secret#token',
      ),
    ).toBe('https://github.com/acme/repo.git');
    expect(sanitizeRemoteUrl('git@github.com:acme/repo.git')).toBe(
      'git@github.com:acme/repo.git',
    );
    expect(
      sanitizeRemoteUrl(
        'git@github.com:acme/repo.git?access_token=secret#token',
      ),
    ).toBeNull();
    expect(sanitizeRemoteUrl('ghp_secret@github.com:acme/repo.git')).toBeNull();
    expect(
      sanitizeRemoteUrl('x-access-token:secret@github.com:acme/repo.git'),
    ).toBeNull();
    expect(
      sanitizeRemoteUrl('https://user@example.com:bad/repo.git'),
    ).toBeNull();
    expect(sanitizeRemoteUrl('ssh://user@example.com:bad/repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('not a url')).toBeNull();
  });

  it('rejects local file and absolute-path remotes', () => {
    expect(sanitizeRemoteUrl('file:///Users/example/repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('/Users/example/repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('~/repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('C:repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('C:\\Users\\example\\repo.git')).toBeNull();
    expect(sanitizeRemoteUrl('\\\\server\\share\\repo.git')).toBeNull();
  });

  it('builds a single-repo snapshot without leaking local paths', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/tmp/local/repo');
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/secret/source',
          color: 'blue',
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    mockedGetRemoteUrl.mockResolvedValue(
      'https://x-access-token:secret@github.com/acme/repo.git',
    );

    const refs = await buildSharedPlanRepositoryRefs('project-a', 'wt-1');

    expect(refs).toEqual([
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'Project A',
        remoteUrl: 'https://github.com/acme/repo.git',
        branch: 'feature',
        commitSha: null,
        defaultBranch: 'main',
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain('/tmp/local/repo');
    expect(JSON.stringify(refs)).not.toContain('/secret/source');
  });

  it('uses multi-repo worktree entries and tolerates missing git metadata', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/tmp/workspace/wt-1');
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: 'blue',
          repos: [],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'api',
        repoName: 'API',
        repoPath: '/tmp/workspace/wt-1/repos/api',
      },
    ]);
    mockedGetRemoteUrl.mockResolvedValue('not a url');
    mockedGetCurrentBranch.mockRejectedValue(new Error('missing branch'));
    mockedGetRemoteDefaultBranch.mockRejectedValue(
      new Error('missing default'),
    );

    const refs = await buildSharedPlanRepositoryRefs('workspace-a', 'wt-1');

    expect(refs).toEqual([
      {
        repoId: 'api',
        repoName: 'API',
        remoteUrl: null,
        branch: null,
        commitSha: null,
        defaultBranch: null,
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain('/tmp/workspace');
  });
});
