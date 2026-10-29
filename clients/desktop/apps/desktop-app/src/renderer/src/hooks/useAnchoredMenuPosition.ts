import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { getWindow } from '@canopy/ui-shared/panels';
import { useWindowPositionInvalidation } from './useWindowPositionInvalidation';

export interface AnchoredMenuPosition {
  top: number;
  left: number;
  /**
   * The height the menu can occupy in the chosen placement direction without
   * running off the viewport. Callers that can grow tall (e.g. the model
   * picker) should apply this as `max-height` with `overflow-y: auto` so the
   * menu scrolls internally on small windows instead of being clipped.
   */
  maxHeight: number;
}

const DEFAULT_MENU_GAP = 8;
const DEFAULT_VIEWPORT_PADDING = 8;
/** Floor so a cramped viewport still yields a usable (scrollable) menu. */
const MIN_MENU_HEIGHT = 96;

function computeAnchoredMenuPosition(
  anchorEl: HTMLElement,
  menuEl: HTMLElement | null,
  menuWidth: number,
): AnchoredMenuPosition {
  const rect = anchorEl.getBoundingClientRect();
  const menuHeight = menuEl ? menuEl.offsetHeight : 0;
  // The anchor's rect is relative to ITS window's viewport, so the viewport
  // clamps must use that same window's dimensions. In a popped-out panel that
  // is the aux window; `getWindow` returns the main window for main-window
  // anchors, so behavior there is unchanged.
  const view = getWindow(anchorEl);

  // Room available on each side of the anchor, discounting the gap + edge pad.
  const availableAbove = rect.top - DEFAULT_MENU_GAP - DEFAULT_VIEWPORT_PADDING;
  const availableBelow =
    view.innerHeight -
    rect.bottom -
    DEFAULT_MENU_GAP -
    DEFAULT_VIEWPORT_PADDING;

  // Prefer above when the menu fits there (preserves the existing placement);
  // otherwise below if it fits; otherwise the side with more room, where the
  // menu will be capped to `maxHeight` and scroll.
  let shouldPlaceBelow: boolean;
  if (menuHeight <= availableAbove) {
    shouldPlaceBelow = false;
  } else if (menuHeight <= availableBelow) {
    shouldPlaceBelow = true;
  } else {
    shouldPlaceBelow = availableBelow > availableAbove;
  }

  const maxHeight = Math.max(
    MIN_MENU_HEIGHT,
    shouldPlaceBelow ? availableBelow : availableAbove,
  );
  // The height actually rendered once `maxHeight` caps overflowing content;
  // positioning clamps against this so a capped menu stays fully on-screen.
  const effectiveHeight = menuEl ? Math.min(menuHeight, maxHeight) : 0;

  const preferredTop = shouldPlaceBelow
    ? rect.bottom + DEFAULT_MENU_GAP
    : rect.top - DEFAULT_MENU_GAP - effectiveHeight;
  const maxTop = Math.max(
    DEFAULT_VIEWPORT_PADDING,
    view.innerHeight - effectiveHeight - DEFAULT_VIEWPORT_PADDING,
  );
  const top = Math.min(
    Math.max(DEFAULT_VIEWPORT_PADDING, preferredTop),
    maxTop,
  );
  const maxLeft = Math.max(
    DEFAULT_VIEWPORT_PADDING,
    view.innerWidth - menuWidth - DEFAULT_VIEWPORT_PADDING,
  );
  const left = Math.min(Math.max(DEFAULT_VIEWPORT_PADDING, rect.left), maxLeft);

  return { top, left, maxHeight };
}

export function useAnchoredMenuPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  menuWidth: number,
): AnchoredMenuPosition | null {
  const [position, setPosition] = useState<AnchoredMenuPosition | null>(null);
  // The window the anchor lives in, resolved once the menu opens. Drives which
  // window's scroll/resize invalidate the position (see below).
  const [ownerWindow, setOwnerWindow] = useState<Window | null>(null);

  const updatePosition = useCallback((): void => {
    const anchorEl = anchorRef.current;
    if (!anchorEl) return;

    const next = computeAnchoredMenuPosition(
      anchorEl,
      menuRef.current,
      menuWidth,
    );
    setPosition((prev) => {
      if (
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.maxHeight === next.maxHeight
      ) {
        return prev;
      }
      return next;
    });
  }, [anchorRef, menuRef, menuWidth]);

  useLayoutEffect((): void => {
    if (!open) {
      setOwnerWindow(null);
      return;
    }
    setOwnerWindow(getWindow(anchorRef.current));
    updatePosition();
  }, [open, anchorRef, updatePosition]);

  // Recompute when the menu's content resizes (e.g. async data loads change
  // height). Without this, an above-anchored menu drawn at its initial small
  // height stays anchored to the wrong y and overlaps the trigger once the
  // content grows.
  useLayoutEffect((): (() => void) | void => {
    if (!open) return;
    const menuEl = menuRef.current;
    if (!menuEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updatePosition());
    observer.observe(menuEl);
    return (): void => observer.disconnect();
  }, [open, menuRef, updatePosition]);

  useWindowPositionInvalidation(open, updatePosition, ownerWindow);

  return position;
}
