import type {
  ToastStackSwipeInput,
  ToastSwipeGesture,
} from '@canopy/ui-shared';

/**
 * A swipe that would bring the card back has ended once the wheel is quiet
 * this long. Trackpads send an event every frame while the fingers move.
 */
const IDLE_MS = 50;
/** Sparse OS momentum ticks can arrive more than one frame apart. */
const MOMENTUM_IDLE_MS = 150;
/**
 * Past the dismiss line, wait longer before taking a quiet wheel as the
 * fingers lifting: resting fingers send nothing either, and a pause there
 * must not throw the card away.
 */
const IDLE_PAST_LINE_MS = 150;
/**
 * Fallback for browsers without a native momentum flag: sustained shrinking
 * deltas can identify the small inertia tail. Native direct input skips it.
 */
const COASTING_STEPS = 3;
/** Slowing fingers still own the toast; only a tiny cancelled tail is spent. */
const MOMENTUM_TAIL_PX = 1;

const STACK_CARD_SELECTOR = '[data-toast-stack-id]';

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

/** Use the platform's inertia signal when the browser exposes it. */
function wheelMomentum(event: WheelEvent): boolean | undefined {
  return 'momentum' in event && typeof event.momentum === 'boolean'
    ? event.momentum
    : undefined;
}

function isHorizontal(event: WheelEvent): boolean {
  return Math.abs(event.deltaX) > Math.abs(event.deltaY);
}

/**
 * Two-finger trackpad swipe to dismiss for the shared toast stack. Swipes
 * arrive as horizontal wheel events, which the stack's pointer swipe never
 * sees; this feeds them to the stack's swipe controller, so the card moves,
 * leaves and returns through the same controller as a mouse drag.
 *
 * The card under the pointer when the swipe starts follows the fingers,
 * even once it has slid out from under the pointer. The native momentum flag
 * ends direct manipulation without feeding inertia into the card. Browsers
 * without that flag use a bounded tail/quiet fallback. Leftover momentum is
 * drained; a fresh direct event can pick the card back up immediately.
 *
 * Desktop only: the web chat pages sit at their first-load budget.
 */
