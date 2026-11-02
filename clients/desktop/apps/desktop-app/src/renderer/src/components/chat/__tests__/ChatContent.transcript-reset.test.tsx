/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatContent } from '../ChatContent';
import type { ActiveTranscriptView } from '../types';
import {
  saveChatScrollPosition,
  clearChatScrollPosition,
} from '@/lib/tab-scroll-positions';
import { loadChatTranscriptPage } from '@/stores/chat/transcript-pages';

jest.mock('@/stores/chat/transcript-pages', () => ({
  loadChatTranscriptPage: jest.fn(),
  TRANSCRIPT_PAGE_LOAD_ERROR: "Couldn't load messages.",
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ): unknown =>
    selector({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      loadTurnFeedback: jest.fn(),
      worktreeChats: {},
      pendingApprovals: {},
    }),
}));

jest.mock('@/hooks/useTranscriptSearch', () => ({
  useTranscriptSearch: (): {
    selection: null;
    error: null;
    refresh: jest.Mock;
  } => ({ selection: null, error: null, refresh: jest.fn() }),
}));

jest.mock('@/hooks/useContentSearch', () => ({
  useContentSearch: (): {
    query: string;
    setQuery: jest.Mock;
    currentIndex: number;
    totalCount: number;
    goToNext: jest.Mock;
    goToPrevious: jest.Mock;
    close: jest.Mock;
  } => ({
    query: '',
    setQuery: jest.fn(),
    currentIndex: 0,
    totalCount: 0,
    goToNext: jest.fn(),
    goToPrevious: jest.fn(),
    close: jest.fn(),
  }),
}));

jest.mock('@/lib/workspace-access', () => ({
  useWorkspaceIsReadOnly: (): boolean => false,
}));

jest.mock('../ChatInput', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ChatInput: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-chat-input' }),
    ),
  };
});

jest.mock('../ChatMessageList', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ChatMessageList: ({
      pagingControls,
      messages,
    }: {
      pagingControls: ReactNamespace.ReactNode;
      messages: ActiveTranscriptView['messages'];
    }): unknown =>
      react.createElement(
        'div',
        { 'data-testid': 'mock-message-list' },
        messages.map((message) =>
          react.createElement('div', { key: message.id }, message.id),
        ),
        pagingControls,
      ),
  };
});

jest.mock('../ChatStateRecoveryBanner', () => ({
  ChatStateRecoveryBanner: (): null => null,
}));

jest.mock('@/lib/dom-search-highlight', () => ({
  createDomSearchExecutor: jest.fn(() => ({
    findMatches: jest.fn(() => 0),
    clearHighlights: jest.fn(),
    setActiveMatch: jest.fn(),
    scrollToMatch: jest.fn(),
  })),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const makeTranscript = (
  revision: number,
  loaded: boolean,
): ActiveTranscriptView => ({
  id: 'chat-reset',
  messages: [
    {
      id: 'visible-before-reset',
      role: 'user',
      blocks: [{ type: 'text', text: 'visible row' }],
      timestamp: 1,
    },
  ],
  queuedMessages: [],
  transcriptLoaded: loaded,
  transcriptWindow: {
    view: 'turns',
    turns: [],
    messageOrdinals: { 'visible-before-reset': 1 },
    before: 1,
    totalMessages: 2,
    transcriptRevision: revision,
  },
});

describe('ChatContent transcript reset paging', () => {
  it.each([false, true])(
    'keeps visible rows during reset and retains history only when atBottom is %s',
    async (atBottom) => {
      const target = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-reset',
      };
      saveChatScrollPosition(target, 100, undefined, atBottom);
      let finish: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      jest.mocked(loadChatTranscriptPage).mockReturnValue(pending);
      await act(async () => {
        root.render(
          <ChatContent
            transcript={makeTranscript(1, true)}
            composerTab={null}
            onClearQueuedMessage={jest.fn()}
            hideComposer
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        root.render(
          <ChatContent
            transcript={makeTranscript(2, false)}
            composerTab={null}
            onClearQueuedMessage={jest.fn()}
            hideComposer
          />,
        );
        await Promise.resolve();
      });
      expect(container.textContent).toContain('visible-before-reset');
      expect(loadChatTranscriptPage).toHaveBeenCalledWith(
        target,
        false,
        undefined,
        { retainOlderWindow: !atBottom },
      );
      await act(async () => {
        finish();
        root.render(
          <ChatContent
            transcript={makeTranscript(2, true)}
            composerTab={null}
            onClearQueuedMessage={jest.fn()}
            hideComposer
          />,
        );
        await pending;
      });
    },
  );

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    jest.mocked(loadChatTranscriptPage).mockReset();
    clearChatScrollPosition({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-reset',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps one newest reload in flight across coalesced resets and clears no completion', async () => {
    let finishReload: (() => void) | undefined;
    const reload = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    jest.mocked(loadChatTranscriptPage).mockReturnValue(reload);

    act(() => {
      root.render(
        <ChatContent
          transcript={makeTranscript(2, false)}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          hideComposer
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadChatTranscriptPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('visible-before-reset');

    act(() => {
      root.render(
        <ChatContent
          transcript={makeTranscript(3, false)}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          hideComposer
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadChatTranscriptPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Couldn't load messages.");

    await act(async () => {
      finishReload?.();
      await reload;
      root.render(
        <ChatContent
          transcript={makeTranscript(3, true)}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          hideComposer
        />,
      );
    });
    expect(loadChatTranscriptPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Couldn't load messages.");
  });
});
