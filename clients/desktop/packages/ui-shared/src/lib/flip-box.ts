import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** An element's layout box within its parent, untouched by transforms. */
interface LayoutBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FlipBoxOptions {
  readonly durationMs: number;
  readonly easing: string;
  /**
   * Take this render's box at once, without motion, stopping any slide in
   * flight: a box that moved because its container resized, not because the
   * user picked a new place for it.
   */
  readonly snap?: boolean;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Realm-neutral, for an element rendered into an auxiliary window. */
function isHtmlElement(node: Element): node is HTMLElement {
  return 'offsetLeft' in node && 'offsetParent' in node;
}

/**
 * The box relative to the element's parent rather than its offset parent, so
 * a fill whose whole row moves (a list re-sorting) is not mistaken for a fill
 * that moved within its track.
 */
function layoutBoxOf(element: HTMLElement): LayoutBox {
  const parent = element.parentElement;
  const shared =
    parent !== null &&
    isHtmlElement(parent) &&
    element.offsetParent !== parent &&
    parent.offsetParent === element.offsetParent;
  return {
    left: element.offsetLeft - (shared ? parent.offsetLeft : 0),
    top: element.offsetTop - (shared ? parent.offsetTop : 0),
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

function sameBox(a: LayoutBox, b: LayoutBox): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * Where the element is drawn right now: its last layout box moved and
 * stretched by whatever part of a previous slide is still running, so a new
 * slide picks up mid-flight instead of jumping back to where that one began.
 */
function drawnBoxOf(element: HTMLElement, laidOut: LayoutBox): LayoutBox {
  const view = element.ownerDocument.defaultView;
  const transform = view?.getComputedStyle(element).transform;
  if (!view || !transform || transform === 'none') return laidOut;
  const matrix = new view.DOMMatrixReadOnly(transform);
  return {
    left: laidOut.left + matrix.e,
    top: laidOut.top + matrix.f,
    width: laidOut.width * matrix.a,
    height: laidOut.height * matrix.d,
  };
}

function reducedMotion(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  return (
    typeof view?.matchMedia === 'function' &&
    view.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * Moves or resizes a box on the compositor rather than by animating
 * `left`/`width`: the element is laid out at its new box at once, then drawn
 * from its old box back to rest with a translate and scale, so the motion
 * stays smooth while the main thread is busy and the element is exact once it
 * lands. The element must rest without a transform of its own and set its
 * `transform-origin` to its top-left corner (`origin-top-left`).
 *
 * Runs after every render and animates only when the layout box changed; the
 * first box an element is drawn in never animates, and neither does a resize
 * of its container between renders, which the box simply follows, or a
 * render that asks to `snap`.
 */
export function useFlipBox(
  ref: RefObject<HTMLElement | null>,
  { durationMs, easing, snap = false }: FlipBoxOptions,
): void {
  const previousRef = useRef<{
    readonly element: HTMLElement;
    readonly box: LayoutBox;
  } | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const observerRef = useRef<{
    readonly element: HTMLElement;
    readonly observer: ResizeObserver;
  } | null>(null);

  useEffect(
    () => (): void => {
      observerRef.current?.observer.disconnect();
      observerRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const element = ref.current;
    if (observerRef.current?.element !== element) {
      observerRef.current?.observer.disconnect();
      observerRef.current = null;
      const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
      if (element && typeof Observer === 'function') {
        // A container resize moves the box without a render; take that box
        // as the next starting point instead of sliding from a stale one.
        const observer = new Observer(() => {
          if (previousRef.current?.element === element) {
            previousRef.current = { element, box: layoutBoxOf(element) };
          }
        });
        observer.observe(element);
        observerRef.current = { element, observer };
      }
    }
    if (!element) {
      previousRef.current = null;
      return;
    }
    const next = layoutBoxOf(element);
    const previous =
      previousRef.current?.element === element ? previousRef.current.box : null;
    previousRef.current = { element, box: next };
    if (!previous || sameBox(previous, next)) return;
    const from = snap ? next : drawnBoxOf(element, previous);
    animationRef.current?.cancel();
    animationRef.current = null;
    if (
      snap ||
      next.width <= 0 ||
      next.height <= 0 ||
      typeof element.animate !== 'function' ||
      reducedMotion(element)
    ) {
      return;
    }
    const dx = from.left - next.left;
    const dy = from.top - next.top;
    const sx = from.width / next.width;
    const sy = from.height / next.height;
    animationRef.current = element.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: 'none' },
      ],
      { duration: durationMs, easing },
    );
  });
}
