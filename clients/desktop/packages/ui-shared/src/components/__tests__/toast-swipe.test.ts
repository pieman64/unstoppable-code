/** @jest-environment jsdom */

import {
  attachToastSwipe,
  toastSwipeDismisses,
  toastSwipeEasingAt,
  toastSwipeRubberBand,
  toastSwipeVelocity,
  type ToastSwipe,
} from '../toast-swipe';
import { IN_APP_NOTIFICATION_WIDTH_PX } from '../../lib/notification-placement';

const WIDTH = IN_APP_NOTIFICATION_WIDTH_PX;
const HEIGHT = 72;

/** jsdom has no layout: give the card the stack's size and a corner place. */
function layOut(card: HTMLElement): void {
  card.getBoundingClientRect = (): DOMRect => {
    const left = window.innerWidth - 16 - WIDTH;
    const top = window.innerHeight - 16 - HEIGHT;
    return {
      x: left,
      y: top,
      left,
      top,
      right: left + WIDTH,
      bottom: top + HEIGHT,
      width: WIDTH,
      height: HEIGHT,
      toJSON: () => ({}),
    };
  };
}

function pointer(
  type: string,
  target: Element,
  clientX: number,
  clientY = 100,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
  return event;
}

/** One pointer move per 16ms frame along `xs` (and `ys`). */
function drag(
  target: Element,
  xs: readonly number[],
  ys: readonly number[] = xs.map(() => 100),
): void {
  pointer('pointerdown', target, 100, 100);
  xs.forEach((x, i) => {
    jest.advanceTimersByTime(16);
    pointer('pointermove', target, x, ys[i] ?? 100);
  });
}

describe('toast swipe decisions', () => {
  it('moves freely toward the edge and resists the other way', () => {
    expect(toastSwipeRubberBand(120, WIDTH)).toBe(120);
    const pulled = toastSwipeRubberBand(-200, WIDTH);
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThan(-200 * 0.55);
    // Never past the card's own size, however far the pull.
    expect(toastSwipeRubberBand(-10_000, WIDTH)).toBeGreaterThan(-WIDTH);
  });

  it('measures speed over the last moments, slowing for a pause before release', () => {
    const samples = [
      { t: 0, input: 0 },
      { t: 16, input: 8 },
      { t: 32, input: 16 },
    ];
    expect(toastSwipeVelocity(samples, 32)).toBeCloseTo(0.5);
    // Released 40ms after the input stopped: half the speed.
    expect(toastSwipeVelocity(samples, 64)).toBeLessThan(0.3);
    expect(toastSwipeVelocity(samples, 500)).toBe(0);
  });

  it('dismisses past a quarter of the width, on a flick, but not on a flick back', () => {
    expect(toastSwipeDismisses('x', WIDTH * 0.25, 0, WIDTH)).toBe(true);
    expect(toastSwipeDismisses('x', WIDTH * 0.25 - 1, 0, WIDTH)).toBe(false);
    expect(toastSwipeDismisses('x', 30, 0.4, WIDTH)).toBe(true);
    expect(toastSwipeDismisses('x', 4, 0.4, WIDTH)).toBe(false);
    expect(toastSwipeDismisses('x', 200, -0.4, WIDTH)).toBe(false);
    // Toward the screen edge: half the card's height.
    expect(toastSwipeDismisses('y', HEIGHT / 2, 0, HEIGHT)).toBe(true);
    expect(toastSwipeDismisses('y', HEIGHT / 2 - 1, 0, HEIGHT)).toBe(false);
  });
});

