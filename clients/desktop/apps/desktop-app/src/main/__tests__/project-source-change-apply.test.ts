jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  rm: jest.fn(),
}));
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'new-worktree'),
}));
jest.mock('../lib/canopy-json', () => ({
  getCanopyJsonPath: jest.fn((repoPath: string) => `${repoPath}/canopy.json`),
  readCanopyJson: jest.fn(),
  writeCanopyJson: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  bestEffortPruneWorktrees: jest.fn(),
  createWorktree: jest.fn(),
  pruneWorktrees: jest.fn(),
  removeWorktree: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(),
}));
jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
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

import { mkdir, rm } from 'node:fs/promises';
import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  getCanopyJsonPath,
  readCanopyJson,
  writeCanopyJson,
} from '../lib/canopy-json';
import {
  bestEffortPruneWorktrees,
  createWorktree,
  pruneWorktrees,
  removeWorktree,
} from '../lib/git';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { applyProjectSourceChangesToWorktree } from '../lib/project-source-change-apply';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import {
  removeWorkspaceWorktrees,
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  writeWorkspaceWorktrees,
} from '../lib/workspace-persistence';

const mockedMkdir = jest.mocked(mkdir);
const mockedRm = jest.mocked(rm);
const mockedGetCanopyJsonPath = jest.mocked(getCanopyJsonPath);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedWriteCanopyJson = jest.mocked(writeCanopyJson);
const mockedBestEffortPruneWorktrees = jest.mocked(bestEffortPruneWorktrees);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedPruneWorktrees = jest.mocked(pruneWorktrees);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedStartProjectWorktreePostCreateSetup = jest.mocked(
  startProjectWorktreePostCreateSetup,
);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedWriteWorkspaceWorktrees = jest.mocked(writeWorkspaceWorktrees);

function createSingleRepoConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/repos/tracked-worktree',
    repos: [],
    scripts: {
      launch: 'npm run dev',
    },
    alwaysShow: true,
    ...overrides,
  };
}

function createWorktreeData(id: string, branchName = 'branch-1'): WorktreeData {
  return {
    id,
    branchName,
    createdAt: '2026-04-07T00:00:00.000Z',
  };
}

function createManifest(
  overrides: Partial<CanopyJsonFile> = {},
): CanopyJsonFile {
  return {
    version: 1,
    ...overrides,
  };
}

