/**
 * Phase 15b — a tab's `status` is a projection of canonical runtime.
 *
 * In a revisioned-live scope main's `runtime.patched` decides whether a turn is
 * running. No renderer-local writer may hold `streaming` against a terminal
 * runtime; an optimistic send is a correlated, expiring `sendingLease`; and
 * `verifyStreamingTabs` decides from an awaited fresh canonical read.
 */
import type {
  ChatGetStateRequest,
  ChatRuntimeState,
  ChatStateChange,
  ChatStateSnapshot,
  ChatResumeStoppedTurnResult,
  ChatSendMessageResult,
  HostQueuedMessageView,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';
import type * as TurnActivityModule from '../stores/chat/turn-activity';
import type * as TurnConfirmationModule from '../stores/chat/turn-confirmation';
import type * as NotificationsModule from '../stores/chat/notifications';
import type * as RuntimeDivergenceModule from '../stores/chat/runtime-divergence';
import type * as PersistedTabsModule from '../stores/chat/persisted-tabs';
import type * as InstrumentationClient from '@canopy/desktop-instrumentation/client';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
  failClientOperation: jest.fn(),
}));
// Each test re-evaluates the chat store after resetModules; the cold first
// load alone can pass 5 s on a busy host.
jest.setTimeout(15_000);

const PROJECT = 'proj';
const WORKTREE = 'wt';
const KEY = `${PROJECT}/${WORKTREE}`;
const CHAT = 'chat';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT };
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let serverSnapshot: ChatStateSnapshot;
const getStateMock = jest.fn<Promise<ChatStateSnapshot>, [ChatGetStateRequest]>(
  () => Promise.resolve(serverSnapshot),
);
const sendMessageMock = jest.fn<
  Promise<ChatSendMessageResult | undefined>,
  [unknown]
>();
const resumeStoppedTurnMock = jest.fn<
  Promise<ChatResumeStoppedTurnResult>,
  [unknown]
>();
const activeSessionsMock = jest.fn();
const answerMcpQuestionMock = jest.fn();
const noop = jest.fn();

interface LoadedStore {
  chat: typeof ChatStoreModule;
  activity: typeof TurnActivityModule;
  confirmation: typeof TurnConfirmationModule;
  instrumentation: jest.Mocked<typeof InstrumentationClient>;
}

function loadStore(): LoadedStore {
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
          resumeStoppedTurn: resumeStoppedTurnMock,
          cancel: jest.fn().mockResolvedValue({}),
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          flushScope: jest.fn().mockResolvedValue(undefined),
          activeSessions: activeSessionsMock,
          getChatQueueSnapshot: jest.fn().mockResolvedValue([]),
          loadArchives: jest.fn().mockResolvedValue([]),
          answerMcpQuestion: answerMcpQuestionMock,
          dismissMcpQuestion: noop,
          updatePlugins: jest.fn((request: { pluginSelections?: unknown }) =>
            Promise.resolve({ pluginSelections: request.pluginSelections }),
          ),
          beginDeferredToolsReload: jest.fn(() => new Promise(() => {})),
          finishDeferredToolsReload: jest.fn(() => new Promise(() => {})),
          cancelDeferredToolsReload: jest.fn().mockResolvedValue(undefined),
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
  const chat = jest.requireActual<typeof ChatStoreModule>(
    '../stores/chatStore',
  );
  chat.useChatStore.setState({ approvalDefaultsCache: { [PROJECT]: 'ask' } });
  return {
    chat,
    activity: jest.requireActual<typeof TurnActivityModule>(
      '../stores/chat/turn-activity',
    ),
    confirmation: jest.requireActual<typeof TurnConfirmationModule>(
      '../stores/chat/turn-confirmation',
    ),
    instrumentation: jest.requireMock<
      jest.Mocked<typeof InstrumentationClient>
    >('@canopy/desktop-instrumentation/client'),
  };
}

const userMessage = (
  id: string,
  text: string,
  at: number,
): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: at,
  blocks: [{ type: 'text', text }],
});

