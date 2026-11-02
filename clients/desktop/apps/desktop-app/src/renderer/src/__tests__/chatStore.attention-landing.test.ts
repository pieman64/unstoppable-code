// Attention landing (CAN-4957): an implicit worktree entry (a sidebar row)
// opens on the tab that needs the user, not the tab last read. Landing only
// activates; it never dismisses attention, and explicit navigation keeps its
// own target.
import type {
  ChatCommandRequest,
  ChatCommandResponse,
  ChatTabsFile,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';
import type * as HydrationModule from '../stores/chat/hydration';
import type * as LandingIntentModule from '../stores/chat/attention-landing-intent';
import type * as NavigationStoreModule from '../stores/navigationStore';

const KEY = 'project/worktree';
const QUESTIONS = [{ id: 'q1', question: 'Continue?', options: ['yes'] }];

const chatCommandMock = jest.fn<
  Promise<ChatCommandResponse>,
  [ChatCommandRequest]
>((request) =>
  Promise.resolve({
    commandId: request.commandId,
    revision: 2,
    outcome: 'applied' as const,
  }),
);
const loadTabsMock = jest.fn<Promise<ChatTabsFile>, [unknown]>();
const noop = jest.fn();
const getStateMock = jest.fn<Promise<ChatStateSnapshot>, [unknown]>();
const pendingRequestsMock = jest.fn().mockResolvedValue([]);

interface LoadedModules {
  readonly useChatStore: typeof ChatStoreModule.useChatStore;
  readonly hydratedKeys: typeof HydrationModule.hydratedKeys;
  readonly useNavigationStore: typeof NavigationStoreModule.useNavigationStore;
}

function loadStore(revisioned = false): LoadedModules {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          sendMessage: jest.fn().mockResolvedValue(undefined),
          cancel: jest.fn().mockResolvedValue(undefined),
          loadTabs: loadTabsMock,
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          command: chatCommandMock,
          ...(revisioned ? { getState: getStateMock } : {}),
          preparePlanFileSystemInstruction: noop,
        },
        approvals: { pendingRequests: pendingRequestsMock },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: jest.fn().mockResolvedValue(undefined),
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
        getPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  const { useChatStore } = jest.requireActual<typeof ChatStoreModule>(
    '../stores/chatStore',
  );
  const { hydratedKeys } = jest.requireActual<typeof HydrationModule>(
    '../stores/chat/hydration',
  );
  const { useNavigationStore } = jest.requireActual<
    typeof NavigationStoreModule
  >('../stores/navigationStore');
  return { useChatStore, hydratedKeys, useNavigationStore };
}

function makeTab(
  over: Partial<ChatStoreModule.ChatTab> & { id: string },
): ChatStoreModule.ChatTab {
  return {
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...over,
  };
}

function question(chatId: string): ChatStoreModule.PendingQuestion {
  return {
    requestId: `req-${chatId}`,
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
    questions: QUESTIONS,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

function activeTabId(
  useChatStore: typeof ChatStoreModule.useChatStore,
): string | undefined {
  return useChatStore.getState().worktreeChats[KEY]?.activeTabId;
}

function sentCommands(): unknown[] {
  return chatCommandMock.mock.calls.map(([request]) => request.command);
}

/** Persisted file: `chat-a` active and read, `chat-b` waiting on a question. */
function persistedQuestionFile(): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'chat-a',
    tabs: [
      {
        id: 'chat-a',
        title: 'Chat A',
        messages: [],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'chat-b',
        title: 'Chat B',
        messages: [],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    pendingQuestions: [
      { requestId: 'req-1', chatId: 'chat-b', questions: QUESTIONS },
    ],
  };
}

/** A loaded, hydrated worktree the user is not on yet. */
function seedHydrated(
  modules: LoadedModules,
  tabs: ChatStoreModule.ChatTab[],
  pendingQuestions: Record<string, ChatStoreModule.PendingQuestion> = {},
): void {
  modules.useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    worktreeChats: { [KEY]: { activeTabId: 'chat-a', tabs } },
    pendingQuestions,
  });
  modules.hydratedKeys.add(KEY);
}

