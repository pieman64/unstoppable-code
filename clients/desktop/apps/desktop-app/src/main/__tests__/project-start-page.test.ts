const mockIsStartPageFeatureEnabled = jest.fn(() => true);
const mockReadWorkspaceConfig = jest.fn<Promise<unknown>, [string]>();
const mockReadCanopyJson = jest.fn<Promise<unknown>, [string]>();

jest.mock('../lib/start-page-feature-flag', () => ({
  isStartPageFeatureEnabled: (): boolean => mockIsStartPageFeatureEnabled(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (workspaceId: string): Promise<unknown> =>
    mockReadWorkspaceConfig(workspaceId),
}));
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: (repoPath: string): Promise<unknown> =>
    mockReadCanopyJson(repoPath),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: (repoPath: string): Promise<string> =>
    Promise.resolve(`${repoPath}/reference`),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: (repoPath: string): Promise<string> =>
    Promise.resolve(`${repoPath}/reference`),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDir: (projectId: string, worktreeId: string): string =>
    `/worktrees/${projectId}/${worktreeId}`,
  getWorkspaceWorktreeRootRepoDir: (
    projectId: string,
    worktreeId: string,
  ): string => `/workspace-worktrees/${projectId}/${worktreeId}`,
}));

import { resolveProjectStartPage } from '../lib/project-start-page';

describe('resolveProjectStartPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStartPageFeatureEnabled.mockReturnValue(true);
  });

  it('returns null without reading persistence when the flag is off', async () => {
    mockIsStartPageFeatureEnabled.mockReturnValue(false);
    await expect(
      resolveProjectStartPage({ projectId: 'project-1' }),
    ).resolves.toBeNull();
    expect(mockReadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('resolves cowork settings', async () => {
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { startPage: { kind: 'file', path: 'README.md' } },
    });
    await expect(
      resolveProjectStartPage({ projectId: 'cowork-1' }),
    ).resolves.toEqual({
      startPage: { kind: 'file', path: 'README.md' },
      source: 'cowork',
    });
  });

  it('lets a local null override suppress the source manifest', async () => {
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      startPage: null,
    });
    await expect(
      resolveProjectStartPage({ projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toBeNull();
    expect(mockReadCanopyJson).not.toHaveBeenCalled();
  });

  it('prefers the worktree manifest and falls back to the reference repo', async () => {
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
    });
    mockReadCanopyJson
      .mockResolvedValueOnce({
        version: 1,
        startPage: { kind: 'file', path: 'worktree.md' },
      })
      .mockResolvedValueOnce({
        version: 1,
        startPage: { kind: 'file', path: 'reference.md' },
      });

    await expect(
      resolveProjectStartPage({ projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toEqual({
      startPage: { kind: 'file', path: 'worktree.md' },
      source: 'source',
    });
    expect(mockReadCanopyJson).toHaveBeenCalledTimes(1);

    mockReadCanopyJson.mockReset();
    mockReadCanopyJson.mockResolvedValueOnce(null).mockResolvedValueOnce({
      version: 1,
      startPage: { kind: 'url', url: 'https://example.com' },
    });
    await expect(
      resolveProjectStartPage({ projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toEqual({
      startPage: { kind: 'url', url: 'https://example.com' },
      source: 'source',
    });
  });
});