const openTimer = (id: string, at: number): PersistedChatMessage => ({
  id,
  role: 'system',
  timestamp: at,
  blocks: [{ type: 'turn_timer', startedAt: at, completedAt: null }],
});

const closedTimer = (id: string, at: number): PersistedChatMessage => ({
  id,
  role: 'system',
  timestamp: at,
  blocks: [{ type: 'turn_timer', startedAt: at, completedAt: at + 500 }],
});

function persistedTab(
  messages: PersistedChatMessage[],
  over: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id: CHAT,
    title: 'Chat',
    createdAt: '2026-10-14T00:00:00.000Z',
    providerType: 'claude',
    model: 'claude-sonnet-4-5-20250514',
    messages,
    ...over,
  };
}

function runtime(
  status: ChatRuntimeState['status'],
  over: Partial<ChatRuntimeState> = {},
): ChatRuntimeState {
  return { status, queuedMessageIds: [], lastActivityAt: T0, ...over };
}

function hostRow(id: string, text: string): HostQueuedMessageView {
  return { id, text, origin: 'desktop', enqueuedAtMs: T0 };
}

let revision = 5;

async function hydrate(
  store: LoadedStore,
  tab: PersistedChatTab,
  chatRuntime: ChatRuntimeState | undefined,
  queue: HostQueuedMessageView[] = [],
): Promise<void> {
  revision = 5;
  serverSnapshot = {
    schemaVersion: 1,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    revision,
    tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
    archives: [],
    runtimeByChatId: chatRuntime ? { [tab.id]: chatRuntime } : {},
    queue: [
      { projectId: PROJECT, worktreeId: WORKTREE, chatId: tab.id, queue },
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
}

/** Commit one canonical revision, and keep main's snapshot in step. */
function commit(store: LoadedStore, changes: ChatStateChange[]): void {
  const baseRevision = revision;
  revision += 1;
  for (const change of changes) {
    if (change.type === 'runtime.patched') {
      serverSnapshot = {
        ...serverSnapshot,
        revision,
        runtimeByChatId: {
          ...serverSnapshot.runtimeByChatId,
          [change.chatId]: change.runtime,
        },
      };
    }
  }
  serverSnapshot = { ...serverSnapshot, revision };
  store.chat.useChatStore.getState().handleChatStateChanged({
    schemaVersion: 1,
    eventId: `event-${revision}`,
    occurredAt: new Date(T0 + revision).toISOString(),
    projectId: PROJECT,
    worktreeId: WORKTREE,
    baseRevision,
    revision,
    changes,
  });
}

function patchRuntime(store: LoadedStore, next: ChatRuntimeState): void {
  commit(store, [{ type: 'runtime.patched', chatId: CHAT, runtime: next }]);
}

/** Main moved on without the renderer seeing it (missed revisions). */
function advanceServerOnly(next: ChatRuntimeState, by = 3): void {
  revision += by;
  serverSnapshot = {
    ...serverSnapshot,
    revision,
    runtimeByChatId: { ...serverSnapshot.runtimeByChatId, [CHAT]: next },
  };
}

/** Main settled the turn: its transcript closes the turn timer. */
function settleServerTranscript(): void {
  serverSnapshot = {
    ...serverSnapshot,
    tabsFile: {
      ...serverSnapshot.tabsFile,
      tabs: [
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
      ],
    },
  };
}

function compat(store: LoadedStore, data: Record<string, unknown>): void {
  store.chat.useChatStore.getState().handleChatEvent({ ...TARGET, data });
}

function tabOf(store: LoadedStore, chatId = CHAT): ChatStoreModule.ChatTab {
  const tab = store.chat.useChatStore
    .getState()
    .worktreeChats[KEY]?.tabs.find((entry) => entry.id === chatId);
  if (!tab) throw new Error(`tab ${chatId} missing`);
  return tab;
}

function setTab(
  store: LoadedStore,
  update: (tab: ChatStoreModule.ChatTab) => ChatStoreModule.ChatTab,
): void {
  store.chat.useChatStore.setState((state) => {
    const wc = state.worktreeChats[KEY];
    if (!wc) return state;
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...wc,
          tabs: wc.tabs.map((tab) => (tab.id === CHAT ? update(tab) : tab)),
        },
      },
    };
  });
}