describe('chatStore attention landing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    chatCommandMock.mockClear();
    loadTabsMock.mockReset();
    getStateMock.mockReset();
    pendingRequestsMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('a worktree that loads on entry (legacy hydration)', () => {
    it.each(['question', 'unread'] as const)(
      'acknowledges an already-active winning %s tab only when visible',
      async (attention) => {
        const { useChatStore, useNavigationStore } = loadStore();
        useNavigationStore.setState({ activePage: 'main' });
        useChatStore.setState({
          selectedWorktree: { projectId: 'project', worktreeId: 'other' },
          unreadWorktreeKeys: new Set([KEY]),
        });
        const file = persistedQuestionFile();
        file.activeTabId = 'chat-b';
        file.tabs = file.tabs.map((tab) => ({
          ...tab,
          unread: tab.id === 'chat-b',
        }));
        if (attention === 'unread') file.pendingQuestions = [];
        loadTabsMock.mockResolvedValue(file);

        useChatStore
          .getState()
          .selectWorktree('project', 'worktree', { attentionLanding: true });
        await flushMicrotasks();

        expect(activeTabId(useChatStore)).toBe('chat-b');
        expect(
          useChatStore
            .getState()
            .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-b')
            ?.unread,
        ).not.toBe(true);
        expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(false);
        if (attention === 'question') {
          expect(
            useChatStore.getState().pendingQuestions['req-1']?.answeredAt,
          ).toBeUndefined();
        }
      },
    );

    it.each(['question', 'unread'] as const)(
      'keeps an already-active winning %s tab unread on a hidden page',
      async (attention) => {
        const { useChatStore, useNavigationStore } = loadStore();
        useNavigationStore.setState({ activePage: 'home' });
        useChatStore.setState({
          selectedWorktree: { projectId: 'project', worktreeId: 'other' },
          unreadWorktreeKeys: new Set([KEY]),
        });
        const file = persistedQuestionFile();
        file.activeTabId = 'chat-b';
        file.tabs = file.tabs.map((tab) => ({
          ...tab,
          unread: tab.id === 'chat-b',
        }));
        if (attention === 'unread') file.pendingQuestions = [];
        loadTabsMock.mockResolvedValue(file);

        useChatStore
          .getState()
          .selectWorktree('project', 'worktree', { attentionLanding: true });
        await flushMicrotasks();

        expect(activeTabId(useChatStore)).toBe('chat-b');
        expect(
          useChatStore
            .getState()
            .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-b')
            ?.unread,
        ).toBe(true);
        expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
      },
    );

    it.each([
      ['a quiet worktree', 'chat-a', false, 'chat-a', false],
      ['an already-waiting active chat', 'chat-b', true, 'chat-b', true],
      ['a landing that switches tabs', 'chat-a', true, 'chat-b', true],
    ] as const)(
      'reveals the chat group on hydration only for an attention target: %s',
      async (_case, persistedActive, asking, landed, reveals) => {
        const { useChatStore } = loadStore();
        useChatStore.setState({
          selectedWorktree: { projectId: 'project', worktreeId: 'other' },
        });
        const file = persistedQuestionFile();
        file.activeTabId = persistedActive;
        if (!asking) file.pendingQuestions = [];
        loadTabsMock.mockResolvedValue(file);

        useChatStore
          .getState()
          .selectWorktree('project', 'worktree', { attentionLanding: true });
        await flushMicrotasks();

        expect(activeTabId(useChatStore)).toBe(landed);
        const { takeAttentionLandingPanelTarget } = jest.requireActual<
          typeof LandingIntentModule
        >('../stores/chat/attention-landing-intent');
        expect(takeAttentionLandingPanelTarget(KEY, landed)).toBe(reveals);
      },
    );

    it('lands on the question tab instead of the persisted one', async () => {
      const { useChatStore, useNavigationStore } = loadStore();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      });
      loadTabsMock.mockResolvedValue(persistedQuestionFile());

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });
      await flushMicrotasks();

      expect(activeTabId(useChatStore)).toBe('chat-b');
      // On the chat page the landed tab is the visible one, so hydration
      // does not mark it unread; the question stays pending until answered.
      const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
      expect(tabs.find((tab) => tab.id === 'chat-b')?.unread).not.toBe(true);
      expect(
        useChatStore.getState().pendingQuestions['req-1']?.answeredAt,
      ).toBeUndefined();
    });

    it('leaves read state to visibility when the chat page is not shown', async () => {
      const { useChatStore } = loadStore();
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      });
      loadTabsMock.mockResolvedValue(persistedQuestionFile());

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });
      await flushMicrotasks();

      expect(activeTabId(useChatStore)).toBe('chat-b');
      // Loading a scope that is not on screen acknowledges nothing.
      const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
      expect(tabs.find((tab) => tab.id === 'chat-b')?.unread).toBe(true);
    });

    it('keeps the persisted tab for an entry that is not implicit', async () => {
      const { useChatStore } = loadStore();
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      });
      loadTabsMock.mockResolvedValue(persistedQuestionFile());

      useChatStore.getState().selectWorktree('project', 'worktree');
      await flushMicrotasks();

      expect(activeTabId(useChatStore)).toBe('chat-a');
    });

    it('drops the landing once the user leaves before the load finishes', async () => {
      const { useChatStore } = loadStore();
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      });
      let resolveLoad: (file: ChatTabsFile) => void = () => {};
      loadTabsMock.mockReturnValue(
        new Promise<ChatTabsFile>((resolve) => {
          resolveLoad = resolve;
        }),
      );

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });
      useChatStore
        .getState()
        .selectWorktree('project', 'other', { deferTabLoad: true });
      resolveLoad(persistedQuestionFile());
      await flushMicrotasks();

      expect(activeTabId(useChatStore)).toBe('chat-a');
    });
  });

  describe('a worktree that is already loaded', () => {
    it('lands synchronously and submits only the activation', async () => {
      const modules = loadStore();
      const { useChatStore } = modules;
      seedHydrated(
        modules,
        [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
        { 'req-chat-b': question('chat-b') },
      );
      useChatStore.setState({
        chatStateSync: { [KEY]: { phase: 'live', revision: 1 } },
      });

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });

      expect(activeTabId(useChatStore)).toBe('chat-b');
      await flushMicrotasks();
      const commands = sentCommands();
      expect(commands).toContainEqual({
        type: 'chat.activate_tab',
        tabId: 'chat-b',
      });
      // Off the chat page nothing is visible, so nothing is acknowledged,
      // and landing itself never dismisses attention.
      expect(commands).not.toContainEqual(
        expect.objectContaining({ type: 'chat.dismiss_attention' }),
      );
      expect(commands).not.toContainEqual(
        expect.objectContaining({ type: 'chat.mark_read' }),
      );
    });

    it('acknowledges the landed tab, never the stale one, when the chat is visible', () => {
      const modules = loadStore();
      const { useChatStore, useNavigationStore } = modules;
      useNavigationStore.setState({ activePage: 'main' });
      seedHydrated(modules, [
        makeTab({ id: 'chat-a', unread: true, messages: [] }),
        makeTab({
          id: 'chat-b',
          unread: true,
          messages: [
            {
              id: 'm-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Done' }],
              timestamp: Date.parse('2026-09-02T00:00:00.000Z'),
            },
          ],
        }),
      ]);

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });

      // `chat-a` is the active unread tab, so the unread tier keeps it.
      expect(activeTabId(useChatStore)).toBe('chat-a');

      useChatStore
        .getState()
        .selectWorktree('project', 'other', { deferTabLoad: true });
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            activeTabId: 'chat-c',
            tabs: [
              ...(state.worktreeChats[KEY]?.tabs ?? []),
              makeTab({ id: 'chat-c' }),
            ],
          },
        },
      }));
      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });

      // The read `chat-c` was persisted; the newest unread tab wins and is
      // the one acknowledged.
      expect(activeTabId(useChatStore)).toBe('chat-b');
      const tabs = useChatStore.getState().worktreeChats[KEY]?.tabs ?? [];
      expect(tabs.find((tab) => tab.id === 'chat-b')?.unread).toBe(false);
      expect(tabs.find((tab) => tab.id === 'chat-a')?.unread).toBe(false);
    });

    it('reveals the chat group only for an entry with an attention target', () => {
      const enter = (
        pending: Record<string, ChatStoreModule.PendingQuestion>,
      ): { active: string | undefined; reveals: boolean } => {
        const modules = loadStore();
        seedHydrated(
          modules,
          [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
          pending,
        );
        modules.useChatStore
          .getState()
          .selectWorktree('project', 'worktree', { attentionLanding: true });
        const active = activeTabId(modules.useChatStore);
        const { takeAttentionLandingPanelTarget } = jest.requireActual<
          typeof LandingIntentModule
        >('../stores/chat/attention-landing-intent');
        return {
          active,
          reveals:
            active !== undefined &&
            takeAttentionLandingPanelTarget(KEY, active),
        };
      };

      // A quiet worktree keeps its saved panel selection.
      expect(enter({})).toEqual({ active: 'chat-a', reveals: false });
      // An active chat that already needs the user is still revealed.
      expect(enter({ 'req-chat-a': question('chat-a') })).toEqual({
        active: 'chat-a',
        reveals: true,
      });
      // A landing that switches tabs reveals the landed chat.
      expect(enter({ 'req-chat-b': question('chat-b') })).toEqual({
        active: 'chat-b',
        reveals: true,
      });
    });

    it('does not land when the worktree is already selected', () => {
      const modules = loadStore();
      const { useChatStore } = modules;
      seedHydrated(
        modules,
        [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
        { 'req-chat-b': question('chat-b') },
      );
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      });

      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });

      expect(activeTabId(useChatStore)).toBe('chat-a');
    });

    it('does not land for newly created work', () => {
      const modules = loadStore();
      const { useChatStore } = modules;
      seedHydrated(
        modules,
        [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
        { 'req-chat-b': question('chat-b') },
      );

      useChatStore.getState().selectWorktree('project', 'worktree', {
        attentionLanding: true,
        newlyCreated: true,
        deferTabLoad: true,
      });

      expect(activeTabId(useChatStore)).toBe('chat-a');
    });
  });

  it('lets an explicit tab choice win over a landing still waiting on the load', async () => {
    const { useChatStore } = loadStore();
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    });
    let resolveLoad: (file: ChatTabsFile) => void = () => {};
    loadTabsMock.mockReturnValue(
      new Promise<ChatTabsFile>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    useChatStore
      .getState()
      .selectWorktree('project', 'worktree', { attentionLanding: true });
    // Explicit chat navigation selects its tab while the scope loads.
    useChatStore.getState().switchTab('chat-a');
    const file = persistedQuestionFile();
    file.activeTabId = 'chat-b';
    resolveLoad(file);
    await flushMicrotasks();

    expect(activeTabId(useChatStore)).toBe('chat-a');
  });
});

