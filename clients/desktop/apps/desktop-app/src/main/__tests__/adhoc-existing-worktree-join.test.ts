import type * as CompositionRecords from '../lib/workspace-composition-records';
import {
  restoreCompositionWorktrees,
  undoCompositionSource,
  undoCompositionRepositories,
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
import { dirname } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type AdhocJoinedWorktreeMigration,
  type MultiRepoSidebarItem,
  type SingleRepoSidebarItem,
  type WorktreeData,
  type WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/node/pipelines/executor/types';

jest.mock('node:fs/promises');
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
  createWorktree: jest.fn(),
  createWorktreeAvoidingCheckedOutBranch: jest.fn(),
  getCurrentBranch: jest.fn(() => Promise.resolve('main')),
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
  getWorktreeTopLevel: jest.fn(),
  hasCommitsAhead: jest.fn(() => Promise.resolve(false)),
  hasUncommittedChanges: jest.fn(() => Promise.resolve(false)),
  moveWorktree: jest.fn(),
  removeWorktree: jest.fn(),
}));
jest.mock('../lib/fs-utils', () => ({
  pathExists: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceConfigPath: (id: string): string =>
    `/mock/workspaces/${id}/workspace.json`,
  getWorkspaceWorktreesFilePath: (id: string): string =>
    `/mock/workspaces/${id}/worktrees.json`,
  getWorkspaceIndexFilePath: (): string => '/mock/workspaces/index.json',
  getArchivedContainersRootDir: jest.fn(
    (workspaceId: string) =>
      `/mock/workspaces/${workspaceId}/archived-containers`,
  ),
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
jest.mock('../lib/instruction-files', () => ({
  ensureAgentsMdSymlink: jest.fn(),
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
  restoreWorkspaceWorktrees: jest.fn(),
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
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));
jest.mock('../ledger/lifecycle', () => ({
  discardLedgerMoveIntent: jest.fn(),
  LEDGER_INTENT_REFUSING_WAIT_MS: 5_000,
  notifyLedgerContainerMoved: jest.fn(),
  recordLedgerMoveIntent: jest.fn(() => Promise.resolve('recorded')),
}));

import {
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  combineWorktreeWithExistingWorktree,
  listExistingWorktreeJoinOptions,
} from '../lib/adhoc-existing-worktree-join';
import { getActiveChatIds } from '../agents/session-manager';
import { pathExists } from '../lib/fs-utils';
import {
  createWorktree,
  getCurrentBranch,
  getRemoteUrl,
  getWorktreeTopLevel,
  hasCommitsAhead,
  hasUncommittedChanges,
  moveWorktree,
} from '../lib/git';
import { safeRemoveWorktree } from '../lib/safe-remove-worktree';
import {
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { validateId } from '../lib/validation';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
  writeWorkspaceConfig,
} from '../lib/workspace-persistence';
import { addRepoCheckoutToWorktree } from '../lib/workspace-repo-mutators';
import {
  addWorkspaceRepository,
  type WorkspaceRepositoryAddRequest,
  type WorkspaceRepositoryCandidate,
} from '../lib/workspace-repositories';
import {
  createTemporaryMultiRepoWorkspace,
  listWorkspaceItems,
} from '../lib/workspace-service';
import { listExecutionSummaries } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import {
  discardLedgerMoveIntent,
  LEDGER_INTENT_REFUSING_WAIT_MS,
  notifyLedgerContainerMoved,
  recordLedgerMoveIntent,
} from '../ledger/lifecycle';

const mockedFsLstat = jest.mocked(lstat);
const mockedFsMkdir = jest.mocked(mkdir);
const mockedFsReaddir = jest.mocked(readdir);
const mockedFsReadlink = jest.mocked(readlink);
const mockedFsRealpath = jest.mocked(realpath);
const mockedFsRm = jest.mocked(rm);
const mockedFsSymlink = jest.mocked(symlink);
const mockedFsWriteFile = jest.mocked(writeFile);
const mockedGetActiveChatIds = jest.mocked(getActiveChatIds);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetWorktreeTopLevel = jest.mocked(getWorktreeTopLevel);
const mockedHasCommitsAhead = jest.mocked(hasCommitsAhead);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedMoveWorktree = jest.mocked(moveWorktree);
const mockedPathExists = jest.mocked(pathExists);
const mockedSafeRemoveWorktree = jest.mocked(safeRemoveWorktree);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedRestoreCompositionWorktrees = jest.mocked(
  restoreCompositionWorktrees,
);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
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
const mockedCreateTemporaryMultiRepoWorkspace = jest.mocked(
  createTemporaryMultiRepoWorkspace,
);
const mockedListExecutionSummaries = jest.mocked(listExecutionSummaries);
const mockedListWorkspaceItems = jest.mocked(listWorkspaceItems);
const mockedValidateId = jest.mocked(validateId);
const mockedNotifyLedgerContainerMoved = jest.mocked(
  notifyLedgerContainerMoved,
);
const mockedRecordLedgerMoveIntent = jest.mocked(recordLedgerMoveIntent);
const mockedDiscardLedgerMoveIntent = jest.mocked(discardLedgerMoveIntent);

/** How a host that refuses without the mapping waits on its write. */
const refusingWait = { waitMs: LEDGER_INTENT_REFUSING_WAIT_MS };

/** A code worktree's Ledger incarnation, as the move participant takes it. */
function worktreeIncarnation(
  workspaceId: string,
  worktreeId: string,
  containerCreatedAt = '2026-06-12T00:00:00.000Z',
): Parameters<typeof notifyLedgerContainerMoved>[0] {
  return {
    container: { kind: 'code_worktree', workspaceId, worktreeId },
    containerCreatedAt,
  };
}

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: 'worktree',
    branchName: 'feature',
    createdAt: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeSingleRepoWorkspace(
  overrides: Partial<SingleRepoSidebarItem> & { id: string },
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    name: overrides.id,
    repoPath: `/repos/${overrides.id}`,
    color: '#123456',
    worktrees: [makeWorktree()],
    collapsed: false,
    order: 0,
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

function makeExecutionSummary(
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_name: 'Pipeline 1',
    status: 'running',
    started_at: '2026-06-12T00:00:00.000Z',
    cwd: '/mock/cwd',
    ...overrides,
  };
}

describe('listExistingWorktreeJoinOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetActiveChatIds.mockReturnValue([]);
    mockedListExecutionSummaries.mockResolvedValue([]);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasCommitsAhead.mockResolvedValue(false);
    mockedGetCurrentBranch.mockResolvedValue('main');
  });

  it('excludes the source project and groups candidates by project', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({
        id: 'other-ws',
        repoPath: '/repos/source-ws',
        worktrees: [makeWorktree({ id: 'wt-1', branchName: 'fix-bug' })],
      }),
      makeSingleRepoWorkspace({ id: 'empty-ws', worktrees: [] }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(mockedValidateId).toHaveBeenCalledWith(
      'source-ws',
      'sourceWorkspaceId',
    );
    expect(mockedValidateId).toHaveBeenCalledWith(
      'worktree',
      'sourceWorktreeId',
    );
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      workspaceId: 'other-ws',
      workspaceName: 'other-ws',
      color: '#123456',
      isMultiRepo: false,
      temporary: false,
    });
    expect(response.groups[0].candidates).toEqual([
      expect.objectContaining({
        workspaceId: 'other-ws',
        worktreeId: 'wt-1',
        branchName: 'fix-bug',
        repoOverlaps: [
          expect.objectContaining({
            sourceHasChanges: false,
            targetHasChanges: false,
          }),
        ],
      }),
    ]);
  });

  it('sorts project groups by sidebar order', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({ id: 'later-ws', order: 5 }),
      makeSingleRepoWorkspace({ id: 'earlier-ws', order: 1 }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups.map((group) => group.workspaceId)).toEqual([
      'earlier-ws',
      'later-ws',
    ]);
  });

  it('marks worktrees with active chats as busy and skips their git checks', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({
        id: 'other-ws',
        repoPath: '/repos/source-ws',
      }),
    ]);
    mockedGetActiveChatIds.mockImplementation((workspaceId: string) =>
      workspaceId === 'other-ws' ? ['chat-1'] : [],
    );

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups).toHaveLength(1);
    expect(response.groups[0].candidates).toEqual([
      expect.objectContaining({
        workspaceId: 'other-ws',
        worktreeId: 'worktree',
        busyReason: 'active-chat',
        repoOverlaps: [],
      }),
    ]);
    expect(mockedHasUncommittedChanges).not.toHaveBeenCalledWith(
      '/mock/workspaces/other-ws/worktrees/worktree',
    );
    expect(mockedHasCommitsAhead).not.toHaveBeenCalledWith(
      '/mock/workspaces/other-ws/worktrees/worktree',
      undefined,
    );
  });

  it('marks worktrees with running pipeline executions as busy', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({ id: 'other-ws' }),
    ]);
    mockedListExecutionSummaries.mockResolvedValue([
      makeExecutionSummary({
        project_id: 'other-ws',
        worktree_id: 'worktree',
        status: 'running',
      }),
      makeExecutionSummary({
        id: 'exec-2',
        project_id: 'other-ws',
        worktree_id: 'unrelated-worktree',
        status: 'running',
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups[0].candidates).toEqual([
      expect.objectContaining({
        worktreeId: 'worktree',
        busyReason: 'running-pipeline',
        repoOverlaps: [],
      }),
    ]);
  });

  it('does not mark worktrees busy for completed pipeline executions', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({ id: 'other-ws' }),
    ]);
    mockedListExecutionSummaries.mockResolvedValue([
      makeExecutionSummary({
        project_id: 'other-ws',
        worktree_id: 'worktree',
        status: 'completed',
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups[0].candidates[0].busyReason).toBeUndefined();
  });

  it('marks setup-pending and health-issue worktrees as busy', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({
        id: 'other-ws',
        worktrees: [
          makeWorktree({ id: 'wt-pending', setupPhase: 'git-pending' }),
          makeWorktree({
            id: 'wt-broken',
            healthIssue: {
              status: 'broken',
              code: 'missing-worktree-path',
              message: 'Worktree path is missing',
              checkedAt: '2026-06-12T00:00:00.000Z',
              worktreePath: '/mock/workspaces/other-ws/worktrees/wt-broken',
            },
          }),
        ],
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups).toHaveLength(1);
    expect(
      response.groups[0].candidates.map((candidate) => candidate.busyReason),
    ).toEqual(['setup-pending', 'health-issue']);
    expect(
      response.groups[0].candidates.map((candidate) => candidate.repoOverlaps),
    ).toEqual([[], []]);
  });

  it('reports per-repo overlap dirtiness for both sides', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeMultiRepoWorkspace({
        id: 'source-ws',
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        ],
        worktrees: [makeWorktree({ id: 'src-wt' })],
      }),
      makeSingleRepoWorkspace({
        id: 'app-ws',
        repoPath: '/repos/app',
        worktrees: [makeWorktree({ id: 'join-wt', branchName: 'other' })],
      }),
    ]);
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(
        checkoutPath ===
          '/mock/workspaces/source-ws/worktrees/src-wt/repos/app',
      ),
    );
    mockedGetCurrentBranch.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath.includes('join-wt') ? 'other' : 'feature'),
    );

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
    });

    expect(response.groups).toHaveLength(1);
    expect(response.groups[0].candidates[0].repoOverlaps).toEqual([
      {
        repoName: 'app-ws',
        sourceHasChanges: true,
        targetHasChanges: false,
        sourceBranch: 'feature',
        targetBranch: 'other',
      },
    ]);
  });

  it('reports addsNewRepo false for a clean subset of the source', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeMultiRepoWorkspace({
        id: 'source-ws',
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        ],
        worktrees: [makeWorktree({ id: 'src-wt' })],
      }),
      makeSingleRepoWorkspace({
        id: 'app-ws',
        repoPath: '/repos/app',
        worktrees: [makeWorktree({ id: 'join-wt', branchName: 'other' })],
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
    });

    expect(response.groups[0].candidates[0].addsNewRepo).toBe(false);
  });

  it('reports addsNewRepo true for a candidate with a non-overlapping repo', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeMultiRepoWorkspace({
        id: 'source-ws',
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        ],
        worktrees: [makeWorktree({ id: 'src-wt' })],
      }),
      makeSingleRepoWorkspace({
        id: 'tool-ws',
        repoPath: '/repos/tool',
        worktrees: [makeWorktree({ id: 'join-wt', branchName: 'other' })],
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
    });

    expect(response.groups[0].candidates[0].addsNewRepo).toBe(true);
    expect(response.groups[0].candidates[0].repoOverlaps).toEqual([]);
  });

  it('flags temporary multi-repo groups and reports empty overlaps for disjoint repos', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeMultiRepoWorkspace({
        id: 'temp-ws',
        temporary: true,
        repos: [
          { id: 'unrelated', name: 'Unrelated', repoPath: '/repos/unrelated' },
        ],
        worktrees: [makeWorktree({ id: 'join-wt' })],
      }),
    ]);

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      workspaceId: 'temp-ws',
      isMultiRepo: true,
      temporary: true,
    });
    // Non-busy candidate with no repo overlap against the source: empty list.
    expect(response.groups[0].candidates[0].busyReason).toBeUndefined();
    expect(response.groups[0].candidates[0].repoOverlaps).toEqual([]);
  });

  it('treats commits ahead of base as changes', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
      makeSingleRepoWorkspace({
        id: 'other-ws',
        repoPath: '/repos/source-ws',
        worktrees: [makeWorktree({ id: 'join-wt' })],
      }),
    ]);
    mockedHasCommitsAhead.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath.includes('join-wt')),
    );

    const response = await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'worktree',
    });

    expect(response.groups[0].candidates[0].repoOverlaps).toEqual([
      expect.objectContaining({
        sourceHasChanges: false,
        targetHasChanges: true,
      }),
    ]);
  });

  it('uses tracked base branches when checking commits ahead', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeMultiRepoWorkspace({
        id: 'source-ws',
        repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
        worktrees: [
          makeWorktree({
            id: 'src-wt',
            trackedRepoBaseBranches: { app: 'release/1.0' },
          }),
        ],
      }),
      makeSingleRepoWorkspace({
        id: 'app-ws',
        repoPath: '/repos/app',
        worktrees: [
          makeWorktree({ id: 'join-wt', trackedBaseBranch: 'develop' }),
        ],
      }),
    ]);

    await listExistingWorktreeJoinOptions({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
    });

    expect(mockedHasCommitsAhead).toHaveBeenCalledWith(
      '/mock/workspaces/source-ws/worktrees/src-wt/repos/app',
      'release/1.0',
    );
    expect(mockedHasCommitsAhead).toHaveBeenCalledWith(
      '/mock/workspaces/app-ws/worktrees/join-wt',
      'develop',
    );
  });

  it('throws when the source project is missing', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'other-ws' }),
    ]);

    await expect(
      listExistingWorktreeJoinOptions({
        sourceWorkspaceId: 'missing-ws',
        sourceWorktreeId: 'worktree',
      }),
    ).rejects.toThrow('Project missing-ws not found');
  });

  it('throws when the source worktree is missing', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      makeSingleRepoWorkspace({ id: 'source-ws' }),
    ]);

    await expect(
      listExistingWorktreeJoinOptions({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'missing-wt',
      }),
    ).rejects.toThrow('Worktree missing-wt not found');
  });
});

