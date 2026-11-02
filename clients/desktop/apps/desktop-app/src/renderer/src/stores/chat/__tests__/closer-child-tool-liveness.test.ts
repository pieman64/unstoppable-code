/**
 * The renderer's own tool closers (streaming verification, send failure, auth
 * refusal, restore) follow the shared child-tool rule: they close Codex root
 * tool calls, keep background children whose parent task is still live in
 * the live-task mirror, and close children once the mirror proves the chat has
 * no live provider session.
 */
import type {
  ActivityLiveBgTasksResponse,
  ChatGetStateRequest,
  ChatRuntimeState,
  ChatStateSnapshot,
  PersistedChatBlock,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../../chatStore';
import type * as LiveTasksModule from '../../liveBackgroundTaskStore';
import type * as SessionRestoreModule from '../session-restore';
import type { ChatMessage, ChatTab } from '../types';
import { createEmptyTab } from '../tab-utils';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
  failClientOperation: jest.fn(),
}));
jest.setTimeout(15_000);

const PROJECT = 'proj';
const WORKTREE = 'wt';
const KEY = `${PROJECT}/${WORKTREE}`;
const CHAT = 'chat';
// Far enough in the past that no restore or streaming grace window applies.
const OLD = Date.UTC(2026, 0, 1);

let serverSnapshot: ChatStateSnapshot;
const getStateMock = jest.fn<Promise<ChatStateSnapshot>, [ChatGetStateRequest]>(
  () => Promise.resolve(serverSnapshot),
);
const activeSessionsMock = jest.fn();
const sendMessageMock = jest.fn();
const listLiveBgTasksMock = jest.fn<
  Promise<ActivityLiveBgTasksResponse>,
  [unknown]
>(() => Promise.resolve({ chats: {} }));
const noop = jest.fn();

interface LoadedStore {
  chat: typeof ChatStoreModule;
  live: typeof LiveTasksModule;
  restore: typeof SessionRestoreModule;
}

