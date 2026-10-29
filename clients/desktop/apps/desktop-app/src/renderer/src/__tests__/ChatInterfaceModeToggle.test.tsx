/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS,
  ChatInterfaceModeToggle,
  type ChatInterfaceModeToggleProps,
} from '@/components/chat/ChatInterfaceModeToggle';

let mockClaudeTuiChatsEnabled = true;

jest.mock('@/lib/claude-tui-chats', () => ({
  useClaudeTuiChatsEnabled: (): boolean => mockClaudeTuiChatsEnabled,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mergeProps(
  props: Partial<ChatInterfaceModeToggleProps>,
): ChatInterfaceModeToggleProps {
  return {
    mode: 'canopy',
    onChange: (): void => {},
    providerIsClaude: true,
    canopyNativeBusy: false,
    ...props,
  };
}

function render(
  props: Partial<ChatInterfaceModeToggleProps> = {},
): string | null {
  const out = ChatInterfaceModeToggle(mergeProps(props));
  if (out === null) return null;
  return renderToStaticMarkup(out);
}

/**
 * Mount the toggle, hover one option, and return the rich tooltip text. Hover
 * help comes from the shared `Tooltip` (never a native `title`, CAN-2799), so
 * it is only in the DOM while the option is hovered/focused. The hover path
 * is used because a disabled option is not focusable.
 */
function tooltipTextFor(
  props: Partial<ChatInterfaceModeToggleProps>,
  testId: string,
): string | null {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ChatInterfaceModeToggle {...mergeProps(props)} />);
  });
  const button = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  act(() => {
    button?.parentElement?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
  });
  const text =
    document.body.querySelector('[role="tooltip"]')?.textContent ?? null;
  act(() => {
    root.unmount();
  });
  host.remove();
  return text;
}

/**
 * Pull a single `<button …>` tag from the rendered markup so individual
 * attribute assertions don't need to depend on attribute order or stringy
 * regexes against the whole tree.
 */
