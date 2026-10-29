import type * as DestructiveRecovery from '../w5-destructive-recovery';
import { destructiveCleanup } from '../w5-destructive-recovery';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../w5-destructive-recovery',
  ),
  readDestructiveRecovery: jest.fn(() => Promise.resolve(null)),
  assertNoDestructiveRecovery: jest.fn(() => Promise.resolve()),
  assertNoLegacyArchiveRecovery: jest.fn(() => Promise.resolve()),
  refuseInterruptedArchiveJournal: jest.fn(() => Promise.resolve()),
  findCompletedDestructiveArchive: jest.fn(() => Promise.resolve(null)),
  reportDestructiveRecovery: jest.fn(() => Promise.resolve([])),
  withDestructiveLifecycle: (
    _input: unknown,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveStep: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveCall: (
    _phase: string,
    work: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ): Promise<unknown> => work(...args),
  hasDestructiveLifecycle: (): boolean => false,
  assertDestructiveRowIdentity: (): void => {},
  acknowledgeArchiveCaptureRefusal: (): void => {},
  protectDestructivePath: (): Promise<void> => Promise.resolve(),
  markDestructiveCleanupRequired: (): void => {},
  destructiveCleanup: jest.fn(
    (_phase: string, work: () => Promise<unknown>): Promise<unknown> => work(),
  ),
}));
// Native profile transactions are exercised with real registries in browser-profile-service.test.ts.
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() =>
    Promise.resolve('profile-retirement'),
  ),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
import { rm } from 'node:fs/promises';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
  type ArchivedContainerManifest,
  type SidebarItem,
  type SidebarItemsFile,
} from '@canopy/desktop-shared/types';
import {
  deleteWorkspace,
  deleteWorkspaceById,
  WorkspaceDeletionRefusedError,
} from '../workspace-deletion';
import { setDelegationActivity } from '../../agents/delegation/activity';
import { destroyWorktreeSessions } from '../../agents/session-manager';
import { deleteCoworkWorkspace } from '../cowork-workspace-crud';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import { getWorkspaceDir } from '../paths';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  removeWorkspaceIndexEntry,
} from '../sidebar-items';
import { acquireWorkspaceDeletionLease } from '../../services/split-lock-service';
import {
  listArchivedContainerManifestsStrict,
  withArchivedWorkspaceOperationLock,
} from '../archived-containers';
import { releaseArchivedGitState } from '../archived-container-git';
import { finishArchivedContainerRecovery } from '../archived-container-recovery';
import { serializeChatProjectOperation } from '../chat-project-operation-queue';
import { archiveWorkspaceWorktrees } from '../worktree-archive';
import {
  captureLedgerWorkspaceIncarnations,
  notifyLedgerWorkspaceDeleted,
  type LedgerWorkspaceCapture,
} from '../../ledger/lifecycle';
import { readThroughProjectPluginDefaults } from '../../plugins/project-plugin-defaults-cache';

jest.mock('node:fs/promises', () => ({ rm: jest.fn() }));
jest.mock('../../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn(),
}));
jest.mock('../cowork-workspace-crud', () => ({
  deleteCoworkWorkspace: jest.fn(),
}));
jest.mock('../cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(() => Promise.resolve(['entry-1'])),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../paths', () => ({
  getWorkspaceIndexFilePath: jest.fn(() => '/data/workspaces/index.json'),
  getDefaultReposDir: jest.fn((): string => '/data/repos'),
  getWorkspaceDir: jest.fn((id: string): string => `/data/workspaces/${id}`),
  getWorkspaceConfigPath: jest.fn(
    (id: string): string => `/data/workspaces/${id}/workspace.json`,
  ),
}));
jest.mock('../sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  readWorkspaceIndexEntry: jest.fn(),
  removeWorkspaceIndexEntry: jest.fn(),
}));
jest.mock('../../services/split-lock-service', () => ({
  acquireWorkspaceDeletionLease: jest.fn(() => jest.fn()),
}));
jest.mock('../archived-containers', () => ({
  listArchivedContainerManifestsStrict: jest.fn(() => Promise.resolve([])),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../worktree-archive', () => ({
  archiveWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
}));
jest.mock('../archived-container-git', () => ({
  readArchivedGitStagedDescriptor: jest.fn(() => Promise.resolve(null)),
  releaseArchivedGitState: jest.fn(() => Promise.resolve()),
}));
jest.mock('../archived-container-recovery', () => ({
  finishArchivedContainerRecovery: jest.fn(() => Promise.resolve([])),
}));
const mockedReleaseCodeGraphReadFence = jest.fn();
const mockedFenceCodeGraphReadsForWorkspace = jest.fn<
  () => void,
  [workspaceId: string]
>(() => mockedReleaseCodeGraphReadFence);
const mockedCancelCodeGraphReadsForWorkspace = jest.fn<
  Promise<void>,
  [workspaceId: string]
