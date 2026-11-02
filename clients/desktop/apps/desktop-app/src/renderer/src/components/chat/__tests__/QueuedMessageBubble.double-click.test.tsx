/**
 * @jest-environment jsdom
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { QueuedMessageBubble } from '../QueuedMessageBubble';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('QueuedMessageBubble double-click to edit', () => {
  let container: HTMLDivElement;
  let root: Root;
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(
    props: Partial<ComponentProps<typeof QueuedMessageBubble>> & {
      message: QueuedChatMessage;
    },
  ): void {
    act(() => {
      root.render(
        <QueuedMessageBubble index={2} onClear={jest.fn()} {...props} />,
      );
    });
  }

  function doubleClickText(): void {
    const paragraph = container.querySelector('p');
    if (!paragraph) throw new Error('Expected queued message text');
    act(() => {
      const init = { bubbles: true, cancelable: true, button: 0 };
      paragraph.dispatchEvent(
        new MouseEvent('mousedown', { ...init, detail: 1 }),
      );
      paragraph.dispatchEvent(
        new MouseEvent('mousedown', { ...init, detail: 2 }),
      );
      paragraph.dispatchEvent(
        new MouseEvent('dblclick', { ...init, detail: 2 }),
      );
    });
  }

  it('opens the editor with the activated message identity', () => {
    const onEdit = jest.fn();
    const message: QueuedChatMessage = {
      text: 'queued text',
      hostQueueEntryId: 'host-1',
    };
    render({ message, onEdit });

    doubleClickText();

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(2, message);
  });

  it('opens the editor from inside the setup quote', () => {
    const onEdit = jest.fn();
    const message: QueuedChatMessage = { text: 'queued text' };
    render({
      message,
      onEdit,
      setupWait: { projectName: 'canopy', startedAtMs: 0 },
      clockNowMs: 1_000,
    });
    const quote = container.querySelector(
      '[data-testid="queued-message-setup-quote"]',
    );
    expect(quote?.contains(container.querySelector('p'))).toBe(true);

    doubleClickText();

    expect(onEdit).toHaveBeenCalledWith(2, message);
  });

  it.each([
    ['is still sending', { pendingSend: true }, false],
    ['belongs to a hook queue', { queuedHookQueueId: 'hook-1' }, false],
    ['waits while another message is edited', {}, true],
  ] as const)(
    'does not edit a message that %s',
    (_label, overrides, anyEditing) => {
      const onEdit = jest.fn();
      render({
        message: { text: 'queued text', ...overrides },
        onEdit,
        anyEditing,
      });

      doubleClickText();

      expect(onEdit).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="queued-message-edit"]'),
      ).toBeNull();
    },
  );

  it('routes a scheduled message to its automation editor', () => {
    const onEdit = jest.fn();
    const scheduledEdit = jest.fn();
    render({
      message: { text: 'later', scheduledSendDraft: { runAt: '2030-01-01' } },
      onEdit,
      scheduled: {
        automationId: 'a1',
        activityName: 'Later',
        scheduledAt: '2030-01-01T18:00:00.000Z',
        onEdit: scheduledEdit,
        onClear: jest.fn(),
        onInterrupt: jest.fn(),
      },
    });

    doubleClickText();

    expect(scheduledEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
