'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DiagramSearchHandle } from './diagram-search-handle';
import {
  EMPTY_FIND_CONTROLLER_STATE,
  useSurfaceFindStore,
  type FindController,
} from './surface-find-store';
import { useFindSurfaceShown } from './useFindSurfaceShown';

/** Keystrokes settle for this long before the diagram is searched. */
export const DIAGRAM_FIND_DEBOUNCE_MS = 150;
/** Like the other find modes, one character is not a search yet. */
export const DIAGRAM_FIND_MIN_LENGTH = 2;

export interface DiagramFindOptions {
  /**
   * Register while true and the surface is shown (its panel tab and page
   * host visible); it unregisters, closing the bar, otherwise.
   */
  enabled: boolean;
  /** The bar's scope key for this diagram. */
  scopeKey: string;
  /** Scope-menu label beside other diagrams. */
  title: string;
  /** The diagram panel root: the surface the bar anchors to and marks. */
  rootRef: RefObject<HTMLElement | null>;
  /** The shown diagram's search API; null until its code loads. */
  handleRef: RefObject<DiagramSearchHandle | null>;
}

export interface DiagramFindSurfaceProps {
  'data-find-surface'?: 'diagram';
  'data-find-scope'?: string;
  /** The root takes focus back when the bar closes without an opener. */
  tabIndex?: -1;
}

export interface DiagramFind {
  /** Spread onto the panel root so Cmd/Ctrl+F routes to this diagram. */
  surfaceProps: DiagramFindSurfaceProps;
  /**
   * Re-runs the active query against the shown diagram, for a host whose
   * diagram changed (another tab or artifact, or its code finished loading).
   * The active node stays active while it still matches; otherwise the
   * first match is. Stable across renders; a no-op while no query is active.
   */
  refresh: () => void;
}

const noop = (): void => {};

/**
 * Find-bar diagram mode over a diagram's imperative search handle: the
 * handle outlines matched nodes and centers the active one, so this only
 * tracks the query, the ordered node ids, and the active index.
 */
export function useDiagramFind({
  enabled,
  scopeKey,
  title,
  rootRef,
  handleRef,
}: DiagramFindOptions): DiagramFind {
  const titleRef = useRef(title);
  titleRef.current = title;
  const refreshRef = useRef<() => void>(noop);
  const refresh = useCallback((): void => refreshRef.current(), []);
  const shown = useFindSurfaceShown();
  const registered = enabled && shown;

  useEffect(() => {
    const anchor = rootRef.current;
    if (!registered || !anchor) return undefined;
    const store = useSurfaceFindStore.getState();
    let query = '';
    let matches: string[] = [];
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const report = (): void => {
      store.updateControllerState(
        'diagram',
        scopeKey,
        matches.length === 0
          ? EMPTY_FIND_CONTROLLER_STATE
          : { currentIndex: index, totalCount: matches.length, error: null },
      );
    };
    const clearTimer = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    // Reads the live handle: the shown diagram can change (or load) while
    // registered, and teardown must clear whichever one is on screen.
    const clearHandle = (): void => handleRef.current?.clear();
    const reveal = (): void => {
      const nodeId = matches[index];
      if (nodeId !== undefined) handleRef.current?.reveal(nodeId);
    };
    // The handle last searched. Hosts hand over a new handle when they show
    // another diagram, so a changed handle means a different diagram even
    // where node ids repeat across diagrams.
    let searched: DiagramSearchHandle | null = null;
    /** Searches the shown diagram; `keepActive` holds the active node while
     * the same diagram still matches it (it updated under an open search),
     * and starts from the first match otherwise (another diagram is shown). */
    const search = (keepActive: boolean): void => {
      clearTimer();
      if (query.trim().length < DIAGRAM_FIND_MIN_LENGTH) {
        clearHandle();
        matches = [];
        index = 0;
        report();
        return;
      }
      const handle = handleRef.current;
      const active =
        keepActive && handle === searched ? matches[index] : undefined;
      searched = handle;
      matches = handle?.search(query) ?? [];
      index = active === undefined ? 0 : Math.max(0, matches.indexOf(active));
      reveal();
      report();
    };
    const step = (delta: number): void => {
      // Enter before the debounced search: run it now and show its first
      // match rather than stepping past it.
      if (timer !== null) {
        search(false);
        return;
      }
      if (matches.length === 0) return;
      index = (index + delta + matches.length) % matches.length;
      reveal();
      report();
    };
    const controller: FindController = {
      mode: 'diagram',
      scopeKey,
      title: titleRef.current,
      anchor,
      setQuery: (next): void => {
        if (next === query) return;
        query = next;
        index = 0;
        clearTimer();
        timer = setTimeout(() => search(false), DIAGRAM_FIND_DEBOUNCE_MS);
      },
      next: (): void => step(1),
      previous: (): void => step(-1),
      close: (): void => {
        clearTimer();
        query = '';
        matches = [];
        index = 0;
        clearHandle();
        report();
      },
    };
    refreshRef.current = (): void => {
      if (query === '' || timer !== null) return;
      search(true);
    };
    store.registerController(controller);
    return (): void => {
      refreshRef.current = noop;
      clearTimer();
      clearHandle();
      useSurfaceFindStore.getState().unregisterController(controller);
    };
  }, [handleRef, registered, rootRef, scopeKey]);

  useEffect(() => {
    if (!registered) return;
    useSurfaceFindStore
      .getState()
      .setControllerTitle('diagram', scopeKey, title);
  }, [registered, scopeKey, title]);

  return {
    surfaceProps: enabled
      ? {
          'data-find-surface': 'diagram',
          'data-find-scope': scopeKey,
          tabIndex: -1,
        }
      : {},
    refresh,
  };
}
