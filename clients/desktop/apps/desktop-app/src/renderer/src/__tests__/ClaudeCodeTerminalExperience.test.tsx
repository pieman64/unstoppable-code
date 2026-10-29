import { renderToStaticMarkup } from 'react-dom/server';
import { ClaudeCodeTerminalExperience } from '@/components/chat/ClaudeCodeTerminalExperience';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockEnsureClaudeTerminal = jest.fn();
let mockByChat: Record<string, unknown> = {};

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    ensureClaudeTerminal: mockEnsureClaudeTerminal,
    worktreeChats: {},
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
  TerminalPane: ({
    terminalId,
    addToChatSelectionHelper,
    pasteDroppedFiles,
  }: {
    terminalId: string;
    addToChatSelectionHelper?: boolean;
    pasteDroppedFiles?: boolean;
  }): unknown => {
    return (
      <div
        data-testid="terminal-pane"
        data-terminal-id={terminalId}
        data-add-to-chat-selection-helper={String(addToChatSelectionHelper)}
        data-paste-dropped-files={String(pasteDroppedFiles)}
      />
    );
  },
}));

describe('ClaudeCodeTerminalExperience', () => {
  beforeEach(() => {
    mockByChat = {};
    mockEnsureClaudeTerminal.mockReset();
  });

  it('shows the contract launching copy while Claude Code is starting', () => {
    const html = renderToStaticMarkup(
      <ClaudeCodeTerminalExperience
        projectId="project"
        worktreeId="worktree"
        chatId="chat"
      />,
    );

    expect(html).toContain('Starting Claude Code…');
  });

  it('lets the terminal pane fill the Claude Code panel when ready', () => {
    mockByChat = {
      'project/worktree/chat': {
        launchStatus: 'ready',
        turnState: 'idle',
        terminalId: 'terminal-1',
        firstOutputAt: 123,
      },
    };

    const html = renderToStaticMarkup(
      <ClaudeCodeTerminalExperience
        projectId="project"
        worktreeId="worktree"
        chatId="chat"
      />,
    );

    expect(html).toContain('data-testid="claude-code-experience-ready"');
    expect(html).not.toContain('pt-10');
    expect(html).not.toContain('pr-[150px]');
    expect(html).toContain('data-terminal-id="terminal-1"');
    expect(html).toContain('data-add-to-chat-selection-helper="false"');
    expect(html).toContain('data-paste-dropped-files="true"');
    // The CLI has produced output, so no boot overlay covers the pane.
    expect(html).not.toContain('claude-code-experience-booting');
  });

  it('overlays the starting copy on the pane until the CLI produces output', () => {
    mockByChat = {
      'project/worktree/chat': {
        launchStatus: 'ready',
        turnState: 'idle',
        terminalId: 'terminal-1',
      },
    };

    const html = renderToStaticMarkup(
      <ClaudeCodeTerminalExperience
        projectId="project"
        worktreeId="worktree"
        chatId="chat"
      />,
    );

    // The pane mounts (so the PTY attaches and sizes correctly) but stays
    // hidden behind the boot overlay while the CLI starts up silently.
    expect(html).toContain('data-terminal-id="terminal-1"');
    expect(html).toContain('data-testid="claude-code-experience-booting"');
    expect(html).toContain('Starting Claude Code…');
  });

  it('shows restart only when the Claude Code process has exited', () => {
    mockByChat = {
      'project/worktree/chat': {
        launchStatus: 'idle',
        turnState: 'exited',
        terminalId: 'terminal-1',
      },
    };

    const html = renderToStaticMarkup(
      <ClaudeCodeTerminalExperience
        projectId="project"
        worktreeId="worktree"
        chatId="chat"
      />,
    );

    expect(html).toContain('Claude Code exited.');
    expect(html).toContain('Restart Claude Code');
  });
});