// Shared combine fixture: source-ws is a multi-repo workspace with repos
// {app, lib} and worktree 'src-wt'; join-ws is a single-repo workspace
// whose repoPath is either /repos/app (full overlap on app) or
// /repos/tool (no overlap), with worktree 'join-wt'.
const SOURCE_ROOT = '/mock/workspaces/source-ws/worktrees/src-wt';
const SOURCE_APP_CHECKOUT = `${SOURCE_ROOT}/repos/app`;
const SOURCE_LIB_CHECKOUT = `${SOURCE_ROOT}/repos/lib`;
const JOIN_CHECKOUT = '/mock/workspaces/join-ws/worktrees/join-wt';
// Full-overlap joins reuse source-ws as the destination workspace (its
// repo identity set matches), so the destination worktree id is allocated
// past the existing 'src-wt' row.
const OVERLAP_DEST_ROOT = '/mock/workspaces/source-ws/worktrees/src-wt-2';
const TEMP_DEST_ROOT = '/mock/workspaces/temp-dest/worktrees/src-wt';

// Virtual filesystem backing the pathExists / move / remove mocks.
let existingPaths: Set<string>;

function addPathWithAncestors(candidatePath: string): void {
  let current = candidatePath;
  while (current && current !== '/') {
    existingPaths.add(current);
    current = dirname(current);
  }
}

function removePathTree(candidatePath: string): void {
  for (const entry of Array.from(existingPaths)) {
    if (entry === candidatePath || entry.startsWith(`${candidatePath}/`)) {
      existingPaths.delete(entry);
    }
  }
}

