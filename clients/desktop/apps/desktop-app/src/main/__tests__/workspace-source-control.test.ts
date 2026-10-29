let mockContextEnabled = true;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({
    isEnabled: (): boolean => mockContextEnabled,
  }),
}));
import type * as InstructionFiles from '../lib/instruction-files';
jest.mock('node:fs/promises');
jest.mock('../lib/git', () => ({
  bestEffortPruneWorktrees: jest.fn(),
  commitWithLocalIdentity: jest.fn(),
  createWorktree: jest.fn(),
  getRemoteUrl: jest.fn(),
  initGitRepo: jest.fn(),
  isGitRepo: jest.fn(),
  pruneWorktrees: jest.fn(),
  removeWorktree: jest.fn(),
  stageAllChanges: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getDefaultReposDir: jest.fn(() => '/mock/repos'),
  getWorkspaceClaudeMdPath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/CLAUDE.md`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  writeCanopyJson: jest.fn(),
}));
jest.mock('../lib/instruction-files', () => ({
  ...jest.requireActual<typeof InstructionFiles>('../lib/instruction-files'),
  ensureAgentsMdSymlink: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<unknown>, [string]>();
  const writeWorkspaceConfig = jest.fn();
  return {
    readWorkspaceConfig,
    readWorkspaceWorktrees: jest.fn(),
    writeWorkspaceConfig,
    WorkspaceConfigUnreadableError: class WorkspaceConfigUnreadableError extends Error {},
    readWorkspaceConfigDetailed: jest.fn(async (workspaceId: string) => ({
      config: await readWorkspaceConfig(workspaceId),
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
    })),
    // The in-queue read of the source repository record (CAN-3819).
    updateWorkspaceConfig: jest.fn(
      async (
        workspaceId: string,
        update: (config: unknown, read: unknown) => unknown,
      ): Promise<unknown> => {
        const config = await readWorkspaceConfig(workspaceId);
        const result = await update(config, {
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
        });
        await writeWorkspaceConfig(workspaceId, config);
        return result;
      },
    ),
  };
});

import { constants, statSync, type Stats } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  commitWithLocalIdentity,
  createWorktree,
  getRemoteUrl,
  initGitRepo,
  isGitRepo,
  stageAllChanges,
} from '../lib/git';
import { readCanopyJson, writeCanopyJson } from '../lib/canopy-json';
import { ensureAgentsMdSymlink } from '../lib/instruction-files';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  writeWorkspaceConfig,
} from '../lib/workspace-persistence';
import {
  buildWorkspaceManifest,
  initializeWorkspaceSourceRepo,
  repairWorkspaceRootWorktree,
  repairExistingWorkspaceRootWorktrees,
  validateWorkspaceRootWorktree,
} from '../lib/workspace-source-control';

const mockedCommitWithLocalIdentity = jest.mocked(commitWithLocalIdentity);
const mockedCopyFile = jest.mocked(copyFile);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedEnsureAgentsMdSymlink = jest.mocked(ensureAgentsMdSymlink);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedInitGitRepo = jest.mocked(initGitRepo);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedMkdir = jest.mocked(mkdir);
const mockedReaddir = jest.mocked(readdir);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadFile = jest.mocked(readFile);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRename = jest.mocked(rename);
const mockedRm = jest.mocked(rm);
const mockedStageAllChanges = jest.mocked(stageAllChanges);
const mockedStat = jest.mocked(stat);
const mockedWriteCanopyJson = jest.mocked(writeCanopyJson);
const mockedWriteFile = jest.mocked(writeFile);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);

function createMissingError(pathStr: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, stat '${pathStr}'`),
    { code: 'ENOENT' },
  );
}

function makeStats(isSymbolicLink: boolean): Stats {
  const stats = statSync(__filename);
  Object.defineProperty(stats, 'isSymbolicLink', {
    value: (): boolean => isSymbolicLink,
  });
  return stats;
}

