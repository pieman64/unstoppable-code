/**
 * The shared "can this chat close?" predicate used by `closeTab`/`closeTabs`,
 * the tab context menu, the tab ×, and every panel close path.
 */
import type { ChatTab } from '../chat/types';
import {
  BACKGROUND_BLOCKS_CLOSE_NOTICE,
  BACKGROUND_BLOCKS_CLOSE_TOOLTIP,
  BACKGROUND_BLOCKS_REMOVAL_TOOLTIP,
  DELEGATES_BLOCK_CLOSE_NOTICE,
  DELEGATES_BLOCK_CLOSE_TOOLTIP,
  DELEGATES_BLOCK_REMOVAL_TOOLTIP,
  closeBlockedNotice,
  closeBlockedTooltip,
  getChatTabCloseBlocker,
  getWorkspaceRemovalBlocker,
  getWorktreeRemovalBlocker,
  isChatTabBusy,
  isChatTabTurnActive,
  notifyCloseBlocked,
  recheckWorkspaceRemovalBlockedReason,
  recheckWorktreeRemovalBlockedReason,
  removalBlockedReason,
} from '../chat/close-guard';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '../delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '../liveBackgroundTaskStore';
import type { ActivityLiveBgTasksResponse } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '../githubStore';

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

function setLiveDelegates(chatId: string, live: number, queued = 0): void {
  useDelegationActivityStore.getState().applyActivity({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId,
    live,
    queued,
  });
}

function setLiveTasks(
  chatId: string,
  taskTypes: ReadonlyArray<string | undefined>,
  worktreeId = 'wt',
): void {
  useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'proj',
    worktreeId,
    chatId,
    sessionActive: true,
    liveTasks: taskTypes.map((taskType, index) => ({
      taskId: `${chatId}-${index}`,
      ...(taskType === undefined ? {} : { taskType }),
    })),
  });
}

function installLiveTaskPull(
  chatsByWorktree: Record<string, ActivityLiveBgTasksResponse['chats']>,
): jest.Mock {
  const listLiveBgTasks = jest.fn(
    (request: { projectId: string; worktreeId: string }) =>
      Promise.resolve({ chats: chatsByWorktree[request.worktreeId] ?? {} }),
  );
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { api: { activity: { listLiveBgTasks } } },
  });
  return listLiveBgTasks;
}

const originalAddToast = useGitHubStore.getState().addToast;

beforeEach(() => {
  useGitHubStore.setState({
    toasts: [],
    notifications: [],
    addToast: originalAddToast,
  });
});

afterEach(() => {
  resetDelegationActivityStoreForTests();
  resetLiveBackgroundTaskStoreForTests();
  Reflect.deleteProperty(global, 'window');
});