function extractButton(html: string, testId: string): string {
  const tagRegex = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`);
  const match = tagRegex.exec(html);
  if (!match) {
    throw new Error(`could not find <button data-testid="${testId}">`);
  }
  return match[0];
}

describe('ChatInterfaceModeToggle', () => {
  beforeEach(() => {
    mockClaudeTuiChatsEnabled = true;
  });

  it('is hidden for non-Claude chats', () => {
    expect(render({ providerIsClaude: false })).toBeNull();
  });

  it('is hidden when Claude Code chat modes are disabled', () => {
    mockClaudeTuiChatsEnabled = false;

    expect(render({ providerIsClaude: true })).toBeNull();
  });

  it('renders all three options for Claude chats', () => {
    const html = render({ mode: 'canopy' });
    expect(html).toContain('chat-interface-mode-toggle-canopy');
    expect(html).toContain('chat-interface-mode-toggle-auto');
    expect(html).toContain('chat-interface-mode-toggle-claude-code');
    // Idle-state tooltips surface the mode name on hover even though the
    // buttons themselves render icons rather than text labels. They are rich
    // tooltips, so no option carries a native `title`.
    for (const testId of [
      'chat-interface-mode-toggle-canopy',
      'chat-interface-mode-toggle-auto',
      'chat-interface-mode-toggle-claude-code',
    ]) {
      expect(extractButton(html, testId)).not.toContain('title=');
    }
    expect(
      tooltipTextFor({ mode: 'canopy' }, 'chat-interface-mode-toggle-canopy'),
    ).toBe(CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.canopy);
    expect(
      tooltipTextFor({ mode: 'canopy' }, 'chat-interface-mode-toggle-auto'),
    ).toBe(CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.auto);
    expect(
      tooltipTextFor(
        { mode: 'canopy' },
        'chat-interface-mode-toggle-claude-code',
      ),
    ).toBe(CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.claudeCode);
  });

  it('disables the toggle while Canopy-native turn is busy and shows the documented tooltip', () => {
    const html = render({
      mode: 'canopy',
      canopyNativeBusy: true,
    });
    const canopyButton = extractButton(
      html,
      'chat-interface-mode-toggle-canopy',
    );
    expect(canopyButton).toContain('disabled');
    expect(canopyButton).toContain('aria-disabled="true"');
    const claudeCodeButton = extractButton(
      html,
      'chat-interface-mode-toggle-claude-code',
    );
    expect(claudeCodeButton).toContain('disabled');
    expect(claudeCodeButton).toContain('aria-disabled="true"');
    const busy = { mode: 'canopy', canopyNativeBusy: true } as const;
    expect(tooltipTextFor(busy, 'chat-interface-mode-toggle-canopy')).toBe(
      CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.canopyBusy,
    );
    expect(tooltipTextFor(busy, 'chat-interface-mode-toggle-claude-code')).toBe(
      CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.canopyBusy,
    );
  });

  it('disables "Canopy" while Claude Code terminal turn is running and shows the documented tooltip', () => {
    const html = render({
      mode: 'claude-code',
      claudeTerminalTurnState: 'running',
    });
    const button = extractButton(html, 'chat-interface-mode-toggle-canopy');
    expect(button).toContain('disabled');
    expect(button).toContain('aria-disabled="true"');
    expect(
      tooltipTextFor(
        { mode: 'claude-code', claudeTerminalTurnState: 'running' },
        'chat-interface-mode-toggle-canopy',
      ),
    ).toBe(CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.terminalBusy);
  });

  it('disables "Canopy" while Claude Code terminal is starting or cleaning up', () => {
    for (const turnState of ['starting', 'cleaning_up'] as const) {
      const html = render({
        mode: 'claude-code',
        claudeTerminalTurnState: turnState,
      });
      const button = extractButton(html, 'chat-interface-mode-toggle-canopy');
      expect(button).toContain('disabled');
      expect(button).toContain('aria-disabled="true"');
    }
  });

  it('lets the caller lock "Canopy" for an error state that still owns a terminal', () => {
    const html = render({
      mode: 'claude-code',
      claudeTerminalTurnState: 'error',
      claudeTerminalBusy: true,
    });
    const button = extractButton(html, 'chat-interface-mode-toggle-canopy');
    expect(button).toContain('disabled');
    expect(
      tooltipTextFor(
        {
          mode: 'claude-code',
          claudeTerminalTurnState: 'error',
          claudeTerminalBusy: true,
        },
        'chat-interface-mode-toggle-canopy',
      ),
    ).toBe(CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS.terminalBusy);
  });

  it('aria-pressed mirrors the active mode', () => {
    const canopyActive = render({ mode: 'canopy' });
    const canopyButton = extractButton(
      canopyActive ?? '',
      'chat-interface-mode-toggle-canopy',
    );
    expect(canopyButton).toContain('aria-pressed="true"');
    expect(canopyButton).not.toContain('transition-');
    expect(canopyActive).toContain('transform:translateX(0px)');
    const claudeActive = render({ mode: 'claude-code' });
    const claudeButton = extractButton(
      claudeActive ?? '',
      'chat-interface-mode-toggle-claude-code',
    );
    expect(claudeButton).toContain('aria-pressed="true"');
    expect(claudeButton).not.toContain('transition-');
    expect(claudeActive).toContain('transform:translateX(56px)');
    const autoActive = render({ mode: 'auto' });
    const autoButton = extractButton(
      autoActive ?? '',
      'chat-interface-mode-toggle-auto',
    );
    expect(autoButton).toContain('aria-pressed="true"');
    expect(autoButton).not.toContain('transition-');
    expect(autoActive).toContain('transform:translateX(28px)');
  });

  it('keeps Auto and Claude Code switchable while the terminal turn runs', () => {
    const html = render({
      mode: 'auto',
      claudeTerminalTurnState: 'running',
    });
    const autoButton = extractButton(html, 'chat-interface-mode-toggle-auto');
    expect(autoButton).not.toContain('aria-disabled="true"');
    const claudeCodeButton = extractButton(
      html,
      'chat-interface-mode-toggle-claude-code',
    );
    expect(claudeCodeButton).not.toContain('aria-disabled="true"');
    // Canopy stays locked until the terminal turn settles.
    const canopyButton = extractButton(
      html,
      'chat-interface-mode-toggle-canopy',
    );
    expect(canopyButton).toContain('aria-disabled="true"');
  });

  it('invokes onChange exactly once with the chosen mode', () => {
    let observed: string | null = null;
    const onChange = (next: string): void => {
      observed = next;
    };
    const element = ChatInterfaceModeToggle({
      mode: 'canopy',
      onChange,
      providerIsClaude: true,
      canopyNativeBusy: false,
    });
    if (element === null) {
      throw new Error('expected toggle to render');
    }
    // Each option is a `<Tooltip>` wrapping its `<button>`. Drill into the
    // element tree to invoke the button's onClick directly so the assertion
    // does not depend on a DOM environment.
    const wrapperChildren = (
      element.props as { children: unknown[] }
    ).children.flat();
    const claudeButton = wrapperChildren
      .map((child): unknown => {
        if (typeof child !== 'object' || child === null) return child;
        return (child as { props?: { children?: unknown } }).props?.children;
      })
      .find((child): boolean => {
        if (typeof child !== 'object' || child === null) return false;
        const props = (child as { props?: { 'data-testid'?: string } }).props;
        return (
          props?.['data-testid'] === 'chat-interface-mode-toggle-claude-code'
        );
      }) as { props: { onClick: (event: unknown) => void } } | undefined;
    if (!claudeButton) {
      throw new Error('expected Claude Code button to be present');
    }
    claudeButton.props.onClick({});
    expect(observed).toBe('claude-code');
  });
});
