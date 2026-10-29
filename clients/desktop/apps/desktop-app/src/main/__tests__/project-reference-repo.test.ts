jest.mock('../lib/git', () => ({
  getRepoRootFromWorktree: jest.fn(),
  getRemoteUrlStrict: jest.fn(),
  isGitRepo: jest.fn(),
}));
jest.mock('../lib/repo-shadow', () => ({
  ensureRepoShadow: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));

import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  getRemoteUrlStrict,
  getRepoRootFromWorktree,
  isGitRepo,
} from '../lib/git';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { ensureRepoShadow } from '../lib/repo-shadow';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { inspectReferenceRepo } from '../lib/workspace-reference-repo-health';

const mockedGetRepoRootFromWorktree = jest.mocked(getRepoRootFromWorktree);
const mockedGetRemoteUrlStrict = jest.mocked(getRemoteUrlStrict);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedEnsureRepoShadow = jest.mocked(ensureRepoShadow);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedResolveWorkspaceReferenceRepoPath = jest.mocked(
  resolveWorkspaceReferenceRepoPath,
);

function createWorkspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [],
    ...overrides,
  };
}

describe('resolveProjectReferenceRepoPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the canonical repo root when git resolves one', async () => {
    mockedGetRepoRootFromWorktree.mockResolvedValue('/repos/source');

    await expect(
      resolveProjectReferenceRepoPath('/repos/worktree'),
    ).resolves.toBe('/repos/source');
  });

  it('falls back to the configured repo path when resolution fails', async () => {
    mockedGetRepoRootFromWorktree.mockRejectedValue(
      new Error('not a worktree'),
    );

    await expect(
      resolveProjectReferenceRepoPath('/repos/worktree'),
    ).resolves.toBe('/repos/worktree');
  });
});

describe('inspectReferenceRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the project has no sourceRepoPath', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());

    await expect(inspectReferenceRepo('workspace-1')).resolves.toBeNull();
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
  });

  it('reports a healthy status with shadowPath and defaultBranch when the shadow syncs', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/source' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/repos/resolved-source',
    );
    mockedGetRemoteUrlStrict.mockResolvedValue('git@example.com:org/repo.git');
    mockedEnsureRepoShadow.mockResolvedValue({
      repoPath: '/repos/resolved-source',
      shadowPath: '/canopy-data/repo-shadows/abc123/checkout',
      defaultBranch: 'main',
      lastSyncAt: '2026-07-07T00:00:00.000Z',
    });

    const status = await inspectReferenceRepo('workspace-1');

    // Health inspection always probes live past the recent-failure cache so a
    // just-fixed remote heals immediately.
    expect(mockedEnsureRepoShadow).toHaveBeenCalledWith(
      '/repos/resolved-source',
      { bypassFailureCache: true },
    );
    expect(typeof status?.lastCheckedAt).toBe('string');
    expect(status).toEqual({
      referenceRepoPath: '/repos/resolved-source',
      shadowPath: '/canopy-data/repo-shadows/abc123/checkout',
      healthy: true,
      warnings: [],
      lastCheckedAt: status?.lastCheckedAt,
      remoteUrl: 'git@example.com:org/repo.git',
      defaultBranch: 'main',
    });
  });

  it('reports a healthy status without maintaining a shadow for a local-only source repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/source' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/repos/resolved-source',
    );
    mockedGetRemoteUrlStrict.mockResolvedValue(null);
    mockedIsGitRepo.mockResolvedValue(true);

    const status = await inspectReferenceRepo('workspace-1');

    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
    expect(typeof status?.lastCheckedAt).toBe('string');
    expect(status).toEqual({
      referenceRepoPath: '/repos/resolved-source',
      healthy: true,
      warnings: [],
      lastCheckedAt: status?.lastCheckedAt,
    });
  });

  it('reports a shadow-sync-failed warning when the shadow sync rejects', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/source' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/repos/resolved-source',
    );
    mockedGetRemoteUrlStrict.mockResolvedValue('git@example.com:org/repo.git');
    mockedEnsureRepoShadow.mockRejectedValue(new Error('no remote default'));

    const status = await inspectReferenceRepo('workspace-1');

    expect(typeof status?.lastCheckedAt).toBe('string');
    expect(status).toEqual({
      referenceRepoPath: '/repos/resolved-source',
      healthy: false,
      warnings: [{ code: 'shadow-sync-failed', message: 'no remote default' }],
      lastCheckedAt: status?.lastCheckedAt,
      remoteUrl: 'git@example.com:org/repo.git',
    });
  });

  it('does not classify an invalid source path as a healthy local-only repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/missing' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue('/repos/missing');
    mockedGetRemoteUrlStrict.mockResolvedValue(null);
    mockedIsGitRepo.mockResolvedValue(false);
    mockedEnsureRepoShadow.mockRejectedValue(new Error('not a git repository'));

    const status = await inspectReferenceRepo('workspace-1');

    expect(status).toEqual({
      referenceRepoPath: '/repos/missing',
      healthy: false,
      warnings: [
        { code: 'shadow-sync-failed', message: 'not a git repository' },
      ],
      lastCheckedAt: status?.lastCheckedAt,
      remoteUrl: undefined,
    });
  });

  it('propagates an unexpected origin lookup failure without reporting healthy', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/source' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/repos/resolved-source',
    );
    mockedGetRemoteUrlStrict.mockRejectedValue(
      new Error('git remote lookup failed'),
    );
    mockedIsGitRepo.mockResolvedValue(true);

    await expect(inspectReferenceRepo('workspace-1')).rejects.toThrow(
      'git remote lookup failed',
    );
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
  });

  it('reports an unhealthy status when origin lookup fails for an invalid path', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({ sourceRepoPath: '/repos/missing' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue('/repos/missing');
    mockedGetRemoteUrlStrict.mockRejectedValue(
      new Error('not a git repository'),
    );
    mockedIsGitRepo.mockResolvedValue(false);

    const status = await inspectReferenceRepo('workspace-1');

    expect(status).toEqual({
      referenceRepoPath: '/repos/missing',
      healthy: false,
      warnings: [
        { code: 'shadow-sync-failed', message: 'not a git repository' },
      ],
      lastCheckedAt: status?.lastCheckedAt,
    });
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
  });
});
