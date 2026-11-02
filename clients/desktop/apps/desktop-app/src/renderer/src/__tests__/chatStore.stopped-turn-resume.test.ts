/**
 * CAN-3137 — explicit Resume for a turn the user stopped.
 *
 * Covers the renderer half: the offer main returns from `chat:cancel`, the
 * single-flight resume dispatch, failure and stale handling, and retiring the
 * offer once another turn starts.
 */
import type {
  ChatCancelRequest,
  ChatCancelResult,
  ChatResumeStoppedTurnRequest,
  ChatResumeStoppedTurnResult,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../stores/chatStore';
import type * as GitHubStoreModule from '../stores/githubStore';
import { toActiveComposerView } from '../components/chat/types';
import {
  STOPPED_TURN_RESUME_FAILED_MESSAGE,
  STOPPED_TURN_RESUME_STALE_MESSAGE,
} from '../stores/chat/stopped-turn-resume';

const sendMessageMock = jest.fn().mockResolvedValue(undefined);
const cancelChatMock = jest.fn<
  Promise<ChatCancelResult>,
  [ChatCancelRequest]
>();
const resumeStoppedTurnMock = jest.fn<
  Promise<ChatResumeStoppedTurnResult>,
  [ChatResumeStoppedTurnRequest]
>();
const noop = jest.fn();

function loadStore(): {
  chat: typeof ChatStoreModule;
  github: typeof GitHubStoreModule;
} {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          sendMessage: sendMessageMock,
          cancel: cancelChatMock,
          resumeStoppedTurn: resumeStoppedTurnMock,
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          cancelDeferredToolsReload: noop,
          answerMcpQuestion: noop,
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
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  return {
    chat: jest.requireActual<typeof ChatStoreModule>('../stores/chatStore'),
    github: jest.requireActual<typeof GitHubStoreModule>(
      '../stores/githubStore',
    ),
  };
}

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat' };

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
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Partial answer' }],
        timestamp: 950,
      },
    ],
    status: 'streaming',
    error: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    approvalMode: 'ask',
    sdkSessionId: 'sdk-abc',
    ...over,
  };
}

function seedTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
  tab: ChatStoreModule.ChatTab,
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    worktreeChats: { 'proj/wt': { activeTabId: tab.id, tabs: [tab] } },
  });
}

function requireTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
): ChatStoreModule.ChatTab {
  const tab = useChatStore
    .getState()
    .worktreeChats['proj/wt']?.tabs.find((entry) => entry.id === 'chat');
  if (!tab) throw new Error('tab missing');
  return tab;
}

function markIdle(useChatStore: typeof ChatStoreModule.useChatStore): void {
  const tab = requireTab(useChatStore);
  seedTab(useChatStore, { ...tab, status: 'idle' });
}

