/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatContent } from '../ChatContent';
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