>(() => Promise.resolve());
jest.mock('../../code-graph/read-runner', () => ({
  fenceCodeGraphReadsForWorkspace: (workspaceId: string): (() => void) =>
    mockedFenceCodeGraphReadsForWorkspace(workspaceId),
  cancelCodeGraphReadsForWorkspace: (workspaceId: string): Promise<void> =>
    mockedCancelCodeGraphReadsForWorkspace(workspaceId),
}));
const mockedDeleteWorkspaceSearchDocs = jest.fn();
const mockedPurgeSkillSuggestions = jest.fn(() =>
  Promise.resolve({
    fingerprintRowsRemoved: 0,
    suggestionsRemoved: 0,
    matchesRemoved: 0,
  }),
);
const mockedCancelLocalWorkspace = jest.fn(() => Promise.resolve());
const mockedCommitLocalWorkspaceCancellation = jest.fn();
const mockedReleaseLocalWorkspaceFence = jest.fn(() => Promise.resolve());
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalWorkspace: mockedCancelLocalWorkspace,
    commitLocalWorkspaceCancellation: mockedCommitLocalWorkspaceCancellation,
    releaseLocalWorkspaceFence: mockedReleaseLocalWorkspaceFence,
  })),
}));
jest.mock('../../skill-suggestions', () => ({
  purgeSkillSuggestionsForWorkspace: (workspaceId: string): Promise<unknown> =>
    mockedPurgeSkillSuggestions(workspaceId),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: mockedDeleteWorkspaceSearchDocs,
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
}));

const mockedRm = jest.mocked(rm);
const mockedDestroySessions = jest.mocked(destroyWorktreeSessions);
const mockedDeleteCowork = jest.mocked(deleteCoworkWorkspace);
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);
const mockedGetWorkspaceDir = jest.mocked(getWorkspaceDir);
const mockedReadItems = jest.mocked(readAllSidebarItems);
const mockedReadIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedRemoveIndex = jest.mocked(removeWorkspaceIndexEntry);
const mockedAcquireWorkspaceDeletionLease = jest.mocked(
  acquireWorkspaceDeletionLease,
);
const mockedListArchivedContainerManifestsStrict = jest.mocked(
  listArchivedContainerManifestsStrict,
);
const mockedWithArchivedWorkspaceOperationLock = jest.mocked(
  withArchivedWorkspaceOperationLock,
);
const mockedReleaseArchivedGitState = jest.mocked(releaseArchivedGitState);
const mockedFinishArchivedContainerRecovery = jest.mocked(
  finishArchivedContainerRecovery,
);
const mockedArchiveWorkspaceWorktrees = jest.mocked(archiveWorkspaceWorktrees);
const mockedCaptureLedger = jest.mocked(captureLedgerWorkspaceIncarnations);
const mockedNotifyLedgerDeleted = jest.mocked(notifyLedgerWorkspaceDeleted);