/** `pullBridge`: whether the mirror can pull a worktree snapshot. */
function loadStore(options: { pullBridge: boolean }): LoadedStore {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          getState: getStateMock,
          setStateScopes: jest.fn().mockResolvedValue(undefined),
          command: jest.fn().mockResolvedValue({ outcome: 'accepted' }),
          sendMessage: sendMessageMock,
          cancel: jest.fn().mockResolvedValue({}),
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          flushScope: jest.fn().mockResolvedValue(undefined),
          activeSessions: activeSessionsMock,
          getChatQueueSnapshot: jest.fn().mockResolvedValue([]),
          loadArchives: jest.fn().mockResolvedValue([]),
          answerMcpQuestion: noop,
          dismissMcpQuestion: noop,
          updatePlugins: jest.fn((request: { pluginSelections?: unknown }) =>
            Promise.resolve({ pluginSelections: request.pluginSelections }),
          ),
          preparePlanFileSystemInstruction: noop,
        },
        approvals: {
          getResolvedDefault: jest.fn().mockResolvedValue('ask'),
          pendingRequests: jest.fn().mockResolvedValue([]),
        },
        claudeTerminal: {
          getState: jest.fn().mockResolvedValue(undefined),
          onStateChanged: jest.fn(() => (): void => {}),
          onSyncCompleted: jest.fn(() => (): void => {}),
          onError: jest.fn(() => (): void => {}),
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: jest.fn().mockResolvedValue(undefined),
        scheduleTaskBranchNaming: jest.fn().mockResolvedValue(undefined),
        github: {
          setForegroundWorktree: noop,
          requestFastRefresh: noop,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        activity: {
          ...(options.pullBridge
            ? { listLiveBgTasks: listLiveBgTasksMock }
            : {}),
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
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  const chat = jest.requireActual<typeof ChatStoreModule>('../../chatStore');
  chat.useChatStore.setState({ approvalDefaultsCache: { [PROJECT]: 'ask' } });
  return {
    chat,
    live: jest.requireActual<typeof LiveTasksModule>(
      '../../liveBackgroundTaskStore',
    ),
    restore:
      jest.requireActual<typeof SessionRestoreModule>('../session-restore'),
  };
}

afterEach(() => {
  Reflect.deleteProperty(global, 'window');
  jest.clearAllMocks();
  listLiveBgTasksMock.mockImplementation(() => Promise.resolve({ chats: {} }));
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function toolUse(toolUseId: string, toolName = 'Bash'): PersistedChatBlock {
  return { type: 'tool_use', toolUseId, toolName, input: '{}' };
}

function toolResult(toolUseId: string, toolName = 'Agent'): PersistedChatBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolName,
    output: 'Launched in the background',
    isError: false,
  };
}

function msg(
  id: string,
  blocks: PersistedChatBlock[],
  metadata: Pick<
    ChatMessage,
    'parentToolUseId' | 'parentBlockId' | 'codexThreadId'
  > = {},
  role: ChatMessage['role'] = 'assistant',
): ChatMessage {
  return { id, role, blocks, timestamp: OLD, ...metadata };
}

/**
 * A Claude turn whose background agent (`agent-tool`) outlives the root turn:
 * the root still has an open `root-tool`, the agent's child an open
 * `child-tool`.
 */
function claudeMessages(): ChatMessage[] {
  return [
    msg('user-1', [{ type: 'text', text: 'go' }], {}, 'user'),
    msg(
      'timer-1',
      [{ type: 'turn_timer', startedAt: OLD, completedAt: null }],
      {},
      'system',
    ),
    msg('root', [toolUse('agent-tool', 'Agent'), toolUse('root-tool')]),
    msg('agent-launched', [toolResult('agent-tool')], {}, 'system'),
    msg('child', [toolUse('child-tool')], { parentToolUseId: 'agent-tool' }),
  ];
}

const CODEX_ROOT_THREAD = 'root-thread';
const CODEX_AGENT_BLOCK = 'codex-agent-call-1';

/**
 * A Codex turn with an open root tool call (stamped with the root thread id)
 * and an open child tool call under a still-running receiver.
 */
function codexMessages(): ChatMessage[] {
  return [
    msg('user-1', [{ type: 'text', text: 'go' }], {}, 'user'),
    msg(
      'timer-1',
      [{ type: 'turn_timer', startedAt: OLD, completedAt: null }],
      {},
      'system',
    ),
    msg('codex-root', [toolUse('codex-root-tool')], {
      codexThreadId: CODEX_ROOT_THREAD,
    }),
    msg(
      'codex-agent',
      [
        {
          type: 'codex_agent_call',
          agentBlockId: CODEX_AGENT_BLOCK,
          callId: 'call-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: CODEX_ROOT_THREAD,
          receiverThreadIds: ['child-thread'],
          prompt: 'Inspect',
          agentsStates: { 'child-thread': { status: 'running' } },
        },
      ],
      { codexThreadId: CODEX_ROOT_THREAD },
    ),
    msg('codex-child', [toolUse('codex-child-tool')], {
      parentBlockId: CODEX_AGENT_BLOCK,
      codexThreadId: 'child-thread',
    }),
  ];
}

function makeTab(overrides: Partial<ChatTab>): ChatTab {
  return {
    ...createEmptyTab(),
    id: CHAT,
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

function codexTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return makeTab({
    providerType: 'codex',
    model: 'gpt-5.5',
    sdkSessionId: CODEX_ROOT_THREAD,
    messages: codexMessages(),
    ...overrides,
  });
}

function tabOf(store: LoadedStore): ChatTab {
  const tab = store.chat.useChatStore
    .getState()
    .worktreeChats[KEY]?.tabs.find((entry) => entry.id === CHAT);
  if (!tab) throw new Error('tab missing');
  return tab;
}

/** Tool calls the closer settled (the agent launch had its own result). */
function closedToolIds(tab: Pick<ChatTab, 'messages'>): string[] {
  return tab.messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === 'tool_result' && block.toolUseId !== 'agent-tool'
        ? [block.toolUseId]
        : [],
    ),
  );
}

function seedLegacyStreamingTab(store: LoadedStore, tab: ChatTab): void {
  store.chat.useChatStore.setState({
    selectedWorktree: { projectId: PROJECT, worktreeId: WORKTREE },
    worktreeChats: {
      [KEY]: {
        activeTabId: CHAT,
        tabs: [{ ...tab, status: 'streaming', lastEventAt: OLD }],
      },
    },
  });
}

function pushLiveTasks(
  store: LoadedStore,
  liveTasks: LiveTasksModule.LiveBackgroundTaskChatEntry['liveTasks'],
): void {
  store.live.useLiveBackgroundTaskStore.getState().applyPush({
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId: CHAT,
    sessionActive: true,
    liveTasks: [...liveTasks],
  });
}

describe('session-dropped closer (legacy streaming verification)', () => {
  beforeEach(() => {
    activeSessionsMock.mockResolvedValue({ activeChatIds: [], sessions: [] });
  });

  it('closes a Codex root tool call and keeps a child under a running receiver open', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, []);
    seedLegacyStreamingTab(store, codexTab());

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(tabOf(store).status).toBe('idle');
    expect(closedToolIds(tabOf(store))).toEqual(['codex-root-tool']);
  });

  it('keeps a Claude child open while its parent task is live and closes the root tool', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, [{ taskId: 'task-1', toolUseId: 'agent-tool' }]);
    seedLegacyStreamingTab(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store))).toEqual(['root-tool']);
  });

  it('closes the Claude child once the hydrated mirror has no session for the chat', async () => {
    const store = loadStore({ pullBridge: false });
    seedLegacyStreamingTab(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store)).sort()).toEqual([
      'child-tool',
      'root-tool',
    ]);
  });

  it('keeps the Claude child open while the mirror is not hydrated', async () => {
    const store = loadStore({ pullBridge: true });
    seedLegacyStreamingTab(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store))).toEqual(['root-tool']);
  });
});

