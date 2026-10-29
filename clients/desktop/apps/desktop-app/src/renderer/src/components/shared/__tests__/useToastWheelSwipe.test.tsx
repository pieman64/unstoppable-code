/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useToastWheelSwipe } from '../useToastWheelSwipe';

type TestWindow = Window & typeof globalThis;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface ToastWheelHostProps {
  readonly onDismiss: (toastId: string) => void;
  readonly childKey: string;
}

function ToastWheelHost({
  onDismiss,
  childKey,
}: ToastWheelHostProps): JSX.Element {
  const hostRef = useToastWheelSwipe('right', onDismiss);
  return (
    <div ref={hostRef} data-testid="toast-stack-host">
      <div data-testid="toast-stack-card">
        <span key={childKey} data-toast-id="t1">
          Toast
        </span>
      </div>
    </div>
  );
}

describe('useToastWheelSwipe across documents', (): void => {
  let container: HTMLDivElement;
  let root: Root;
  let iframe: HTMLIFrameElement;
  let childDocument: Document = document;
  let childWindow: TestWindow = window;
  let onDismiss: jest.Mock<void, [string]>;

  beforeEach((): void => {
    jest.useFakeTimers();
    container = document.createElement('div');
    iframe = document.createElement('iframe');
    document.body.appendChild(container);
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument;
    const iframeWindow = iframe.contentWindow;
    if (iframeDocument === null || iframeWindow === null) {
      throw new Error('iframe document unavailable');
    }
    childDocument = iframeDocument;
    childWindow = iframeWindow;
    root = createRoot(container);
    onDismiss = jest.fn<void, [string]>();
  });

  afterEach((): void => {
    act(() => root.unmount());
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  function render(childKey: string): void {
    act(() =>
      root.render(<ToastWheelHost onDismiss={onDismiss} childKey={childKey} />),
    );
  }

  function requiredElement(selector: string): Element {
    const element = container.querySelector(selector);
    if (element === null) throw new Error(`no element matches ${selector}`);
    return element;
  }

  function wheel(
    target: Element,
    eventWindow: TestWindow,
    deltaX: number,
    deltaY = 0,
  ): WheelEvent {
    const event = new eventWindow.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX,
      deltaY,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  /** The fingers lift and the wheel goes quiet. */
  function endSwipe(): void {
    act(() => jest.advanceTimersByTime(200));
  }

  /** One wheel event per 16ms frame, as a trackpad sends them. */
  function swipeFrames(target: Element, deltas: readonly number[]): void {
    for (const deltaX of deltas) {
      wheel(target, window, deltaX);
      act(() => jest.advanceTimersByTime(16));
    }
  }

  function wheelX(card: Element): string {
    return card instanceof HTMLElement
      ? card.style.getPropertyValue('--toast-wheel-x')
      : '';
  }

  it('moves the card with the fingers and decides only when the swipe ends', (): void => {
    render('main');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    // A slow swipe well past the dismiss line: the card tracks every frame
    // 1:1 and is not thrown out while the fingers still move.
    let travelled = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      swipeFrames(toast, [-4]);
      travelled += 4;
      expect(wheelX(card)).toBe(`${String(travelled)}px`);
      expect(card.hasAttribute('data-wheel-swiping')).toBe(true);
    }
    expect(onDismiss).not.toHaveBeenCalled();

    endSwipe();
    expect(onDismiss).toHaveBeenCalledWith('t1');
    // It leaves from where the fingers left it.
    expect(wheelX(card)).toBe('120px');
  });

  it('springs a short swipe back to its place', (): void => {
    render('main');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    swipeFrames(toast, [-3, -3, -3, -3]);
    expect(wheelX(card)).toBe('12px');
    endSwipe();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(wheelX(card)).toBe('');
    expect(card.hasAttribute('data-wheel-swiping')).toBe(false);
  });

  it('resists a swipe away from the stack edge', (): void => {
    render('main');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    swipeFrames(toast, [20, 20]);
    const offset = Number.parseFloat(wheelX(card));
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-40);
  });

  it('hands a momentum tail past the line to the exit at its speed', (): void => {
    render('main');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    // A flick: the fingers speed up, lift, and the OS momentum decays.
    swipeFrames(toast, [-8, -16, -24, -24, -20, -17, -14]);

    // Dismissed as the momentum fades, without waiting for the wheel to go
    // quiet, and the exit starts at the card's current speed.
    expect(onDismiss).toHaveBeenCalledWith('t1');
    expect(card instanceof HTMLElement ? card.style.transition : '').toMatch(
      /transform \d+ms cubic-bezier/,
    );
  });

  it('dismisses a toast from a horizontal wheel swipe in the main document', (): void => {
    render('main');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    expect(toast.ownerDocument).toBe(document);
    expect(wheel(toast, window, -64).defaultPrevented).toBe(true);
    endSwipe();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('t1');
    expect(card.hasAttribute('data-wheel-swiping')).toBe(false);
  });

  it('dismisses a child-realm toast after its host is adopted into an iframe', (): void => {
    render('before-adoption');
    childDocument.body.appendChild(container);
    render('after-adoption');
    const card = requiredElement('[data-testid="toast-stack-card"]');
    const toast = requiredElement('[data-toast-id="t1"]');

    expect(childWindow.Element).not.toBe(window.Element);
    expect(toast.ownerDocument).toBe(childDocument);
    expect(toast instanceof childWindow.Element).toBe(true);
    expect(wheel(toast, childWindow, -64).defaultPrevented).toBe(true);
    endSwipe();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('t1');
    expect(card.hasAttribute('data-wheel-swiping')).toBe(false);
  });

  it('ignores vertical wheel events', (): void => {
    render('main');
    const toast = requiredElement('[data-toast-id="t1"]');

    expect(wheel(toast, window, 0, 80).defaultPrevented).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
