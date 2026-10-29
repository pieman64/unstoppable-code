import { useEffect, useRef, type RefObject } from 'react';

/** How far a released swipe must have carried a card to dismiss it, in px. */
const WHEEL_DISMISS_PX = 64;
/** A swipe moving at least this fast when it stops dismisses, in px/ms. */
const WHEEL_FLICK_PX_PER_MS = 0.6;
/**
 * A swipe that pauses this long has ended: the card leaves or returns. Wheel
 * events stop while resting fingers hold still, so this also has to outlast
 * a brief pause mid-swipe.
 */
const WHEEL_IDLE_MS = 150;
/**
 * Momentum events that shrink this many times in a row mean the fingers have
 * lifted and the OS is coasting; past the dismiss line the card leaves then.
 */
const WHEEL_COASTING_STEPS = 3;
/** A swipe away from the screen edge moves the card this much, up to a cap. */
const WHEEL_PULL_RESISTANCE = 0.25;
const WHEEL_MAX_PULL_PX = 24;
/** The stack's own exit (toast-stack.css), used for a card thrown from rest. */
const EXIT_MS = 400;
/** The quickest and longest a thrown card takes to coast off. */
const MIN_THROW_MS = 200;
const MAX_THROW_MS = 700;
/** How far past its resting place a leaving card travels: `100% + 32px`. */
const EXIT_CLEARANCE_PX = 32;

const STACK_CARD_SELECTOR = '[data-testid="toast-stack-card"]';

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Where the card sits for a swipe offset: free toward the edge, damped away. */
function shownOffset(offset: number): number {
  return offset >= 0
    ? offset
    : -Math.min(WHEEL_MAX_PULL_PX, -offset * WHEEL_PULL_RESISTANCE);
}

/**
 * The exit transition for a card thrown at `speed` px/ms over `distance` px.
 * A moving card leaves at its own speed and only slows down from there, like
 * momentum, so the hand-off from the fingers (or the OS coasting) has no
 * jump. A card at rest eases into motion. Either way it fades out late, while
 * it is already leaving.
 */
