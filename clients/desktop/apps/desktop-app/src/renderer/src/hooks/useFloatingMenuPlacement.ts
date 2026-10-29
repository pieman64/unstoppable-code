import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import {
  computeFloatingMenuPosition,
  type FloatingMenuPlacement,
  type FloatingMenuPosition,
} from '@canopy/ui-shared';
import { getWindow } from '@canopy/ui-shared/panels';
import { useWindowPositionInvalidation } from './useWindowPositionInvalidation';

/**
 * Places a surface that renders its own frame exactly as the shared
 * `FloatingMenu` places menus (the model picker, the sidebar menus): the 4px
 * menu gap, edge alignment with the trigger, a flip to the other side when it
 * does not fit, and the transform origin its entry motion grows from.
 */
export function useFloatingMenuPlacement(
  active: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  placement: FloatingMenuPlacement = 'bottom-left',
): FloatingMenuPosition | null {
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);
  const [ownerWindow, setOwnerWindow] = useState<Window | null>(null);

  const updatePosition = useCallback((): void => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const view = getWindow(anchor);
    const next = computeFloatingMenuPosition({
      anchorRect: anchor.getBoundingClientRect(),
      menuWidth: menu.offsetWidth,
      menuHeight: menu.offsetHeight,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
      placement,
    });
    setPosition((previous) =>
      previous &&
      previous.top === next.top &&
      previous.left === next.left &&
      previous.placement === next.placement
        ? previous
        : next,
    );
  }, [anchorRef, menuRef, placement]);

  useLayoutEffect((): void => {
    if (!active) {
      setPosition(null);
      setOwnerWindow(null);
      return;
    }
    setOwnerWindow(getWindow(anchorRef.current));
    updatePosition();
  }, [active, anchorRef, updatePosition]);

  // Content that loads after opening changes the height a flip depends on.
  useLayoutEffect((): (() => void) | void => {
    if (!active) return;
    const menu = menuRef.current;
    if (!menu || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updatePosition());
    observer.observe(menu);
    return (): void => observer.disconnect();
  }, [active, menuRef, updatePosition]);

  useWindowPositionInvalidation(active, updatePosition, ownerWindow);

  return position;
}
