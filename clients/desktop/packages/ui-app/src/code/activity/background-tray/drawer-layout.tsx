'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { OverlayScrollArea } from '@canopy/ui-shared/components';

// Height limits (D10). The open list scrolls past its cap; an inspector's
// scrolling region keeps the cap its content has elsewhere, and never grows
// past what the list leaves after the sticky label, the row and the
// inspector's own lines, so an open row always fits in the drawer whole.

// The list's cap is the `--background-drawer-list-max` variable
// (`min(22rem, 45vh)`), set on the list in BackgroundTray.tsx; the caps
// below subtract from it.
/** Workflow agents (and later agent steps): the delegated agent card's `max-h-48`. */
const REGION_CAP =
  'max-h-[min(12rem,calc(var(--background-drawer-list-max)_-_10rem))]';
/** Shell output: the Scripts and Hooks tail's 12 lines. */
export const TAIL_LINES = 12;
export const TAIL_CAP =
  'min(10.5rem, calc(var(--background-drawer-list-max) - 8rem))';
/** The sticky group label's height: revealed rows and the top fade clear it. */
export const GROUP_LABEL_PX = 28;

/**
 * Scrolls the drawer's list, never the page, so an opened row and its
 * inspector show whole below the sticky label. The caps keep them shorter
 * than the list, and the row's top always stays in view.
 */
export function revealInList(
  list: HTMLElement,
  row: HTMLElement,
  topInset: number,
): void {
  const bounds = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const above = box.top - (bounds.top + topInset);
  const below = box.bottom - bounds.bottom;
  if (above < 0) list.scrollTop += above;
  else if (below > 0) list.scrollTop += Math.min(below, above);
}

/**
 * One clock per drawer for its elapsed times: it ticks each second only
 * while `running` (the drawer is open), so a closed drawer costs nothing.
 */
export function useDrawerClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return (): void => window.clearInterval(timer);
  }, [running]);
  return now;
}

/** An inspector's capped scrolling region; it opens on its newest line. */
export function CappedRegion({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, []);
  return (
    <OverlayScrollArea
      viewportClassName={`${REGION_CAP} overflow-x-hidden`}
      viewportRef={ref}
      edgeFadeSize={12}
    >
      {children}
    </OverlayScrollArea>
  );
}
