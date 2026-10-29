/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatScheduledSendLabel } from '@/lib/worktreeSessionPromptAutomations';
import {
  QueuedMessageBubble,
  type ScheduledMessageBubbleDescriptor,
} from '../QueuedMessageBubble';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('QueuedMessageBubble scheduled variant', () => {
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

  function descriptor(scheduledAt: string): ScheduledMessageBubbleDescriptor {
    return {
      automationId: 'a1',
      activityName: 'Later',
      scheduledAt,
      onEdit: jest.fn(),
      onClear: jest.fn(),
      onInterrupt: jest.fn(),
    };
  }

  function render(
    scheduled: ScheduledMessageBubbleDescriptor | undefined,
  ): void {
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'First paragraph\n\nSecond paragraph' }}
          onClear={jest.fn()}
          scheduled={scheduled}
        />,
      );
    });
  }

  it('shows trusted queued agent attribution in the receiving Advisor context', () => {
    act(() =>
      root.render(
        <QueuedMessageBubble
          index={0}
          onClear={jest.fn()}
          receivingContext={{ kind: 'bot', botId: 'app_advisor' }}
          message={{
            text: 'Visible body',
            agentSent: {
              sender: {
                kind: 'bot',
                botId: 'app_advisor',
                taskId: 'task',
                chatId: 'sender',
              },
              chatTitle: 'Captured sender',
              projectLabel: 'App Advisor',
            },
          }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-sent-title"]')?.textContent,
    ).toBe('Captured sender');
    expect(container.textContent).toContain('Visible body');
    expect(container.textContent).not.toContain('Sent by');
  });

  it('renders one Sends row instead of the old heading and timestamp', () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(descriptor(at));
    const label = container.querySelector(
      '[data-testid="scheduled-message-send-label"]',
    );
    expect(label?.textContent).toBe(`Sends ${formatScheduledSendLabel(at)}`);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Scheduled Message');
    expect(text).not.toContain('Scheduled for');
  });

  it('wraps the scheduled prompt in the collapsible clamp', () => {
    render(descriptor(new Date(Date.now() + 60 * 60 * 1000).toISOString()));
    const content = container.querySelector(
      '[data-testid="user-message-content"]',
    );
    expect(content?.textContent).toContain('First paragraph');
    expect(content?.textContent).toContain('Second paragraph');
  });

  it('falls back to a generic label for an unparseable time', () => {
    render(descriptor('not-a-date'));
    expect(
      container.querySelector('[data-testid="scheduled-message-send-label"]')
        ?.textContent,
    ).toBe('Scheduled');
  });

  it('leaves the ordinary queued bubble unclamped', () => {
    render(undefined);
    expect(
      container.querySelector('[data-testid="user-message-content"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Queued');
  });
});
