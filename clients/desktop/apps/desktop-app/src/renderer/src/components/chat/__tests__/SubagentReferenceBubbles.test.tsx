/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DisplayMessage } from '../types';
import { QueuedMessageBubble } from '../QueuedMessageBubble';
import { UserBubble } from '../UserBubble';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ATTACHED_REFERENCE_TEXT =
  'About Port handlers [canopy-subagent:managed:delegation-1]\n\nReview the port handlers.';
const MESSAGE_BODY = 'Review the port handlers.';

function userMessage(text: string): DisplayMessage {
  return {
    id: 'user-1',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

describe('desktop subagent reference attachments', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clipboardWrites: string[];
  let originalClipboard: PropertyDescriptor | undefined;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    globalThis.ResizeObserver = ResizeObserverStub;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    clipboardWrites = [];
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('shows a chip above a sent bubble and renders and copies only the body', async () => {
    act(() =>
      root.render(
        <UserBubble message={userMessage(ATTACHED_REFERENCE_TEXT)} />,
      ),
    );

    expect(
      container.querySelector('[data-testid="subagent-reference-chip"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('canopy-subagent:');
    expect(
      container.querySelector('[data-chat-message-id] .prose p')?.textContent,
    ).toBe(MESSAGE_BODY);

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy to clipboard"]',
    );
    if (!copyButton) throw new Error('Missing sent message copy action');
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboardWrites).toEqual([MESSAGE_BODY]);
  });

  it('shows a chip above a queued bubble and renders and copies only the body', async () => {
    act(() =>
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: ATTACHED_REFERENCE_TEXT }}
          onClear={(): void => undefined}
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="subagent-reference-chip"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('canopy-subagent:');
    expect(container.textContent).toContain(MESSAGE_BODY);
    expect(container.textContent).not.toContain(
      'About Port handlers [canopy-subagent:',
    );

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy to clipboard"]',
    );
    if (!copyButton) throw new Error('Missing queued message copy action');
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboardWrites).toEqual([MESSAGE_BODY]);
  });

  it('leaves ordinary sent and queued messages without a chip', () => {
    act(() =>
      root.render(
        <>
          <UserBubble message={userMessage('Ordinary prompt.')} />
          <QueuedMessageBubble
            index={0}
            message={{ text: 'Ordinary queued prompt.' }}
            onClear={(): void => undefined}
          />
        </>,
      ),
    );

    expect(
      container.querySelector('[data-testid="subagent-reference-chip"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-chat-message-id] .prose p')?.textContent,
    ).toBe('Ordinary prompt.');
    expect(container.textContent).toContain('Ordinary queued prompt.');
  });
});
