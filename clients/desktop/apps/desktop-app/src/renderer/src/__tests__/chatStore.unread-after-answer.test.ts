// Answering an interactive ask-user question must clear the unread state that
// the question itself raised on a non-visible chat tab. Without this the
// orange question dot disappears (answeredAt filters it) while a bare blue
// unread dot survives on the sidebar row with nothing new to see.
import type {
  ChatCommandRequest,
  ChatCommandResponse,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';

const KEY = 'project/worktree';
const QUESTIONS = [{ id: 'q1', question: 'Continue?', options: ['yes'] }];
const ANSWERS = [
  { questionId: 'q1', question: 'Continue?', selectedOptions: ['yes'] },
];

const answerMcpQuestionMock = jest.fn().mockResolvedValue({ accepted: true });
const dismissMcpQuestionMock = jest.fn().mockResolvedValue(undefined);
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

function loadStore(): typeof ChatStoreModule {
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
          answerMcpQuestion: answerMcpQuestionMock,
          dismissMcpQuestion: dismissMcpQuestionMock,
          preparePlanFileSystemInstruction: noop,
        },
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
      },
    },
  });
  return jest.requireActual<typeof ChatStoreModule>('../stores/chatStore');
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
        blocks: [{ type: 'text', text: 'Need input' }],
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

function requireTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
  chatId: string,
): ChatStoreModule.ChatTab {
  const tab = useChatStore
    .getState()
    .worktreeChats[KEY]?.tabs.find((entry) => entry.id === chatId);
  if (!tab) {
    throw new Error(`Tab ${chatId} not found in ${KEY}`);
  }
  return tab;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

/** Two tabs: `chat-a` active, `chat-b` in the background awaiting a question. */
function seedTwoTabs(
  useChatStore: typeof ChatStoreModule.useChatStore,
  over: Partial<ChatStoreModule.ChatTab> = {},
): void {
  useChatStore.setState({
    // A different worktree is on screen, so nothing in KEY is visible.
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    worktreeChats: {
      [KEY]: {
        activeTabId: 'chat-a',
        tabs: [
          makeTab({ id: 'chat-a', status: 'idle', messages: [] }),
          makeTab({ id: 'chat-b', ...over }),
        ],
      },
    },
  });
}

function askOnChatB(useChatStore: typeof ChatStoreModule.useChatStore): void {
  useChatStore.getState().handleMcpAskUser({
    requestId: 'req-1',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat-b',
    questions: QUESTIONS,
  });
}

describe('chatStore unread state after answering an ask-user question', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    answerMcpQuestionMock.mockClear();
    dismissMcpQuestionMock.mockClear();
    chatCommandMock.mockClear();
    loadTabsMock.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('clears the unread the live question raised on a background tab once it is answered', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);

    askOnChatB(useChatStore);
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);

    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(answerMcpQuestionMock).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().pendingQuestions['req-1']?.answeredAt,
    ).toEqual(expect.any(Number));
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(false);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(false);
  });

  it('clears the unread that hydration raised for a persisted pending question (portal answer path)', async () => {
    const { useChatStore } = loadStore();
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    });
    loadTabsMock.mockResolvedValue({
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
    });

    // Same entry point `applyQuestionMutation` in App.tsx uses.
    await useChatStore.getState().loadTabsForTarget('project', 'worktree');
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(requireTab(useChatStore, 'chat-a').unread).not.toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);

    await useChatStore.getState().answerMcpQuestionAndWait('req-1', ANSWERS);

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(false);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(false);
  });

  it('drops a stale manual mark when the question raises unread (CAN-4378)', () => {
    const { useChatStore } = loadStore();
    // A resumed turn clears `unread` but leaves the earlier manual mark.
    seedTwoTabs(useChatStore, { unread: false, unreadMarkedManually: true });

    askOnChatB(useChatStore);

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(
      requireTab(useChatStore, 'chat-b').unreadMarkedManually,
    ).toBeUndefined();
  });

  it('keeps a live manual mark when a question arrives on the unread tab', () => {
    const { useChatStore } = loadStore();
    // Main still holds the manual flag; the renderer must not diverge from it.
    seedTwoTabs(useChatStore, { unread: true, unreadMarkedManually: true });

    askOnChatB(useChatStore);

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(requireTab(useChatStore, 'chat-b').unreadMarkedManually).toBe(true);
  });

  it('answering keeps a manual mark set after the question was read (CAN-4378)', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);
    askOnChatB(useChatStore);
    useChatStore
      .getState()
      .markTargetRead('project', 'worktree', { tabId: 'chat-b' });
    useChatStore
      .getState()
      .setChatUnread('project', 'worktree', 'chat-b', true);

    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(requireTab(useChatStore, 'chat-b').unreadMarkedManually).toBe(true);
  });

  it('keeps an unread that a completed turn set before the question arrived', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore, { unread: true });
    useChatStore.setState({ unreadWorktreeKeys: new Set([KEY]) });

    askOnChatB(useChatStore);
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);

    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
  });

  it('keeps the worktree key while a sibling tab is still unread', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);
    useChatStore.setState((state) => ({
      worktreeChats: {
        [KEY]: {
          ...state.worktreeChats[KEY],
          tabs: state.worktreeChats[KEY].tabs.map((tab) =>
            tab.id === 'chat-a' ? { ...tab, unread: true } : tab,
          ),
        },
      },
      unreadWorktreeKeys: new Set([KEY]),
    }));

    askOnChatB(useChatStore);
    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(false);
    expect(requireTab(useChatStore, 'chat-a').unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
  });

  it('keeps the unread while another question on the same tab is still unanswered', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);

    askOnChatB(useChatStore);
    useChatStore.getState().handleMcpAskUser({
      requestId: 'req-2',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      questions: [{ id: 'q2', question: 'Also?', options: ['no'] }],
    });

    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);

    useChatStore
      .getState()
      .answerMcpQuestion('req-2', [
        { questionId: 'q2', question: 'Also?', selectedOptions: ['no'] },
      ]);
    await flushMicrotasks();
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(false);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(false);
  });

  it('keeps the unread when a dismissed question has a sibling that is answered later', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);

    askOnChatB(useChatStore);
    useChatStore.getState().handleMcpAskUser({
      requestId: 'req-2',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      questions: [{ id: 'q2', question: 'Also?', options: ['no'] }],
    });

    // The dismissed question was never read, so it releases the marker at
    // once; the sibling's answer must not be able to clear the unread later.
    await useChatStore.getState().dismissMcpQuestionAndWait('req-1');
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(
      requireTab(useChatStore, 'chat-b').unreadRaisedByQuestion,
    ).toBeUndefined();

    useChatStore
      .getState()
      .answerMcpQuestion('req-2', [
        { questionId: 'q2', question: 'Also?', selectedOptions: ['no'] },
      ]);
    await flushMicrotasks();
    expect(requireTab(useChatStore, 'chat-b').unread).toBe(true);
    expect(useChatStore.getState().unreadWorktreeKeys.has(KEY)).toBe(true);
    // `command` takes one envelope whose discriminant is `command.type`, so
    // inspect the relayed commands rather than the call arguments.
    const commands = chatCommandMock.mock.calls.map(
      ([request]) => request.command,
    );
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: 'chat.mark_read' }),
    );
  });

  it('relays chat.mark_read to main when the scope is revisioned-live', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore);
    useChatStore.setState({
      chatStateSync: { [KEY]: { phase: 'live', revision: 1 } },
    });

    askOnChatB(useChatStore);
    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(requireTab(useChatStore, 'chat-b').unread).toBe(false);
    const commands = chatCommandMock.mock.calls.map(
      ([request]) => request.command,
    );
    expect(commands).toContainEqual({
      type: 'chat.mark_read',
      chatId: 'chat-b',
    });
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: 'chat.dismiss_attention' }),
    );
  });

  it('does not relay chat.mark_read when nothing was cleared', async () => {
    const { useChatStore } = loadStore();
    seedTwoTabs(useChatStore, { unread: true });
    useChatStore.setState({
      unreadWorktreeKeys: new Set([KEY]),
      chatStateSync: { [KEY]: { phase: 'live', revision: 1 } },
    });

    askOnChatB(useChatStore);
    useChatStore.getState().answerMcpQuestion('req-1', ANSWERS);
    await flushMicrotasks();

    expect(chatCommandMock).not.toHaveBeenCalled();
  });
});
