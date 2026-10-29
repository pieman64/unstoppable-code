import { useCallback, useRef, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';

const RING_PADDING = 6;
const RING_RADIUS = 8;

export interface AnchorHighlightRingProps {
  /**
   * Finds the element to ring. Called again whenever the last element left
   * the document, so an anchor that React re-creates is found; null draws
   * nothing.
   */
  resolveAnchor: () => HTMLElement | null;
  /** Space between the anchor's box and the ring, in pixels. */
  padding?: number;
  testId?: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clips(overflow: string): boolean {
  return overflow !== '' && overflow !== 'visible';
}

/**
 * The part of the anchor's box its scroll containers show. A ring drawn from
 * the raw box would follow an anchor scrolled out of the sidebar and sit over
 * the header or the composer.
 */
function visibleBox(anchor: HTMLElement): Box | null {
  const rect = anchor.getBoundingClientRect();
  let { left, top, right, bottom } = rect;
  for (
    let node = anchor.parentElement;
    node !== null && node !== document.body;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    const clipX = clips(style.overflowX);
    const clipY = clips(style.overflowY);
    if (!clipX && !clipY) continue;
    const bounds = node.getBoundingClientRect();
    if (clipX) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (clipY) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

/** The box as one comparable string, so equal boxes skip a render. */
function boxKey(box: Box | null): string {
  return box ? [box.left, box.top, box.width, box.height].join(',') : '';
}

function serverBox(): string {
  return '';
}

/**
 * The accent ring the desktop tour and spotlight draw around the element a
 * step points at. It is an overlay in a portal, positioned from the anchor's
 * visible box, so a scroll region cannot clip it and the anchor's own focus
 * styles cannot hide it; styling the anchor itself does both. It follows the
 * anchor through resizes, scrolls, layout changes above it and transitions,
 * stays within the anchor's scroll containers, and never takes pointer
 * events.
 */
export function AnchorHighlightRing({
  resolveAnchor,
  padding = RING_PADDING,
  testId,
}: AnchorHighlightRingProps): JSX.Element | null {
  // Resolving is a document query; keep the element while the same resolver
  // is in force and the element is still in the document, rather than query
  // on every scroll. A new resolver (the next tour stop) resolves afresh.
  const cached = useRef<{
    resolve: () => HTMLElement | null;
    element: HTMLElement | null;
  } | null>(null);
  // The observer of the current subscription, so a re-resolved element is
  // watched too and not only the one found when the subscription began.
  const observerRef = useRef<ResizeObserver | null>(null);
  const anchor = useCallback((): HTMLElement | null => {
    const current = cached.current;
    if (
      current !== null &&
      current.resolve === resolveAnchor &&
      current.element?.isConnected
    )
      return current.element;
    const element = resolveAnchor();
    cached.current = { resolve: resolveAnchor, element };
    if (element) observerRef.current?.observe(element);
    return element;
  }, [resolveAnchor]);
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(onChange);
      observerRef.current = observer;
      const element = anchor();
      if (element) observer?.observe(element);
      // The body resizes when content above the anchor grows or shrinks.
      observer?.observe(document.body);
      // A sidebar collapsing or a panel sliding moves the anchor without a
      // resize of its own; a transition elsewhere on the page does not.
      const onMotionEnd = (event: Event): void => {
        const element = cached.current?.element ?? null;
        if (
          element === null ||
          !(event.target instanceof Node) ||
          event.target.contains(element) ||
          element.contains(event.target)
        )
          onChange();
      };
      window.addEventListener('resize', onChange);
      window.addEventListener('scroll', onChange, true);
      window.addEventListener('transitionend', onMotionEnd, true);
      window.addEventListener('animationend', onMotionEnd, true);
      return (): void => {
        observer?.disconnect();
        if (observerRef.current === observer) observerRef.current = null;
        window.removeEventListener('resize', onChange);
        window.removeEventListener('scroll', onChange, true);
        window.removeEventListener('transitionend', onMotionEnd, true);
        window.removeEventListener('animationend', onMotionEnd, true);
      };
    },
    [anchor],
  );
  const key = useSyncExternalStore(
    subscribe,
    () => {
      const element = anchor();
      return element ? boxKey(visibleBox(element)) : '';
    },
    serverBox,
  );
  if (key === '') return null;
  const [left = 0, top = 0, width = 0, height = 0] = key.split(',').map(Number);
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-spotlight"
      role="presentation"
      data-testid={testId}
    >
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        <rect
          x={left - padding}
          y={top - padding}
          width={width + padding * 2}
          height={height + padding * 2}
          rx={RING_RADIUS}
          fill="none"
          stroke="var(--fg-accent)"
          strokeWidth="1.5"
        />
      </svg>
    </div>,
    document.body,
  );
}
