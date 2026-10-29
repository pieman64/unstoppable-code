const listWorkspaceItemsMock = jest.fn();
const readWorkspaceConfigMock = jest.fn();
const pathExistsMock = jest.fn();
const analyzeSplitWorktreeItemsMock = jest.fn(() =>
  Promise.resolve({
    perRepo: new Map(),
    root: {
      chatTabs: [],
      archivedChats: [],
      fileTabs: [],
      executions: [],
      plans: [],
      attachmentNames: [],
    },
  }),
);
const migrateSplitChatsAndPlansMock = jest.fn();
const finalizeSplitChatsAndPlansMigrationMock = jest.fn();
const migrateSplitPipelineExecutionsMock = jest.fn();
const deleteSplitPipelineExecutionsMock = jest.fn(() => Promise.resolve());
const archiveMultiRepoWorktreeMock = jest.fn();
type WorkspaceWorktreeUpdater = (
  worktrees: WorktreeData[],
) => WorktreeData[] | Promise<WorktreeData[]>;
const updateWorkspaceWorktreesMock = jest.fn<
  Promise<WorktreeData[]>,
  [string, WorkspaceWorktreeUpdater]
>();
const removeWorkspaceWorktreesMock = jest.fn();
const assertNoActiveWorktreeWorkMock = jest.fn();
const getGitCommonDirMock = jest.fn();
const acquireSplitDestinationWorktreeClaimMock = jest.fn();
const acquireSplitLockMock = jest.fn();
const releaseSplitDestinationWorktreeClaimMock = jest.fn();
const releaseSplitLockMock = jest.fn();
const acquireWorkspaceArchiveRetentionLeaseMock = jest.fn(() => jest.fn());
const safeRemoveWorktreeMock = jest.fn();
const reverseMovedCheckoutsMock = jest.fn(() => Promise.resolve());
const restoreSplitExecutionSnapshotsMock = jest.fn(() => Promise.resolve());
const restoreSplitExecutionSnapshotsForTargetMock = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());
const undoSplitChatsAndPlansTargetMigrationMock = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());
const removeWorkspaceIndexEntryMock = jest.fn();
const worktreeRowsMock = new Map<string, WorktreeData[]>();
const findOrCreateSingleRepoWorkspaceForRepoMock = jest.fn();
const rmMock = jest.fn();
const readdirMock = jest.fn();
const hasSplitWorktreeStoredItemsMock = jest.fn(() => Promise.resolve(false));
const resolveArchiveRetentionDaysMock = jest.fn(() => null);
const allocateAdhocDestinationWorktreeIdMock = jest.fn(
  (
    _workspaceId: string,
    _preferredId: string,
    additionalReservedIds: ReadonlySet<string> = new Set<string>(),
  ) =>
    Promise.resolve(
      additionalReservedIds.has('destination-wt')
        ? 'destination-wt-2'
        : 'destination-wt',
    ),
);
const readWorkspaceWorktreesMock = jest.fn(() => Promise.resolve([]));
const archiveSingleRepoWorktreeMock = jest.fn(() =>
  Promise.resolve({ warnings: [] }),
);
const removePersistedWorktreeDataDirectoryMock = jest.fn(() =>
  Promise.resolve(),
);
const acquireSplitDestinationWorkspaceLeasesMock = jest.fn(() =>
  Promise.resolve(jest.fn()),
);
const withSplitDestinationWorkspaceCreationLockMock = jest.fn(
  <T>(operation: () => Promise<T>) => operation(),
);
const notifyLedgerContainerMovedMock = jest.fn();
const recordLedgerMoveIntentMock = jest.fn(
  (): Promise<string> => Promise.resolve('recorded'),
);
const discardLedgerMoveIntentMock = jest.fn();

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readdir: readdirMock,
  rm: rmMock,
}));

jest.mock('../lib/adhoc-combine-core', () => ({
  allocateAdhocDestinationWorktreeId: allocateAdhocDestinationWorktreeIdMock,
  assertNoActiveWorktreeWork: assertNoActiveWorktreeWorkMock,
  findWorkspace: jest.fn((items: Array<{ id: string }>, workspaceId: string) =>
    items.find((item) => item.id === workspaceId),
  ),
  identitiesMatch: jest.fn(() => false),
  resolveRepoIdentity: jest.fn(() => Promise.resolve({ remotes: [] })),
  reverseMovedCheckouts: reverseMovedCheckoutsMock,
}));

jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(() => Promise.resolve(null)),
  getGitCommonDir: getGitCommonDirMock,
  moveWorktree: jest.fn(),
}));

jest.mock('../services/split-lock-service', () => ({
  acquireSplitDestinationWorktreeClaim:
    acquireSplitDestinationWorktreeClaimMock,
  acquireWorkspaceArchiveRetentionLease:
    acquireWorkspaceArchiveRetentionLeaseMock,
  acquireSplitLock: acquireSplitLockMock,
  releaseSplitDestinationWorktreeClaim:
    releaseSplitDestinationWorktreeClaimMock,
  releaseSplitLock: releaseSplitLockMock,
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceIndexFilePath: jest.fn(() => '/data/index.json'),
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/data/${workspaceId}/worktrees.json`,
  ),
  getWorkspaceDir: jest.fn((workspaceId: string) => `/data/${workspaceId}`),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/data/${workspaceId}/${worktreeId}/repos/${repoId}`,
  ),
}));

jest.mock('../lib/fs-utils', () => ({
  pathExists: pathExistsMock,
}));

jest.mock('../lib/safe-remove-worktree', () => ({
  safeRemoveWorktree: safeRemoveWorktreeMock,
}));

jest.mock('../lib/sidebar-items', () => ({
  removeWorkspaceIndexEntry: removeWorkspaceIndexEntryMock,
}));

jest.mock('../lib/sidebar-items-preservation', () => ({
  getSidebarItemsPreserveWorkspaceIds: jest.fn(() => []),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: readWorkspaceConfigMock,
  isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
  readWorkspaceWorktrees: readWorkspaceWorktreesMock,
  removeWorkspaceWorktrees: removeWorkspaceWorktreesMock,
  updateWorkspaceWorktrees: updateWorkspaceWorktreesMock,
}));

jest.mock('../lib/workspace-service', () => ({
  acquireSplitDestinationWorkspaceLeases:
    acquireSplitDestinationWorkspaceLeasesMock,
  findOrCreateSingleRepoWorkspaceForRepo:
    findOrCreateSingleRepoWorkspaceForRepoMock,
  listWorkspaceItems: listWorkspaceItemsMock,
  withSplitDestinationWorkspaceCreationLock:
    withSplitDestinationWorkspaceCreationLockMock,
}));

jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: archiveMultiRepoWorktreeMock,
  archiveSingleRepoWorktree: archiveSingleRepoWorktreeMock,
}));