describe('stopped-turn resume (CAN-3137)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('offers Resume after stopping a resumable turn', async () => {
    const { chat } = loadStore();
    seedTab(chat.useChatStore, makeTab());
    cancelChatMock.mockResolvedValueOnce({
      resumableTurn: { userMessageId: 'user-1' },
    });

    await chat.useChatStore.getState().cancelSession(TARGET);
    markIdle(chat.useChatStore);

    const tab = requireTab(chat.useChatStore);
    expect(tab.stoppedTurnResume).toEqual({
      userMessageId: 'user-1',
      status: 'available',
    });
    expect(toActiveComposerView(tab).stoppedTurnResumeUserMessageId).toBe(
      'user-1',
    );
  });

  it('offers nothing when main reports the stop as not resumable', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        stoppedTurnResume: { userMessageId: 'older', status: 'available' },
      }),
    );
    cancelChatMock.mockResolvedValueOnce({});

    await chat.useChatStore.getState().cancelSession(TARGET);

    expect(requireTab(chat.useChatStore).stoppedTurnResume).toBeUndefined();
  });

  it('hides the offer while the turn is still running', () => {
    const tab = makeTab({
      status: 'streaming',
      stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
    });
    expect(
      toActiveComposerView(tab).stoppedTurnResumeUserMessageId,
    ).toBeUndefined();
  });

  it('resumes without re-sending the user message and dispatches once for rapid clicks', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }),
    );
    let resolveResume: (result: ChatResumeStoppedTurnResult) => void = () =>
      undefined;
    resumeStoppedTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );

    const first = chat.useChatStore.getState().resumeStoppedTurn(TARGET);
    const second = chat.useChatStore.getState().resumeStoppedTurn(TARGET);
    expect(requireTab(chat.useChatStore).status).toBe('streaming');
    resolveResume({ disposition: 'dispatched' });
    await Promise.all([first, second]);

    expect(resumeStoppedTurnMock).toHaveBeenCalledTimes(1);
    expect(resumeStoppedTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...TARGET,
        userMessageId: 'user-1',
        sdkSessionId: 'sdk-abc',
        providerType: 'claude',
        approvalMode: 'ask',
      }),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    const tab = requireTab(chat.useChatStore);
    expect(tab.stoppedTurnResume).toBeUndefined();
    expect(tab.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(tab.messages.some((m) => m.id === 'assistant-1')).toBe(true);
  });

  it('keeps the chat usable and the offer retryable after a failed resume', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }),
    );
    resumeStoppedTurnMock.mockResolvedValueOnce({
      disposition: 'failed',
      error: 'Provider unavailable. Try again.',
      retryable: true,
    });

    await chat.useChatStore.getState().resumeStoppedTurn(TARGET);

    const tab = requireTab(chat.useChatStore);
    expect(tab.status).toBe('idle');
    expect(tab.stoppedTurnResume).toEqual({
      userMessageId: 'user-1',
      status: 'available',
      error: 'Provider unavailable. Try again.',
    });
    expect(toActiveComposerView(tab).stoppedTurnResumeError).toBe(
      'Provider unavailable. Try again.',
    );
  });

  it('treats a rejected IPC as a retryable failure', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }),
    );
    resumeStoppedTurnMock.mockRejectedValueOnce(new Error(''));

    await chat.useChatStore.getState().resumeStoppedTurn(TARGET);

    const tab = requireTab(chat.useChatStore);
    expect(tab.status).toBe('idle');
    expect(tab.stoppedTurnResume?.error).toBe(
      STOPPED_TURN_RESUME_FAILED_MESSAGE,
    );
  });

  it('retires a stale offer main refused and says why', async () => {
    const { chat, github } = loadStore();
    const addToast = jest
      .spyOn(github.useGitHubStore.getState(), 'addToast')
      .mockImplementation(() => undefined);
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }),
    );
    resumeStoppedTurnMock.mockResolvedValueOnce({ disposition: 'stale' });

    await chat.useChatStore.getState().resumeStoppedTurn(TARGET);

    const tab = requireTab(chat.useChatStore);
    expect(tab.status).toBe('idle');
    expect(tab.stoppedTurnResume).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith(
      STOPPED_TURN_RESUME_STALE_MESSAGE,
      'info',
    );
  });

  it('hides and refuses the offer once a newer turn exists', async () => {
    const { chat } = loadStore();
    const base = makeTab();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
        messages: [
          ...base.messages,
          {
            id: 'user-2',
            role: 'user',
            blocks: [{ type: 'text', text: 'something else' }],
            timestamp: 2000,
          },
        ],
      }),
    );

    expect(
      toActiveComposerView(requireTab(chat.useChatStore))
        .stoppedTurnResumeUserMessageId,
    ).toBeUndefined();
    await chat.useChatStore.getState().resumeStoppedTurn(TARGET);
    expect(resumeStoppedTurnMock).not.toHaveBeenCalled();
  });

  it('hides and refuses the offer when a newer turn is already queued', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
        queuedMessages: [
          {
            text: 'Do something else instead.',
            origin: 'desktop',
            enqueuedAtMs: 2_000,
          },
        ],
      }),
    );

    expect(
      toActiveComposerView(requireTab(chat.useChatStore))
        .stoppedTurnResumeUserMessageId,
    ).toBeUndefined();
    await chat.useChatStore.getState().resumeStoppedTurn(TARGET);
    expect(resumeStoppedTurnMock).not.toHaveBeenCalled();
  });

  it('does not let a late resume reply clear a newer stop offer', async () => {
    const { chat } = loadStore();
    seedTab(
      chat.useChatStore,
      makeTab({
        status: 'idle',
        stoppedTurnResume: { userMessageId: 'user-1', status: 'available' },
      }),
    );
    let resolveResume: (result: ChatResumeStoppedTurnResult) => void = () =>
      undefined;
    resumeStoppedTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    cancelChatMock.mockResolvedValueOnce({
      resumableTurn: { userMessageId: 'user-1' },
    });

    const resume = chat.useChatStore.getState().resumeStoppedTurn(TARGET);
    await chat.useChatStore.getState().cancelSession(TARGET);
    resolveResume({ disposition: 'dispatched' });
    await resume;

    expect(requireTab(chat.useChatStore).stoppedTurnResume).toEqual({
      userMessageId: 'user-1',
      status: 'available',
    });
  });
});