function makeJoinFixture(joinRepoPath: string): {
  sourceWorkspace: MultiRepoSidebarItem;
  joinWorkspace: SingleRepoSidebarItem;
} {
  const sourceWorkspace = makeMultiRepoWorkspace({
    id: 'source-ws',
    repos: [
      { id: 'app', name: 'App', repoPath: '/repos/app' },
      { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
    ],
    worktrees: [makeWorktree({ id: 'src-wt' })],
  });
  const joinWorkspace = makeSingleRepoWorkspace({
    id: 'join-ws',
    repoPath: joinRepoPath,
    worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
  });
  return { sourceWorkspace, joinWorkspace };
}

function setupCombineFixtureMocks(): void {
  existingPaths = new Set();
  addPathWithAncestors(SOURCE_APP_CHECKOUT);
  addPathWithAncestors(SOURCE_LIB_CHECKOUT);
  addPathWithAncestors(JOIN_CHECKOUT);

  mockedGetActiveChatIds.mockReturnValue([]);
  mockedListExecutionSummaries.mockResolvedValue([]);
  mockedHasUncommittedChanges.mockResolvedValue(false);
  mockedHasCommitsAhead.mockResolvedValue(false);
  mockedGetCurrentBranch.mockResolvedValue('main');
  mockedGetRemoteUrl.mockResolvedValue(null);
  mockedGetWorktreeTopLevel.mockImplementation((worktreePath: string) =>
    Promise.resolve(worktreePath),
  );
  mockedPathExists.mockImplementation((candidatePath: string) =>
    Promise.resolve(existingPaths.has(candidatePath)),
  );
  mockedMoveWorktree.mockImplementation((_repoPath, oldPath, newPath) => {
    removePathTree(oldPath);
    addPathWithAncestors(newPath);
    return Promise.resolve();
  });
  mockedCreateWorktree.mockImplementation((_repoPath, worktreePath) => {
    addPathWithAncestors(worktreePath);
    return Promise.resolve('main');
  });
  mockedSafeRemoveWorktree.mockImplementation((_repoPath, worktreePath) => {
    removePathTree(worktreePath);
    return Promise.resolve();
  });
  mockedFsLstat.mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
  mockedFsMkdir.mockImplementation((dirPath) => {
    addPathWithAncestors(String(dirPath));
    return Promise.resolve(undefined);
  });
  mockedFsReaddir.mockResolvedValue([]);
  mockedFsReadlink.mockRejectedValue(
    Object.assign(new Error('EINVAL'), { code: 'EINVAL' }),
  );
  mockedFsRealpath.mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
  mockedFsRm.mockImplementation((rmPath) => {
    removePathTree(String(rmPath));
    return Promise.resolve();
  });
  mockedFsSymlink.mockImplementation((_target, linkPath) => {
    addPathWithAncestors(String(linkPath));
    return Promise.resolve();
  });
  mockedFsWriteFile.mockResolvedValue(undefined);
  mockedReadWorkspaceConfig.mockResolvedValue({
    version: 1,
    type: 'multi-repo',
    repos: [],
  });
  mockedWriteWorkspaceConfig.mockResolvedValue(undefined);
  mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
    Promise.resolve(
      workspaceId === 'source-ws' ? [makeWorktree({ id: 'src-wt' })] : [],
    ),
  );
  mockedRemoveWorkspaceWorktrees.mockImplementation(
    async (workspaceId, predicate) =>
      (await mockedReadWorkspaceWorktrees(workspaceId)).filter(predicate),
  );
  mockedRestoreCompositionWorktrees.mockResolvedValue(undefined);
  mockedUpdateWorkspaceWorktrees.mockImplementation(
    async (workspaceId, updater) =>
      Promise.resolve(
        updater(
          workspaceId === 'source-ws' ? [makeWorktree({ id: 'src-wt' })] : [],
        ),
      ),
  );
  mockedCreateTemporaryMultiRepoWorkspace.mockRejectedValue(
    new Error('unexpected temporary project creation'),
  );
}

