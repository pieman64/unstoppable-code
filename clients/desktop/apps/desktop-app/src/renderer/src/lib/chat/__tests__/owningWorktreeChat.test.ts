/**
 * @jest-environment jsdom
 */
import {
  OWNING_CHAT_SEND_REJECTED_MESSAGE,
  OWNING_CHAT_UNAVAILABLE_MESSAGE,
  resolveOwningWorktreeChatId,
  sendToOwningWorktreeChat,
} from '@/lib/chat/owningWorktreeChat';
import { useChatStore, type ChatTab } from '@/stores/chatStore';

const SCOPE = { projectId: 'proj-1', worktreeId: 'wt-1' };
const KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;
const SELECTED = { projectId: 'proj-2', worktreeId: 'wt-selected' };
const SELECTED_KEY = `${SELECTED.projectId}/${SELECTED.worktreeId}`;

let loadTabsForTarget: jest.Mock;
let ensureWorktreeHasChatTab: jest.Mock;
let switchTab: jest.Mock;
let sendMessage: jest.Mock;

function tab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

beforeEach(() => {
  loadTabsForTarget = jest.fn().mockResolvedValue(undefined);
  ensureWorktreeHasChatTab = jest.fn().mockResolvedValue(undefined);
  switchTab = jest.fn();
  sendMessage = jest.fn().mockResolvedValue(undefined);
  useChatStore.setState({
    selectedWorktree: SELECTED,
    worktreeChats: {
      [SELECTED_KEY]: {
        tabs: [tab('selected-chat')],
        activeTabId: 'selected-chat',
      },
    },
    loadTabsForTarget,
    ensureWorktreeHasChatTab,
    switchTab,
    sendMessage,
  });
});

describe('resolveOwningWorktreeChatId', () => {
  it('uses the active chat of a loaded worktree without loading it again', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: { tabs: [tab('chat-a'), tab('chat-b')], activeTabId: 'chat-b' },
      },
    }));

    await expect(resolveOwningWorktreeChatId(SCOPE)).resolves.toBe('chat-b');
    expect(loadTabsForTarget).not.toHaveBeenCalled();
    expect(ensureWorktreeHasChatTab).not.toHaveBeenCalled();
  });

  it('loads an unloaded worktree before resolving its chat', async () => {
    loadTabsForTarget.mockImplementation((): Promise<void> => {
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { tabs: [tab('loaded-chat')], activeTabId: 'loaded-chat' },
        },
      }));
      return Promise.resolve();
    });

    await expect(resolveOwningWorktreeChatId(SCOPE)).resolves.toBe(
      'loaded-chat',
    );
    expect(loadTabsForTarget).toHaveBeenCalledWith('proj-1', 'wt-1');
  });

  it('prefers the last editable chat while a file tab is active', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          tabs: [
            tab('chat-a'),
            tab('chat-b'),
            tab('file-1', { kind: 'file', filePath: '/repo/a.ts' }),
          ],
          activeTabId: 'file-1',
          lastActiveEditableChatId: 'chat-b',
        },
      },
    }));

    await expect(resolveOwningWorktreeChatId(SCOPE)).resolves.toBe('chat-b');
  });

  it('creates a chat when the worktree has no editable one', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          tabs: [tab('file-1', { kind: 'file', filePath: '/repo/a.ts' })],
          activeTabId: 'file-1',
        },
      },
    }));
    ensureWorktreeHasChatTab.mockImplementation((): Promise<void> => {
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { tabs: [tab('new-chat')], activeTabId: 'new-chat' },
        },
      }));
      return Promise.resolve();
    });

    await expect(resolveOwningWorktreeChatId(SCOPE)).resolves.toBe('new-chat');
    expect(ensureWorktreeHasChatTab).toHaveBeenCalledWith(SCOPE);
  });

  it('resolves null when no editable chat exists or can be created', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          tabs: [tab('read-only', { readOnly: true })],
          activeTabId: 'read-only',
        },
      },
    }));

    await expect(resolveOwningWorktreeChatId(SCOPE)).resolves.toBeNull();
  });
});

