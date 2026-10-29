/**
 * @jest-environment jsdom
 *
 * CAN-2309 — the Escape-to-cancel shortcut listens in the active chat panel's
 * owning document and ignores targets outside that panel. A mounted but
 * inactive Claude-terminal chat therefore must not arm or fire, and terminal
 * input inside the active panel remains excluded.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClaudeCodeTerminalExperience } from '@/components/chat/ClaudeCodeTerminalExperience';
import { CANCEL_SHORTCUT_CONFIRM_WINDOW_MS } from '@/components/chat/useCancelRunningChatShortcut';
import { requestTerminalFocus } from '@/lib/terminal-focus-intent';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnsureClaudeTerminal = jest.fn(() => Promise.resolve(undefined));
const markUserInterrupted = jest.fn();
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
  useClaudeTerminalStore: Object.assign(
    (selector: (state: unknown) => unknown): unknown =>
      selector({ byChat: mockByChat }),
    { getState: (): unknown => ({ markUserInterrupted }) },
  ),
}));

jest.mock('@/lib/terminal-focus-intent', () => ({
  requestTerminalFocus: jest.fn(),
}));

jest.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: ({ focused }: { focused?: boolean }): React.ReactElement => (
    <div data-testid="terminal-pane" data-focused={String(focused)} />
  ),
}));

function dispatchEscape(target: EventTarget = document): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('ClaudeCodeTerminalExperience cancel shortcut scoping', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let write: jest.Mock;
  let interrupt: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockEnsureClaudeTerminal.mockClear();
    markUserInterrupted.mockClear();
    jest.mocked(requestTerminalFocus).mockClear();
    write = jest.fn().mockResolvedValue(undefined);
    interrupt = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: { write },
        claudeTerminal: { interrupt },
      },
    });
    mockByChat = {
      'project/worktree/chat': {
        terminalId: 'terminal-1',
        turnState: 'running',
        launchStatus: 'ready',
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    jest.useRealTimers();
  });

  function render(isActivePanel: boolean): void {
    act(() => {
      root ??= createRoot(container);
      root.render(
        <ClaudeCodeTerminalExperience
          projectId="project"
          worktreeId="worktree"
          chatId="chat"
          isActivePanel={isActivePanel}
        />,
      );
    });
  }

  it('interrupts the running agent on Esc-Esc when it is the active panel', () => {
    render(true);
    const experienceRoot = container.firstElementChild;
    if (experienceRoot === null) {
      throw new Error('Expected the Claude terminal experience root');
    }

    dispatchEscape(experienceRoot);
    act(() => {
      jest.advanceTimersByTime(CANCEL_SHORTCUT_CONFIRM_WINDOW_MS - 1);
    });
    dispatchEscape(experienceRoot);

    expect(write).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      data: '\x03',
    });
    expect(markUserInterrupted).toHaveBeenCalledTimes(1);
  });

  it('never interrupts from Escape while it is not the active panel', () => {
    render(false);

    dispatchEscape();
    dispatchEscape();
    dispatchEscape();

    expect(write).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(markUserInterrupted).not.toHaveBeenCalled();
  });

  it('never interrupts from Escape pressed inside a terminal pane', () => {
    render(true);
    const experienceRoot = container.firstElementChild;
    if (experienceRoot === null) {
      throw new Error('Expected the Claude terminal experience root');
    }
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    experienceRoot.appendChild(xterm);

    dispatchEscape(xterm);
    dispatchEscape(xterm);

    expect(write).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(markUserInterrupted).not.toHaveBeenCalled();
    xterm.remove();
  });

  it('leaves the pane ineligible for the caret while it is not the active panel', () => {
    render(false);

    expect(
      container
        .querySelector('[data-testid="terminal-pane"]')
        ?.getAttribute('data-focused'),
    ).toBe('false');
  });

  it('does not claim focus when remounted during an existing launch', () => {
    mockByChat = {
      'project/worktree/chat': {
        turnState: 'starting',
        launchStatus: 'starting',
      },
    };
    render(true);

    mockByChat = {
      'project/worktree/chat': {
        terminalId: 'terminal-1',
        turnState: 'idle',
        launchStatus: 'ready',
        firstOutputAt: 1,
      },
    };
    render(true);

    expect(requestTerminalFocus).not.toHaveBeenCalled();
  });

  // Restart is an explicit gesture, but it does NOT remount this component —
  // it only bumps `launchAttempt`. The one-shot launch entitlement is armed
  // at first mount only, so without its own intent record the user clicks
  // Restart and the caret stays wherever it was.
  it('claims the caret for a restarted terminal', () => {
    mockByChat = {
      'project/worktree/chat': {
        terminalId: 'terminal-1',
        turnState: 'exited',
        launchStatus: 'ready',
      },
    };
    render(true);
    expect(requestTerminalFocus).not.toHaveBeenCalled();

    const restart = container.querySelector('button');
    if (restart === null) throw new Error('Expected the Restart action');
    act(() => {
      restart.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Relaunch begins: no terminal id yet.
    mockByChat = {
      'project/worktree/chat': {
        turnState: 'starting',
        launchStatus: 'starting',
      },
    };
    render(true);
    expect(requestTerminalFocus).not.toHaveBeenCalled();

    // Restarted terminal comes up.
    mockByChat = {
      'project/worktree/chat': {
        terminalId: 'terminal-2',
        turnState: 'idle',
        launchStatus: 'ready',
      },
    };
    render(true);

    expect(requestTerminalFocus).toHaveBeenCalledTimes(1);
    expect(jest.mocked(requestTerminalFocus).mock.calls[0]?.[0]).toBe(
      'terminal-2',
    );
  });

  // The launch is asynchronous, so the terminal id routinely lands while the
  // user has switched away. The claim has to survive that, or opening Claude
  // Code and glancing at another task silently loses focus-on-launch forever.
  it('keeps a launch claim pending until the panel becomes active again', () => {
    mockByChat = {
      'project/worktree/chat': { turnState: 'idle', launchStatus: 'ready' },
    };
    render(true);

    // Terminal id arrives while this panel is NOT the active one.
    mockByChat = {
      'project/worktree/chat': {
        terminalId: 'terminal-1',
        turnState: 'idle',
        launchStatus: 'ready',
      },
    };
    render(false);
    expect(requestTerminalFocus).not.toHaveBeenCalled();

    render(true);

    expect(requestTerminalFocus).toHaveBeenCalledTimes(1);
    expect(jest.mocked(requestTerminalFocus).mock.calls[0]?.[0]).toBe(
      'terminal-1',
    );
  });
});