describe('combineWorktreeWithExistingWorktree (temporary)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupCombineFixtureMocks();
  });

  it('moves the joined worktree checkout in when only the target is dirty', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    sourceWorkspace.worktrees = [
      makeWorktree({
        id: 'src-wt',
        trackedRepoBaseBranches: { app: 'source-base' },
      }),
    ];
    joinWorkspace.worktrees = [
      makeWorktree({
        id: 'join-wt',
        branchName: 'join-feature',
        trackedRepoBaseBranches: { 'join-ws': 'target-base' },
      }),
    ];
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    // The dirty target checkout wins the overlap and moves into the
    // destination; the clean source checkout is removed.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      JOIN_CHECKOUT,
      `${OVERLAP_DEST_ROOT}/repos/app`,
    );
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      'adhoc existing-worktree join overlap cleanup',
    );
    // Non-overlapping source repo moves from the source side.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/lib',
      SOURCE_LIB_CHECKOUT,
      `${OVERLAP_DEST_ROOT}/repos/lib`,
    );
    // Exactly one mover per destination repo and no fresh checkouts.
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(2);
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(response.destinationWorktreeId).toBe('src-wt-2');
    expect(response.destinationWorktree.trackedRepoBaseBranches).toEqual({
      app: 'target-base',
    });
  });

  it('keeps source tracked base branches when a clean target overlap is discarded', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
      ],
      worktrees: [
        makeWorktree({
          id: 'src-wt',
          trackedRepoBaseBranches: { app: 'source-base' },
        }),
      ],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [
        makeWorktree({
          id: 'join-wt',
          branchName: 'join-feature',
          trackedRepoBaseBranches: {
            app: 'discarded-target-base',
            tool: 'target-tool-base',
          },
        }),
      ],
    });
    const joinAppCheckout = `${JOIN_CHECKOUT}/repos/app`;
    const joinToolCheckout = `${JOIN_CHECKOUT}/repos/tool`;
    addPathWithAncestors(joinAppCheckout);
    addPathWithAncestors(joinToolCheckout);
    sourceWorkspace.worktrees = [
      makeWorktree({
        id: 'src-wt',
        trackedRepoBaseBranches: { app: 'source-base' },
      }),
    ];
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      makeMultiRepoWorkspace({
        id: 'temp-dest',
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
          { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
        ],
        worktrees: [],
        temporary: true,
      }),
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      joinAppCheckout,
      'adhoc existing-worktree join overlap cleanup',
    );
    expect(response.destinationWorktree.trackedRepoBaseBranches).toEqual({
      app: 'source-base',
      tool: 'target-tool-base',
    });
  });

  it('uses the target repo root for destination metadata when a target overlap wins', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/mirror/app');
    mockedGetRemoteUrl.mockImplementation((repoPath: string) =>
      Promise.resolve(
        repoPath === '/repos/app' || repoPath === '/mirror/app'
          ? 'git@github.com:acme/app.git'
          : null,
      ),
    );
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      makeMultiRepoWorkspace({
        id: 'temp-dest',
        repos: [
          { id: 'join-ws', name: 'join-ws', repoPath: '/mirror/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        ],
        worktrees: [],
        temporary: true,
      }),
    );
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    expect(response.destinationWorkspace.repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'join-ws', repoPath: '/mirror/app' }),
      ]),
    );
    expect(response.joinedWorktree.repoMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationRepoId: 'join-ws',
          repoPath: '/mirror/app',
          oldWorktreePath: JOIN_CHECKOUT,
          newWorktreePath: `${TEMP_DEST_ROOT}/repos/join-ws`,
        }),
      ]),
    );
  });

  it('rejects source-backed roots with unpublished root-level changes before consuming checkouts', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    const sourceBackedWorkspace: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      sourceRepoPath: '/repos/workspace-root',
      repos: [
        {
          id: WORKSPACE_ROOT_REPO_ID,
          name: 'Workspace Root',
          repoPath: '/repos/workspace-root',
        },
        ...sourceWorkspace.repos,
      ],
    };
    mockedListWorkspaceItems.mockResolvedValue([
      sourceBackedWorkspace,
      joinWorkspace,
    ]);
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === SOURCE_ROOT),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow(/project root has uncommitted changes/);

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects when checkout status cannot be determined before removing overlaps', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      checkoutPath === JOIN_CHECKOUT
        ? Promise.reject(new Error('status failed'))
        : Promise.resolve(false),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow('status failed');

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('removes the clean target overlap checkout while absorbing a new repo when the source is dirty', async () => {
    // Multi-repo join {app, tool}: app overlaps the source app (source dirty
    // wins -> the clean target app checkout is removed), tool is a new repo
    // (added + moved in). The union {app, lib, tool} does not match the source
    // workspace, so a temporary destination workspace is created.
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
      ],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
    });
    const joinAppCheckout = `${JOIN_CHECKOUT}/repos/app`;
    const joinToolCheckout = `${JOIN_CHECKOUT}/repos/tool`;
    addPathWithAncestors(joinAppCheckout);
    addPathWithAncestors(joinToolCheckout);
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    const temporaryDestination = makeMultiRepoWorkspace({
      id: 'temp-dest',
      temporary: true,
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [],
    });
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      temporaryDestination,
    );
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === SOURCE_APP_CHECKOUT),
    );

    await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    // Source wins the app overlap: the clean target app checkout is removed.
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      joinAppCheckout,
      'adhoc existing-worktree join overlap cleanup',
    );
    // Both source checkouts move into the destination.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      `${TEMP_DEST_ROOT}/repos/app`,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/lib',
      SOURCE_LIB_CHECKOUT,
      `${TEMP_DEST_ROOT}/repos/lib`,
    );
    // The new target repo's checkout moves into the destination.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      joinToolCheckout,
      `${TEMP_DEST_ROOT}/repos/tool`,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(3);
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects a no-op join when the target is a clean subset of the source', async () => {
    // Source {app, lib}, join single {app} clean: no new repos and the source
    // wins the only overlap, so the target would be consumed for no benefit.
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow(/no changes/);

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('pairs mixed-kind identity overlaps by candidate reference, not identity key', async () => {
    // The source workspace's app repo carries a manifestUrl, so its identity
    // resolves kind:'remote'; the join workspace's same-repoPath repo has no
    // remote (getRemoteUrl mocked to null), so it resolves kind:'path'.
    // `identitiesMatch` pairs them (repoPath comparison), but their derived
    // identity keys differ (`remote:<url>` vs `path:<repoPath>`), so a
    // key-based overlap lookup would miss in `planCheckoutMoves` and
    // double-plan movers while removing the dirty winner's checkout.
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        {
          id: 'app',
          name: 'App',
          repoPath: '/repos/app',
          manifestUrl: 'https://github.com/acme/app.git',
        },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
      ],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeSingleRepoWorkspace({
      id: 'join-ws',
      repoPath: '/repos/app',
      worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
    });
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      makeMultiRepoWorkspace({
        id: 'temp-dest',
        repos: [
          { id: 'join-ws', name: 'join-ws', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        ],
        worktrees: [],
        temporary: true,
      }),
    );
    // The target is dirty, so it wins the overlap.
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    // The clean source checkout is removed exactly once as the overlap loser.
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      'adhoc existing-worktree join overlap cleanup',
    );
    // The dirty target checkout moves exactly once into the destination; the
    // removed source checkout is never planned as a mover.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      JOIN_CHECKOUT,
      `${TEMP_DEST_ROOT}/repos/join-ws`,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/lib',
      SOURCE_LIB_CHECKOUT,
      `${TEMP_DEST_ROOT}/repos/lib`,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(2);
    expect(
      mockedMoveWorktree.mock.calls.filter(
        ([, oldPath]) => oldPath === SOURCE_APP_CHECKOUT,
      ),
    ).toHaveLength(0);
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects with a join-side message when the selected worktree checkout is missing', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    removePathTree(JOIN_CHECKOUT);

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow(
      `Cannot join worktree: selected worktree checkout is missing at ${JOIN_CHECKOUT}.`,
    );

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects when the source worktree has a health issue', async () => {
    const { joinWorkspace } = makeJoinFixture('/repos/tool');
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
      ],
      worktrees: [
        makeWorktree({
          id: 'src-wt',
          healthIssue: {
            status: 'broken',
            code: 'missing-worktree-path',
            message: 'Worktree path is missing',
            checkedAt: '2026-06-12T00:00:00.000Z',
            worktreePath: SOURCE_ROOT,
          },
        }),
      ],
    });
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow('Cannot join from a worktree with a health issue.');

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects when an overlapping repo is dirty on both sides', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(
        checkoutPath === SOURCE_APP_CHECKOUT || checkoutPath === JOIN_CHECKOUT,
      ),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow(/Both worktrees have changes in repo/);

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('removes both worktree rows and returns the joined migration payload', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    const temporaryDestination = makeMultiRepoWorkspace({
      id: 'temp-dest',
      temporary: true,
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [],
    });
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      temporaryDestination,
    );
    let persistedWorktrees: WorktreeData[] | undefined;
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        const next = await Promise.resolve(updater([]));
        persistedWorktrees = next;
        return next;
      },
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      JOIN_CHECKOUT,
      `${TEMP_DEST_ROOT}/repos/tool`,
    );
    const sourceRemoveCall = mockedRemoveWorkspaceWorktrees.mock.calls.find(
      ([workspaceId]) => workspaceId === 'source-ws',
    );
    const joinRemoveCall = mockedRemoveWorkspaceWorktrees.mock.calls.find(
      ([workspaceId]) => workspaceId === 'join-ws',
    );
    expect(sourceRemoveCall).toBeDefined();
    expect(joinRemoveCall).toBeDefined();
    expect(sourceRemoveCall?.[1](makeWorktree({ id: 'src-wt' }))).toBe(true);
    expect(sourceRemoveCall?.[1](makeWorktree({ id: 'other' }))).toBe(false);
    expect(joinRemoveCall?.[1](makeWorktree({ id: 'join-wt' }))).toBe(true);
    expect(joinRemoveCall?.[1](makeWorktree({ id: 'other' }))).toBe(false);

    expect(response.removedSourceWorktree).toBe(true);
    expect(response.destinationWorkspaceId).toBe('temp-dest');
    expect(response.joinedWorktree.workspaceId).toBe('join-ws');
    expect(response.joinedWorktree.worktreeId).toBe('join-wt');
    expect(response.joinedWorktree.repoMappings).toEqual([
      {
        sourceRepoId: 'join-ws',
        destinationRepoId: 'tool',
        repoName: 'Tool',
        repoPath: '/repos/tool',
        oldWorktreePath: JOIN_CHECKOUT,
        newWorktreePath: `${TEMP_DEST_ROOT}/repos/tool`,
      },
    ]);
    expect(response.joinedWorktree.selectedRepoIdRewrites).toEqual({
      'join-ws': 'tool',
    });
    expect(response.joinedWorktree.sourceRootRepoIdRewrite).toBe('tool');
    expect(response.joinedWorktree.filePathRewrites).toEqual([
      { fromRoot: JOIN_CHECKOUT, toRoot: `${TEMP_DEST_ROOT}/repos/tool` },
    ]);
    expect(response.joinedWorktree.compatibilitySymlinks).toEqual([
      expect.objectContaining({
        path: JOIN_CHECKOUT,
        targetPath: `${TEMP_DEST_ROOT}/repos/tool`,
        repoId: 'tool',
        sourceWorkspaceId: 'join-ws',
        sourceWorktreeId: 'join-wt',
      }),
    ]);

    // The persisted destination worktree carries the joined migration so a
    // retry after the source row is gone can return it.
    expect(persistedWorktrees).toHaveLength(1);
    expect(
      persistedWorktrees?.[0].adhocTransitionSource?.joinedWorktreeMigration,
    ).toMatchObject({ workspaceId: 'join-ws', worktreeId: 'join-wt' });

    // Both ledgers are offered to the combined worktree, the source's first;
    // it keeps the source's creation time.
    const moves = [
      [
        worktreeIncarnation('source-ws', 'src-wt'),
        worktreeIncarnation('temp-dest', 'src-wt'),
      ],
      [
        worktreeIncarnation('join-ws', 'join-wt'),
        worktreeIncarnation('temp-dest', 'src-wt'),
      ],
    ];
    // Both moves are durable before the combined row is written, waited on
    // as long as a host that refuses without them waits...
    expect(mockedRecordLedgerMoveIntent.mock.calls).toEqual(
      moves.map((move) => [...move, refusingWait]),
    );
    expect(
      Math.max(...mockedRecordLedgerMoveIntent.mock.invocationCallOrder),
    ).toBeLessThan(
      mockedUpdateWorkspaceWorktrees.mock.invocationCallOrder[0] ??
        Number.NEGATIVE_INFINITY,
    );
    // ...and the participant hears of them only after both rows left their
    // workspaces.
    expect(mockedNotifyLedgerContainerMoved.mock.calls).toEqual(moves);
    const lastRemoval = Math.max(
      ...mockedRemoveWorkspaceWorktrees.mock.invocationCallOrder,
    );
    expect(
      mockedNotifyLedgerContainerMoved.mock.invocationCallOrder[0],
    ).toBeGreaterThan(lastRemoval);
    expect(mockedDiscardLedgerMoveIntent).not.toHaveBeenCalled();
  });

  it('completes the join when the Ledger participant throws', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      makeMultiRepoWorkspace({
        id: 'temp-dest',
        temporary: true,
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
          { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
        ],
        worktrees: [],
      }),
    );
    mockedNotifyLedgerContainerMoved.mockImplementation(() => {
      throw new Error('Ledger participant defect');
    });

    try {
      const response = await combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      });

      expect(response.removedSourceWorktree).toBe(true);
      expect(mockedNotifyLedgerContainerMoved).toHaveBeenCalledTimes(2);
      expect(mockedRestoreCompositionWorktrees).not.toHaveBeenCalled();
    } finally {
      mockedNotifyLedgerContainerMoved.mockReset();
    }
  });

  it.each([
    ['cannot be saved', 'not_durable'],
    ['write throws', 'throws'],
  ] as const)(
    'refuses the join, rolling it back, when a Ledger mapping %s',
    async (_case, failure) => {
      const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
      mockedListWorkspaceItems.mockResolvedValue([
        sourceWorkspace,
        joinWorkspace,
      ]);
      const temporaryDestination = makeMultiRepoWorkspace({
        id: 'temp-dest',
        temporary: true,
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
          { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
        ],
        worktrees: [],
      });
      mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
        temporaryDestination,
      );
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [sourceWorkspace, joinWorkspace, temporaryDestination],
      });
      mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
      // The source's mapping is saved; the joined worktree's is not.
      mockedRecordLedgerMoveIntent.mockResolvedValueOnce('recorded');
      if (failure === 'not_durable') {
        mockedRecordLedgerMoveIntent.mockResolvedValueOnce('not_durable');
      } else {
        mockedRecordLedgerMoveIntent.mockRejectedValueOnce(
          new Error('Ledger journal defect'),
        );
      }

      await expect(
        combineWorktreeWithExistingWorktree({
          sourceWorkspaceId: 'source-ws',
          sourceWorktreeId: 'src-wt',
          joinWorkspaceId: 'join-ws',
          joinWorktreeId: 'join-wt',
          mode: 'temporary',
        }),
      ).rejects.toThrow("Couldn't join the worktree. Try again.");

      // Nothing commits: no row is written or removed, and the joined
      // checkout goes back where it was.
      expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
      expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
      expect(mockedMoveWorktree).toHaveBeenCalledWith(
        '/repos/tool',
        `${TEMP_DEST_ROOT}/repos/tool`,
        JOIN_CHECKOUT,
      );
      // The temporary project the join created is removed again.
      expect(removeWorkspaceIndexEntry).toHaveBeenCalledWith('temp-dest');
      // Neither ledger moves, and the mapping that was saved is forgotten.
      expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
      expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual([
        [
          worktreeIncarnation('source-ws', 'src-wt'),
          worktreeIncarnation('temp-dest', 'src-wt'),
        ],
        [
          worktreeIncarnation('join-ws', 'join-wt'),
          worktreeIncarnation('temp-dest', 'src-wt'),
        ],
      ]);
    },
  );

  it('commits the join without a Ledger mapping when no Ledger exists', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      makeMultiRepoWorkspace({
        id: 'temp-dest',
        temporary: true,
        repos: [
          { id: 'app', name: 'App', repoPath: '/repos/app' },
          { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
          { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
        ],
        worktrees: [],
      }),
    );
    mockedRecordLedgerMoveIntent.mockResolvedValue('not_needed');

    try {
      const response = await combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      });

      expect(response.removedSourceWorktree).toBe(true);
      expect(mockedNotifyLedgerContainerMoved).toHaveBeenCalledTimes(2);
      expect(mockedDiscardLedgerMoveIntent).not.toHaveBeenCalled();
      expect(mockedRestoreCompositionWorktrees).not.toHaveBeenCalled();
    } finally {
      mockedRecordLedgerMoveIntent.mockResolvedValue('recorded');
    }
  });

  it('re-creates removed clean checkouts when a later step fails (rollback)', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    // Target dirty: source app checkout is the clean overlap loser that gets
    // removed and must be re-created during rollback.
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );
    mockedGetCurrentBranch.mockImplementation((checkoutPath: string) =>
      Promise.resolve(
        checkoutPath === SOURCE_APP_CHECKOUT ? 'feature-src' : 'main',
      ),
    );
    mockedUpdateWorkspaceWorktrees.mockRejectedValue(
      new Error('persist failed'),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow('persist failed');

    // Moved checkouts are moved back (newPath -> oldPath).
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      `${OVERLAP_DEST_ROOT}/repos/app`,
      JOIN_CHECKOUT,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/lib',
      `${OVERLAP_DEST_ROOT}/repos/lib`,
      SOURCE_LIB_CHECKOUT,
    );
    // The removed clean source checkout is re-created at its old path with
    // the branch recorded before removal.
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      'feature-src',
    );
  });

  it('restores removed source and joined worktree rows when a late temporary join step fails', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    const sourceRows = [makeWorktree({ id: 'src-wt' })];
    const joinRows = [makeWorktree({ id: 'join-wt' })];
    mockedListWorkspaceItems
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockResolvedValueOnce([sourceWorkspace, joinWorkspace])
      .mockRejectedValueOnce(new Error('refresh failed'));
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'source-ws') {
        return Promise.resolve(sourceRows);
      }
      if (workspaceId === 'join-ws') {
        return Promise.resolve(joinRows);
      }
      return Promise.resolve([]);
    });
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow('refresh failed');

    expect(mockedRestoreCompositionWorktrees).toHaveBeenCalledWith({
      source: 'existing_worktree_join',
      workspaceId: 'source-ws',
      rows: sourceRows,
      order: sourceRows.map((row) => row.id),
    });
    expect(mockedRestoreCompositionWorktrees).toHaveBeenCalledWith({
      source: 'existing_worktree_join',
      workspaceId: 'join-ws',
      rows: joinRows,
      order: joinRows.map((row) => row.id),
    });
    // Rolled back, so neither ledger moves, and both recorded moves are
    // forgotten.
    expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
    expect(mockedRecordLedgerMoveIntent).toHaveBeenCalledTimes(2);
    expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual(
      mockedRecordLedgerMoveIntent.mock.calls.map(([from, to]) => [from, to]),
    );
  });

  it('preserves the destination root when rollback itself fails', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    // Target dirty: the join checkout and the source lib checkout both move
    // into the destination before the failure.
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );
    mockedUpdateWorkspaceWorktrees.mockRejectedValue(
      new Error('persist failed'),
    );
    // Forward moves succeed; reverse moves (from the destination) fail, so
    // the destination still holds the only copies of the moved checkouts.
    mockedMoveWorktree.mockImplementation((_repoPath, oldPath, newPath) => {
      if (oldPath.startsWith(OVERLAP_DEST_ROOT)) {
        return Promise.reject(new Error('reverse move failed'));
      }
      removePathTree(oldPath);
      addPathWithAncestors(newPath);
      return Promise.resolve();
    });

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow(
      /Join worktree failed and rollback did not fully restore checkouts.*Destination was left in place/,
    );

    // The destructive destination cleanup is skipped: the destination root is
    // never removed while it may hold the only copy of a checkout.
    const destinationRootRemovals = mockedFsRm.mock.calls.filter(
      ([rmPath]) => String(rmPath) === OVERLAP_DEST_ROOT,
    );
    expect(destinationRootRemovals).toHaveLength(0);
  });

  it('removes a newly created temporary destination project when rollback fully succeeds', async () => {
    const { sourceWorkspace, joinWorkspace } = makeJoinFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    // No existing workspace matches {app, lib, tool}, so the combine creates
    // a NEW temporary destination workspace.
    const temporaryDestination = makeMultiRepoWorkspace({
      id: 'temp-dest',
      temporary: true,
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [],
    });
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      temporaryDestination,
    );
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [sourceWorkspace, joinWorkspace, temporaryDestination],
    });
    mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    // Fail after the checkout moves; the default move/create mocks let the
    // rollback fully restore both sides.
    mockedUpdateWorkspaceWorktrees.mockRejectedValue(
      new Error('persist failed'),
    );

    await expect(
      combineWorktreeWithExistingWorktree({
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        joinWorkspaceId: 'join-ws',
        joinWorktreeId: 'join-wt',
        mode: 'temporary',
      }),
    ).rejects.toThrow('persist failed');

    // The created temporary destination workspace is dropped from the
    // sidebar and its workspace directory is removed.
    expect(removeWorkspaceIndexEntry).toHaveBeenCalledWith('temp-dest');
    expect(mockedFsRm).toHaveBeenCalledWith('/mock/workspaces/temp-dest', {
      recursive: true,
      force: true,
    });
  });

  it('consumes a multi-repo joined worktree root with a symlink to the destination root', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
      ],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join-ws',
      repos: [{ id: 'tool', name: 'Tool', repoPath: '/repos/tool' }],
      worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
    });
    const joinRoot = '/mock/workspaces/join-ws/worktrees/join-wt';
    addPathWithAncestors(`${joinRoot}/repos/tool`);
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    const temporaryDestination = makeMultiRepoWorkspace({
      id: 'temp-dest',
      temporary: true,
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [],
    });
    mockedCreateTemporaryMultiRepoWorkspace.mockResolvedValue(
      temporaryDestination,
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      `${joinRoot}/repos/tool`,
      `${TEMP_DEST_ROOT}/repos/tool`,
    );
    // The multi-repo joined worktree root itself is consumed and replaced by
    // a compatibility symlink pointing at the destination worktree root.
    expect(response.joinedWorktree.compatibilitySymlinks).toEqual([
      expect.objectContaining({
        path: joinRoot,
        targetPath: TEMP_DEST_ROOT,
        sourceWorkspaceId: 'join-ws',
        sourceWorktreeId: 'join-wt',
      }),
    ]);
  });

  it('returns the persisted payload when retrying after the source was already combined', async () => {
    const joinedMigration: AdhocJoinedWorktreeMigration = {
      workspaceId: 'join-ws',
      worktreeId: 'join-wt',
      repoMappings: [
        {
          sourceRepoId: 'join-ws',
          destinationRepoId: 'tool',
          repoName: 'Tool',
          repoPath: '/repos/tool',
          oldWorktreePath: JOIN_CHECKOUT,
          newWorktreePath:
            '/mock/workspaces/dest-ws/worktrees/dest-wt/repos/tool',
        },
      ],
      selectedRepoIdRewrites: { 'join-ws': 'tool' },
      sourceRootRepoIdRewrite: 'tool',
      filePathRewrites: [
        {
          fromRoot: JOIN_CHECKOUT,
          toRoot: '/mock/workspaces/dest-ws/worktrees/dest-wt/repos/tool',
        },
      ],
      compatibilitySymlinks: [],
    };
    const sourceRepoMappings = [
      {
        sourceRepoId: 'app',
        destinationRepoId: 'app',
        repoName: 'App',
        repoPath: '/repos/app',
        oldWorktreePath: SOURCE_APP_CHECKOUT,
        newWorktreePath: '/mock/workspaces/dest-ws/worktrees/dest-wt/repos/app',
      },
    ];
    const destinationWorktree = makeWorktree({
      id: 'dest-wt',
      adhocTransitionSource: {
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        sourceRepoIds: ['app', 'lib'],
        repoMappings: sourceRepoMappings,
        selectedRepoIdRewrites: { app: 'app', lib: 'lib' },
        filePathRewrites: [
          {
            fromRoot: SOURCE_APP_CHECKOUT,
            toRoot: '/mock/workspaces/dest-ws/worktrees/dest-wt/repos/app',
          },
        ],
        joinedWorktreeMigration: joinedMigration,
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    });
    const destinationWorkspace = makeMultiRepoWorkspace({
      id: 'dest-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'lib', name: 'Lib', repoPath: '/repos/lib' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [destinationWorktree],
    });
    mockedListWorkspaceItems.mockResolvedValue([destinationWorkspace]);

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'temporary',
    });

    expect(response.joinedWorktree).toEqual(joinedMigration);
    expect(response.destinationWorkspaceId).toBe('dest-ws');
    expect(response.destinationWorktreeId).toBe('dest-wt');
    expect(response.repoMappings).toEqual(sourceRepoMappings);
    expect(response.reusedWorkspace).toBe(true);
    expect(response.removedSourceWorktree).toBe(true);
    // Idempotent retry: no git or persistence mutations.
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedFsWriteFile).not.toHaveBeenCalled();
  });
});

