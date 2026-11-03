import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalEventEnvelope,
  type WorkspaceConfigFile,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
jest.mock('../../../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(),
}));
import {
  handlePortalWorktreeArchive,
  handlePortalWorktreeCreate,
  handlePortalWorktreeReorder,
  handlePortalWorktreeUpdate,
} from '../worktree-adapter';
import type { PortalAdapterContext } from '../types';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  type CreateWorktreeServiceOptions,
} from '../../../lib/worktree-service';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../../../lib/workspace-persistence';
import { setDelegationActivity } from '../../../agents/delegation/activity';
import {
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  type LiveBackgroundTaskOwner,
} from '../../../agents/session-manager';
import { createLiveBackgroundTaskOwner } from '../../../ipc/__tests__/background-work-removal-test-helpers';
import { sendToWindow } from '../../../lib/window-send';
import { recordWorktreeCrudTelemetry } from '../../../lib/desktop-telemetry';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../../../services/split-lock-service';
import { forkOpenWorktreeTabs } from '../../../lib/worktree-open-tabs-fork';
import {
  markWorkspaceTargetRemovalPending,
  resetWorkspaceTargetExclusionsForTests,
} from '../../../lib/workspace-target-exclusion';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from '../../../lib/worktree-live-cleanup';
import {
  getWorkspacePortalWorktreeEntity,
  getWorkspacePortalWorktreeRuntimeStatus,
} from '../../../services/workspace-portal-service';

jest.mock('../../../lib/worktree-service', () => ({
  createSingleRepoWorktree: jest.fn(),
  createMultiRepoWorktree: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
  archiveMultiRepoWorktree: jest.fn(),
}));
jest.mock('../../../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<unknown>, [string]>();
  return {
    readWorkspaceConfig,
    // The archive boundary (CAN-3811) reads the same config with authority.
    readWorkspaceConfigDetailed: jest.fn(async (workspaceId: string) => ({
      config: await readWorkspaceConfig(workspaceId),
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
    })),
    readWorkspaceWorktrees: jest.fn(),
    isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
    updateWorkspaceWorktree: jest.fn(),
    updateWorkspaceWorktrees: jest.fn(),
  };
});
jest.mock('../../../lib/archived-containers', () => ({
  listArchivedContainerManifestsStrict: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../../../lib/desktop-telemetry', () => ({
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../../services/split-lock-service', () => ({
  assertNotSplitDestinationWorktreeClaimed: jest.fn(),
  assertNotSplitLocked: jest.fn(),
}));
jest.mock('../../../lib/post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../../../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: jest.fn(),
  purgeLiveWorktreeObservabilityData: jest.fn(),
}));
jest.mock('../../../lib/worktree-open-tabs-fork', () => ({
  forkOpenWorktreeTabs: jest.fn(),
}));
jest.mock('../../../services/workspace-portal-service', () => ({
  getWorkspacePortalWorktreeEntity: jest.fn(),
  getWorkspacePortalWorktreeRuntimeStatus: jest.fn(),
}));

const mockedSingle = jest.mocked(createSingleRepoWorktree);
const mockedMulti = jest.mocked(createMultiRepoWorktree);
const mockedArchiveSingle = jest.mocked(archiveSingleRepoWorktree);
const mockedArchiveMulti = jest.mocked(archiveMultiRepoWorktree);
const mockedReadConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedUpdateWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedTelemetry = jest.mocked(recordWorktreeCrudTelemetry);
const mockedAssertNotSplitLocked = jest.mocked(assertNotSplitLocked);
const mockedAssertNotSplitDestinationWorktreeClaimed = jest.mocked(
  assertNotSplitDestinationWorktreeClaimed,
);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedForkOpenTabs = jest.mocked(forkOpenWorktreeTabs);
const mockedCleanupLiveState = jest.mocked(cleanupLiveWorktreeState);
const mockedPurgeObservabilityData = jest.mocked(
  purgeLiveWorktreeObservabilityData,
);
const mockedGetPortalWorktreeEntity = jest.mocked(
  getWorkspacePortalWorktreeEntity,
);
const mockedGetPortalWorktreeRuntimeStatus = jest.mocked(
  getWorkspacePortalWorktreeRuntimeStatus,
);
const mockedGetLiveBackgroundTasksForChat = jest.mocked(
  getLiveBackgroundTasksForChat,
);
const mockedListLiveBackgroundTaskOwners = jest.mocked(
  listLiveBackgroundTaskOwners,
);

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

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (command, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
  );
}

function stateDeltaPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload))
    throw new Error('Expected a worktree status delta payload');
  return payload;
}

function command(
  payload: unknown,
): Parameters<typeof handlePortalWorktreeCreate>[0] {
  return {
    id: 'cmd-1',
    sequence: 1,
    type: 'portal.worktree.create',
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorktreeCreate>[0];
}

function updateCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorktreeUpdate>[0] {
  const update: PortalCommandEnvelope<unknown> = {
    id: 'cmd-u',
    sequence: 1,
    type: 'portal.worktree.update',
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  };
  return update;
}

function reorderCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorktreeReorder>[0] {
  const reorder: PortalCommandEnvelope<unknown> = {
    id: 'cmd-r',
    sequence: 1,
    type: 'portal.worktree.reorder',
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  };
  return reorder;
}

function config(type: WorkspaceType): WorkspaceConfigFile {
  return { version: 1, type, repos: [] };
}

const createdWorktree = {
  id: 'wt-new',
  branchName: 'feature/new',
  createdAt: '2026-07-10T00:00:00.000Z',
};

describe('worktree portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLiveBackgroundTasksForChat.mockReset().mockReturnValue(undefined);
    mockedListLiveBackgroundTaskOwners.mockReset().mockReturnValue([]);
    mockedReadWorktrees.mockResolvedValue([]);
    mockedGetPortalWorktreeRuntimeStatus.mockResolvedValue({});
    mockedGetPortalWorktreeEntity.mockResolvedValue({
      entityType: 'worktree',
      localId: 'wt-new',
      parentLocalId: 'ws-1',
      payload: {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-new',
        branch: 'feature/new',
      },
    });
  });

  it('creates a single-repo worktree, records telemetry, and completes', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockResolvedValue(createdWorktree);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1', existingWorktreeIds: ['wt-a'] }),
      adapterContext(events),
    );

    expect(mockedSingle).toHaveBeenCalledTimes(1);
    const createOptions = mockedSingle.mock.calls[0]?.[0];
    expect(createOptions).toMatchObject({
      workspaceId: 'ws-1',
      existingWorktreeIds: ['wt-a'],
      startPostCreateSetup: false,
      deferGitSetup: true,
    });
    expect(typeof createOptions?.onGitReady).toBe('function');
    expect(typeof createOptions?.onGitFailed).toBe('function');
    expect(mockedMulti).not.toHaveBeenCalled();
    expect(mockedTelemetry).toHaveBeenCalledWith({
      action: 'create',
      workspaceId: 'ws-1',
      source: 'portal',
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1', worktrees: [] },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('publishes deferred git-ready status without holding the create command open', async () => {
    let createOptions: CreateWorktreeServiceOptions | undefined;
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockImplementation((options) => {
      createOptions = options;
      return Promise.resolve({
        ...createdWorktree,
        setupPhase: 'git-pending',
      });
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    createOptions?.onGitReady?.({
      projectId: 'ws-1',
      worktreeId: 'wt-new',
      branchName: 'feature/new',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreeGitReady,
      expect.objectContaining({ projectId: 'ws-1', worktreeId: 'wt-new' }),
    );
    const statusEvent = events[events.length - 1];
    expect(statusEvent?.type).toBe('portal.state.delta');
    if (statusEvent?.type !== 'portal.state.delta') {
      throw new Error('Expected a worktree status delta');
    }
    const statusPayload = stateDeltaPayload(statusEvent.payload);
    expect(statusPayload.scope).toBe('worktree');
    expect(statusPayload.target).toEqual({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-new',
    });
    expect(statusPayload.entities).toEqual([
      {
        entityType: 'worktree',
        localId: 'wt-new',
        parentLocalId: 'ws-1',
        payload: {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-new',
          branch: 'feature/new',
        },
      },
    ]);
  });

  it('publishes deferred git failure as a broken worktree status after command acceptance', async () => {
    let createOptions: CreateWorktreeServiceOptions | undefined;
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockImplementation((options) => {
      createOptions = options;
      return Promise.resolve({
        ...createdWorktree,
        setupPhase: 'git-pending',
      });
    });
    mockedGetPortalWorktreeEntity.mockResolvedValue({
      entityType: 'worktree',
      localId: 'wt-new',
      parentLocalId: 'ws-1',
      payload: {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-new',
        branch: 'feature/new',
        healthIssue: {
          status: 'broken',
          reason: 'Worktree setup failed. Check the repository state.',
        },
      },
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );
    createOptions?.onGitFailed?.({
      projectId: 'ws-1',
      worktreeId: 'wt-new',
      error: 'git fetch failed',
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        message: 'Worktree setup failed.',
        checkedAt: '2026-07-10T00:00:00.000Z',
        worktreePath: '/private/worktree',
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(events[0]?.type).toBe('portal.command.completed');
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreeGitFailed,
      expect.objectContaining({ projectId: 'ws-1', worktreeId: 'wt-new' }),
    );
    const statusEvent = events[events.length - 1];
    expect(statusEvent?.type).toBe('portal.state.delta');
    if (statusEvent?.type !== 'portal.state.delta') {
      throw new Error('Expected a worktree status delta');
    }
    const statusPayload = stateDeltaPayload(statusEvent.payload);
    expect(statusPayload).not.toHaveProperty('worktreeSetupFailure');
    expect(statusPayload.entities).toEqual([
      {
        entityType: 'worktree',
        localId: 'wt-new',
        parentLocalId: 'ws-1',
        payload: {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-new',
          branch: 'feature/new',
          healthIssue: {
            status: 'broken',
            reason: 'Worktree setup failed. Check the repository state.',
          },
        },
      },
    ]);
  });

  it('publishes the deferred git failure when rollback removed the reserved worktree', async () => {
    let createOptions: CreateWorktreeServiceOptions | undefined;
    mockedReadConfig.mockResolvedValue(config('multi-repo'));
    mockedMulti.mockImplementation((options) => {
      createOptions = options;
      return Promise.resolve({
        ...createdWorktree,
        setupPhase: 'git-pending',
      });
    });
    mockedGetPortalWorktreeEntity.mockResolvedValue(null);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );
    createOptions?.onGitFailed?.({
      projectId: 'ws-1',
      worktreeId: 'wt-new',
      error: 'Repository clone failed; reservation rolled back.',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const statusEvent = events[events.length - 1];
    expect(statusEvent?.type).toBe('portal.state.delta');
    if (statusEvent?.type !== 'portal.state.delta') {
      throw new Error('Expected a worktree status delta');
    }
    expect(statusEvent.payload).toMatchObject({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-new',
      },
      removed: [
        {
          entityType: 'worktree',
          localId: 'wt-new',
          parentLocalId: 'ws-1',
        },
      ],
      worktreeSetupFailure: {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-new',
        error: 'Repository clone failed; reservation rolled back.',
      },
    });
  });

  it.each([
    ['is still in progress', false],
    ['finishes while the status is being read', true],
  ])(
    'does not report a setup failure for a worktree whose removal %s',
    async (_label, releaseDuringRead) => {
      let createOptions: CreateWorktreeServiceOptions | undefined;
      mockedReadConfig.mockResolvedValue(config('multi-repo'));
      mockedMulti.mockImplementation((options) => {
        createOptions = options;
        return Promise.resolve({
          ...createdWorktree,
          setupPhase: 'git-pending',
        });
      });
      const events: PortalEventEnvelope[] = [];
      await handlePortalWorktreeCreate(
        command({ workspaceId: 'ws-1' }),
        adapterContext(events),
      );
      const release = markWorkspaceTargetRemovalPending('ws-1', 'wt-new');
      // The projection hides a pending row, and an archive that finishes
      // removes it: either way the targeted read finds nothing.
      mockedGetPortalWorktreeEntity.mockImplementation(() => {
        if (releaseDuringRead) release();
        return Promise.resolve(null);
      });

      try {
        // Archiving cancels in-flight setup, so its failure callback can fire
        // for a row the user is deliberately removing.
        createOptions?.onGitFailed?.({
          projectId: 'ws-1',
          worktreeId: 'wt-new',
          error: 'This worktree setup was cancelled by archiving.',
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } finally {
        release();
        resetWorkspaceTargetExclusionsForTests();
      }

      const statusEvent = events[events.length - 1];
      if (statusEvent?.type !== 'portal.state.delta') {
        throw new Error('Expected a worktree status delta');
      }
      expect(statusEvent.payload).toMatchObject({
        removed: [
          {
            entityType: 'worktree',
            localId: 'wt-new',
            parentLocalId: 'ws-1',
          },
        ],
      });
      expect(statusEvent.payload).not.toHaveProperty('worktreeSetupFailure');
    },
  );

  it('finishes tab inheritance before publishing deferred Git readiness', async () => {
    let createOptions: CreateWorktreeServiceOptions | undefined;
    let resolveForkOpenTabs: (() => void) | undefined;
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedForkOpenTabs.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof forkOpenWorktreeTabs>>>(
          (resolve) => {
            resolveForkOpenTabs = (): void => resolve(new Map());
          },
        ),
    );
    mockedSingle.mockImplementation((options) => {
      createOptions = options;
      return Promise.resolve({
        ...createdWorktree,
        setupPhase: 'git-pending',
      });
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-base',
        forkOpenTabs: true,
      }),
      adapterContext(events),
    );

    expect(mockedForkOpenTabs).not.toHaveBeenCalled();
    const readyEvent = {
      projectId: 'ws-1',
      worktreeId: 'wt-new',
      branchName: 'feature/new',
    };
    const beforeReady = createOptions?.beforeGitReady?.(readyEvent);

    expect(mockedForkOpenTabs).toHaveBeenCalledWith({
      projectId: 'ws-1',
      sourceWorktreeId: 'wt-base',
      destinationWorktreeId: 'wt-new',
    });
    expect(mockedSendToWindow).not.toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreeGitReady,
      expect.anything(),
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);

    resolveForkOpenTabs?.();
    await beforeReady;
    createOptions?.onGitReady?.(readyEvent);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreeGitReady,
      expect.objectContaining({ projectId: 'ws-1', worktreeId: 'wt-new' }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
      'portal.state.delta',
    ]);
  });

  it('broadcasts the full post-create worktree list to the desktop renderer', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockResolvedValue(createdWorktree);
    const postCreateList = [
      { id: 'wt-a', branchName: 'a', createdAt: '2026-07-10T00:00:00.000Z' },
      createdWorktree,
    ];
    mockedReadWorktrees.mockResolvedValue(postCreateList);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedReadWorktrees).toHaveBeenCalledWith('ws-1');
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1', worktrees: postCreateList },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('does not broadcast to the renderer when the create fails', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockRejectedValue(new Error('create failed'));
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it('creates a multi-repo worktree when the project config is multi-repo', async () => {
    mockedReadConfig.mockResolvedValue(config('multi-repo'));
    mockedMulti.mockResolvedValue(createdWorktree);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-2' }),
      adapterContext(events),
    );

    expect(mockedMulti).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-2' }),
    );
    expect(mockedSingle).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('rejects a cowork project without creating anything', async () => {
    mockedReadConfig.mockResolvedValue(config('cowork'));
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'cowork-1' }),
      adapterContext(events),
    );

    expect(mockedSingle).not.toHaveBeenCalled();
    expect(mockedMulti).not.toHaveBeenCalled();
    expect(mockedTelemetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it('fails on an invalid payload with no workspaceId', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ existingWorktreeIds: [] }),
      adapterContext(events),
    );

    expect(mockedReadConfig).not.toHaveBeenCalled();
    expect(mockedSingle).not.toHaveBeenCalled();
    expect(mockedMulti).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it('rejects a malformed workspaceId before touching the config', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'Bad Id!' }),
      adapterContext(events),
    );

    expect(mockedReadConfig).not.toHaveBeenCalled();
    expect(mockedSingle).not.toHaveBeenCalled();
    expect(mockedMulti).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
    expect(events[0]?.payload).toEqual({
      error: {
        code: 'invalid_payload',
        message:
          'Invalid worktree create payload: workspaceId and baseWorktreeId must use lowercase letters, numbers, and hyphens.',
      },
    });
  });

  it('reports a service error as a command failure', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedSingle.mockRejectedValue(
      new Error(
        "Command failed: git -C /Users/example/private/repo worktree add '/Users/example/private/worktree'",
      ),
    );
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeCreate(
      command({ workspaceId: 'ws-1' }),
      adapterContext(events),
    );

    expect(mockedTelemetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
    expect(events[0]?.payload).toEqual({
      error: {
        code: 'execution_failed',
        message:
          'Failed to create the task worktree. Check the repository state, then try again.',
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('/Users/example/private');
  });
});

function archiveCommand(
  payload: unknown,
): Parameters<typeof handlePortalWorktreeArchive>[0] {
  return {
    id: 'cmd-a',
    sequence: 2,
    type: 'portal.worktree.archive',
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  } as Parameters<typeof handlePortalWorktreeArchive>[0];
}

const archivedResult = { success: true, warnings: [] };

describe('worktree portal adapter — archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetLiveBackgroundTasksForChat.mockReset().mockReturnValue(undefined);
    mockedListLiveBackgroundTaskOwners.mockReset().mockReturnValue([]);
    // The archive boundary sees the worktree before the archive; reads after
    // it see the list without the worktree.
    mockedReadWorktrees
      .mockReset()
      .mockResolvedValueOnce(
        ['wt-1', 'wt-9'].map((id) => ({
          id,
          branchName: `feature/${id}`,
          createdAt: '2026-07-10T00:00:00.000Z',
        })),
      )
      .mockResolvedValue([]);
  });

  it.each([
    ['absent mode', undefined, true],
    ['archive mode', 'archive', true],
    ['delete mode', 'delete', false],
  ] as const)(
    'archives a single-repo worktree with %s and the expected retained-item lock',
    async (_label, mode, locksAfterArchive) => {
      mockedReadConfig.mockResolvedValue(config('single-repo'));
      setProviderTask(
        createLiveBackgroundTaskOwner('ws-1', 'wt-1', 'chat-a', 'local_bash'),
      );
      mockedArchiveSingle.mockResolvedValue(archivedResult);
      const events: PortalEventEnvelope[] = [];
      const payload = {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        ...(mode === undefined ? {} : { mode }),
      };

      await handlePortalWorktreeArchive(
        archiveCommand(payload),
        adapterContext(events),
      );

      expect(mockedAssertNotSplitLocked).toHaveBeenCalledWith(
        'ws-1',
        'wt-1',
        expect.any(String),
      );
      expect(
        mockedAssertNotSplitDestinationWorktreeClaimed,
      ).toHaveBeenCalledWith('ws-1', 'wt-1', expect.any(String));
      const archiveArgs = mockedArchiveSingle.mock.calls[0]?.[0];
      expect(archiveArgs).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          observabilityMode: 'live-service',
        }),
      );
      if (locksAfterArchive) {
        expect(archiveArgs).toHaveProperty('lockAfterArchive', true);
      } else {
        expect(archiveArgs).not.toHaveProperty('lockAfterArchive');
      }
      expect(archiveArgs).not.toHaveProperty('repoPath');
      expect(archiveArgs).not.toHaveProperty('deleteBranch');
      expect(mockedArchiveMulti).not.toHaveBeenCalled();
      expect(mockedTelemetry).toHaveBeenCalledWith({
        action: 'archive',
        workspaceId: 'ws-1',
        source: 'portal',
      });
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.workspaceWorktreesUpdated,
        { workspaceId: 'ws-1', worktrees: [] },
      );
      expect(events.map((event) => event.type)).toEqual([
        'portal.command.completed',
      ]);
    },
  );

  it('broadcasts the full post-archive worktree list to the desktop renderer', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedArchiveSingle.mockResolvedValue(archivedResult);
    const postArchiveList = [
      { id: 'wt-2', branchName: 'b', createdAt: '2026-07-10T00:00:00.000Z' },
    ];
    mockedReadWorktrees.mockResolvedValue(postArchiveList);
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeArchive(
      archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
      adapterContext(events),
    );

    expect(mockedReadWorktrees).toHaveBeenCalledWith('ws-1');
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'ws-1', worktrees: postArchiveList },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('does not broadcast to the renderer when the archive fails', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedArchiveSingle.mockRejectedValue(new Error('archive failed'));
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeArchive(
      archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
      adapterContext(events),
    );

    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it.each([
    ['absent mode', undefined, true],
    ['archive mode', 'archive', true],
    ['delete mode', 'delete', false],
  ] as const)(
    'archives a multi-repo worktree with %s and the expected retained-item lock',
    async (_label, mode, locksAfterArchive) => {
      mockedReadConfig.mockResolvedValue(config('multi-repo'));
      mockedArchiveMulti.mockResolvedValue(archivedResult);
      const events: PortalEventEnvelope[] = [];
      const payload = {
        workspaceId: 'ws-2',
        worktreeId: 'wt-9',
        ...(mode === undefined ? {} : { mode }),
      };

      await handlePortalWorktreeArchive(
        archiveCommand(payload),
        adapterContext(events),
      );

      const archiveArgs = mockedArchiveMulti.mock.calls[0]?.[0];
      expect(archiveArgs).toEqual(
        expect.objectContaining({ workspaceId: 'ws-2', worktreeId: 'wt-9' }),
      );
      if (locksAfterArchive) {
        expect(archiveArgs).toHaveProperty('lockAfterArchive', true);
      } else {
        expect(archiveArgs).not.toHaveProperty('lockAfterArchive');
      }
      expect(archiveArgs).not.toHaveProperty('repoPath');
      expect(archiveArgs).not.toHaveProperty('deleteBranch');
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).toEqual([
        'portal.command.completed',
      ]);
    },
  );

  it.each([
    ['unsupported string', 'remove'],
    ['null', null],
    ['number', 1],
    ['object', { action: 'delete' }],
  ] as const)(
    'rejects an invalid archive mode supplied as %s before side effects',
    async (_label, mode) => {
      const events: PortalEventEnvelope[] = [];

      await handlePortalWorktreeArchive(
        archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1', mode }),
        adapterContext(events),
      );

      expect(mockedReadConfig).not.toHaveBeenCalled();
      expect(mockedAssertNotSplitLocked).not.toHaveBeenCalled();
      expect(
        mockedAssertNotSplitDestinationWorktreeClaimed,
      ).not.toHaveBeenCalled();
      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(mockedArchiveMulti).not.toHaveBeenCalled();
      expect(mockedCleanupLiveState).not.toHaveBeenCalled();
      expect(mockedPurgeObservabilityData).not.toHaveBeenCalled();
      expect(mockedTelemetry).not.toHaveBeenCalled();
      expect(mockedSendToWindow).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          type: 'portal.command.failed',
          payload: {
            error: {
              code: 'invalid_payload',
              message: 'Invalid worktree archive mode.',
            },
          },
        }),
      );
    },
  );

  it('fails when a split PR is in progress (split-lock guard throws)', async () => {
    mockedReadConfig.mockResolvedValue(config('single-repo'));
    mockedAssertNotSplitLocked.mockImplementation(() => {
      throw new Error('split in progress');
    });
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeArchive(
      archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
      adapterContext(events),
    );

    expect(mockedArchiveSingle).not.toHaveBeenCalled();
    expect(mockedTelemetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });

  it.each(['single-repo', 'multi-repo'] as const)(
    'refuses to archive a %s worktree while one of its chats has live delegates',
    async (type) => {
      mockedReadConfig.mockResolvedValue(config(type));
      mockedAssertNotSplitLocked.mockImplementation(() => undefined);
      const events: PortalEventEnvelope[] = [];
      setProviderTask(
        createLiveBackgroundTaskOwner('ws-1', 'wt-1', 'chat-a', 'local_agent'),
      );
      setDelegationActivity('portal-archive-owner', 'ws-1/wt-1/chat-a', 1);
      try {
        await handlePortalWorktreeArchive(
          archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
          adapterContext(events),
        );
      } finally {
        setDelegationActivity('portal-archive-owner', 'ws-1/wt-1/chat-a', 0);
      }

      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(mockedArchiveMulti).not.toHaveBeenCalled();
      expect(mockedTelemetry).not.toHaveBeenCalled();
      expect(events).toEqual([
        expect.objectContaining({
          type: 'portal.command.failed',
          payload: {
            error: {
              code: 'conflict',
              message: 'Delegates are still running here. Stop them first.',
            },
          },
        }),
      ]);
    },
  );

  it.each([
    ['single-repo', 'local_agent'],
    ['single-repo', 'local_workflow'],
    ['multi-repo', 'local_agent'],
    ['multi-repo', 'local_workflow'],
  ] as const)(
    'refuses to archive a %s worktree while a chat has a live %s',
    async (type, taskType) => {
      mockedReadConfig.mockResolvedValue(config(type));
      const owner = createLiveBackgroundTaskOwner(
        'ws-1',
        'wt-1',
        'chat-a',
        taskType,
      );
      setProviderTask(owner);
      const events: PortalEventEnvelope[] = [];

      await handlePortalWorktreeArchive(
        archiveCommand({ workspaceId: 'ws-1', worktreeId: 'wt-1' }),
        adapterContext(events),
      );

      expect(mockedArchiveSingle).not.toHaveBeenCalled();
      expect(mockedArchiveMulti).not.toHaveBeenCalled();
      expect(mockedCleanupLiveState).not.toHaveBeenCalled();
      expect(mockedPurgeObservabilityData).not.toHaveBeenCalled();
      expect(mockedTelemetry).not.toHaveBeenCalled();
      expect(mockedSendToWindow).not.toHaveBeenCalled();
      expect(events).toEqual([
        expect.objectContaining({
          type: 'portal.command.failed',
          payload: {
            error: {
              code: 'conflict',
              message:
                'Background agents or workflows are still running here. Stop them first.',
            },
          },
        }),
      ]);
    },
  );

  it('rejects cowork and missing-field payloads', async () => {
    mockedReadConfig.mockResolvedValue(config('cowork'));
    const coworkEvents: PortalEventEnvelope[] = [];
    await handlePortalWorktreeArchive(
      archiveCommand({ workspaceId: 'cw-1', worktreeId: 'wt-1' }),
      adapterContext(coworkEvents),
    );
    expect(mockedArchiveSingle).not.toHaveBeenCalled();
    expect(coworkEvents.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);

    const missingEvents: PortalEventEnvelope[] = [];
    await handlePortalWorktreeArchive(
      archiveCommand({ workspaceId: 'ws-1' }),
      adapterContext(missingEvents),
    );
    expect(mockedReadConfig).toHaveBeenCalledTimes(1); // only the cowork call
    expect(missingEvents.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });
});

// Persisted update and reorder outcomes are golden-tested over real storage
// in worktree-adapter-golden.test.ts; these cover payload admission.
describe('worktree portal adapter — update and reorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadConfig.mockResolvedValue(config('single-repo'));
  });

  it.each([
    ['no editable fields', { workspaceId: 'ws-1', worktreeId: 'wt-1' }],
    [
      'a non-string label',
      { workspaceId: 'ws-1', worktreeId: 'wt-1', label: 42 },
    ],
    [
      'a non-boolean hidden value',
      { workspaceId: 'ws-1', worktreeId: 'wt-1', hidden: 'yes' },
    ],
  ])('rejects an update payload with %s', async (_description, payload) => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeUpdate(
      updateCommand(payload),
      adapterContext(events),
    );

    expect(mockedUpdateWorktrees).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('rejects a malformed reorder payload before reading sidebar state', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalWorktreeReorder(
      reorderCommand({
        workspaceId: 'ws-1',
        activeWorktreeId: 'wt-a',
      }),
      adapterContext(events),
    );

    expect(mockedReadConfig).not.toHaveBeenCalled();
    expect(mockedUpdateWorktrees).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });
});