describe('revisioned attention landing regressions', () => {
  beforeEach(() => {
    chatCommandMock.mockReset().mockImplementation((request) =>
      Promise.resolve({
        commandId: request.commandId,
        revision: 2,
        outcome: 'applied',
      }),
    );
    getStateMock.mockReset();
    pendingRequestsMock.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function snapshot(): ChatStateSnapshot {
    const file = persistedQuestionFile();
    return {
      schemaVersion: 1,
      projectId: 'project',
      worktreeId: 'worktree',
      revision: 1,
      tabsFile: {
        ...file,
        tabs: file.tabs.map((tab) => ({ ...tab, unread: true })),
      },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };
  }

  it.each([false, true])(
    'lands before acknowledging a revisioned scope (prefetched=%s)',
    async (prefetched) => {
      const { useChatStore, useNavigationStore } = loadStore(true);
      getStateMock.mockResolvedValue(snapshot());
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      });
      if (prefetched)
        await useChatStore
          .getState()
          .hydrateChatScopeRevisioned('project', 'worktree');
      useChatStore
        .getState()
        .selectWorktree('project', 'worktree', { attentionLanding: true });
      await useChatStore.getState().loadTabs();
      await flushMicrotasks();
      expect(activeTabId(useChatStore)).toBe('chat-b');
      expect(
        useChatStore
          .getState()
          .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-a')?.unread,
      ).toBe(true);
      expect(sentCommands()).toContainEqual({
        type: 'chat.mark_read',
        chatId: 'chat-b',
      });
      expect(sentCommands()).not.toContainEqual(
        expect.objectContaining({ type: 'chat.dismiss_attention' }),
      );
      expect(sentCommands()).not.toContainEqual({
        type: 'chat.mark_read',
        chatId: 'chat-a',
      });
      expect(
        useChatStore.getState().pendingQuestions['req-1']?.answeredAt,
      ).toBeUndefined();
    },
  );

  it('preserves an explicit tab choice made while a revisioned snapshot loads', async () => {
    const modules = loadStore(true);
    const { useChatStore } = modules;
    let resolveSnapshot: (value: ChatStateSnapshot) => void = () => {};
    getStateMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'other' },
      worktreeChats: {
        [KEY]: {
          activeTabId: 'chat-a',
          tabs: [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
        },
      },
    });
    useChatStore
      .getState()
      .selectWorktree('project', 'worktree', { attentionLanding: true });
    await flushMicrotasks();
    useChatStore.getState().switchTab('chat-b');
    resolveSnapshot(snapshot());
    await useChatStore.getState().loadTabs();
    expect(activeTabId(useChatStore)).toBe('chat-b');
  });

  it('rolls back a rejected landing without clearing sibling unread', async () => {
    const { useChatStore } = loadStore(true);
    getStateMock.mockResolvedValue(snapshot());
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned('project', 'worktree');
    chatCommandMock.mockRejectedValueOnce(new Error('activation unavailable'));
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    });
    useChatStore
      .getState()
      .selectWorktree('project', 'worktree', { attentionLanding: true });
    await useChatStore.getState().loadTabs();
    await flushMicrotasks();
    expect(activeTabId(useChatStore)).toBe('chat-a');
    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY]?.tabs.find((tab) => tab.id === 'chat-a')?.unread,
    ).toBe(true);
    expect(useChatStore.getState().chatStateNotices[KEY]?.kind).toBe(
      'command_failed',
    );
  });
});