describe('sendToOwningWorktreeChat', () => {
  beforeEach(() => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: { tabs: [tab('owning-chat')], activeTabId: 'owning-chat' },
      },
    }));
  });

  it("sends to the owning worktree's chat, not the selected worktree", async () => {
    await expect(
      sendToOwningWorktreeChat(SCOPE, 'Hello', {
        hiddenContext: {
          kind: 'plan-explore-comment-instructions',
          text: 'Context',
        },
      }),
    ).resolves.toBe('owning-chat');

    expect(switchTab).toHaveBeenCalledWith('owning-chat', SCOPE);
    expect(sendMessage).toHaveBeenCalledWith(
      'Hello',
      undefined,
      { ...SCOPE, chatId: 'owning-chat' },
      undefined,
      expect.objectContaining({
        throwOnDispatchFailure: true,
        hiddenContext: {
          kind: 'plan-explore-comment-instructions',
          text: 'Context',
        },
      }),
    );
    expect(useChatStore.getState().selectedWorktree).toEqual(SELECTED);
  });

  it('reports the chosen chat once, after switching to it and before the send settles', async () => {
    let settleSend: () => void = () => undefined;
    sendMessage.mockImplementation(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          settleSend = resolve;
        }),
    );
    const onChatChosen = jest.fn((chatId: string): void => {
      // The chat is already the worktree's active tab when it is reported.
      expect(chatId).toBe('owning-chat');
      expect(switchTab).toHaveBeenCalledWith('owning-chat', SCOPE);
    });

    const sent = sendToOwningWorktreeChat(SCOPE, 'Hello', { onChatChosen });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }

    expect(onChatChosen).toHaveBeenCalledTimes(1);
    expect(onChatChosen).toHaveBeenCalledWith('owning-chat');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The callback is the caller's, never a dispatch option.
    expect(sendMessage).not.toHaveBeenCalledWith(
      'Hello',
      undefined,
      { ...SCOPE, chatId: 'owning-chat' },
      undefined,
      expect.objectContaining({ onChatChosen }),
    );

    settleSend();
    await expect(sent).resolves.toBe('owning-chat');
    expect(onChatChosen).toHaveBeenCalledTimes(1);
  });

  it('reports no chat when none is available', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: { tabs: [], activeTabId: '' },
      },
    }));
    const onChatChosen = jest.fn();

    await expect(
      sendToOwningWorktreeChat(SCOPE, 'Hello', { onChatChosen }),
    ).rejects.toThrow(OWNING_CHAT_UNAVAILABLE_MESSAGE);
    expect(onChatChosen).not.toHaveBeenCalled();
  });

  it('rejects when the send is refused before dispatch', async () => {
    sendMessage.mockImplementation(
      (
        _text: string,
        _refs: unknown,
        _target: unknown,
        _mode: unknown,
        options: { onPreDispatchRejected?: () => void },
      ): Promise<void> => {
        options.onPreDispatchRejected?.();
        return Promise.resolve();
      },
    );

    await expect(sendToOwningWorktreeChat(SCOPE, 'Hello')).rejects.toThrow(
      OWNING_CHAT_SEND_REJECTED_MESSAGE,
    );
  });

  it('rejects when the dispatch fails', async () => {
    sendMessage.mockRejectedValue(new Error('Provider unavailable'));

    await expect(sendToOwningWorktreeChat(SCOPE, 'Hello')).rejects.toThrow(
      'Provider unavailable',
    );
  });

  it('rejects without sending when no chat is available', async () => {
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: { tabs: [], activeTabId: '' },
      },
    }));

    await expect(sendToOwningWorktreeChat(SCOPE, 'Hello')).rejects.toThrow(
      OWNING_CHAT_UNAVAILABLE_MESSAGE,
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });
});
