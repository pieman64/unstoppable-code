import { useCallback, useEffect, useRef } from 'react';

/**
 * Reschedules `updatePosition` on scroll/resize of the owning window.
 *
 * `targetWindow` is the window the anchored element actually lives in. When the
 * composer is popped out to an aux panel window, resize/scroll fire on THAT
 * window, so listeners must bind there — a main-window binding would both miss
 * the aux window's events and react to the main window's. Defaults to the
 * ambient `window` when omitted (or null before the owner resolves), so
 * main-window callers are unchanged.
 */
export function useWindowPositionInvalidation(
  active: boolean,
  updatePosition: () => void,
  targetWindow?: Window | null,
): void {
  const animationFrameRef = useRef<number | null>(null);
  const view = targetWindow ?? window;

  const schedulePositionUpdate = useCallback((): void => {
    if (animationFrameRef.current !== null) {
      return;
    }

    animationFrameRef.current = view.requestAnimationFrame((): void => {
      animationFrameRef.current = null;
      updatePosition();
    });
  }, [updatePosition, view]);

  useEffect((): (() => void) | void => {
    if (!active) {
      return;
    }

    view.addEventListener('resize', schedulePositionUpdate);
    view.addEventListener('scroll', schedulePositionUpdate, {
      capture: true,
      passive: true,
    });

    return (): void => {
      view.removeEventListener('resize', schedulePositionUpdate);
      view.removeEventListener('scroll', schedulePositionUpdate, {
        capture: true,
      });
      if (animationFrameRef.current !== null) {
        view.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [active, schedulePositionUpdate, view]);
}