export const toastTrackpadSwipe: ToastStackSwipeInput = (swipe, host, side) => {
  const sign = side === 'right' ? 1 : -1;
  let gesture: ToastSwipeGesture | null = null;
  // The document whose wheel events the current swipe follows.
  let swipeDocument: Document | null = null;
  let lastStep = 0;
  let coastingSteps = 0;
  // A swipe that has ended mid-stream is spent until its momentum stops.
  let spent = false;
  let spentDirection = 0;
  let lastDirectInputAt: number | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopFollowing = (): void => {
    swipeDocument?.removeEventListener('wheel', onSwipeWheel, true);
    swipeDocument = null;
    gesture = null;
    lastStep = 0;
    coastingSteps = 0;
    spentDirection = 0;
    lastDirectInputAt = undefined;
  };

  const waitForQuiet = (ms: number, then: () => void): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(then, ms);
  };

  const liveCard = (element: Element | null): HTMLElement | null => {
    const card = element?.closest<HTMLElement>(STACK_CARD_SELECTOR) ?? null;
    return card !== null &&
      host.contains(card) &&
      !card.matches('[data-swipe-flung], [data-ending-style], [data-limited]')
      ? card
      : null;
  };

  // Wheel transactions may keep targeting the outgoing toast until the
  // pointer moves. Fresh direct input must hit-test the current deck instead.
  const cardAtPointer = (event: WheelEvent): HTMLElement | null => {
    const hits = host.ownerDocument.elementsFromPoint?.(
      event.clientX,
      event.clientY,
    );
    if (hits !== undefined) {
      for (const hit of hits) {
        const card = liveCard(hit);
        if (card !== null) return card;
      }
      return null;
    }
    return liveCard(isElementNode(event.target) ? event.target : null);
  };

  const track = (g: ToastSwipeGesture, event: WheelEvent): void => {
    event.preventDefault();
    // Fingers moving toward the edge scroll the other way.
    const step = -sign * event.deltaX;
    const momentum = wheelMomentum(event);
    if (momentum !== true) {
      coastingSteps =
        step * lastStep > 0 &&
        Math.abs(step) <= Math.abs(lastStep) &&
        (coastingSteps > 0 || Math.abs(step) < Math.abs(lastStep))
          ? coastingSteps + 1
          : 0;
      lastStep = step;
      g.move(step);
      lastDirectInputAt = performance.now();
    }
    // Native direct input never ends because its deltas got smaller. The
    // first momentum event is the release; do not feed its delta to the card.
    // Older browsers retain the bounded fallback until they expose momentum.
    if (
      momentum === true ||
      (momentum === undefined &&
        !g.ended &&
        coastingSteps >= COASTING_STEPS &&
        (g.wouldDismiss() || Math.abs(step) <= MOMENTUM_TAIL_PX))
    ) {
      g.end(lastDirectInputAt);
    }
    if (g.ended) {
      // Keep the document listener until the tail stops, even if the card
      // has moved away from the pointer or is already back in place.
      gesture = null;
      spentDirection = Math.sign(step);
      lastStep = 0;
      coastingSteps = 0;
      spent = true;
      waitForQuiet(MOMENTUM_IDLE_MS, () => {
        spent = false;
        stopFollowing();
      });
      return;
    }
    const inputEndedAt = lastDirectInputAt;
    waitForQuiet(g.isPastLine() ? IDLE_PAST_LINE_MS : IDLE_MS, () => {
      stopFollowing();
      // Decided on the speed the fingers had, not one diluted by the wait.
      g.end(inputEndedAt);
    });
  };

  function onSwipeWheel(event: WheelEvent): void {
    const momentum = wheelMomentum(event);
    if (!isHorizontal(event) && momentum !== true) {
      if (spent) {
        // A fresh vertical gesture and its inertia belong to the page too.
        clearTimeout(idleTimer);
        spent = false;
        stopFollowing();
      }
      return;
    }
    if (spent) {
      const direction = Math.sign(-sign * event.deltaX);
      // New direct input can start on the next card without waiting for the
      // outgoing card or moving the cursor. Inertia never transfers cards.
      const freshInput =
        momentum === false ||
        (momentum === undefined &&
          direction !== 0 &&
          direction !== spentDirection);
      const card = freshInput ? cardAtPointer(event) : null;
      if (freshInput) {
        const next = card === null ? null : swipe.begin(card);
        if (card !== null && next !== null) {
          spent = false;
          gesture = next;
          track(next, event);
          return;
        }
        // Fresh scrolling outside the deck belongs to the page, including
        // when another input already owns the card under the pointer.
        clearTimeout(idleTimer);
        spent = false;
        stopFollowing();
        return;
      }
      event.preventDefault();
      waitForQuiet(MOMENTUM_IDLE_MS, () => {
        spent = false;
        stopFollowing();
      });
      return;
    }
    if (gesture !== null) track(gesture, event);
  }

  const onWheel = (event: WheelEvent): void => {
    // A swipe under way is followed through its document's listener.
    if (gesture !== null || spent || !isHorizontal(event)) return;
    const card = cardAtPointer(event);
    if (card === null) return;
    if (wheelMomentum(event) === true) {
      event.preventDefault();
      return;
    }
    // Null while a mouse drag owns the card.
    const g = swipe.begin(card);
    if (g === null) return;
    gesture = g;
    swipeDocument = card.ownerDocument;
    swipeDocument.addEventListener('wheel', onSwipeWheel, {
      capture: true,
      passive: false,
    });
    track(g, event);
  };

  host.addEventListener('wheel', onWheel, { passive: false });
  return (): void => {
    clearTimeout(idleTimer);
    const g = gesture;
    stopFollowing();
    g?.end();
    host.removeEventListener('wheel', onWheel);
  };
};