describe('combineWorktreeWithExistingWorktree (update-source-workspace)', () => {
  // Update mode absorbs the joined worktree into the source worktree IN
  // PLACE. New-repo checkouts land under the source worktree's repos/ dir
  // keyed by the destination repo id allocated for the join candidate.
  const SOURCE_JOINED_REPO_CHECKOUT = `${SOURCE_ROOT}/repos/join-ws`;

  // Source has only {app} so /repos/tool joins are pure additions and
  // /repos/app joins are full overlaps.
  function makeUpdateFixture(joinRepoPath: string): {
    sourceWorkspace: MultiRepoSidebarItem;
    joinWorkspace: SingleRepoSidebarItem;
  } {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeSingleRepoWorkspace({
      id: 'join-ws',
      repoPath: joinRepoPath,
      worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
    });
    return { sourceWorkspace, joinWorkspace };
  }

  function makeUpdateRequest(): Parameters<
    typeof combineWorktreeWithExistingWorktree
  >[0] {
    return {
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-ws',
      joinWorktreeId: 'join-wt',
      mode: 'update-source-workspace',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setupCombineFixtureMocks();
    mockedAddWorkspaceRepository.mockImplementation(
      withCandidate((repo) =>
        Promise.resolve({
          id: repo.id ?? 'repo',
          name: repo.name ?? 'repo',
          repoPath: repo.repoPath,
        }),
      ),
    );
  });

  it('rejects when the source project is not multi-repo', async () => {
    const sourceWorkspace = makeSingleRepoWorkspace({
      id: 'source-ws',
      repoPath: '/repos/app',
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeSingleRepoWorkspace({
      id: 'join-ws',
      repoPath: '/repos/tool',
      worktrees: [makeWorktree({ id: 'join-wt' })],
    });
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow(/requires a multi-repo source project/);

    expect(mockedAddWorkspaceRepository).not.toHaveBeenCalled();
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects when the source project is temporary', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      temporary: true,
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeSingleRepoWorkspace({
      id: 'join-ws',
      repoPath: '/repos/tool',
      worktrees: [makeWorktree({ id: 'join-wt' })],
    });
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow(/Cannot update a temporary project/);

    expect(mockedAddWorkspaceRepository).not.toHaveBeenCalled();
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('allows dirty source-backed roots because update mode does not consume the source root', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/tool');
    const sourceBackedWorkspace: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      sourceRepoPath: '/repos/workspace-root',
      repos: [
        {
          id: WORKSPACE_ROOT_REPO_ID,
          name: 'Workspace Root',
          repoPath: '/repos/workspace-root',
        },
        ...sourceWorkspace.repos,
      ],
    };
    const refreshedSource: MultiRepoSidebarItem = {
      ...sourceBackedWorkspace,
      repos: [
        ...sourceBackedWorkspace.repos,
        { id: 'join-ws', name: 'join-ws', repoPath: '/repos/tool' },
      ],
    };
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [refreshedSource, joinWorkspace]
          : [sourceBackedWorkspace, joinWorkspace],
      ),
    );
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === SOURCE_ROOT),
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      JOIN_CHECKOUT,
      SOURCE_JOINED_REPO_CHECKOUT,
    );
  });

  it('adds new repos to the config and moves the target checkout in place', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/tool');
    let persistedSourceRows = sourceWorkspace.worktrees;
    const refreshedSource = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'join-ws', name: 'join-ws', repoPath: '/repos/tool' },
      ],
      worktrees: persistedSourceRows,
    });
    // Content-keyed: list calls return the refreshed source workspace only
    // once the combine has extended the workspace config (the step-5 reload).
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [
              { ...refreshedSource, worktrees: persistedSourceRows },
              joinWorkspace,
            ]
          : [
              { ...sourceWorkspace, worktrees: persistedSourceRows },
              joinWorkspace,
            ],
      ),
    );
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? persistedSourceRows
          : joinWorkspace.worktrees,
      ),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        if (workspaceId !== 'source-ws') {
          return Promise.resolve(updater([]));
        }
        persistedSourceRows = await Promise.resolve(
          updater(persistedSourceRows),
        );
        return persistedSourceRows;
      },
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    expect(mockedAddWorkspaceRepository).toHaveBeenCalledWith(
      combineAdd('source-ws', {
        id: 'join-ws',
        name: 'join-ws',
        repoPath: '/repos/tool',
      }),
      expect.objectContaining({
        operation: 'core.workspace.composition.combine',
      }),
    );
    // The joined checkout is MOVED into the source worktree, never created.
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      JOIN_CHECKOUT,
      SOURCE_JOINED_REPO_CHECKOUT,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockedAddRepoCheckoutToWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();

    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(response.destinationWorktreeId).toBe('src-wt');
    expect(response.removedSourceWorktree).toBe(false);
    expect(response.joinedWorktree.workspaceId).toBe('join-ws');
    expect(response.joinedWorktree.worktreeId).toBe('join-wt');
    expect(response.joinedWorktree.repoMappings).toEqual([
      {
        sourceRepoId: 'join-ws',
        destinationRepoId: 'join-ws',
        repoName: 'join-ws',
        repoPath: '/repos/tool',
        oldWorktreePath: JOIN_CHECKOUT,
        newWorktreePath: SOURCE_JOINED_REPO_CHECKOUT,
      },
    ]);
    expect(response.joinedWorktree.selectedRepoIdRewrites).toEqual({
      'join-ws': 'join-ws',
    });
    expect(response.joinedWorktree.filePathRewrites).toEqual([
      { fromRoot: JOIN_CHECKOUT, toRoot: SOURCE_JOINED_REPO_CHECKOUT },
    ]);
    expect(
      persistedSourceRows[0].adhocTransitionSource?.joinedWorktreeMigration,
    ).toEqual(response.joinedWorktree);
    expect(persistedSourceRows[0].adhocTransitionSource).toMatchObject({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      selectedRepoIdRewrites: { app: 'app', 'join-ws': 'join-ws' },
      filePathRewrites: [
        { fromRoot: SOURCE_APP_CHECKOUT, toRoot: SOURCE_APP_CHECKOUT },
        { fromRoot: JOIN_CHECKOUT, toRoot: SOURCE_JOINED_REPO_CHECKOUT },
      ],
    });
    // The joined worktree's ledger is offered to the source row that
    // absorbed it: durably before the rows change, to the participant once
    // the joined row is gone.
    const move = [
      worktreeIncarnation('join-ws', 'join-wt'),
      worktreeIncarnation('source-ws', 'src-wt'),
    ];
    expect(mockedRecordLedgerMoveIntent.mock.calls).toEqual([
      [...move, refusingWait],
    ]);
    expect(
      mockedRecordLedgerMoveIntent.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedUpdateWorkspaceWorktrees.mock.invocationCallOrder[0] ??
        Number.NEGATIVE_INFINITY,
    );
    expect(mockedNotifyLedgerContainerMoved.mock.calls).toEqual([move]);
    expect(
      mockedNotifyLedgerContainerMoved.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      mockedRemoveWorkspaceWorktrees.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('returns the persisted update-source payload when retrying after the joined row is gone', async () => {
    const joinedMigration: AdhocJoinedWorktreeMigration = {
      workspaceId: 'join-ws',
      worktreeId: 'join-wt',
      repoMappings: [
        {
          sourceRepoId: 'join-ws',
          destinationRepoId: 'join-ws',
          repoName: 'join-ws',
          repoPath: '/repos/tool',
          oldWorktreePath: JOIN_CHECKOUT,
          newWorktreePath: SOURCE_JOINED_REPO_CHECKOUT,
        },
      ],
      selectedRepoIdRewrites: { 'join-ws': 'join-ws' },
      filePathRewrites: [
        { fromRoot: JOIN_CHECKOUT, toRoot: SOURCE_JOINED_REPO_CHECKOUT },
      ],
      compatibilitySymlinks: [],
    };
    const sourceRepoMappings = [
      {
        sourceRepoId: 'app',
        destinationRepoId: 'app',
        repoName: 'App',
        repoPath: '/repos/app',
        oldWorktreePath: SOURCE_APP_CHECKOUT,
        newWorktreePath: SOURCE_APP_CHECKOUT,
      },
      {
        sourceRepoId: 'join-ws',
        destinationRepoId: 'join-ws',
        repoName: 'join-ws',
        repoPath: '/repos/tool',
        oldWorktreePath: JOIN_CHECKOUT,
        newWorktreePath: SOURCE_JOINED_REPO_CHECKOUT,
      },
    ];
    const sourceWorktree = makeWorktree({
      id: 'src-wt',
      adhocTransitionSource: {
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        sourceRepoIds: ['app'],
        repoMappings: sourceRepoMappings,
        selectedRepoIdRewrites: { app: 'app', 'join-ws': 'join-ws' },
        filePathRewrites: [
          { fromRoot: SOURCE_APP_CHECKOUT, toRoot: SOURCE_APP_CHECKOUT },
          { fromRoot: JOIN_CHECKOUT, toRoot: SOURCE_JOINED_REPO_CHECKOUT },
        ],
        joinedWorktreeMigration: joinedMigration,
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    });
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'join-ws', name: 'join-ws', repoPath: '/repos/tool' },
      ],
      worktrees: [sourceWorktree],
    });
    mockedListWorkspaceItems.mockResolvedValue([sourceWorkspace]);

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(response.destinationWorktreeId).toBe('src-wt');
    expect(response.removedSourceWorktree).toBe(false);
    expect(response.joinedWorktree).toEqual(joinedMigration);
    expect(response.repoMappings).toEqual(sourceRepoMappings);
    expect(response.reusedWorkspace).toBe(true);
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('continues normally from a live update-source worktree when joining a different target', async () => {
    const joinTwoCheckout = '/mock/workspaces/join-two/worktrees/join-two-wt';
    const joinedMigration: AdhocJoinedWorktreeMigration = {
      workspaceId: 'join-ws',
      worktreeId: 'join-wt',
      repoMappings: [],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
    };
    const sourceWorktree = makeWorktree({
      id: 'src-wt',
      adhocTransitionSource: {
        sourceWorkspaceId: 'source-ws',
        sourceWorktreeId: 'src-wt',
        sourceRepoIds: ['app'],
        repoMappings: [],
        selectedRepoIdRewrites: {},
        filePathRewrites: [],
        joinedWorktreeMigration: joinedMigration,
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    });
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
      worktrees: [sourceWorktree],
    });
    const joinWorkspace = makeSingleRepoWorkspace({
      id: 'join-two',
      repoPath: '/repos/tool',
      worktrees: [makeWorktree({ id: 'join-two-wt' })],
    });
    const refreshedSource = {
      ...sourceWorkspace,
      repos: [
        ...sourceWorkspace.repos,
        { id: 'join-two', name: 'join-two', repoPath: '/repos/tool' },
      ],
    };
    addPathWithAncestors(joinTwoCheckout);
    let persistedSourceRows = sourceWorkspace.worktrees;
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [{ ...refreshedSource, worktrees: persistedSourceRows }]
          : [
              { ...sourceWorkspace, worktrees: persistedSourceRows },
              joinWorkspace,
            ],
      ),
    );
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? persistedSourceRows
          : joinWorkspace.worktrees,
      ),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        if (workspaceId !== 'source-ws') {
          return Promise.resolve(updater([]));
        }
        persistedSourceRows = await Promise.resolve(
          updater(persistedSourceRows),
        );
        return persistedSourceRows;
      },
    );

    const response = await combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'source-ws',
      sourceWorktreeId: 'src-wt',
      joinWorkspaceId: 'join-two',
      joinWorktreeId: 'join-two-wt',
      mode: 'update-source-workspace',
    });

    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(mockedAddWorkspaceRepository).toHaveBeenCalledWith(
      combineAdd('source-ws', {
        id: 'join-two',
        name: 'join-two',
        repoPath: '/repos/tool',
      }),
      expect.objectContaining({
        operation: 'core.workspace.composition.combine',
      }),
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      joinTwoCheckout,
      `${SOURCE_ROOT}/repos/join-two`,
    );
    expect(response.joinedWorktree.workspaceId).toBe('join-two');
    expect(response.joinedWorktree.worktreeId).toBe('join-two-wt');
  });

  it('swaps the overlapping checkout in place when the target is dirty', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/app');
    sourceWorkspace.worktrees = [
      makeWorktree({
        id: 'src-wt',
        trackedRepoBaseBranches: { app: 'source-base' },
      }),
    ];
    joinWorkspace.worktrees = [
      makeWorktree({
        id: 'join-wt',
        branchName: 'join-feature',
        trackedRepoBaseBranches: { 'join-ws': 'target-base' },
      }),
    ];
    let persistedSourceRows = sourceWorkspace.worktrees;
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve([
        { ...sourceWorkspace, worktrees: persistedSourceRows },
        joinWorkspace,
      ]),
    );
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? persistedSourceRows
          : joinWorkspace.worktrees,
      ),
    );
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        if (workspaceId !== 'source-ws') {
          return Promise.resolve(updater([]));
        }
        persistedSourceRows = await Promise.resolve(
          updater(persistedSourceRows),
        );
        return persistedSourceRows;
      },
    );
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    // The clean source checkout is removed first, then the dirty target
    // checkout moves into its exact place.
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      'adhoc existing-worktree join overlap cleanup',
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      JOIN_CHECKOUT,
      SOURCE_APP_CHECKOUT,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockedSafeRemoveWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMoveWorktree.mock.invocationCallOrder[0],
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(response.destinationWorktree.trackedRepoBaseBranches).toEqual({
      app: 'target-base',
    });
    expect(response.destinationWorkspace.repos).toEqual([
      { id: 'app', name: 'App', repoPath: '/repos/app' },
    ]);
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('rejects target-wins overlaps from a different local clone in update mode', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/mirror/app');
    mockedGetRemoteUrl.mockImplementation((repoPath: string) =>
      Promise.resolve(
        repoPath === '/repos/app' || repoPath === '/mirror/app'
          ? 'git@github.com:acme/app.git'
          : null,
      ),
    );
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow(/different local clone/);

    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('removes the clean target overlap checkout while absorbing a new repo when the source wins', async () => {
    // Multi-repo join {app, tool}: app overlaps the source app (both clean ->
    // source wins -> the target's app checkout is removed), tool is a new repo
    // (added to the config + moved into the source worktree in place).
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
      worktrees: [
        makeWorktree({
          id: 'src-wt',
          trackedRepoBaseBranches: { app: 'source-base' },
        }),
      ],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [
        makeWorktree({
          id: 'join-wt',
          branchName: 'join-feature',
          trackedRepoBaseBranches: {
            app: 'discarded-target-base',
            tool: 'target-tool-base',
          },
        }),
      ],
    });
    const joinAppCheckout = `${JOIN_CHECKOUT}/repos/app`;
    const joinToolCheckout = `${JOIN_CHECKOUT}/repos/tool`;
    addPathWithAncestors(joinAppCheckout);
    addPathWithAncestors(joinToolCheckout);
    const refreshedSource = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [
        makeWorktree({
          id: 'src-wt',
          trackedRepoBaseBranches: { app: 'source-base' },
        }),
      ],
    });
    let persistedSourceRows = sourceWorkspace.worktrees;
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [
              { ...refreshedSource, worktrees: persistedSourceRows },
              joinWorkspace,
            ]
          : [
              { ...sourceWorkspace, worktrees: persistedSourceRows },
              joinWorkspace,
            ],
      ),
    );
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? persistedSourceRows
          : joinWorkspace.worktrees,
      ),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (workspaceId, updater) => {
        if (workspaceId !== 'source-ws') {
          return Promise.resolve(updater([]));
        }
        persistedSourceRows = await Promise.resolve(
          updater(persistedSourceRows),
        );
        return persistedSourceRows;
      },
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    // Source wins the app overlap: the target's clean app checkout is removed.
    expect(mockedSafeRemoveWorktree).toHaveBeenCalledWith(
      '/repos/app',
      joinAppCheckout,
      'adhoc existing-worktree join overlap cleanup',
    );
    // The new tool repo is added to the config and its checkout moves into the
    // source worktree; the source app checkout stays in place (no move into it).
    expect(mockedAddWorkspaceRepository).toHaveBeenCalledWith(
      combineAdd('source-ws', {
        id: 'tool',
        name: 'Tool',
        repoPath: '/repos/tool',
      }),
      expect.objectContaining({
        operation: 'core.workspace.composition.combine',
      }),
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      joinToolCheckout,
      `${SOURCE_ROOT}/repos/tool`,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(response.destinationWorktree.trackedRepoBaseBranches).toEqual({
      app: 'source-base',
      tool: 'target-tool-base',
    });
  });

  it('allows a join that adds no new repos when the target has changes to absorb', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    // The target is dirty, so it wins the only overlap and its changes are
    // absorbed in place. This is allowed even though no new repo is added.
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    // Absorbing the target's changed checkout alone is meaningful in
    // existing-worktree joins; the workspace-join "do not add any new repos"
    // rule does not apply. The no-op guard only rejects when the target is
    // clean and the source wins every overlap.
    expect(response.destinationWorkspaceId).toBe('source-ws');
    expect(response.destinationWorktreeId).toBe('src-wt');
    expect(mockedAddWorkspaceRepository).not.toHaveBeenCalled();
  });

  it('rejects a no-op join when the target adds no new repos and is clean', async () => {
    // Source {app}, join single {app} clean: no new repos and the source wins
    // the only overlap, so nothing would be absorbed.
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow(/no changes/);

    expect(mockedAddWorkspaceRepository).not.toHaveBeenCalled();
    expect(mockedMoveWorktree).not.toHaveBeenCalled();
    expect(mockedSafeRemoveWorktree).not.toHaveBeenCalled();
  });

  it('consumes the joined worktree with a symlink to the source worktree root', async () => {
    const sourceWorkspace = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    const joinWorkspace = makeMultiRepoWorkspace({
      id: 'join-ws',
      repos: [{ id: 'tool', name: 'Tool', repoPath: '/repos/tool' }],
      worktrees: [makeWorktree({ id: 'join-wt', branchName: 'join-feature' })],
    });
    const joinRoot = '/mock/workspaces/join-ws/worktrees/join-wt';
    addPathWithAncestors(`${joinRoot}/repos/tool`);
    const refreshedSource = makeMultiRepoWorkspace({
      id: 'source-ws',
      repos: [
        { id: 'app', name: 'App', repoPath: '/repos/app' },
        { id: 'tool', name: 'Tool', repoPath: '/repos/tool' },
      ],
      worktrees: [makeWorktree({ id: 'src-wt' })],
    });
    // Content-keyed: list calls return the refreshed source workspace only
    // once the combine has extended the workspace config (the step-5 reload).
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [refreshedSource, joinWorkspace]
          : [sourceWorkspace, joinWorkspace],
      ),
    );
    let persistedSourceWorktrees: WorktreeData[] | undefined;
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        const next = await Promise.resolve(
          updater([makeWorktree({ id: 'src-wt' })]),
        );
        persistedSourceWorktrees = next;
        return next;
      },
    );

    const response =
      await combineWorktreeWithExistingWorktree(makeUpdateRequest());

    // The multi-repo joined worktree root becomes a symlink to the SOURCE
    // worktree root (the in-place destination).
    expect(response.joinedWorktree.compatibilitySymlinks).toEqual([
      expect.objectContaining({
        path: joinRoot,
        targetPath: SOURCE_ROOT,
        sourceWorkspaceId: 'join-ws',
        sourceWorktreeId: 'join-wt',
      }),
    ]);

    // The joined worktree row is removed from its workspace; the source
    // worktree row stays and gains the appended symlink.
    const joinRemoveCall = mockedRemoveWorkspaceWorktrees.mock.calls.find(
      ([workspaceId]) => workspaceId === 'join-ws',
    );
    expect(joinRemoveCall).toBeDefined();
    expect(joinRemoveCall?.[1](makeWorktree({ id: 'join-wt' }))).toBe(true);
    expect(joinRemoveCall?.[1](makeWorktree({ id: 'other' }))).toBe(false);
    expect(
      mockedRemoveWorkspaceWorktrees.mock.calls.find(
        ([workspaceId]) => workspaceId === 'source-ws',
      ),
    ).toBeUndefined();
    expect(mockedUpdateWorkspaceWorktrees).toHaveBeenCalledWith(
      'source-ws',
      expect.any(Function),
      { requireAuthoritativeRead: true, requireExistingList: true },
    );
    expect(persistedSourceWorktrees).toHaveLength(1);
    expect(persistedSourceWorktrees?.[0].id).toBe('src-wt');
    expect(persistedSourceWorktrees?.[0].compatibilitySymlinks).toEqual([
      expect.objectContaining({ path: joinRoot, targetPath: SOURCE_ROOT }),
    ]);
  });

  it('restores config and checkouts when a later step fails (rollback)', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/tool');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedRemoveWorkspaceWorktrees.mockImplementation((workspaceId) =>
      workspaceId === 'join-ws'
        ? Promise.reject(new Error('remove failed'))
        : Promise.resolve([]),
    );

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow('remove failed');

    // Rollback removes only the repository entries this join added.
    expect(
      jest.mocked(undoCompositionRepositories).mock.calls[0]?.[0],
    ).toMatchObject({
      workspaceId: 'source-ws',
      repositories: [{ repoPath: '/repos/tool' }],
    });
    // The moved checkout is moved back to the joined worktree (exact paths).
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      JOIN_CHECKOUT,
      SOURCE_JOINED_REPO_CHECKOUT,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      SOURCE_JOINED_REPO_CHECKOUT,
      JOIN_CHECKOUT,
    );
    expect(mockedMoveWorktree).toHaveBeenCalledTimes(2);
    // The source worktree row mutation (appended symlinks / merged tracked
    // branches) is undone through the identity-checked source command.
    expect(jest.mocked(undoCompositionSource).mock.calls[0]?.[0]).toMatchObject(
      { workspaceId: 'source-ws', worktree: { id: 'src-wt' } },
    );
    // The join row removal itself failed, so there is nothing to restore on
    // the join side.
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalledWith(
      'join-ws',
      expect.any(Function),
    );
  });

  it('restores both worktree rows when a step fails after the join row removal', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/tool');
    const sourceRow = makeWorktree({
      id: 'src-wt',
      trackedBaseBranch: 'main-base',
    });
    const joinRow = makeWorktree({ id: 'join-wt', branchName: 'join-feature' });
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? [sourceRow]
          : workspaceId === 'join-ws'
            ? [joinRow]
            : [],
      ),
    );
    // The step-5 reload cannot find the source workspace, so the combine
    // fails AFTER both persisted-row mutations already happened.
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve(
        mockedAddWorkspaceRepository.mock.calls.length > 0
          ? [joinWorkspace]
          : [sourceWorkspace, joinWorkspace],
      ),
    );

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow('Updated project could not be reloaded');

    // The source command undoes only the fields this join changed.
    expect(jest.mocked(undoCompositionSource).mock.calls[0]?.[0]).toMatchObject(
      { workspaceId: 'source-ws', worktree: { id: 'src-wt' } },
    );
    // The join workspace receives only the row removed under its list lock.
    expect(mockedRestoreCompositionWorktrees).toHaveBeenCalledWith({
      source: 'existing_worktree_join',
      workspaceId: 'join-ws',
      rows: [joinRow],
      order: [joinRow.id],
    });
    // The repositories this join added are removed too.
    expect(
      jest.mocked(undoCompositionRepositories).mock.calls[0]?.[0],
    ).toMatchObject({
      workspaceId: 'source-ws',
      repositories: [{ repoPath: '/repos/tool' }],
    });
    // Rolled back, so the joined worktree's ledger stays where it is and the
    // recorded move is forgotten.
    expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
    expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual([
      [
        worktreeIncarnation('join-ws', 'join-wt'),
        worktreeIncarnation('source-ws', 'src-wt'),
      ],
    ]);
  });

  it('refuses an update-source join, rolling it back, when the Ledger mapping cannot be saved', async () => {
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/tool');
    const sourceRow = makeWorktree({ id: 'src-wt' });
    const joinRow = makeWorktree({ id: 'join-wt', branchName: 'join-feature' });
    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'source-ws'
          ? [sourceRow]
          : workspaceId === 'join-ws'
            ? [joinRow]
            : [],
      ),
    );
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedRecordLedgerMoveIntent.mockResolvedValueOnce('not_durable');

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow("Couldn't join the worktree. Try again.");

    // Nothing commits: neither row changes, the joined checkout goes back,
    // and the extended config is restored.
    expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedMoveWorktree).toHaveBeenCalledWith(
      '/repos/tool',
      SOURCE_JOINED_REPO_CHECKOUT,
      JOIN_CHECKOUT,
    );
    expect(
      jest.mocked(undoCompositionRepositories).mock.calls[0]?.[0],
    ).toMatchObject({
      workspaceId: 'source-ws',
      repositories: [{ repoPath: '/repos/tool' }],
    });
    expect(mockedNotifyLedgerContainerMoved).not.toHaveBeenCalled();
    expect(mockedDiscardLedgerMoveIntent.mock.calls).toEqual([
      [
        worktreeIncarnation('join-ws', 'join-wt'),
        worktreeIncarnation('source-ws', 'src-wt'),
      ],
    ]);
  });

  it('does not rewrite config metadata when a target-wins update later fails', async () => {
    // Full overlap with a dirty target: the target wins, no repo is added to
    // the config, and the clean SOURCE checkout (the overlap loser) is removed
    // then has the target checkout moved into its place.
    const { sourceWorkspace, joinWorkspace } = makeUpdateFixture('/repos/app');
    mockedListWorkspaceItems.mockResolvedValue([
      sourceWorkspace,
      joinWorkspace,
    ]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/repos/app' }],
    });
    mockedHasUncommittedChanges.mockImplementation((checkoutPath: string) =>
      Promise.resolve(checkoutPath === JOIN_CHECKOUT),
    );
    mockedRemoveWorkspaceWorktrees.mockRejectedValue(
      new Error('remove failed'),
    );

    await expect(
      combineWorktreeWithExistingWorktree(makeUpdateRequest()),
    ).rejects.toThrow('remove failed');

    expect(mockedAddWorkspaceRepository).not.toHaveBeenCalled();
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
    // The mutated source rows are still restored.
    expect(jest.mocked(undoCompositionSource).mock.calls[0]?.[0]).toMatchObject(
      { workspaceId: 'source-ws', worktree: { id: 'src-wt' } },
    );
    // The removed clean SOURCE checkout (the overlap loser when the target
    // wins) is re-created at its old path during rollback.
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/app',
      SOURCE_APP_CHECKOUT,
      'main',
    );
  });
});