describe('chat close guard', () => {
  it('lets an idle chat and every file tab close', () => {
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBeNull();
    setLiveDelegates('file-1', 1);
    expect(
      getChatTabCloseBlocker(
        makeTab({ id: 'file-1', kind: 'file', status: 'streaming' }),
        'proj',
        'wt',
      ),
    ).toBeNull();
  });

  it.each([
    ['streaming', makeTab({ status: 'streaming' })],
    ['queued', makeTab({ queuedMessages: [{ text: 'Next' }] })],
    ['pending plan exit', makeTab({ pendingPlanExit: { plan: 'Plan' } })],
  ])('keeps a %s chat open for its own turn', (_name, tab) => {
    expect(isChatTabTurnActive(tab)).toBe(true);
    expect(getChatTabCloseBlocker(tab, 'proj', 'wt')).toBe('active');
  });

  it('lets a lone queued hook placeholder close', () => {
    const tab = makeTab({
      queuedHookPlaceholder: true,
      queuedMessages: [{ text: 'Hook prompt', queuedHookQueueId: 'queue-1' }],
    });
    expect(isChatTabBusy(tab, 'proj', 'wt')).toBe(false);
  });

  it('keeps an idle chat with live delegates open, even with only queued delegations', () => {
    setLiveDelegates('chat-1', 0, 1);
    const tab = makeTab();

    expect(isChatTabTurnActive(tab)).toBe(false);
    expect(getChatTabCloseBlocker(tab, 'proj', 'wt')).toBe('delegates');
    // Scoped to the chat's own worktree.
    expect(getChatTabCloseBlocker(tab, 'proj', 'other')).toBeNull();

    setLiveDelegates('chat-1', 0, 0);
    expect(isChatTabBusy(tab, 'proj', 'wt')).toBe(false);
  });

  it('reports its own turn before delegates', () => {
    setLiveDelegates('chat-1', 1);
    expect(
      getChatTabCloseBlocker(makeTab({ status: 'streaming' }), 'proj', 'wt'),
    ).toBe('active');
  });

  it.each(['local_agent', 'local_workflow'])(
    'keeps an idle chat with a live provider %s open',
    (taskType) => {
      setLiveTasks('chat-1', ['local_bash', taskType]);
      const tab = makeTab();

      expect(getChatTabCloseBlocker(tab, 'proj', 'wt')).toBe('background');
      expect(isChatTabBusy(tab, 'proj', 'wt')).toBe(true);
      // Scoped to the chat's own worktree.
      expect(getChatTabCloseBlocker(tab, 'proj', 'other')).toBeNull();
    },
  );

  it('lets a chat with only shells, MCP tasks or untyped tasks close', () => {
    setLiveTasks('chat-1', ['local_bash', 'mcp_task', undefined]);
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBeNull();
  });

  it('reads the live-task state it is given', () => {
    setLiveTasks('chat-1', ['local_agent']);
    const blocking = useLiveBackgroundTaskStore.getState();
    resetLiveBackgroundTaskStoreForTests();

    expect(
      getChatTabCloseBlocker(
        makeTab(),
        'proj',
        'wt',
        useDelegationActivityStore.getState(),
        blocking,
      ),
    ).toBe('background');
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBeNull();
  });

  it('reports its own turn, then delegates, then provider work', () => {
    setLiveTasks('chat-1', ['local_agent']);
    setLiveDelegates('chat-1', 1);
    expect(
      getChatTabCloseBlocker(makeTab({ status: 'streaming' }), 'proj', 'wt'),
    ).toBe('active');
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBe('delegates');
    setLiveDelegates('chat-1', 0);
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBe('background');
  });

  it('explains only the blockers the tab cannot show itself', () => {
    expect(closeBlockedTooltip('delegates')).toBe(
      DELEGATES_BLOCK_CLOSE_TOOLTIP,
    );
    expect(closeBlockedTooltip('background')).toBe(
      BACKGROUND_BLOCKS_CLOSE_TOOLTIP,
    );
    expect(closeBlockedTooltip('active')).toBeUndefined();
    expect(closeBlockedTooltip(null)).toBeUndefined();
    expect(DELEGATES_BLOCK_CLOSE_TOOLTIP).toBe(
      'Stop its delegates to close this chat',
    );
    expect(BACKGROUND_BLOCKS_CLOSE_TOOLTIP).toBe(
      'Stop its background agents and workflows to close this chat',
    );
  });

  it('picks one notice per gesture, delegates first', () => {
    expect(closeBlockedNotice([])).toBeNull();
    expect(closeBlockedNotice(['active', null])).toBeNull();
    expect(closeBlockedNotice(['background', 'active'])).toBe(
      BACKGROUND_BLOCKS_CLOSE_NOTICE,
    );
    expect(closeBlockedNotice(['background', 'delegates'])).toBe(
      DELEGATES_BLOCK_CLOSE_NOTICE,
    );
    expect(DELEGATES_BLOCK_CLOSE_NOTICE).toBe(
      'Delegates are still running. Open background work and stop them to close this chat.',
    );
    expect(BACKGROUND_BLOCKS_CLOSE_NOTICE).toBe(
      'Background agents or workflows are still running. Open background work and stop them to close this chat.',
    );
  });

  it('shows one background notice for a gesture refused by provider work', () => {
    jest.useFakeTimers();
    notifyCloseBlocked(['background', 'background', 'active']);
    notifyCloseBlocked(['active']);

    const toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      message: BACKGROUND_BLOCKS_CLOSE_NOTICE,
      type: 'info',
      meta: { forceInApp: true, suppressOsNotification: true },
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('shows the refusal notice once while it is on screen', () => {
    // The toast's auto-dismiss timer must not outlive the test.
    jest.useFakeTimers();
    notifyCloseBlocked(['delegates']);
    notifyCloseBlocked(['delegates', 'background']);

    const toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      message: DELEGATES_BLOCK_CLOSE_NOTICE,
      type: 'info',
      meta: { forceInApp: true, suppressOsNotification: true },
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('removal guard', () => {
  it('reports delegates first, then provider agents and workflows, never shells', () => {
    setLiveTasks('chat-1', ['local_bash']);
    expect(getWorktreeRemovalBlocker('proj', 'wt')).toBeNull();
    expect(getWorkspaceRemovalBlocker('proj')).toBeNull();

    setLiveTasks('chat-1', ['local_workflow']);
    expect(getWorktreeRemovalBlocker('proj', 'wt')).toBe('background');
    expect(getWorktreeRemovalBlocker('proj', 'other')).toBeNull();
    expect(getWorkspaceRemovalBlocker('proj')).toBe('background');
    expect(getWorkspaceRemovalBlocker('elsewhere')).toBeNull();

    setLiveDelegates('chat-2', 1);
    expect(getWorktreeRemovalBlocker('proj', 'wt')).toBe('delegates');
    expect(getWorkspaceRemovalBlocker('proj')).toBe('delegates');
  });

  it('maps each blocker to its removal copy', () => {
    expect(removalBlockedReason('delegates')).toBe(
      DELEGATES_BLOCK_REMOVAL_TOOLTIP,
    );
    expect(removalBlockedReason('background')).toBe(
      BACKGROUND_BLOCKS_REMOVAL_TOOLTIP,
    );
    expect(removalBlockedReason(null)).toBeUndefined();
    expect(DELEGATES_BLOCK_REMOVAL_TOOLTIP).toBe(
      'Delegates are still running here. Stop them first.',
    );
    expect(BACKGROUND_BLOCKS_REMOVAL_TOOLTIP).toBe(
      'Background agents or workflows are still running here. Stop them first.',
    );
  });

  it('hydrates unvisited worktrees before re-checking a removal', async () => {
    const listLiveBgTasks = installLiveTaskPull({
      busy: {
        'chat-9': {
          sessionActive: true,
          liveTasks: [{ taskId: 'a', taskType: 'local_agent' }],
        },
      },
    });

    await expect(
      recheckWorktreeRemovalBlockedReason([
        { projectId: 'proj', worktreeId: 'idle' },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      recheckWorktreeRemovalBlockedReason([
        { projectId: 'proj', worktreeId: 'idle' },
        { projectId: 'proj', worktreeId: 'busy' },
      ]),
    ).resolves.toBe(BACKGROUND_BLOCKS_REMOVAL_TOOLTIP);
    expect(listLiveBgTasks).toHaveBeenCalledTimes(2);
  });

  it('re-checks a whole workspace after hydrating its worktrees', async () => {
    installLiveTaskPull({
      busy: {
        'chat-9': {
          sessionActive: true,
          liveTasks: [{ taskId: 'a', taskType: 'remote_agent' }],
        },
      },
    });
    await expect(
      recheckWorkspaceRemovalBlockedReason('proj', ['idle']),
    ).resolves.toBeUndefined();
    await expect(
      recheckWorkspaceRemovalBlockedReason('proj', ['idle', 'busy']),
    ).resolves.toBe(BACKGROUND_BLOCKS_REMOVAL_TOOLTIP);

    setLiveDelegates('chat-1', 0, 1);
    await expect(
      recheckWorkspaceRemovalBlockedReason('proj', []),
    ).resolves.toBe(DELEGATES_BLOCK_REMOVAL_TOOLTIP);
  });
});
