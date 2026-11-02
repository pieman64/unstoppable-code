jest.mock('../lib/org-shared-multi-repo-legacy-guard', () => ({
  assertLegacyCombineAllowed: jest.fn((): Promise<void> => Promise.resolve()),
}));
import type * as CompositionRecords from '../lib/workspace-composition-records';
import type * as ScriptRunner from '../lib/script-runner';
import {
  undoCompositionRepositories,
  promoteCompositionWorkspace,
} from '../lib/workspace-composition-records';
import { removeWorkspaceIndexEntry } from '../lib/sidebar-items';
jest.mock('../lib/workspace-composition-records', () => {
  const actual = jest.requireActual<typeof CompositionRecords>(
    '../lib/workspace-composition-records',
  );
  return {
    ...actual,
    restoreCompositionWorktrees: jest.fn(() => Promise.resolve()),
    undoCompositionSource: jest.fn(() => Promise.resolve()),
    undoCompositionRepositories: jest.fn(() => Promise.resolve()),
    promoteCompositionWorkspace: jest.fn(() => Promise.resolve()),
  };
});
import {
  mkdtemp,
  mkdir,
  lstat,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  MultiRepoSidebarItem,
  WorktreeData,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';

jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/mock/executions',
    tempRootDir: '/mock/temp',
    bundledActionsDir: '/mock/actions',
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  })),
}));
jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(() => Promise.resolve([])),
    loadExecutionState: jest.fn(),
    saveExecutionState: jest.fn(),
  }),
);
jest.mock('../lib/git', () => ({
  createWorktree: jest.fn(() => Promise.resolve('mock-branch')),
  createWorktreeAvoidingCheckedOutBranch: jest.fn(),
  getCurrentBranch: jest.fn(),
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
  getRepoRootFromWorktree: jest.fn(),
  getWorktreeTopLevel: jest.fn(),
  moveWorktree: jest.fn(),
  removeWorktree: jest.fn(),
}));
jest.mock('../lib/fs-utils', () => ({
  pathExists: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/instruction-files', () => ({
  ensureAgentsMdSymlink: jest.fn(),
}));
jest.mock('../lib/archived-containers', () => ({
  listArchivedContainerManifests: jest.fn(() => Promise.resolve([])),
  countArchivedContainers: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceConfigPath: (id: string): string =>
    `/mock/workspaces/${id}/workspace.json`,
  getWorkspaceWorktreesFilePath: (id: string): string =>
    `/mock/workspaces/${id}/worktrees.json`,
  getWorkspaceIndexFilePath: (): string => '/mock/workspaces/index.json',
  getWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees`,
  ),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  writeAllSidebarItems: jest.fn(),
  removeWorkspaceIndexEntry: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/safe-remove-worktree', () => ({
  safeRemoveWorktree: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  removeWorkspaceWorktrees: jest.fn(),
  updateWorkspaceWorktrees: jest.fn(),
  writeWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-service', () => ({
  createTemporaryMultiRepoWorkspace: jest.fn(),
  listWorkspaceItems: jest.fn(),
}));
jest.mock('../lib/workspace-repo-mutators', () => ({
  addRepoCheckoutToWorktree: jest.fn(),
}));
jest.mock('../lib/workspace-repositories', () => ({
  addWorkspaceRepository: jest.fn(),
}));
jest.mock('../lib/workspace-source-control', () => ({
  initializeWorkspaceSourceRepo: jest.fn(),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));
jest.mock('../ledger/lifecycle', () => ({
  discardLedgerMoveIntent: jest.fn(),
  LEDGER_INTENT_REFUSING_WAIT_MS: 5_000,
  notifyLedgerContainerMoved: jest.fn(),
  recordLedgerMoveIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../lib/script-runner', () => ({
  ...jest.requireActual<typeof ScriptRunner>('../lib/script-runner'),
  listTrackedShellScriptsForWorktree: jest.fn(() => []),
}));

import {
  combineWorktreeWithWorkspace,
  cleanupCompatibilitySymlinks,
  createOrReuseTemporaryWorkspaceFromRepos,
  createOrReuseTemporaryWorkspaceFromWorkspaces,
  listAdhocMultiRepoJoinOptions,
  promoteTemporaryWorkspace,
} from '../lib/adhoc-multi-repo-workspaces';
import {
  allocateAdhocDestinationWorktreeId,
  buildDestinationWorktree,
  replacePathWithCompatibilitySymlink,
} from '../lib/adhoc-combine-core';
import { listArchivedContainerManifests } from '../lib/archived-containers';
import { getActiveChatIds } from '../agents/session-manager';
import { listTrackedShellScriptsForWorktree } from '../lib/script-runner';
import { pathExists } from '../lib/fs-utils';
import {
  createWorktree,
  createWorktreeAvoidingCheckedOutBranch,
  getCurrentBranch,
  getRemoteUrl,
  getRepoRootFromWorktree,
  getWorktreeTopLevel,
  moveWorktree,
  removeWorktree,
} from '../lib/git';
import {
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from '../lib/paths';
import {
  listExecutionSummaries,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { safeRemoveWorktree } from '../lib/safe-remove-worktree';
import {
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { addRepoCheckoutToWorktree } from '../lib/workspace-repo-mutators';
import {
  addWorkspaceRepository,
  type WorkspaceRepositoryAddRequest,
  type WorkspaceRepositoryCandidate,
} from '../lib/workspace-repositories';
import { initializeWorkspaceSourceRepo } from '../lib/workspace-source-control';
import {
  createTemporaryMultiRepoWorkspace,
  listWorkspaceItems,
} from '../lib/workspace-service';
import {
  discardLedgerMoveIntent,
  LEDGER_INTENT_REFUSING_WAIT_MS,
  notifyLedgerContainerMoved,
  recordLedgerMoveIntent,
} from '../ledger/lifecycle';

const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedNotifyLedgerContainerMoved = jest.mocked(
  notifyLedgerContainerMoved,
);
const mockedRecordLedgerMoveIntent = jest.mocked(recordLedgerMoveIntent);
const mockedDiscardLedgerMoveIntent = jest.mocked(discardLedgerMoveIntent);

/** How a host that refuses without the mapping waits on its write. */
const refusingWait = { waitMs: LEDGER_INTENT_REFUSING_WAIT_MS };

/** A code worktree's Ledger incarnation, as the move calls take it. */
function ledgerWorktree(
  workspaceId: string,
  worktreeId: string,
): Parameters<typeof notifyLedgerContainerMoved>[0] {
  return {
    container: { kind: 'code_worktree', workspaceId, worktreeId },
    containerCreatedAt: '2026-05-19T00:00:00.000Z',
  };
}
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedGetActiveChatIds = jest.mocked(getActiveChatIds);
const mockedListTrackedShellScriptsForWorktree = jest.mocked(
  listTrackedShellScriptsForWorktree,
);
const mockedListExecutionSummaries = jest.mocked(listExecutionSummaries);
const mockedLoadExecutionState = jest.mocked(loadExecutionState);
const mockedSaveExecutionState = jest.mocked(saveExecutionState);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedAddRepoCheckoutToWorktree = jest.mocked(addRepoCheckoutToWorktree);
const mockedAddWorkspaceRepository = jest.mocked(addWorkspaceRepository);
/** The candidate of a combine's repository add (CAN-3819). */
function withCandidate<T>(
  build: (repo: WorkspaceRepositoryCandidate) => T,
): (request: WorkspaceRepositoryAddRequest) => T {
  return (request) => {
    if (!('repository' in request))
      throw new Error('Expected a new repository');
    return build(request.repository);
  };
}
/** The repository add a combine issues for its source workspace. */
function combineAdd(
  workspaceId: string,
  repository: WorkspaceRepositoryCandidate,
): WorkspaceRepositoryAddRequest {
  return { workspaceId, source: 'temporary_combine', repository };
}
const mockedInitializeWorkspaceSourceRepo = jest.mocked(
  initializeWorkspaceSourceRepo,
);
const mockedListArchivedContainerManifests = jest.mocked(
  listArchivedContainerManifests,
);
const mockedCreateTemporaryMultiRepoWorkspace = jest.mocked(
  createTemporaryMultiRepoWorkspace,
);
const mockedCreateWorktree = jest.mocked(
  createWorktreeAvoidingCheckedOutBranch,
);
// Rollback restores use the plain `createWorktree` (exact-branch semantics).
const mockedRestoreCreateWorktree = jest.mocked(createWorktree);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetRepoRootFromWorktree = jest.mocked(getRepoRootFromWorktree);
const mockedGetWorktreeTopLevel = jest.mocked(getWorktreeTopLevel);
const mockedListWorkspaceItems = jest.mocked(listWorkspaceItems);
const mockedMoveWorktree = jest.mocked(moveWorktree);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedPathExists = jest.mocked(pathExists);
const mockedSafeRemoveWorktree = jest.mocked(safeRemoveWorktree);
const mockedGetWorktreeDir = jest.mocked(getWorktreeDir);
const mockedGetWorkspaceWorktreeDir = jest.mocked(getWorkspaceWorktreeDir);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: 'worktree',
    branchName: 'feature',
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeMultiRepoWorkspace(
  overrides: Partial<MultiRepoSidebarItem> & {
    id: string;
    repos: WorkspaceRepoData[];
  },
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    name: overrides.id,
    color: '#123456',
    worktrees: [makeWorktree()],
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

function mockPathExistsFromDisk(
  virtualExistingPaths = new Set<string>(),
): void {
  mockedPathExists.mockImplementation(async (candidatePath: string) => {
    if (virtualExistingPaths.has(candidatePath)) {
      return true;
    }
    try {
      await lstat(candidatePath);
      return true;
    } catch {
      return false;
    }
  });
}

describe('adhoc multi-repo project helpers', () => {
  it('keeps the newest activity watermark on the destination', () => {
    const destination = buildDestinationWorktree({
      id: 'destination',
      sourceWorktree: makeWorktree({
        lastTouchedAt: '2026-09-01T12:00:00.000Z',
      }),
      repoIdRewrites: {},
      compatibilitySymlinks: [],
      existingDestinationWorktree: makeWorktree({
        id: 'destination',
        lastTouchedAt: '2026-09-02T12:00:00.000Z',
      }),
    });

    expect(destination.lastTouchedAt).toBe('2026-09-02T12:00:00.000Z');
  });

  it('merges activity and execution metadata from every consumed worktree', () => {
    const destination = buildDestinationWorktree({
      id: 'destination',
      sourceWorktree: makeWorktree({
        lastTouchedAt: '2026-09-01T12:00:00.000Z',
        seenPipelineExecutionIds: ['source-execution'],
      }),
      consumedWorktrees: [
        makeWorktree({
          id: 'joined',
          lastTouchedAt: '2026-09-03T12:00:00.000Z',
          seenPipelineExecutionIds: ['joined-execution'],
        }),
      ],
      repoIdRewrites: {},
      compatibilitySymlinks: [],
    });

    expect(destination.lastTouchedAt).toBe('2026-09-03T12:00:00.000Z');
    expect(destination.seenPipelineExecutionIds).toEqual([
      'source-execution',
      'joined-execution',
    ]);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetActiveChatIds.mockReturnValue([]);
    mockedListTrackedShellScriptsForWorktree.mockReturnValue([]);
    mockedListExecutionSummaries.mockResolvedValue([]);
    mockedLoadExecutionState.mockResolvedValue(null);
    mockedSaveExecutionState.mockResolvedValue(undefined);
    mockedCreateTemporaryMultiRepoWorkspace.mockRejectedValue(
      new Error('unexpected temporary project creation'),
    );
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    mockedListArchivedContainerManifests.mockResolvedValue([]);
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedPathExists.mockResolvedValue(true);
    mockedGetCurrentBranch.mockResolvedValue('main');
    mockedGetRemoteUrl.mockResolvedValue(null);
    mockedGetRepoRootFromWorktree.mockImplementation((worktreePath: string) =>
      Promise.resolve(worktreePath),
    );
    mockedGetWorktreeTopLevel.mockImplementation((worktreePath: string) =>
      Promise.resolve(worktreePath),
    );
    mockedGetWorktreeDir.mockImplementation(
      (workspaceId: string, worktreeId: string) =>
        `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
    );
    mockedGetWorkspaceWorktreeDir.mockImplementation(
      (workspaceId: string, worktreeId: string) =>
        `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
    );
    mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
      (workspaceId: string, worktreeId: string, repoId: string) =>
        `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
    );
    mockedMoveWorktree.mockResolvedValue(undefined);
    mockedRemoveWorktree.mockResolvedValue(undefined);
    mockedCreateWorktree.mockResolvedValue('main');
    mockedAddRepoCheckoutToWorktree.mockResolvedValue(undefined);
    mockedSafeRemoveWorktree.mockResolvedValue(undefined);
    mockedRemoveWorkspaceWorktrees.mockImplementation(
      async (workspaceId, predicate) =>
        (await mockedReadWorkspaceWorktrees(workspaceId)).filter(predicate),
    );
    mockedInitializeWorkspaceSourceRepo.mockResolvedValue({
      sourceRepoPath: '/repos/permanent-workspace',
      manifest: { version: 1, repos: [] },
      warnings: [],
    });
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => Promise.resolve(updater([])),
    );
  });

  it('reserves ids already used by archived containers', async () => {
    mockedListArchivedContainerManifests.mockResolvedValue([
      {
        version: 1,
        id: 'source-wt',
        kind: 'worktree',
        projectId: 'destination',
        name: 'Existing archive',
        createdAt: '2026-08-01T00:00:00.000Z',
        archivedAt: '2026-08-02T00:00:00.000Z',
        retentionDays: 30,
        expiresAt: '2026-09-01T00:00:00.000Z',
        chatCount: 0,
        archivedChatCount: 0,
        executionCount: 0,
        workspaceType: 'single-repo',
      },
    ]);

    await expect(
      allocateAdhocDestinationWorktreeId('destination', 'source-wt'),
    ).resolves.toBe('source-wt-2');
  });

  it('promotes a temporary project and initializes project source control', async () => {
    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'temp-workspace',
      name: 'Temp',
      color: '#123456',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      temporary: true,
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [workspace],
    });
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'app',
          name: 'App',
          repoPath: '/repos/app',
          source: 'local',
        },
      ],
      temporary: true,
    });

    const result = await promoteTemporaryWorkspace({
      workspaceId: 'temp-workspace',
      name: 'Permanent Workspace',
    });

    expect(result).toMatchObject({
      id: 'temp-workspace',
      name: 'Permanent Workspace',
      temporary: undefined,
      repos: [
        {
          id: 'app',
          name: 'App',
          repoPath: '/repos/app',
          source: 'local',
        },
      ],
      sourceRepoPath: '/repos/permanent-workspace',
    });
    expect(mockedInitializeWorkspaceSourceRepo).toHaveBeenCalledWith(
      {
        workspaceId: 'temp-workspace',
        workspaceName: 'Permanent Workspace',
        source: 'temporary_promote',
      },
      expect.objectContaining({
        commit: {
          operation: 'core.workspace.composition.promote',
          expectedRevisions: undefined,
        },
      }),
    );
    expect(promoteCompositionWorkspace).toHaveBeenCalledWith({
      source: 'temporary_promote',
      workspaceId: 'temp-workspace',
      name: 'Permanent Workspace',
      sourceRepoPath: '/repos/permanent-workspace',
    });
  });

  it('rejects promotion with a blank name', async () => {
    await expect(
      promoteTemporaryWorkspace({ workspaceId: 'temp-workspace', name: '   ' }),
    ).rejects.toThrow('Project name is required');
  });

  it('filters add-repo join options that do not contribute new repos for temporary multi-repo sources', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source',
      temporary: true,
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
      ],
    });
    const duplicateSingle = {
      type: 'single-repo' as const,
      id: 'duplicate-single',
      name: 'Duplicate Single',
      color: '#111111',
      repoPath: '/clones/a',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const localDuplicateSingle = {
      type: 'single-repo' as const,
      id: 'local-duplicate-single',
      name: 'Local Duplicate Single',
      color: '#222222',
      repoPath: '/repos/b',
      worktrees: [],
      collapsed: false,
      order: 2,
    };
    const duplicateMulti = makeMultiRepoWorkspace({
      id: 'duplicate-multi',
      repos: [{ id: 'repo-a-copy', name: 'Repo A', repoPath: '/clones/a' }],
    });
    const mixedMulti = makeMultiRepoWorkspace({
      id: 'mixed-multi',
      repos: [
        { id: 'repo-a-copy', name: 'Repo A', repoPath: '/clones/a' },
        { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
      ],
    });
    const newSingle = {
      type: 'single-repo' as const,
      id: 'new-single',
      name: 'New Single',
      color: '#333333',
      repoPath: '/repos/d',
      worktrees: [],
      collapsed: false,
      order: 5,
    };
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      duplicateSingle,
      localDuplicateSingle,
      duplicateMulti,
      mixedMulti,
      newSingle,
    ]);
    mockedGetRemoteUrl.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/a' || repoPath === '/clones/a') {
        return Promise.resolve('git@github.com:example/repo-a.git');
      }
      if (repoPath === '/repos/c') {
        return Promise.resolve('https://github.com/example/repo-c.git');
      }
      return Promise.resolve(null);
    });

    const result = await listAdhocMultiRepoJoinOptions({
      sourceWorkspaceId: 'source',
    });

    expect(result.options.map((option) => option.id)).toEqual([
      'mixed-multi',
      'new-single',
    ]);
    expect(
      result.options.find((option) => option.id === 'mixed-multi'),
    ).toMatchObject({
      isMultiRepo: true,
      repoCount: 2,
    });
  });

  it('excludes cowork projects from adhoc multi-repo join options without throwing', async () => {
    const sourceWorkspace = {
      type: 'single-repo' as const,
      id: 'source',
      name: 'Source',
      color: '#000000',
      repoPath: '/repos/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const coworkWorkspace = {
      type: 'cowork' as const,
      id: 'cowork-1',
      name: 'Research Notes',
      color: '#C08457',
      collapsed: false,
      order: 1,
    };
    const joinSingle = {
      type: 'single-repo' as const,
      id: 'join-single',
      name: 'Join Single',
      color: '#333333',
      repoPath: '/repos/d',
      worktrees: [],
      collapsed: false,
      order: 2,
    };
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      coworkWorkspace,
      joinSingle,
    ]);
    mockedGetRemoteUrl.mockResolvedValue(null);

    const result = await listAdhocMultiRepoJoinOptions({
      sourceWorkspaceId: 'source',
    });

    expect(result.options.map((option) => option.id)).toEqual(['join-single']);
    expect(result.options.some((option) => option.id === 'cowork-1')).toBe(
      false,
    );
  });

  it('returns no join options when the source project is cowork', async () => {
    const coworkSource = {
      type: 'cowork' as const,
      id: 'source',
      name: 'Cowork Source',
      color: '#C08457',
      collapsed: false,
      order: 0,
    };
    const joinSingle = {
      type: 'single-repo' as const,
      id: 'join-single',
      name: 'Join Single',
      color: '#333333',
      repoPath: '/repos/d',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    mockedListWorkspaceItems.mockResolvedValue([coworkSource, joinSingle]);

    const result = await listAdhocMultiRepoJoinOptions({
      sourceWorkspaceId: 'source',
    });

    expect(result.options).toEqual([]);
  });

  it('rejects combine requests when the selected project adds no repos', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source',
      temporary: true,
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
    });
    const joinWorkspace = {
      type: 'single-repo' as const,
      id: 'join',
      name: 'Join',
      color: '#111111',
      repoPath: '/clones/a',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:example/repo-a.git');

    await expect(
      combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      }),
    ).rejects.toThrow('Selected projects do not add any new repos.');
  });

  it('creates a temporary project from multiple selected projects', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/repos/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = makeMultiRepoWorkspace({
      id: 'workspace-bc',
      repos: [
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
      ],
      worktrees: [],
      order: 1,
    });
    const temporaryWorkspace = makeMultiRepoWorkspace({
      id: 'temp-workspace',
      temporary: true,
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
      ],
      worktrees: [],
      order: 2,
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      temporaryWorkspace,
    );

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'workspace-bc',
      'repo-a',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).toHaveBeenCalledWith(
      [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
      ],
      {
        repoIdentityKeys: ['path:/repos/a', 'path:/repos/b', 'path:/repos/c'],
        sourceWorkspaceIds: ['repo-a', 'workspace-bc'],
        commit: { operation: 'core.workspace.create' },
      },
    );
    expect(result).toEqual({
      workspace: temporaryWorkspace,
      createdTemporaryWorkspace: true,
      reusedWorkspace: false,
    });
  });

  it('reuses an existing project when selected projects resolve to the same repo set', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/repos/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-b',
      name: 'Repo B',
      color: '#222222',
      repoPath: '/repos/b',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const existingWorkspace = makeMultiRepoWorkspace({
      id: 'existing',
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
      ],
      worktrees: [],
      order: 2,
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
      existingWorkspace,
    ]);

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'repo-a',
      'repo-b',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: existingWorkspace,
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
    });
  });

  it('uses sidebar order when resolving selected projects for temporary reuse', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/repos/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-b',
      name: 'Repo B',
      color: '#222222',
      repoPath: '/repos/b',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const thirdWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-c',
      name: 'Repo C',
      color: '#333333',
      repoPath: '/repos/c',
      worktrees: [],
      collapsed: false,
      order: 2,
    };
    const existingTemporaryWorkspace = makeMultiRepoWorkspace({
      id: 'repo-a-repo-b-repo-c',
      name: 'Repo A, Repo B & Repo C',
      temporary: true,
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
      ],
      worktrees: [],
      order: 3,
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
      thirdWorkspace,
      existingTemporaryWorkspace,
    ]);

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'repo-c',
      'repo-a',
      'repo-b',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: existingTemporaryWorkspace,
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
    });
  });

  it('reuses a matching temporary project by manifest repo identity', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/selected/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-b',
      name: 'Repo B',
      color: '#222222',
      repoPath: '/selected/b',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const existingTemporaryWorkspace = makeMultiRepoWorkspace({
      id: 'repo-a-repo-b',
      name: 'Repo A & Repo B',
      temporary: true,
      repos: [
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/cached/b',
          manifestUrl: 'https://github.com/org/repo-b.git',
        },
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/cached/a',
          manifestUrl: 'https://github.com/org/repo-a.git',
        },
      ],
      worktrees: [],
      order: 2,
    });
    mockedGetRemoteUrl.mockImplementation((repoPath) => {
      if (repoPath === '/selected/a') {
        return Promise.resolve('git@github.com:org/repo-a.git');
      }
      if (repoPath === '/selected/b') {
        return Promise.resolve('git@github.com:org/repo-b.git');
      }
      return Promise.resolve(null);
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
      existingTemporaryWorkspace,
    ]);

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'repo-a',
      'repo-b',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: existingTemporaryWorkspace,
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
    });
  });

  it('reuses a matching temporary project by selected project provenance', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/selected/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-b',
      name: 'Repo B',
      color: '#222222',
      repoPath: '/selected/b',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const existingTemporaryWorkspace = makeMultiRepoWorkspace({
      id: 'repo-a-repo-b',
      name: 'Repo A & Repo B',
      temporary: true,
      temporarySourceWorkspaceIds: ['repo-b', 'repo-a'],
      repos: [
        { id: 'repo-b', name: 'Repo B', repoPath: '/other/b' },
        { id: 'repo-a', name: 'Repo A', repoPath: '/other/a' },
      ],
      worktrees: [],
      order: 2,
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
      existingTemporaryWorkspace,
    ]);

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'repo-a',
      'repo-b',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: existingTemporaryWorkspace,
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
    });
  });

  it('reuses a matching temporary project by stored repo identity signature', async () => {
    const firstWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-a',
      name: 'Repo A',
      color: '#111111',
      repoPath: '/selected/a',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const secondWorkspace = {
      type: 'single-repo' as const,
      id: 'repo-b',
      name: 'Repo B',
      color: '#222222',
      repoPath: '/selected/b',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const existingTemporaryWorkspace = makeMultiRepoWorkspace({
      id: 'repo-a-repo-b',
      name: 'Repo A & Repo B',
      temporary: true,
      temporaryRepoIdentityKeys: [
        'remote:github.com/org/repo-b',
        'remote:github.com/org/repo-a',
      ],
      repos: [
        { id: 'repo-b', name: 'Repo B', repoPath: '/stale/b' },
        { id: 'repo-a', name: 'Repo A', repoPath: '/stale/a' },
      ],
      worktrees: [],
      order: 2,
    });
    mockedGetRemoteUrl.mockImplementation((repoPath) => {
      if (repoPath === '/selected/a') {
        return Promise.resolve('git@github.com:org/repo-a.git');
      }
      if (repoPath === '/selected/b') {
        return Promise.resolve('https://github.com/org/repo-b');
      }
      return Promise.resolve(null);
    });
    mockedListWorkspaceItems.mockResolvedValue([
      firstWorkspace,
      secondWorkspace,
      existingTemporaryWorkspace,
    ]);

    const result = await createOrReuseTemporaryWorkspaceFromWorkspaces([
      'repo-b',
      'repo-a',
    ]);

    expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspace: existingTemporaryWorkspace,
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
    });
  });

  it('combines a worktree with multiple selected projects at once', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-multi-'));
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'destination');
      await mkdir(sourceCheckout, { recursive: true });
      await mkdir(destinationRoot, { recursive: true });
      mockPathExistsFromDisk();
      mockedGetWorktreeDir.mockImplementation((workspaceId, worktreeId) =>
        workspaceId === 'source' && worktreeId === 'worktree'
          ? sourceCheckout
          : join(tempDir, workspaceId, worktreeId),
      );
      mockedGetWorkspaceWorktreeDir.mockImplementation(
        (workspaceId, worktreeId) =>
          workspaceId === 'temp' && worktreeId === 'worktree'
            ? destinationRoot
            : join(tempDir, workspaceId, worktreeId),
      );
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (workspaceId, worktreeId, repoId) =>
          join(
            workspaceId === 'temp' && worktreeId === 'worktree'
              ? destinationRoot
              : join(tempDir, workspaceId, worktreeId),
            'repos',
            repoId,
          ),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#111111',
        repoPath: '/repos/a',
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const firstJoinWorkspace = {
        type: 'single-repo' as const,
        id: 'repo-b',
        name: 'Repo B',
        color: '#222222',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const secondJoinWorkspace = {
        type: 'single-repo' as const,
        id: 'repo-c',
        name: 'Repo C',
        color: '#333333',
        repoPath: '/repos/c',
        worktrees: [],
        collapsed: false,
        order: 2,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'temp',
        temporary: true,
        repos: [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
          { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
        ],
        worktrees: [],
        order: 3,
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryWorkspace,
      );
      mockedListWorkspaceItems
        .mockResolvedValueOnce([
          sourceWorkspace,
          firstJoinWorkspace,
          secondJoinWorkspace,
        ])
        .mockResolvedValueOnce([
          sourceWorkspace,
          firstJoinWorkspace,
          secondJoinWorkspace,
        ])
        .mockResolvedValueOnce([temporaryWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceIds: ['repo-b', 'repo-c'],
        mode: 'temporary',
      });

      expect(mockedCreateTemporaryMultiRepoWorkspace).toHaveBeenCalledWith(
        [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
          { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
        ],
        {
          commit: {
            operation: 'core.workspace.composition.combine',
            expectedRevisions: undefined,
          },
          repoIdentityKeys: ['path:/repos/a', 'path:/repos/b', 'path:/repos/c'],
        },
      );
      expect(
        result.repoMappings.map((mapping) => mapping.destinationRepoId),
      ).toEqual(['source', 'repo-b', 'repo-c']);
      expect(result).toMatchObject({
        destinationWorkspaceId: 'temp',
        destinationWorktreeId: 'worktree',
        createdTemporaryWorkspace: true,
      });
    } finally {
      mockedGetWorktreeDir.mockImplementation(
        (workspaceId: string, worktreeId: string) =>
          `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
      );
      mockedGetWorkspaceWorktreeDir.mockImplementation(
        (workspaceId: string, worktreeId: string) =>
          `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
      );
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (workspaceId: string, worktreeId: string, repoId: string) =>
          `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
      );
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('removes only tracked compatibility symlinks', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-'));
    try {
      const targetPath = join(tempDir, 'target');
      const symlinkPath = join(tempDir, 'old');
      const realDirectoryPath = join(tempDir, 'real-dir');
      await mkdir(targetPath);
      await mkdir(realDirectoryPath);
      await symlink(
        process.platform === 'win32' ? targetPath : 'target',
        symlinkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const worktree: WorktreeData = {
        id: 'destination',
        branchName: 'branch',
        createdAt: '2026-05-19T00:00:00.000Z',
        compatibilitySymlinks: [
          {
            path: symlinkPath,
            targetPath,
            reason: 'adhoc-multi-repo-transition',
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'worktree',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
          {
            path: realDirectoryPath,
            targetPath,
            reason: 'adhoc-multi-repo-transition',
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'worktree',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      };

      await expect(cleanupCompatibilitySymlinks(worktree)).resolves.toEqual([]);
      await expect(lstat(symlinkPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(lstat(realDirectoryPath)).resolves.toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates Windows-compatible junction targets that resolve to the moved worktree path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-link-'));
    try {
      const targetPath = join(tempDir, 'target');
      const linkPath = join(tempDir, 'old');
      await mkdir(targetPath);

      const link = await replacePathWithCompatibilitySymlink(
        linkPath,
        targetPath,
        {
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
        },
        'win32',
      );

      expect(link.path).toBe(linkPath);
      expect(link.targetPath).toBe(targetPath);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(isAbsolute(await readlink(linkPath))).toBe(true);
      await expect(realpath(linkPath)).resolves.toBe(
        await realpath(targetPath),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('adds missing repos to the current source worktree in update-source-workspace mode', async () => {
    const sourceWorkspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'source',
      name: 'Source',
      color: '#123456',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      worktrees: [
        {
          id: 'worktree',
          branchName: 'feature',
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
    };
    const joinWorkspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'join',
      name: 'Join',
      color: '#654321',
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
      ],
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([
        {
          ...sourceWorkspace,
          repos: [...sourceWorkspace.repos, joinWorkspace.repos[1]],
        },
        joinWorkspace,
      ]);
    mockedAddWorkspaceRepository.mockResolvedValue(joinWorkspace.repos[1]);
    mockedListExecutionSummaries.mockResolvedValue([
      {
        id: 'exec-1',
        pipeline_id: 'pipeline-1',
        pipeline_name: 'Pipeline 1',
        project_id: 'source',
        worktree_id: 'worktree',
        status: 'success',
        status_reasons: [],
        started_at: '2026-05-19T00:00:00.000Z',
        cwd: '/repos/source',
      },
    ]);

    const result = await combineWorktreeWithWorkspace({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      joinWorkspaceId: 'join',
      mode: 'update-source-workspace',
    });

    expect(mockedAddWorkspaceRepository).toHaveBeenCalledWith(
      combineAdd('source', {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repos/b',
      }),
      expect.objectContaining({
        operation: 'core.workspace.composition.combine',
      }),
    );
    expect(mockedAddRepoCheckoutToWorktree).toHaveBeenCalledWith(
      'source',
      'worktree',
      joinWorkspace.repos[1],
    );
    expect(result).toMatchObject({
      destinationWorkspaceId: 'source',
      destinationWorktreeId: 'worktree',
      removedSourceWorktree: false,
    });
    expect(
      result.repoMappings.map((mapping) => mapping.destinationRepoId),
    ).toEqual(['repo-a', 'repo-b']);
    expect(mockedLoadExecutionState).not.toHaveBeenCalled();
    expect(mockedSaveExecutionState).not.toHaveBeenCalled();
  });

  it('rolls back update-source-workspace config and unregisters created checkouts when adding a checkout fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-update-'));
    try {
      const repoBCheckoutPath = join(tempDir, 'worktree', 'repos', 'repo-b');
      const repoCCheckoutPath = join(tempDir, 'worktree', 'repos', 'repo-c');
      const originalConfig = {
        version: 1 as const,
        type: 'multi-repo' as const,
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      };
      const sourceWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'source',
        name: 'Source',
        color: '#123456',
        repos: originalConfig.repos,
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'join',
        name: 'Join',
        color: '#654321',
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
          { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
        ],
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      mockedReadWorkspaceConfig.mockResolvedValue(originalConfig);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          repoId === 'repo-b'
            ? repoBCheckoutPath
            : repoId === 'repo-c'
              ? repoCCheckoutPath
              : `/mock/workspaces/source/worktrees/worktree/repos/${repoId}`,
      );
      mockedListWorkspaceItems.mockResolvedValue([
        sourceWorkspace,
        joinWorkspace,
      ]);
      mockedAddWorkspaceRepository.mockImplementation(
        withCandidate((repo) =>
          repo.id === undefined || repo.name === undefined
            ? Promise.reject(new Error('Expected repository identity'))
            : Promise.resolve({
                id: repo.id,
                name: repo.name,
                repoPath: repo.repoPath,
              }),
        ),
      );
      mockedAddRepoCheckoutToWorktree.mockImplementation(
        async (_workspaceId, _worktreeId, repo) => {
          const checkoutPath =
            repo.id === 'repo-b' ? repoBCheckoutPath : repoCCheckoutPath;
          if (repo.id === 'repo-c') {
            throw new Error('checkout failed');
          }
          await mkdir(checkoutPath, { recursive: true });
        },
      );
      mockedRemoveWorktree.mockImplementation(
        async (_repoPath, checkoutPath) => {
          await rm(checkoutPath, { recursive: true, force: true });
        },
      );

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'update-source-workspace',
        }),
      ).rejects.toThrow('checkout failed');

      expect(
        jest.mocked(undoCompositionRepositories).mock.calls[0]?.[0],
      ).toMatchObject({
        workspaceId: 'source',
        repositories: [{ repoPath: '/repos/b' }, { repoPath: '/repos/c' }],
      });
      expect(mockedRemoveWorktree).toHaveBeenCalledWith(
        '/repos/b',
        repoBCheckoutPath,
      );
      await expect(lstat(repoBCheckoutPath)).rejects.toThrow();
      await expect(lstat(repoCCheckoutPath)).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not remove a pre-existing checkout directory when update-source checkout creation is rejected', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-existing-'));
    try {
      const repoBCheckoutPath = join(tempDir, 'worktree', 'repos', 'repo-b');
      await mkdir(repoBCheckoutPath, { recursive: true });
      const sentinelPath = join(repoBCheckoutPath, 'keep.txt');
      await writeFile(sentinelPath, 'user content', 'utf8');
      const originalConfig = {
        version: 1 as const,
        type: 'multi-repo' as const,
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      };
      const sourceWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'source',
        name: 'Source',
        color: '#123456',
        repos: originalConfig.repos,
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'join',
        name: 'Join',
        color: '#654321',
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      mockedReadWorkspaceConfig.mockResolvedValue(originalConfig);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          repoId === 'repo-b'
            ? repoBCheckoutPath
            : `/mock/workspaces/source/worktrees/worktree/repos/${repoId}`,
      );
      mockedListWorkspaceItems.mockResolvedValue([
        sourceWorkspace,
        joinWorkspace,
      ]);
      mockedAddWorkspaceRepository.mockImplementation(
        withCandidate((repo) =>
          repo.id === undefined || repo.name === undefined
            ? Promise.reject(new Error('Expected repository identity'))
            : Promise.resolve({
                id: repo.id,
                name: repo.name,
                repoPath: repo.repoPath,
              }),
        ),
      );
      mockedAddRepoCheckoutToWorktree.mockRejectedValue(
        new Error(
          `Cannot add repo: ${repoBCheckoutPath} already exists and is not empty. Remove it manually if this is unexpected.`,
        ),
      );

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'update-source-workspace',
        }),
      ).rejects.toThrow('already exists and is not empty');

      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
      await expect(lstat(sentinelPath)).resolves.toBeTruthy();
      expect(
        jest.mocked(undoCompositionRepositories).mock.calls[0]?.[0],
      ).toMatchObject({
        workspaceId: 'source',
        repositories: [{ repoPath: '/repos/b' }],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects active source chat sessions before filesystem transition work starts', async () => {
    const sourceWorkspace = {
      type: 'single-repo' as const,
      id: 'source',
      name: 'Source',
      color: '#123456',
      repoPath: '/repos/source',
      worktrees: [
        {
          id: 'worktree',
          branchName: 'feature',
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
    };
    const joinWorkspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'join',
      name: 'Join',
      color: '#654321',
      repos: [{ id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' }],
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    mockedGetActiveChatIds.mockReturnValue(['chat-1']);
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace]);

    await expect(
      combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      }),
    ).rejects.toThrow(
      'Stop active chats before adding a repo to this worktree.',
    );

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects running source pipeline executions before filesystem transition work starts', async () => {
    const sourceWorkspace = {
      type: 'single-repo' as const,
      id: 'source',
      name: 'Source',
      color: '#123456',
      repoPath: '/repos/source',
      worktrees: [makeWorktree()],
      collapsed: false,
      order: 0,
    };
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join',
      repos: [{ id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' }],
      worktrees: [],
    });
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace]);
    mockedListExecutionSummaries.mockResolvedValue([
      {
        id: 'exec-1',
        pipeline_id: 'pipeline-1',
        pipeline_name: 'Pipeline 1',
        project_id: 'source',
        worktree_id: 'worktree',
        status: 'running',
        status_reasons: [],
        started_at: '2026-05-19T00:00:00.000Z',
        cwd: '/repos/source',
      },
    ]);

    await expect(
      combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      }),
    ).rejects.toThrow(
      'Wait for running workflow executions to finish before adding a repo to this worktree.',
    );

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects a running source setup script before filesystem transition work starts', async () => {
    const sourceWorkspace = {
      type: 'single-repo' as const,
      id: 'source',
      name: 'Source',
      color: '#123456',
      repoPath: '/repos/source',
      worktrees: [makeWorktree()],
      collapsed: false,
      order: 0,
    };
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join',
      repos: [{ id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' }],
      worktrees: [],
    });
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace]);
    mockedListTrackedShellScriptsForWorktree.mockImplementation((target) =>
      target.projectId === 'source' && target.worktreeId === 'worktree'
        ? [{ projectId: 'source', worktreeId: 'worktree', scriptKey: 'setup' }]
        : [],
    );

    await expect(
      combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      }),
    ).rejects.toThrow(
      'Wait for running scripts, such as setup, to finish before adding a repo to this worktree.',
    );

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects nested source checkout paths before filesystem transition work starts', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'canopy-adhoc-nested-source-'),
    );
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const nestedCheckout = join(sourceCheckout, 'nested');
      await mkdir(nestedCheckout, { recursive: true });
      mockPathExistsFromDisk();

      mockedGetWorktreeDir.mockReturnValue(nestedCheckout);
      mockedGetWorktreeTopLevel.mockResolvedValue(sourceCheckout);

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Source',
        color: '#123456',
        repoPath: '/repos/source',
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = makeMultiRepoWorkspace({
        id: 'join',
        repos: [{ id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' }],
        worktrees: [],
      });
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace]);

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'temporary',
        }),
      ).rejects.toThrow(
        `Cannot add repo: source checkout is not a Git worktree root at ${nestedCheckout}.`,
      );

      expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
      expect(mockedMoveWorktree).not.toHaveBeenCalled();
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an existing adhoc destination on idempotent retry without mutating files', async () => {
    const destinationWorktree = makeWorktree({
      id: 'existing-destination',
      seenPipelineExecutionIds: ['existing-exec', 'source-exec'],
      adhocTransitionSource: {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        sourceRepoIds: ['source-repo'],
        repoMappings: [
          {
            sourceRepoId: 'source-repo',
            destinationRepoId: 'repo-a',
            repoName: 'Repo A',
            repoPath: '/repos/a',
            oldWorktreePath: '/old/source',
            newWorktreePath: '/new/destination',
          },
        ],
        selectedRepoIdRewrites: { 'source-repo': 'repo-a' },
        sourceRootRepoIdRewrite: 'repo-a',
        filePathRewrites: [
          { fromRoot: '/old/source', toRoot: '/new/destination' },
        ],
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      compatibilitySymlinks: [
        {
          path: '/old/source',
          targetPath: '/new/destination',
          reason: 'adhoc-multi-repo-transition',
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    });
    const destinationWorkspace = makeMultiRepoWorkspace({
      id: 'destination',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      worktrees: [destinationWorktree],
    });
    mockedListWorkspaceItems.mockResolvedValue([destinationWorkspace]);

    const result = await combineWorktreeWithWorkspace({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      joinWorkspaceId: 'join',
      mode: 'temporary',
    });

    expect(result).toMatchObject({
      destinationWorkspaceId: 'destination',
      destinationWorktreeId: 'existing-destination',
      removedSourceWorktree: true,
      compatibilitySymlinks: destinationWorktree.compatibilitySymlinks,
      repoMappings: [
        {
          sourceRepoId: 'source-repo',
          destinationRepoId: 'repo-a',
          repoName: 'Repo A',
          repoPath: '/repos/a',
          oldWorktreePath: '/old/source',
          newWorktreePath: '/new/destination',
        },
      ],
      selectedRepoIdRewrites: { 'source-repo': 'repo-a' },
      sourceRootRepoIdRewrite: 'repo-a',
      filePathRewrites: [
        { fromRoot: '/old/source', toRoot: '/new/destination' },
      ],
    });
    expect(result.destinationWorktree).toMatchObject({
      seenPipelineExecutionIds: ['existing-exec', 'source-exec'],
    });
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('ignores self retry markers when adding another project to a live source worktree', async () => {
    const sourceWorktree = makeWorktree({
      adhocTransitionSource: {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        sourceRepoIds: ['repo-a'],
        repoMappings: [],
        selectedRepoIdRewrites: {},
        filePathRewrites: [],
        joinedWorktreeMigration: {
          workspaceId: 'previous-join',
          worktreeId: 'previous-worktree',
          repoMappings: [],
          selectedRepoIdRewrites: {},
          filePathRewrites: [],
          compatibilitySymlinks: [],
        },
        createdAt: '2026-05-19T00:00:00.000Z',
      },
    });
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      worktrees: [sourceWorktree],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join',
      repos: [{ id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' }],
      worktrees: [],
    });
    const refreshedSource = makeMultiRepoWorkspace({
      id: 'source',
      repos: [...sourceWorkspace.repos, joinWorkspace.repos[0]],
      worktrees: [sourceWorktree],
    });
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([refreshedSource, joinWorkspace]);
    mockedAddWorkspaceRepository.mockResolvedValue(joinWorkspace.repos[0]);

    const result = await combineWorktreeWithWorkspace({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      joinWorkspaceId: 'join',
      mode: 'update-source-workspace',
    });

    expect(result.destinationWorkspaceId).toBe('source');
    expect(result.destinationWorktreeId).toBe('worktree');
    expect(result.removedSourceWorktree).toBe(false);
    expect(mockedAddWorkspaceRepository).toHaveBeenCalledWith(
      combineAdd('source', {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repos/b',
      }),
      expect.objectContaining({
        operation: 'core.workspace.composition.combine',
      }),
    );
    expect(mockedAddRepoCheckoutToWorktree).toHaveBeenCalledWith(
      'source',
      'worktree',
      joinWorkspace.repos[0],
    );
  });

  it('creates a temporary project for single-repo source plus single-repo target transitions', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-single-'));
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'temporary-worktree');
      await mkdir(sourceCheckout, { recursive: true });
      mockPathExistsFromDisk();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [
          makeWorktree({
            seenPipelineExecutionIds: ['source-exec', 'shared-exec'],
          }),
        ],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = {
        type: 'single-repo' as const,
        id: 'join',
        name: 'Repo B',
        color: '#654321',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'temp',
        name: 'Repo A & Repo B',
        temporary: true,
        repos: [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'join', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryWorkspace,
      );
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([temporaryWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(mockedCreateTemporaryMultiRepoWorkspace).toHaveBeenCalledWith(
        [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'join', name: 'Repo B', repoPath: '/repos/b' },
        ],
        {
          commit: {
            operation: 'core.workspace.composition.combine',
            expectedRevisions: undefined,
          },
          repoIdentityKeys: ['path:/repos/a', 'path:/repos/b'],
        },
      );
      expect(result).toMatchObject({
        destinationWorkspaceId: 'temp',
        destinationWorktreeId: 'worktree',
        createdTemporaryWorkspace: true,
        reusedWorkspace: false,
        sourceRootRepoIdRewrite: 'source',
      });
      expect(mockedMoveWorktree).toHaveBeenCalledWith(
        '/repos/a',
        sourceCheckout,
        join(destinationRoot, 'repos', 'source'),
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/b',
        join(destinationRoot, 'repos', 'join'),
        'feature',
      );
      // The worktree moved to the temporary project with its creation time,
      // so its ledger follows. The move is durable before the destination
      // row is written; the participant hears of it once the source row is
      // gone.
      const move = [
        ledgerWorktree('source', 'worktree'),
        ledgerWorktree('temp', 'worktree'),
      ];
      expect(mockedRecordLedgerMoveIntent.mock.calls).toEqual([
        [...move, refusingWait],
      ]);
      expect(mockedNotifyLedgerContainerMoved.mock.calls).toEqual([move]);
      expect(mockedDiscardLedgerMoveIntent).not.toHaveBeenCalled();
      expect(
        mockedRecordLedgerMoveIntent.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockedUpdateWorkspaceWorktrees.mock.invocationCallOrder[0] ??
          Number.NEGATIVE_INFINITY,
      );
      expect(
        mockedNotifyLedgerContainerMoved.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        mockedRemoveWorkspaceWorktrees.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['the source row cannot be removed', 'remove'],
    ['the Ledger participant throws', 'participant'],
    ['the Ledger mapping cannot be saved', 'not_durable'],
    ['the Ledger mapping write throws', 'intent_throws'],
    ['the destination ID is suffixed', 'suffix'],
    ['the mapping to a suffixed ID cannot be saved', 'suffix_not_durable'],
  ] as const)(
    'keeps the Ledger out of a temporary combine outcome when %s',
    async (_case, failure) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-ledger-'));
      try {
        const sourceCheckout = join(tempDir, 'source-checkout');
        const destinationRoot = join(tempDir, 'temporary-worktree');
        await mkdir(sourceCheckout, { recursive: true });
        mockPathExistsFromDisk();
        mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
        mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
        mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
          (_workspaceId: string, _worktreeId: string, repoId: string) =>
            join(destinationRoot, 'repos', repoId),
        );
        mockedMoveWorktree.mockImplementation(
          async (_repoPath, oldPath, newPath) => {
            await rm(oldPath, { recursive: true, force: true });
            await mkdir(newPath, { recursive: true });
          },
        );
        mockedCreateWorktree.mockImplementation(
          async (_repoPath, worktreePath) => {
            await mkdir(worktreePath, { recursive: true });
            return 'feature';
          },
        );
        mockedGetCurrentBranch.mockResolvedValue('feature');
        const sourceWorkspace = {
          type: 'single-repo' as const,
          id: 'source',
          name: 'Repo A',
          color: '#123456',
          repoPath: '/repos/a',
          worktrees: [makeWorktree()],
          collapsed: false,
          order: 0,
        };
        const joinWorkspace = {
          type: 'single-repo' as const,
          id: 'join',
          name: 'Repo B',
          color: '#654321',
          repoPath: '/repos/b',
          worktrees: [],
          collapsed: false,
          order: 1,
        };
        const temporaryWorkspace = makeMultiRepoWorkspace({
          id: 'temp',
          name: 'Repo A & Repo B',
          temporary: true,
          repos: [
            { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
            { id: 'join', name: 'Repo B', repoPath: '/repos/b' },
          ],
          worktrees: [],
        });
        mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
          temporaryWorkspace,
        );
        const refused =
          failure === 'not_durable' ||
          failure === 'intent_throws' ||
          failure === 'suffix_not_durable';
        mockedListWorkspaceItems
          .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
          .mockResolvedValueOnce([sourceWorkspace, joinWorkspace]);
        // Only a combine that commits reads the projects again.
        if (!refused) {
          mockedListWorkspaceItems.mockResolvedValueOnce([temporaryWorkspace]);
        }
        if (failure === 'remove') {
          mockedRemoveWorkspaceWorktrees.mockRejectedValueOnce(
            new Error('source row removal failed'),
          );
        } else if (failure === 'participant') {
          mockedNotifyLedgerContainerMoved.mockImplementationOnce(() => {
            throw new Error('Ledger participant defect');
          });
        } else if (failure === 'intent_throws') {
          mockedRecordLedgerMoveIntent.mockRejectedValueOnce(
            new Error('Ledger journal defect'),
          );
        } else if (failure === 'not_durable') {
          mockedRecordLedgerMoveIntent.mockResolvedValueOnce('not_durable');
        }
        const suffixed =
          failure === 'suffix' || failure === 'suffix_not_durable';
        if (failure === 'suffix_not_durable') {
          mockedRecordLedgerMoveIntent.mockResolvedValueOnce('not_durable');
        }
        if (suffixed) {
          // Another worktree already uses the ID in the temporary project.
          mockedReadWorkspaceWorktrees.mockImplementation(
            (workspaceId: string) =>
              Promise.resolve(
                workspaceId === 'temp'
                  ? [makeWorktree({ id: 'worktree' })]
                  : [],
              ),
          );
        }

        const combine = combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'temporary',
        });

        const move = [
          ledgerWorktree('source', 'worktree'),
          ledgerWorktree('temp', suffixed ? 'worktree-2' : 'worktree'),
        ];
        if (failure === 'remove') {
          await expect(combine).rejects.toThrow('source row removal failed');
          expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
          // The recorded move never committed, so it is forgotten.
          expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual([move]);
        } else if (refused) {
          // Without a lasting mapping the combine does not commit: no row
          // changes, and the checkout goes back where it was.
          await expect(combine).rejects.toThrow(
            "Couldn't combine the projects. Try again.",
          );
          expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
          expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
          expect(mockedMoveWorktree).toHaveBeenLastCalledWith(
            '/repos/a',
            join(destinationRoot, 'repos', 'source'),
            sourceCheckout,
          );
          expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
          expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual([move]);
        } else if (failure === 'suffix') {
          await expect(combine).resolves.toMatchObject({
            destinationWorkspaceId: 'temp',
            destinationWorktreeId: 'worktree-2',
          });
          // Only the durable intent lets startup find the suffixed ID.
          expect(mockedRecordLedgerMoveIntent.mock.calls).toEqual([
            [...move, refusingWait],
          ]);
          expect(mockedNotifyLedgerContainerMoved.mock.calls).toEqual([move]);
        } else {
          await expect(combine).resolves.toMatchObject({
            destinationWorkspaceId: 'temp',
            removedSourceWorktree: true,
          });
          expect(mockedRecordLedgerMoveIntent).toHaveBeenCalledTimes(1);
          expect(mockedNotifyLedgerContainerMoved).toHaveBeenCalledTimes(1);
          expect(mockedDiscardLedgerMoveIntent).not.toHaveBeenCalled();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('preserves a single-repo source tracked base branch as a destination repo base branch', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-single-base-'));
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'temporary-worktree');
      await mkdir(sourceCheckout, { recursive: true });
      mockPathExistsFromDisk();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');

      let persistedDestinationWorktree: WorktreeData | undefined;
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          const next = await Promise.resolve(updater([]));
          persistedDestinationWorktree = next[0];
          return next;
        },
      );

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [
          makeWorktree({
            trackedBaseBranch: 'release/2.0',
            trackedRepoBaseBranches: { source: '   ' },
          }),
        ],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = {
        type: 'single-repo' as const,
        id: 'join',
        name: 'Repo B',
        color: '#654321',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'temp',
        name: 'Repo A & Repo B',
        temporary: true,
        repos: [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'join', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryWorkspace,
      );
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([temporaryWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(persistedDestinationWorktree?.trackedBaseBranch).toBe(
        'release/2.0',
      );
      expect(persistedDestinationWorktree?.trackedRepoBaseBranches).toEqual({
        source: 'release/2.0',
      });
      expect(result.destinationWorktree.trackedRepoBaseBranches).toEqual({
        source: 'release/2.0',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses a matching temporary project before creating another temporary project', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-temp-reuse-'));
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'existing-temp-worktree');
      await mkdir(sourceCheckout, { recursive: true });
      mockPathExistsFromDisk();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [
          makeWorktree({
            seenPipelineExecutionIds: ['source-exec', 'shared-exec'],
          }),
        ],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = {
        type: 'single-repo' as const,
        id: 'join',
        name: 'Repo B',
        color: '#654321',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'matching-temp',
        name: 'Repo A & Repo B',
        temporary: true,
        repos: [
          { id: 'source', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'join', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [
          makeWorktree({
            seenPipelineExecutionIds: ['existing-exec', 'shared-exec'],
          }),
        ],
        order: 2,
      });
      let persistedDestinationWorktree: WorktreeData | undefined;
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          const next = await Promise.resolve(
            updater(temporaryWorkspace.worktrees),
          );
          persistedDestinationWorktree = next.find(
            (worktree) => worktree.id === 'worktree',
          );
          return next;
        },
      );
      mockedListWorkspaceItems
        .mockResolvedValueOnce([
          sourceWorkspace,
          joinWorkspace,
          temporaryWorkspace,
        ])
        .mockResolvedValueOnce([
          sourceWorkspace,
          joinWorkspace,
          temporaryWorkspace,
        ])
        .mockResolvedValueOnce([temporaryWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        destinationWorkspaceId: 'matching-temp',
        createdTemporaryWorkspace: false,
        reusedWorkspace: true,
      });
      expect(persistedDestinationWorktree).toMatchObject({
        seenPipelineExecutionIds: [
          'existing-exec',
          'shared-exec',
          'source-exec',
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('moves single-repo source checkouts, remaps worktree data, and rewrites pipeline summaries during temporary combine', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-success-'));
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'destination-worktree');
      await mkdir(sourceCheckout, { recursive: true });
      const movedDestinationPaths = new Set<string>();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedPathExists.mockImplementation(async (candidatePath: string) => {
        if (candidatePath === sourceCheckout) {
          try {
            await lstat(sourceCheckout);
            return true;
          } catch {
            return false;
          }
        }
        if (candidatePath.startsWith(destinationRoot)) {
          return (
            candidatePath === destinationRoot ||
            movedDestinationPaths.has(candidatePath)
          );
        }
        return true;
      });
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
          movedDestinationPaths.add(newPath);
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          movedDestinationPaths.add(worktreePath);
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');
      mockedListExecutionSummaries.mockResolvedValue([
        {
          id: 'exec-1',
          pipeline_id: 'pipeline-1',
          pipeline_name: 'Pipeline 1',
          project_id: 'source',
          worktree_id: 'worktree',
          status: 'success',
          status_reasons: [],
          started_at: '2026-05-19T00:00:00.000Z',
          cwd: '/repos/source',
        },
      ]);
      mockedLoadExecutionState.mockResolvedValue({
        id: 'exec-1',
        project_id: 'source',
        worktree_id: 'worktree',
        cwd: join(sourceCheckout, 'subdir'),
        parent_execution_id: 'parent-1',
        rerun_source_id: 'rerun-1',
      } as Awaited<ReturnType<typeof loadExecutionState>>);

      let persistedDestinationWorktree: WorktreeData | undefined;
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          const next = await Promise.resolve(updater([]));
          persistedDestinationWorktree = next[0];
          return next;
        },
      );

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [
          {
            id: 'worktree',
            branchName: 'feature',
            createdAt: '2026-05-19T00:00:00.000Z',
            discovery: {
              slashCommands: [
                {
                  name: 'test-command',
                  description: 'Test command',
                },
              ],
              mcpServers: [
                {
                  name: 'test-server',
                  status: 'connected' as const,
                },
              ],
              discoveredAt: '2026-05-19T00:00:00.000Z',
              providerType: 'claude' as const,
            },
            branchPromptSent: true,
            hidden: true,
            pausedHookKeys: ['post-checkout:repo-a'],
            setupPhase: 'git-ready' as const,
            status: 'active' as const,
            healthIssue: {
              status: 'broken' as const,
              code: 'git-error' as const,
              message: 'Git status failed',
              checkedAt: '2026-05-19T00:00:00.000Z',
              worktreePath: sourceCheckout,
            },
            lastKnownPrStatus: {
              repos: [
                {
                  repoId: 'source',
                  repoName: 'Repo A',
                  status: null,
                },
              ],
              lastCheckedAt: '2026-05-19T00:00:00.000Z',
            },
            trackedBaseBranch: 'main',
            seenPipelineExecutionIds: ['exec-0'],
            trackedRepoBaseBranches: { source: 'main', stale: 'old' },
          },
        ],
        collapsed: false,
        order: 0,
      };
      const legacySetupWorktree = sourceWorkspace.worktrees[0];
      if (legacySetupWorktree === undefined) {
        throw new Error('Expected source worktree fixture');
      }
      // Preserve this legacy setup phase as the input to the normalization test.
      Reflect.set(legacySetupWorktree, 'setupPhase', 'setup-running');
      const destinationWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'join',
        name: 'Join',
        color: '#654321',
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, destinationWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, destinationWorkspace])
        .mockResolvedValueOnce([destinationWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(mockedMoveWorktree).toHaveBeenCalledWith(
        '/repos/a',
        sourceCheckout,
        join(destinationRoot, 'repos', 'repo-a'),
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/b',
        join(destinationRoot, 'repos', 'repo-b'),
        'feature',
      );
      expect(persistedDestinationWorktree).toMatchObject({
        id: 'worktree',
        branchName: 'feature',
        discovery: {
          slashCommands: [
            {
              name: 'test-command',
              description: 'Test command',
            },
          ],
          mcpServers: [
            {
              name: 'test-server',
              status: 'connected',
            },
          ],
          discoveredAt: '2026-05-19T00:00:00.000Z',
          providerType: 'claude',
        },
        branchPromptSent: true,
        setupPhase: 'git-ready',
        status: 'active',
        pausedHookKeys: ['post-checkout:repo-a'],
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: 'Git status failed',
          checkedAt: '2026-05-19T00:00:00.000Z',
          worktreePath: sourceCheckout,
        },
        lastKnownPrStatus: {
          repos: [
            {
              repoId: 'source',
              repoName: 'Repo A',
              status: null,
            },
          ],
          lastCheckedAt: '2026-05-19T00:00:00.000Z',
        },
        trackedBaseBranch: 'main',
        seenPipelineExecutionIds: ['exec-0'],
        trackedRepoBaseBranches: { 'repo-a': 'main' },
      });
      expect(persistedDestinationWorktree).not.toHaveProperty('hidden');
      expect(result.compatibilitySymlinks).toEqual([
        expect.objectContaining({
          path: sourceCheckout,
          targetPath: join(destinationRoot, 'repos', 'repo-a'),
          repoId: 'repo-a',
        }),
      ]);
      expect(mockedSaveExecutionState).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'exec-1',
          project_id: 'join',
          worktree_id: 'worktree',
          cwd: join(destinationRoot, 'repos', 'repo-a', 'subdir'),
          parent_execution_id: 'parent-1',
          rerun_source_id: 'rerun-1',
        }),
        '/mock/executions',
      );
      expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
        'source',
        expect.any(Function),
        undefined,
        undefined,
        {
          requireAuthoritativeRead: true,
          requireExistingList: true,
          markRemovedAfterWrite: true,
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('dedupes by remote, excludes project root repos, reuses a matching project, and creates a source-backed root symlink', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-source-root-'));
    try {
      const sourceRoot = join(tempDir, 'source-worktree');
      const destinationRoot = join(tempDir, 'join-worktree');
      const sourceRepoPath = join(tempDir, 'source-root-repo');
      await mkdir(join(sourceRoot, 'repos', 'repo-a'), { recursive: true });
      await mkdir(sourceRepoPath);
      mockPathExistsFromDisk();

      mockedGetRemoteUrl.mockImplementation((repoPath: string) => {
        if (repoPath === '/repos/a' || repoPath === '/mirror/a') {
          return Promise.resolve('git@github.com:canopy/repo-a.git');
        }
        return Promise.resolve(null);
      });
      mockedGetWorkspaceWorktreeDir.mockImplementation((workspaceId: string) =>
        workspaceId === 'source' ? sourceRoot : destinationRoot,
      );
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (workspaceId: string, _worktreeId: string, repoId: string) =>
          workspaceId === 'source'
            ? join(sourceRoot, 'repos', repoId)
            : join(destinationRoot, 'repos', repoId),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedSafeRemoveWorktree.mockImplementation(async () => {
        await rm(sourceRoot, { recursive: true, force: true });
      });
      mockedGetCurrentBranch.mockResolvedValue('feature');

      const sourceWorkspace = makeMultiRepoWorkspace({
        id: 'source',
        sourceRepoPath,
        repos: [
          {
            id: WORKSPACE_ROOT_REPO_ID,
            name: 'Workspace Root',
            repoPath: sourceRepoPath,
          },
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        ],
        worktrees: [makeWorktree()],
      });
      const joinWorkspace = makeMultiRepoWorkspace({
        id: 'join',
        repos: [
          {
            id: WORKSPACE_ROOT_REPO_ID,
            name: 'Workspace Root',
            repoPath: '/join/root',
          },
          { id: 'mirror-a', name: 'Repo A Mirror', repoPath: '/mirror/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
      });
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([joinWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(result).toMatchObject({
        destinationWorkspaceId: 'join',
        destinationWorktreeId: 'worktree',
        createdTemporaryWorkspace: false,
        reusedWorkspace: true,
      });
      expect(mockedCreateTemporaryMultiRepoWorkspace).not.toHaveBeenCalled();
      expect(
        result.repoMappings.map((mapping) => mapping.destinationRepoId),
      ).toEqual(['mirror-a', 'repo-b']);
      expect(
        result.repoMappings.some(
          (mapping) => mapping.destinationRepoId === WORKSPACE_ROOT_REPO_ID,
        ),
      ).toBe(false);
      expect(mockedMoveWorktree).toHaveBeenCalledWith(
        '/repos/a',
        join(sourceRoot, 'repos', 'repo-a'),
        join(destinationRoot, 'repos', 'mirror-a'),
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/b',
        join(destinationRoot, 'repos', 'repo-b'),
        'feature',
      );
      expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
        sourceRepoPath,
        sourceRoot,
        'adhoc-multi-repo source root cleanup',
      );
      expect(result.compatibilitySymlinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: sourceRoot,
            targetPath: destinationRoot,
            repoId: undefined,
          }),
        ]),
      );
      expect(result.filePathRewrites).toEqual(
        expect.arrayContaining([
          { fromRoot: sourceRoot, toRoot: destinationRoot },
        ]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cleans a local-only multi-repo source root, creates a root symlink, and soft deletes an empty temporary source project', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-local-root-'));
    try {
      const sourceRoot = join(tempDir, 'source-worktree');
      const destinationRoot = join(tempDir, 'join-worktree');
      await mkdir(join(sourceRoot, 'repos', 'repo-a'), { recursive: true });
      await writeFile(join(sourceRoot, 'CLAUDE.md'), '# instructions', 'utf8');
      await writeFile(join(sourceRoot, 'AGENTS.md'), '# instructions', 'utf8');
      mockPathExistsFromDisk();

      mockedGetWorkspaceWorktreeDir.mockImplementation((workspaceId: string) =>
        workspaceId === 'source' ? sourceRoot : destinationRoot,
      );
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (workspaceId: string, _worktreeId: string, repoId: string) =>
          workspaceId === 'source'
            ? join(sourceRoot, 'repos', repoId)
            : join(destinationRoot, 'repos', repoId),
      );
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return 'feature';
        },
      );
      mockedGetCurrentBranch.mockResolvedValue('feature');
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
        temporary: true,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([]);

      const sourceWorkspace = makeMultiRepoWorkspace({
        id: 'source',
        temporary: true,
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
        worktrees: [makeWorktree()],
      });
      const joinWorkspace = makeMultiRepoWorkspace({
        id: 'join',
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
      });
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [sourceWorkspace, joinWorkspace],
      });
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
        .mockResolvedValueOnce([joinWorkspace]);

      const result = await combineWorktreeWithWorkspace({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      });

      expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
      expect(result.compatibilitySymlinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: sourceRoot,
            targetPath: destinationRoot,
            repoId: undefined,
          }),
        ]),
      );
      expect(result.filePathRewrites).toEqual(
        expect.arrayContaining([
          { fromRoot: sourceRoot, toRoot: destinationRoot },
        ]),
      );
      expect(result.removedTemporaryWorkspaceId).toBe('source');
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('restores the source root before moving source checkouts back when temporary combine rollback runs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canopy-adhoc-rollback-'));
    try {
      const sourceRoot = join(tempDir, 'source-worktree');
      const destinationRoot = join(tempDir, 'destination-worktree');
      const sourceRepoPath = join(tempDir, 'source-root-repo');
      await mkdir(join(sourceRoot, 'repos', 'repo-a'), { recursive: true });
      await mkdir(sourceRepoPath);
      const destinationWorktreeRoot = `${destinationRoot}-worktree`;
      const movedDestinationPaths = new Set<string>();

      mockedGetWorkspaceWorktreeDir.mockImplementation(
        (workspaceId: string, worktreeId: string) =>
          workspaceId === 'source'
            ? sourceRoot
            : `${destinationRoot}-${worktreeId}`,
      );
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (workspaceId: string, worktreeId: string, repoId: string) =>
          workspaceId === 'source'
            ? join(sourceRoot, 'repos', repoId)
            : join(`${destinationRoot}-${worktreeId}`, 'repos', repoId),
      );
      mockedPathExists.mockImplementation(async (candidatePath: string) => {
        if (candidatePath.startsWith(sourceRoot)) {
          try {
            await lstat(candidatePath);
            return true;
          } catch {
            return false;
          }
        }
        if (candidatePath === destinationWorktreeRoot) {
          return true;
        }
        if (candidatePath.startsWith(destinationWorktreeRoot)) {
          return movedDestinationPaths.has(candidatePath);
        }
        return true;
      });
      mockedMoveWorktree.mockImplementation((_repoPath, _oldPath, newPath) => {
        movedDestinationPaths.add(newPath);
        return Promise.resolve();
      });
      mockedSafeRemoveWorktree.mockImplementation(async () => {
        await rm(sourceRoot, { recursive: true, force: true });
      });
      mockedGetCurrentBranch.mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath === sourceRoot ? 'root-branch' : 'feature'),
      );
      const createImplementation = async (
        repoPath: string,
      ): Promise<string> => {
        if (repoPath === sourceRepoPath) {
          await mkdir(sourceRoot, { recursive: true });
        }
        return 'main';
      };
      mockedCreateWorktree.mockImplementation(createImplementation);
      mockedRestoreCreateWorktree.mockImplementation(createImplementation);
      const originalPipelineState = {
        id: 'exec-rollback',
        project_id: 'source',
        worktree_id: 'worktree',
        cwd: join(sourceRoot, 'repos', 'repo-a', 'task'),
      } as Awaited<ReturnType<typeof loadExecutionState>>;
      mockedListExecutionSummaries.mockResolvedValue([
        {
          id: 'exec-rollback',
          pipeline_id: 'pipeline-1',
          pipeline_name: 'Pipeline 1',
          project_id: 'source',
          worktree_id: 'worktree',
          status: 'success',
          status_reasons: [],
          started_at: '2026-05-19T00:00:00.000Z',
          cwd: '/repos/source',
        },
      ]);
      mockedLoadExecutionState.mockResolvedValue(originalPipelineState);
      mockedUpdateWorkspaceWorktrees.mockRejectedValue(
        new Error('persist failed'),
      );

      const sourceWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'source',
        name: 'Source',
        color: '#123456',
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
        worktrees: [
          {
            id: 'worktree',
            branchName: 'feature',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
        ],
        collapsed: false,
        order: 0,
        sourceRepoPath,
      };
      const destinationWorkspace: MultiRepoSidebarItem = {
        type: 'multi-repo',
        id: 'destination',
        name: 'Destination',
        color: '#654321',
        repos: sourceWorkspace.repos,
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      destinationWorkspace.repos = [
        ...sourceWorkspace.repos,
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
      ];
      mockedListWorkspaceItems
        .mockResolvedValueOnce([sourceWorkspace, destinationWorkspace])
        .mockResolvedValueOnce([sourceWorkspace, destinationWorkspace]);

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'destination',
          mode: 'temporary',
        }),
      ).rejects.toThrow('persist failed');

      expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
        sourceRepoPath,
        sourceRoot,
        'adhoc-multi-repo source root cleanup',
      );
      expect(mockedRestoreCreateWorktree).toHaveBeenCalledWith(
        sourceRepoPath,
        sourceRoot,
        'root-branch',
      );
      expect(mockedMoveWorktree).toHaveBeenCalledWith(
        '/repos/a',
        join(`${destinationRoot}-worktree`, 'repos', 'repo-a'),
        join(sourceRoot, 'repos', 'repo-a'),
      );
      expect(mockedSaveExecutionState).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 'exec-rollback',
          project_id: 'destination',
          worktree_id: 'worktree',
          cwd: join(`${destinationRoot}-worktree`, 'repos', 'repo-a', 'task'),
        }),
        '/mock/executions',
      );
      expect(mockedSaveExecutionState).toHaveBeenNthCalledWith(
        2,
        originalPipelineState,
        '/mock/executions',
      );
      expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('bypasses empty temporary preservation when rollback removes a newly created temporary project', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'canopy-adhoc-temp-rollback-'),
    );
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'temp-worktree');
      await mkdir(sourceCheckout, { recursive: true });
      const movedDestinationPaths = new Set<string>();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedPathExists.mockImplementation(async (candidatePath: string) => {
        if (candidatePath === sourceCheckout) {
          try {
            await lstat(sourceCheckout);
            return true;
          } catch {
            return false;
          }
        }
        if (candidatePath.startsWith(destinationRoot)) {
          return (
            candidatePath === destinationRoot ||
            movedDestinationPaths.has(candidatePath)
          );
        }
        return true;
      });
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
          movedDestinationPaths.add(newPath);
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          movedDestinationPaths.add(worktreePath);
          return 'feature';
        },
      );
      mockedUpdateWorkspaceWorktrees.mockRejectedValue(
        new Error('persist failed'),
      );

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = {
        type: 'single-repo' as const,
        id: 'join',
        name: 'Repo B',
        color: '#654321',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'temp-workspace',
        temporary: true,
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
        order: 2,
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryWorkspace,
      );
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [sourceWorkspace, joinWorkspace, temporaryWorkspace],
      });
      mockedListWorkspaceItems.mockResolvedValue([
        sourceWorkspace,
        joinWorkspace,
      ]);

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'temporary',
        }),
      ).rejects.toThrow('persist failed');

      expect(removeWorkspaceIndexEntry).toHaveBeenCalledWith('temp-workspace');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the destination when something recreates the source checkout path mid-combine', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'canopy-adhoc-recreated-source-'),
    );
    try {
      const sourceCheckout = join(tempDir, 'source-checkout');
      const destinationRoot = join(tempDir, 'temp-worktree');
      const movedCheckout = join(destinationRoot, 'repos', 'repo-a');
      await mkdir(sourceCheckout, { recursive: true });
      const movedDestinationPaths = new Set<string>();

      mockedGetWorktreeDir.mockReturnValue(sourceCheckout);
      mockedGetWorkspaceWorktreeDir.mockReturnValue(destinationRoot);
      mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
        (_workspaceId: string, _worktreeId: string, repoId: string) =>
          join(destinationRoot, 'repos', repoId),
      );
      mockedPathExists.mockImplementation(async (candidatePath: string) => {
        if (candidatePath === sourceCheckout) {
          try {
            await lstat(sourceCheckout);
            return true;
          } catch {
            return false;
          }
        }
        if (candidatePath.startsWith(destinationRoot)) {
          return (
            candidatePath === destinationRoot ||
            movedDestinationPaths.has(candidatePath)
          );
        }
        return true;
      });
      mockedMoveWorktree.mockImplementation(
        async (_repoPath, oldPath, newPath) => {
          await rm(oldPath, { recursive: true, force: true });
          await mkdir(newPath, { recursive: true });
          movedDestinationPaths.add(newPath);
          // A still-running setup script writes build output to the old path.
          await mkdir(join(oldPath, 'apps', '.build'), { recursive: true });
        },
      );
      mockedCreateWorktree.mockImplementation(
        async (_repoPath, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          movedDestinationPaths.add(worktreePath);
          return 'feature';
        },
      );

      const sourceWorkspace = {
        type: 'single-repo' as const,
        id: 'source',
        name: 'Repo A',
        color: '#123456',
        repoPath: '/repos/a',
        worktrees: [makeWorktree()],
        collapsed: false,
        order: 0,
      };
      const joinWorkspace = {
        type: 'single-repo' as const,
        id: 'join',
        name: 'Repo B',
        color: '#654321',
        repoPath: '/repos/b',
        worktrees: [],
        collapsed: false,
        order: 1,
      };
      const temporaryWorkspace = makeMultiRepoWorkspace({
        id: 'temp-workspace',
        temporary: true,
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
        order: 2,
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryWorkspace,
      );
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [sourceWorkspace, joinWorkspace, temporaryWorkspace],
      });
      mockedListWorkspaceItems.mockResolvedValue([
        sourceWorkspace,
        joinWorkspace,
      ]);

      await expect(
        combineWorktreeWithWorkspace({
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          mode: 'temporary',
        }),
      ).rejects.toThrow(
        'Add repo failed and rollback did not fully restore source checkouts',
      );

      expect(removeWorkspaceIndexEntry).not.toHaveBeenCalled();
      await expect(lstat(movedCheckout)).resolves.toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate repo selection only after the sibling identity read settles', async () => {
    let releaseIdentity: ((url: string | null) => void) | undefined;
    mockedGetRemoteUrl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseIdentity = resolve;
        }),
    );
    const settled = jest.fn();
    const result = createOrReuseTemporaryWorkspaceFromRepos([
      { path: '/repos/alpha', name: 'Alpha' },
      { path: '/repos/alpha', name: 'Alpha again' },
    ]).finally(settled);
    result.catch(() => undefined);
    await new Promise((done) => setImmediate(done));
    expect(releaseIdentity).toBeDefined();
    expect(settled).not.toHaveBeenCalled();
    releaseIdentity?.(null);
    await expect(result).rejects.toThrow('was selected more than once');
  });
});