it('lands only once for the current A → B → A entry, then respects a manual choice', async () => {
  const { useChatStore } = loadStore(true);
  let resolveSnapshot: (value: ChatStateSnapshot) => void = () => {};
  getStateMock.mockReturnValue(
    new Promise((resolve) => {
      resolveSnapshot = resolve;
    }),
  );
  chatCommandMock.mockClear();
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
  });
  useChatStore
    .getState()
    .selectWorktree('project', 'worktree', { attentionLanding: true });
  await flushMicrotasks();
  useChatStore
    .getState()
    .selectWorktree('project', 'other', { deferTabLoad: true });
  useChatStore
    .getState()
    .selectWorktree('project', 'worktree', { attentionLanding: true });
  resolveSnapshot({
    schemaVersion: 1,
    projectId: 'project',
    worktreeId: 'worktree',
    revision: 1,
    tabsFile: persistedQuestionFile(),
    archives: [],
    runtimeByChatId: {},
    queue: [],
  });
  await useChatStore.getState().loadTabs();
  await flushMicrotasks();
  expect(activeTabId(useChatStore)).toBe('chat-b');
  expect(
    sentCommands().filter(
      (command) =>
        typeof command === 'object' &&
        command !== null &&
        'type' in command &&
        command.type === 'chat.activate_tab',
    ),
  ).toHaveLength(1);
  useChatStore.getState().switchTab('chat-a');
  await useChatStore.getState().loadTabs();
  expect(activeTabId(useChatStore)).toBe('chat-a');
});

