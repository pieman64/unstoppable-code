/**
 * @jest-environment jsdom
 */
import { act, Profiler } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { ChatContent } from '../ChatContent';
import { ChatMessageList } from '../ChatMessageList';
import { ToolApprovalDock } from '../ToolApprovalDock';
import { TurnTimer } from '@canopy/ui-shared/components/TurnTimer';
import type { ActiveTranscriptView } from '../types';

jest.mock('@/stores/chat/transcript-pages', () => ({
  loadChatTranscriptPage: jest.fn(),
  TRANSCRIPT_PAGE_LOAD_ERROR: "Couldn't load messages.",
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    ChatMessageList: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-message-list' }),
    ),
  };
});

jest.mock('@/lib/dom-search-highlight', () => ({
  createDomSearchExecutor: jest.fn(() => ({
    findMatches: jest.fn(() => 0),
    clearHighlights: jest.fn(),
    setActiveMatch: jest.fn(),
    scrollToMatch: jest.fn(),
  })),
}));

const transcript: ActiveTranscriptView = {
  id: 'chat-1',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 0,
    },
  ],
  queuedMessages: [],
};

describe('ChatContent scheduled message error', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the scheduled message error', async () => {
    act(() => {
      root.render(
        <ChatContent
          transcript={transcript}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          scheduledMessageError="Couldn't schedule Secret nightly sync"
        />,
      );
    });
    await act(async () => {});

    const error = container.querySelector(
      '[data-testid="chat-scheduled-message-error"]',
    );
    expect(error?.textContent).toBe("Couldn't schedule Secret nightly sync");
  });
});

describe('ChatContent approval wait (CAN-4996)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialState = useChatStore.getState();

  function approval(
    requestId: string,
    overrides: Partial<ApprovalRequestEvent> = {},
  ): ApprovalRequestEvent {
    return {
      requestId,
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      provider: 'claude',
      title: 'touch a.txt',
      details: { kind: 'command', command: 'touch a.txt' },
      ...overrides,
    };
  }

  function lastWaiting(): boolean | undefined {
    const calls = jest.mocked(ChatMessageList).mock.calls;
    return calls[calls.length - 1]?.[0].waitingForApproval;
  }

  function setApprovals(
    pendingApprovals: Record<string, ApprovalRequestEvent>,
  ): void {
    act(() => {
      useChatStore.setState({ pendingApprovals });
    });
  }

  beforeEach(() => {
    jest.mocked(ChatMessageList).mockClear();
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      pendingApprovals: {},
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ChatContent
          transcript={transcript}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState(initialState, true);
  });

  it('waits while this chat has an approval and stops when the last clears', () => {
    expect(lastWaiting()).toBe(false);
    setApprovals({ a: approval('a'), b: approval('b') });
    expect(lastWaiting()).toBe(true);
    setApprovals({ b: approval('b') });
    expect(lastWaiting()).toBe(true);
    setApprovals({});
    expect(lastWaiting()).toBe(false);
  });

  it("ignores another chat, worktree, or project's approval", () => {
    setApprovals({
      a: approval('a', { chatId: 'chat-2' }),
      b: approval('b', { worktreeId: 'worktree-2' }),
      c: approval('c', { projectId: 'project-2' }),
    });
    expect(lastWaiting()).toBe(false);
  });

  it('does not carry waiting into a different chat when the old request remains pending', () => {
    setApprovals({ a: approval('a') });
    expect(lastWaiting()).toBe(true);
    act(() =>
      root.render(
        <ChatContent
          transcript={{ ...transcript, id: 'chat-2' }}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
        />,
      ),
    );
    expect(lastWaiting()).toBe(false);
  });

  it('commits the real dock and shared timer together on each store update', () => {
    const commits: Array<{ card: boolean; timer: string | null | undefined }> =
      [];
    jest
      .mocked(ChatMessageList)
      .mockImplementation(({ waitingForApproval }) => (
        <TurnTimer
          startedAt={Date.now() - 5_000}
          waitingForUser={waitingForApproval}
        />
      ));
    try {
      act(() =>
        root.render(
          <Profiler
            id="approval-seam"
            onRender={() => {
              commits.push({
                card:
                  container.querySelector(
                    '[data-testid="tool-approval-card"]',
                  ) !== null,
                timer: container
                  .querySelector('[data-testid="turn-timer"]')
                  ?.getAttribute('data-state'),
              });
            }}
          >
            <ChatContent
              transcript={transcript}
              composerTab={null}
              onClearQueuedMessage={jest.fn()}
            />
            <ToolApprovalDock
              projectId="project"
              worktreeId="worktree"
              chatId="chat-1"
            />
          </Profiler>,
        ),
      );
      setApprovals({ a: approval('a'), b: approval('b') });
      setApprovals({ b: approval('b') });
      setApprovals({});
      expect(commits.some((commit) => commit.card)).toBe(true);
      expect(
        commits.filter((commit) => commit.card && commit.timer !== 'paused'),
      ).toEqual([]);
      expect(commits.at(-1)).toEqual({ card: false, timer: 'live' });
    } finally {
      jest
        .mocked(ChatMessageList)
        .mockImplementation(() => <div data-testid="mock-message-list" />);
    }
  });
});
