// A chat whose background agents still run reports its completion once they
// settle, not at every wake's result (turn-state phase 36d).
import type * as ChatStoreModule from '../stores/chatStore';
import type * as NotificationsModule from '../stores/chat/notifications';
import type * as DelegationActivityModule from '../stores/delegationActivityStore';

type SettledListener = (target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}) => void;

const KEY = 'project/worktree';
const TARGET = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat-b',
};

let liveDelegates = false;
let settledListeners: SettledListener[] = [];
const toastMock = jest.fn();
const pingMock = jest.fn();

jest.mock('../stores/chat/notifications', () => ({
  ...jest.requireActual<typeof NotificationsModule>(
    '../stores/chat/notifications',
  ),
  maybeShowUnreadChatToast: (...args: unknown[]): void => {
    toastMock(...args);
  },
  maybeFireChatActivityNotification: (...args: unknown[]): void => {
    pingMock(...args);
  },
}));

jest.mock('../stores/delegationActivityStore', () => ({
  ...jest.requireActual<typeof DelegationActivityModule>(
    '../stores/delegationActivityStore',
  ),
  chatHasLiveDelegates: (): boolean => liveDelegates,
  subscribeChatDelegatesSettled: (listener: SettledListener): (() => void) => {
    settledListeners.push(listener);
    return (): void => {
      settledListeners = settledListeners.filter(
        (candidate) => candidate !== listener,
      );
    };
  },
}));

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
          loadTabs: jest.fn(),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          command: jest.fn().mockResolvedValue({ outcome: 'applied' }),
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
  over: Partial<ChatStoreModule.ChatTab>,
): ChatStoreModule.ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
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

function seedBackgroundChat(
  useChatStore: typeof ChatStoreModule.useChatStore,
): void {
  useChatStore.setState({
    // A different worktree is on screen, so the chat finishes off-screen.
    selectedWorktree: { projectId: 'project', worktreeId: 'other' },
    worktreeChats: {
      [KEY]: {
        activeTabId: 'chat-a',
        tabs: [
          makeTab({ id: 'chat-a', status: 'idle' }),
          makeTab({ id: 'chat-b', title: 'Background work' }),
        ],
      },
    },
  });
}

function result(
  useChatStore: typeof ChatStoreModule.useChatStore,
  text: string,
): void {
  useChatStore.getState().handleChatEvent({
    ...TARGET,
    data: { type: 'result', subtype: 'success', result: text },
  });
}

describe('chat completion notices while background agents run', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    liveDelegates = false;
    settledListeners = [];
    toastMock.mockClear();
    pingMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function settleDelegates(): void {
    liveDelegates = false;
    for (const listener of settledListeners) listener(TARGET);
  }

  function patchChatB(
    useChatStore: typeof ChatStoreModule.useChatStore,
    patch: Partial<ChatStoreModule.ChatTab>,
  ): void {
    useChatStore.setState((state) => ({
      worktreeChats: {
        [KEY]: {
          ...state.worktreeChats[KEY],
          tabs: state.worktreeChats[KEY].tabs.map((tab) =>
            tab.id === 'chat-b' ? { ...tab, ...patch } : tab,
          ),
        },
      },
    }));
  }

  it('holds the completion notice until the agents settle, then shows it once', () => {
    const { useChatStore } = loadStore();
    seedBackgroundChat(useChatStore);
    liveDelegates = true;

    result(useChatStore, 'Started two agents.');
    result(useChatStore, 'The first agent finished.');
    expect(toastMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();

    settleDelegates();
    jest.advanceTimersByTime(5_000);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('lets the wake that follows the settle report the held notice once', () => {
    const { useChatStore } = loadStore();
    seedBackgroundChat(useChatStore);
    liveDelegates = true;

    result(useChatStore, 'Started an agent.');
    settleDelegates();
    // The settled agent wakes the chat, which streams its final answer.
    patchChatB(useChatStore, { status: 'streaming' });
    jest.advanceTimersByTime(5_000);
    expect(toastMock).not.toHaveBeenCalled();

    result(useChatStore, 'All done.');
    jest.advanceTimersByTime(5_000);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('drops a held notice for a chat the user read before its work settled', () => {
    const { useChatStore } = loadStore();
    seedBackgroundChat(useChatStore);
    patchChatB(useChatStore, { providerType: 'codex' });
    liveDelegates = true;

    result(useChatStore, 'Started an agent.');
    patchChatB(useChatStore, { unread: false, status: 'idle' });
    settleDelegates();
    jest.advanceTimersByTime(5_000);
    expect(toastMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('notifies at once when no background work runs', () => {
    const { useChatStore } = loadStore();
    seedBackgroundChat(useChatStore);

    result(useChatStore, 'Done.');
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