function runtime(status: ChatRuntimeState['status']): ChatRuntimeState {
  return { status, queuedMessageIds: [], lastActivityAt: OLD };
}

async function hydrateCanonical(
  store: LoadedStore,
  tab: ChatTab,
): Promise<void> {
  const persisted: PersistedChatTab = {
    id: tab.id,
    title: tab.title,
    createdAt: tab.createdAt,
    providerType: tab.providerType,
    model: tab.model,
    messages: tab.messages,
    ...(tab.sdkSessionId ? { sdkSessionId: tab.sdkSessionId } : {}),
  };
  serverSnapshot = {
    schemaVersion: 1,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    revision: 5,
    tabsFile: { version: 1, tabs: [persisted], activeTabId: tab.id },
    archives: [],
    runtimeByChatId: { [tab.id]: runtime('completed') },
    queue: [
      { projectId: PROJECT, worktreeId: WORKTREE, chatId: tab.id, queue: [] },
    ],
  };
  store.chat.useChatStore.setState({
    selectedWorktree: { projectId: PROJECT, worktreeId: WORKTREE },
  });
  await store.chat.useChatStore.getState().loadTabsForTarget(PROJECT, WORKTREE);
  expect(store.chat.useChatStore.getState().chatStateSync[KEY]).toEqual({
    phase: 'live',
    revision: 5,
  });
  // Restore stays out of the way: the verifier is what this suite exercises.
  store.chat.useChatStore.setState((state) => ({
    worktreeChats: {
      ...state.worktreeChats,
      [KEY]: {
        activeTabId: CHAT,
        tabs: [{ ...tab, status: 'streaming' }],
      },
    },
  }));
}

describe('verify-streaming closer (canonical turn is terminal)', () => {
  it('closes a Codex root tool call and keeps a child under a running receiver open', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, []);
    await hydrateCanonical(store, codexTab());

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(tabOf(store).status).toBe('idle');
    expect(closedToolIds(tabOf(store))).toEqual(['codex-root-tool']);
  });

  it('keeps a Claude child open while its parent task is live and closes the root tool', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, [{ taskId: 'task-1', toolUseId: 'agent-tool' }]);
    await hydrateCanonical(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store))).toEqual(['root-tool']);
  });

  it('closes the Claude child once the hydrated mirror has no session for the chat', async () => {
    const store = loadStore({ pullBridge: false });
    await hydrateCanonical(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store)).sort()).toEqual([
      'child-tool',
      'root-tool',
    ]);
  });

  it('keeps the Claude child open while the mirror is not hydrated', async () => {
    const store = loadStore({ pullBridge: true });
    // The snapshot pull is still in flight.
    listLiveBgTasksMock.mockImplementation(() => new Promise(() => {}));
    await hydrateCanonical(store, makeTab({ messages: claudeMessages() }));

    await store.chat.useChatStore.getState().verifyStreamingTabs();

    expect(closedToolIds(tabOf(store))).toEqual(['root-tool']);
  });
});

/** An idle tab whose earlier turn left a background agent running. */
function earlierTurnWithLiveChild(): ChatMessage[] {
  return [
    msg('user-1', [{ type: 'text', text: 'go' }], {}, 'user'),
    msg(
      'timer-1',
      [{ type: 'turn_timer', startedAt: OLD, completedAt: OLD + 1 }],
      {},
      'system',
    ),
    msg('root', [toolUse('agent-tool', 'Agent')]),
    msg('agent-launched', [toolResult('agent-tool')], {}, 'system'),
    msg('child', [toolUse('child-tool')], { parentToolUseId: 'agent-tool' }),
  ];
}

function seedIdleTab(store: LoadedStore, tab: ChatTab): void {
  store.chat.useChatStore.setState({
    selectedWorktree: { projectId: PROJECT, worktreeId: WORKTREE },
    worktreeChats: { [KEY]: { activeTabId: CHAT, tabs: [tab] } },
  });
}

