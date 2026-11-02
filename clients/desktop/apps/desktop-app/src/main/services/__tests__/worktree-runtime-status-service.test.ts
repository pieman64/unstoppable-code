import type * as WorktreeRuntimeStatusModule from '../worktree-runtime-status-service';
const statMock = jest.fn<Promise<{ mtimeMs: number }>, [string]>();
const readFileMock = jest.fn<Promise<string>, [string, string]>();
const readChatTabsFileMock = jest.fn<Promise<ChatTabsFile>, [string, string]>();
jest.mock('../../lib/chat-tabs-reader', () => ({
  get readChatTabsFile(): typeof readChatTabsFileMock {
    return readChatTabsFileMock;
  },
}));
const getAllActiveSessionInfosMock = jest.fn<ChatActiveSessionInfo[], []>();
const subscribeChatSessionActivityMock = jest.fn<() => void, [() => void]>();
const getActivePipelineExecutionHandlesMock = jest.fn();
const subscribeToActiveCountChangeMock = jest.fn<() => void, [() => void]>();
const subscribePipelineRunUpdatesMock = jest.fn<() => void, [() => void]>();
const getRunningWorktreeTargetsMock = jest.fn();
const addTerminalEventListenerMock = jest.fn<() => void, [() => void]>();
const listTrackedShellScriptsMock = jest.fn();
const subscribeTrackedScriptsChangedMock = jest.fn<() => void, [() => void]>();
const listActiveHookRunTargetsMock = jest.fn();
const subscribeActiveHookRunsChangedMock = jest.fn<() => void, [() => void]>();
type BackgroundWorkTarget = {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  hasBackgroundWork: boolean;
  blocksClose: boolean;
  backgroundTasks: number;
};
const listBackgroundWorkTargetsMock = jest.fn<BackgroundWorkTarget[], []>();
const subscribeBackgroundWorkMock = jest.fn<
  () => void,
  [(sessionKey: string) => void]
>();
const enqueuePortalEventMock = jest.fn<void, [PortalEventEnvelope]>();
const isCanopyPortalActiveMock = jest.fn<boolean, []>(() => true);
const getWorkspacePortalWorktreeEntityMock = jest.fn<
  Promise<PortalEntityEnvelope | null>,
  [string, string, WorktreeRuntimeStatus]
>();

jest.mock('node:fs/promises', () => ({
  get readFile(): typeof readFileMock {
    return readFileMock;
  },
  get stat(): typeof statMock {
    return statMock;
  },
}));

jest.mock('../../agents/session-manager', () => ({
  get getAllActiveSessionInfos(): typeof getAllActiveSessionInfosMock {
    return getAllActiveSessionInfosMock;
  },
  get subscribeChatSessionActivity(): typeof subscribeChatSessionActivityMock {
    return subscribeChatSessionActivityMock;
  },
  listLiveBackgroundTaskOwners: jest.fn(() => []),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
}));

jest.mock('../../pipelines/pipeline-execution-registry', () => ({
  get getActivePipelineExecutionHandles(): typeof getActivePipelineExecutionHandlesMock {
    return getActivePipelineExecutionHandlesMock;
  },
  get subscribeToActiveCountChange(): typeof subscribeToActiveCountChangeMock {
    return subscribeToActiveCountChangeMock;
  },
}));

jest.mock('../pipelines-service', () => ({
  get subscribePipelineRunUpdates(): typeof subscribePipelineRunUpdatesMock {
    return subscribePipelineRunUpdatesMock;
  },
}));

jest.mock('../../terminal/worker-terminal', () => ({
  workerTerminal: {
    get runningWorktrees(): typeof getRunningWorktreeTargetsMock {
      return getRunningWorktreeTargetsMock;
    },
    get addEventListener(): typeof addTerminalEventListenerMock {
      return addTerminalEventListenerMock;
    },
  },
}));

