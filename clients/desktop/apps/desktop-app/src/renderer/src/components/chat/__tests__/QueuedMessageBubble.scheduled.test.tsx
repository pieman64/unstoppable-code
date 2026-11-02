/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatScheduledSendLabel } from '@/lib/worktreeSessionPromptAutomations';
import type {
  ChatTurnPhase,
  QueuedMessageWaitingReason,
} from '@canopy/desktop-shared/types';
import {
  QUEUED_MESSAGE_WAITING_REASON_COPY,
  type QueuedMessageSetupWait,
} from '@canopy/ui-shared';
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

  function setupQuote(): Element | null {
    return container.querySelector(
      '[data-testid="queued-message-setup-quote"]',
    );
  }

  function renderQueueRow(
    options: {
      text?: string;
      waitingReason?: QueuedMessageWaitingReason;
      reason?: string;
      setupWait?: QueuedMessageSetupWait;
      clockNowMs?: number;
      scheduled?: ScheduledMessageBubbleDescriptor;
    } = {},
  ): void {
    const message = {
      text: options.text ?? 'queued',
      hostQueueEntryId: 'entry-1',
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.waitingReason !== undefined
        ? { waitingReason: options.waitingReason }
        : {}),
    };

    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={message}
          onClear={jest.fn()}
          setupWait={options.setupWait}
          clockNowMs={options.clockNowMs}
          scheduled={options.scheduled}
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

  it('renders a message reason and omits the reason line when absent', () => {
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'queued', reason: 'Waiting for setup.' }}
          onClear={jest.fn()}
        />,
      );
    });

    let labels = container.querySelectorAll('div.mb-1.text-xs.fg-secondary');
    expect(labels).toHaveLength(2);
    expect(labels.item(0).textContent).toBe('Queued');
    expect(labels.item(1).textContent).toBe('Waiting for setup.');

    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'queued' }}
          onClear={jest.fn()}
        />,
      );
    });

    labels = container.querySelectorAll('div.mb-1.text-xs.fg-secondary');
    expect(labels).toHaveLength(1);
    expect(labels.item(0).textContent).toBe('Queued');
  });

  it('shows the host waiting reason on an ordinary queued row', () => {
    renderQueueRow({ waitingReason: 'steer_unavailable' });

    const reason = container.querySelector(
      '[data-testid="queued-message-waiting-reason"]',
    );
    expect(reason?.getAttribute('data-waiting-reason')).toBe(
      'steer_unavailable',
    );
    expect(reason?.textContent).toBe('Sends as soon as the agent can take it.');
  });

  it('offers Run now for a row held by background work', () => {
    const onRunNow = jest.fn();
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{
            text: 'held prompt',
            hostQueueEntryId: 'entry-1',
            waitingReason: 'background_work',
          }}
          onClear={jest.fn()}
          onForce={jest.fn()}
          onRunNow={onRunNow}
          canForce
          turnPhase="idle"
        />,
      );
    });

    const reason = container.querySelector(
      '[data-testid="queued-message-waiting-reason"]',
    );
    expect(reason?.getAttribute('data-waiting-reason')).toBe('background_work');
    expect(reason?.textContent).toBe(
      QUEUED_MESSAGE_WAITING_REASON_COPY.background_work,
    );
    expect(
      container.querySelector('[data-testid="queued-message-run-now"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-retry"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-run-now"]')
        ?.click();
    });
    expect(onRunNow).toHaveBeenCalledWith(0);
  });

  it('omits the host waiting reason when the row does not provide one', () => {
    renderQueueRow();

    expect(
      container.querySelector('[data-testid="queued-message-waiting-reason"]'),
    ).toBeNull();
  });

  it('prefers free text over the host waiting reason', () => {
    renderQueueRow({
      reason: 'Waiting for a specific setup step.',
      waitingReason: 'steer_unavailable',
    });

    const labels = container.querySelectorAll('div.mb-1.text-xs.fg-secondary');
    expect(labels.item(1).textContent).toBe(
      'Waiting for a specific setup step.',
    );
    expect(
      container.querySelector('[data-testid="queued-message-waiting-reason"]'),
    ).toBeNull();
  });

  it('prefers the setup reason over the host waiting reason', () => {
    renderQueueRow({
      waitingReason: 'steer_unavailable',
      setupWait: { projectName: 'canopy', startedAtMs: 1_000 },
      clockNowMs: 13_000,
    });

    const setup = container.querySelector(
      '[data-testid="queued-message-setup-reason"]',
    );
    expect(setup?.textContent).toContain(
      "Setting up this chat's copy of canopy.",
    );
    expect(setup?.textContent).toContain('0:12 elapsed');
    expect(setup?.textContent).toContain(
      "Your message will send automatically when it's ready.",
    );
    expect(
      container.querySelector('[data-testid="queued-message-waiting-reason"]'),
    ).toBeNull();
  });

  it('prefers free text over the setup reason', () => {
    renderQueueRow({
      reason: 'Waiting for active chat sessions to finish.',
      setupWait: { startedAtMs: 1_000 },
      clockNowMs: 2_000,
    });

    expect(
      container.querySelector('[data-testid="queued-message-setup-reason"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      'Waiting for active chat sessions to finish.',
    );
  });

  it('shows the scheduled state instead of a setup reason', () => {
    renderQueueRow({
      setupWait: { startedAtMs: 1_000 },
      clockNowMs: 2_000,
      scheduled: {
        automationId: 'automation-1',
        activityName: 'Nightly',
        scheduledAt: new Date(60_000).toISOString(),
        onEdit: jest.fn(),
        onClear: jest.fn(),
        onInterrupt: jest.fn(),
      },
    });

    expect(
      container.querySelector('[data-testid="queued-message-setup-reason"]'),
    ).toBeNull();
    expect(setupQuote()).toBeNull();
    expect(
      container.querySelector('[data-testid="scheduled-message-send-label"]')
        ?.className,
    ).toContain('text-xs');
  });

  it('quotes the message body while it waits for setup', () => {
    renderQueueRow({
      text: 'First paragraph\n\nSecond paragraph',
      setupWait: { projectName: 'canopy', startedAtMs: 1_000 },
      clockNowMs: 2_000,
    });

    const quote = setupQuote();
    expect(quote).not.toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-setup-reason"]')
        ?.nextElementSibling,
    ).toBe(quote);
    expect(quote?.querySelector('.break-words')).not.toBeNull();
    const paragraphs = Array.from(container.querySelectorAll('p'));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      'First paragraph',
      'Second paragraph',
    ]);
    expect(paragraphs.every((p) => quote?.contains(p))).toBe(true);
  });

  it('quotes the body only when the setup reason renders', () => {
    renderQueueRow({
      reason: 'Held.',
      setupWait: { startedAtMs: 1_000 },
      clockNowMs: 2_000,
    });
    expect(setupQuote()).toBeNull();

    renderQueueRow({ waitingReason: 'steer_unavailable' });
    expect(setupQuote()).toBeNull();

    renderQueueRow({
      waitingReason: 'steer_unavailable',
      setupWait: { startedAtMs: 1_000 },
      clockNowMs: 2_000,
    });
    const hasReason =
      container.querySelector('[data-testid="queued-message-setup-reason"]') !==
      null;
    expect(setupQuote() !== null).toBe(hasReason);

    renderQueueRow();
    expect(setupQuote()).toBeNull();
    expect(container.querySelector('.break-words')).not.toBeNull();
  });

  it('hides the host waiting reason on a scheduled row', () => {
    renderQueueRow({
      waitingReason: 'steer_unavailable',
      scheduled: descriptor(
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ),
    });

    expect(
      container.querySelector('[data-testid="queued-message-waiting-reason"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="scheduled-message-send-label"]'),
    ).not.toBeNull();
  });
});