describe('applyProjectSourceChangesToWorktree', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedGetCanopyJsonPath.mockImplementation(
      (repoPath: string): string => `${repoPath}/canopy.json`,
    );
    mockedReadCanopyJson.mockResolvedValue(createManifest());
    mockedWriteCanopyJson.mockResolvedValue(createManifest());
    mockedCreateWorktree.mockResolvedValue('branch-1');
    mockedPruneWorktrees.mockResolvedValue(undefined);
    mockedRemoveWorktree.mockResolvedValue(undefined);
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/repos/source');
    mockedStartProjectWorktreePostCreateSetup.mockImplementation(() =>
      Promise.resolve(),
    );
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('wt-1'),
    ]);
    mockedRemoveWorkspaceWorktrees.mockResolvedValue([]);
    mockedWriteWorkspaceWorktrees.mockResolvedValue(undefined);
  });

  it('writes canopy.json into an existing worktree', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({
        buildCommand: 'npm run build',
      }),
    );

    const result = await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {
          setup: 'npm install',
          launch: null,
        },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        buildCommand: 'npm run build',
        scripts: {
          setup: 'npm install',
        },
      },
    );
    expect(result).toEqual({
      worktreeId: 'wt-1',
      branchName: 'branch-1',
      createdWorktree: false,
      referenceRepoPath: '/repos/source',
    });
  });

  it('removes manifest scripts when the requested script map is empty', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({
        scripts: {
          setup: 'npm install',
        },
        buildCommand: 'npm run build',
      }),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {
          setup: null,
        },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        buildCommand: 'npm run build',
      },
    );
  });

  it('sets and clears the source-controlled start page', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({ startPage: { kind: 'file', path: 'OLD.md' } }),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: { mode: 'existing', worktreeId: 'wt-1' },
        startPage: { kind: 'file', path: 'README.md' },
      },
      () => null,
    );
    expect(mockedWriteCanopyJson).toHaveBeenLastCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      expect.objectContaining({
        startPage: { kind: 'file', path: 'README.md' },
      }),
    );

    mockedWriteCanopyJson.mockClear();
    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: { mode: 'existing', worktreeId: 'wt-1' },
        startPage: null,
      },
      () => null,
    );
    expect(mockedWriteCanopyJson.mock.calls[0]?.[1]).not.toHaveProperty(
      'startPage',
    );
  });

  it('preserves manifest scripts when scripts are omitted', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({
        scripts: {
          setup: 'npm install',
        },
        hooks: {
          'pr:create': [{ type: 'command', command: 'npm test' }],
        },
      }),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        hooks: {
          'pr:create': [{ type: 'command', command: 'npm run lint' }],
        },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        scripts: {
          setup: 'npm install',
        },
        hooks: {
          'pr:create': [{ type: 'command', command: 'npm run lint' }],
        },
      },
    );
  });

  it('preserves timeout metadata when writing manifest scripts', async () => {
    mockedReadCanopyJson.mockResolvedValue(createManifest());

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {
          setup: {
            command: 'npm install',
            timeoutSeconds: 900,
          },
          launch: null,
        },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        scripts: {
          setup: {
            command: 'npm install',
            timeoutSeconds: 900,
          },
        },
      },
    );
  });

  it('writes project plugin recommendations while preserving unrelated manifest fields', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({
        buildCommand: 'npm run build',
      }),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {
          setup: 'npm install',
        },
        plugins: [
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'org/marketplace' },
            plugin_name: 'browser',
          },
        ],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        buildCommand: 'npm run build',
        scripts: {
          setup: 'npm install',
        },
        plugins: [
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'org/marketplace' },
            plugin_name: 'browser',
          },
        ],
      },
    );
  });

  it('removes project plugin recommendations when the source draft is empty', async () => {
    mockedReadCanopyJson.mockResolvedValue(
      createManifest({
        plugins: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'canopy' },
            skill_name: 'old',
          },
        ],
      }),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {},
        plugins: [],
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
      },
    );
  });

  it('creates a new worktree from the canonical reference repo path and appends it to worktrees.json', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      createWorktreeData('existing'),
    ]);
    mockedReadCanopyJson.mockResolvedValue(null);

    const result = await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'new',
          existingWorktreeIds: ['existing'],
        },
        scripts: {
          setup: 'npm install',
        },
      },
      () => null,
    );

    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/mock/workspaces/project-1/worktrees/new-worktree',
      'new-worktree',
    );
    expect(mockedWriteWorkspaceWorktrees).toHaveBeenCalledWith('project-1', [
      createWorktreeData('existing'),
      expect.objectContaining({
        id: 'new-worktree',
        branchName: 'branch-1',
      }),
    ]);
    expect(mockedStartProjectWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'new-worktree',
        project: {
          repoPath: '/repos/tracked-worktree',
          scripts: {
            launch: 'npm run dev',
          },
        },
      }),
    );
    expect(result).toEqual({
      worktreeId: 'new-worktree',
      branchName: 'branch-1',
      createdWorktree: true,
      referenceRepoPath: '/repos/source',
    });
  });

  it('overwrites an invalid target canopy.json with a fresh manifest', async () => {
    mockedReadCanopyJson.mockRejectedValue(
      new Error(
        '/mock/workspaces/project-1/worktrees/wt-1/canopy.json: invalid canopy.json',
      ),
    );

    await applyProjectSourceChangesToWorktree(
      {
        projectId: 'project-1',
        target: {
          mode: 'existing',
          worktreeId: 'wt-1',
        },
        scripts: {
          setup: 'npm install',
        },
      },
      () => null,
    );

    expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/wt-1',
      {
        version: 1,
        scripts: {
          setup: 'npm install',
        },
      },
    );
  });

  it('rethrows non-parse target canopy.json read failures', async () => {
    mockedReadCanopyJson.mockRejectedValue(
      new Error('EACCES: permission denied, open canopy.json'),
    );

    await expect(
      applyProjectSourceChangesToWorktree(
        {
          projectId: 'project-1',
          target: {
            mode: 'existing',
            worktreeId: 'wt-1',
          },
          scripts: {
            setup: 'npm install',
          },
        },
        () => null,
      ),
    ).rejects.toThrow('EACCES: permission denied, open canopy.json');

    expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
  });

  it('rejects a relative configured repo path before resolving the reference repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createSingleRepoConfig({
        repoPath: 'relative/repo',
      }),
    );

    await expect(
      applyProjectSourceChangesToWorktree(
        {
          projectId: 'project-1',
          target: {
            mode: 'existing',
            worktreeId: 'wt-1',
          },
          scripts: {
            setup: 'npm install',
          },
        },
        () => null,
      ),
    ).rejects.toThrow('Invalid repoPath: must be an absolute path');

    expect(mockedResolveProjectReferenceRepoPath).not.toHaveBeenCalled();
    expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
  });

  it('rolls back a newly created worktree when applying changes fails', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    mockedReadCanopyJson.mockResolvedValue(null);
    mockedWriteCanopyJson.mockRejectedValue(new Error('write failed'));

    await expect(
      applyProjectSourceChangesToWorktree(
        {
          projectId: 'project-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          scripts: {
            setup: 'npm install',
          },
        },
        () => null,
      ),
    ).rejects.toThrow('write failed');

    expect(mockedRemoveWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/mock/workspaces/project-1/worktrees/new-worktree',
    );
    // W6f3: the rollback removal reaches the writer through the record port.
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
      undefined,
      undefined,
      {},
    );
    const removes = mockedRemoveWorkspaceWorktrees.mock.calls[0]?.[1];
    expect(
      removes?.({ id: 'new-worktree', branchName: 'other', createdAt: 'x' }),
    ).toBe(true);
    expect(
      removes?.({ id: 'other', branchName: 'new-worktree', createdAt: 'x' }),
    ).toBe(false);
  });

  it('prunes stale worktree metadata when rollback falls back to rm', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    mockedReadCanopyJson.mockResolvedValue(null);
    mockedWriteCanopyJson.mockRejectedValue(new Error('write failed'));
    mockedRemoveWorktree.mockRejectedValue(new Error('remove failed'));

    await expect(
      applyProjectSourceChangesToWorktree(
        {
          projectId: 'project-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          scripts: {
            setup: 'npm install',
          },
        },
        () => null,
      ),
    ).rejects.toThrow('write failed');

    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/project-1/worktrees/new-worktree',
      { recursive: true, force: true },
    );
    expect(mockedBestEffortPruneWorktrees).toHaveBeenCalledWith(
      '/repos/source',
      'project-source-change-apply rollbackCreatedProjectWorktree',
    );
  });
});