jest.mock('../lib/split-temporary-workspace-items', () => ({
  analyzeSplitWorktreeItems: analyzeSplitWorktreeItemsMock,
  deleteSplitPipelineExecutions: deleteSplitPipelineExecutionsMock,
  finalizeSplitChatsAndPlansMigration: finalizeSplitChatsAndPlansMigrationMock,
  hasSplitWorktreeStoredItems: hasSplitWorktreeStoredItemsMock,
  migrateSplitChatsAndPlans: migrateSplitChatsAndPlansMock,
  migrateSplitPipelineExecutions: migrateSplitPipelineExecutionsMock,
  restoreSplitExecutionSnapshots: restoreSplitExecutionSnapshotsMock,
  restoreSplitExecutionSnapshotsForTarget:
    restoreSplitExecutionSnapshotsForTargetMock,
  undoSplitChatsAndPlansMigration: jest.fn(() => Promise.resolve()),
  undoSplitChatsAndPlansTargetMigration:
    undoSplitChatsAndPlansTargetMigrationMock,
}));

jest.mock('@canopy/desktop-shared/lib/archive-retention', () => ({
  resolveArchiveRetentionDays: resolveArchiveRetentionDaysMock,
}));

jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory:
    removePersistedWorktreeDataDirectoryMock,
}));

jest.mock('../ledger/lifecycle', () => ({
  discardLedgerMoveIntent: discardLedgerMoveIntentMock,
  LEDGER_INTENT_REFUSING_WAIT_MS: 5_000,
  notifyLedgerContainerMoved: notifyLedgerContainerMovedMock,
  recordLedgerMoveIntent: recordLedgerMoveIntentMock,
}));

import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  SplitTemporaryWorkspaceCompleteEvent,
  SplitTemporaryWorkspaceRequest,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  beginSplitTemporaryWorkspaceShutdown,
  drainSplitTemporaryWorkspaceBackgroundPhases,
  previewSplitTemporaryWorkspaceWorktree,
  splitTemporaryWorkspaceWorktree,
} from '../lib/split-temporary-workspace';

const sourceWorkspace: MultiRepoSidebarItem = {
  id: 'source',
  name: 'Source',
  type: 'multi-repo',
  color: '#000000',
  repos: [{ id: 'repo', name: 'Repo', repoPath: '/repo' }],
  worktrees: [
    {
      id: 'source-wt',
      branchName: 'feature',
      createdAt: '2026-08-04T00:00:00.000Z',
    },
  ],
  collapsed: false,
  order: 0,
  temporary: true,
};

const destinationWorkspace: SingleRepoSidebarItem = {
  id: 'destination',
  name: 'Repo',
  type: 'single-repo',
  repoPath: '/repo',
  color: '#000000',
  worktrees: [],
  collapsed: false,
  order: 1,
  archiveRetentionDays: null,
};

const sourceConfig: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  repos: [{ id: 'repo', name: 'Repo', repoPath: '/repo' }],
};

const destinationConfig: WorkspaceConfigFile = {
  version: 1,
  type: 'single-repo',
  repoPath: '/repo',
  repos: [],
  archiveRetentionDays: null,
};

/** A code worktree's Ledger incarnation, as the move participant takes it. */
function ledgerWorktree(
  workspaceId: string,
  worktreeId: string,
): {
  container: { kind: 'code_worktree'; workspaceId: string; worktreeId: string };
  containerCreatedAt: string;
} {
  return {
    container: { kind: 'code_worktree', workspaceId, worktreeId },
    // Every split destination keeps the source worktree's creation time.
    containerCreatedAt: '2026-08-04T00:00:00.000Z',
  };
}

function request(
  selection: 'split' | 'remove',
): SplitTemporaryWorkspaceRequest {
  return {
    workspaceId: 'source',
    worktreeId: 'source-wt',
    selections: { repo: selection },
    rootAction: 'delete',
  };
}

/** Holds per-target item rollback open: fails `failRepoId`'s item undo and
 * keeps `holdRepoId`'s execution restore pending until `release()`. */
function holdTargetRollback(
  failRepoId: string,
  holdRepoId: string,
): { finished: boolean; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { finished: false, release: (): void => release() };
  const repoIdOf = (target: unknown): unknown =>
    typeof target === 'object' && target !== null && 'repoId' in target
      ? target.repoId
      : undefined;
  undoSplitChatsAndPlansTargetMigrationMock.mockImplementation(
    (_undo, target) =>
      repoIdOf(target) === failRepoId
        ? Promise.reject(new Error(`${failRepoId} item restore failed`))
        : Promise.resolve(),
  );
  restoreSplitExecutionSnapshotsForTargetMock.mockImplementation(
    (_snapshots, target) =>
      repoIdOf(target) === holdRepoId
        ? held.then(() => {
            state.finished = true;
          })
        : Promise.resolve(),
  );
  return state;
}

async function flushBackgroundWork(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Two archive targets where the first archive fails fatally, so the later
 * target's migrated data is restored to the source. */
function startMixedArchiveFailureSplit(
  completions: SplitTemporaryWorkspaceCompleteEvent[],
): ReturnType<typeof splitTemporaryWorkspaceWorktree> {
  const mixedSource: MultiRepoSidebarItem = {
    ...sourceWorkspace,
    repos: [
      { id: 'repo-first', name: 'First Repo', repoPath: '/repo-first' },
      { id: 'repo-later', name: 'Later Repo', repoPath: '/repo-later' },
    ],
  };
  const firstDestination: SingleRepoSidebarItem = {
    ...destinationWorkspace,
    id: 'first-destination',
    repoPath: '/repo-first',
    archiveRetentionDays: 30,
  };
  const laterDestination: SingleRepoSidebarItem = {
    ...destinationWorkspace,
    id: 'later-destination',
    repoPath: '/repo-later',
    archiveRetentionDays: 30,
  };
  listWorkspaceItemsMock.mockResolvedValue([
    mixedSource,
    firstDestination,
    laterDestination,
  ]);
  readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
    Promise.resolve(
      workspaceId === mixedSource.id
        ? { ...sourceConfig, repos: mixedSource.repos }
        : { ...destinationConfig, archiveRetentionDays: 30 },
    ),
  );
  resolveArchiveRetentionDaysMock.mockReturnValue(30);
  archiveSingleRepoWorktreeMock.mockRejectedValueOnce(
    new Error('archive failed'),
  );
  updateWorkspaceWorktreesMock
    .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
    .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
    .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
    .mockRejectedValueOnce(new Error('destination persistence failed'));
  return splitTemporaryWorkspaceWorktree(
    {
      workspaceId: mixedSource.id,
      worktreeId: 'source-wt',
      selections: {
        'repo-first': 'remove',
        'repo-later': 'remove',
      },
      rootAction: 'delete',
    },
    { onComplete: (event) => completions.push(event) },
  );
}

