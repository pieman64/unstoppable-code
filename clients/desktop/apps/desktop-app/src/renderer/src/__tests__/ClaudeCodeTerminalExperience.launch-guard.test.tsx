/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClaudeCodeTerminalExperience } from '@/components/chat/ClaudeCodeTerminalExperience';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnsureClaudeTerminal = jest.fn(() => Promise.resolve(undefined));
let mockByChat: Record<string, unknown> = {};
let mockQueuedMessages: Array<{ text: string }> = [];

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    ensureClaudeTerminal: mockEnsureClaudeTerminal,
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat',
        tabs: [{ id: 'chat', queuedMessages: mockQueuedMessages }],
      },
    },
  });
  return {
    useChatStore: (selector: (state: unknown) => unknown): unknown =>
      selector(mockState()),
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(() => mockState()),
  };
});

jest.mock('@/stores/claudeTerminalStore', () => ({
  useClaudeTerminalStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ byChat: mockByChat }),
}));

jest.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: (): null => null,
}));

describe('ClaudeCodeTerminalExperience launch ownership', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    mockByChat = {};
    mockQueuedMessages = [];
    mockEnsureClaudeTerminal.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function render(): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <ClaudeCodeTerminalExperience
          projectId="project"
          worktreeId="worktree"
          chatId="chat"
        />,
      );
    });
  }

  it('launches the terminal on mount when no auto send is pending', () => {
    render();
    expect(mockEnsureClaudeTerminal).toHaveBeenCalledTimes(1);
  });

  it('defers to the send-path launch while a queued auto send is pending without a terminal', () => {
    // The send path owns the launch in this window and passes the queued
    // prompt as the CLI's initial argument; a promptless launch from the
    // mount effect would win the in-flight dedupe and strand the prompt.
    mockQueuedMessages = [{ text: 'queued prompt' }];
    mockByChat = {
      'project/worktree/chat': {
        turnState: 'uninitialized',
        launchStatus: 'idle',
        autoSendPending: true,
      },
    };
    render();
    expect(mockEnsureClaudeTerminal).not.toHaveBeenCalled();
  });

  it('still launches for a pending auto send with no queued message (live-terminal rehydration)', () => {
    // No queued message means the send path wrote directly into a live
    // terminal (e.g. after a renderer reload) and will never launch — the
    // mount effect must run so the renderer rehydrates the live runtime.
    mockByChat = {
      'project/worktree/chat': {
        turnState: 'uninitialized',
        launchStatus: 'idle',
        autoSendPending: true,
      },
    };
    render();
    expect(mockEnsureClaudeTerminal).toHaveBeenCalledTimes(1);
  });

  it('still ensures the terminal when an auto send is pending on a live terminal', () => {
    mockByChat = {
      'project/worktree/chat': {
        turnState: 'idle',
        launchStatus: 'ready',
        terminalId: 'terminal-1',
        autoSendPending: true,
      },
    };
    render();
    expect(mockEnsureClaudeTerminal).toHaveBeenCalledTimes(1);
  });
});