jest.mock('../../lib/script-runner', () => ({
  get listTrackedShellScripts(): typeof listTrackedShellScriptsMock {
    return listTrackedShellScriptsMock;
  },
  get subscribeTrackedScriptsChanged(): typeof subscribeTrackedScriptsChangedMock {
    return subscribeTrackedScriptsChangedMock;
  },
}));

jest.mock('../../lib/hook-runner', () => ({
  get listActiveHookRunTargets(): typeof listActiveHookRunTargetsMock {
    return listActiveHookRunTargetsMock;
  },
  get subscribeActiveHookRunsChanged(): typeof subscribeActiveHookRunsChangedMock {
    return subscribeActiveHookRunsChangedMock;
  },
}));

jest.mock('../../agents/background-work', () => ({
  listBackgroundWorkTargets: listBackgroundWorkTargetsMock,
  subscribeBackgroundWork: subscribeBackgroundWorkMock,
}));

jest.mock('../../lib/resolve-worktree', () => ({
  resolveChatTabsFilePath: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}/chats.json`,
  ),
}));

jest.mock('../../portal/portal-event-bus', () => ({
  get enqueuePortalEvent(): typeof enqueuePortalEventMock {
    return enqueuePortalEventMock;
  },
  get isCanopyPortalActive(): typeof isCanopyPortalActiveMock {
    return isCanopyPortalActiveMock;
  },
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
}));

jest.mock('../workspace-portal-service', () => ({
  get getWorkspacePortalWorktreeEntity(): typeof getWorkspacePortalWorktreeEntityMock {
    return getWorkspacePortalWorktreeEntityMock;
  },
}));

import type {
  ChatActiveSessionInfo,
  ChatTabsFile,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  PersistedChatTab,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { setDelegationActivity } from '../../agents/delegation/activity';
import type { WorktreeRuntimeStatus } from '../worktree-runtime-status-service';

const {
  getWorktreeRuntimeStatuses,
  handleChatTabsWritten,
  resetWorktreeRuntimeStatusServiceForTests,
  startWorktreeRuntimeStatusService,
  stopWorktreeRuntimeStatusService,
} = jest.requireActual<typeof WorktreeRuntimeStatusModule>(
  '../worktree-runtime-status-service',
);

async function getWorktreeRuntimeStatus(
  workspaceId: string,
  target: WorktreeData,
): Promise<WorktreeRuntimeStatus> {
  const statuses = await getWorktreeRuntimeStatuses([
    { workspaceId, worktree: target },
  ]);
  return statuses.get(`${workspaceId}\u0000${target.id}`) ?? {};
}

let activityListener: (() => void) | null = null;
let pipelineCountListener: (() => void) | null = null;
let pipelineUpdateListener: (() => void) | null = null;
let terminalListener: ((event: { type: string }) => void) | null = null;
let scriptListener: (() => void) | null = null;
let hookListener: (() => void) | null = null;
let backgroundWorkListener: ((sessionKey: string) => void) | null = null;
let backgroundWorkTargets: BackgroundWorkTarget[] = [];
let sessions: ChatActiveSessionInfo[] = [];
let pipelineStates: Array<{
  status: 'running' | 'paused';
  project_id?: string;
  worktree_id?: string;
}> = [];
let terminalTargets: Array<{ projectId: string; worktreeId: string }> = [];
let scriptTargets: Array<{ projectId: string; worktreeId: string }> = [];
let hookTargets: Array<{ projectId: string; worktreeId: string }> = [];

const worktree: WorktreeData = {
  id: 'snake',
  branchName: 'feature/runtime',
  createdAt: '2026-07-27T00:00:00.000Z',
  status: 'active',
};

function session(
  chatId: string,
  turnActive: boolean,
  lastActivityAt: number,
): ChatActiveSessionInfo {
  return {
    chatId,
    projectId: 'workspace-1',
    worktreeId: 'snake',
    providerType: 'claude',
    turnActive,
    createdAt: lastActivityAt - 1000,
    lastActivityAt,
    turnCount: 1,
    pendingMessageCount: 0,
  };
}

function tab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-07-27T00:00:00.000Z',
    messages: [],
    providerType: 'claude',
    ...overrides,
  };
}

function tabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('worktree runtime status service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T10:20:30.900Z'));
    sessions = [];
    pipelineStates = [];
    terminalTargets = [];
    scriptTargets = [];
    hookTargets = [];
    readFileMock.mockResolvedValue(JSON.stringify(tabsFile([])));
    readChatTabsFileMock.mockReset();
    readChatTabsFileMock.mockResolvedValue(tabsFile([]));
    activityListener = null;
    pipelineCountListener = null;
    pipelineUpdateListener = null;
    terminalListener = null;
    scriptListener = null;
    hookListener = null;
    backgroundWorkListener = null;
    backgroundWorkTargets = [];
    statMock.mockReset();
    statMock.mockRejectedValue(new Error('missing'));
    isCanopyPortalActiveMock.mockReset();
    isCanopyPortalActiveMock.mockReturnValue(true);
    getAllActiveSessionInfosMock.mockReset();
    getAllActiveSessionInfosMock.mockImplementation(() => sessions);
    subscribeChatSessionActivityMock.mockReset();
    subscribeChatSessionActivityMock.mockImplementation(
      (listener: () => void): (() => void) => {
        activityListener = listener;
        return (): void => {
          activityListener = null;
        };
      },
    );
    getActivePipelineExecutionHandlesMock.mockReset();
    getActivePipelineExecutionHandlesMock.mockImplementation(() =>
      pipelineStates.map((state) => ({
        getState: (): (typeof pipelineStates)[number] => state,
      })),
    );
    getRunningWorktreeTargetsMock.mockReset();
    getRunningWorktreeTargetsMock.mockImplementation(() => terminalTargets);
    listTrackedShellScriptsMock.mockReset();
    listTrackedShellScriptsMock.mockImplementation(() => scriptTargets);
    listActiveHookRunTargetsMock.mockReset();
    listActiveHookRunTargetsMock.mockImplementation(() => hookTargets);
    const setListener =
      (
        setter: (listener: (() => void) | null) => void,
      ): ((listener: () => void) => () => void) =>
      (listener): (() => void) => {
        setter(listener);
        return (): void => {
          setter(null);
        };
      };
    subscribeToActiveCountChangeMock.mockReset();
    subscribeToActiveCountChangeMock.mockImplementation(
      setListener((listener) => {
        pipelineCountListener = listener;
      }),
    );
    subscribePipelineRunUpdatesMock.mockReset();
    subscribePipelineRunUpdatesMock.mockImplementation(
      setListener((listener) => {
        pipelineUpdateListener = listener;
      }),
    );
    addTerminalEventListenerMock.mockReset();
    addTerminalEventListenerMock.mockImplementation(
      (listener: (event: { type: string }) => void): (() => void) => {
        terminalListener = listener;
        return (): void => {
          terminalListener = null;
        };
      },
    );
    subscribeTrackedScriptsChangedMock.mockReset();
    subscribeTrackedScriptsChangedMock.mockImplementation(
      setListener((listener) => {
        scriptListener = listener;
      }),
    );
    subscribeActiveHookRunsChangedMock.mockReset();
    subscribeActiveHookRunsChangedMock.mockImplementation(
      setListener((listener) => {
        hookListener = listener;
      }),
    );
    listBackgroundWorkTargetsMock.mockReset();
    listBackgroundWorkTargetsMock.mockImplementation(
      () => backgroundWorkTargets,
    );
    subscribeBackgroundWorkMock.mockReset();
    subscribeBackgroundWorkMock.mockImplementation((listener) => {
      backgroundWorkListener = listener;
      return (): void => {
        backgroundWorkListener = null;
      };
    });
    enqueuePortalEventMock.mockReset();
    getWorkspacePortalWorktreeEntityMock.mockReset();
    getWorkspacePortalWorktreeEntityMock.mockImplementation(
      (
        workspaceId: string,
        worktreeId: string,
        runtimeStatus: WorktreeRuntimeStatus,
      ) =>
        Promise.resolve({
          entityType: 'worktree',
          localId: worktreeId,
          parentLocalId: workspaceId,
          payload: {
            workspaceLocalId: workspaceId,
            worktreeLocalId: worktreeId,
            branch: 'feature/runtime',
            branchName: 'feature/runtime',
            status: 'active',
            ...runtimeStatus,
          },
        }),
    );
  });

  afterEach(() => {
    resetWorktreeRuntimeStatusServiceForTests();
    jest.useRealTimers();
  });

  it('aggregates active and idle chats using turnActive only', async () => {
    sessions = [
      session('idle', false, Date.parse('2026-07-27T10:20:00.400Z')),
      session('active', true, Date.parse('2026-07-27T10:20:01.900Z')),
    ];
    startWorktreeRuntimeStatusService();

    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toEqual({
      isStreaming: true,
      lastActivityAt: '2026-07-27T10:20:01.000Z',
    });

    sessions = [
      {
        ...session('queued', false, Date.parse('2026-07-27T10:20:02Z')),
        pendingMessageCount: 3,
      },
    ];
    activityListener?.();
    jest.advanceTimersByTime(35);
    await flushAsync();

    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2],
    ).not.toHaveProperty('isStreaming');
  });

  it('shows live delegates as background work with their count, not streaming (turn-state phase 41f)', async () => {
    startWorktreeRuntimeStatusService();
    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toEqual({});

    backgroundWorkTargets = [
      {
        sessionKey: 'workspace-1/snake/chat-a',
        projectId: 'workspace-1',
        worktreeId: 'snake',
        chatId: 'chat-a',
        hasBackgroundWork: true,
        blocksClose: true,
        backgroundTasks: 1,
      },
    ];
    setDelegationActivity('status-owner', 'workspace-1/snake/chat-a', 0, 1);
    try {
      jest.advanceTimersByTime(35);
      await flushAsync();
      expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
      expect(getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2]).toEqual({
        hasBackgroundWork: true,
        backgroundTasks: 1,
      });
      await expect(
        getWorktreeRuntimeStatus('workspace-1', worktree),
      ).resolves.toEqual({ hasBackgroundWork: true, backgroundTasks: 1 });
      await expect(
        getWorktreeRuntimeStatus('workspace-1', {
          ...worktree,
          id: 'other-tree',
        }),
      ).resolves.toEqual({});
    } finally {
      backgroundWorkTargets = [];
      setDelegationActivity('status-owner', 'workspace-1/snake/chat-a', 0);
    }

    jest.advanceTimersByTime(35);
    await flushAsync();
    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(2);
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('isStreaming');
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('hasBackgroundWork');
  });

  it('stops refreshing on delegate activity after the service stops', async () => {
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);
    expect(backgroundWorkListener).not.toBeNull();
    stopWorktreeRuntimeStatusService();
    expect(backgroundWorkListener).toBeNull();
    getAllActiveSessionInfosMock.mockClear();

    setDelegationActivity('status-owner', 'workspace-1/snake/chat-a', 1);
    setDelegationActivity('status-owner', 'workspace-1/snake/chat-a', 0);
    jest.advanceTimersByTime(35);
    await flushAsync();

    expect(getAllActiveSessionInfosMock).not.toHaveBeenCalled();
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('emits background-only status changes without changing streaming state', async () => {
    sessions = [
      session('chat-background', false, Date.parse('2026-07-27T10:20:01.500Z')),
    ];
    pipelineStates = [
      {
        status: 'running',
        project_id: 'workspace-1',
        worktree_id: 'snake',
      },
    ];
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);

    const target: BackgroundWorkTarget = {
      sessionKey: 'workspace-1/snake/chat-background',
      projectId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'chat-background',
      hasBackgroundWork: true,
      blocksClose: false,
      backgroundTasks: 2,
    };
    backgroundWorkTargets = [target];
    backgroundWorkListener?.(target.sessionKey);
    jest.advanceTimersByTime(35);
    await flushAsync();

    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2],
    ).toMatchObject({
      hasBackgroundWork: true,
      backgroundTasks: 2,
      lastActivityAt: '2026-07-27T10:20:01.000Z',
      pipelineStatus: 'running',
      isRunningRun: true,
    });
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2],
    ).not.toHaveProperty('isStreaming');

    // Provider-only background work is data, not a streaming turn.
    backgroundWorkTargets = [];
    backgroundWorkListener?.(target.sessionKey);
    jest.advanceTimersByTime(35);
    await flushAsync();

    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(2);
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('hasBackgroundWork');
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('isStreaming');
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).toMatchObject({
      lastActivityAt: '2026-07-27T10:20:01.000Z',
      pipelineStatus: 'running',
      isRunningRun: true,
    });
  });

  it('still emits a background change that a non-Portal read saw first', async () => {
    const target: BackgroundWorkTarget = {
      sessionKey: 'workspace-1/snake/chat-background',
      projectId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'chat-background',
      hasBackgroundWork: true,
      blocksClose: true,
      backgroundTasks: 1,
    };
    startWorktreeRuntimeStatusService();
    backgroundWorkTargets = [target];
    backgroundWorkListener?.(target.sessionKey);
    jest.advanceTimersByTime(35);
    await flushAsync();
    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);

    // The last task ends. The desktop session snapshot (or auto-archive) reads
    // the runtime status inside the refresh window, before the Portal delta.
    backgroundWorkTargets = [];
    backgroundWorkListener?.(target.sessionKey);
    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toEqual({});
    jest.advanceTimersByTime(35);
    await flushAsync();

    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(2);
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('backgroundTasks');
  });

  it('derives all executable runtime aggregates and omits them while idle', async () => {
    startWorktreeRuntimeStatusService();
    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toEqual({});

    pipelineStates = [
      {
        status: 'running',
        project_id: 'workspace-1',
        worktree_id: 'snake',
      },
      {
        status: 'paused',
        project_id: 'workspace-1',
        worktree_id: 'snake',
      },
    ];
    terminalTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];
    scriptTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];
    hookTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];

    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toMatchObject({
      pipelineStatus: 'running',
      terminalStatus: 'running',
      scriptStatus: 'running',
      hookStatus: 'running',
      isRunningRun: true,
    });
  });

  it.each([
    [
      'pipeline',
      (): void => {
        pipelineStates = [
          {
            status: 'paused',
            project_id: 'workspace-1',
            worktree_id: 'snake',
          },
        ];
        pipelineUpdateListener?.();
      },
      { pipelineStatus: 'paused' },
    ],
    [
      'terminal',
      (): void => {
        terminalTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];
        terminalListener?.({ type: 'runningChanged' });
      },
      { terminalStatus: 'running' },
    ],
    [
      'script',
      (): void => {
        scriptTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];
        scriptListener?.();
      },
      { scriptStatus: 'running' },
    ],
    [
      'hook',
      (): void => {
        hookTargets = [{ projectId: 'workspace-1', worktreeId: 'snake' }];
        hookListener?.();
      },
      { hookStatus: 'running' },
    ],
    [
      'running pipeline contribution',
      (): void => {
        pipelineStates = [
          {
            status: 'running',
            project_id: 'workspace-1',
            worktree_id: 'snake',
          },
        ];
        pipelineCountListener?.();
      },
      { pipelineStatus: 'running', isRunningRun: true },
    ],
  ])(
    'emits a delta when the %s fingerprint contribution changes',
    async (_label, change, expected) => {
      startWorktreeRuntimeStatusService();
      await getWorktreeRuntimeStatus('workspace-1', worktree);

      change();
      jest.advanceTimersByTime(35);
      await flushAsync();

      expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);
      expect(
        getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2],
      ).toMatchObject(expected);
    },
  );

  it('derives and clears unread and plan approval from live writes', async () => {
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);

    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([
        tab('chat-1', {
          unread: true,
          pendingPlanExit: {
            requestId: 'request-1',
            toolUseId: 'tool-1',
          },
        }),
      ]),
    );
    await flushAsync();
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[0]?.[2],
    ).toMatchObject({
      hasUnread: true,
      awaitingApproval: true,
      lastActivityAt: '2026-07-27T10:20:30.000Z',
    });

    jest.setSystemTime(new Date('2026-07-27T10:20:31.100Z'));
    handleChatTabsWritten('workspace-1', 'snake', tabsFile([tab('chat-1')]));
    await flushAsync();
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('hasUnread');
    expect(
      getWorkspacePortalWorktreeEntityMock.mock.calls[1]?.[2],
    ).not.toHaveProperty('awaitingApproval');
  });

  it('swallows entity-builder rejection and emits nothing', async () => {
    getWorkspacePortalWorktreeEntityMock.mockRejectedValueOnce(
      new Error('project deleted'),
    );
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);

    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([tab('chat-1', { unread: true })]),
    );
    await flushAsync();

    expect(getWorkspacePortalWorktreeEntityMock).toHaveBeenCalledTimes(1);
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('skips delta emission entirely while no portal session is active', async () => {
    isCanopyPortalActiveMock.mockReturnValue(false);
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);

    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([tab('chat-1', { unread: true })]),
    );
    await flushAsync();

    expect(getWorkspacePortalWorktreeEntityMock).not.toHaveBeenCalled();
    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });

  it('does not regress fresher live badge state from a stale snapshot mirror', async () => {
    startWorktreeRuntimeStatusService();

    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([tab('chat-1', { unread: true })]),
    );
    await flushAsync();

    // Snapshot arrives in the write-vs-flush window: worktrees.json badges
    // are stale (empty) while the live write above already saw unread.
    const status = await getWorktreeRuntimeStatus('workspace-1', {
      ...worktree,
      chatBadges: {
        version: 1,
        unreadChats: [],
        approvalChats: [],
        needsHydration: false,
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
    });

    expect(status).toMatchObject({ hasUnread: true });
  });

  it('builds an overview from the persisted badge mirror without reading chat storage', async () => {
    startWorktreeRuntimeStatusService();
    const statuses = await getWorktreeRuntimeStatuses([
      {
        workspaceId: 'workspace-1',
        worktree: {
          ...worktree,
          chatBadges: {
            version: 1,
            unreadChats: [{ chatId: 'chat-1', title: 'Chat' }],
            approvalChats: [],
            needsHydration: false,
            updatedAt: '2026-07-27T00:00:00.000Z',
          },
        },
      },
      {
        workspaceId: 'workspace-1',
        worktree: { ...worktree, id: 'other' },
      },
    ]);

    expect(readChatTabsFileMock).not.toHaveBeenCalled();
    expect(statuses.get('workspace-1\u0000snake')).toEqual({ hasUnread: true });
    expect(statuses.get('workspace-1\u0000other')).toEqual({});
  });

  it('keeps live badge writes across portal stops and before the portal starts', async () => {
    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([tab('chat-1', { unread: true })]),
    );
    startWorktreeRuntimeStatusService();
    stopWorktreeRuntimeStatusService();
    startWorktreeRuntimeStatusService();

    await expect(
      getWorktreeRuntimeStatus('workspace-1', {
        ...worktree,
        chatBadges: {
          version: 1,
          unreadChats: [],
          approvalChats: [],
          needsHydration: false,
          updatedAt: '2026-07-27T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({
      hasUnread: true,
      lastActivityAt: '2026-07-27T10:20:30.000Z',
    });
    expect(readChatTabsFileMock).not.toHaveBeenCalled();
    expect(getWorkspacePortalWorktreeEntityMock).not.toHaveBeenCalled();
  });

  it('uses the latest live session or chat write time', async () => {
    sessions = [
      session('active', false, Date.parse('2026-07-27T10:20:20.900Z')),
    ];
    handleChatTabsWritten('workspace-1', 'snake', tabsFile([tab('chat-1')]));
    startWorktreeRuntimeStatusService();

    await expect(
      getWorktreeRuntimeStatus('workspace-1', worktree),
    ).resolves.toEqual({
      lastActivityAt: '2026-07-27T10:20:30.000Z',
    });
  });

  it('projects unread and approval from the badge mirror', async () => {
    await expect(
      getWorktreeRuntimeStatus('workspace-1', {
        ...worktree,
        chatBadges: {
          version: 1,
          unreadChats: [{ chatId: 'chat-1', title: 'Chat' }],
          approvalChats: [{ chatId: 'chat-1', title: 'Chat' }],
          needsHydration: false,
          updatedAt: '2026-07-27T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ hasUnread: true, awaitingApproval: true });
  });

  it('deduplicates unchanged writes and coalesces session bursts', async () => {
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);
    const file = tabsFile([tab('chat-1', { unread: true })]);

    handleChatTabsWritten('workspace-1', 'snake', file);
    handleChatTabsWritten('workspace-1', 'snake', file);
    await flushAsync();
    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(1);

    sessions = [session('active', true, Date.now())];
    activityListener?.();
    activityListener?.();
    activityListener?.();
    expect(getAllActiveSessionInfosMock).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(35);
    await flushAsync();
    expect(getAllActiveSessionInfosMock).toHaveBeenCalledTimes(3);
    expect(enqueuePortalEventMock).toHaveBeenCalledTimes(2);
  });

  it('emits a complete worktree delta contract and keeps busy absent', async () => {
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);
    handleChatTabsWritten(
      'workspace-1',
      'snake',
      tabsFile([tab('chat-1', { unread: true })]),
    );
    await flushAsync();

    const event = enqueuePortalEventMock.mock.calls[0]?.[0];
    expect(event?.type).toBe('portal.state.delta');
    expect(event?.payload).toMatchObject({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
    const deltaPayload = event?.payload as { generatedAt?: unknown };
    expect(typeof deltaPayload.generatedAt).toBe('string');
    const payload = event?.payload as {
      entities?: PortalEntityEnvelope[];
    };
    expect(payload.entities?.[0]).toMatchObject({
      entityType: 'worktree',
      localId: 'snake',
      parentLocalId: 'workspace-1',
      payload: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        branch: 'feature/runtime',
        branchName: 'feature/runtime',
        hasUnread: true,
      },
    });
    expect(payload.entities?.[0]?.payload).not.toHaveProperty('busy');
  });

  it('cancels pending and stale async emissions after shutdown', async () => {
    const entityResolution: {
      resolve:
        | ((
            value:
              | PortalEntityEnvelope
              | PromiseLike<PortalEntityEnvelope | null>
              | null,
          ) => void)
        | undefined;
    } = { resolve: undefined };
    getWorkspacePortalWorktreeEntityMock.mockImplementation(
      () =>
        new Promise<PortalEntityEnvelope | null>((resolve): void => {
          entityResolution.resolve = resolve;
        }),
    );
    startWorktreeRuntimeStatusService();
    await getWorktreeRuntimeStatus('workspace-1', worktree);
    sessions = [session('active', true, Date.now())];
    activityListener?.();
    jest.advanceTimersByTime(35);
    await Promise.resolve();
    stopWorktreeRuntimeStatusService();
    entityResolution.resolve?.({
      entityType: 'worktree',
      localId: 'snake',
      payload: {},
    });
    await flushAsync();

    expect(enqueuePortalEventMock).not.toHaveBeenCalled();
  });
});