describe('QueuedMessageBubble queue actions by turn phase', () => {
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

  function present(testId: string): boolean {
    return container.querySelector(`[data-testid="${testId}"]`) !== null;
  }

  function renderHostRow(
    turnPhase: ChatTurnPhase | undefined,
    extra: { anyEditing?: boolean } = {},
  ): void {
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'queued', hostQueueEntryId: 'entry-1' }}
          onClear={jest.fn()}
          onForce={jest.fn()}
          onSteer={jest.fn()}
          steeringSupported
          canForce
          turnPhase={turnPhase}
          {...extra}
        />,
      );
    });
  }

  it.each([undefined, 'foreground'] as const)(
    'offers Steer and Interrupt on a host row when the phase is %s',
    (turnPhase) => {
      renderHostRow(turnPhase);
      expect(present('queued-message-steer')).toBe(true);
      expect(present('queued-message-interrupt')).toBe(true);
    },
  );

  it.each(['idle', 'background'] as const)(
    'drops the Steer and Interrupt row when the chat is %s',
    (turnPhase) => {
      renderHostRow(turnPhase);
      expect(present('queued-message-steer')).toBe(false);
      expect(present('queued-message-interrupt')).toBe(false);
      expect(container.querySelector('.flex-wrap.justify-end')).toBeNull();
    },
  );

  it('keeps the editing spacer only where the phase offers Steer', () => {
    renderHostRow('foreground', { anyEditing: true });
    expect(container.querySelector('.flex-wrap.justify-end')).not.toBeNull();
    renderHostRow('background', { anyEditing: true });
    expect(container.querySelector('.flex-wrap.justify-end')).toBeNull();
  });

  it('routes Retry and Run now on the head row in any phase', () => {
    const onRetry = jest.fn();
    const onRunNow = jest.fn();
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'kept after a failed launch' }}
          onClear={jest.fn()}
          onRetry={onRetry}
          onRunNow={onRunNow}
          canForce
          turnPhase="idle"
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-retry"]')
        ?.click();
      container
        .querySelector<HTMLElement>('[data-testid="queued-message-run-now"]')
        ?.click();
    });
    expect(onRetry).toHaveBeenCalledWith(0);
    expect(onRunNow).toHaveBeenCalledWith(0);
  });

  it('withholds Retry and Run now from rows behind the head', () => {
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={1}
          message={{ text: 'second' }}
          onClear={jest.fn()}
          onRetry={jest.fn()}
          onRunNow={jest.fn()}
        />,
      );
    });
    expect(present('queued-message-retry')).toBe(false);
    expect(present('queued-message-run-now')).toBe(false);
  });

  it('keeps the scheduled run-now Interrupt whatever the phase', () => {
    act(() => {
      root.render(
        <QueuedMessageBubble
          index={0}
          message={{ text: 'later' }}
          onClear={jest.fn()}
          turnPhase="idle"
          scheduled={{
            automationId: 'a1',
            activityName: 'Later',
            scheduledAt: new Date(Date.now() + 60_000).toISOString(),
            onEdit: jest.fn(),
            onClear: jest.fn(),
            onInterrupt: jest.fn(),
          }}
        />,
      );
    });
    expect(present('queued-message-interrupt')).toBe(true);
    expect(present('queued-message-retry')).toBe(false);
    expect(present('queued-message-run-now')).toBe(false);
  });
});
