// CAN-3819: core.workspace.sourceChanges.apply. Runs the real sidebar,
// persistence and source-change modules against a temporary data dir; Git,
// the root worktree validation and the post-create setup are mocked.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../git', () => ({
  bestEffortPruneWorktrees: jest.fn(),
  createWorktree: jest.fn(),
  getRepoRootFromWorktree: jest.fn((repoPath: string) =>
    Promise.resolve(repoPath),
  ),
  removeWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../workspace-source-control', () => ({
  repairWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
  validateWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../workspace-worktree-runtime', () => ({
  resolveWorkspaceWorktreeBranchName: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { createWorktree } from '../git';
import * as projectSourceChangeApply from '../project-source-change-apply';
import * as workspaceSourceChangeApply from '../workspace-source-change-apply';
import {
  getWorkspaceConfigPath,
  getWorkspaceWorktreeRootRepoDir,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  applySourceChanges,
  WorkspaceSourceChangesRefusedError,
  type WorkspaceSourceChangesRefusal,
} from '../workspace-source-changes';

type JsonRecord = Record<string, unknown>;

const CONCURRENT_ROW: WorktreeData = {
  id: 'concurrent-row',
  branchName: 'concurrent-row',
  createdAt: '2026-10-01T00:00:00.000Z',
};
const EXISTING_ROW: WorktreeData = {
  id: 'otter',
  branchName: 'otter',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object in ${filePath}`);
  return parsed;
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspaceSourceChangesRefusal,
  message: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceSourceChangesRefusedError);
  expect(error).toMatchObject({ reason, message });
}

/** Waits for every manifest write queued so far. */
async function settleManifestQueue(workspaceId: string): Promise<void> {
  await updateWorkspaceConfig(workspaceId, () => false, {
    shouldWrite: (changed) => changed,
  });
}

describe('source change application (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-source-apply-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    // The checkout appears where Git would put it; a row created by another
    // writer lands while it is made.
    jest.clearAllMocks();
    jest
      .mocked(createWorktree)
      .mockImplementation(async (_repoPath, worktreePath, branchName) => {
        await mkdir(worktreePath, { recursive: true });
        const workspaceId = path.basename(
          path.dirname(path.dirname(worktreePath)),
        );
        await updateWorkspaceWorktrees(workspaceId, (rows) => [
          ...rows.map((row) =>
            row.id === EXISTING_ROW.id
              ? { ...row, status: 'done' as const }
              : row,
          ),
          CONCURRENT_ROW,
        ]);
        return branchName;
      });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    'keeps the rows written while a project target worktree was checked out; callback=%s',
    async (withCallback) => {
      const getWindow = jest.fn(() => null);
      const onApplied = withCallback ? jest.fn() : undefined;
      const applyProject = jest.spyOn(
        projectSourceChangeApply,
        'applyProjectSourceChangesToWorktree',
      );
      const project: SingleRepoSidebarItem = {
        id: 'single',
        name: 'Single',
        type: 'single-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 0,
        repoPath: path.join(dataDir, 'src', 'single'),
        worktrees: [{ ...EXISTING_ROW }],
      };
      await writeAllSidebarItems([project]);

      const response = await applySourceChanges({
        kind: 'project',
        source: 'project_settings',
        request: {
          projectId: 'single',
          target: { mode: 'new', existingWorktreeIds: [] },
          scripts: { dev: 'npm run dev' },
        },
        getWindow,
        onApplied,
      });

      expect(response.createdWorktree).toBe(true);
      expect(applyProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'single' }),
        getWindow,
        onApplied,
      );
      if (onApplied) expect(onApplied).toHaveBeenCalledTimes(1);
      const rows = await readWorkspaceWorktrees('single');
      expect(rows.map((row) => row.id)).toEqual([
        EXISTING_ROW.id,
        CONCURRENT_ROW.id,
        response.worktreeId,
      ]);
      // Another row's observed state is not rolled back to the earlier read.
      expect(rows[0]).toMatchObject({ status: 'done' });
    },
  );

  it.each([false, true])(
    'keeps the rows written while a workspace target worktree was checked out; callback=%s',
    async (withCallback) => {
      const getWindow = jest.fn(() => null);
      const onApplied = withCallback ? jest.fn() : undefined;
      const applyWorkspace = jest.spyOn(
        workspaceSourceChangeApply,
        'applyWorkspaceSourceChangesToWorktree',
      );
      const workspace: MultiRepoSidebarItem = {
        id: 'multi',
        name: 'Multi',
        type: 'multi-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 0,
        sourceRepoPath: path.join(dataDir, 'src', 'multi'),
        repos: [],
        worktrees: [{ ...EXISTING_ROW }],
      };
      await writeAllSidebarItems([workspace]);

      const response = await applySourceChanges({
        kind: 'workspace',
        source: 'workspace_settings',
        request: {
          workspaceId: 'multi',
          target: { mode: 'new', existingWorktreeIds: [] },
          workspaceScripts: { dev: 'npm run dev' },
        },
        getWindow,
        onApplied,
      });

      expect(response.createdWorktree).toBe(true);
      expect(applyWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'multi' }),
        getWindow,
        onApplied,
      );
      if (onApplied) expect(onApplied).toHaveBeenCalledTimes(1);
      const rows = await readWorkspaceWorktrees('multi');
      expect(rows.map((row) => row.id)).toEqual([
        EXISTING_ROW.id,
        CONCURRENT_ROW.id,
        response.worktreeId,
      ]);
      expect(rows[0]).toMatchObject({ status: 'done' });
    },
  );

  it('binds repositories on the manifest read in its write queue', async () => {
    const workspace: MultiRepoSidebarItem = {
      id: 'multi',
      name: 'Multi',
      type: 'multi-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 0,
      sourceRepoPath: path.join(dataDir, 'src', 'multi'),
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      worktrees: [{ ...CONCURRENT_ROW }],
    };
    await writeAllSidebarItems([workspace]);
    const root = getWorkspaceWorktreeRootRepoDir('multi', CONCURRENT_ROW.id);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'canopy.json'),
      JSON.stringify({
        version: 1,
        repos: [
          { id: 'repo-a', name: 'Repo A', url: 'https://example.com/a.git' },
        ],
      }),
    );

    const response = await applySourceChanges({
      kind: 'workspace',
      source: 'workspace_settings',
      request: {
        workspaceId: 'multi',
        target: { mode: 'existing', worktreeId: CONCURRENT_ROW.id },
        workspaceScripts: { dev: 'npm run dev' },
      },
      getWindow: () => null,
      onApplied: () => {
        // Another settings write lands after the apply read the manifest.
        void updateWorkspaceConfig('multi', (config): void => {
          config.repos.push({
            id: 'repo-b',
            name: 'Repo B',
            repoPath: '/repos/b',
          });
          config.archiveRetentionDays = 7;
        });
      },
    });
    await settleManifestQueue('multi');

    expect(response.localRepoBindingsUpdated).toBe(true);
    const manifest = await readJson(getWorkspaceConfigPath('multi'));
    expect(manifest.archiveRetentionDays).toBe(7);
    expect(manifest.repos).toEqual([
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/a',
        source: 'manifest',
        manifestUrl: 'https://example.com/a.git',
      },
      { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
    ]);
  });

  it('refuses with the existing messages', async () => {
    await writeAllSidebarItems([
      {
        id: 'multi',
        name: 'Multi',
        type: 'multi-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 0,
        repos: [],
        worktrees: [],
      },
      {
        id: 'single',
        name: 'Single',
        type: 'single-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 1,
        repoPath: path.join(dataDir, 'src', 'single'),
        worktrees: [],
      },
    ]);
    const listText = await readFile(
      getWorkspaceWorktreesFilePath('single'),
      'utf8',
    );

    await expectRefusal(
      applySourceChanges({
        kind: 'workspace',
        source: 'workspace_settings',
        request: {
          workspaceId: 'multi',
          target: { mode: 'new', existingWorktreeIds: [] },
        },
        getWindow: () => null,
      }),
      'no-source-repository',
      'Project does not have a source repository',
    );
    await expectRefusal(
      applySourceChanges({
        kind: 'project',
        source: 'project_settings',
        request: {
          projectId: 'multi',
          target: { mode: 'new', existingWorktreeIds: [] },
        },
        getWindow: () => null,
      }),
      'not-single-repo',
      'Project multi is not a single-repo project',
    );
    await expectRefusal(
      applySourceChanges({
        kind: 'project',
        source: 'project_settings',
        request: {
          projectId: 'single',
          target: { mode: 'existing', worktreeId: 'missing' },
        },
        getWindow: () => null,
      }),
      'not-found',
      'Project worktree missing was not found',
    );
    expect(jest.mocked(createWorktree)).not.toHaveBeenCalled();
    expect(
      await readFile(getWorkspaceWorktreesFilePath('single'), 'utf8'),
    ).toBe(listText);
  });
});