describe('splitTemporaryWorkspaceWorktree safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertNoActiveWorktreeWorkMock.mockResolvedValue(undefined);
    getGitCommonDirMock.mockImplementation((repoPath: string) =>
      Promise.resolve(`${repoPath}/.git`),
    );
    pathExistsMock.mockResolvedValue(true);
    listWorkspaceItemsMock.mockResolvedValue([
      sourceWorkspace,
      destinationWorkspace,
    ]);
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === sourceWorkspace.id ? sourceConfig : destinationConfig,
      ),
    );
    migrateSplitChatsAndPlansMock.mockResolvedValue({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      sourceChatsFile: { version: 1, tabs: [], activeTabId: '' },
      sourceArchivesFile: { version: 1, archived: [] },
      sourcePlans: [],
      writtenChatFiles: [],
      writtenArchiveFiles: [],
      writtenPlanFiles: [],
    });
    migrateSplitPipelineExecutionsMock.mockResolvedValue(new Map());
    analyzeSplitWorktreeItemsMock.mockResolvedValue({
      perRepo: new Map(),
      root: {
        chatTabs: [],
        archivedChats: [],
        fileTabs: [],
        executions: [],
        plans: [],
        attachmentNames: [],
      },
    });
    deleteSplitPipelineExecutionsMock.mockResolvedValue(undefined);
    finalizeSplitChatsAndPlansMigrationMock.mockResolvedValue(undefined);
    restoreSplitExecutionSnapshotsMock.mockResolvedValue(undefined);
    restoreSplitExecutionSnapshotsForTargetMock.mockResolvedValue(undefined);
    undoSplitChatsAndPlansTargetMigrationMock.mockResolvedValue(undefined);
    archiveMultiRepoWorktreeMock.mockResolvedValue({ warnings: [] });
    archiveSingleRepoWorktreeMock.mockResolvedValue({ warnings: [] });
    removePersistedWorktreeDataDirectoryMock.mockResolvedValue();
    acquireSplitDestinationWorkspaceLeasesMock.mockResolvedValue(jest.fn());
    worktreeRowsMock.clear();
    updateWorkspaceWorktreesMock.mockImplementation(
      async (workspaceId, update) => {
        const rows = await update(worktreeRowsMock.get(workspaceId) ?? []);
        worktreeRowsMock.set(workspaceId, rows);
        return rows;
      },
    );
    removeWorkspaceWorktreesMock.mockImplementation(
      (workspaceId: string, predicate: (row: WorktreeData) => boolean) => {
        const rows = worktreeRowsMock.get(workspaceId) ?? [];
        worktreeRowsMock.set(
          workspaceId,
          rows.filter((row) => !predicate(row)),
        );
        return Promise.resolve(rows.filter(predicate));
      },
    );
    reverseMovedCheckoutsMock.mockResolvedValue(undefined);
    removeWorkspaceIndexEntryMock.mockResolvedValue(true);
    rmMock.mockResolvedValue(undefined);
    readdirMock.mockResolvedValue([]);
    findOrCreateSingleRepoWorkspaceForRepoMock.mockResolvedValue({
      workspace: destinationWorkspace,
      created: true,
    });
    allocateAdhocDestinationWorktreeIdMock.mockImplementation(
      (
        _workspaceId: string,
        _preferredId: string,
        additionalReservedIds: ReadonlySet<string> = new Set<string>(),
      ) =>
        Promise.resolve(
          additionalReservedIds.has('destination-wt')
            ? 'destination-wt-2'
            : 'destination-wt',
        ),
    );
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    hasSplitWorktreeStoredItemsMock.mockResolvedValue(false);
    resolveArchiveRetentionDaysMock.mockReturnValue(null);
  });

  it('always archives removed repos, even if the destination retention setting changes after approval', async () => {
    // Deletion retention is always on: the destination's persisted value
    // only sizes the retention window, so flipping it mid-flight (even to the
    // legacy "off" encodings) never turns the removal into a hard delete.
    let destinationRetentionDays: number | null = 30;
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === destinationWorkspace.id
          ? {
              ...destinationConfig,
              archiveRetentionDays: destinationRetentionDays,
            }
          : sourceConfig,
      ),
    );

    await splitTemporaryWorkspaceWorktree(request('remove'), {
      consumeDestructiveApproval: (preview) => {
        expect(preview.repos[0]?.removalMode).toBe('archive');
        expect(acquireSplitLockMock).toHaveBeenCalledWith(
          'source',
          'source-wt',
        );
        destinationRetentionDays = null;
      },
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(archiveSingleRepoWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        retainAsArchivedContainer: true,
        requireArchivedContainer: true,
        lockAfterArchive: true,
      }),
    );
    expect(safeRemoveWorktreeMock).not.toHaveBeenCalled();
  });

  it('aborts before migration when a required checkout is missing', async () => {
    pathExistsMock.mockResolvedValue(false);

    await expect(
      splitTemporaryWorkspaceWorktree(request('split')),
    ).rejects.toThrow('checkout for repo "Repo" is missing');

    expect(migrateSplitChatsAndPlansMock).not.toHaveBeenCalled();
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects completed worktrees at the shared backend boundary', async () => {
    listWorkspaceItemsMock.mockResolvedValue([
      {
        ...sourceWorkspace,
        worktrees: sourceWorkspace.worktrees.map((worktree) => ({
          ...worktree,
          status: 'done',
        })),
      },
      destinationWorkspace,
    ]);

    await expect(
      splitTemporaryWorkspaceWorktree(request('split')),
    ).rejects.toThrow('Cannot split a completed worktree');

    expect(migrateSplitChatsAndPlansMock).not.toHaveBeenCalled();
  });

  it('retains destination reservations when item rollback cannot restore the source', async () => {
    const rollbackFailure = new Error('source restore failed');
    rollbackFailure.name = 'SplitItemsMigrationRollbackError';
    migrateSplitChatsAndPlansMock.mockRejectedValue(rollbackFailure);
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string };
    }> = [];

    await expect(
      splitTemporaryWorkspaceWorktree(request('split'), {
        onSplitWorktreeFailed: (event) => failureEvents.push(event),
      }),
    ).rejects.toThrow('source restore failed');

    expect(removeWorkspaceWorktreesMock).not.toHaveBeenCalled();
    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 1
      ];
    expect(recoveryUpdate?.[0]).toBe('destination');
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected retained reservation recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([
      {
        id: 'destination-wt',
        branchName: 'feature/source',
        createdAt: '2026-08-04T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
    expect(recoveredReservations).toHaveLength(1);
    expect(recoveredReservations[0]).toMatchObject({
      id: 'destination-wt',
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        gitError: 'source restore failed',
      },
    });
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      projectId: 'destination',
      worktreeId: 'destination-wt',
      healthIssue: { code: 'git-error' },
    });
  });

  it('refreshes a preview cache miss under lease and rejects destination rebinding', async () => {
    const cacheRaceSource: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      id: 'source-cache-race',
      worktrees: sourceWorkspace.worktrees.map((worktree) => ({
        ...worktree,
        id: 'source-cache-race-wt',
      })),
    };
    const cacheRaceRequest: SplitTemporaryWorkspaceRequest = {
      workspaceId: cacheRaceSource.id,
      worktreeId: 'source-cache-race-wt',
      selections: { repo: 'split' },
      rootAction: 'delete',
    };
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === cacheRaceSource.id ? sourceConfig : destinationConfig,
      ),
    );
    listWorkspaceItemsMock.mockResolvedValue([cacheRaceSource]);
    const approvedPreview =
      await previewSplitTemporaryWorkspaceWorktree(cacheRaceRequest);
    expect(approvedPreview.repos[0]?.destinationWorkspaceId).toBeUndefined();

    listWorkspaceItemsMock.mockResolvedValue([
      cacheRaceSource,
      destinationWorkspace,
    ]);
    await expect(
      splitTemporaryWorkspaceWorktree(cacheRaceRequest, {
        consumeDestructiveApproval: (currentPreview) => {
          expect(currentPreview.repos[0]?.destinationWorkspaceId).toBe(
            'destination',
          );
          expect(currentPreview.previewRevision).not.toBe(
            approvedPreview.previewRevision,
          );
          throw new Error('The split preview changed before execution');
        },
      }),
    ).rejects.toThrow('The split preview changed before execution');

    expect(migrateSplitChatsAndPlansMock).not.toHaveBeenCalled();
    expect(findOrCreateSingleRepoWorkspaceForRepoMock).not.toHaveBeenCalled();
  });

  it('surfaces and marks reservations when fast-phase cleanup fails', async () => {
    migrateSplitChatsAndPlansMock.mockRejectedValue(
      new Error('item migration failed'),
    );
    removeWorkspaceWorktreesMock.mockRejectedValue(
      new Error('reservation persistence failed'),
    );
    findOrCreateSingleRepoWorkspaceForRepoMock.mockResolvedValue({
      workspace: destinationWorkspace,
      created: false,
    });
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      error: string;
      healthIssue?: { status: string; gitError?: string };
    }> = [];

    await expect(
      splitTemporaryWorkspaceWorktree(request('split'), {
        onSplitWorktreeFailed: (event) => failureEvents.push(event),
      }),
    ).rejects.toThrow(
      'Reservation rollback was incomplete; retained destinations were marked failed for recovery',
    );

    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      projectId: 'destination',
      worktreeId: 'destination-wt',
    });
    expect(failureEvents[0]?.healthIssue).toMatchObject({
      status: 'broken',
      gitError: 'reservation persistence failed',
    });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('blocks both running and paused pipelines at the backend boundary', async () => {
    await splitTemporaryWorkspaceWorktree(request('split'));
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(assertNoActiveWorktreeWorkMock).toHaveBeenCalledWith(
      'source',
      'source-wt',
      expect.objectContaining({
        blockedPipelineStatuses: new Set(['running', 'paused']),
      }),
    );
  });

  it('persists recovery rows for every surviving destination before source mutation', async () => {
    const mixedSource: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      repos: [
        { id: 'repo-keep', name: 'Keep Repo', repoPath: '/repo-keep' },
        {
          id: 'repo-archive',
          name: 'Archive Repo',
          repoPath: '/repo-archive',
        },
      ],
    };
    const keepDestination: SingleRepoSidebarItem = {
      ...destinationWorkspace,
      id: 'keep-destination',
      repoPath: '/repo-keep',
    };
    const archiveDestination: SingleRepoSidebarItem = {
      ...destinationWorkspace,
      id: 'archive-destination',
      repoPath: '/repo-archive',
      archiveRetentionDays: 30,
    };
    listWorkspaceItemsMock.mockResolvedValue([
      mixedSource,
      keepDestination,
      archiveDestination,
    ]);
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === mixedSource.id
          ? { ...sourceConfig, repos: mixedSource.repos }
          : {
              ...destinationConfig,
              archiveRetentionDays:
                workspaceId === archiveDestination.id ? 30 : null,
            },
      ),
    );
    resolveArchiveRetentionDaysMock.mockImplementation(
      (_workspaceType: string, configuredDays: number | null | undefined) =>
        configuredDays === null ? null : 30,
    );
    let finishMigration:
      | ((value: {
          workspaceId: string;
          worktreeId: string;
          sourceChatsFile: {
            version: number;
            tabs: never[];
            activeTabId: string;
          };
          sourceArchivesFile: { version: number; archived: never[] };
          sourcePlans: never[];
          writtenChatFiles: never[];
          writtenArchiveFiles: never[];
          writtenPlanFiles: never[];
        }) => void)
      | undefined;
    let signalMigrationStarted: () => void = () => {};
    const migrationStarted = new Promise<void>((resolve) => {
      signalMigrationStarted = resolve;
    });
    migrateSplitChatsAndPlansMock.mockImplementationOnce(() => {
      signalMigrationStarted();
      return new Promise((resolve) => {
        finishMigration = resolve;
      });
    });

    const splitPromise = splitTemporaryWorkspaceWorktree({
      workspaceId: mixedSource.id,
      worktreeId: 'source-wt',
      selections: {
        'repo-keep': 'split',
        'repo-archive': 'remove',
      },
      rootAction: 'delete',
    });
    await migrationStarted;

    const reservationCalls = updateWorkspaceWorktreesMock.mock.calls.slice(
      0,
      2,
    );
    const keepReservation = await reservationCalls[0]?.[1]([]);
    const archiveReservation = await reservationCalls[1]?.[1]([]);

    if (!finishMigration) {
      throw new Error('Expected item migration to remain pending');
    }
    finishMigration({
      workspaceId: mixedSource.id,
      worktreeId: 'source-wt',
      sourceChatsFile: { version: 1, tabs: [], activeTabId: '' },
      sourceArchivesFile: { version: 1, archived: [] },
      sourcePlans: [],
      writtenChatFiles: [],
      writtenArchiveFiles: [],
      writtenPlanFiles: [],
    });
    await splitPromise;
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(reservationCalls.map(([workspaceId]) => workspaceId)).toEqual([
      'keep-destination',
      'archive-destination',
    ]);
    expect(keepReservation?.[0]).toMatchObject({
      setupPhase: 'git-pending',
      splitRecoveryRequired: true,
    });
    expect(keepReservation?.[0]).not.toHaveProperty('hidden');
    expect(archiveReservation?.[0]).toMatchObject({
      hidden: true,
      setupPhase: 'git-pending',
      splitRecoveryRequired: true,
    });
    expect(
      updateWorkspaceWorktreesMock.mock.invocationCallOrder[1],
    ).toBeLessThan(migrateSplitChatsAndPlansMock.mock.invocationCallOrder[0]);
    // One repository is kept, so the worktree's ledger moves there; the
    // archived repository's destination is not a continuation.
    expect(notifyLedgerContainerMovedMock.mock.calls).toEqual([
      [
        ledgerWorktree(mixedSource.id, 'source-wt'),
        ledgerWorktree('keep-destination', 'destination-wt'),
      ],
    ]);
  });

  it('emits one failure event and drains an unexpected background rejection', async () => {
    // Removed repos always archive now, so the checkout presence check runs
    // in the fast phase; the execution-snapshot read is the first background
    // read on this path and stands in as the unexpected rejection source.
    pathExistsMock.mockResolvedValue(true);
    let rejectExecutionRead: ((error: Error) => void) | undefined;
    migrateSplitPipelineExecutionsMock.mockImplementation(
      () =>
        new Promise<Map<string, never>>((_resolve, reject) => {
          rejectExecutionRead = reject;
        }),
    );
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('remove'), {
      onComplete: (event) => completionEvents.push(event),
    });
    expect(acquireSplitLockMock).toHaveBeenCalledWith('source', 'source-wt');
    expect(releaseSplitLockMock).not.toHaveBeenCalled();
    const drain = drainSplitTemporaryWorkspaceBackgroundPhases(1_000);
    for (let attempt = 0; attempt < 20 && !rejectExecutionRead; attempt += 1) {
      await Promise.resolve();
    }

    if (!rejectExecutionRead) {
      throw new Error('Expected the background execution read to be pending');
    }
    rejectExecutionRead(new Error('background read failed'));
    await drain;

    expect(completionEvents).toEqual([
      expect.objectContaining({
        success: false,
        error: 'background read failed',
      }),
    ]);
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
    expect(releaseSplitLockMock).toHaveBeenCalledWith('source', 'source-wt');
  });

  it('tracks and locks the split while its fast phase is still running', async () => {
    let releaseActiveWorkCheck: (() => void) | undefined;
    assertNoActiveWorktreeWorkMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseActiveWorkCheck = resolve;
        }),
    );

    const split = splitTemporaryWorkspaceWorktree(request('split'));
    await Promise.resolve();
    await Promise.resolve();
    const drain = drainSplitTemporaryWorkspaceBackgroundPhases(1_000);
    let drainSettled = false;
    void drain.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    expect(drainSettled).toBe(false);
    expect(releaseSplitLockMock).not.toHaveBeenCalled();
    if (!releaseActiveWorkCheck) {
      throw new Error('Expected the active-work check to be pending');
    }
    releaseActiveWorkCheck();
    await split;
    await drain;
    expect(releaseSplitLockMock).toHaveBeenCalledWith('source', 'source-wt');
  });

  it('retains an archived container for potentially unmanaged root files', async () => {
    resolveArchiveRetentionDaysMock.mockReturnValue(7);

    await splitTemporaryWorkspaceWorktree({
      ...request('split'),
      rootAction: 'archive',
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(archiveMultiRepoWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        retainAsArchivedContainer: true,
        requireArchivedContainer: true,
        lockAfterArchive: true,
        captureWorkspaceRootFiles: true,
        restoreScope: 'workspace-root-only',
      }),
    );
  });

  it('keeps reservations pending until execution migration settles', async () => {
    let finishExecutionMigration:
      | ((snapshots: Map<string, never>) => void)
      | undefined;
    let signalExecutionMigrationStarted: () => void = () => {};
    const executionMigrationStarted = new Promise<void>((resolve) => {
      signalExecutionMigrationStarted = resolve;
    });
    migrateSplitPipelineExecutionsMock.mockImplementation(() => {
      signalExecutionMigrationStarted();
      return new Promise<Map<string, never>>((resolve) => {
        finishExecutionMigration = resolve;
      });
    });
    const readyEvents: Array<{
      projectId: string;
      worktreeId: string;
      branchName: string;
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeReady: (event) => readyEvents.push(event),
    });
    await executionMigrationStarted;

    expect(migrateSplitPipelineExecutionsMock).toHaveBeenCalled();
    expect(updateWorkspaceWorktreesMock).toHaveBeenCalledTimes(1);
    expect(readyEvents).toEqual([]);

    if (!finishExecutionMigration) {
      throw new Error('Expected execution migration to be pending');
    }
    finishExecutionMigration(new Map());
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(updateWorkspaceWorktreesMock).toHaveBeenCalledTimes(2);
    const promotionUpdater = updateWorkspaceWorktreesMock.mock.calls[1]?.[1];
    if (typeof promotionUpdater !== 'function') {
      throw new Error('Expected destination promotion updater');
    }
    expect(
      promotionUpdater([
        {
          id: 'destination-wt',
          branchName: 'feature/source',
          createdAt: '2026-08-04T00:00:00.000Z',
          setupPhase: 'git-pending',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'destination-wt',
        setupPhase: 'git-ready',
      }),
    ]);
    expect(
      updateWorkspaceWorktreesMock.mock.invocationCallOrder[1],
    ).toBeLessThan(
      finalizeSplitChatsAndPlansMigrationMock.mock.invocationCallOrder[0],
    );
    expect(readyEvents).toEqual([
      expect.objectContaining({
        projectId: 'destination',
        worktreeId: 'destination-wt',
      }),
    ]);
    expect(acquireSplitDestinationWorktreeClaimMock).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
    );
    expect(releaseSplitDestinationWorktreeClaimMock).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
    );
  });

  it('rolls back when the destination reservation disappears before promotion', async () => {
    updateWorkspaceWorktreesMock
      .mockImplementationOnce((_workspaceId, updater) =>
        Promise.resolve(updater([])),
      )
      .mockImplementationOnce((_workspaceId, updater) =>
        Promise.resolve(updater([])),
      );
    const readyEvents: Array<{ projectId: string; worktreeId: string }> = [];
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeReady: (event) => readyEvents.push(event),
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(reverseMovedCheckoutsMock).toHaveBeenCalled();
    expect(readyEvents).toEqual([]);
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]?.success).toBe(false);
    expect(completionEvents[0]?.error).toContain(
      'disappeared before promotion',
    );
    expect(finalizeSplitChatsAndPlansMigrationMock).not.toHaveBeenCalled();
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
  });

  it('retains destination reservations when checkout reversal fails', async () => {
    updateWorkspaceWorktreesMock
      .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
      .mockRejectedValueOnce(new Error('reservation promotion failed'));
    reverseMovedCheckoutsMock.mockImplementation(
      (_moved: unknown[], rollbackErrors: unknown[]) => {
        rollbackErrors.push(new Error('checkout reversal failed'));
        return Promise.resolve();
      },
    );
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string };
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeFailed: (event) => failureEvents.push(event),
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(removeWorkspaceWorktreesMock).not.toHaveBeenCalled();
    expect(finalizeSplitChatsAndPlansMigrationMock).not.toHaveBeenCalled();
    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 1
      ];
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected incomplete rollback recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([
      {
        id: 'destination-wt',
        branchName: 'feature/source',
        createdAt: '2026-08-04T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
    expect(recoveredReservations[0]).toMatchObject({
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: { status: 'broken', code: 'git-error' },
    });
    expect(failureEvents).toHaveLength(1);
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]?.success).toBe(false);
    expect(
      completionEvents[0]?.warnings.some((warning) =>
        warning.includes('reservations were retained'),
      ),
    ).toBe(true);
  });

  it('stops before readiness and teardown when execution rollback fails', async () => {
    const rollbackFailure = new Error('execution restore failed');
    rollbackFailure.name = 'SplitExecutionMigrationRollbackError';
    migrateSplitPipelineExecutionsMock.mockRejectedValue(rollbackFailure);
    const readyEvents: Array<{
      projectId: string;
      worktreeId: string;
      branchName: string;
    }> = [];
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string };
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeReady: (event) => readyEvents.push(event),
      onSplitWorktreeFailed: (event) => failureEvents.push(event),
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(readyEvents).toEqual([]);
    expect(removeWorkspaceWorktreesMock).not.toHaveBeenCalled();
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 1
      ];
    expect(recoveryUpdate?.[0]).toBe('destination');
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected retained reservation recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([
      {
        id: 'destination-wt',
        branchName: 'feature/source',
        createdAt: '2026-08-04T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
    expect(recoveredReservations[0]).toMatchObject({
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        gitError: 'execution restore failed',
      },
    });
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      projectId: 'destination',
      worktreeId: 'destination-wt',
      healthIssue: { code: 'git-error' },
    });
    expect(completionEvents).toEqual([
      expect.objectContaining({
        success: false,
        error: 'execution restore failed',
      }),
    ]);
  });

  it('materializes archive-only recovery rows when execution rollback fails', async () => {
    resolveArchiveRetentionDaysMock.mockReturnValue(30);
    const rollbackFailure = new Error('archive execution restore failed');
    rollbackFailure.name = 'SplitExecutionMigrationRollbackError';
    migrateSplitPipelineExecutionsMock.mockRejectedValue(rollbackFailure);
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string };
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('remove'), {
      onSplitWorktreeFailed: (event) => failureEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 1
      ];
    expect(recoveryUpdate?.[0]).toBe('destination');
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected archive-only recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([
      {
        id: 'destination-wt',
        branchName: 'feature/source',
        createdAt: '2026-08-04T00:00:00.000Z',
        hidden: true,
        setupPhase: 'git-pending',
        splitRecoveryRequired: true,
      },
    ]);
    expect(recoveredReservations).toHaveLength(1);
    expect(recoveredReservations[0]).toMatchObject({
      id: 'destination-wt',
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: { code: 'git-error' },
    });
    expect(recoveredReservations[0]).not.toHaveProperty('hidden');
    expect(failureEvents).toHaveLength(1);
    expect(archiveSingleRepoWorktreeMock).not.toHaveBeenCalled();
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rolls back the split when execution migration fails', async () => {
    migrateSplitPipelineExecutionsMock.mockRejectedValue(
      new Error('execution migration failed'),
    );
    const readyEvents: Array<{
      projectId: string;
      worktreeId: string;
      branchName: string;
    }> = [];
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeReady: (event) => readyEvents.push(event),
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(reverseMovedCheckoutsMock).toHaveBeenCalled();
    expect(removeWorkspaceWorktreesMock).toHaveBeenCalledWith(
      'destination',
      expect.any(Function),
      undefined,
      undefined,
      { requireAuthoritativeRead: true, requireExistingList: true },
    );
    expect(finalizeSplitChatsAndPlansMigrationMock).not.toHaveBeenCalled();
    expect(readyEvents).toEqual([]);
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
    expect(completionEvents).toEqual([
      expect.objectContaining({
        success: false,
        error: 'execution migration failed',
      }),
    ]);
    expect(notifyLedgerContainerMovedMock).not.toHaveBeenCalled();
    expect(recordLedgerMoveIntentMock).not.toHaveBeenCalled();
  });

  it('moves the Ledger scope to the only kept destination once promotion commits, before the source teardown', async () => {
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(completionEvents).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(notifyLedgerContainerMovedMock.mock.calls).toEqual([
      [
        ledgerWorktree('source', 'source-wt'),
        ledgerWorktree('destination', 'destination-wt'),
      ],
    ]);
    // The destination ID may be suffixed, so the move is made durable
    // before promotion commits the destination, waited on as long as a host
    // that refuses without it waits...
    expect(recordLedgerMoveIntentMock.mock.calls).toEqual([
      [
        ledgerWorktree('source', 'source-wt'),
        ledgerWorktree('destination', 'destination-wt'),
        { waitMs: 5_000 },
      ],
    ]);
    expect(discardLedgerMoveIntentMock).not.toHaveBeenCalled();
    const recordedAt =
      recordLedgerMoveIntentMock.mock.invocationCallOrder[0] ??
      Number.POSITIVE_INFINITY;
    const movedAt =
      notifyLedgerContainerMovedMock.mock.invocationCallOrder[0] ?? 0;
    const promotedAt = Math.max(
      ...updateWorkspaceWorktreesMock.mock.invocationCallOrder,
    );
    expect(recordedAt).toBeLessThan(promotedAt);
    // ...and the participant hears of it once the last reservation update
    // promoted the destination, before the teardown removes the source row.
    expect(promotedAt).toBeLessThan(movedAt);
    expect(movedAt).toBeLessThan(
      archiveMultiRepoWorktreeMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('keeps the Ledger scope with the source when a split keeps several repositories', async () => {
    const twoRepoSource: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repo-a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repo-b' },
      ],
    };
    listWorkspaceItemsMock.mockResolvedValue([
      twoRepoSource,
      { ...destinationWorkspace, id: 'destination-a', repoPath: '/repo-a' },
      { ...destinationWorkspace, id: 'destination-b', repoPath: '/repo-b' },
    ]);
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === twoRepoSource.id
          ? { ...sourceConfig, repos: twoRepoSource.repos }
          : destinationConfig,
      ),
    );
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(
      {
        workspaceId: twoRepoSource.id,
        worktreeId: 'source-wt',
        selections: { 'repo-a': 'split', 'repo-b': 'split' },
        rootAction: 'delete',
      },
      { onComplete: (event) => completionEvents.push(event) },
    );
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(completionEvents).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(recordLedgerMoveIntentMock).not.toHaveBeenCalled();
    expect(notifyLedgerContainerMovedMock).not.toHaveBeenCalled();
  });

  it.each([
    ['cannot be saved', 'not_durable'],
    ['write throws', 'throws'],
  ] as const)(
    'rolls the split back when its Ledger mapping %s',
    async (_case, failure) => {
      if (failure === 'not_durable') {
        recordLedgerMoveIntentMock.mockResolvedValueOnce('not_durable');
      } else {
        recordLedgerMoveIntentMock.mockRejectedValueOnce(
          new Error('Ledger journal defect'),
        );
      }
      const readyEvents: Array<{ projectId: string; worktreeId: string }> = [];
      const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

      await splitTemporaryWorkspaceWorktree(request('split'), {
        onSplitWorktreeReady: (event) => readyEvents.push(event),
        onComplete: (event) => completionEvents.push(event),
      });
      await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

      // Nothing commits: the destination is never promoted or published,
      // the checkouts go back, and the source stays.
      expect(reverseMovedCheckoutsMock).toHaveBeenCalled();
      expect(removeWorkspaceWorktreesMock).toHaveBeenCalledWith(
        'destination',
        expect.any(Function),
        undefined,
        undefined,
        { requireAuthoritativeRead: true, requireExistingList: true },
      );
      expect(readyEvents).toEqual([]);
      expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
      expect(completionEvents).toEqual([
        expect.objectContaining({
          success: false,
          error: "Couldn't split the project. Try again.",
        }),
      ]);
      expect(notifyLedgerContainerMovedMock).not.toHaveBeenCalled();
      expect(discardLedgerMoveIntentMock.mock.calls).toEqual([
        [
          ledgerWorktree('source', 'source-wt'),
          ledgerWorktree('destination', 'destination-wt'),
        ],
      ]);
    },
  );

  it('completes the split without a Ledger mapping when no Ledger exists', async () => {
    recordLedgerMoveIntentMock.mockResolvedValueOnce('not_needed');
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(recordLedgerMoveIntentMock).toHaveBeenCalledTimes(1);
    expect(notifyLedgerContainerMovedMock).toHaveBeenCalledTimes(1);
    expect(discardLedgerMoveIntentMock).not.toHaveBeenCalled();
    expect(archiveMultiRepoWorktreeMock).toHaveBeenCalledTimes(1);
    expect(completionEvents).toEqual([
      expect.objectContaining({ success: true }),
    ]);
  });

  it('completes the split when the Ledger participant throws', async () => {
    notifyLedgerContainerMovedMock.mockImplementationOnce(() => {
      throw new Error('Ledger participant defect');
    });
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(notifyLedgerContainerMovedMock).toHaveBeenCalledTimes(1);
    expect(archiveMultiRepoWorktreeMock).toHaveBeenCalledTimes(1);
    expect(completionEvents).toEqual([
      expect.objectContaining({ success: true }),
    ]);
  });

  it('preserves project directories when sidebar persistence fails', async () => {
    listWorkspaceItemsMock.mockResolvedValue([sourceWorkspace]);
    updateWorkspaceWorktreesMock
      .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
      .mockRejectedValueOnce(new Error('reservation promotion failed'));
    removeWorkspaceIndexEntryMock.mockRejectedValue(
      new Error('sidebar write failed'),
    );

    await splitTemporaryWorkspaceWorktree(request('split'));
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(removeWorkspaceIndexEntryMock).toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('removes a created destination whose rewritten stores are empty', async () => {
    listWorkspaceItemsMock.mockResolvedValue([sourceWorkspace]);
    updateWorkspaceWorktreesMock
      .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
      .mockRejectedValueOnce(new Error('reservation promotion failed'));

    await splitTemporaryWorkspaceWorktree(request('split'));
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(hasSplitWorktreeStoredItemsMock).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
    );
    expect(rmMock).toHaveBeenCalledWith('/data/destination', {
      recursive: true,
      force: true,
    });
    expect(removePersistedWorktreeDataDirectoryMock).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      { removeTree: removeTreeWithoutAsar },
    );
    expect(withSplitDestinationWorkspaceCreationLockMock).toHaveBeenCalled();
  });

  it('rejects a destination id that becomes reserved before persistence', async () => {
    updateWorkspaceWorktreesMock.mockImplementationOnce(
      (
        _workspaceId: string,
        update: (worktrees: WorktreeData[]) => WorktreeData[],
      ) =>
        update([
          {
            id: 'destination-wt',
            branchName: 'other-branch',
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ]),
    );

    await expect(
      splitTemporaryWorkspaceWorktree(request('split')),
    ).rejects.toThrow('is already reserved');

    expect(migrateSplitChatsAndPlansMock).not.toHaveBeenCalled();
  });

  it('marks a created destination containing post-split data for recovery', async () => {
    listWorkspaceItemsMock.mockResolvedValue([sourceWorkspace]);
    updateWorkspaceWorktreesMock
      .mockImplementationOnce((_id, update) => Promise.resolve(update([])))
      .mockRejectedValueOnce(new Error('reservation promotion failed'));
    hasSplitWorktreeStoredItemsMock.mockResolvedValue(true);
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string };
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('split'), {
      onSplitWorktreeFailed: (event) => failureEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(rmMock).not.toHaveBeenCalled();
    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 2
      ];
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected data-bearing reservation recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([
      {
        id: 'destination-wt',
        branchName: 'feature/source',
        createdAt: '2026-08-04T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
    expect(recoveredReservations[0]).toMatchObject({
      id: 'destination-wt',
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: { status: 'broken', code: 'git-error' },
    });
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      projectId: 'destination',
      worktreeId: 'destination-wt',
      healthIssue: { code: 'git-error' },
    });
  });

  it('materializes an archive-only recovery row when migrated-item rollback fails', async () => {
    resolveArchiveRetentionDaysMock.mockReturnValue(30);
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    archiveSingleRepoWorktreeMock.mockRejectedValueOnce(
      new Error('archive failed'),
    );
    undoSplitChatsAndPlansTargetMigrationMock.mockRejectedValueOnce(
      new Error('source item restore failed'),
    );
    const completionEvents: SplitTemporaryWorkspaceCompleteEvent[] = [];
    const failureEvents: Array<{
      projectId: string;
      worktreeId: string;
      healthIssue?: { code: string; gitError?: string };
    }> = [];

    await splitTemporaryWorkspaceWorktree(request('remove'), {
      onSplitWorktreeFailed: (event) => failureEvents.push(event),
      onComplete: (event) => completionEvents.push(event),
    });
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    const recoveryUpdate =
      updateWorkspaceWorktreesMock.mock.calls[
        updateWorkspaceWorktreesMock.mock.calls.length - 1
      ];
    expect(recoveryUpdate?.[0]).toBe('destination');
    const recoveryUpdater = recoveryUpdate?.[1];
    if (typeof recoveryUpdater !== 'function') {
      throw new Error('Expected archive rollback recovery updater');
    }
    const recoveredReservations = await recoveryUpdater([]);
    expect(recoveredReservations).toHaveLength(1);
    expect(recoveredReservations[0]).toMatchObject({
      id: 'destination-wt',
      setupPhase: undefined,
      splitRecoveryRequired: true,
      healthIssue: { status: 'broken', code: 'git-error' },
    });
    expect(recoveredReservations[0]?.healthIssue?.gitError).toContain(
      'source item restore failed',
    );
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      projectId: 'destination',
      worktreeId: 'destination-wt',
      healthIssue: { code: 'git-error' },
    });
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]).toMatchObject({ success: false });
    expect(completionEvents[0]?.error).toContain(
      'migrated-item rollback failed',
    );
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
  });

  it('claims archive-only destination ids until their background phase settles', async () => {
    const secondSource: MultiRepoSidebarItem = {
      ...sourceWorkspace,
      id: 'source-two',
    };
    listWorkspaceItemsMock.mockResolvedValue([
      sourceWorkspace,
      secondSource,
      destinationWorkspace,
    ]);
    readWorkspaceConfigMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === destinationWorkspace.id
          ? { ...destinationConfig, archiveRetentionDays: 30 }
          : sourceConfig,
      ),
    );
    resolveArchiveRetentionDaysMock.mockReturnValue(30);
    let finishFirstMigration: ((value: Map<string, never>) => void) | undefined;
    let signalFirstMigration: () => void = () => {};
    const firstMigrationStarted = new Promise<void>((resolve) => {
      signalFirstMigration = resolve;
    });
    migrateSplitPipelineExecutionsMock
      .mockImplementationOnce(() => {
        signalFirstMigration();
        return new Promise<Map<string, never>>((resolve) => {
          finishFirstMigration = resolve;
        });
      })
      .mockResolvedValue(new Map());

    const first = await splitTemporaryWorkspaceWorktree(request('remove'));
    await firstMigrationStarted;
    const second = await splitTemporaryWorkspaceWorktree({
      ...request('split'),
      workspaceId: secondSource.id,
    });

    expect(first.results[0]?.destinationWorktreeId).toBeUndefined();
    expect(second.results[0]?.destinationWorktreeId).toBe('destination-wt-2');
    expect(allocateAdhocDestinationWorktreeIdMock).toHaveBeenNthCalledWith(
      2,
      'destination',
      'source-wt',
      expect.any(Set),
    );

    if (!finishFirstMigration) {
      throw new Error('Expected the first execution migration to be pending');
    }
    finishFirstMigration(new Map());
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(archiveSingleRepoWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        retainAsArchivedContainer: true,
        requireArchivedContainer: true,
      }),
    );
  });

  // The mixed delete-then-archive scenarios that used to live here required a
  // destination workspace with retention disabled. Deletion retention is
  // always on now, so every removed repo archives and the hard-delete removal
  // mode is unreachable from the split flow.

  it('restores later archive targets before returning from an earlier fatal archive', async () => {
    const completions: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await startMixedArchiveFailureSplit(completions);
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(undoSplitChatsAndPlansTargetMigrationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repoId: 'repo-later' }),
    );
    expect(restoreSplitExecutionSnapshotsForTargetMock).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({ repoId: 'repo-later' }),
    );
    expect(archiveSingleRepoWorktreeMock).toHaveBeenCalledTimes(1);
    expect(completions).toEqual([expect.objectContaining({ success: false })]);
    expect(archiveMultiRepoWorktreeMock).not.toHaveBeenCalled();
  });

  it('does not reuse a separate clone of the same remote repository', async () => {
    listWorkspaceItemsMock.mockResolvedValue([
      sourceWorkspace,
      { ...destinationWorkspace, repoPath: '/other-clone' },
    ]);
    getGitCommonDirMock.mockImplementation((repoPath: string) =>
      Promise.resolve(
        repoPath === '/repo' ? '/repo/.git' : '/other-clone/.git',
      ),
    );

    const preview = await previewSplitTemporaryWorkspaceWorktree({
      workspaceId: 'source',
      worktreeId: 'source-wt',
    });

    expect(preview.repos[0]?.destinationWorkspaceId).toBeUndefined();
  });

  it('always requires a root disposition for potentially unmanaged files', async () => {
    const preview = await previewSplitTemporaryWorkspaceWorktree({
      workspaceId: 'source',
      worktreeId: 'source-wt',
    });

    expect(preview.root.present).toBe(true);
    expect(preview.root.chats.count).toBe(0);
    expect(preview.root.pipelines.count).toBe(0);
    expect(preview.root.plans.count).toBe(0);
    expect(preview.root.attachments.count).toBe(0);
  });

  it('changes the preview revision when persisted item identity changes', async () => {
    const emptyItems = {
      chatTabs: [],
      archivedChats: [],
      fileTabs: [],
      executions: [],
      plans: [],
    };
    analyzeSplitWorktreeItemsMock
      .mockResolvedValueOnce({
        perRepo: new Map(),
        root: { ...emptyItems, attachmentNames: ['before.txt'] },
      })
      .mockResolvedValueOnce({
        perRepo: new Map(),
        root: { ...emptyItems, attachmentNames: ['after.txt'] },
      });

    const before = await previewSplitTemporaryWorkspaceWorktree({
      workspaceId: 'source',
      worktreeId: 'source-wt',
    });
    const after = await previewSplitTemporaryWorkspaceWorktree({
      workspaceId: 'source',
      worktreeId: 'source-wt',
    });

    expect(after.previewRevision).not.toBe(before.previewRevision);
  });

  it('waits for the pending execution restore before reporting a failed archive rollback', async () => {
    resolveArchiveRetentionDaysMock.mockReturnValue(30);
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    archiveSingleRepoWorktreeMock.mockRejectedValueOnce(
      new Error('archive failed'),
    );
    const rollback = holdTargetRollback('repo', 'repo');
    const completions: SplitTemporaryWorkspaceCompleteEvent[] = [];
    const failures: unknown[] = [];

    await splitTemporaryWorkspaceWorktree(request('remove'), {
      onSplitWorktreeFailed: (event) => failures.push(event),
      onComplete: (event) => completions.push(event),
    });
    await flushBackgroundWork();

    expect(restoreSplitExecutionSnapshotsForTargetMock).toHaveBeenCalled();
    expect(rollback.finished).toBe(false);
    expect(failures).toEqual([]);
    expect(completions).toEqual([]);

    rollback.release();
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(rollback.finished).toBe(true);
    expect(failures).toHaveLength(1);
    expect(completions).toEqual([expect.objectContaining({ success: false })]);
    expect(completions[0]?.error).toContain('repo item restore failed');
  });

  it('waits for the pending execution restore of a later archive target before reporting', async () => {
    const rollback = holdTargetRollback('repo-later', 'repo-later');
    const completions: SplitTemporaryWorkspaceCompleteEvent[] = [];

    await startMixedArchiveFailureSplit(completions);
    await flushBackgroundWork();

    expect(restoreSplitExecutionSnapshotsForTargetMock).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({ repoId: 'repo-later' }),
    );
    expect(rollback.finished).toBe(false);
    expect(completions).toEqual([]);

    rollback.release();
    await drainSplitTemporaryWorkspaceBackgroundPhases(1_000);

    expect(rollback.finished).toBe(true);
    expect(completions).toEqual([expect.objectContaining({ success: false })]);
    expect(completions[0]?.warnings.join('\n')).toContain(
      'repo-later item restore failed',
    );
  });
  it('rejects a new split after shutdown begins', async () => {
    beginSplitTemporaryWorkspaceShutdown();

    await expect(
      splitTemporaryWorkspaceWorktree(request('split')),
    ).rejects.toThrow('app is shutting down');
    expect(acquireSplitLockMock).not.toHaveBeenCalled();
  });
});