function throwTransition(speed: number, distance: number): string {
  if (speed <= 0) {
    return [
      `transform ${String(EXIT_MS)}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      `opacity ${String(EXIT_MS)}ms cubic-bezier(0.4, 0, 1, 1)`,
      'height 150ms ease-out',
    ].join(', ');
  }
  const duration = Math.round(
    clamp((2 * distance) / speed, MIN_THROW_MS, MAX_THROW_MS),
  );
  // The starting speed as a multiple of the average: a curve whose first two
  // control points lie on one line of that slope starts exactly that fast and
  // only decelerates. Below 1 it cannot, so it starts at the average.
  const slope = Math.max(1, (speed * duration) / Math.max(1, distance));
  const easing = `cubic-bezier(${(0.5 / slope).toFixed(3)}, 0.5, ${(1 / slope).toFixed(3)}, 1)`;
  return [
    `transform ${String(duration)}ms ${easing}`,
    `opacity ${String(duration)}ms cubic-bezier(0.4, 0, 1, 1)`,
    'height 150ms ease-out',
  ].join(', ');
}

/**
 * Trackpad swipe-to-dismiss for the toast stack rendered inside the returned
 * element. Two-finger swipes arrive as horizontal wheel events, which the
 * shared stack's pointer swipe never sees.
 *
 * It feels like dragging the card with the mouse: the card under the pointer
 * when the swipe starts follows the fingers 1:1, even once it has slid out
 * from under the pointer, (`--toast-wheel-x`, read by toast-stack.css, with
 * `data-wheel-swiping` while it moves), including the OS momentum after the
 * fingers lift. Nothing is decided mid-swipe. When the momentum fades past the
 * dismiss line, or the wheel goes quiet, the card either slides out to the
 * stack's side, starting at its current speed, or springs back to its place.
 *
 * It lives here, not in the shared `ToastStack`: the web chat pages sit at
 * their first-load budget, and web toasts keep the pointer swipe alone.
 *
 * `onDismiss` receives the `data-toast-id` found inside the swiped card.
 */
export function useToastWheelSwipe(
  side: 'left' | 'right',
  onDismiss: (toastId: string) => void,
): RefObject<HTMLDivElement | null> {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const sign = side === 'right' ? 1 : -1;
    let card: HTMLElement | null = null;
    // Distance swiped toward the edge, and the swipe's speed in px/ms.
    let offset = 0;
    let speed = 0;
    let lastStep = 0;
    let lastTime: number | null = null;
    let coastingSteps = 0;
    // A swipe that has dismissed a card is spent: its momentum keeps arriving
    // for a moment, over whichever card moved under the pointer, and must not
    // carry that one away too.
    let spent = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // The document whose wheel events the current swipe follows. The card
    // slides out from under the pointer, so later events land on the card
    // behind it, or outside the stack altogether.
    let swipeDocument: Document | null = null;

    const resetSwipe = (): void => {
      swipeDocument?.removeEventListener('wheel', onSwipeWheel, true);
      swipeDocument = null;
      card = null;
      offset = 0;
      speed = 0;
      lastStep = 0;
      lastTime = null;
      coastingSteps = 0;
    };
    const settleBack = (): void => {
      card?.removeAttribute('data-wheel-swiping');
      card?.style.removeProperty('--toast-wheel-x');
      resetSwipe();
    };
    const throwOut = (target: HTMLElement, throwSpeed: number): void => {
      const toastId = target
        .querySelector('[data-toast-id]')
        ?.getAttribute('data-toast-id');
      const shown = sign * shownOffset(offset);
      // Leave from where the swipe took the card, at its speed. The inline
      // exit matches toast-stack.css's ending style, so the card is already
      // moving in the frames before the stack marks it as ending.
      target.style.transition = throwTransition(
        throwSpeed,
        target.offsetWidth + EXIT_CLEARANCE_PX,
      );
      target.style.transform = `translateX(calc(${String(shown)}px + ${String(sign)} * (100% + ${String(EXIT_CLEARANCE_PX)}px))) translateY(var(--toast-y)) scale(var(--toast-scale))`;
      target.style.opacity = '0';
      target.removeAttribute('data-wheel-swiping');
      resetSwipe();
      spent = true;
      idleTimer = setTimeout(() => {
        spent = false;
      }, WHEEL_IDLE_MS);
      if (toastId) onDismissRef.current(toastId);
    };
    const release = (): void => {
      const target = card;
      if (target === null) return;
      if (offset >= WHEEL_DISMISS_PX || speed >= WHEEL_FLICK_PX_PER_MS) {
        // The card has rested here since the wheel went quiet.
        throwOut(target, 0);
        return;
      }
      settleBack();
    };
    const track = (target: HTMLElement, event: WheelEvent): void => {
      event.preventDefault();
      clearTimeout(idleTimer);
      // Fingers moving toward the edge scroll the other way.
      const step = -sign * event.deltaX;
      const now = performance.now();
      const elapsed = lastTime === null ? Infinity : now - lastTime;
      // The first event of a swipe counts as one 16ms frame.
      const stepSpeed =
        step / (elapsed > WHEEL_IDLE_MS ? 16 : Math.max(4, elapsed));
      speed =
        elapsed > WHEEL_IDLE_MS ? stepSpeed : 0.6 * speed + 0.4 * stepSpeed;
      coastingSteps =
        step > 0 && lastStep > 0 && step < lastStep ? coastingSteps + 1 : 0;
      lastStep = step;
      lastTime = now;
      offset += step;
      target.style.setProperty(
        '--toast-wheel-x',
        `${String(sign * shownOffset(offset))}px`,
      );
      target.setAttribute('data-wheel-swiping', '');
      if (
        offset >= WHEEL_DISMISS_PX &&
        coastingSteps >= WHEEL_COASTING_STEPS &&
        speed > 0
      ) {
        throwOut(target, speed);
        return;
      }
      idleTimer = setTimeout(release, WHEEL_IDLE_MS);
    };
    function onSwipeWheel(event: WheelEvent): void {
      if (card === null) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      track(card, event);
    }
    const onWheel = (event: WheelEvent): void => {
      // A swipe under way is followed through its document's listener.
      if (card !== null) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const target = isElementNode(event.target)
        ? event.target.closest<HTMLElement>(STACK_CARD_SELECTOR)
        : null;
      if (target === null) return;
      if (spent) {
        // Spent until the momentum stops arriving.
        event.preventDefault();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          spent = false;
        }, WHEEL_IDLE_MS);
        return;
      }
      card = target;
      swipeDocument = target.ownerDocument;
      swipeDocument.addEventListener('wheel', onSwipeWheel, {
        capture: true,
        passive: false,
      });
      track(target, event);
    };

    host.addEventListener('wheel', onWheel, { passive: false });
    return (): void => {
      clearTimeout(idleTimer);
      resetSwipe();
      host.removeEventListener('wheel', onWheel);
    };
  }, [side]);

  return hostRef;
}
