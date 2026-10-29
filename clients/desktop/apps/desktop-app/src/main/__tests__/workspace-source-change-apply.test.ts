import { statSync } from 'node:fs';
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn(),
  rm: jest.fn(),
  writeFile: jest.fn(),
  lstat: jest.fn(),
  readlink: jest.fn(),
}));
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'new-worktree'),
}));
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  writeCanopyJson: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  bestEffortPruneWorktrees: jest.fn(),
  createWorktree: jest.fn(),
  getRepoRootFromWorktree: jest.fn(),
  pruneWorktrees: jest.fn(),
  removeWorktree: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktree-data/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees`,
  ),
}));
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn();
  const readWorkspaceWorktrees = jest.fn();
  const writeWorkspaceConfig = jest.fn();
  const writeWorkspaceWorktrees = jest.fn();
  return {
    removeWorkspaceWorktrees: jest.fn(),
    readWorkspaceConfig,
    readWorkspaceWorktrees,
    writeWorkspaceConfig,
    writeWorkspaceWorktrees,
    // The locked list append and the queued manifest update (CAN-3819),
    // recorded as the writes they make.
    updateWorkspaceWorktrees: jest.fn(
      async (
        workspaceId: string,
        updater: (rows: unknown[]) => unknown[] | Promise<unknown[]>,
      ): Promise<unknown[]> => {
        const current: unknown = await readWorkspaceWorktrees(workspaceId);
        const next = await updater(Array.isArray(current) ? current : []);
        await writeWorkspaceWorktrees(workspaceId, next);
        return next;
      },
    ),
    updateWorkspaceConfig: jest.fn(
      async (
        workspaceId: string,
        update: (config: unknown, read: unknown) => unknown,
        options?: { shouldWrite?: (result: unknown) => boolean },
      ): Promise<unknown> => {
        const config: unknown = await readWorkspaceConfig(workspaceId);
        const result = await update(config, {
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
        });
        if (options?.shouldWrite && !options.shouldWrite(result)) return result;
        await writeWorkspaceConfig(workspaceId, config);
        return result;
      },
    ),
  };
});
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));
jest.mock('../lib/workspace-source-control', () => ({
  repairWorkspaceRootWorktree: jest.fn(),
  validateWorkspaceRootWorktree: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  resolveWorkspaceWorktreeBranchName: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type {
  CanopyJsonFile,
  WorkspaceApplySourceChangesRequest,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { readCanopyJson, writeCanopyJson } from '../lib/canopy-json';
import {
  bestEffortPruneWorktrees,
  createWorktree,
  getRepoRootFromWorktree,
  pruneWorktrees,
  removeWorktree,
} from '../lib/git';
import {
  applyWorkspaceSourceChangesToWorktree,
  normalizeWorkspaceApplySourceChangesRequest,
} from '../lib/workspace-source-change-apply';
import {
  removeWorkspaceWorktrees,
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';
import {
  repairWorkspaceRootWorktree,
  validateWorkspaceRootWorktree,
} from '../lib/workspace-source-control';
import {
  resolveWorkspaceWorktreeBranchName,
  startWorkspaceRepoSetupAndDiscovery,
  startWorkspaceWorktreePostCreateSetup,
} from '../lib/workspace-worktree-runtime';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedReaddir = jest.mocked(readdir);
const mockedRm = jest.mocked(rm);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedWriteCanopyJson = jest.mocked(writeCanopyJson);
const mockedBestEffortPruneWorktrees = jest.mocked(bestEffortPruneWorktrees);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedGetRepoRootFromWorktree = jest.mocked(getRepoRootFromWorktree);
const mockedPruneWorktrees = jest.mocked(pruneWorktrees);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
const mockedWriteWorkspaceWorktrees = jest.mocked(writeWorkspaceWorktrees);
const mockedResolveWorkspaceReferenceRepoPath = jest.mocked(
  resolveWorkspaceReferenceRepoPath,
);
const mockedRepairWorkspaceRootWorktree = jest.mocked(
  repairWorkspaceRootWorktree,
);
const mockedValidateWorkspaceRootWorktree = jest.mocked(
  validateWorkspaceRootWorktree,
);
const mockedResolveWorkspaceWorktreeBranchName = jest.mocked(
  resolveWorkspaceWorktreeBranchName,
);
const mockedStartWorkspaceRepoSetupAndDiscovery = jest.mocked(
  startWorkspaceRepoSetupAndDiscovery,
);
const mockedStartWorkspaceWorktreePostCreateSetup = jest.mocked(
  startWorkspaceWorktreePostCreateSetup,
);

function createWorkspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/source/workspace',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/repo-a',
      },
    ],
    ...overrides,
  };
}

function createManifest(
  overrides: Partial<CanopyJsonFile> = {},
): CanopyJsonFile {
  return {
    version: 1,
    repos: [
      {
        id: 'repo-b',
        name: 'Repo B',
        url: 'https://example.com/repo-b.git',
      },
    ],
    ...overrides,
  };
}

function createWorktreeData(id: string, branchName = 'branch-1'): WorktreeData {
  return {
    id,
    branchName,
    createdAt: '2026-04-06T00:00:00.000Z',
  };
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedMkdir.mockResolvedValue(undefined);
  mockedReadFile.mockRejectedValue(new Error('missing'));
  mockedReaddir.mockResolvedValue([]);
  mockedRm.mockResolvedValue(undefined);
  mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });
  mockedWriteCanopyJson.mockResolvedValue({ version: 1, repos: [] });
  mockedCreateWorktree.mockResolvedValue('branch-1');
  mockedGetRepoRootFromWorktree.mockResolvedValue('/resolved/repo');
  mockedPruneWorktrees.mockResolvedValue(undefined);
  mockedRemoveWorktree.mockResolvedValue(undefined);
  mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
  mockedReadWorkspaceWorktrees.mockResolvedValue([]);
  mockedRemoveWorkspaceWorktrees.mockResolvedValue([]);
  mockedWriteWorkspaceConfig.mockResolvedValue(undefined);
  mockedWriteWorkspaceWorktrees.mockResolvedValue(undefined);
  mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
    '/resolved/reference',
  );
  mockedRepairWorkspaceRootWorktree.mockResolvedValue([]);
  mockedValidateWorkspaceRootWorktree.mockResolvedValue([]);
  mockedResolveWorkspaceWorktreeBranchName.mockResolvedValue('branch-1');
  mockedStartWorkspaceRepoSetupAndDiscovery.mockResolvedValue(undefined);
  mockedStartWorkspaceWorktreePostCreateSetup.mockResolvedValue(undefined);
});

describe('normalizeWorkspaceApplySourceChangesRequest', () => {
  it('assigns unique repo ids for source-controlled repo adds that omit them', async () => {
    mockedReaddir.mockResolvedValueOnce([]);

    const result = await normalizeWorkspaceApplySourceChangesRequest({
      workspaceId: 'workspace-1',
      config: createWorkspaceConfig(),
      manifest: createManifest(),
      request: {
        workspaceId: 'workspace-1',
        target: {
          mode: 'new',
          existingWorktreeIds: [],
        },
        repoAdds: [
          {
            repoName: 'Repo A',
            repoPath: '/repos/repo-new-a',
            remoteUrl: 'https://example.com/repo-new-a.git',
          },
          {
            repoName: 'Repo A',
            repoPath: '/repos/repo-new-b',
            remoteUrl: 'https://example.com/repo-new-b.git',
          },
        ],
      },
    });

    expect(result.repoAdds).toEqual([
      expect.objectContaining({
        repoId: 'repo-a-2',
        repoName: 'Repo A',
      }),
      expect.objectContaining({
        repoId: 'repo-a-3',
        repoName: 'Repo A',
      }),
    ]);
  });

  it('preserves explicit repo ids while normalizing mixed add requests', async () => {
    mockedReaddir.mockResolvedValueOnce([]);

    const result = await normalizeWorkspaceApplySourceChangesRequest({
      workspaceId: 'workspace-1',
      config: createWorkspaceConfig(),
      manifest: createManifest(),
      request: {
        workspaceId: 'workspace-1',
        target: {
          mode: 'new',
          existingWorktreeIds: [],
        },
        repoAdds: [
          {
            repoId: 'custom-id',
            repoName: 'Repo Custom',
            repoPath: '/repos/repo-custom',
            remoteUrl: 'https://example.com/repo-custom.git',
          },
          {
            repoName: 'Repo Extra',
            repoPath: '/repos/repo-extra',
            remoteUrl: 'https://example.com/repo-extra.git',
          },
        ],
      },
    });

    expect(result.repoAdds).toEqual([
      expect.objectContaining({
        repoId: 'custom-id',
        repoName: 'Repo Custom',
      }),
      expect.objectContaining({
        repoId: 'repo-extra',
        repoName: 'Repo Extra',
      }),
    ]);
  });
});

describe('applyWorkspaceSourceChangesToWorktree', () => {
  it.each(['lstat', 'readlink', 'readFile'])(
    'rejects instruction resolver %s failures without reporting applied settings',
    async (operation) => {
      const root = '/mock/workspaces/workspace-1/worktrees/wt-1';
      const failure = Object.assign(
        new Error(`instruction ${operation} denied`),
        { code: 'EACCES' },
      );
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        createWorktreeData('wt-1'),
      ]);
      const entry = statSync(__filename);
      if (operation === 'readlink') entry.isSymbolicLink = (): boolean => true;
      jest.mocked(lstat).mockImplementation((filePath) => {
        if (operation === 'lstat') return Promise.reject(failure);
        return Promise.resolve(
          filePath === `${root}/AGENTS.md` ? entry : statSync(__filename),
        );
      });
      jest.mocked(readlink).mockRejectedValue(failure);
      mockedReadFile.mockRejectedValue(failure);
      const onApplied = jest.fn();
      await expect(
        applyWorkspaceSourceChangesToWorktree(
          {
            workspaceId: 'workspace-1',
            target: { mode: 'existing', worktreeId: 'wt-1' },
            claudeMd: 'Updated rules',
            workspaceScripts: { setup: { command: 'echo setup' } },
          },
          () => null,
          onApplied,
        ),
      ).rejects.toThrow(failure);
      expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
      expect(onApplied).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'write'])(
    'propagates a regular instruction %s failure instead of reporting applied settings',
    async (operation) => {
      const root = '/mock/workspaces/workspace-1/worktrees/wt-1';
      const failure = new Error(`instruction ${operation} denied`);
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        createWorktreeData('wt-1'),
      ]);
      jest
        .mocked(lstat)
        .mockImplementation((filePath) =>
          filePath === `${root}/AGENTS.md`
            ? Promise.resolve(statSync(__filename))
            : Promise.reject(
                Object.assign(new Error('missing'), { code: 'ENOENT' }),
              ),
        );
      mockedReadFile.mockResolvedValue('Existing rules');
      if (operation === 'read') mockedReadFile.mockRejectedValue(failure);
      else jest.mocked(writeFile).mockRejectedValueOnce(failure);
      await expect(
        applyWorkspaceSourceChangesToWorktree(
          {
            workspaceId: 'workspace-1',
            target: { mode: 'existing', worktreeId: 'wt-1' },
            claudeMd: 'Updated rules',
            workspaceScripts: { setup: { command: 'echo setup' } },
          },
          () => null,
        ),
      ).rejects.toThrow(failure);
      expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
    },
  );

  it('propagates manifest failures when optional instructions have an unsupported layout', async () => {
    const root = '/mock/workspaces/workspace-1/worktrees/wt-1';
    const failure = new Error('manifest write denied');
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    jest
      .mocked(lstat)
      .mockImplementation((filePath) =>
        filePath === `${root}/AGENTS.md`
          ? Promise.resolve(statSync(__dirname))
          : Promise.reject(
              Object.assign(new Error('missing'), { code: 'ENOENT' }),
            ),
      );
    mockedWriteCanopyJson.mockRejectedValueOnce(failure);
    await expect(
      applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: 'workspace-1',
          target: { mode: 'existing', worktreeId: 'wt-1' },
          claudeMd: '',
          workspaceScripts: { setup: { command: 'echo setup' } },
        },
        () => null,
      ),
    ).rejects.toThrow(failure);
  });

  it.each(
    ['AGENTS.md', 'CLAUDE.md'].flatMap((fileName) =>
      ['directory', 'symlink'].map((entryKind) => ({ fileName, entryKind })),
    ),
  )(
    'applies scripts without changing an unsupported $fileName $entryKind',
    async ({ fileName, entryKind }) => {
      const root = '/mock/workspaces/workspace-1/worktrees/wt-1';
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        createWorktreeData('wt-1'),
      ]);
      const entryStats = statSync(__dirname);
      if (entryKind === 'symlink')
        entryStats.isSymbolicLink = (): boolean => true;
      jest
        .mocked(lstat)
        .mockImplementation((filePath) =>
          filePath === `${root}/${fileName}`
            ? Promise.resolve(entryStats)
            : Promise.reject(
                Object.assign(new Error('missing'), { code: 'ENOENT' }),
              ),
        );
      jest.mocked(readlink).mockResolvedValue(`docs/${fileName}`);
      await applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: 'workspace-1',
          target: { mode: 'existing', worktreeId: 'wt-1' },
          claudeMd: '',
          workspaceScripts: { setup: { command: 'echo setup' } },
        },
        () => null,
      );
      expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
        root,
        expect.objectContaining({ scripts: { setup: 'echo setup' } }),
      );
      expect(
        jest
          .mocked(writeFile)
          .mock.calls.filter(
            ([filePath]) =>
              typeof filePath === 'string' &&
              /(?:AGENTS|CLAUDE)\.md$/.test(filePath),
          ),
      ).toEqual([]);
    },
  );

  it('applies instruction edits to the worktree AGENTS.md without creating CLAUDE.md', async () => {
    const root = '/mock/workspaces/workspace-1/worktrees/wt-1';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    jest.mocked(lstat).mockImplementation((filePath) => {
      if (filePath === `${root}/AGENTS.md`)
        return Promise.resolve(statSync(__filename));
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockedReadFile.mockImplementation((filePath) => {
      if (filePath === `${root}/AGENTS.md`)
        return Promise.resolve('Existing rules');
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: { mode: 'existing', worktreeId: 'wt-1' },
        claudeMd: 'Existing rules\nUpdated',
      },
      () => null,
    );
    expect(writeFile).toHaveBeenCalledWith(
      `${root}/AGENTS.md`,
      'Existing rules\nUpdated',
      'utf8',
    );
    expect(writeFile).not.toHaveBeenCalledWith(
      `${root}/CLAUDE.md`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('matches equivalent remotes when finding an existing local binding', async () => {
    const config = createWorkspaceConfig({
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          source: 'manifest',
          manifestUrl: 'git@github.com:Org/Repo.git',
        },
      ],
    });
    mockedReadWorkspaceConfig.mockResolvedValue(config);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        repoAdds: [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            remoteUrl: 'https://github.com/org/repo',
          },
        ],
      },
      () => null,
    );

    await flushBackgroundWork();
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/mock/workspaces/workspace-1/worktrees/wt-1/repos/repo-a',
      'branch-1',
    );
    expect(mockedWriteCanopyJson.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCreateWorktree.mock.invocationCallOrder[0],
    );
    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      {
        version: 1,
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            url: 'https://github.com/org/repo',
          },
        ],
      },
    );
  });

  it('does not duplicate equivalent manifest remotes when URL forms differ', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-existing',
          name: 'Repo Existing',
          url: 'git@github.com:Org/Repo.git',
        },
      ],
    });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        repoAdds: [
          {
            repoId: 'repo-new',
            repoName: 'Repo New',
            repoPath: '/repos/repo-new',
            remoteUrl: 'https://github.com/org/repo',
          },
        ],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      {
        version: 1,
        repos: [
          {
            id: 'repo-existing',
            name: 'Repo Existing',
            url: 'git@github.com:Org/Repo.git',
          },
        ],
      },
    );
  });

  it('writes source-controlled project plugin recommendations without disturbing unrelated fields', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [],
      x_existing: 'kept',
      plugins: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'old',
        },
      ],
    });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        workspacePlugins: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'org/skills' },
            skill_name: 'reviewer',
          },
          {
            type: 'skill',
            source: { type: 'github', repo: 'ORG/SKILLS' },
            skill_name: 'reviewer',
          },
        ],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      {
        version: 1,
        repos: [],
        x_existing: 'kept',
        plugins: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'org/skills' },
            skill_name: 'reviewer',
          },
        ],
      },
    );
  });

  it('preserves timeout metadata when applying project and repo scripts', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
        },
      ],
    });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        workspaceScripts: {
          setup: {
            command: 'npm install',
            timeoutSeconds: 900,
          },
          launch: null,
        },
        repoScriptChanges: [
          {
            repoId: 'repo-a',
            scripts: {
              setup: {
                command: 'pnpm install',
                timeoutSeconds: null,
              },
              launch: null,
            },
          },
        ],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      {
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
            url: 'https://example.com/repo-a.git',
            scripts: {
              setup: {
                command: 'pnpm install',
                timeoutSeconds: null,
              },
              launch: null,
            },
          },
        ],
      },
    );
  });

  it('applies the workspace source start page', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({ version: 1, repos: [] });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: { mode: 'existing', worktreeId: 'wt-1' },
        startPage: { kind: 'url', url: 'https://example.com/start' },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      expect.objectContaining({
        startPage: { kind: 'url', url: 'https://example.com/start' },
      }),
    );
  });

  it('removes project plugin recommendations when the source draft is empty', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [],
      plugins: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'old',
        },
      ],
    });

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        workspacePlugins: [],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/wt-1',
      {
        version: 1,
        repos: [],
      },
    );
  });

  it('creates a new project root worktree from the reference repo default branch helper', async () => {
    const result = await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'new',
          existingWorktreeIds: [],
        },
      },
      () => null,
    );

    expect(mockedCreateWorktree).toHaveBeenNthCalledWith(
      1,
      '/resolved/reference',
      '/mock/workspaces/workspace-1/worktrees/new-worktree',
      'new-worktree',
    );
    const firstWriteWorktreesCall = mockedWriteWorkspaceWorktrees.mock.calls[0];
    expect(firstWriteWorktreesCall).toBeDefined();
    if (!firstWriteWorktreesCall) {
      throw new Error('Expected writeWorkspaceWorktrees to be called');
    }
    const [writtenWorkspaceId, writtenWorktrees] = firstWriteWorktreesCall;
    expect(writtenWorkspaceId).toBe('workspace-1');
    expect(writtenWorktrees).toHaveLength(1);
    expect(writtenWorktrees[0]).toMatchObject({
      id: 'new-worktree',
      branchName: 'branch-1',
    });
    expect(typeof writtenWorktrees[0]?.createdAt).toBe('string');
    expect(result).toEqual({
      worktreeId: 'new-worktree',
      branchName: 'branch-1',
      createdWorktree: true,
      referenceRepoPath: '/resolved/reference',
      localRepoBindingsUpdated: false,
    });
  });

  it('returns after writing the manifest when background child worktree creation fails', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockedCreateWorktree
      .mockResolvedValueOnce('branch-1')
      .mockRejectedValueOnce(new Error('child failed'));

    const result = await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: {
          mode: 'new',
          existingWorktreeIds: [],
        },
      },
      () => null,
    );

    expect(result).toMatchObject({
      worktreeId: 'new-worktree',
      branchName: 'branch-1',
      createdWorktree: true,
    });
    await flushBackgroundWork();
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to finish project source apply background repo work:',
      expect.any(Error),
    );
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('holds storage ownership until background repo work finishes', async () => {
    let releaseChild!: () => void;
    const events: string[] = [];
    mockedCreateWorktree
      .mockResolvedValueOnce('branch-1')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseChild = (): void => {
              events.push('child worktree');
              resolve('branch-1');
            };
          }),
      );

    await applyWorkspaceSourceChangesToWorktree(
      {
        workspaceId: 'workspace-1',
        target: { mode: 'new', existingWorktreeIds: [] },
      },
      () => null,
    );
    await flushBackgroundWork();
    const change = withStorageOwnershipChange(
      ['workspace_manifest', 'worktree_list'],
      () => {
        events.push('change');
      },
    );
    await flushBackgroundWork();

    expect(events).toEqual([]);
    releaseChild();
    await change;
    expect(events).toEqual(['child worktree', 'change']);
  });

  it('does not create repo worktrees before the manifest write succeeds', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
        },
      ],
    });
    mockedWriteCanopyJson.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: 'workspace-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          repoAdds: [
            {
              repoId: 'repo-b',
              repoName: 'Repo B',
              repoPath: '/repos/repo-b',
              remoteUrl: 'https://example.com/repo-b.git',
            },
          ],
        },
        () => null,
      ),
    ).rejects.toThrow('write failed');

    expect(mockedRemoveWorktree).toHaveBeenCalledWith(
      '/resolved/reference',
      '/mock/workspaces/workspace-1/worktrees/new-worktree',
    );
    expect(mockedRemoveWorktree).not.toHaveBeenCalledWith(
      '/repos/repo-b',
      '/mock/workspaces/workspace-1/worktrees/new-worktree/repos/repo-b',
    );
  });

  it('does not prune repo worktree metadata before the manifest write succeeds', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
        },
      ],
    });
    mockedWriteCanopyJson.mockRejectedValueOnce(new Error('write failed'));
    mockedRemoveWorktree.mockImplementation(
      (repoPath: string): Promise<void> =>
        repoPath === '/repos/repo-b'
          ? Promise.reject(new Error('remove failed'))
          : Promise.resolve(),
    );

    await expect(
      applyWorkspaceSourceChangesToWorktree(
        {
          workspaceId: 'workspace-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          repoAdds: [
            {
              repoId: 'repo-b',
              repoName: 'Repo B',
              repoPath: '/repos/repo-b',
              remoteUrl: 'https://example.com/repo-b.git',
            },
          ],
        },
        () => null,
      ),
    ).rejects.toThrow('write failed');

    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/workspaces/workspace-1/worktrees/new-worktree/repos/repo-b',
      { recursive: true, force: true },
    );
    expect(mockedBestEffortPruneWorktrees).not.toHaveBeenCalledWith(
      '/repos/repo-b',
      'workspace-source-change-apply cleanupWorktreeDirectory',
    );
  });

  function observeDetachedWork(): {
    readonly settled: boolean;
    done: Promise<void>;
  } {
    const state = { settled: false, done: Promise.resolve() };
    state.done = settleDetachedWork().then(() => {
      state.settled = true;
    });
    return state;
  }

  function mockTwoManifestRepos(): void {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({
        repos: ['repo-a', 'repo-b'].map((id) => ({
          id,
          name: id,
          repoPath: `/repos/${id}`,
          manifestUrl: `https://example.com/${id}.git`,
        })),
      }),
    );
  }

  async function expectRepoWorktreesSettleTogether(
    request: WorkspaceApplySourceChangesRequest,
  ): Promise<void> {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockTwoManifestRepos();
    const failure = new Error('repo-a worktree failed');
    let releaseRepoB: () => void = () => {};
    let repoBDone = false;
    mockedCreateWorktree.mockImplementation(async (_repoPath, worktreePath) => {
      if (worktreePath.endsWith('/repos/repo-a')) throw failure;
      if (!worktreePath.endsWith('/repos/repo-b')) return 'branch-1';
      await new Promise<void>((resolve) => {
        releaseRepoB = resolve;
      });
      repoBDone = true;
      return 'branch-1';
    });

    await applyWorkspaceSourceChangesToWorktree(request, () => null);
    const background = observeDetachedWork();
    await flushBackgroundWork();

    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-b',
      expect.stringMatching(/\/repos\/repo-b$/),
      'branch-1',
    );
    expect(background.settled).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
    releaseRepoB();
    await background.done;
    expect(repoBDone).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to finish project source apply background repo work:',
      failure,
    );
    consoleError.mockRestore();
  }

  /** Holds every call of a setup starter open and checks detached work tracks it. */
  async function expectSetupStarterTrackedUntilSettled(
    request: WorkspaceApplySourceChangesRequest,
    starter:
      | typeof mockedStartWorkspaceRepoSetupAndDiscovery
      | typeof mockedStartWorkspaceWorktreePostCreateSetup,
    expectedStarts: number,
  ): Promise<void> {
    mockTwoManifestRepos();
    let releaseSetup: () => void = () => {};
    const heldSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupDone = false;
    starter.mockImplementation(async () => {
      await heldSetup;
      setupDone = true;
    });

    const result = await applyWorkspaceSourceChangesToWorktree(
      request,
      () => null,
    );
    expect(result.worktreeId).toBeDefined();
    const background = observeDetachedWork();
    for (let turn = 0; turn < 5; turn += 1) {
      await flushBackgroundWork();
    }

    expect(starter).toHaveBeenCalledTimes(expectedStarts);
    expect(setupDone).toBe(false);
    expect(background.settled).toBe(false);
    releaseSetup();
    await background.done;
    expect(setupDone).toBe(true);
  }

  it('tracks per-repo setup for repos added to an existing worktree until it settles', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    await expectSetupStarterTrackedUntilSettled(
      {
        workspaceId: 'workspace-1',
        target: { mode: 'existing', worktreeId: 'wt-1' },
        repoAdds: ['repo-a', 'repo-b'].map((repoId) => ({
          repoId,
          repoName: repoId,
          remoteUrl: `https://example.com/${repoId}.git`,
        })),
      },
      mockedStartWorkspaceRepoSetupAndDiscovery,
      2,
    );
    expect(mockedStartWorkspaceWorktreePostCreateSetup).not.toHaveBeenCalled();
  });

  it('tracks post-create setup for a newly created worktree until it settles', async () => {
    await expectSetupStarterTrackedUntilSettled(
      {
        workspaceId: 'workspace-1',
        target: { mode: 'new', existingWorktreeIds: [] },
      },
      mockedStartWorkspaceWorktreePostCreateSetup,
      1,
    );
    expect(mockedStartWorkspaceRepoSetupAndDiscovery).not.toHaveBeenCalled();
  });

  it('waits for every prepared repo worktree before failing existing-worktree repo adds', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    await expectRepoWorktreesSettleTogether({
      workspaceId: 'workspace-1',
      target: { mode: 'existing', worktreeId: 'wt-1' },
      repoAdds: ['repo-a', 'repo-b'].map((repoId) => ({
        repoId,
        repoName: repoId,
        remoteUrl: `https://example.com/${repoId}.git`,
      })),
    });
  });

  it('waits for every repo worktree before failing new-worktree population', async () => {
    await expectRepoWorktreesSettleTogether({
      workspaceId: 'workspace-1',
      target: { mode: 'new', existingWorktreeIds: [] },
    });
  });
});
