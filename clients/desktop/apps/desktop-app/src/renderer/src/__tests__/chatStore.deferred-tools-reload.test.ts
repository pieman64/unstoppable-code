import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type {
  ChatTabPluginSelections,
  ChatUpdatePluginsRequest,
  ChatUpdatePluginsResponse,
  DeferredToolsReloadAck,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadBeginRequest,
  DeferredToolsReloadCancelRequest,
  DeferredToolsReloadEvent,
  DeferredToolsReloadFinishRequest,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';
import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
} from '../stores/chat/deferred-tool-reload';

const sendMessageMock = jest.fn().mockResolvedValue(undefined);
const cancelChatMock = jest.fn().mockResolvedValue(undefined);
const saveTabsMock = jest.fn().mockResolvedValue(undefined);
const loadTabsMock = jest
  .fn()
  .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' });
const activeSessionsMock = jest
  .fn()
  .mockResolvedValue({ activeChatIds: [], sessions: [] });
const discoverWorktreeEnvMock = jest.fn().mockResolvedValue(undefined);
const updatePluginsMock = jest
  .fn<Promise<ChatUpdatePluginsResponse>, [ChatUpdatePluginsRequest]>()
  .mockImplementation((request) =>
    Promise.resolve({ pluginSelections: request.pluginSelections }),
  );
const beginReloadMock = jest.fn<
  Promise<DeferredToolsReloadAck>,
  [DeferredToolsReloadBeginRequest]
>();
const finishReloadMock = jest.fn<
  Promise<DeferredToolsReloadAck>,
  [DeferredToolsReloadFinishRequest]
>();
const cancelReloadMock = jest.fn<
  Promise<DeferredToolsReloadAck>,
  [DeferredToolsReloadCancelRequest]
>();
const noop = jest.fn();

function ack(requestId: string, accepted: boolean): DeferredToolsReloadAck {
  return {
    requestId,
    accepted,
    lifecycle: accepted
      ? { kind: 'state', state: 'ui_prepared' }
      : { kind: 'outcome', outcome: 'rejected' },
  };
}

function loadStore(
  surface: 'main' | 'app-advisor' = 'main',
): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: {
        search: surface === 'app-advisor' ? '?surface=app-advisor' : '',
      },
      api: {
        chat: {
          sendMessage: sendMessageMock,
          cancel: cancelChatMock,
          loadTabs: loadTabsMock,
          saveTabs: saveTabsMock,
          activeSessions: activeSessionsMock,
          updatePlugins: updatePluginsMock,
          beginDeferredToolsReload: beginReloadMock,
          finishDeferredToolsReload: finishReloadMock,
          cancelDeferredToolsReload: cancelReloadMock,
          answerMcpQuestion: noop,
          preparePlanFileSystemInstruction: noop,
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        github: {
          setForegroundWorktree: noop,
          requestFastRefresh: noop,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        activity: {
          plans: {
            create: noop,
            update: noop,
            list: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue(null),
          },
        },
        showOsNotification: jest.fn().mockResolvedValue({ shown: false }),
        onOsNotificationClicked: jest.fn(() => (): void => {}),
        onOsNotificationClosed: jest.fn(() => (): void => {}),
        appAdvisor: { openWindow: jest.fn().mockResolvedValue(undefined) },
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  return jest.requireActual<typeof ChatStoreModule>('../stores/chatStore');
}

const SCOPE: DeferredToolsReloadScopeKey = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};

const ADDITIONS: DeferredToolsReloadAdditions = {
  skillRefs: [{ sourceId: 'src', skillName: 'new-skill' }],
  pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'new-plugin' }],
  mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
};

const BASE_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: ['keep-collection'],
  skillRefs: [{ sourceId: 'src', skillName: 'existing-skill' }],
  pluginRefs: [],
};

function reloadEvent(
  over: Partial<DeferredToolsReloadEvent> = {},
): DeferredToolsReloadEvent {
  return {
    scope: SCOPE,
    requestId: 'req-1',
    toolCallId: 'tool-1',
    lifecycle: { kind: 'state', state: 'result_pending' },
    enabledResources: [{ ref: 'r1', kind: 'skill', name: 'New Skill' }],
    additions: ADDITIONS,
    ...over,
  };
}

function makeTab(
  over: Partial<ChatStoreModule.ChatTab> = {},
): ChatStoreModule.ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'do the thing' }],
        timestamp: 900,
      },
      {
        id: 'timer-1',
        role: 'system',
        blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: null }],
        timestamp: 1000,
      },
    ],
    status: 'streaming',
    error: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    sdkSessionId: 'sdk-abc',
    pluginSelections: BASE_SELECTIONS,
    ...over,
  };
}

function seedTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
  tab: ChatStoreModule.ChatTab,
  key = 'proj/wt',
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    worktreeChats: { [key]: { activeTabId: tab.id, tabs: [tab] } },
  });
}

function requireTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
  key = 'proj/wt',
  chatId = 'chat',
): ChatStoreModule.ChatTab {
  const tab = useChatStore
    .getState()
    .worktreeChats[key]?.tabs.find((t) => t.id === chatId);
  if (!tab) {
    throw new Error(`Tab ${chatId} not found in ${key}`);
  }
  return tab;
}

function openTurnTimer(tab: ChatStoreModule.ChatTab): boolean {
  return tab.messages.some((m) =>
    m.blocks.some((b) => b.type === 'turn_timer' && b.completedAt === null),
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

describe('chatStore deferred-tools reload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    beginReloadMock.mockReset().mockResolvedValue(ack('req-1', true));
    finishReloadMock.mockReset().mockResolvedValue(ack('req-1', true));
    cancelReloadMock.mockReset().mockResolvedValue(ack('req-1', true));
    updatePluginsMock.mockClear();
    discoverWorktreeEnvMock.mockClear();
    saveTabsMock.mockClear();
    cancelChatMock.mockClear();
    activeSessionsMock
      .mockReset()
      .mockResolvedValue({ activeChatIds: [], sessions: [] });
  });

  afterEach(async () => {
    await jest.runOnlyPendingTimersAsync();
    jest.useRealTimers();
    jest.resetModules();
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: undefined,
    });
  });

  it('merges additions into the originating tab, holds streaming, and adds no second timer or bubble', async () => {
    const { useChatStore } = loadStore();
    seedTab(useChatStore, makeTab());
    const messageCountBefore = requireTab(useChatStore).messages.length;

    useChatStore.getState().handleDeferredToolsReloadEvent(reloadEvent());

    // Marker is set synchronously and the tab stays streaming.
    const markedTab = requireTab(useChatStore);
    expect(markedTab.deferredToolsReload).toMatchObject({
      requestId: 'req-1',
      toolCallId: 'tool-1',
      userMessageId: 'user-1',
    });
    expect(markedTab.status).toBe('streaming');

    await flushMicrotasks();

    // begin → updatePlugins → finish all fired.
    expect(beginReloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SCOPE, additions: ADDITIONS }),
    );
    expect(updatePluginsMock).toHaveBeenCalledTimes(1);
    expect(discoverWorktreeEnvMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      pluginSelections: {
        collectionIds: ['keep-collection'],
        skillRefs: [
          { sourceId: 'src', skillName: 'existing-skill' },
          { sourceId: 'src', skillName: 'new-skill' },
        ],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'new-plugin' }],
        mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
      },
      providerType: 'claude',
    });
    expect(finishReloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: 'user-1',
      }),
    );

    const resultTab = requireTab(useChatStore);
    // Additive merge onto the SAME tab: keeps existing, appends the new refs.
    expect(resultTab.pluginSelections?.collectionIds).toEqual([
      'keep-collection',
    ]);
    expect(resultTab.pluginSelections?.skillRefs).toContainEqual({
      sourceId: 'src',
      skillName: 'existing-skill',
    });
    expect(resultTab.pluginSelections?.skillRefs).toContainEqual({
      sourceId: 'src',
      skillName: 'new-skill',
    });
    expect(resultTab.pluginSelections?.pluginRefs).toContainEqual({
      marketplaceId: 'mkt',
      pluginName: 'new-plugin',
    });
    expect(resultTab.pluginSelections?.mcpServerRefs).toContainEqual({
      serverId: 'srv',
      configId: 'cfg',
    });

    // No second user bubble, no second timer: message list unchanged, one timer.
    expect(resultTab.messages).toHaveLength(messageCountBefore);
    const timerCount = resultTab.messages.filter((m) =>
      m.blocks.some((b) => b.type === 'turn_timer'),
    ).length;
    expect(timerCount).toBe(1);
    expect(openTurnTimer(resultTab)).toBe(true);

    // The marker is held until the terminal completed event clears it.
    expect(resultTab.deferredToolsReload).toBeDefined();
    useChatStore
      .getState()
      .handleDeferredToolsReloadEvent(
        reloadEvent({ lifecycle: { kind: 'state', state: 'completed' } }),
      );
    expect(requireTab(useChatStore).deferredToolsReload).toBeUndefined();
  });

  it('holds the tab streaming through verifyStreamingTabs during the session gap', async () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'enabling' },
        },
      }),
    );

    // No active session for this chat id — without the marker this would flip
    // the tab to idle.
    await useChatStore.getState().verifyStreamingTabs();

    const tab = requireTab(useChatStore);
    expect(tab.status).toBe('streaming');
    expect(openTurnTimer(tab)).toBe(true);
  });

  it('ignores the internal interruption cancellation while a reload is active', () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'interrupting' },
        },
      }),
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      data: { type: 'result', terminal_reason: 'aborted_streaming' },
    });

    const tab = requireTab(useChatStore);
    // Timer still open, still streaming, marker retained, no failure message.
    expect(tab.status).toBe('streaming');
    expect(openTurnTimer(tab)).toBe(true);
    expect(tab.deferredToolsReload).toBeDefined();
    expect(tab.messages).toHaveLength(2);
  });

  it('ignores an interrupted Claude-terminal fallback timer while reload is active', () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'interrupting' },
        },
      }),
    );

    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'interrupted-fallback-timer',
            role: 'system',
            timestamp: 2000,
            blocks: [
              { type: 'turn_timer', startedAt: 1000, completedAt: 2000 },
            ],
          },
        ],
        importedEventCount: 1,
      },
    });

    const tab = requireTab(useChatStore);
    expect(openTurnTimer(tab)).toBe(true);
    expect(tab.messages).toHaveLength(2);
    expect(tab.status).toBe('streaming');
  });

  it('lets the final resumed completion pass through and clears the marker', () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'resuming' },
        },
      }),
    );

    // A normal (non-cancellation) completion is NOT ignored: it ends the turn.
    useChatStore.getState().handleChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      data: { type: 'result', is_error: false, result: 'All done' },
    });

    const tab = requireTab(useChatStore);
    expect(tab.deferredToolsReload).toBeUndefined();
    expect(openTurnTimer(tab)).toBe(false);
    expect(tab.status).toBe('idle');
  });

  it('closes the timer and shows enable-failure copy on an enable_failed outcome', () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'interrupting' },
        },
      }),
    );

    useChatStore.getState().handleDeferredToolsReloadEvent(
      reloadEvent({
        lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
        additions: undefined,
      }),
    );

    const tab = requireTab(useChatStore);
    expect(tab.deferredToolsReload).toBeUndefined();
    expect(tab.status).toBe('idle');
    expect(openTurnTimer(tab)).toBe(false);
    const lastMessage = tab.messages[tab.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.blocks).toEqual([
      { type: 'text', text: DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE },
    ]);
  });

  it('shows resume-failure copy on a resume_failed outcome', () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'resuming' },
        },
      }),
    );

    useChatStore.getState().handleDeferredToolsReloadEvent(
      reloadEvent({
        lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
        additions: undefined,
      }),
    );

    const tab = requireTab(useChatStore);
    const lastMessage = tab.messages[tab.messages.length - 1];
    expect(lastMessage.blocks).toEqual([
      { type: 'text', text: DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE },
    ]);
  });

  it('marks App Advisor reloads in-memory in the read-only main mirror', async () => {
    const { useChatStore } = loadStore('main');
    const sentinelKey = `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`;
    const sentinelScope: DeferredToolsReloadScopeKey = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'chat',
    };
    seedTab(useChatStore, makeTab(), sentinelKey);

    useChatStore
      .getState()
      .handleDeferredToolsReloadEvent(reloadEvent({ scope: sentinelScope }));
    await flushMicrotasks();

    // The mirror records enough lifecycle state to suppress the internal
    // interruption, but never drives or persists the canonical reload.
    expect(
      requireTab(useChatStore, sentinelKey).deferredToolsReload,
    ).toBeDefined();
    expect(beginReloadMock).not.toHaveBeenCalled();
    expect(updatePluginsMock).not.toHaveBeenCalled();
    expect(saveTabsMock).not.toHaveBeenCalled();

    useChatStore.getState().handleChatEvent({
      ...sentinelScope,
      data: { type: 'result', terminal_reason: 'aborted_streaming' },
    });

    const tab = requireTab(useChatStore, sentinelKey);
    expect(tab.status).toBe('streaming');
    expect(openTurnTimer(tab)).toBe(true);
    expect(tab.deferredToolsReload).toBeDefined();
  });

  it('writes App Advisor sentinel tabs from the App Advisor window', async () => {
    const { useChatStore } = loadStore('app-advisor');
    const sentinelKey = `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`;
    const sentinelScope: DeferredToolsReloadScopeKey = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'chat',
    };
    seedTab(useChatStore, makeTab(), sentinelKey);

    useChatStore
      .getState()
      .handleDeferredToolsReloadEvent(reloadEvent({ scope: sentinelScope }));
    await flushMicrotasks();

    expect(
      requireTab(useChatStore, sentinelKey).deferredToolsReload,
    ).toBeDefined();
    expect(beginReloadMock).toHaveBeenCalledTimes(1);
    expect(updatePluginsMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the coordinator on user Stop and never auto-resumes', async () => {
    const { useChatStore } = loadStore();
    seedTab(
      useChatStore,
      makeTab({
        deferredToolsReload: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          userMessageId: 'user-1',
          lifecycle: { kind: 'state', state: 'interrupting' },
        },
      }),
    );

    await useChatStore.getState().cancelSession({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
    });

    // Coordinator told to cancel; normal turn cancel also issued.
    expect(cancelReloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        toolCallId: 'tool-1',
      }),
    );
    expect(cancelChatMock).toHaveBeenCalledTimes(1);
    const tab = requireTab(useChatStore);
    expect(tab.cancelRequestedByUser).toBe(true);
    // Marker cleared so the reload cannot auto-resume.
    expect(tab.deferredToolsReload).toBeUndefined();
    // Finish (resume) must never fire on a user Stop.
    expect(finishReloadMock).not.toHaveBeenCalled();
  });
});
