'use client';

import {
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from 'react';

export interface SidebarHeaderRest {
  readonly resting: boolean;
  readonly onPointerEnter: PointerEventHandler<HTMLElement>;
  readonly onPointerMove: PointerEventHandler<HTMLElement>;
  readonly onFocusCapture: FocusEventHandler<HTMLElement>;
  readonly onKeyDownCapture: KeyboardEventHandler<HTMLElement>;
}

/** A collapse ends the current hover interaction; fresh input reveals actions. */
export function useSidebarHeaderRest(
  collapsed: boolean,
  actionsActive = false,
): SidebarHeaderRest {
  const [state, setState] = useState({ collapsed, resting: false });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // Update before paint, including controlled/optimistic host projections.
  // Initially collapsed headers still respond to their first hover normally.
  if (state.collapsed !== collapsed || (actionsActive && state.resting)) {
    setState({ collapsed, resting: collapsed && !actionsActive });
  }
  const resting =
    !actionsActive &&
    (state.collapsed === collapsed ? state.resting : collapsed);
  const reveal = (): void => {
    if (resting) setState({ collapsed, resting: false });
  };
  return {
    resting,
    onPointerEnter: (event): void => {
      pointer.current = { x: event.clientX, y: event.clientY };
      reveal();
    },
    onPointerMove: (event): void => {
      const previous = pointer.current;
      pointer.current = { x: event.clientX, y: event.clientY };
      if (
        previous === null ||
        previous.x !== event.clientX ||
        previous.y !== event.clientY
      )
        reveal();
    },
    onFocusCapture: (event): void => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(':focus-visible')
      )
        reveal();
    },
    onKeyDownCapture: (event): void => {
      if (event.key === 'Tab') reveal();
    },
  };
}