describe('attachToastSwipe', () => {
  let host: HTMLDivElement;
  let card: HTMLDivElement;
  let content: HTMLSpanElement;
  let onDismiss: jest.Mock<void, [string]>;
  let swipe: ToastSwipe;

  function attach(
    side: 'left' | 'right' = 'right',
    edge: 'top' | 'bottom' = 'bottom',
  ): void {
    swipe = attachToastSwipe(host, { side, edge, onDismiss });
  }

  function swipeX(): string {
    return card.style.getPropertyValue('--toast-swipe-x');
  }

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement('div');
    card = document.createElement('div');
    card.setAttribute('data-toast-stack-id', 't1');
    content = document.createElement('span');
    content.textContent = 'Toast';
    card.append(content);
    host.append(card);
    document.body.append(host);
    layOut(card);
    onDismiss = jest.fn<void, [string]>();
  });

  afterEach(() => {
    swipe.detach();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  it('follows the pointer 1:1 from the first move, without waiting for the slop', () => {
    attach();
    pointer('pointerdown', content, 100);
    pointer('pointermove', content, 101);
    expect(swipeX()).toBe('1px');
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
    pointer('pointermove', content, 160);
    expect(swipeX()).toBe('60px');
  });

  it('leaves past a quarter of the width, past the window edge, then closes the toast', () => {
    attach();
    drag(content, [120, 140, 160, 180, 200]);
    jest.advanceTimersByTime(200);
    pointer('pointerup', content, 200);

    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(false);
    // Clear of the window's right edge, shadow included.
    const target = Number.parseFloat(swipeX());
    expect(target).toBeGreaterThanOrEqual(16 + WIDTH + 24);
    // The deck closes up a moment after the card starts to leave.
    expect(onDismiss).not.toHaveBeenCalled();
    jest.advanceTimersByTime(90);
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('dismisses a short quick flick, but settles the same distance dragged slowly', () => {
    attach();
    drag(content, [110, 120, 130]);
    pointer('pointerup', content, 130);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    jest.advanceTimersByTime(90);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    card.removeAttribute('data-swipe-flung');
    onDismiss.mockClear();
    drag(content, [110, 120, 130]);
    jest.advanceTimersByTime(300);
    pointer('pointerup', content, 130);
    expect(card.hasAttribute('data-swipe-flung')).toBe(false);
    expect(card.hasAttribute('data-swipe-settling')).toBe(true);
    expect(swipeX()).toBe('0px');
    jest.advanceTimersByTime(1000);
    expect(card.hasAttribute('data-swipe-settling')).toBe(false);
    expect(swipeX()).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses a flick that sends a single move', () => {
    attach();
    pointer('pointerdown', content, 100);
    jest.advanceTimersByTime(16);
    pointer('pointermove', content, 130);
    pointer('pointerup', content, 130);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
  });

  it('puts a card back when detached mid-drag or mid-return', () => {
    attach();
    pointer('pointerdown', content, 100);
    pointer('pointermove', content, 140);
    swipe.detach();
    expect(swipeX()).toBe('');
    expect(card.hasAttribute('data-swipe-dragging')).toBe(false);

    attach();
    const g = swipe.begin(card);
    g?.move(40);
    jest.advanceTimersByTime(200);
    g?.end();
    expect(card.hasAttribute('data-swipe-settling')).toBe(true);
    swipe.detach();
    expect(card.hasAttribute('data-swipe-settling')).toBe(false);
    expect(swipeX()).toBe('');
  });

  it('keeps a card flicked back toward its place', () => {
    attach();
    drag(content, [140, 180, 220, 200, 170, 140]);
    pointer('pointerup', content, 140);
    expect(card.hasAttribute('data-swipe-settling')).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps a card flicked back after a drag past the dismiss line', () => {
    attach();
    // Slowly out to 150px, well past a quarter of the card...
    drag(content, [120, 140, 160, 180, 200, 220, 240, 250]);
    jest.advanceTimersByTime(16);
    // ...then a quick flick back, released while still past the line.
    pointer('pointermove', content, 235);
    jest.advanceTimersByTime(16);
    pointer('pointermove', content, 215);
    pointer('pointerup', content, 215);
    expect(card.hasAttribute('data-swipe-flung')).toBe(false);
    expect(card.hasAttribute('data-swipe-settling')).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('measures only the latest run in one direction', () => {
    const samples = [
      { t: 0, input: 0 },
      { t: 16, input: 40 },
      { t: 32, input: 80 },
      { t: 48, input: 60 },
      { t: 64, input: 40 },
    ];
    expect(toastSwipeVelocity(samples, 64)).toBeLessThan(-1);
  });

  it('resists a drag away from the side', () => {
    attach();
    drag(content, [80, 60, 40, 20, 0, -100]);
    const shown = Number.parseFloat(swipeX());
    expect(shown).toBeLessThan(0);
    expect(shown).toBeGreaterThan(-200 * 0.55);
  });

  it('works mirrored for a stack on the left', () => {
    attach('left');
    drag(content, [80, 60, 40, 20, 0]);
    expect(swipeX()).toBe('-100px');
    pointer('pointerup', content, 0);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    expect(Number.parseFloat(swipeX())).toBeLessThan(-WIDTH);
  });

  it('dismisses a clearly vertical drag toward the screen edge, and resists away from it', () => {
    attach('right', 'bottom');
    drag(content, [100, 101, 101, 102], [110, 130, 150, 170]);
    expect(swipeX()).toBe('');
    expect(card.style.getPropertyValue('--toast-swipe-y')).toBe('70px');
    jest.advanceTimersByTime(200);
    pointer('pointerup', content, 102, 170);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    jest.advanceTimersByTime(90);
    expect(onDismiss).toHaveBeenCalledWith('t1');

    // Up, away from the bottom edge: the card gives a little and returns.
    card.removeAttribute('data-swipe-flung');
    onDismiss.mockClear();
    drag(content, [100, 100, 100], [80, 40, 0]);
    const lifted = Number.parseFloat(
      card.style.getPropertyValue('--toast-swipe-y'),
    );
    expect(lifted).toBeLessThan(0);
    expect(lifted).toBeGreaterThan(-100);
    pointer('pointerup', content, 100, 0);
    jest.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses upward for a stack in a top corner', () => {
    attach('right', 'top');
    drag(content, [100, 100, 100], [70, 40, 10]);
    expect(card.style.getPropertyValue('--toast-swipe-y')).toBe('-90px');
    pointer('pointerup', content, 100, 10);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
  });

  it('lets a click through, and swallows the click that ends a drag', () => {
    attach();
    const onClick = jest.fn();
    card.addEventListener('click', onClick);

    // A press that wobbles under the slop is still a click.
    pointer('pointerdown', content, 100);
    pointer('pointermove', content, 103);
    pointer('pointerup', content, 103);
    content.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(card.hasAttribute('data-swipe-flung')).toBe(false);

    jest.advanceTimersByTime(1000);
    drag(content, [110, 120]);
    jest.advanceTimersByTime(300);
    pointer('pointerup', content, 120);
    content.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps a press on the card from starting a text selection, until it ends', () => {
    attach();
    const select = (): boolean =>
      document.dispatchEvent(new Event('selectstart', { cancelable: true }));
    expect(select()).toBe(true);
    pointer('pointerdown', content, 100);
    expect(select()).toBe(false);
    pointer('pointermove', content, 140);
    pointer('pointerup', content, 140);
    expect(select()).toBe(true);
  });

  it('ends a press released outside the stack, before any capture', () => {
    attach();
    pointer('pointerdown', content, 100);
    pointer('pointermove', document.body, 103);
    pointer('pointerup', document.body, 103);
    // Selection works again and the next swipe starts normally.
    expect(
      document.dispatchEvent(new Event('selectstart', { cancelable: true })),
    ).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(swipeX()).toBe('');
    expect(swipe.begin(card)).not.toBeNull();
  });

  it('follows a drag that leaves the stack and lets go outside it', () => {
    attach();
    pointer('pointerdown', content, 100);
    for (const x of [140, 180, 220]) {
      jest.advanceTimersByTime(16);
      pointer('pointermove', document.body, x);
    }
    expect(swipeX()).toBe('120px');
    pointer('pointerup', document.body, 220);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
  });

  it('ends a press whose stack moved to another document mid-press', () => {
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    pointer('pointerdown', content, 100);
    jest.advanceTimersByTime(100);
    pointer('pointermove', content, 120);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
    jest.advanceTimersByTime(200);

    // The overlay layer adopts the stack into its own document.
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const childDocument = iframe.contentDocument;
    if (childDocument === null) throw new Error('no iframe document');
    childDocument.body.append(host);

    // Released on the moved stack: the stack itself hears it.
    pointer('pointerup', content, 120);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(false);
    expect(onHold).toHaveBeenLastCalledWith('t1', false);
    jest.advanceTimersByTime(1000);
    expect(swipe.begin(card)).not.toBeNull();
  });

  it('ends a press whose stack moved documents and was released off the stack', () => {
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    const button = document.createElement('button');
    card.append(button);
    pointer('pointerdown', content, 100);
    jest.advanceTimersByTime(100);
    pointer('pointermove', content, 120);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);

    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const childDocument = iframe.contentDocument;
    if (childDocument === null) throw new Error('no iframe document');
    childDocument.body.append(host);
    // No release anywhere the press listens: the move itself ends the press.
    jest.advanceTimersByTime(50);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(false);
    expect(onHold).toHaveBeenLastCalledWith('t1', false);
    jest.advanceTimersByTime(1000);
    expect(swipe.begin(card)).not.toBeNull();
  });

  it('releases a button hold whose stack moved documents', () => {
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    const button = document.createElement('button');
    card.append(button);
    pointer('pointerdown', button, 100);
    expect(onHold).toHaveBeenLastCalledWith('t1', true);
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const childDocument = iframe.contentDocument;
    if (childDocument === null) throw new Error('no iframe document');
    childDocument.body.append(host);
    jest.advanceTimersByTime(50);
    expect(onHold).toHaveBeenLastCalledWith('t1', false);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('lets a new press end one whose release was never heard', () => {
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    pointer('pointerdown', content, 100);
    pointer('pointermove', content, 120);
    // The release went somewhere nobody listens; the next press recovers.
    pointer('pointerdown', content, 100);
    expect(onHold.mock.calls).toEqual([
      ['t1', true],
      ['t1', false],
      ['t1', true],
    ]);
    // The new press drives the card (picked up where it is drawn).
    jest.advanceTimersByTime(16);
    pointer('pointermove', content, 104);
    const first = Number.parseFloat(swipeX());
    pointer('pointermove', content, 114);
    expect(Number.parseFloat(swipeX())).toBeCloseTo(first + 10);
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
  });

  it('reports a card held and let go, for the stack to hold its clock', () => {
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    pointer('pointerdown', content, 100);
    expect(onHold).toHaveBeenLastCalledWith('t1', true);
    pointer('pointerup', content, 100);
    expect(onHold).toHaveBeenLastCalledWith('t1', false);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('holds the clock while a card’s own button is pressed, without dragging', () => {
    const button = document.createElement('button');
    card.append(button);
    const onHold = jest.fn<void, [string, boolean]>();
    swipe = attachToastSwipe(host, {
      side: 'right',
      edge: 'bottom',
      onDismiss,
      onHold,
    });
    pointer('pointerdown', button, 100);
    expect(onHold).toHaveBeenLastCalledWith('t1', true);
    pointer('pointermove', button, 160);
    expect(swipeX()).toBe('');
    // Released anywhere, the hold ends.
    pointer('pointerup', document.body, 160);
    expect(onHold).toHaveBeenLastCalledWith('t1', false);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('never starts a drag on the card’s own buttons', () => {
    const button = document.createElement('button');
    card.append(button);
    attach();
    drag(button, [140, 180, 220]);
    expect(swipeX()).toBe('');
  });

  it('closes the toast at once under reduced motion', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: true });
    Object.defineProperty(window, 'matchMedia', {
      value: matchMedia,
      configurable: true,
    });
    try {
      attach();
      drag(content, [140, 180, 220]);
      pointer('pointerup', content, 220);
      jest.advanceTimersByTime(0);
      expect(onDismiss).toHaveBeenCalledWith('t1');
      expect(matchMedia).toHaveBeenCalledWith(
        '(prefers-reduced-motion: reduce)',
      );
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('under reduced motion, a card let go is home at once and re-grabbed from there', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: jest.fn().mockReturnValue({ matches: true }),
      configurable: true,
    });
    try {
      attach();
      drag(content, [110, 120, 130, 140, 150]);
      jest.advanceTimersByTime(300);
      pointer('pointerup', content, 150);
      expect(card.hasAttribute('data-swipe-settling')).toBe(false);
      expect(swipeX()).toBe('');

      // A second short drag right away starts from rest, not 50px out.
      drag(content, [110, 120, 130, 140, 150]);
      expect(swipeX()).toBe('50px');
      jest.advanceTimersByTime(300);
      pointer('pointerup', content, 150);
      expect(card.hasAttribute('data-swipe-flung')).toBe(false);
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  describe('a host-driven swipe', () => {
    it('follows the host, decides when it ends, and commits once half off', () => {
      attach();
      const gesture = swipe.begin(card);
      if (gesture === null) throw new Error('no gesture');
      gesture.move(40);
      expect(swipeX()).toBe('40px');
      expect(gesture.isPastLine()).toBe(false);
      gesture.move(60);
      expect(gesture.isPastLine()).toBe(true);
      expect(gesture.ended).toBe(false);
      gesture.move(WIDTH / 2);
      // Half off: gone without waiting for the input to end.
      expect(gesture.ended).toBe(true);
      expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    });

    it('decides on the speed the input had when it ended', () => {
      attach();
      const g = swipe.begin(card);
      for (const step of [12, 12, 12]) {
        jest.advanceTimersByTime(16);
        g?.move(step);
      }
      const lastInputAt = performance.now();
      // Noticed only after a quiet spell, as a trackpad host does.
      jest.advanceTimersByTime(150);
      g?.end(lastInputAt);
      expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    });

    it('is refused while a pointer drag owns the card, and the reverse', () => {
      attach();
      pointer('pointerdown', content, 100);
      jest.advanceTimersByTime(100);
      pointer('pointermove', content, 120);
      expect(swipe.begin(card)).toBeNull();
      jest.advanceTimersByTime(200);
      pointer('pointerup', content, 120);
      jest.advanceTimersByTime(1000);

      const gesture = swipe.begin(card);
      expect(gesture).not.toBeNull();
      pointer('pointerdown', content, 100);
      pointer('pointermove', content, 160);
      expect(swipeX()).toBe('0px');
      gesture?.end();
    });

    it('picks a settling card up where it is drawn', () => {
      attach();
      const first = swipe.begin(card);
      first?.move(60);
      jest.advanceTimersByTime(200);
      first?.end();
      expect(card.hasAttribute('data-swipe-settling')).toBe(true);
      // Partway back: neither at 60px nor home yet.
      jest.advanceTimersByTime(80);
      const second = swipe.begin(card);
      const drawn = Number.parseFloat(swipeX());
      expect(drawn).toBeGreaterThan(5);
      expect(drawn).toBeLessThan(60);
      second?.move(10);
      expect(Number.parseFloat(swipeX())).toBeCloseTo(drawn + 10);
      second?.end();
    });

    it('starts the same ease it was given', () => {
      expect(toastSwipeEasingAt([0.3, 0, 0.25, 1], 0)).toBe(0);
      expect(toastSwipeEasingAt([0.3, 0, 0.25, 1], 1)).toBeCloseTo(1);
      expect(toastSwipeEasingAt([0.3, 0, 0.25, 1], 0.5)).toBeGreaterThan(0.5);
    });
  });
});