describe('project source control helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(lstat).mockImplementation((...args) => stat(...args));
    jest.mocked(access).mockResolvedValue(undefined);

    mockedCopyFile.mockResolvedValue(undefined);
    mockedCreateWorktree.mockResolvedValue('wt-1');
    mockedEnsureAgentsMdSymlink.mockResolvedValue(undefined);
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedInitGitRepo.mockResolvedValue(undefined);
    mockedIsGitRepo.mockResolvedValue(true);
    mockedMkdir.mockResolvedValue(undefined);
    mockedReaddir.mockResolvedValue([]);
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });
    mockedReadFile.mockResolvedValue('repos/\n');
    mockedRename.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedStageAllChanges.mockResolvedValue(undefined);
    mockedWriteCanopyJson.mockImplementation((_repoPath, manifest) =>
      Promise.resolve(manifest),
    );
    mockedWriteFile.mockResolvedValue(undefined);
    mockedWriteWorkspaceConfig.mockResolvedValue(undefined);
  });

  it('creates AGENTS.md symlink in the source repo before the initial commit', async () => {
    mockedReadWorkspaceConfig
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        hooks: {
          'pr:create': [
            {
              type: 'chat',
              prompt: 'Use plugin',
              promptReferences: [
                {
                  kind: 'plugin',
                  textStart: 4,
                  displayText: 'plugin',
                  plugin: {
                    kind: 'installed',
                    marketplaceId: 'market-1',
                    pluginName: 'plugin',
                  },
                },
              ],
              pluginSelections: {
                collectionIds: ['local-collection'],
                skillRefs: [],
                pluginRefs: [],
              },
            },
          ],
        },
        repos: [],
      })
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        hooks: {
          'pr:create': [
            {
              type: 'chat',
              prompt: 'Use plugin',
              promptReferences: [
                {
                  kind: 'plugin',
                  textStart: 4,
                  displayText: 'plugin',
                  plugin: {
                    kind: 'installed',
                    marketplaceId: 'market-1',
                    pluginName: 'plugin',
                  },
                },
              ],
              pluginSelections: {
                collectionIds: ['local-collection'],
                skillRefs: [],
                pluginRefs: [],
              },
            },
          ],
        },
        repos: [],
      })
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: '/mock/repos/example-workspace',
      });
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (pathStr === '/mock/workspaces/ws-1/CLAUDE.md') {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });

    const result = await initializeWorkspaceSourceRepo({
      workspaceId: 'ws-1',
      workspaceName: 'Example Workspace',
      source: 'workspace_settings',
    });

    expect(result.sourceRepoPath).toBe('/mock/repos/example-workspace');
    expect(mockedInitGitRepo).toHaveBeenCalledWith(
      '/mock/repos/example-workspace',
    );
    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/repos/example-workspace',
      {
        version: 1,
        hooks: {
          'pr:create': [
            {
              type: 'chat',
              prompt: 'Use plugin',
            },
          ],
        },
        repos: [],
      },
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'local-hook-plugin-selections' }),
    );
    const savedConfig = mockedWriteWorkspaceConfig.mock.calls.find(
      ([id]) => id === 'ws-1',
    )?.[1];
    expect(savedConfig?.hooks?.['pr:create']).toMatchObject([
      {
        localPluginSelectionOverlay: true,
        promptReferences: [{ kind: 'plugin', plugin: { kind: 'installed' } }],
      },
    ]);
    expect(mockedCopyFile).toHaveBeenCalledWith(
      '/mock/workspaces/ws-1/CLAUDE.md',
      '/mock/repos/example-workspace/CLAUDE.md',
      constants.COPYFILE_EXCL,
    );
    expect(mockedEnsureAgentsMdSymlink).toHaveBeenCalledWith(
      '/mock/repos/example-workspace',
    );
    expect(
      mockedEnsureAgentsMdSymlink.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedStageAllChanges.mock.invocationCallOrder[0]);
    expect(mockedCommitWithLocalIdentity).toHaveBeenCalledWith(
      '/mock/repos/example-workspace',
      'Initialize project source repo',
    );
  });

  it('preserves an existing gitignore when repos/ is already present', async () => {
    mockedReadWorkspaceConfig
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        repos: [],
      })
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        repos: [],
      })
      .mockResolvedValueOnce({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: '/mock/repos/example-workspace',
      });
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (
        pathStr === '/mock/workspaces/ws-1/CLAUDE.md' ||
        pathStr === '/mock/repos/example-workspace/.gitignore'
      ) {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });
    mockedReadFile.mockResolvedValue('  \r\nrepos/\r\n');

    await initializeWorkspaceSourceRepo({
      workspaceId: 'ws-1',
      workspaceName: 'Example Workspace',
      source: 'workspace_settings',
    });

    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('reports a stale AGENTS.md file as a repairable issue', async () => {
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/.gitignore' ||
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/CLAUDE.md'
      ) {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });
    mockedReadFile.mockResolvedValue('repos/\n');
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });

    const issues = await validateWorkspaceRootWorktree('ws-1', 'wt-1');

    expect(issues).toEqual(
      expect.arrayContaining([
        {
          code: 'invalid-agents-md',
          message: 'AGENTS.md must mirror CLAUDE.md',
          blocking: false,
        },
      ]),
    );
  });

  it.each(['validate', 'repair'])(
    'preserves an AGENTS-only root during %s',
    async (operation) => {
      const root = '/mock/workspaces/ws-1/worktrees/wt-1';
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: '/mock/repos/source',
      });
      mockedStat.mockImplementation((filePath) => {
        if (
          filePath === `${root}/AGENTS.md` ||
          filePath === `${root}/.gitignore`
        )
          return Promise.resolve(makeStats(false));
        return Promise.reject(createMissingError(String(filePath)));
      });
      if (operation === 'validate') {
        await expect(
          validateWorkspaceRootWorktree('ws-1', 'wt-1'),
        ).resolves.toEqual([]);
      } else {
        await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
      }
      expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
      expect(mockedCopyFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['AGENTS.md', 'directory'],
    ['CLAUDE.md', 'directory'],
    ['AGENTS.md', 'symbolic link'],
    ['CLAUDE.md', 'symbolic link'],
    ['AGENTS.md', 'unreadable file'],
    ['CLAUDE.md', 'unreadable file'],
  ])('reports non-blocking warnings for a %s %s', async (name, kind) => {
    const root = '/mock/workspaces/ws-1/worktrees/wt-1';
    const unsupportedStats = makeStats(kind === 'symbolic link');
    if (kind === 'directory')
      Object.defineProperty(unsupportedStats, 'isFile', {
        value: (): boolean => false,
      });
    mockedStat.mockImplementation((filePath) => {
      if (filePath === `${root}/${name}`)
        return Promise.resolve(unsupportedStats);
      if (filePath === `${root}/.gitignore`)
        return Promise.resolve(makeStats(false));
      return Promise.reject(createMissingError(String(filePath)));
    });
    jest.mocked(readlink).mockResolvedValue('docs/rules.md');
    if (kind === 'unreadable file')
      jest
        .mocked(access)
        .mockRejectedValue(
          Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
        );

    const issues = await validateWorkspaceRootWorktree('ws-1', 'wt-1');

    expect(issues.map((issue) => issue.code)).toEqual([
      'missing-claude-md',
      'invalid-agents-md',
    ]);
    expect(issues.every((issue) => !issue.blocking)).toBe(true);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('reports only the AGENTS warning when readable legacy guidance remains', async () => {
    const root = '/mock/workspaces/ws-1/worktrees/wt-1';
    mockedStat.mockImplementation((filePath) => {
      if (filePath === `${root}/AGENTS.md`)
        return Promise.resolve(makeStats(true));
      if (filePath === `${root}/CLAUDE.md` || filePath === `${root}/.gitignore`)
        return Promise.resolve(makeStats(false));
      return Promise.reject(createMissingError(String(filePath)));
    });
    jest.mocked(readlink).mockResolvedValue('docs/rules.md');

    const issues = await validateWorkspaceRootWorktree('ws-1', 'wt-1');

    expect(issues.map((issue) => issue.code)).toEqual(['invalid-agents-md']);
    expect(issues.every((issue) => !issue.blocking)).toBe(true);
  });

  it.each([
    ['root', 'AGENTS.md', 'directory'],
    ['root', 'CLAUDE.md', 'directory'],
    ['root', 'AGENTS.md', 'symbolic link'],
    ['root', 'CLAUDE.md', 'symbolic link'],
    ['source', 'AGENTS.md', 'directory'],
    ['source', 'CLAUDE.md', 'directory'],
    ['source', 'AGENTS.md', 'symbolic link'],
    ['source', 'CLAUDE.md', 'symbolic link'],
  ])('repairs metadata despite a %s %s %s', async (location, name, kind) => {
    const root = '/mock/workspaces/ws-1/worktrees/wt-1';
    const source = '/mock/repos/source';
    const unsupportedPath = `${location === 'root' ? root : source}/${name}`;
    const unsupportedStats = makeStats(kind === 'symbolic link');
    if (kind === 'directory')
      Object.defineProperty(unsupportedStats, 'isFile', {
        value: (): boolean => false,
      });
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: source,
    });
    mockedStat.mockImplementation((filePath) => {
      if (filePath === unsupportedPath)
        return Promise.resolve(unsupportedStats);
      if (filePath === `${root}/.gitignore`)
        return Promise.resolve(makeStats(false));
      return Promise.reject(createMissingError(String(filePath)));
    });
    jest.mocked(readlink).mockResolvedValue('/outside/project-rules.md');
    const issues = await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
    expect(issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(root, {
      version: 1,
      repos: [],
    });
    expect(mockedCopyFile).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
  });

  it('keeps an instruction copy failure non-blocking after metadata repair', async () => {
    const root = '/mock/workspaces/ws-1/worktrees/wt-1';
    const source = '/mock/repos/source';
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: source,
    });
    mockedStat.mockImplementation((filePath) => {
      if (
        filePath === `${root}/.gitignore` ||
        filePath === `${source}/AGENTS.md`
      )
        return Promise.resolve(makeStats(false));
      return Promise.reject(createMissingError(String(filePath)));
    });
    mockedCopyFile.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    const issues = await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
    expect(issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(issues.some((issue) => issue.code === 'missing-claude-md')).toBe(
      true,
    );
  });

  it('does not swallow a blocking manifest write failure during repair', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: '/mock/repos/source',
    });
    mockedWriteCanopyJson.mockRejectedValueOnce(
      new Error('Manifest write denied'),
    );
    await expect(
      repairWorkspaceRootWorktree('ws-1', 'wt-1', true),
    ).rejects.toThrow('Manifest write denied');
  });

  it.each(['AGENTS.md', 'CLAUDE.md'])(
    'restores source %s into a root without instructions',
    async (name) => {
      const root = '/mock/workspaces/ws-1/worktrees/wt-1';
      const source = '/mock/repos/source';
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: source,
      });
      mockedStat.mockImplementation((filePath) => {
        if (
          filePath === `${source}/${name}` ||
          filePath === `${root}/.gitignore`
        )
          return Promise.resolve(makeStats(false));
        return Promise.reject(createMissingError(String(filePath)));
      });
      await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
      expect(mockedCopyFile).toHaveBeenCalledWith(
        `${source}/${name}`,
        `${root}/${name}`,
        constants.COPYFILE_EXCL,
      );
      expect(mockedEnsureAgentsMdSymlink).toHaveBeenCalledTimes(
        name === 'CLAUDE.md' ? 1 : 0,
      );
    },
  );

  it.each(['equal copies', 'reverse alias', 'independent files'])(
    'restores source compatibility layout (%s) into an empty root',
    async (layout) => {
      const root = '/mock/workspaces/ws-1/worktrees/wt-1';
      const source = '/mock/repos/source';
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: source,
      });
      mockedStat.mockImplementation((filePath) => {
        if (
          filePath === `${source}/AGENTS.md` ||
          filePath === `${root}/.gitignore`
        )
          return Promise.resolve(makeStats(false));
        if (filePath === `${source}/CLAUDE.md`)
          return Promise.resolve(makeStats(layout === 'reverse alias'));
        return Promise.reject(createMissingError(String(filePath)));
      });
      jest.mocked(readlink).mockResolvedValue('AGENTS.md');
      mockedReadFile.mockImplementation((filePath) =>
        Promise.resolve(
          filePath === `${source}/CLAUDE.md` && layout === 'independent files'
            ? 'Claude-specific rules'
            : 'Shared rules',
        ),
      );
      await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
      expect(mockedCopyFile).toHaveBeenCalledWith(
        `${source}/AGENTS.md`,
        `${root}/AGENTS.md`,
        constants.COPYFILE_EXCL,
      );
      if (layout === 'reverse alias') {
        expect(symlink).toHaveBeenCalledWith('AGENTS.md', `${root}/CLAUDE.md`);
      } else {
        expect(mockedCopyFile).toHaveBeenCalledWith(
          `${source}/CLAUDE.md`,
          `${root}/CLAUDE.md`,
          constants.COPYFILE_EXCL,
        );
      }
      expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['AGENTS.md', 'CLAUDE.md'],
    ['CLAUDE.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
  ])(
    'restores a broken %s alias from source %s without creating a cycle',
    async (alias, sourceName) => {
      const root = '/mock/workspaces/ws-1/worktrees/wt-1';
      const source = '/mock/repos/source';
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: source,
      });
      mockedStat.mockImplementation((filePath) => {
        if (
          filePath === `${source}/${sourceName}` ||
          filePath === `${root}/.gitignore`
        )
          return Promise.resolve(makeStats(false));
        return Promise.reject(createMissingError(String(filePath)));
      });
      jest
        .mocked(lstat)
        .mockImplementation((...args) =>
          args[0] === `${root}/${alias}`
            ? Promise.resolve(makeStats(true))
            : stat(...args),
        );
      jest.mocked(readlink).mockResolvedValue(target);
      await repairWorkspaceRootWorktree('ws-1', 'wt-1', true);
      expect(mockedCopyFile).toHaveBeenCalledWith(
        `${source}/${sourceName}`,
        `${root}/${target}`,
        constants.COPYFILE_EXCL,
      );
      expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
    },
  );

  it('accepts an AGENTS.md file that mirrors CLAUDE.md during validation', async () => {
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/.gitignore' ||
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/AGENTS.md' ||
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/CLAUDE.md'
      ) {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });
    mockedReadFile.mockResolvedValue('repos/\n');
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });

    const issues = await validateWorkspaceRootWorktree('ws-1', 'wt-1');

    expect(issues.some((issue) => issue.code === 'invalid-agents-md')).toBe(
      false,
    );
  });

  it('does not auto-repair a warning-only AGENTS.md issue during background repair', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: '/mock/repos/example-workspace',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'wt-1',
        createdAt: '2026-03-24T00:00:00.000Z',
      },
    ]);
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1' ||
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/.gitignore' ||
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/CLAUDE.md'
      ) {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });
    mockedReadFile.mockResolvedValue('repos/\n');
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });

    await repairExistingWorkspaceRootWorktrees('ws-1');

    expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedCopyFile).not.toHaveBeenCalled();
  });

  it('recreates missing root worktrees with the default-branch helper', async () => {
    let worktreeCreated = false;
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: '/mock/repos/example-workspace',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature-branch',
        createdAt: '2026-03-24T00:00:00.000Z',
      },
    ]);
    mockedIsGitRepo.mockResolvedValue(false);
    mockedCreateWorktree.mockImplementation(() => {
      worktreeCreated = true;
      return Promise.resolve('wt-1');
    });
    mockedStat.mockImplementation((pathLike) => {
      const pathStr = pathLike.toString();
      if (
        pathStr === '/mock/workspaces/ws-1/worktrees/wt-1' ||
        (worktreeCreated &&
          (pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/.gitignore' ||
            pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/CLAUDE.md'))
      ) {
        return Promise.resolve(makeStats(false));
      }

      return Promise.reject(createMissingError(pathStr));
    });

    await repairExistingWorkspaceRootWorktrees('ws-1');

    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/mock/repos/example-workspace',
      '/mock/workspaces/ws-1/worktrees/wt-1',
      'feature-branch',
    );
  });

  it('preserves chat if-command fields when building a project manifest', async () => {
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');

    const result = await buildWorkspaceManifest({
      version: 1,
      type: 'multi-repo',
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review project PR',
            'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
            pluginSelections: {
              collectionIds: ['workspace-local'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        ],
      },
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/mock/repo-a',
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review repo PR',
                'if-command': 'test -n "$CANOPY_PR_URL"',
                pluginSelections: {
                  collectionIds: ['repo-local'],
                  skillRefs: [],
                  pluginRefs: [],
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.manifest).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review project PR',
            'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
          },
        ],
      },
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://github.com/acme/repo.git',
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review repo PR',
                'if-command': 'test -n "$CANOPY_PR_URL"',
              },
            ],
          },
        },
      ],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'local-hook-plugin-selections' }),
        expect.objectContaining({
          code: 'local-hook-plugin-selections',
          repoId: 'repo-a',
        }),
      ]),
    );
    expect(result.localConfig.repos[0]?.hooks).toEqual({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review repo PR',
          localPluginSelectionOverlay: true,
          localPluginSelectionOverlayKey: 'chat:Review repo PR',
          pluginSelections: {
            collectionIds: ['repo-local'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
    });
  });

  it('does not write cleared local overlay markers to the project manifest', async () => {
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');

    const result = await buildWorkspaceManifest({
      version: 1,
      type: 'multi-repo',
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review project PR',
            localPluginSelectionOverlay: true,
            localPluginSelectionOverlayKey: 'chat:Review project PR',
          },
        ],
      },
      repos: [],
    });

    expect(result.manifest.hooks).toEqual({
      'pr:create': [{ type: 'chat', prompt: 'Review project PR' }],
    });
  });

  it.each([true, false])(
    'retains pipeline bindings only locally during conversion (flag=%s)',
    async (enabled): Promise<void> => {
      mockContextEnabled = enabled;
      mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');
      try {
        const result = await buildWorkspaceManifest({
          version: 1,
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/mock/repo-a',
              hooks: {
                'pr:create': [
                  {
                    type: 'pipeline',
                    source: 'bundled',
                    id: 'review',
                    executionContext: 'personal',
                    inputs: { value: 'old' },
                  },
                ],
              },
            },
          ],
        });
        expect(result.localConfig.repos[0]?.hooks).toEqual(
          enabled
            ? {
                'pr:create': [
                  {
                    type: 'pipeline',
                    source: 'bundled',
                    id: 'review',
                    executionContext: 'personal',
                    localExecutionContextOverlay: true,
                  },
                ],
              }
            : undefined,
        );
      } finally {
        mockContextEnabled = true;
      }
    },
  );

  it.each([true, false])(
    'retains chat bindings only locally during conversion (flag=%s)',
    async (enabled): Promise<void> => {
      mockContextEnabled = enabled;
      mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');
      try {
        const result = await buildWorkspaceManifest({
          version: 1,
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/mock/repo-a',
              hooks: {
                'pr:create': [
                  {
                    type: 'chat',
                    prompt: 'Review this PR',
                    executionContext: 'personal',
                  },
                ],
              },
            },
          ],
        });
        expect(result.localConfig.repos[0]?.hooks).toEqual(
          enabled
            ? {
                'pr:create': [
                  {
                    type: 'chat',
                    prompt: 'Review this PR',
                    executionContext: 'personal',
                    localExecutionContextOverlay: true,
                  },
                ],
              }
            : undefined,
        );
        expect(result.manifest.repos[0]?.hooks).toEqual({
          'pr:create': [
            {
              type: 'chat',
              prompt: 'Review this PR',
              ...(enabled ? {} : { executionContext: 'personal' }),
            },
          ],
        });
      } finally {
        mockContextEnabled = true;
      }
    },
  );

  it('retains only local plugin overlays and disabled repo hooks after conversion', async () => {
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');

    const result = await buildWorkspaceManifest({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/mock/repo-a',
          hooks: {
            'pr:create': [
              { type: 'command', command: 'echo source controlled' },
            ],
            'pr:closed': [
              {
                type: 'chat',
                prompt: 'Retain only my selections',
                pluginSelections: {
                  collectionIds: ['local-collection'],
                  skillRefs: [],
                  pluginRefs: [],
                },
              },
            ],
            'pr:merged': null,
          },
        },
      ],
    });

    expect(result.localConfig.repos[0]?.hooks).toEqual({
      'pr:closed': [
        {
          type: 'chat',
          prompt: 'Retain only my selections',
          localPluginSelectionOverlay: true,
          localPluginSelectionOverlayKey: 'chat:Retain only my selections',
          pluginSelections: {
            collectionIds: ['local-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
      'pr:merged': null,
    });
    expect(result.manifest.repos[0]?.hooks).toEqual({
      'pr:create': [{ type: 'command', command: 'echo source controlled' }],
      'pr:closed': [{ type: 'chat', prompt: 'Retain only my selections' }],
      'pr:merged': null,
    });
  });

  it('preserves script timeout metadata when building a project manifest', async () => {
    mockedGetRemoteUrl.mockResolvedValue('https://github.com/acme/repo.git');

    const result = await buildWorkspaceManifest({
      version: 1,
      type: 'multi-repo',
      scripts: {
        setup: {
          command: 'npm install',
          timeoutSeconds: 900,
        },
        launch: null,
      },
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/mock/repo-a',
          scripts: {
            setup: {
              command: 'pnpm install',
              timeoutSeconds: null,
            },
            launch: null,
          },
        },
      ],
    });

    expect(result.manifest).toEqual({
      version: 1,
      scripts: {
        setup: {
          command: 'npm install',
          timeoutSeconds: 900,
        },
      },
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://github.com/acme/repo.git',
          scripts: {
            setup: {
              command: 'pnpm install',
              timeoutSeconds: null,
            },
            launch: null,
          },
        },
      ],
    });
  });
});

test('startup root repair waits for the workspace deletion operation before reading live targets', async () => {
  const { withArchivedWorkspaceOperationLock } =
    await import('../lib/archived-containers');
  let release: (() => void) | undefined;
  const deletion = withArchivedWorkspaceOperationLock(
    'ws-1',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  jest
    .mocked(readWorkspaceConfig)
    .mockClear()
    .mockResolvedValueOnce({ version: 1, type: 'multi-repo', repos: [] });
  const repair = repairExistingWorkspaceRootWorktrees('ws-1');
  await Promise.resolve();
  const callsWhileDeleting = jest.mocked(readWorkspaceConfig).mock.calls.length;
  release?.();
  await deletion;
  await repair;
  expect(callsWhileDeleting).toBe(0);
  expect(readWorkspaceConfig).toHaveBeenCalledTimes(1);
});
