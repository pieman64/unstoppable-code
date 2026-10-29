/**
 * @jest-environment jsdom
 */
import {
  computePopoverViewportShift,
  findPopoverBoundary,
} from '@/lib/anchoredPopoverPosition';

/**
 * The popover is anchored to the archive icon with `right-0`, so it opens
 * down-and-LEFT. It is clipped by the nearest ancestor with a non-visible
 * overflow — for the worktree header that is
 * `section[data-testid="worktree-part"]` (`overflow: hidden`), whose left
 * edge is the CONTENT REGION, not the window. Clamping to the window alone
 * still left the card's leading text ("ARCHIVED CHATS") cut off there.
 */
describe('computePopoverViewportShift', () => {
  const PADDING = 8;
  const WINDOW: { left: number; right: number } = { left: 0, right: 1200 };

  it('leaves a fully visible card where it is', () => {
    expect(
      computePopoverViewportShift({
        left: 400,
        right: 720,
        boundary: WINDOW,
      }),
    ).toBe(0);
  });

  it('pushes a card back inside a boundary inset from the window', () => {
    // The real bug: the card clears the WINDOW (left 60 > 0) but is clipped
    // by the content region starting at 220.
    expect(
      computePopoverViewportShift({
        left: 60,
        right: 380,
        boundary: { left: 220, right: 1200 },
      }),
    ).toBe(220 + PADDING - 60);
  });

  it('pushes a left-overflowing card back inside the boundary', () => {
    expect(
      computePopoverViewportShift({
        left: -17,
        right: 303,
        boundary: WINDOW,
      }),
    ).toBe(PADDING + 17);
  });

  it('pulls a right-overflowing card back inside the boundary', () => {
    expect(
      computePopoverViewportShift({
        left: 900,
        right: 1220,
        boundary: WINDOW,
      }),
    ).toBe(-(1220 - (1200 - PADDING)));
  });

  it('favors the leading edge when the card cannot fit either way', () => {
    // Keeping the leading edge visible means the heading and titles stay
    // readable; the component also caps the width so this is a fallback.
    expect(
      computePopoverViewportShift({
        left: -40,
        right: 360,
        boundary: { left: 0, right: 300 },
      }),
    ).toBe(PADDING + 40);
  });

  it('treats an unmeasured card (all zeros) as needing no shift', () => {
    expect(
      computePopoverViewportShift({
        left: 0,
        right: 0,
        boundary: { left: 0, right: 0 },
      }),
    ).toBe(0);
  });
});

describe('findPopoverBoundary', () => {
  function buildTree(overflowX: string): HTMLElement {
    const clipper = document.createElement('div');
    clipper.style.overflowX = overflowX;
    clipper.getBoundingClientRect = (): DOMRect =>
      ({ left: 220, right: 900 }) as DOMRect;
    const card = document.createElement('div');
    clipper.appendChild(card);
    document.body.appendChild(clipper);
    return card;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the nearest clipping ancestor, intersected with the window', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    });
    expect(findPopoverBoundary(buildTree('hidden'))).toEqual({
      left: 220,
      right: 900,
    });
  });

  it('falls back to the window when no ancestor clips', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    });
    expect(findPopoverBoundary(buildTree('visible'))).toEqual({
      left: 0,
      right: 1000,
    });
  });
});