/** What the Ledger captured of a workspace before its deletion. */
function ledgerCapture(workspaceId: string): LedgerWorkspaceCapture {
  return {
    incarnations: [
      {
        container: {
          kind: 'code_worktree',
          workspaceId,
          worktreeId: 'wt-1',
        },
        containerCreatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };
}

function sidebarFile(items: SidebarItem[]): SidebarItemsFile {
  return { version: 1, items };
}

function coworkItem(id: string): SidebarItem {
  return {
    type: 'cowork',
    id,
    name: id,
    color: '#fff',
    collapsed: false,
    order: 0,
  };
}

function singleRepoItem(id: string): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#fff',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function archivedV2Manifest(): ArchivedContainerManifest {
  return {
    version: 2,
    id: 'archive-1',
    projectId: 'ws-1',
    kind: 'worktree',
    name: 'Archived worktree',
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: '2026-09-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-09-09T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: 'single-repo',
    originalWorktree: {
      id: 'archive-1',
      branchName: 'feature/archive',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    gitState: { version: 1, diffFormatVersion: 1, repositories: [] },
    gitChanges: {
      status: 'complete',
      capturedAt: '2026-09-02T00:00:00.000Z',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: [],
    },
    pullRequestMetadata: {
      capturedAt: '2026-09-02T00:00:00.000Z',
      repositories: [],
    },
  };
}

function archivedV3Manifest(): ArchivedContainerManifest {
  const original = archivedV2Manifest();
  if (original.version !== 2) throw new Error('Expected version-2 manifest');
  return {
    ...original,
    version: 3,
    recovery: {
      kind: 'files-only',
      source: 'partial',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
      gitCleanupPending: true,
    },
  };
}

describe('deleteWorkspaceById', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Drops one-shot implementations a failed test left unconsumed.
    mockedRm.mockReset();
    mockedRemoveIndex.mockReset();
    mockedCancelCodeGraphReadsForWorkspace
      .mockReset()
      .mockResolvedValue(undefined);
    mockedAcquireWorkspaceDeletionLease.mockReturnValue(jest.fn());
    mockedReadIndexEntry.mockResolvedValue(null);
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([]);
  });

  it('rejects an active split before any project deletion side effect', async () => {
    mockedAcquireWorkspaceDeletionLease.mockImplementationOnce(() => {
      throw new Error(
        'Cannot delete a project while one of its worktrees is being split.',
      );
    });

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'Cannot delete a project while one of its worktrees is being split.',
    );

    expect(mockedReadItems).not.toHaveBeenCalled();
    expect(mockedRemoveIndex).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'a code project', item: singleRepoItem('ws-1'), id: 'ws-1' },
    { name: 'a Cowork project', item: coworkItem('ws-1'), id: 'ws-1' },
  ])(
    'refuses to delete $name while one of its chats has live delegates',
    async ({ item, id }) => {
      mockedReadItems.mockResolvedValue(sidebarFile([item]));
      setDelegationActivity('delete-owner', `${id}/entry-1/chat-a`, 1);
      try {
        await expect(deleteWorkspaceById(id, 'portal')).rejects.toMatchObject({
          code: 'conflict',
          message: 'Delegates are still running here. Stop them first.',
        });
      } finally {
        setDelegationActivity('delete-owner', `${id}/entry-1/chat-a`, 0);
      }
      expect(mockedDestroySessions).not.toHaveBeenCalled();
      expect(mockedDeleteCowork).not.toHaveBeenCalled();
      expect(mockedRemoveIndex).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
    },
  );

  it('deletes a project while only another project has live delegates', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    setDelegationActivity('delete-owner', 'ws-2/wt-1/chat-a', 1);
    try {
      await deleteWorkspaceById('ws-1', 'portal');
    } finally {
      setDelegationActivity('delete-owner', 'ws-2/wt-1/chat-a', 0);
    }
    expect(mockedRemoveIndex).toHaveBeenCalled();
    expect(mockedRm).toHaveBeenCalled();
  });

  it('removes the persisted directory for a non-cowork project and records telemetry', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));

    await deleteWorkspaceById('ws-1', 'portal');

    expect(mockedCancelLocalWorkspace).toHaveBeenCalledWith('ws-1');
    expect(mockedCancelLocalWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mockedRm.mock.invocationCallOrder[0],
    );
    expect(mockedCommitLocalWorkspaceCancellation).toHaveBeenCalledWith('ws-1');
    expect(mockedReleaseLocalWorkspaceFence).not.toHaveBeenCalled();
    expect(mockedGetWorkspaceDir).toHaveBeenCalledWith('ws-1');
    expect(mockedRemoveIndex).toHaveBeenCalledWith('ws-1');
    expect(mockedRm).toHaveBeenCalledWith('/data/workspaces/ws-1', {
      recursive: true,
      force: true,
    });
    expect(mockedDestroySessions).not.toHaveBeenCalled();
    expect(mockedDeleteCowork).not.toHaveBeenCalled();
    expect(mockedDeleteWorkspaceSearchDocs).toHaveBeenCalledWith('ws-1');
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'ws-1',
      source: 'portal',
    });
  });

  it("stops the project's code-graph readers before the sidebar commit and the directory removal", async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    let readersExited = false;
    mockedCancelCodeGraphReadsForWorkspace.mockImplementationOnce(
      async (): Promise<void> => {
        await Promise.resolve();
        readersExited = true;
      },
    );
    mockedRemoveIndex.mockImplementationOnce((): Promise<boolean> => {
      expect(readersExited).toBe(true);
      return Promise.resolve(true);
    });
    mockedRm.mockImplementationOnce((): Promise<boolean> => {
      expect(readersExited).toBe(true);
      expect(mockedReleaseCodeGraphReadFence).not.toHaveBeenCalled();
      return Promise.resolve(true);
    });

    await deleteWorkspaceById('ws-1', 'portal');

    expect(mockedFenceCodeGraphReadsForWorkspace).toHaveBeenCalledWith('ws-1');
    expect(mockedCancelCodeGraphReadsForWorkspace).toHaveBeenCalledWith('ws-1');
    expect(
      mockedFenceCodeGraphReadsForWorkspace.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCancelCodeGraphReadsForWorkspace.mock.invocationCallOrder[0],
    );
    expect(mockedRm).toHaveBeenCalledWith('/data/workspaces/ws-1', {
      recursive: true,
      force: true,
    });
    expect(mockedReleaseCodeGraphReadFence).toHaveBeenCalledTimes(1);
    expect(
      mockedReleaseCodeGraphReadFence.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockedRm.mock.invocationCallOrder[0]);
  });

  it('releases the code-graph read fence when the project deletion fails', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedRemoveIndex.mockRejectedValueOnce(new Error('disk full'));

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'disk full',
    );

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedReleaseCodeGraphReadFence).toHaveBeenCalledTimes(1);
  });

  it('drops the cached plugin defaults of a removed project', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    const configPath = '/data/workspaces/ws-1/workspace.json';
    await readThroughProjectPluginDefaults(configPath, () =>
      Promise.resolve({
        defaults: {
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plug-a' }],
          },
        },
        cacheable: true,
      }),
    );

    await deleteWorkspaceById('ws-1', 'portal');

    const reload = jest.fn(() =>
      Promise.resolve({ defaults: {}, cacheable: true }),
    );
    expect(await readThroughProjectPluginDefaults(configPath, reload)).toEqual(
      {},
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight template install before deleting a project', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    let releaseInstall!: () => void;
    let markInstallStarted!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const install = serializeChatProjectOperation(async () => {
      markInstallStarted();
      await installGate;
    });
    await installStarted;

    const deletion = deleteWorkspaceById('ws-1', 'portal');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedAcquireWorkspaceDeletionLease).not.toHaveBeenCalled();
    expect(mockedRemoveIndex).not.toHaveBeenCalled();

    releaseInstall();
    await Promise.all([install, deletion]);
    expect(mockedRemoveIndex).toHaveBeenCalledTimes(1);
  });

  it('releases retained Git refs only after removing the project directory', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([
      archivedV2Manifest(),
    ]);

    await deleteWorkspaceById('ws-1', 'portal');

    expect(mockedReleaseArchivedGitState).toHaveBeenCalledWith({
      version: 1,
      diffFormatVersion: 1,
      repositories: [],
    });
    expect(mockedRm.mock.invocationCallOrder[0]).toBeLessThan(
      mockedReleaseArchivedGitState.mock.invocationCallOrder[0],
    );
  });

  it('preserves a version-3 retry record when Git cleanup cannot finish', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    const manifest = archivedV3Manifest();
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([manifest]);
    mockedFinishArchivedContainerRecovery.mockImplementationOnce(
      (candidate) => {
        candidate.recovery.gitCleanupPending = true;
        return Promise.resolve([]);
      },
    );

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'Git registration cleanup is still pending',
    );

    expect(mockedFinishArchivedContainerRecovery).toHaveBeenCalledWith(
      manifest,
    );
    expect(mockedRemoveIndex).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedReleaseLocalWorkspaceFence).toHaveBeenCalledWith('ws-1');
  });

  it('finishes version-3 Git cleanup before removing the project directory', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    const manifest = archivedV3Manifest();
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([manifest]);
    mockedFinishArchivedContainerRecovery.mockImplementationOnce(
      (candidate) => {
        candidate.recovery.gitCleanupPending = false;
        return Promise.resolve([]);
      },
    );

    await deleteWorkspaceById('ws-1', 'portal');

    expect(mockedFinishArchivedContainerRecovery).toHaveBeenCalledWith(
      manifest,
    );
    expect(
      mockedFinishArchivedContainerRecovery.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedRm.mock.invocationCallOrder[0]);
  });

  it('holds the archive operation lock through manifest inventory and deletion', async () => {
    let archiveLockHeld = false;
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedWithArchivedWorkspaceOperationLock.mockImplementationOnce(
      async (_workspaceId, operation) => {
        archiveLockHeld = true;
        try {
          return await operation();
        } finally {
          archiveLockHeld = false;
        }
      },
    );
    mockedListArchivedContainerManifestsStrict.mockImplementationOnce(() => {
      expect(archiveLockHeld).toBe(true);
      return Promise.resolve([archivedV2Manifest()]);
    });
    mockedRm.mockImplementationOnce(() => {
      expect(archiveLockHeld).toBe(true);
      return Promise.resolve(true);
    });
    mockedReleaseArchivedGitState.mockImplementationOnce(() => {
      expect(archiveLockHeld).toBe(true);
      return Promise.resolve(true);
    });

    await deleteWorkspaceById('ws-1', 'portal');

    expect(mockedWithArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      'ws-1',
      expect.any<() => Promise<void>>(Function),
    );
  });

  it('does not release retained refs when parent deletion fails', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([
      archivedV2Manifest(),
    ]);
    mockedRm.mockRejectedValueOnce(new Error('remove failed'));

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'remove failed',
    );

    expect(mockedReleaseArchivedGitState).not.toHaveBeenCalled();
  });

  it('keeps parent deletion successful when retained-ref cleanup fails', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedListArchivedContainerManifestsStrict.mockResolvedValue([
      archivedV2Manifest(),
    ]);
    mockedReleaseArchivedGitState.mockRejectedValueOnce(
      new Error('release failed'),
    );

    await expect(
      deleteWorkspaceById('ws-1', 'portal'),
    ).resolves.toBeUndefined();
    expect(mockedReleaseArchivedGitState).toHaveBeenCalledTimes(1);
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'ws-1',
      source: 'portal',
    });
  });

  it('preserves the workspace when retained-ref inventory fails', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedListArchivedContainerManifestsStrict.mockRejectedValueOnce(
      new Error('inventory failed'),
    );

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'inventory failed',
    );

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedReleaseArchivedGitState).not.toHaveBeenCalled();
    expect(mockedReleaseLocalWorkspaceFence).toHaveBeenCalledWith('ws-1');
  });

  it('retains the watcher fence when cancellation commit fails after project removal', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
    mockedCommitLocalWorkspaceCancellation.mockRejectedValueOnce(
      new Error('watcher commit failed'),
    );

    await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
      'watcher commit failed',
    );

    expect(mockedRm).toHaveBeenCalled();
    expect(mockedReleaseLocalWorkspaceFence).not.toHaveBeenCalled();
  });

  it('routes a cowork project through session teardown + cowork delete (never rm)', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([coworkItem('cw-1')]));

    await deleteWorkspaceById('cw-1', 'portal');

    // Sessions tear down per work entry, plus the legacy pre-entry slot.
    expect(mockedDestroySessions).toHaveBeenCalledWith('cw-1', 'entry-1');
    expect(mockedDestroySessions).toHaveBeenCalledWith(
      'cw-1',
      COWORK_HOME_WORKTREE_ID,
    );
    expect(mockedDeleteCowork).toHaveBeenCalledWith(
      'cw-1',
      expect.objectContaining({ deferLocalWatcherCancellationCommit: true }),
    );
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedDeleteWorkspaceSearchDocs).toHaveBeenCalledWith('cw-1');
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'cw-1',
      source: 'portal',
    });
  });

  it('routes a failed cowork load using the persisted index entry', async () => {
    mockedReadItems.mockResolvedValue({
      version: 1,
      items: [],
      warnings: [
        {
          code: 'workspace-load-failed',
          workspaceId: 'cw-failed',
          workspaceName: 'Failed Cowork',
          reason: 'transient read failure',
        },
      ],
    });
    mockedReadIndexEntry.mockResolvedValue({
      id: 'cw-failed',
      name: 'Failed Cowork',
      type: 'cowork',
      color: '#fff',
      collapsed: false,
      order: 0,
    });

    await deleteWorkspaceById('cw-failed', 'portal');

    expect(mockedDestroySessions).toHaveBeenCalledWith(
      'cw-failed',
      COWORK_HOME_WORKTREE_ID,
    );
    expect(mockedDeleteCowork).toHaveBeenCalledWith(
      'cw-failed',
      expect.objectContaining({ deferLocalWatcherCancellationCommit: true }),
    );
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('treats an unknown project as non-cowork (removes the directory)', async () => {
    mockedReadItems.mockResolvedValue(sidebarFile([]));

    await deleteWorkspaceById('ws-missing', 'multi_repo_workspace_delete');

    expect(mockedRemoveIndex).toHaveBeenCalledWith('ws-missing');
    expect(mockedRm).toHaveBeenCalledWith('/data/workspaces/ws-missing', {
      recursive: true,
      force: true,
    });
    expect(mockedDeleteCowork).not.toHaveBeenCalled();
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'ws-missing',
      source: 'multi_repo_workspace_delete',
    });
  });

  describe('Ledger lifecycle participant', () => {
    beforeEach(() => {
      mockedCaptureLedger.mockImplementation((workspaceId) =>
        Promise.resolve(ledgerCapture(workspaceId)),
      );
    });

    it('captures the contents before deleting and retires them once the deletion commits', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
      const manifest = archivedV2Manifest();
      mockedListArchivedContainerManifestsStrict.mockResolvedValue([manifest]);

      await deleteWorkspaceById('ws-1', 'portal');

      // The capture reads the archive manifests the deletion already listed.
      expect(mockedCaptureLedger).toHaveBeenCalledWith('ws-1', [manifest]);
      expect(mockedCaptureLedger.mock.invocationCallOrder[0]).toBeLessThan(
        mockedRemoveIndex.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mockedNotifyLedgerDeleted).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerDeleted).toHaveBeenCalledWith(
        ledgerCapture('ws-1'),
      );
      expect(
        mockedNotifyLedgerDeleted.mock.invocationCallOrder[0],
      ).toBeGreaterThan(mockedRm.mock.invocationCallOrder[0] ?? 0);
    });

    it('retires a Cowork workspace’s contents once the Cowork deletion commits', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([coworkItem('cw-1')]));

      await deleteWorkspaceById('cw-1', 'portal');

      expect(mockedCaptureLedger.mock.invocationCallOrder[0]).toBeLessThan(
        mockedDeleteCowork.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mockedNotifyLedgerDeleted).toHaveBeenCalledWith(
        ledgerCapture('cw-1'),
      );
      expect(
        mockedNotifyLedgerDeleted.mock.invocationCallOrder[0],
      ).toBeGreaterThan(mockedDeleteCowork.mock.invocationCallOrder[0] ?? 0);
    });

    it('retires nothing when the deletion does not commit', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
      mockedRm.mockRejectedValueOnce(new Error('remove failed'));

      await expect(deleteWorkspaceById('ws-1', 'portal')).rejects.toThrow(
        'remove failed',
      );

      expect(mockedNotifyLedgerDeleted).not.toHaveBeenCalled();
    });

    it('deletes the workspace when the capture or the participant fails', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
      mockedCaptureLedger.mockRejectedValueOnce(
        new Error('Ledger read defect'),
      );
      mockedNotifyLedgerDeleted.mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        deleteWorkspaceById('ws-1', 'portal'),
      ).resolves.toBeUndefined();

      expect(mockedRm).toHaveBeenCalled();
      // Nothing was captured, so the startup pass settles the scopes.
      expect(mockedNotifyLedgerDeleted).toHaveBeenCalledWith(null);
      expect(mockedCommitLocalWorkspaceCancellation).toHaveBeenCalledWith(
        'ws-1',
      );
    });
  });

  it('rejects a malformed project id before any deletion', async () => {
    await expect(deleteWorkspaceById('Bad Id!', 'portal')).rejects.toThrow();

    expect(mockedReadItems).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedDeleteCowork).not.toHaveBeenCalled();
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });

  it.each([
    DEFAULT_COWORK_WORKSPACE_ID,
    'cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ])(
    'rejects deleting default cowork project %s before tearing down sessions',
    async (workspaceId) => {
      await expect(deleteWorkspaceById(workspaceId, 'portal')).rejects.toThrow(
        'The Chats project cannot be deleted',
      );

      expect(mockedReadItems).not.toHaveBeenCalled();
      expect(mockedDestroySessions).not.toHaveBeenCalled();
      expect(mockedDeleteCowork).not.toHaveBeenCalled();
      expect(mockedTelemetry).not.toHaveBeenCalled();
    },
  );

  describe('typed deletion boundary (CAN-3809)', () => {
    function managedSingleRepoItem(id: string): SidebarItem {
      return { ...singleRepoItem(id), repoPath: `/data/repos/${id}` };
    }

    function multiRepoItem(id: string): SidebarItem {
      return {
        type: 'multi-repo',
        id,
        name: id,
        repos: [],
        color: '#fff',
        worktrees: [],
        collapsed: false,
        order: 0,
      };
    }

    it('reports what it removed and every post-commit cleanup', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
      mockedListArchivedContainerManifestsStrict.mockResolvedValue([
        archivedV2Manifest(),
      ]);

      await expect(
        deleteWorkspace({ workspaceId: 'ws-1', source: 'portal' }),
      ).resolves.toEqual({
        workspaceId: 'ws-1',
        removed: 'code',
        cleanup: {
          archivedGitRefs: { status: 'done' },
          chatSearchRows: { status: 'done' },
          managedRepository: { status: 'skipped' },
          skillSuggestions: { status: 'done' },
        },
      });
      expect(mockedPurgeSkillSuggestions).toHaveBeenCalledWith('ws-1');
    });

    it('reports failed post-commit cleanup without failing the committed deletion', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([coworkItem('cw-1')]));
      mockedListArchivedContainerManifestsStrict.mockResolvedValue([
        archivedV2Manifest(),
      ]);
      const releaseError = new Error('release failed');
      const searchError = new Error('search failed');
      mockedReleaseArchivedGitState.mockRejectedValueOnce(releaseError);
      mockedDeleteWorkspaceSearchDocs.mockRejectedValueOnce(searchError);
      const suggestionError = new Error('suggestion purge failed');
      mockedPurgeSkillSuggestions.mockRejectedValueOnce(suggestionError);

      const outcome = await deleteWorkspace({
        workspaceId: 'cw-1',
        source: 'portal',
      });

      expect(outcome).toEqual({
        workspaceId: 'cw-1',
        removed: 'cowork',
        cleanup: {
          archivedGitRefs: { status: 'failed', error: releaseError },
          chatSearchRows: { status: 'failed', error: searchError },
          managedRepository: { status: 'skipped' },
          skillSuggestions: { status: 'failed', error: suggestionError },
        },
      });
      // Rebuildable suggestion data never marks the journal for recovery.
      expect(jest.mocked(destructiveCleanup)).not.toHaveBeenCalledWith(
        'skill-suggestions',
        expect.anything(),
      );
      expect(mockedNotifyLedgerDeleted).toHaveBeenCalled();
    });

    it('reports an id with no index entry as unindexed', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([]));

      await expect(
        deleteWorkspace({ workspaceId: 'ws-missing', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'unindexed' });
    });

    it('refuses a protected project with a typed refusal', async () => {
      await expect(
        deleteWorkspace({
          workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
          source: 'portal',
        }),
      ).rejects.toMatchObject({
        name: 'WorkspaceDeletionRefusedError',
        reason: 'protected',
      });
    });

    it('refuses with a typed refusal while Git cleanup is pending', async () => {
      mockedReadItems.mockResolvedValue(sidebarFile([singleRepoItem('ws-1')]));
      mockedListArchivedContainerManifestsStrict.mockResolvedValue([
        archivedV3Manifest(),
      ]);

      const result = deleteWorkspace({ workspaceId: 'ws-1', source: 'portal' });

      await expect(result).rejects.toBeInstanceOf(
        WorkspaceDeletionRefusedError,
      );
      await expect(result).rejects.toMatchObject({
        reason: 'git-cleanup-pending',
      });
      expect(mockedRm).not.toHaveBeenCalled();
    });

    describe('archives the live worktrees first (CAN-3799 B2)', () => {
      it.each([
        ['single-repo', singleRepoItem('ws-1')],
        ['multi-repo', multiRepoItem('ws-1')],
      ] as const)(
        'archives a %s project’s worktrees before taking the archive lock',
        async (kind, item) => {
          let archiveLockHeld = false;
          mockedReadItems.mockResolvedValue(sidebarFile([item]));
          mockedWithArchivedWorkspaceOperationLock.mockImplementationOnce(
            async (_workspaceId, operation) => {
              archiveLockHeld = true;
              try {
                return await operation();
              } finally {
                archiveLockHeld = false;
              }
            },
          );
          mockedArchiveWorkspaceWorktrees.mockImplementationOnce(() => {
            // Each archive drains the worktree's activity, and an activity
            // touch waits for the archive lock.
            expect(archiveLockHeld).toBe(false);
            return Promise.resolve();
          });

          await deleteWorkspace({ workspaceId: 'ws-1', source: 'portal' });

          expect(mockedArchiveWorkspaceWorktrees).toHaveBeenCalledWith(
            'ws-1',
            kind,
          );
          const [archived] =
            mockedArchiveWorkspaceWorktrees.mock.invocationCallOrder;
          // The inventory then includes the new archives, so their refs are
          // released once the deletion commits.
          expect(archived).toBeLessThan(
            mockedListArchivedContainerManifestsStrict.mock
              .invocationCallOrder[0],
          );
          expect(archived).toBeLessThan(
            mockedRemoveIndex.mock.invocationCallOrder[0],
          );
        },
      );

      it.each([
        'shared_container_fork',
        'org-member-multi-repo-create',
      ] as const)(
        'archives nothing when rolling back a %s creation',
        async (source) => {
          mockedReadItems.mockResolvedValue(
            sidebarFile([singleRepoItem('ws-1')]),
          );

          await deleteWorkspace({ workspaceId: 'ws-1', source });

          // Its scripts never had the user's consent to run.
          expect(mockedArchiveWorkspaceWorktrees).not.toHaveBeenCalled();
          expect(mockedRm).toHaveBeenCalled();
        },
      );

      it.each([
        ['a Cowork project', [coworkItem('ws-1')]],
        ['an unindexed id', []],
      ])('archives nothing for %s', async (_label, items) => {
        mockedReadItems.mockResolvedValue(sidebarFile(items));

        await deleteWorkspace({ workspaceId: 'ws-1', source: 'portal' });

        expect(mockedArchiveWorkspaceWorktrees).not.toHaveBeenCalled();
      });

      it('removes nothing more when a worktree cannot be archived', async () => {
        mockedReadItems.mockResolvedValue(
          sidebarFile([singleRepoItem('ws-1')]),
        );
        const teardownError = new Error(
          'Project deletion teardown failed: exit 1',
        );
        mockedArchiveWorkspaceWorktrees.mockRejectedValueOnce(teardownError);

        await expect(
          deleteWorkspace({ workspaceId: 'ws-1', source: 'portal' }),
        ).rejects.toBe(teardownError);

        expect(
          mockedListArchivedContainerManifestsStrict,
        ).not.toHaveBeenCalled();
        expect(mockedRemoveIndex).not.toHaveBeenCalled();
        expect(mockedRm).not.toHaveBeenCalled();
        expect(mockedReleaseArchivedGitState).not.toHaveBeenCalled();
        expect(mockedTelemetry).not.toHaveBeenCalled();
        expect(mockedReleaseLocalWorkspaceFence).toHaveBeenCalledWith('ws-1');
      });
    });

    describe('a single-repo project deletion (project:delete, CAN-3799 B6)', () => {
      it.each([
        ['a multi-repo project', multiRepoItem('ws-1')],
        ['a Cowork project', coworkItem('ws-1')],
      ])('refuses %s before any destructive step', async (_label, item) => {
        mockedReadItems.mockResolvedValue(sidebarFile([item]));

        await expect(
          deleteWorkspace({
            workspaceId: 'ws-1',
            source: 'single_repo_project_delete',
            singleRepoProject: true,
          }),
        ).rejects.toMatchObject({ reason: 'not-single-repo' });

        expect(mockedArchiveWorkspaceWorktrees).not.toHaveBeenCalled();
        expect(mockedRemoveIndex).not.toHaveBeenCalled();
        expect(mockedRm).not.toHaveBeenCalled();
        expect(mockedDeleteCowork).not.toHaveBeenCalled();
        expect(mockedDestroySessions).not.toHaveBeenCalled();
        expect(mockedReleaseLocalWorkspaceFence).toHaveBeenCalledWith('ws-1');
      });

      it('refuses while the project configuration failed to load', async () => {
        mockedReadItems.mockResolvedValue({
          version: 1,
          items: [],
          warnings: [
            {
              code: 'workspace-load-failed',
              workspaceId: 'ws-1',
              workspaceName: 'Project',
              reason: 'transient read failure',
            },
          ],
        });
        mockedReadIndexEntry.mockResolvedValue({
          id: 'ws-1',
          name: 'Project',
          type: 'single-repo',
          color: '#fff',
          collapsed: false,
          order: 0,
        });

        await expect(
          deleteWorkspace({
            workspaceId: 'ws-1',
            source: 'single_repo_project_delete',
            singleRepoProject: true,
          }),
        ).rejects.toMatchObject({
          reason: 'configuration-unavailable',
          message:
            'Cannot delete this project while its configuration is unavailable. Reload and try again.',
        });
        expect(mockedArchiveWorkspaceWorktrees).not.toHaveBeenCalled();
        expect(mockedRemoveIndex).not.toHaveBeenCalled();
        expect(mockedRm).not.toHaveBeenCalled();
      });

      it('holds the deletion lease until the deletion finishes', async () => {
        mockedReadItems.mockResolvedValue(
          sidebarFile([managedSingleRepoItem('ws-1')]),
        );
        const releaseLease = jest.fn();
        mockedAcquireWorkspaceDeletionLease.mockReturnValue(releaseLease);

        await deleteWorkspace({
          workspaceId: 'ws-1',
          source: 'single_repo_project_delete',
          singleRepoProject: true,
        });

        expect(releaseLease).toHaveBeenCalledTimes(1);
        expect(releaseLease.mock.invocationCallOrder[0]).toBeGreaterThan(
          Math.max(...mockedRm.mock.invocationCallOrder),
        );
      });

      it('runs the full cleanup and removes the repository the app created', async () => {
        mockedReadItems.mockResolvedValue(
          sidebarFile([managedSingleRepoItem('ws-1')]),
        );

        const outcome = await deleteWorkspace({
          workspaceId: 'ws-1',
          source: 'single_repo_project_delete',
          singleRepoProject: true,
        });

        expect(outcome.cleanup.managedRepository).toEqual({ status: 'done' });
        expect(mockedRm).toHaveBeenNthCalledWith(1, '/data/workspaces/ws-1', {
          recursive: true,
          force: true,
        });
        expect(mockedRm).toHaveBeenNthCalledWith(2, '/data/repos/ws-1', {
          recursive: true,
          force: true,
        });
        expect(mockedFenceCodeGraphReadsForWorkspace).toHaveBeenCalledWith(
          'ws-1',
        );
        expect(mockedNotifyLedgerDeleted).toHaveBeenCalled();
        expect(mockedDeleteWorkspaceSearchDocs).toHaveBeenCalledWith('ws-1');
        expect(mockedTelemetry).toHaveBeenCalledWith({
          action: 'delete',
          workspaceId: 'ws-1',
          source: 'single_repo_project_delete',
        });
      });

      it.each([
        ['outside the managed repos directory', '/repos/ws-1'],
        ['the managed repos directory itself', '/data/repos'],
      ])('never removes a repository %s', async (_label, repoPath) => {
        mockedReadItems.mockResolvedValue(
          sidebarFile([{ ...singleRepoItem('ws-1'), repoPath }]),
        );

        const outcome = await deleteWorkspace({
          workspaceId: 'ws-1',
          source: 'single_repo_project_delete',
          singleRepoProject: true,
        });

        expect(outcome.cleanup.managedRepository).toEqual({
          status: 'skipped',
        });
        expect(mockedRm).toHaveBeenCalledTimes(1);
      });

      it('removes nothing but the data directory for an unindexed id', async () => {
        mockedReadItems.mockResolvedValue(sidebarFile([]));

        await expect(
          deleteWorkspace({
            workspaceId: 'ws-missing',
            source: 'single_repo_project_delete',
            singleRepoProject: true,
          }),
        ).resolves.toMatchObject({
          removed: 'unindexed',
          cleanup: { managedRepository: { status: 'skipped' } },
        });
        expect(mockedRm).toHaveBeenCalledTimes(1);
      });

      it('reports a failed repository removal after the deletion commits', async () => {
        mockedReadItems.mockResolvedValue(
          sidebarFile([managedSingleRepoItem('ws-1')]),
        );
        const removeError = new Error('EBUSY');
        mockedRm
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(removeError);

        const outcome = await deleteWorkspace({
          workspaceId: 'ws-1',
          source: 'single_repo_project_delete',
          singleRepoProject: true,
        });

        expect(outcome.cleanup.managedRepository).toEqual({
          status: 'failed',
          error: removeError,
        });
        expect(mockedNotifyLedgerDeleted).toHaveBeenCalled();
        expect(mockedCommitLocalWorkspaceCancellation).toHaveBeenCalledWith(
          'ws-1',
        );
      });
    });
  });
});
