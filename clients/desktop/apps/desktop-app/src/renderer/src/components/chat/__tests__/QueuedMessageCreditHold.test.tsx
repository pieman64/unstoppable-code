/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { QueuedMessageBubble } from '../QueuedMessageBubble';
import { QueuedMessageCompactRow } from '../QueuedMessageCompactRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Seeded host-mirror rows: desktop has no credit-held Try it flow of its own,
// so these cover the shared presentation each desktop adapter forwards.
function hostRow(held: boolean): QueuedChatMessage {
  return {
    hostQueueEntryId: 'entry-1',
    text: 'try it prompt',
    turnPhase: 'idle',
    ...(held ? { retryBlockedReason: 'insufficient_credits' as const } : {}),
  };
}

describe('desktop queued-row credit hold', () => {
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
    act(() => root.unmount());
    container.remove();
  });

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  function button(testId: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  it('forwards the hold from the wrapper bubble and retries once it lifts', () => {
    const onRetry = jest.fn();
    const onForce = jest.fn();
    const bubble = (held: boolean): JSX.Element => (
      <QueuedMessageBubble
        index={0}
        message={hostRow(held)}
        onClear={jest.fn()}
        onRetry={onRetry}
        onForce={onForce}
        turnPhase="idle"
        canForce
      />
    );
    render(bubble(true));

    expect(button('queued-message-retry')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(button('queued-message-interrupt')).toBeNull();
    act(() => button('queued-message-retry')?.click());
    expect(onRetry).not.toHaveBeenCalled();

    render(bubble(false));
    act(() => button('queued-message-retry')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(0);
    expect(onForce).not.toHaveBeenCalled();
  });

  it('explains a hold only on the head row of the wrapper bubble', () => {
    render(
      <QueuedMessageBubble
        index={1}
        message={hostRow(true)}
        onClear={jest.fn()}
        onRetry={jest.fn()}
        turnPhase="idle"
      />,
    );

    expect(button('queued-message-retry')).toBeNull();
  });

  it('keeps the compact Retry disabled until the hold lifts', () => {
    const onForce = jest.fn();
    const onClear = jest.fn();
    const row = (held: boolean): JSX.Element => (
      <QueuedMessageCompactRow
        message={hostRow(held)}
        index={0}
        onClear={onClear}
        onForce={onForce}
        onSteer={jest.fn()}
        canForce
      />
    );
    render(row(true));

    const send = button('queued-message-interrupt');
    expect(send?.textContent).toBe('Retry');
    expect(send?.getAttribute('aria-disabled')).toBe('true');
    expect(button('queued-message-steer')).toBeNull();
    act(() => send?.click());
    expect(onForce).not.toHaveBeenCalled();

    render(row(false));
    expect(
      button('queued-message-interrupt')?.hasAttribute('aria-disabled'),
    ).toBe(false);
    act(() => button('queued-message-interrupt')?.click());
    expect(onForce).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });
});
