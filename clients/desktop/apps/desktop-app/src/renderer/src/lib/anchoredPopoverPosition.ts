/**
 * Geometry for popovers that stay ANCHORED to their trigger (same wrapper)
 * instead of being portaled — the archived-chats hover card, whose pointer
 * bridge between icon and card depends on that shared wrapper.
 *
 * Such a card is clipped by the nearest ancestor with a non-visible overflow,
 * which is often NOT the window: in the worktree header the clipper is
 * `section[data-testid="worktree-part"]` (`overflow: hidden`), whose left edge
 * is the content region. Clamping to the window alone still left the card's
 * leading text cut off by that ancestor.
 */

/** Gap kept between the card and the edge that would clip it. */
export const ANCHORED_POPOVER_PADDING = 8;

export interface PopoverBoundary {
  left: number;
  right: number;
}

/**
 * Horizontal correction (px) that brings an anchored card inside `boundary`,
 * or `0` when it already fits.
 */
export function computePopoverViewportShift(rect: {
  left: number;
  right: number;
  boundary: PopoverBoundary;
  padding?: number;
}): number {
  const padding = rect.padding ?? ANCHORED_POPOVER_PADDING;
  // An unmeasured card (pre-layout, or jsdom) reports all zeros — leave it be
  // rather than inventing a shift from meaningless numbers.
  if (rect.boundary.right <= rect.boundary.left) return 0;
  const minLeft = rect.boundary.left + padding;
  const maxRight = rect.boundary.right - padding;
  // Overflowing the LEFT edge wins when the card cannot fit either way: the
  // heading and chat titles start there, so that is the edge worth keeping.
  if (rect.left < minLeft) return minLeft - rect.left;
  if (rect.right > maxRight) return maxRight - rect.right;
  return 0;
}

/**
 * The rect that will actually clip the card: every ancestor whose horizontal
 * overflow is not `visible`, intersected with the window. Falls back to the
 * window when nothing clips.
 */
export function findPopoverBoundary(element: HTMLElement): PopoverBoundary {
  const view = element.ownerDocument.defaultView;
  const viewportRight = view?.innerWidth ?? 0;
  let boundary: PopoverBoundary = { left: 0, right: viewportRight };

  for (
    let ancestor = element.parentElement;
    ancestor !== null && ancestor !== element.ownerDocument.documentElement;
    ancestor = ancestor.parentElement
  ) {
    const overflowX = view?.getComputedStyle(ancestor).overflowX;
    // Allowlist the values that actually clip, rather than skipping only
    // `visible`: an unstyled element can report an EMPTY string, and treating
    // that as clipping collapsed the boundary onto a zero-sized ancestor.
    if (
      overflowX !== 'hidden' &&
      overflowX !== 'clip' &&
      overflowX !== 'auto' &&
      overflowX !== 'scroll' &&
      overflowX !== 'overlay'
    ) {
      continue;
    }
    const rect = ancestor.getBoundingClientRect();
    // A zero-area rect carries no usable boundary (unlaid-out ancestors).
    if (rect.right <= rect.left) continue;
    boundary = {
      left: Math.max(boundary.left, rect.left),
      right: Math.min(boundary.right, rect.right),
    };
  }

  return boundary;
}
