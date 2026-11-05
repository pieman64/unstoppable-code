/**
 * Swipe to dismiss for the shared toast stack (`ToastStack`). One controller
 * owns a swipe from the moment the card moves until it has left or settled,
 * so a mouse drag here and a host's trackpad swipe (through `ToastSwipe`)
 * feel the same:
 *
 * - The card follows the input 1:1, from the first pointer move. Past its
 *   resting place it resists, like an overscrolled list.
 * - Nothing is decided until the input ends. The card leaves if it has gone a
 *   quarter of its width (or half its height) toward the screen edge, or is
 *   moving that way quickly; a quick flick back keeps it. Trackpad input
 *   uses the same release decision, so crossing a distance never prevents
 *   the user from pulling the card back before releasing.
 * - A dismissed card leaves at its release speed. A cancelled swipe returns
 *   promptly without overshoot. Both use interruptible CSS transitions.
 *   Base UI waits for the exit before unmounting.
 *   A leaving card goes all the way past the window edge, opaque until it is
 *   nearly there.
 * - The rest of the stack closes up shortly after the card starts to leave.
 * - A card that is still settling back is picked up where it is drawn.
 *
 * Toward the stack's side is the main direction; toward the stack's screen
 * edge (down for the bottom corners, up for the top ones) also dismisses.
 * The pointer only captures once a drag passes a few px, so a click on the
 * card stays a click. Under reduced motion the card still follows the input,
 * but leaves and returns at once (the shared rule in canopy-tokens-core.css).
 *
 * toast-stack.css reads `--toast-swipe-x` / `--toast-swipe-y` and the
 * `data-swipe-dragging`, `data-swipe-settling` and `data-swipe-flung` states.
 */

import { IN_APP_NOTIFICATION_WIDTH_PX } from '../lib/notification-placement';

/** The screen side the stack sits against. */
export type ToastSwipeSide = 'left' | 'right';
/** The screen edge the stack grows from. */
export type ToastSwipeEdge = 'top' | 'bottom';

export interface ToastSwipeOptions {
  readonly side: ToastSwipeSide;
  readonly edge: ToastSwipeEdge;
  /**
   * The card was swiped away. It is already leaving; the stack closes the
   * toast (`data-toast-stack-id` on the card) so the rest of the deck closes
   * up behind it.
   */
  readonly onDismiss: (toastId: string) => void;
  /**
   * A card was pressed (`held`), or the press ended. The stack holds the
   * toast's clock meanwhile, so a toast held on a touchscreen (which has no
   * hover to pause it) never closes under the finger.
   */
  readonly onHold?: (toastId: string, held: boolean) => void;
}

/** One sideways swipe a host drives itself (the desktop trackpad). */
export interface ToastSwipeGesture {
  /** Moves the card `step` px toward the stack's side (negative: away). */
  move(step: number): void;
  /** Whether letting go now, at the current speed, would dismiss the card. */
  wouldDismiss(): boolean;
  /** Whether the card is past the dismiss line, whatever its speed. */
  isPastLine(): boolean;
  /**
   * The input has ended: the card leaves or settles back. `inputEndedAt`
   * (a `performance.now()` time) is when the last input arrived, for a host
   * that only notices the end after a quiet spell: the decision then uses the
   * speed the input had, not one diluted by the wait.
   */
  end(inputEndedAt?: number): void;
  /** The gesture has ended through `end`. */
  readonly ended: boolean;
}

export interface ToastSwipe {
  /**
   * Starts a sideways swipe on `card` for input the host follows itself, or
   * returns null while another swipe owns the card.
   */
  begin(card: HTMLElement): ToastSwipeGesture | null;
  detach(): void;
}

