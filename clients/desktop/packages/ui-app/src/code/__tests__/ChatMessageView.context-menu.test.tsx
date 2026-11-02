/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import { withSubagentReference } from '@canopy/ui-shared';
import { ChatMessageView } from '../ChatMessageView';

function message(
  partial: Partial<PortalChatMessage> & Pick<PortalChatMessage, 'role'>,
): PortalChatMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    status: 'complete',
    text: '',
    createdAtMs: 0,
    ...partial,
  };
}

const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

beforeEach(() => {
  writeText.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
});

function render(msg: PortalChatMessage): HTMLElement {
  act(() => root.render(<ChatMessageView message={msg} />));
  const row = container.querySelector('[data-testid="chat-message"]');
  if (!(row instanceof HTMLElement)) throw new Error('missing message row');
  return row;
}

function openMenu(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
  });
}

async function choose(testId: string): Promise<void> {
  const item = document.querySelector(`[data-testid="${testId}"]`);
  if (!(item instanceof HTMLButtonElement)) throw new Error(`no ${testId}`);
  expect(item.disabled).toBe(false);
  act(() => item.click());
  await act(async () => {
    await Promise.resolve();
  });
}

function menuLabels(): Array<string | null> {
  return Array.from(
    document.querySelectorAll(
      '[data-testid="chat-message-context-menu"] [role="menuitem"]',
    ),
  ).map((item) => item.textContent);
}

/** Selects `node`'s rendered text and returns what the menu should copy. */
function select(node: Node | null): string {
  if (!node) throw new Error('missing selection target');
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection?.toString() ?? '';
}

/** Without a selection the menu holds one disabled Copy selection (CAN-4870). */
async function expectOnlyDisabledSelectionCopy(): Promise<void> {
  expect(menuLabels()).toEqual(['Copy selection']);
  const item = document.querySelector(
    '[data-testid="chat-message-copy-selection"]',
  );
  if (!(item instanceof HTMLButtonElement)) throw new Error('no item');
  expect(item.disabled).toBe(true);
  act(() => item.click());
  await act(async () => {
    await Promise.resolve();
  });
  expect(writeText).not.toHaveBeenCalled();
}

function queryMenu(): Element | null {
  return document.querySelector('[data-testid="chat-message-context-menu"]');
}

describe('ChatMessageView message context menu (CAN-4277)', () => {
  it('renders no menu markup while closed', () => {
    const html = renderToString(
      <ChatMessageView message={message({ role: 'assistant', text: 'Hi' })} />,
    );
    expect(html).not.toContain('chat-message-context-menu');
  });

  it('copies only the selection inside the presented user body', async () => {
    const text = withSubagentReference(
      { kind: 'managed', id: 'child-1', title: 'Review source' },
      'Please **check** this.',
    );
    const row = render(message({ role: 'user', text }));
    openMenu(row.querySelector('p') ?? row);
    expect(queryMenu()).not.toBeNull();
    await expectOnlyDisabledSelectionCopy();

    const expected = select(row.querySelector('strong'));
    expect(expected).toBe('check');
    openMenu(row.querySelector('p') ?? row);
    await choose('chat-message-copy-selection');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(expected);
  });

  it('copies only the selection inside assistant text', async () => {
    const row = render(
      message({
        role: 'assistant',
        text: 'Done:\n\n1. **Built** it',
        parts: [
          {
            kind: 'tool_use',
            data: { toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
          },
        ],
      }),
    );
    openMenu(row);
    await expectOnlyDisabledSelectionCopy();

    const expected = select(row.querySelector('li'));
    expect(expected).toBe('Built it');
    openMenu(row);
    await choose('chat-message-copy-selection');
    expect(writeText).toHaveBeenLastCalledWith(expected);
  });

  it('reuses the user copy badge tab stop for the keyboard menu', () => {
    const row = render(message({ role: 'user', text: 'Keyboard message' }));
    expect(row.tabIndex).toBe(-1);
    const badge = row.querySelector('[aria-label="Copy your message"]');
    if (!(badge instanceof HTMLButtonElement))
      throw new Error('missing copy badge');
    expect(badge.tabIndex).toBe(0);
    act(() => {
      badge.focus();
      badge.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(queryMenu()).not.toBeNull();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(badge);
  });

  it('makes an assistant message without controls reachable by Tab', () => {
    const row = render(
      message({ role: 'assistant', text: 'Keyboard message' }),
    );
    expect(row.tabIndex).toBe(0);
  });

  it('copies the selected proxy-error summary as shown', async () => {
    // The visible summary is a notice; a selection copies what is shown, not
    // the underlying text.
    const proxyFailureText = `unexpected status 502 Bad Gateway: ${JSON.stringify(
      {
        error: {
          canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
          code: 'upstream_unavailable',
          correlation_id: 'corr-live-1',
          message: 'AI Credits proxy could not reach the gateway.',
        },
      },
    )}`;
    const row = render(
      message({ role: 'system', status: 'failed', text: proxyFailureText }),
    );
    expect(
      row.querySelector('[data-testid="portal-chat-canopy-proxy-error"]'),
    ).not.toBeNull();
    const summary = row.querySelector(
      '[data-testid="portal-chat-canopy-proxy-error"]',
    );
    const expected = select(summary);
    expect(expected).not.toBe('');
    expect(expected).not.toBe(proxyFailureText);
    openMenu(summary ?? row);
    await choose('chat-message-copy-selection');
    expect(writeText).toHaveBeenLastCalledWith(expected);
  });

  it('opens on a message with no text with only a disabled selection copy', async () => {
    const row = render(
      message({
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            data: { toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
          },
        ],
      }),
    );
    // No message text: no Tab stop, but the menu still opens for a selection.
    expect(row.hasAttribute('tabindex')).toBe(false);
    openMenu(row);
    expect(queryMenu()).not.toBeNull();
    await expectOnlyDisabledSelectionCopy();
  });

  it('offers Copy link and no open actions on a message link (CAN-2632)', async () => {
    const url = 'https://example.com/docs?x=1#frag';
    const row = render(
      message({ role: 'assistant', text: `Read [the docs](${url}).` }),
    );
    const anchor = row.querySelector(`a[href="${url}"]`);
    if (!anchor) throw new Error('missing link');
    openMenu(anchor);
    expect(menuLabels()).toEqual(['Copy link', 'Copy selection']);
    await choose('chat-message-copy-link');
    expect(writeText).toHaveBeenLastCalledWith(url);
  });
});
