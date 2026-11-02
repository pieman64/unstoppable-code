// Native profile transactions are exercised with real registries in browser-profile-service.test.ts.
jest.mock('../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() =>
    Promise.resolve('profile-retirement'),
  ),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
const emitEntrySummaryMock = jest.fn(() => Promise.resolve());
const emitRemovalsMock = jest.fn();
const emitWorkspaceSummariesMock = jest.fn(() => Promise.resolve());
jest.mock('../services/standalone-chat-service', () => ({
  emitStandaloneWorkEntrySummary: emitEntrySummaryMock,
  emitStandaloneChatRemovals: emitRemovalsMock,
  emitStandaloneWorkspaceWorkEntrySummaries: emitWorkspaceSummariesMock,
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn(() => Promise.resolve()),
  getActiveChatIds: jest.fn(() => []),
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  listWorkEntries: jest.fn(),
  listWorkEntryChatSummaries: jest.fn(() =>
    Promise.resolve([
      {
        entryId: 'entry-1',
        title: 'Entry',
        chats: [{ id: 'chat-1' }, { id: 'chat-2' }],
      },
    ]),
  ),
  onWorkEntryListChanged: jest.fn(() => (): void => undefined),
  removeWorkEntryRow: jest.fn(() => Promise.resolve()),
  reorderWorkEntries: jest.fn(() => Promise.resolve()),
  resolveWorkEntryForChat: jest.fn(),
  updateWorkEntry: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn((id: string) => id),
}));
const refreshWorktreeMetadataMock = jest.fn(() => Promise.resolve());
const drainWorktreeForDeletionMock = jest.fn(() => Promise.resolve());
const commitWorktreeQueueDeletionMock = jest.fn();
const rollbackWorktreeQueueDeletionMock = jest.fn();
const beginWorktreeQueueDeletionMock = jest.fn(() => ({
  commit: commitWorktreeQueueDeletionMock,
  rollback: rollbackWorktreeQueueDeletionMock,
}));
const runWithScopeDeletionMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
const runWithScopeDeletionLifecycleMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): unknown => ({
    refreshWorktreeMetadata: refreshWorktreeMetadataMock,
    drainWorktreeForDeletion: drainWorktreeForDeletionMock,
  }),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    runWithScopeDeletion: runWithScopeDeletionMock,
    runWithScopeDeletionLifecycle: runWithScopeDeletionLifecycleMock,
  }),
}));
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): unknown => ({
    beginWorktreeDeletion: beginWorktreeQueueDeletionMock,
  }),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => true),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../lib/archived-container-retention', () => ({
  createArchivedContainerTiming: jest.fn(() => ({
    archivedAt: '2026-01-08T00:00:00.000Z',
    expiresAt: '2026-01-15T00:00:00.000Z',
  })),
  resolveContainerRetentionDays: jest.fn(() => Promise.resolve(7)),
}));
jest.mock('../lib/archived-container-provider-state', () => ({
  captureArchivedContainerProviderState: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/archived-containers', () => ({
  assertArchivedContainerSourceGeneration: jest.fn(() => Promise.resolve()),
  beginArchivedContainerCapture: jest.fn(() =>
    Promise.resolve({
      chats: { version: 1, tabs: [], activeTabId: '' },
      chatArchives: { version: 1, archived: [] },
    }),
  ),
  broadcastArchivedContainersChanged: jest.fn(),
  commitArchivedContainer: jest.fn(() => Promise.resolve()),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_projectId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
const releaseLocalScopeFenceMock = jest.fn(() => Promise.resolve());
const commitLocalScopeCancellationMock = jest.fn();
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): unknown => ({
    releaseLocalScopeFence: releaseLocalScopeFenceMock,
    commitLocalScopeCancellation: commitLocalScopeCancellationMock,
  }),
}));
jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerArchived: jest.fn(),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import {
  destroyWorktreeSessions,
  getActiveChatIds,
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  type LiveBackgroundTaskOwner,
} from '../agents/session-manager';
import { archiveWorkEntry } from '../lib/work-entry-archive';
import { setDelegationActivity } from '../agents/delegation/activity';
import { registerWorkEntryHandlers } from '../ipc/work-entries';
import { createLiveBackgroundTaskOwner } from '../ipc/__tests__/background-work-removal-test-helpers';
import { commitTaskBrowserRetirement } from '../browser/browser-profile-lifecycle';
import { registerIpcHandler } from '../ipc/register';
import {
  createWorkEntry,
  listWorkEntries,
  removeWorkEntryRow,
  onWorkEntryListChanged,
  reorderWorkEntries,
  resolveWorkEntryForChat,
  updateWorkEntry,
} from '../lib/cowork-work-entries';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { resolveContainerRetentionDays } from '../lib/archived-container-retention';
import { captureArchivedContainerProviderState } from '../lib/archived-container-provider-state';
import {
  assertArchivedContainerSourceGeneration,
  beginArchivedContainerCapture,
  broadcastArchivedContainersChanged,
  commitArchivedContainer,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import { currentLocalFenceHolder } from '../app-advisor/local-fence-holder';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetLiveBackgroundTasksForChat = jest.mocked(
  getLiveBackgroundTasksForChat,
);
const mockedListLiveBackgroundTaskOwners = jest.mocked(
  listLiveBackgroundTaskOwners,
);

type Handler = (event: undefined, request: unknown) => Promise<unknown>;

function handlerFor(channel: string): Handler {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registered]) => registered === channel,
  );
  if (!call || typeof call[1] !== 'function') {
    throw new Error(`Missing handler for ${channel}`);
  }
  return async (event, request): Promise<unknown> =>
    Promise.resolve(Reflect.apply(call[1], undefined, [event, request]));
}