describe('send failure and auth refusal closers', () => {
  it('keeps a live background child from an earlier turn open when the send fails', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, [{ taskId: 'task-1', toolUseId: 'agent-tool' }]);
    seedIdleTab(store, makeTab({ messages: earlierTurnWithLiveChild() }));
    sendMessageMock.mockRejectedValueOnce(new Error('ipc down'));

    await store.chat.useChatStore.getState().sendMessage('next');

    expect(tabOf(store).status).toBe('error');
    expect(closedToolIds(tabOf(store))).toEqual([]);
  });

  it('closes the earlier child on send failure once the mirror proves no session', async () => {
    const store = loadStore({ pullBridge: false });
    seedIdleTab(store, makeTab({ messages: earlierTurnWithLiveChild() }));
    sendMessageMock.mockRejectedValueOnce(new Error('ipc down'));

    await store.chat.useChatStore.getState().sendMessage('next');

    expect(closedToolIds(tabOf(store))).toEqual(['child-tool']);
  });

  it('closes a Codex root tool call on send failure', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, []);
    seedIdleTab(store, codexTab());
    sendMessageMock.mockRejectedValueOnce(new Error('ipc down'));

    await store.chat.useChatStore.getState().sendMessage('next');

    expect(closedToolIds(tabOf(store))).toEqual(['codex-root-tool']);
  });

  it('keeps a live background child from an earlier turn open when auth refuses the send', async () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, [{ taskId: 'task-1', toolUseId: 'agent-tool' }]);
    seedIdleTab(store, makeTab({ messages: earlierTurnWithLiveChild() }));
    sendMessageMock.mockResolvedValueOnce({
      refusedAuthDependencies: {
        message: 'Reconnect the server.',
        failures: [
          {
            dependencyClass: 'mcp',
            dependencyId: 'srv:cfg',
            displayName: 'Server',
            failureClass: 'expired',
            recovery: { kind: 'none' },
          },
        ],
      },
    });

    await store.chat.useChatStore.getState().sendMessage('next');

    expect(tabOf(store).status).toBe('error');
    expect(closedToolIds(tabOf(store))).toEqual([]);
  });
});

describe('restore closer', () => {
  const scope = {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    pendingQuestions: {},
    pendingApprovals: {},
  };

  it('closes a Codex root tool call and keeps a child under a running receiver open', () => {
    const store = loadStore({ pullBridge: false });
    pushLiveTasks(store, []);
    const { tabs } = store.restore.restoreStreamingTabs(
      [codexTab()],
      { activeChatIds: [] },
      OLD,
      scope,
    );
    expect(closedToolIds(tabs[0])).toEqual(['codex-root-tool']);
  });

  it('closes restored children when the hydrated mirror has no session for the chat', () => {
    const store = loadStore({ pullBridge: false });
    const { tabs } = store.restore.restoreStreamingTabs(
      [makeTab({ messages: claudeMessages() })],
      { activeChatIds: [] },
      OLD,
      scope,
    );
    expect(closedToolIds(tabs[0]).sort()).toEqual(['child-tool', 'root-tool']);
  });

  it('closes a restored child after hydration shows no live session (full restart)', async () => {
    const store = loadStore({ pullBridge: true });
    listLiveBgTasksMock.mockResolvedValueOnce({ chats: {} });
    const { tabs } = store.restore.restoreStreamingTabs(
      [makeTab({ messages: claudeMessages() })],
      { activeChatIds: [] },
      OLD,
      scope,
    );
    expect(closedToolIds(tabs[0])).toEqual(['root-tool']);
    store.chat.useChatStore.setState({
      worktreeChats: { [KEY]: { activeTabId: CHAT, tabs } },
    });

    await flush();

    expect(listLiveBgTasksMock).toHaveBeenCalledTimes(1);
    expect(closedToolIds(tabOf(store)).sort()).toEqual([
      'child-tool',
      'root-tool',
    ]);
  });

  it('keeps a restored child open after hydration shows its parent is live (renderer reload)', async () => {
    const store = loadStore({ pullBridge: true });
    listLiveBgTasksMock.mockResolvedValueOnce({
      chats: {
        [CHAT]: {
          sessionActive: true,
          liveTasks: [{ taskId: 'task-1', toolUseId: 'agent-tool' }],
        },
      },
    });
    const { tabs } = store.restore.restoreStreamingTabs(
      [makeTab({ messages: claudeMessages() })],
      { activeChatIds: [] },
      OLD,
      scope,
    );
    store.chat.useChatStore.setState({
      worktreeChats: { [KEY]: { activeTabId: CHAT, tabs } },
    });

    await flush();

    expect(listLiveBgTasksMock).toHaveBeenCalledTimes(1);
    expect(closedToolIds(tabOf(store))).toEqual(['root-tool']);
  });
});