/** Card fraction toward the side that dismisses on release. */
const DISMISS_FRACTION_X = 0.25;
/** Card fraction toward the screen edge that dismisses on release. */
const DISMISS_FRACTION_Y = 0.5;
/** Release speed toward the edge that dismisses whatever the distance, px/ms. */
const FLING_PX_PER_MS = 0.3;
/** Resistance past the resting place (0.55 is iOS's overscroll). */
const RUBBER_BAND = 0.55;
/** A drag owns the pointer (and is no longer a click) past this, px. */
const POINTER_SLOP_PX = 6;
/** Only a clearly vertical drag moves the card vertically. */
const VERTICAL_RATIO = 1.5;
/** One display frame, ms. */
const FRAME_MS = 16;
/** Release speed is measured over the input of this window, ms. */
const VELOCITY_WINDOW_MS = 80;
const EXIT_MS: readonly [number, number] = [160, 320];
const SETTLE_MS = 180;
/** A cancelled swipe must not pull a notification across the work surface. */
const MAX_OVERSCROLL_PX = 48;
/** Advance the live deck as soon as dismissal commits; exit can finish behind it. */
const REFLOW_DELAY_MS = 0;
/** Card size before layout (tests, a card not drawn yet): the stack's width. */
const FALLBACK_SIZE: Record<'x' | 'y', number> = {
  x: IN_APP_NOTIFICATION_WIDTH_PX,
  y: 72,
};
/** Room past the window edge for the card's shadow. */
const EXIT_SHADOW_PX = 24;
/** A leaving card always travels at least its size plus the corner inset. */
const EXIT_CLEARANCE_PX = 32;

const CARD_SELECTOR = '[data-toast-stack-id]';
const INTERACTIVE_SELECTOR =
  'button,a,input,textarea,select,[role="button"],[contenteditable="true"]';

type Axis = 'x' | 'y';

interface Sample {
  readonly t: number;
  readonly input: number;
}

interface Gesture {
  readonly card: HTMLElement;
  readonly axis: Axis;
  /** Card size along the axis; scales resistance and the dismiss line. */
  readonly size: number;
  /** Input travelled toward the edge, before resistance. */
  input: number;
  readonly samples: Sample[];
  readonly hostDriven: boolean;
  ended: boolean;
}

interface PendingPointer {
  readonly card: HTMLElement;
  readonly pointerId: number;
  /** When the press started: the first speed sample of its drag. */
  readonly downAt: number;
  readonly startX: number;
  readonly startY: number;
  /** Past the slop: the drag owns the pointer and its axis is fixed. */
  axis: Axis | null;
  startInput: { x: number; y: number };
  /** Stops following the press: listeners off, selection and clock back. */
  readonly stop: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

/** Drawn offset for an input offset: free toward the edge, resisting away. */
export function toastSwipeRubberBand(input: number, size: number): number {
  if (input >= 0 || size <= 0) return input;
  const over = -input;
  const limit = Math.min(size, MAX_OVERSCROLL_PX);
  return -(1 - 1 / ((over * RUBBER_BAND) / limit + 1)) * limit;
}

function unRubberBand(shown: number, size: number): number {
  if (shown >= 0 || size <= 0) return shown;
  const limit = Math.min(size, MAX_OVERSCROLL_PX);
  const x = Math.min(-shown, limit * 0.99);
  return -((limit / RUBBER_BAND) * (1 / (1 - x / limit) - 1));
}

/**
 * Input speed over the last moments before `now`, in px/ms toward the edge.
 * Only the latest run in one direction counts: a quick flick back after a
 * long drag out reads as moving back, not as the average of both.
 */
export function toastSwipeVelocity(
  samples: readonly Sample[],
  now: number,
): number {
  const recent = samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS);
  const last = recent[recent.length - 1];
  if (last === undefined) return 0;
  // Walk back while the input keeps moving the way it last moved.
  let direction = 0;
  let first = last;
  for (let i = recent.length - 2; i >= 0; i -= 1) {
    const sample = recent[i];
    const next = recent[i + 1];
    if (sample === undefined || next === undefined) break;
    const step = Math.sign(next.input - sample.input);
    if (step !== 0) {
      if (direction === 0) direction = step;
      else if (step !== direction) break;
    }
    first = sample;
  }
  if (first === last) return 0;
  // Time runs to `now`: input that stopped before the release slows it down.
  return (last.input - first.input) / Math.max(now - first.t, 8);
}

/**
 * The decision when a swipe ends: `offset` is how far the card is drawn
 * toward the edge, `velocity` its speed that way, `size` its size on the axis.
 */
export function toastSwipeDismisses(
  axis: Axis,
  offset: number,
  velocity: number,
  size: number,
): boolean {
  if (velocity <= -FLING_PX_PER_MS) return false;
  const far =
    offset >= size * (axis === 'x' ? DISMISS_FRACTION_X : DISMISS_FRACTION_Y);
  return far || (velocity >= FLING_PX_PER_MS && offset > 8);
}

