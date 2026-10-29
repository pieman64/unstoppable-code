import { WorkspaceConfigUnreadableError } from '../lib/workspace-manifest-repository';

const mockGetRemoteUrl = jest.fn();
const mockGetRemoteUrlStrict = jest.fn();
const mockIsGitRepo = jest.fn();

jest.mock('../lib/git', () => ({
  getRemoteUrl: mockGetRemoteUrl,
  getRemoteUrlStrict: mockGetRemoteUrlStrict,
  isGitRepo: mockIsGitRepo,
}));

const mockReadWorkspaceConfig = jest.fn();
const mockReadWorkspaceConfigDetailed = jest.fn();
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: mockReadWorkspaceConfig,
  readWorkspaceConfigDetailed: mockReadWorkspaceConfigDetailed,
}));

const mockGetWorktreeDir = jest.fn(() => '/mock/worktree');
jest.mock('../lib/paths', () => ({
  getWorktreeDir: mockGetWorktreeDir,
}));

const mockListWorkspaceWorktreeRepoEntries = jest.fn(() => Promise.resolve([]));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: mockListWorkspaceWorktreeRepoEntries,
}));

import {
  resolveGitHubRepositoryCandidates,
  resolveUnambiguousGitHubRepository,
} from '../lib/github-repository-context';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

describe('resolveGitHubRepositoryCandidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGitRepo.mockResolvedValue(true);
  });

  it('accepts a GitHub HTTPS remote with a trailing slash', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/Owner/Repo/');

    await expect(
      resolveGitHubRepositoryCandidates({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        cwd: '/mock/worktree',
      }),
    ).resolves.toEqual(['owner/repo']);
  });

  describe('cowork chats', () => {
    beforeEach(() => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    });
    afterEach(() => {
      registerWorkspaceTypes(new Map());
    });

    it('infers the repository when the cowork folder is a GitHub checkout', async () => {
      mockGetRemoteUrl.mockResolvedValue('git@github.com:Acme/Api.git');

      await expect(
        resolveGitHubRepositoryCandidates({
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
          cwd: '/cowork/checkout',
        }),
      ).resolves.toEqual(['acme/api']);
    });

    it.each([
      ['a non-git folder', '/cowork/notes'],
      ['no folder', undefined],
    ])(
      'returns no candidates for %s instead of probing a worktree path',
      async (_label, cwd) => {
        mockIsGitRepo.mockResolvedValue(false);
        mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/api');

        await expect(
          resolveGitHubRepositoryCandidates({
            projectId: 'cowork-1',
            worktreeId: 'entry-1',
            ...(cwd ? { cwd } : {}),
          }),
        ).resolves.toEqual([]);
        expect(mockGetWorktreeDir).not.toHaveBeenCalled();
        expect(mockListWorkspaceWorktreeRepoEntries).not.toHaveBeenCalled();
        expect(mockGetRemoteUrl).not.toHaveBeenCalled();
      },
    );
  });

  it('falls back to the worktree checkout for a non-git worktree cwd', async () => {
    mockIsGitRepo.mockResolvedValue(false);
    mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/widgets');

    await expect(
      resolveGitHubRepositoryCandidates({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        cwd: '/mock/worktree/sub',
      }),
    ).resolves.toEqual(['acme/widgets']);
    expect(mockGetWorktreeDir).toHaveBeenCalledWith('project-1', 'worktree-1');
  });
});

describe('resolveUnambiguousGitHubRepository', () => {
  const origin = { projectId: 'project-1', worktreeId: 'worktree-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    mockGetRemoteUrlStrict.mockResolvedValue('git@github.com:Acme/Api.git');
    mockReadWorkspaceConfigDetailed.mockImplementation(async () => {
      const config: unknown = await mockReadWorkspaceConfig();
      return {
        config,
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
      };
    });
  });

  it('rejects normalized unreadable configuration instead of confirming an ambiguous origin', async () => {
    const config = { version: 1, type: 'multi-repo', repos: [] };
    mockReadWorkspaceConfig.mockResolvedValue(config);
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      config,
      authority: 'unreadable',
      ownerMalformed: false,
      memoryMalformed: false,
    });
    await expect(resolveUnambiguousGitHubRepository(origin)).rejects.toThrow(
      WorkspaceConfigUnreadableError,
    );
    expect(mockGetRemoteUrlStrict).not.toHaveBeenCalled();
  });

  it('treats a confirmed absent manifest as no repository without probing Git', async () => {
    const config = { version: 1, type: 'multi-repo', repos: [] };
    mockReadWorkspaceConfig.mockResolvedValue(config);
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      config,
      authority: 'absent',
      ownerMalformed: false,
      memoryMalformed: false,
    });
    await expect(
      resolveUnambiguousGitHubRepository(origin),
    ).resolves.toBeNull();
    expect(mockGetRemoteUrlStrict).not.toHaveBeenCalled();
  });

  it('resolves the GitHub origin of a single-repository worktree', async () => {
    await expect(resolveUnambiguousGitHubRepository(origin)).resolves.toBe(
      'acme/api',
    );
    expect(mockGetRemoteUrlStrict).toHaveBeenCalledWith('/mock/worktree');
    expect(mockListWorkspaceWorktreeRepoEntries).not.toHaveBeenCalled();
  });

  it.each(['multi-repo', 'cowork'])(
    'never resolves a %s workspace, whatever its checkouts',
    async (type) => {
      mockReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type,
        repos: [],
      });
      await expect(resolveUnambiguousGitHubRepository(origin)).resolves.toBe(
        null,
      );
      expect(mockGetRemoteUrlStrict).not.toHaveBeenCalled();
    },
  );

  it('fails instead of guessing when the config or remote cannot be read', async () => {
    mockReadWorkspaceConfig.mockRejectedValueOnce(new Error('io'));
    await expect(resolveUnambiguousGitHubRepository(origin)).rejects.toThrow(
      'io',
    );
    mockGetRemoteUrlStrict.mockRejectedValueOnce(new Error('git'));
    await expect(resolveUnambiguousGitHubRepository(origin)).rejects.toThrow(
      'git',
    );
  });

  it.each([
    ['no origin remote', null],
    ['a non-GitHub remote', 'https://gitlab.com/acme/api.git'],
  ])('resolves nothing for %s', async (_label, remote) => {
    mockGetRemoteUrlStrict.mockResolvedValue(remote);
    await expect(resolveUnambiguousGitHubRepository(origin)).resolves.toBe(
      null,
    );
  });

  it('never resolves a registered cowork project', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    try {
      await expect(
        resolveUnambiguousGitHubRepository({
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
        }),
      ).resolves.toBe(null);
      expect(mockReadWorkspaceConfig).not.toHaveBeenCalled();
    } finally {
      registerWorkspaceTypes(new Map());
    }
  });
});