function hasOpenTimer(tab: ChatStoreModule.ChatTab): boolean {
  return tab.messages.some((message) =>
    message.blocks.some(
      (block) => block.type === 'turn_timer' && block.completedAt === null,
    ),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('renderer status is a projection of canonical runtime', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    jest.clearAllMocks();
    getStateMock.mockImplementation(() => Promise.resolve(serverSnapshot));
    activeSessionsMock.mockResolvedValue({ activeChatIds: [], sessions: [] });
    sendMessageMock.mockResolvedValue({ disposition: 'dispatched' });
  });

  afterEach(async () => {
    await jest.runOnlyPendingTimersAsync();
    jest.useRealTimers();
  });

  describe('octopus replay', () => {
    it('ends idle after a host-queued prompt dispatches and completes, across every compatibility boundary', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          openTimer('timer-1', T0),
        ]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
          queuedMessageIds: ['q-1'],
        }),
        [hostRow('q-1', 'follow up')],
      );
      expect(tabOf(store).queuedMessages[0]?.hostQueueEntryId).toBe('q-1');
      expect(tabOf(store).status).toBe('streaming');

      // Turn 1 settles with the follow-up still queued.
      patchRuntime(store, runtime('completed', { queuedMessageIds: ['q-1'] }));
      compat(store, { type: 'result', result: 'Done 1', is_error: false });

      // Main dequeues the follow-up and starts its turn.
      patchRuntime(
        store,
        runtime('starting', {
          activeTurn: { userMessageId: 'user-2', startedAt: T0 + 10 },
        }),
      );
      compat(store, {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'user-2',
      });
      // A late queue mirror from before the dequeue.
      store.chat.useChatStore.getState().handleChatQueueUpdated({
        ...TARGET,
        queue: [hostRow('q-1', 'follow up')],
      });
      patchRuntime(
        store,
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-2', startedAt: T0 + 10 },
        }),
      );
      // Turn 2 completes.
      patchRuntime(store, runtime('completed'));
      expect(tabOf(store).status).toBe('idle');

      compat(store, { type: 'result', result: 'Done 2', is_error: false });
      expect(tabOf(store).status).toBe('idle');

      store.chat.useChatStore.getState().handleChatQueueUpdated({
        ...TARGET,
        queue: [],
      });
      expect(tabOf(store).status).toBe('idle');

      compat(store, {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'user-2',
      });
      expect(tabOf(store).status).toBe('idle');

      compat(store, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'late words' }] },
      });
      expect(tabOf(store).status).toBe('idle');

      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(tabOf(store).status).toBe('idle');
    });
  });

  describe('writers with canonical runtime terminal', () => {
    it('keep-streaming: a terminal with a host-queued head does not hold streaming', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0)]),
        runtime('completed', { queuedMessageIds: ['q-1'] }),
        [hostRow('q-1', 'follow up')],
      );
      compat(store, { type: 'result', result: 'Done', is_error: false });
      expect(tabOf(store).status).toBe('idle');
      await jest.advanceTimersByTimeAsync(4_000);
      expect(tabOf(store).status).toBe('idle');
    });

    it('keep-streaming: still drops a superseded plan card', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0)]),
        runtime('completed', { queuedMessageIds: ['q-1'] }),
        [hostRow('q-1', 'feedback')],
      );
      setTab(store, (tab) => ({
        ...tab,
        pendingPlanExit: { requestId: 'plan-1', plan: 'Plan' },
      }));
      compat(store, { type: 'result', result: 'Done', is_error: false });
      expect(tabOf(store).pendingPlanExit).toBeUndefined();
      expect(tabOf(store).status).toBe('idle');
    });

    it('deferred-tools reload: the reload event does not write streaming over a terminal runtime', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      store.chat.useChatStore.getState().handleDeferredToolsReloadEvent({
        scope: TARGET,
        requestId: 'req-1',
        toolCallId: 'tool-1',
        additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
        lifecycle: { kind: 'state', state: 'result_pending' },
      });
      expect(tabOf(store).deferredToolsReload?.requestId).toBe('req-1');
      expect(tabOf(store).status).toBe('idle');
    });

    it('deferred-tools reload: canonical runtime keeps the tab streaming through the session gap', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
        }),
      );
      store.chat.useChatStore.getState().handleDeferredToolsReloadEvent({
        scope: TARGET,
        requestId: 'req-1',
        toolCallId: 'tool-1',
        additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
        lifecycle: { kind: 'state', state: 'result_pending' },
      });
      // No live session during the gap; canonical runtime still says active.
      await store.chat.useChatStore.getState().verifyStreamingTabs();
      expect(tabOf(store).status).toBe('streaming');
      expect(hasOpenTimer(tabOf(store))).toBe(true);
    });

    it('send: issues a sending lease instead of writing streaming', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      sendMessageMock.mockImplementation(() => new Promise(() => {}));
      void store.chat.useChatStore
        .getState()
        .sendMessage('next', undefined, TARGET, undefined, {
          userMessageId: 'user-2',
        });
      await flush();
      const tab = tabOf(store);
      expect(tab.status).toBe('idle');
      expect(tab.sendingLease).toMatchObject({
        userMessageId: 'user-2',
        kind: 'send',
        state: 'pending',
      });
      expect(
        store.activity.composerTurnActivity(
          tab,
          store.chat.useChatStore.getState().runtimeByChatId[CHAT],
          Date.now(),
        ),
      ).toBe('sending');
    });

    it('send: a second send while the lease is pending joins the host queue', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      sendMessageMock.mockImplementation(() => new Promise(() => {}));
      void store.chat.useChatStore
        .getState()
        .sendMessage('next', undefined, TARGET, undefined, {
          userMessageId: 'user-2',
        });
      await flush();
      void store.chat.useChatStore
        .getState()
        .sendMessage('another', undefined, TARGET, undefined, {
          userMessageId: 'user-3',
        });
      await flush();
      expect(tabOf(store).pendingQueueMessages?.[0]?.userMessageId).toBe(
        'user-3',
      );
    });

    it('stale-session reinstatement: canonical status is left to canonical runtime', () => {
      // In a live revisioned scope agent responses never reach this reducer;
      // while the scope hydrates the compatibility reducer and then the
      // snapshot own status. The helper itself must not write it there.
      loadStore();
      const notifications = jest.requireActual<typeof NotificationsModule>(
        '../stores/chat/notifications',
      );
      const staleTab: ChatStoreModule.ChatTab = {
        id: CHAT,
        title: 'Chat',
        createdAt: '2026-10-14T00:00:00.000Z',
        messages: [],
        status: 'idle',
        error: null,
        queuedMessages: [],
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        fastModeExplicit: false,
        staleSessionDetected: { droppedMessageText: 'hello' },
        readOnly: true,
      };
      const response = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'resumed' }] },
      };
      const canonical = notifications.reinstateStaleSessionOnAgentResponse(
        staleTab,
        response,
        { canonicalStatus: true },
      );
      expect(canonical.staleSessionDetected).toBeUndefined();
      expect(canonical.readOnly).toBeUndefined();
      expect(canonical.status).toBe('idle');
      expect(
        notifications.reinstateStaleSessionOnAgentResponse(staleTab, response)
          .status,
      ).toBe('streaming');
    });

    it('resume: issues a sending lease instead of writing streaming', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('cancelled'),
      );
      setTab(store, (tab) => ({
        ...tab,
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }));
      resumeStoppedTurnMock.mockImplementation(() => new Promise(() => {}));
      void store.chat.useChatStore.getState().resumeStoppedTurn(TARGET);
      await flush();
      const tab = tabOf(store);
      expect(tab.status).toBe('idle');
      expect(tab.stoppedTurnResume?.status).toBe('resuming');
      expect(tab.sendingLease).toMatchObject({
        userMessageId: 'user-1',
        kind: 'resume',
        state: 'pending',
      });
    });

    it('resume: a dispatched reply acknowledges the lease and canonical runtime decides', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('cancelled'),
      );
      setTab(store, (tab) => ({
        ...tab,
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }));
      resumeStoppedTurnMock.mockResolvedValue({ disposition: 'dispatched' });
      await store.chat.useChatStore.getState().resumeStoppedTurn(TARGET);
      expect(tabOf(store).sendingLease).toBeUndefined();
      expect(tabOf(store).status).toBe('idle');
      patchRuntime(
        store,
        runtime('starting', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 + 5 },
        }),
      );
      expect(tabOf(store).status).toBe('streaming');
    });

    it('question answer: an accepted answer does not write streaming over a terminal runtime', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          {
            id: 'timer-1',
            role: 'system',
            timestamp: T0,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: T0,
                completedAt: null,
                pausedAt: T0 + 100,
                resumedAt: null,
                pauseOwnerIds: ['question:req-1'],
              },
            ],
          },
        ]),
        runtime('completed'),
      );
      store.chat.useChatStore.setState({
        pendingQuestions: {
          'req-1': {
            requestId: 'req-1',
            projectId: PROJECT,
            worktreeId: WORKTREE,
            chatId: CHAT,
            questions: [
              {
                question: 'Pick one',
                header: 'Pick',
                options: ['A'],
                optionDescriptions: ['a'],
                multiSelect: false,
              },
            ],
          },
        },
      });
      answerMcpQuestionMock.mockResolvedValue({ accepted: true });
      await store.chat.useChatStore
        .getState()
        .answerMcpQuestionAndWait('req-1', [
          { question: 'Pick one', selectedOptions: ['A'] },
        ]);
      expect(tabOf(store).status).toBe('idle');
    });

    it('hook start: a started hook tab takes its status from canonical runtime and a lease', () => {
      const store = loadStore();
      store.chat.useChatStore.setState({
        chatStateSync: { [KEY]: { phase: 'live', revision: 5 } },
        runtimeByChatId: { 'hook-chat': runtime('completed') },
        worktreeChats: { [KEY]: { activeTabId: '', tabs: [] } },
      });
      store.chat.useChatStore.getState().handleHookTabStarted({
        projectId: PROJECT,
        worktreeId: WORKTREE,
        chatId: 'hook-chat',
        activateTab: true,
        tab: { ...persistedTab([]), id: 'hook-chat', title: 'Hook' },
      });
      const tab = tabOf(store, 'hook-chat');
      expect(tab.status).toBe('idle');
      expect(tab.sendingLease).toMatchObject({
        kind: 'hook',
        state: 'pending',
      });
    });

    it('hook start: an active canonical runtime shows streaming', () => {
      const store = loadStore();
      store.chat.useChatStore.setState({
        chatStateSync: { [KEY]: { phase: 'live', revision: 5 } },
        runtimeByChatId: {
          'hook-chat': runtime('starting', {
            activeTurn: { userMessageId: 'hook-user', startedAt: T0 },
          }),
        },
        worktreeChats: { [KEY]: { activeTabId: '', tabs: [] } },
      });
      store.chat.useChatStore.getState().handleHookTabStarted({
        projectId: PROJECT,
        worktreeId: WORKTREE,
        chatId: 'hook-chat',
        activateTab: true,
        tab: { ...persistedTab([]), id: 'hook-chat', title: 'Hook' },
      });
      expect(tabOf(store, 'hook-chat').status).toBe('streaming');
    });
  });

  describe('divergence detector', () => {
    it('repairs an untagged local streaming write within the grace and records it', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      // Any chat activity installs the detector.
      compat(store, { type: 'stream_event' });
      await flush();
      setTab(store, (tab) => ({ ...tab, status: 'streaming' }));
      await jest.advanceTimersByTimeAsync(2_000);
      expect(tabOf(store).status).toBe('streaming');
      await jest.advanceTimersByTimeAsync(1_500);
      await flush();
      expect(tabOf(store).status).toBe('idle');
      const context: unknown = expect.objectContaining({
        kind: 'renderer_runtime_divergence',
        writer: 'unknown',
        tabStatus: 'streaming',
        runtimeStatus: 'completed',
      });
      expect(store.instrumentation.succeedClientOperation).toHaveBeenCalledWith(
        'canopy.app_diagnostic',
        expect.objectContaining({ context }),
      );
    });

    it('names a tagged writer in the record', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      compat(store, { type: 'stream_event' });
      await flush();
      const divergence = jest.requireActual<typeof RuntimeDivergenceModule>(
        '../stores/chat/runtime-divergence',
      );
      divergence.tagStatusWrite(CHAT, 'keep-streaming');
      setTab(store, (tab) => ({ ...tab, status: 'streaming' }));
      await jest.advanceTimersByTimeAsync(3_500);
      await flush();
      expect(tabOf(store).status).toBe('idle');
      const context: unknown = expect.objectContaining({
        writer: 'keep-streaming',
      });
      expect(store.instrumentation.succeedClientOperation).toHaveBeenCalledWith(
        'canopy.app_diagnostic',
        expect.objectContaining({ context }),
      );
    });
  });

  describe('sending lease', () => {
    async function sendWithLease(store: LoadedStore): Promise<void> {
      await hydrate(
        store,
        persistedTab([
          userMessage('user-1', 'first', T0),
          closedTimer('t', T0),
        ]),
        runtime('completed'),
      );
      sendMessageMock.mockImplementation(() => new Promise(() => {}));
      void store.chat.useChatStore
        .getState()
        .sendMessage('next', undefined, TARGET, undefined, {
          userMessageId: 'user-2',
        });
      await flush();
      expect(tabOf(store).sendingLease?.state).toBe('pending');
    }

    it('is acknowledged when canonical runtime shows the turn before the deadline', async () => {
      const store = loadStore();
      await sendWithLease(store);
      patchRuntime(
        store,
        runtime('starting', {
          activeTurn: { userMessageId: 'user-2', startedAt: T0 + 1 },
        }),
      );
      expect(tabOf(store).sendingLease).toBeUndefined();
      expect(tabOf(store).status).toBe('streaming');
    });

    it('is dropped when the chat fails before acknowledgement', async () => {
      const store = loadStore();
      await sendWithLease(store);
      patchRuntime(
        store,
        runtime('failed', {
          error: {
            code: 'provider_error',
            message: 'boom',
            retryable: true,
            occurredAt: new Date(T0).toISOString(),
          },
        }),
      );
      expect(tabOf(store).sendingLease).toBeUndefined();
      expect(tabOf(store).status).toBe('error');
    });

    it('expires at its deadline when never acknowledged', async () => {
      const store = loadStore();
      await sendWithLease(store);
      await jest.advanceTimersByTimeAsync(15_001);
      const tab = tabOf(store);
      expect(tab.sendingLease?.state).toBe('expired');
      expect(tab.status).toBe('idle');
      expect(
        store.activity.composerTurnActivity(
          tab,
          store.chat.useChatStore.getState().runtimeByChatId[CHAT],
          Date.now(),
        ),
      ).toBe('idle');
    });

    it('a late acknowledgement after expiry still shows the running turn', async () => {
      const store = loadStore();
      await sendWithLease(store);
      await jest.advanceTimersByTimeAsync(15_001);
      patchRuntime(
        store,
        runtime('starting', {
          activeTurn: { userMessageId: 'user-2', startedAt: T0 + 16_000 },
        }),
      );
      const tab = tabOf(store);
      expect(tab.sendingLease).toBeUndefined();
      expect(tab.status).toBe('streaming');
    });

    it('is never persisted', () => {
      const store = loadStore();
      const persisted = jest
        .requireActual<
          typeof PersistedTabsModule
        >('../stores/chat/persisted-tabs')
        .toPersistedTab({
          id: CHAT,
          title: 'Chat',
          createdAt: '2026-10-14T00:00:00.000Z',
          messages: [],
          status: 'idle',
          error: null,
          queuedMessages: [],
          planMode: false,
          proposalMode: 'optional',
          thinkingLevel: 'high',
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          fastModeExplicit: false,
          sendingLease: {
            userMessageId: 'user-2',
            kind: 'send',
            issuedAt: T0,
            deadline: T0 + 15_000,
            state: 'pending',
          },
        });
      expect(store.chat.useChatStore).toBeDefined();
      expect(Object.keys(persisted)).not.toContain('sendingLease');
    });
  });

  describe('verifyStreamingTabs decides from a fresh canonical read', () => {
    it('shares a read that is already in flight', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
        }),
      );
      advanceServerOnly(runtime('completed'));
      settleServerTranscript();
      let release: (snapshot: ChatStateSnapshot) => void = () => undefined;
      getStateMock.mockClear();
      getStateMock.mockImplementationOnce(
        () =>
          new Promise<ChatStateSnapshot>((resolve) => {
            release = resolve;
          }),
      );
      const inFlight = store.confirmation.confirmCanonicalTurn(TARGET);
      const verify = store.chat.useChatStore.getState().verifyStreamingTabs();
      release(serverSnapshot);
      await inFlight;
      await verify;
      // One shared confirmation read, then one refresh because main had moved
      // past the runtime the renderer holds.
      expect(getStateMock).toHaveBeenCalledTimes(2);
      expect(tabOf(store).status).toBe('idle');
      expect(hasOpenTimer(tabOf(store))).toBe(false);
    });

    it('settles a tab when main moved on through revisions the renderer missed', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
        }),
      );
      advanceServerOnly(runtime('completed'));
      settleServerTranscript();
      await store.chat.useChatStore.getState().verifyStreamingTabs();
      expect(tabOf(store).status).toBe('idle');
      expect(hasOpenTimer(tabOf(store))).toBe(false);
      // The composer reads the runtime itself, which catches up through the
      // revision-guarded refresh rather than a local write.
      await flush();
      const state = store.chat.useChatStore.getState();
      expect(state.chatStateSync[KEY]).toEqual({ phase: 'live', revision });
      expect(
        store.activity.composerTurnActivity(
          tabOf(store),
          state.runtimeByChatId[CHAT],
          Date.now(),
        ),
      ).toBe('idle');
      expect(hasOpenTimer(tabOf(store))).toBe(false);
    });

    it('changes nothing when the read fails', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('completed'),
      );
      setTab(store, (tab) => ({ ...tab, status: 'streaming' }));
      getStateMock.mockRejectedValueOnce(new Error('ipc down'));
      await store.chat.useChatStore.getState().verifyStreamingTabs();
      expect(tabOf(store).status).toBe('streaming');
      expect(hasOpenTimer(tabOf(store))).toBe(true);
    });

    it('restores streaming when canonical says active and the tab is idle', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
        }),
      );
      setTab(store, (tab) => ({ ...tab, status: 'idle' }));
      await store.chat.useChatStore.getState().verifyStreamingTabs();
      expect(tabOf(store).status).toBe('streaming');
    });

    it('settles a streaming tab whose canonical turn is terminal even while its session is alive', async () => {
      const store = loadStore();
      await hydrate(
        store,
        persistedTab([userMessage('user-1', 'first', T0), openTimer('t', T0)]),
        runtime('streaming', {
          activeTurn: { userMessageId: 'user-1', startedAt: T0 },
        }),
      );
      activeSessionsMock.mockResolvedValue({
        activeChatIds: [CHAT],
        sessions: [],
      });
      advanceServerOnly(runtime('completed'));
      settleServerTranscript();
      await store.chat.useChatStore.getState().verifyStreamingTabs();
      expect(tabOf(store).status).toBe('idle');
      expect(hasOpenTimer(tabOf(store))).toBe(false);
    });
  });
});