/** A CSS `cubic-bezier(x1, y1, x2, y2)` easing. */
type Easing = readonly [number, number, number, number];

/** An ease that starts at `slope` × the average speed, then eases out to `tail`. */
function speedEase(slope: number, tail: readonly [number, number]): Easing {
  const s = clamp(slope, -2, 6);
  const x1 = s > 1 ? Math.min(0.3, 1 / s) : 0.3;
  return [x1, x1 * s, tail[0], tail[1]];
}

function easingCss([x1, y1, x2, y2]: Easing): string {
  return `cubic-bezier(${[x1, y1, x2, y2].map((v) => v.toFixed(3)).join(', ')})`;
}

/** Progress of `easing` at time fraction `x` (Newton's method on the curve). */
export function toastSwipeEasingAt(
  [x1, y1, x2, y2]: Easing,
  x: number,
): number {
  const at = (a: number, b: number, t: number): number =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const progress = clamp(x, 0, 1);
  let t = progress;
  for (let i = 0; i < 8; i += 1) {
    const error = at(x1, x2, t) - progress;
    const slope =
      3 * x1 * (1 - t) ** 2 +
      6 * (x2 - x1) * t * (1 - t) +
      3 * (1 - x2) * t * t;
    if (Math.abs(error) < 1e-4 || slope === 0) break;
    t = clamp(t - error / slope, 0, 1);
  }
  return at(y1, y2, t);
}

/** A card on its way back to its place: where it set off and how. */
interface Settling {
  readonly axis: Axis;
  readonly from: number;
  readonly start: number;
  readonly duration: number;
  readonly easing: Easing;
}

function preventDefault(event: Event): void {
  event.preventDefault();
}

