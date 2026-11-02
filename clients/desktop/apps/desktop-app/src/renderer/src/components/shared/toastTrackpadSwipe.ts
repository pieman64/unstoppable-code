import type {
  ToastStackSwipeInput,
  ToastSwipeGesture,
} from '@canopy/ui-shared';

/**
 * A swipe that would bring the card back has ended once the wheel is quiet
 * this long. Trackpads send an event every frame while the fingers move.
 */
const IDLE_MS = 50;
/**
 * Past the dismiss line, wait longer before taking a quiet wheel as the
 * fingers lifting: resting fingers send nothing either, and a pause there
 * must not throw the card away.
 */
const IDLE_PAST_LINE_MS = 150;
/**
 * Steps that shrink this many times in a row are the OS coasting after the
 * fingers lifted: a card that would leave goes now, at its speed.
 */
const COASTING_STEPS = 3;

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

function isHorizontal(event: WheelEvent): boolean {
  return Math.abs(event.deltaX) > Math.abs(event.deltaY);
}

/**
 * Two-finger trackpad swipe to dismiss for the shared toast stack. Swipes
 * arrive as horizontal wheel events, which the stack's pointer swipe never
 * sees; this feeds them to the stack's swipe controller, so the card moves,
 * leaves and returns exactly as it does under a mouse drag.
 *
 * The card under the pointer when the swipe starts follows the fingers,
 * including the OS momentum after they lift, even once it has slid out from
 * under the pointer: later events are followed on the card's document. Each
 * swipe moves one card; its leftover momentum never carries the next one.
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
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopFollowing = (): void => {
    swipeDocument?.removeEventListener('wheel', onSwipeWheel, true);
    swipeDocument = null;
    gesture = null;
    lastStep = 0;
    coastingSteps = 0;
  };

  const waitForQuiet = (ms: number, then: () => void): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(then, ms);
  };

  const track = (g: ToastSwipeGesture, event: WheelEvent): void => {
    event.preventDefault();
    // Fingers moving toward the edge scroll the other way.
    const step = -sign * event.deltaX;
    coastingSteps =
      step > 0 && lastStep > 0 && step < lastStep ? coastingSteps + 1 : 0;
    lastStep = step;
    g.move(step);
    const lastInputAt = performance.now();
    if (!g.ended && coastingSteps >= COASTING_STEPS && g.wouldDismiss()) {
      g.end();
    }
    if (g.ended) {
      // Gone (half off, or coasting away): the rest of this swipe is spent.
      stopFollowing();
      spent = true;
      waitForQuiet(IDLE_MS, () => {
        spent = false;
      });
      return;
    }
    waitForQuiet(g.isPastLine() ? IDLE_PAST_LINE_MS : IDLE_MS, () => {
      stopFollowing();
      // Decided on the speed the fingers had, not one diluted by the wait.
      g.end(lastInputAt);
    });
  };

  function onSwipeWheel(event: WheelEvent): void {
    if (gesture === null || !isHorizontal(event)) return;
    track(gesture, event);
  }

  const onWheel = (event: WheelEvent): void => {
    // A swipe under way is followed through its document's listener.
    if (gesture !== null || !isHorizontal(event)) return;
    const card = isElementNode(event.target)
      ? event.target.closest<HTMLElement>(STACK_CARD_SELECTOR)
      : null;
    if (card === null) return;
    if (spent) {
      event.preventDefault();
      waitForQuiet(IDLE_MS, () => {
        spent = false;
      });
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