it('finishes pending entry landing after retrying a failed initial snapshot', async () => {
  const { useChatStore } = loadStore(true);
  getStateMock
    .mockRejectedValueOnce(new Error('snapshot unavailable'))
    .mockResolvedValue({
      schemaVersion: 1,
      projectId: 'project',
      worktreeId: 'worktree',
      revision: 1,
      tabsFile: persistedQuestionFile(),
      archives: [],
      runtimeByChatId: {},
      queue: [],
    });
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
  });
  useChatStore
    .getState()
    .selectWorktree('project', 'worktree', { attentionLanding: true });
  await useChatStore.getState().loadTabs();
  useChatStore.getState().retryChatStateRefresh('project', 'worktree');
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(activeTabId(useChatStore)).toBe('chat-b');
});

it('ignores a late automatic activation failure after a newer manual choice', async () => {
  const { useChatStore } = loadStore(true);
  getStateMock.mockResolvedValue({
    schemaVersion: 1,
    projectId: 'project',
    worktreeId: 'worktree',
    revision: 1,
    tabsFile: persistedQuestionFile(),
    archives: [],
    runtimeByChatId: {},
    queue: [],
  });
  await useChatStore
    .getState()
    .hydrateChatScopeRevisioned('project', 'worktree');
  let rejectLanding: (error: Error) => void = () => {};
  chatCommandMock.mockImplementation((request) => {
    if (
      request.command.type === 'chat.activate_tab' &&
      request.command.tabId === 'chat-b'
    ) {
      return new Promise((_resolve, reject) => {
        rejectLanding = reject;
      });
    }
    return Promise.resolve({
      commandId: request.commandId,
      revision: 3,
      outcome: 'applied',
    });
  });
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
  });
  useChatStore
    .getState()
    .selectWorktree('project', 'worktree', { attentionLanding: true });
  await useChatStore.getState().loadTabs();
  expect(activeTabId(useChatStore)).toBe('chat-b');
  useChatStore.getState().switchTab('chat-a');
  rejectLanding(new Error('late activation failure'));
  await flushMicrotasks();
  expect(activeTabId(useChatStore)).toBe('chat-a');
});
