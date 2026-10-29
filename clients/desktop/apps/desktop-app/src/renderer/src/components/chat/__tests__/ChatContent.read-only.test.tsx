/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatContent } from '../ChatContent';
import { ChatMessageList } from '../ChatMessageList';
import type { ActiveTranscriptView } from '../types';
import {
  WorkspaceAccessContext,
  type WorkspaceAccess,
} from '@/lib/workspace-access';

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

const READ_ONLY: WorkspaceAccess = {
  mode: 'read-only',
  reason: 'shared-container',
  containerType: 'CODE_WORKTREE',
  runAllowed: false,
};

interface MessageListProps {
  hideBranchActions?: boolean;
  onResetToPoint?: unknown;
}

function lastMessageListProps(): MessageListProps {
  const mock = jest.mocked(ChatMessageList);
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return (call?.[0] ?? {}) satisfies MessageListProps;
}

describe('ChatContent in a read-only scope', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.mocked(ChatMessageList).mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(access?: WorkspaceAccess): Promise<void> {
    const content = (
      <ChatContent
        transcript={transcript}
        composerTab={null}
        onClearQueuedMessage={jest.fn()}
        onResetToPoint={jest.fn((): Promise<void> => Promise.resolve())}
      />
    );
    act(() => {
      root.render(
        access === undefined ? (
          content
        ) : (
          <WorkspaceAccessContext.Provider value={access}>
            {content}
          </WorkspaceAccessContext.Provider>
        ),
      );
    });
    await act(async () => {});
  }

  it('keeps the composer and turn actions in a read-write scope', async () => {
    await render();

    expect(
      container.querySelector('[data-testid="mock-chat-input"]'),
    ).not.toBeNull();
    expect(lastMessageListProps().hideBranchActions).toBeFalsy();
    expect(lastMessageListProps().onResetToPoint).toBeDefined();
  });

  it('renders the transcript with no composer, branch or rewind actions', async () => {
    await render(READ_ONLY);

    expect(
      container.querySelector('[data-testid="mock-message-list"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-chat-input"]')).toBe(
      null,
    );
    expect(lastMessageListProps().hideBranchActions).toBe(true);
    expect(lastMessageListProps().onResetToPoint).toBeUndefined();
  });
});
