/** @jest-environment jsdom */

import { attachToastSwipe } from '@canopy/ui-shared';
import { toastTrackpadSwipe } from '../toastTrackpadSwipe';

type TestWindow = Window & { WheelEvent: typeof WheelEvent };

function hasWheelEventConstructor(
  windowLike: Window,
): windowLike is TestWindow {
  return typeof Reflect.get(windowLike, 'WheelEvent') === 'function';
}

describe('toastTrackpadSwipe', (): void => {
  let host: HTMLDivElement;
  let card: HTMLDivElement;
  let behind: HTMLDivElement;
  let onDismiss: jest.Mock<void, [string]>;
  let detach: () => void;

  function makeCard(id: string): HTMLDivElement {
    const element = document.createElement('div');
    element.setAttribute('data-toast-stack-id', id);
    element.append(document.createElement('span'));
    return element;
  }

  function attach(side: 'left' | 'right' = 'right'): void {
    const swipe = attachToastSwipe(host, { side, edge: 'top', onDismiss });
    const detachInput = toastTrackpadSwipe(swipe, host, side);
    detach = (): void => {
      detachInput();
      swipe.detach();
    };
  }

  beforeEach((): void => {
    jest.useFakeTimers();
    host = document.createElement('div');
    card = makeCard('t1');
    behind = makeCard('t2');
    host.append(card, behind);
    document.body.append(host);
    onDismiss = jest.fn<void, [string]>();
    attach();
  });

  afterEach((): void => {
    detach();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  function wheel(
    target: Element,
    deltaX: number,
    deltaY = 0,
    eventWindow: TestWindow = window,
  ): WheelEvent {
    const event = new eventWindow.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX,
      deltaY,
    });
    target.dispatchEvent(event);
    return event;
  }

  /** One wheel event per 16ms frame, as a trackpad sends them. */
  function frames(target: Element, deltas: readonly number[]): void {
    for (const deltaX of deltas) {
      wheel(target, deltaX);
      jest.advanceTimersByTime(16);
    }
  }

  function swipeX(element: HTMLElement): string {
    return element.style.getPropertyValue('--toast-swipe-x');
  }

  it('moves the card with the fingers 1:1 and decides only when the swipe ends', (): void => {
    let travelled = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      frames(card, [-4]);
      travelled += 4;
      expect(swipeX(card)).toBe(`${String(travelled)}px`);
      expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
    }
    expect(onDismiss).not.toHaveBeenCalled();

    // Past the dismiss line: a short pause is not taken as a lift.
    jest.advanceTimersByTime(100);
    expect(card.hasAttribute('data-swipe-flung')).toBe(false);
    jest.advanceTimersByTime(60);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    jest.advanceTimersByTime(90);
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('springs a short swipe back as soon as the wheel goes quiet', (): void => {
    frames(card, [-3, -3, -3, -3]);
    expect(swipeX(card)).toBe('12px');
    jest.advanceTimersByTime(50);

    expect(card.hasAttribute('data-swipe-settling')).toBe(true);
    expect(swipeX(card)).toBe('0px');
    jest.advanceTimersByTime(1000);
    expect(swipeX(card)).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('throws out a quick short flick that stops without momentum', (): void => {
    // Fast, short of the dismiss line, then quiet: no coasting to read.
    frames(card, [-12, -12, -12]);
    expect(card.hasAttribute('data-swipe-flung')).toBe(false);
    jest.advanceTimersByTime(60);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
  });

  it('resists a swipe away from the stack side', (): void => {
    frames(card, [20, 20]);
    const offset = Number.parseFloat(swipeX(card));
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-40 * 0.55);
  });

  it('throws a coasting card out at its speed, and its momentum leaves the next card alone', (): void => {
    // A flick: the fingers speed up, lift, and the OS momentum decays.
    frames(card, [-8, -16, -24, -24, -20, -17, -14]);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    expect(card.style.getPropertyValue('--toast-swipe-ease')).toMatch(
      /^cubic-bezier\(/,
    );

    // The rest of the momentum lands on the card behind and is swallowed.
    expect(wheel(behind, -10).defaultPrevented).toBe(true);
    frames(behind, [-8, -6]);
    expect(swipeX(behind)).toBe('');
    jest.advanceTimersByTime(100);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // A new swipe once the momentum has stopped moves the next card.
    frames(behind, [-10]);
    expect(swipeX(behind)).toBe('10px');
  });

  it('keeps following a card that slid out from under the pointer', (): void => {
    frames(card, [-30]);
    // The same swipe now lands on the card behind, or outside the stack.
    frames(behind, [-30]);
    frames(document.body, [-30]);
    expect(swipeX(card)).toBe('90px');
    expect(swipeX(behind)).toBe('');
  });

  it('commits once the card is half off, without waiting for the swipe to end', (): void => {
    frames(card, [-60, -60, -60]);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
  });

  it('ignores vertical scrolling', (): void => {
    expect(wheel(card, 0, 80).defaultPrevented).toBe(false);
    expect(wheel(card, -10, 80).defaultPrevented).toBe(false);
    expect(swipeX(card)).toBe('');
  });

  it('works mirrored for a stack on the left', (): void => {
    detach();
    attach('left');
    frames(card, [10, 10]);
    expect(swipeX(card)).toBe('-20px');
  });

  it('follows a card whose stack was adopted into another document', (): void => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const childDocument = iframe.contentDocument;
    const iframeWindow = iframe.contentWindow;
    if (
      childDocument === null ||
      iframeWindow === null ||
      !hasWheelEventConstructor(iframeWindow)
    ) {
      throw new Error('iframe document unavailable');
    }
    let childWindow: TestWindow = window;
    childWindow = iframeWindow;
    childDocument.body.append(host);
    expect(card.ownerDocument).toBe(childDocument);

    const event = wheel(card, -40, 0, childWindow);
    expect(event.defaultPrevented).toBe(true);
    wheel(card, -40, 0, childWindow);
    expect(swipeX(card)).toBe('80px');
  });
});