describe('work-entry IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLiveBackgroundTasksForChat.mockReset().mockReturnValue(undefined);
    mockedListLiveBackgroundTaskOwners.mockReset().mockReturnValue([]);
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    registerWorkEntryHandlers();
  });

  function setProviderTask(owner: LiveBackgroundTaskOwner): void {
    mockedGetLiveBackgroundTasksForChat.mockImplementation(
      (projectId, worktreeId, chatId) =>
        owner.projectId === projectId &&
        owner.worktreeId === worktreeId &&
        owner.chatId === chatId
          ? owner.liveTasks
          : undefined,
    );
    mockedListLiveBackgroundTaskOwners.mockReturnValue([owner]);
  }

  it('closes and drains Work Entry admission before acquiring the archive lock', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    let lockHeld = false;
    const lock = jest.mocked(withArchivedWorkspaceOperationLock);
    lock.mockImplementation(
      async <T>(_id: string, operation: () => Promise<T>): Promise<T> => {
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    );
    let drainedUnderLock = false;
    runWithScopeDeletionLifecycleMock.mockImplementationOnce(
      async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
        drainedUnderLock = lockHeld;
        return operation();
      },
    );
    try {
      await archiveWorkEntry({
        workspaceId: 'app-advisor',
        entryId: 'entry-1',
      });
      expect(drainedUnderLock).toBe(false);
    } finally {
      lock.mockImplementation(
        <T>(_id: string, operation: () => Promise<T>): Promise<T> =>
          operation(),
      );
    }
  });

  it('rejects first activity after an automatic Work Entry candidate without a timestamp', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastTouchedAt: '2026-09-11T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    await expect(
      archiveWorkEntry({
        workspaceId: 'cowork-1',
        entryId: 'entry-1',
        expectedLastTouchedAt: undefined,
        revalidateAutoArchivePolicy: () => Promise.resolve({}),
      }),
    ).rejects.toThrow('Auto Delete eligibility changed');
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
  });

  it('returns persisted cleanup warnings after a committed automatic deletion', async () => {
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'app-advisor',
        'entry-1',
        'chat-a',
        'local_bash',
      ),
    );
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    jest
      .mocked(cleanupPersistedWorktreeData)
      .mockResolvedValueOnce(['cleanup warning']);
    await expect(
      archiveWorkEntry({ workspaceId: 'app-advisor', entryId: 'entry-1' }),
    ).resolves.toEqual({ retained: true, warnings: ['cleanup warning'] });
    expect(removeWorkEntryRow).toHaveBeenCalledWith('app-advisor', 'entry-1');
  });

  describe('Ledger lifecycle participant', () => {
    const entryCreatedAt = '2026-01-01T00:00:00.000Z';

    beforeEach(() => {
      jest.mocked(listWorkEntries).mockResolvedValue([
        {
          id: 'entry-1',
          title: 'Entry 1',
          createdAt: entryCreatedAt,
          chatCount: 0,
        },
      ]);
    });

    it.each([
      [
        'Cowork',
        'workspace-1',
        {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'entry-1',
        },
      ],
      [
        'App Advisor',
        APP_ADVISOR_PROJECT_ID,
        {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: 'entry-1',
        },
      ],
    ] as const)(
      'tells the Ledger once after a %s Work Entry archive commits',
      async (_surface, workspaceId, container) => {
        await expect(
          archiveWorkEntry({ workspaceId, entryId: 'entry-1' }),
        ).resolves.toEqual({ retained: true, warnings: [] });

        expect(notifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
        expect(notifyLedgerContainerArchived).toHaveBeenCalledWith(
          { container, containerCreatedAt: entryCreatedAt },
          { retained: true },
        );
        // Only after both commits: the retained manifest, then the row.
        const notifiedAt = jest.mocked(notifyLedgerContainerArchived).mock
          .invocationCallOrder[0];
        expect(
          jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0],
        ).toBeLessThan(notifiedAt ?? 0);
        expect(
          jest.mocked(removeWorkEntryRow).mock.invocationCallOrder[0],
        ).toBeLessThan(notifiedAt ?? 0);
      },
    );

    it('does not tell the Ledger when the retained manifest commit fails', async () => {
      jest
        .mocked(commitArchivedContainer)
        .mockRejectedValueOnce(new Error('manifest commit failed'));

      await expect(
        archiveWorkEntry({ workspaceId: 'workspace-1', entryId: 'entry-1' }),
      ).rejects.toThrow('manifest commit failed');

      expect(removeWorkEntryRow).not.toHaveBeenCalled();
      expect(notifyLedgerContainerArchived).not.toHaveBeenCalled();
    });

    it('does not tell the Ledger when the entry row cannot be removed', async () => {
      jest
        .mocked(removeWorkEntryRow)
        .mockRejectedValueOnce(new Error('work entry registry write failed'));

      await expect(
        archiveWorkEntry({ workspaceId: 'workspace-1', entryId: 'entry-1' }),
      ).rejects.toThrow('work entry registry write failed');

      expect(notifyLedgerContainerArchived).not.toHaveBeenCalled();
    });

    it('completes the archive when the Ledger participant throws', async () => {
      jest.mocked(notifyLedgerContainerArchived).mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        archiveWorkEntry({ workspaceId: 'workspace-1', entryId: 'entry-1' }),
      ).resolves.toEqual({ retained: true, warnings: [] });

      expect(notifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(commitLocalScopeCancellationMock).toHaveBeenCalledWith(
        'workspace-1',
        'entry-1',
      );
      expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
      expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    });

    it.each([
      [
        'Cowork',
        'workspace-1',
        {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'entry-1',
        },
      ],
      [
        'App Advisor',
        APP_ADVISOR_PROJECT_ID,
        {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: 'entry-1',
        },
      ],
    ] as const)(
      'tells the Ledger once after a %s Work Entry delete commits',
      async (_surface, projectId, container) => {
        await expect(
          handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
            projectId,
            entryId: 'entry-1',
          }),
        ).resolves.toEqual({ browserCleanupPending: false });

        // Every delete retains the entry as an archived container, so the
        // scope becomes read-only rather than retiring.
        expect(notifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
        expect(notifyLedgerContainerArchived).toHaveBeenCalledWith(
          { container, containerCreatedAt: entryCreatedAt },
          { retained: true },
        );
        const notifiedAt = jest.mocked(notifyLedgerContainerArchived).mock
          .invocationCallOrder[0];
        expect(
          jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0],
        ).toBeLessThan(notifiedAt ?? 0);
        expect(
          jest.mocked(removeWorkEntryRow).mock.invocationCallOrder[0],
        ).toBeLessThan(notifiedAt ?? 0);
      },
    );

    it('does not tell the Ledger when a deletion fails before its row is removed', async () => {
      jest
        .mocked(commitArchivedContainer)
        .mockRejectedValueOnce(new Error('manifest commit failed'));
      await expect(
        handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
          projectId: 'workspace-1',
          entryId: 'entry-1',
        }),
      ).rejects.toThrow('manifest commit failed');

      jest
        .mocked(removeWorkEntryRow)
        .mockRejectedValueOnce(new Error('work entry registry write failed'));
      await expect(
        handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
          projectId: 'workspace-1',
          entryId: 'entry-1',
        }),
      ).rejects.toThrow('work entry registry write failed');

      expect(notifyLedgerContainerArchived).not.toHaveBeenCalled();
    });

    it('completes the deletion when the Ledger participant throws', async () => {
      jest.mocked(notifyLedgerContainerArchived).mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
          projectId: 'workspace-1',
          entryId: 'entry-1',
        }),
      ).resolves.toEqual({ browserCleanupPending: false });

      expect(notifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(commitLocalScopeCancellationMock).toHaveBeenCalledWith(
        'workspace-1',
        'entry-1',
      );
      expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
      expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
      expect(broadcastArchivedContainersChanged).toHaveBeenCalledWith(
        'workspace-1',
      );
    });
  });

  it('registers all work-entry channels', () => {
    expect(
      mockedRegisterIpcHandler.mock.calls.map(([channel]) => channel),
    ).toEqual([
      IPC_CHANNELS.workEntriesList,
      IPC_CHANNELS.workEntriesCreate,
      IPC_CHANNELS.workEntriesUpdate,
      IPC_CHANNELS.workEntriesReorder,
      IPC_CHANNELS.workEntriesDelete,
      IPC_CHANNELS.workEntriesResolveChat,
    ]);
  });

  it('lists and creates entries through the registry', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([]);
    jest.mocked(createWorkEntry).mockResolvedValue({
      entry: {
        id: 'entry-1',
        title: 'New entry',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesList)(undefined, {
        projectId: 'workspace-1',
      }),
    ).resolves.toEqual({ entries: [] });
    await handlerFor(IPC_CHANNELS.workEntriesCreate)(undefined, {
      projectId: 'workspace-1',
      title: 'New entry',
    });
    expect(createWorkEntry).toHaveBeenCalledWith('workspace-1', {
      title: 'New entry',
    });
  });

  it('accepts App Advisor without consulting the indexed cowork project registry', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([]);
    jest.mocked(createWorkEntry).mockResolvedValue({
      entry: {
        id: 'entry-app-advisor',
        title: 'New entry',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesList)(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
      }),
    ).resolves.toEqual({ entries: [] });
    await handlerFor(IPC_CHANNELS.workEntriesCreate)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
    });

    expect(listWorkEntries).toHaveBeenCalledWith(APP_ADVISOR_PROJECT_ID, {
      getActiveChatIds,
    });
    expect(createWorkEntry).toHaveBeenCalledWith(APP_ADVISOR_PROJECT_ID, {});
    expect(resolveCoworkWorkspaceId).not.toHaveBeenCalled();
    expect(isCoworkWorkspace).not.toHaveBeenCalled();
  });

  it('updates an entry after validating its id', async () => {
    await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
      title: 'Renamed',
    });
    // Only the keys the request carried are forwarded, so a rename cannot
    // clobber the entry's done state.
    expect(updateWorkEntry).toHaveBeenCalledWith('workspace-1', 'entry-1', {
      title: 'Renamed',
    });

    await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
      status: 'done',
    });
    expect(updateWorkEntry).toHaveBeenLastCalledWith('workspace-1', 'entry-1', {
      status: 'done',
    });

    await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
      pinned: true,
    });
    expect(updateWorkEntry).toHaveBeenLastCalledWith('workspace-1', 'entry-1', {
      pinned: true,
    });

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId: 'workspace-1',
        entryId: '../escape',
        title: 'Bad',
      }),
    ).rejects.toThrow('Invalid entryId');

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
        status: 'archived',
      }),
    ).rejects.toThrow('Invalid work entry status');

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
        pinned: 'yes',
      }),
    ).rejects.toThrow('Invalid work entry pinned state');
  });

  it.each(['workspace-1', APP_ADVISOR_PROJECT_ID])(
    'preserves task resources when %s is marked done',
    async (projectId) => {
      await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId,
        entryId: 'entry-1',
        status: 'done',
      });
      expect(updateWorkEntry).toHaveBeenCalledWith(projectId, 'entry-1', {
        status: 'done',
      });
      expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
      expect(destroyWorktreeSessions).not.toHaveBeenCalled();
    },
  );

  it('pushes a telemetry metadata refresh after a rename or mark-done', async () => {
    // A rename (linkage bonus) or mark-done (done bonus) is usually the last
    // action on an entry, so no later turn will carry the change to the server.
    // Without this the Impact delivery bonuses are unreachable server-side.
    await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
      status: 'done',
    });
    expect(refreshWorktreeMetadataMock).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );

    refreshWorktreeMetadataMock.mockClear();
    await handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
      title: 'SUP-412 Refund flow',
    });
    expect(refreshWorktreeMetadataMock).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
  });

  it('does not fail the local edit when the telemetry refresh rejects', async () => {
    refreshWorktreeMetadataMock.mockRejectedValueOnce(new Error('offline'));

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
        status: 'done',
      }),
    ).resolves.toBeUndefined();
    expect(updateWorkEntry).toHaveBeenCalled();
  });

  it('never attempts a telemetry refresh for a rejected id', async () => {
    await expect(
      handlerFor(IPC_CHANNELS.workEntriesUpdate)(undefined, {
        projectId: 'workspace-1',
        entryId: '../escape',
        status: 'done',
      }),
    ).rejects.toThrow('Invalid entryId');
    expect(refreshWorktreeMetadataMock).not.toHaveBeenCalled();
  });

  it('reorders entries after validating every id', async () => {
    await handlerFor(IPC_CHANNELS.workEntriesReorder)(undefined, {
      projectId: 'workspace-1',
      entryIds: ['entry-2', 'entry-1'],
    });
    expect(reorderWorkEntries).toHaveBeenCalledWith('workspace-1', [
      'entry-2',
      'entry-1',
    ]);
    await expect(
      handlerFor(IPC_CHANNELS.workEntriesReorder)(undefined, {
        projectId: 'workspace-1',
        entryIds: ['../escape'],
      }),
    ).rejects.toThrow('Invalid entryId');
  });

  it('re-projects the whole cowork workspace when its entry list changes', async () => {
    // Handler registration (see beforeEach) subscribes exactly once.
    const onListChanged = jest.mocked(onWorkEntryListChanged);
    expect(onListChanged).toHaveBeenCalledTimes(1);
    const listener = onListChanged.mock.calls[0]?.[0];
    if (!listener) throw new Error('Expected a Work Entry list listener');

    listener('workspace-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitWorkspaceSummariesMock).toHaveBeenCalledWith('workspace-1');

    // App Advisor projects its own navigation; the cowork emitter skips it.
    emitWorkspaceSummariesMock.mockClear();
    listener(APP_ADVISOR_PROJECT_ID);
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitWorkspaceSummariesMock).not.toHaveBeenCalled();
  });

  it('tears down sessions and persisted data before removing a row', async () => {
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'workspace-1',
        'entry-1',
        'chat-a',
        'local_bash',
      ),
    );
    jest.mocked(commitTaskBrowserRetirement).mockResolvedValueOnce(true);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    const deletion = await handlerFor(IPC_CHANNELS.workEntriesDelete)(
      undefined,
      {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      },
    );
    expect(deletion).toEqual({ browserCleanupPending: true });
    expect(destroyWorktreeSessions).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(beginWorktreeQueueDeletionMock).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
    expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    // Deletion retention is always on: even a plain Delete retains the
    // entry as a container, so search documents move rather than drop.
    expect(cleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
      {
        chatSearchDisposition: 'container-archived',
        deferLocalWatcherCancellationCommit: true,
      },
    );
    expect(removeWorkEntryRow).toHaveBeenCalledWith('workspace-1', 'entry-1');
    expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
    expect(emitRemovalsMock).toHaveBeenCalledWith('workspace-1', [
      'chat-1',
      'chat-2',
    ]);
    // The telemetry queue must be drained and dropped too. A `metaDirty`
    // envelope has no collection items to retire it, so a mark-done followed by
    // a delete would otherwise leave an immortal queue entry uploading metadata
    // for a Work Entry that no longer exists locally.
    expect(drainWorktreeForDeletionMock).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(
      beginWorktreeQueueDeletionMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(destroyWorktreeSessions).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(destroyWorktreeSessions).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(cleanupPersistedWorktreeData).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(cleanupPersistedWorktreeData).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(removeWorkEntryRow).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('tears down providers inside the lifecycle fence before closing repository writes', async () => {
    let lifecycleFenceActive = false;
    let repositoryFenceActive = false;
    runWithScopeDeletionLifecycleMock.mockImplementationOnce(
      async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
        lifecycleFenceActive = true;
        try {
          return await operation();
        } finally {
          lifecycleFenceActive = false;
        }
      },
    );
    runWithScopeDeletionMock.mockImplementationOnce(
      async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
        repositoryFenceActive = true;
        try {
          return await operation();
        } finally {
          repositoryFenceActive = false;
        }
      },
    );
    jest.mocked(destroyWorktreeSessions).mockImplementationOnce(() => {
      expect(lifecycleFenceActive).toBe(true);
      expect(repositoryFenceActive).toBe(false);
      return Promise.resolve();
    });
    jest.mocked(cleanupPersistedWorktreeData).mockImplementationOnce(() => {
      expect(lifecycleFenceActive).toBe(true);
      expect(repositoryFenceActive).toBe(true);
      return Promise.resolve([]);
    });
    jest.mocked(removeWorkEntryRow).mockImplementationOnce(() => {
      expect(lifecycleFenceActive).toBe(true);
      expect(repositoryFenceActive).toBe(true);
      return Promise.resolve();
    });
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      }),
    ).resolves.toEqual({ browserCleanupPending: false });

    expect(runWithScopeDeletionLifecycleMock).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'entry-1' },
      expect.any(Function),
    );
    expect(runWithScopeDeletionMock).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'entry-1' },
      expect.any(Function),
    );
    expect(lifecycleFenceActive).toBe(false);
    expect(repositoryFenceActive).toBe(false);
  });

  it('commits retained entry state after session teardown and before deleting the live row', async () => {
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);

    await handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
      projectId: 'workspace-1',
      entryId: 'entry-1',
    });

    expect(beginArchivedContainerCapture).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
      {
        allowDuringScopeDeletion: true,
        expectedCreatedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    // Non-strict: provider-state failures degrade to warnings so an offline
    // plugin marketplace can never make a work entry undeletable.
    expect(captureArchivedContainerProviderState).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'entry-1',
      expectedCreatedAt: '2026-01-01T00:00:00.000Z',
      tabs: [],
      includeClaude: false,
      onlyPluginCodex: true,
    });
    expect(commitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'entry-1',
        kind: 'work-entry',
        retentionDays: 7,
      }),
    );
    expect(assertArchivedContainerSourceGeneration).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
      '2026-01-01T00:00:00.000Z',
    );
    expect(
      jest.mocked(captureArchivedContainerProviderState).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(assertArchivedContainerSourceGeneration).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(assertArchivedContainerSourceGeneration).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(cleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
      {
        chatSearchDisposition: 'container-archived',
        deferLocalWatcherCancellationCommit: true,
      },
    );
    expect(broadcastArchivedContainersChanged).toHaveBeenCalledWith(
      'workspace-1',
    );
    expect(
      runWithScopeDeletionLifecycleMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(destroyWorktreeSessions).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(destroyWorktreeSessions).mock.invocationCallOrder[0],
    ).toBeLessThan(
      runWithScopeDeletionMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(runWithScopeDeletionMock.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(beginArchivedContainerCapture).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(cleanupPersistedWorktreeData).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      jest.mocked(cleanupPersistedWorktreeData).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(removeWorkEntryRow).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('keeps persisted entry data and the row when post-teardown capture fails', async () => {
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    jest
      .mocked(beginArchivedContainerCapture)
      .mockRejectedValueOnce(new Error('chat copy failed'));

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      }),
    ).rejects.toThrow('chat copy failed');

    expect(destroyWorktreeSessions).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(commitArchivedContainer).not.toHaveBeenCalled();
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removeWorkEntryRow).not.toHaveBeenCalled();
    expect(commitWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(rollbackWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
    expect(rollbackWorktreeQueueDeletionMock).toHaveBeenCalledWith({
      sessionsDestroyed: true,
    });
  });

  it('releases the local watcher fence when retained entry commit fails', async () => {
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    jest
      .mocked(commitArchivedContainer)
      .mockRejectedValueOnce(new Error('manifest commit failed'));

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      }),
    ).rejects.toThrow('manifest commit failed');

    expect(releaseLocalScopeFenceMock).toHaveBeenCalledWith(
      'workspace-1',
      'entry-1',
    );
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removeWorkEntryRow).not.toHaveBeenCalled();
  });

  it('releases the local watcher fence as its own fence holder (CAN-4989)', async () => {
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    jest
      .mocked(commitArchivedContainer)
      .mockRejectedValueOnce(new Error('manifest commit failed'));
    const holders: unknown[] = [];
    releaseLocalScopeFenceMock.mockImplementation(() => {
      holders.push(currentLocalFenceHolder());
      return Promise.resolve();
    });

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      }),
    ).rejects.toThrow('manifest commit failed');

    releaseLocalScopeFenceMock.mockImplementation(() => Promise.resolve());
    expect(holders.length).toBeGreaterThan(0);
    expect(new Set(holders).size).toBe(1);
    expect(holders[0]).not.toBe(currentLocalFenceHolder());
  });

  it('runs each automatic Work Entry deletion as its own fence holder (CAN-4989)', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    const holders: unknown[] = [];
    jest.mocked(cleanupPersistedWorktreeData).mockImplementation(() => {
      holders.push(currentLocalFenceHolder());
      return Promise.resolve([]);
    });
    commitLocalScopeCancellationMock.mockImplementation(() => {
      holders.push(currentLocalFenceHolder());
      return Promise.resolve();
    });
    try {
      await archiveWorkEntry({
        workspaceId: 'app-advisor',
        entryId: 'entry-1',
      });
      await archiveWorkEntry({
        workspaceId: 'app-advisor',
        entryId: 'entry-1',
      });
    } finally {
      jest
        .mocked(cleanupPersistedWorktreeData)
        .mockImplementation(() => Promise.resolve([]));
      commitLocalScopeCancellationMock.mockReset();
    }

    expect(holders).toHaveLength(4);
    expect(holders[0]).toBe(holders[1]);
    expect(holders[2]).toBe(holders[3]);
    expect(holders[0]).not.toBe(holders[2]);
    expect(holders[0]).not.toBe(currentLocalFenceHolder());
  });

  it('does not reactivate watchers after the work-entry row is removed', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    commitLocalScopeCancellationMock.mockRejectedValueOnce(
      new Error('watcher commit failed'),
    );

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: 'workspace-1',
        entryId: 'entry-1',
      }),
    ).rejects.toThrow('watcher commit failed');

    expect(removeWorkEntryRow).toHaveBeenCalledWith('workspace-1', 'entry-1');
    expect(releaseLocalScopeFenceMock).not.toHaveBeenCalled();
  });

  it('routes retained App Advisor entry deletion through the shared capture path', async () => {
    jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'advisor-entry',
        title: 'Advisor entry',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]);

    await handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      entryId: 'advisor-entry',
    });

    expect(beginArchivedContainerCapture).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'advisor-entry',
      {
        allowDuringScopeDeletion: true,
        expectedCreatedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(commitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        id: 'advisor-entry',
        kind: 'work-entry',
      }),
    );
    expect(removeWorkEntryRow).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'advisor-entry',
    );
  });

  it('rejects the App Advisor global slot and unknown entries before cleanup', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([]);

    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
        entryId: APP_ADVISOR_WORKTREE_ID,
      }),
    ).rejects.toThrow('global slot cannot be deleted');
    await expect(
      handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
        entryId: 'unknown-entry',
      }),
    ).rejects.toThrow('Unknown work entry unknown-entry');

    expect(destroyWorktreeSessions).not.toHaveBeenCalled();
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removeWorkEntryRow).not.toHaveBeenCalled();
  });

  it('refuses to delete a Work Entry while one of its chats has live delegates', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'workspace-1',
        'entry-1',
        'chat-a',
        'local_agent',
      ),
    );
    setDelegationActivity(
      'entry-delete-owner',
      'workspace-1/entry-1/chat-a',
      1,
    );
    try {
      await expect(
        handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
          projectId: 'workspace-1',
          entryId: 'entry-1',
        }),
      ).rejects.toThrow('Delegates are still running here. Stop them first.');
    } finally {
      setDelegationActivity(
        'entry-delete-owner',
        'workspace-1/entry-1/chat-a',
        0,
      );
    }
    expect(destroyWorktreeSessions).not.toHaveBeenCalled();
    expect(beginWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removeWorkEntryRow).not.toHaveBeenCalled();
  });

  it.each(['local_agent', 'local_workflow'] as const)(
    'refuses to delete a Work Entry while one of its chats has a live %s',
    async (taskType) => {
      jest.mocked(listWorkEntries).mockResolvedValue([
        {
          id: 'entry-1',
          title: 'Entry 1',
          createdAt: '2026-01-01T00:00:00.000Z',
          chatCount: 1,
        },
      ]);
      setProviderTask(
        createLiveBackgroundTaskOwner(
          'workspace-1',
          'entry-1',
          'chat-a',
          taskType,
        ),
      );

      await expect(
        handlerFor(IPC_CHANNELS.workEntriesDelete)(undefined, {
          projectId: 'workspace-1',
          entryId: 'entry-1',
        }),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Background agents or workflows are still running here. Stop them first.',
      });
      expect(destroyWorktreeSessions).not.toHaveBeenCalled();
      expect(beginWorktreeQueueDeletionMock).not.toHaveBeenCalled();
      expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
      expect(removeWorkEntryRow).not.toHaveBeenCalled();
    },
  );

  it('refuses to archive a Work Entry while one of its chats has live delegates', async () => {
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'entry-1',
        title: 'Entry 1',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 1,
      },
    ]);
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'cowork-1',
        'entry-1',
        'chat-a',
        'local_agent',
      ),
    );
    setDelegationActivity(
      'entry-archive-owner',
      'cowork-1/entry-1/chat-a',
      0,
      1,
    );
    try {
      await expect(
        archiveWorkEntry({ workspaceId: 'cowork-1', entryId: 'entry-1' }),
      ).rejects.toThrow('Delegates are still running here. Stop them first.');
    } finally {
      setDelegationActivity(
        'entry-archive-owner',
        'cowork-1/entry-1/chat-a',
        0,
      );
    }
    expect(destroyWorktreeSessions).not.toHaveBeenCalled();
    expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(removeWorkEntryRow).not.toHaveBeenCalled();
  });

  it.each(['local_agent', 'local_workflow'] as const)(
    'refuses to archive a Work Entry while one of its chats has a live %s',
    async (taskType) => {
      jest.mocked(listWorkEntries).mockResolvedValue([
        {
          id: 'entry-1',
          title: 'Entry 1',
          createdAt: '2026-01-01T00:00:00.000Z',
          chatCount: 1,
        },
      ]);
      setProviderTask(
        createLiveBackgroundTaskOwner(
          'cowork-1',
          'entry-1',
          'chat-a',
          taskType,
        ),
      );

      await expect(
        archiveWorkEntry({ workspaceId: 'cowork-1', entryId: 'entry-1' }),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Background agents or workflows are still running here. Stop them first.',
      });
      expect(destroyWorktreeSessions).not.toHaveBeenCalled();
      expect(beginWorktreeQueueDeletionMock).not.toHaveBeenCalled();
      expect(cleanupPersistedWorktreeData).not.toHaveBeenCalled();
      expect(removeWorkEntryRow).not.toHaveBeenCalled();
    },
  );

  it('validates and resolves a chat id', async () => {
    jest.mocked(resolveWorkEntryForChat).mockResolvedValue({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });
    await expect(
      handlerFor(IPC_CHANNELS.workEntriesResolveChat)(undefined, {
        projectId: 'workspace-1',
        chatId: 'chat-1',
      }),
    ).resolves.toEqual({ entryId: 'entry-1', archivedInEntryId: null });
    expect(resolveWorkEntryForChat).toHaveBeenCalledWith(
      'workspace-1',
      'chat-1',
    );
  });
});
