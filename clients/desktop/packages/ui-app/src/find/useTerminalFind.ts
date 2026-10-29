'use client';

import { useEffect, useRef, type RefObject } from 'react';
import type { TerminalInstanceEntry } from '../code/terminal/terminal-instances';
import {
  EMPTY_FIND_CONTROLLER_STATE,
  findControllerKey,
  useSurfaceFindStore,
  type FindController,
} from './surface-find-store';
import { useFindSurfaceShown } from './useFindSurfaceShown';

/** Keystrokes settle for this long before the scrollback is searched. */
export const TERMINAL_FIND_DEBOUNCE_MS = 150;
/** Like the other find modes, one character is not a search yet. */
export const TERMINAL_FIND_MIN_LENGTH = 2;

/**
 * The parts of a cached terminal entry the find bar drives. Type-only, so
 * this module never loads xterm at runtime.
 */
export interface TerminalFindEntry {
  term: Pick<TerminalInstanceEntry['term'], 'clearSelection'>;
  search: Pick<
    TerminalInstanceEntry['search'],
    'clearDecorations' | 'findNext' | 'findPrevious' | 'onDidChangeResults'
  >;
  findShortcutClaimed: boolean;
  disposed: boolean;
}

/**
 * Match highlight colors, passed in by the pane: the terminal cache owns
 * them beside the terminal theme.
 */
export type TerminalFindDecorations = NonNullable<
  Parameters<TerminalFindEntry['search']['findNext']>[1]
>['decorations'];

export interface TerminalFindOptions {
  /**
   * Register while true and the surface is shown (its panel tab and page
   * host visible); it unregisters, closing the bar, otherwise.
   */
  enabled: boolean;
  /** The bar's scope key for this terminal: its terminal id. */
  scopeKey: string;
  /** Scope-menu label beside other terminals. */
  title: string;
  /** The terminal pane root: the surface the bar anchors to and marks. */
  rootRef: RefObject<HTMLElement | null>;
  /** The cached xterm instance with its search addon; null until mounted. */
  entryRef: RefObject<TerminalFindEntry | null>;
  /** Highlight colors for matches and the active match. */
  decorations: TerminalFindDecorations;
}

export interface TerminalFindSurfaceProps {
  'data-find-surface'?: 'terminal';
  'data-find-scope'?: string;
  /** The root takes focus back when the bar closes without an opener. */
  tabIndex?: -1;
}

export interface TerminalFind {
  /** Spread onto the pane root so Cmd/Ctrl+F routes to this terminal. */
  surfaceProps: TerminalFindSurfaceProps;
  /**
   * True while a query has selected matches. Each step selects its match,
   * so the pane suppresses its selection pill meanwhile.
   */
  activeRef: RefObject<boolean>;
}

/**
 * Find-bar terminal mode over xterm's search addon: the addon highlights
 * matches in the scrollback, selects and scrolls to the active one, and
 * re-highlights as output arrives, so this only tracks the query and
 * forwards the addon's counts to the bar.
 */
export function useTerminalFind({
  enabled,
  scopeKey,
  title,
  rootRef,
  entryRef,
  decorations,
}: TerminalFindOptions): TerminalFind {
  const titleRef = useRef(title);
  titleRef.current = title;
  const decorationsRef = useRef(decorations);
  decorationsRef.current = decorations;
  const activeRef = useRef(false);
  const shown = useFindSurfaceShown();
  const registered = enabled && shown;

  useEffect(() => {
    const anchor = rootRef.current;
    const entry = entryRef.current;
    if (!registered || !anchor || !entry) return undefined;
    const store = useSurfaceFindStore.getState();
    let query = '';
    // The addon's own count: stepping is a no-op only when it found nothing.
    let rawCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    entry.findShortcutClaimed = true;

    // The cache disposes an entry when its session closes, possibly while
    // the bar is open, and a pane can move to another terminal; never call
    // into a disposed or replaced terminal.
    const live = (): boolean => entryRef.current === entry && !entry.disposed;
    const reportEmpty = (): void => {
      store.updateControllerState(
        'terminal',
        scopeKey,
        EMPTY_FIND_CONTROLLER_STATE,
      );
    };
    const clearTimer = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    /**
     * Drops highlights, the selected match, and any pending search. The
     * selection is cleared only when a search ran (a search replaces it with
     * its match), so opening and closing the bar, or hiding the panel,
     * without searching keeps the user's selection; the find ends first, so
     * the pane recomputes its pill.
     */
    const clear = (): void => {
      clearTimer();
      const searched = activeRef.current;
      activeRef.current = false;
      if (live()) {
        entry.search.clearDecorations();
        if (searched) entry.term.clearSelection();
      }
      rawCount = 0;
      reportEmpty();
    };
    const search = (): void => {
      clearTimer();
      if (!live() || query.trim().length < TERMINAL_FIND_MIN_LENGTH) {
        clear();
        return;
      }
      activeRef.current = true;
      entry.search.findNext(query, {
        incremental: true,
        decorations: decorationsRef.current,
      });
    };
    const step = (direction: 'next' | 'previous'): void => {
      // Enter before the debounced search: run it now and show its first
      // match rather than stepping past it.
      if (timer !== null) {
        search();
        return;
      }
      if (!live()) {
        clear();
        return;
      }
      if (query.trim().length < TERMINAL_FIND_MIN_LENGTH || rawCount === 0) {
        return;
      }
      const options = { decorations: decorationsRef.current };
      if (direction === 'next') {
        entry.search.findNext(query, options);
      } else {
        entry.search.findPrevious(query, options);
      }
    };

    const results = entry.search.onDidChangeResults(
      ({ resultIndex, resultCount }) => {
        if (!live()) return;
        rawCount = resultCount;
        store.updateControllerState('terminal', scopeKey, {
          currentIndex: Math.max(0, resultIndex),
          totalCount: Math.max(0, resultCount),
          error: null,
        });
      },
    );

    const controller: FindController = {
      mode: 'terminal',
      scopeKey,
      title: titleRef.current,
      anchor,
      setQuery: (next): void => {
        if (next === query) return;
        query = next;
        if (query.trim().length < TERMINAL_FIND_MIN_LENGTH) {
          clear();
          return;
        }
        clearTimer();
        timer = setTimeout(search, TERMINAL_FIND_DEBOUNCE_MS);
      },
      next: (): void => step('next'),
      previous: (): void => step('previous'),
      close: (): void => {
        query = '';
        clear();
      },
    };
    store.registerController(controller);
    return (): void => {
      const current = useSurfaceFindStore.getState();
      // Old and new panes overlap during navigation: once a newer pane's
      // controller took this terminal over, its claim, highlights, and
      // counts are not this one's to reset.
      if (
        current.controllers[findControllerKey('terminal', scopeKey)]
          ?.controller !== controller
      ) {
        clearTimer();
        results.dispose();
        return;
      }
      clear();
      results.dispose();
      entry.findShortcutClaimed = false;
      current.unregisterController(controller);
    };
  }, [entryRef, registered, rootRef, scopeKey]);

  useEffect(() => {
    if (!registered) return;
    useSurfaceFindStore
      .getState()
      .setControllerTitle('terminal', scopeKey, title);
  }, [registered, scopeKey, title]);

  return {
    surfaceProps: enabled
      ? {
          'data-find-surface': 'terminal',
          'data-find-scope': scopeKey,
          tabIndex: -1,
        }
      : {},
    activeRef,
  };
}