function prefersReducedMotion(view: Window | null): boolean {
  return (
    view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Attaches swipe to dismiss to the stack rendered inside `host`, whose cards
 * carry `data-toast-stack-id`.
 */
export function attachToastSwipe(
  host: HTMLElement,
  { side, edge, onDismiss, onHold }: ToastSwipeOptions,
): ToastSwipe {
  const sign: Record<Axis, number> = {
    x: side === 'right' ? 1 : -1,
    y: edge === 'bottom' ? 1 : -1,
  };
  const varName = (axis: Axis): string => `--toast-swipe-${axis}`;
  let gesture: Gesture | null = null;
  let pending: PendingPointer | null = null;
  let suppressClick = false;
  let detached = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settleTimers = new WeakMap<
    HTMLElement,
    ReturnType<typeof setTimeout>
  >();
  const settlingCards = new Map<HTMLElement, Settling>();

  const later = (
    ms: number,
    run: () => void,
  ): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const shownOf = (g: Gesture): number => toastSwipeRubberBand(g.input, g.size);

  const write = (g: Gesture): void => {
    g.card.style.setProperty(
      varName(g.axis),
      `${String(sign[g.axis] * shownOf(g))}px`,
    );
  };

  const clearSwipeState = (card: HTMLElement): void => {
    card.removeAttribute('data-swipe-dragging');
    card.removeAttribute('data-swipe-settling');
    card.style.removeProperty(varName('x'));
    card.style.removeProperty(varName('y'));
    card.style.removeProperty('--toast-swipe-ms');
    card.style.removeProperty('--toast-swipe-ease');
  };

  /** `since`: when the input started, the first speed sample. */
  const begin = (
    card: HTMLElement,
    axis: Axis,
    hostDriven: boolean,
    since: number = performance.now(),
  ): Gesture => {
    const timer = settleTimers.get(card);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(timer);
    }
    const rect = card.getBoundingClientRect();
    const size =
      (axis === 'x' ? rect.width : rect.height) || FALLBACK_SIZE[axis];
    // Pick the card up where it is drawn, even partway back to its place.
    const settling = settlingCards.get(card);
    settlingCards.delete(card);
    const drawn =
      settling?.axis === axis
        ? settling.from *
          (1 -
            toastSwipeEasingAt(
              settling.easing,
              (performance.now() - settling.start) / settling.duration,
            ))
        : 0;
    card.removeAttribute('data-swipe-settling');
    card.setAttribute('data-swipe-dragging', '');
    const input = unRubberBand(drawn, size);
    const g: Gesture = {
      card,
      axis,
      size,
      input,
      // Where the input started, so even a flick of one move has a speed.
      samples: [{ t: since, input }],
      hostDriven,
      ended: false,
    };
    write(g);
    return g;
  };

  // Input is timed by the clock the release reads, not `event.timeStamp`.
  const track = (g: Gesture, input: number): void => {
    g.input = input;
    g.samples.push({ t: performance.now(), input });
    if (g.samples.length > 32) g.samples.shift();
    write(g);
  };

  const exit = (g: Gesture, velocity: number): void => {
    const { card, axis } = g;
    const shown = shownOf(g);
    const view = card.ownerDocument.defaultView;
    const rect = card.getBoundingClientRect();
    // Clear of the window edge, shadow included, measured from the resting
    // place (the card is drawn `shown` px toward the edge already).
    let restToEdge = g.size + EXIT_CLEARANCE_PX;
    if (view !== null) {
      const drawnShift = sign[axis] * shown;
      if (axis === 'x') {
        restToEdge =
          sign.x === 1
            ? view.innerWidth - (rect.left - drawnShift)
            : rect.right - drawnShift;
      } else {
        restToEdge =
          sign.y === 1
            ? view.innerHeight - (rect.top - drawnShift)
            : rect.bottom - drawnShift;
      }
    }
    const target = Math.max(
      g.size + EXIT_CLEARANCE_PX,
      restToEdge + EXIT_SHADOW_PX,
    );
    const remaining = Math.max(target - shown, 1);
    const speed = Math.max(velocity, 0);
    const [min, max] = EXIT_MS;
    // On average a little slower than the release: the curve eases out.
    const duration = clamp(
      remaining / Math.max(speed * 0.6, remaining / max),
      min,
      max,
    );
    card.removeAttribute('data-swipe-dragging');
    card.style.setProperty('--toast-swipe-ms', `${duration.toFixed(0)}ms`);
    card.style.setProperty(
      '--toast-swipe-ease',
      easingCss(speedEase((speed * duration) / remaining, [0.55, 1])),
    );
    card.setAttribute('data-swipe-flung', '');
    card.style.setProperty(varName(axis), `${String(sign[axis] * target)}px`);
    const toastId = card.getAttribute('data-toast-stack-id');
    if (toastId === null) return;
    const delay = prefersReducedMotion(view)
      ? 0
      : Math.min(REFLOW_DELAY_MS, duration);
    // Not cancelled by `detach`: a card already leaving must still close.
    setTimeout(() => onDismiss(toastId), delay);
  };

  const settle = (g: Gesture): void => {
    const { card, axis } = g;
    const shown = shownOf(g);
    card.removeAttribute('data-swipe-dragging');
    // Under reduced motion the card is home at once (the shared rule ends
    // the transition), so there is no return to pick it up from.
    if (
      Math.abs(shown) < 0.5 ||
      prefersReducedMotion(card.ownerDocument.defaultView)
    ) {
      clearSwipeState(card);
      return;
    }
    // A cancelled swipe goes straight home; release momentum must not carry
    // it farther away first. Keep this curve monotonic and interruptible.
    const duration = SETTLE_MS;
    const easing: Easing = [0.22, 1, 0.36, 1];
    card.style.setProperty('--toast-swipe-ms', `${duration.toFixed(0)}ms`);
    card.style.setProperty('--toast-swipe-ease', easingCss(easing));
    card.setAttribute('data-swipe-settling', '');
    settlingCards.set(card, {
      axis,
      from: shown,
      start: performance.now(),
      duration,
      easing,
    });
    card.style.setProperty(varName(axis), '0px');
    settleTimers.set(
      card,
      later(duration + 20, () => {
        settleTimers.delete(card);
        settlingCards.delete(card);
        clearSwipeState(card);
      }),
    );
  };

  const finish = (
    g: Gesture,
    cancelled = false,
    inputEndedAt?: number,
  ): void => {
    if (g.ended) return;
    g.ended = true;
    if (gesture === g) gesture = null;
    const now = performance.now();
    // The card moves on at the speed it has now; the decision may look at
    // the speed the input had when it ended.
    const velocity = cancelled ? 0 : toastSwipeVelocity(g.samples, now);
    const decidingVelocity =
      cancelled || inputEndedAt === undefined
        ? velocity
        : toastSwipeVelocity(g.samples, Math.min(inputEndedAt, now));
    if (
      !cancelled &&
      toastSwipeDismisses(g.axis, shownOf(g), decidingVelocity, g.size)
    ) {
      exit(g, velocity);
    } else {
      settle(g);
    }
  };

  // ---- Pointer (mouse, pen, touch) ----
  /**
   * Presses on a card's own controls that hold its clock: each release, by
   * the pointer it waits for.
   */
  const controlHolds = new Map<() => void, number>();

  /**
   * Calls `onMoved` once if `card` leaves `doc` while a press is open: the
   * desktop overlay layer can adopt the stack into another document, where
   * the press's document listeners never hear the release. Checked once a
   * frame, only while a press is open. Returns the stop.
   */
  const watchDocument = (
    card: HTMLElement,
    doc: Document,
    onMoved: () => void,
  ): (() => void) => {
    const view = doc.defaultView;
    if (view === null) return (): void => undefined;
    let frame = 0;
    const check = (): void => {
      if (card.ownerDocument !== doc || !card.isConnected) {
        frame = 0;
        onMoved();
        return;
      }
      frame = view.requestAnimationFrame(check);
    };
    frame = view.requestAnimationFrame(check);
    return (): void => {
      if (frame !== 0) view.cancelAnimationFrame(frame);
      frame = 0;
    };
  };

  /**
   * A press on a card's own button never drags it, but still holds its
   * clock until the press ends anywhere, so a toast never closes under a
   * finger on its action.
   */
  const holdWhilePressed = (card: HTMLElement, pointerId: number): void => {
    const toastId = card.getAttribute('data-toast-stack-id');
    if (toastId === null || onHold === undefined) return;
    const doc = card.ownerDocument;
    const onRelease = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) release();
    };
    const release = (): void => {
      stopWatching();
      doc.removeEventListener('pointerup', onRelease, true);
      doc.removeEventListener('pointercancel', onRelease, true);
      controlHolds.delete(release);
      onHold(toastId, false);
    };
    doc.addEventListener('pointerup', onRelease, true);
    doc.addEventListener('pointercancel', onRelease, true);
    const stopWatching = watchDocument(card, doc, release);
    controlHolds.set(release, pointerId);
    onHold(toastId, true);
  };

  /**
   * Ends a press that lost track of its pointer: the desktop overlay layer
   * can move the stack to another document mid-press, where the document
   * listeners never hear the release. The card goes back and the clock runs.
   */
  const cancelStalePresses = (): void => {
    for (const release of Array.from(controlHolds.keys())) release();
    const p = pending;
    if (p === null) return;
    pending = null;
    p.stop();
    const g = gesture;
    if (g === null || g.hostDriven) return;
    gesture = null;
    g.ended = true;
    settle(g);
  };

  /**
   * A release seen by the stack itself: these listeners move with the stack
   * when it changes documents, so a press released on it always ends.
   */
  const onHostRelease = (event: PointerEvent): void => {
    onPointerEnd(event);
    for (const [release, pointerId] of Array.from(controlHolds)) {
      if (pointerId === event.pointerId) release();
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !isElementNode(event.target)) return;
    const card = event.target.closest<HTMLElement>(CARD_SELECTOR);
    if (card === null || !host.contains(card)) return;
    // A new press means any earlier one has ended, heard or not.
    cancelStalePresses();
    if (event.target.closest(INTERACTIVE_SELECTOR)) {
      holdWhilePressed(card, event.pointerId);
      return;
    }
    if (gesture !== null || pending !== null) return;
    if (
      card.hasAttribute('data-swipe-flung') ||
      card.hasAttribute('data-ending-style')
    ) {
      return;
    }
    // The press is followed on the whole document: the pointer is only
    // captured past the slop, and a press released outside the stack must
    // still end. It never starts a text selection that the drag would then
    // stretch across the page.
    const doc = card.ownerDocument;
    doc.addEventListener('selectstart', preventDefault, true);
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerEnd, true);
    doc.addEventListener('pointercancel', onPointerEnd, true);
    const toastId = card.getAttribute('data-toast-stack-id');
    if (toastId !== null) onHold?.(toastId, true);
    // Moved to another document mid-press: the release won't be heard here.
    const stopWatching = watchDocument(card, doc, cancelStalePresses);
    pending = {
      card,
      pointerId: event.pointerId,
      downAt: performance.now(),
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      startInput: { x: 0, y: 0 },
      stop: (): void => {
        stopWatching();
        doc.removeEventListener('selectstart', preventDefault, true);
        doc.removeEventListener('pointermove', onPointerMove, true);
        doc.removeEventListener('pointerup', onPointerEnd, true);
        doc.removeEventListener('pointercancel', onPointerEnd, true);
        if (toastId !== null) onHold?.(toastId, false);
      },
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const p = pending;
    if (p === null || event.pointerId !== p.pointerId) return;
    const dx = event.clientX - p.startX;
    const dy = event.clientY - p.startY;
    if (p.axis === null && Math.hypot(dx, dy) >= POINTER_SLOP_PX) {
      // Decide the axis over the whole slop, favouring sideways.
      p.axis = Math.abs(dy) > Math.abs(dx) * VERTICAL_RATIO ? 'y' : 'x';
      if (gesture !== null && gesture.axis !== p.axis) {
        // The card followed the wrong axis for a few px; start over on this one.
        const wrong = gesture;
        gesture = null;
        wrong.card.style.removeProperty(varName(wrong.axis));
      }
      try {
        p.card.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic or already-released pointer: the drag still works.
      }
    }
    // Follow from the very first move, sideways until the axis is decided.
    const axis = p.axis ?? 'x';
    if (gesture === null) {
      gesture = begin(p.card, axis, false, p.downAt);
      p.startInput[axis] = gesture.input;
    } else if (gesture.hostDriven) {
      return;
    }
    event.preventDefault();
    const delta = axis === 'x' ? dx : dy;
    track(gesture, p.startInput[axis] + sign[axis] * delta);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    const p = pending;
    if (p === null || event.pointerId !== p.pointerId) return;
    pending = null;
    p.stop();
    const g = gesture;
    if (g === null || g.hostDriven) return;
    if (p.axis === null) {
      // A click that wobbled a few px: the card goes back, the click stays.
      gesture = null;
      g.ended = true;
      settle(g);
      return;
    }
    // The press was a drag, not a click on the card.
    suppressClick = true;
    later(0, () => {
      suppressClick = false;
    });
    finish(g, event.type === 'pointercancel');
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (pending !== null && pending.axis !== null) event.preventDefault();
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) return;
    event.stopPropagation();
    event.preventDefault();
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointerup', onHostRelease);
  host.addEventListener('pointercancel', onHostRelease);
  host.addEventListener('click', onClick, true);
  host.addEventListener('touchmove', onTouchMove, { passive: false });

  return {
    begin(card: HTMLElement): ToastSwipeGesture | null {
      if (detached || gesture !== null || pending !== null) return null;
      if (!host.contains(card) || card.hasAttribute('data-swipe-flung'))
        return null;
      if (card.hasAttribute('data-ending-style')) return null;
      // The host's first step counts as one frame of input.
      const g = begin(card, 'x', true, performance.now() - FRAME_MS);
      gesture = g;
      return {
        move(step: number): void {
          if (g.ended) return;
          track(g, g.input + step);
        },
        wouldDismiss(): boolean {
          return toastSwipeDismisses(
            'x',
            shownOf(g),
            toastSwipeVelocity(g.samples, performance.now()),
            g.size,
          );
        },
        isPastLine(): boolean {
          return toastSwipeDismisses('x', shownOf(g), 0, g.size);
        },
        end(inputEndedAt?: number): void {
          finish(g, false, inputEndedAt);
        },
        get ended(): boolean {
          return g.ended;
        },
      };
    },
    detach(): void {
      detached = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointerup', onHostRelease);
      host.removeEventListener('pointercancel', onHostRelease);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('touchmove', onTouchMove);
      pending?.stop();
      for (const release of Array.from(controlHolds.keys())) release();
      // Nothing will finish what was under way: put those cards back.
      if (gesture !== null) clearSwipeState(gesture.card);
      for (const card of settlingCards.keys()) clearSwipeState(card);
      settlingCards.clear();
      gesture = null;
      pending = null;
    },
  };
}
