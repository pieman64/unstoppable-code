'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createDomSearchExecutor } from '@canopy/ui-shared/lib/dom-search-highlight';
import {
  EMPTY_FIND_CONTROLLER_STATE,
  useSurfaceFindStore,
  type FindController,
} from './surface-find-store';
import { useFindSurfaceShown } from './useFindSurfaceShown';

/** Keystrokes settle for this long before the content is scanned. */
export const DOM_TEXT_FIND_DEBOUNCE_MS = 150;
/** Like the file and browser searches, one character is not a search yet. */
export const DOM_TEXT_FIND_MIN_LENGTH = 2;

/** Find-bar modes that search a surface's rendered DOM text. */
export type DomTextFindMode = 'chat' | 'plan';

export interface DomTextFindOptions<Mode extends DomTextFindMode> {
  mode: Mode;
  /**
   * Register while true and the surface is shown (its panel tab and page
   * host visible); it unregisters, closing the bar, otherwise.
   */
  enabled: boolean;
  /** The bar's scope key for this surface. */
  scopeKey: string;
  /** Scope-menu label beside other surfaces of the mode. */
  title: string;
  /** The panel root: the surface the bar anchors to and marks. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * The element searched and scrolled, inside the root; the root itself when
   * omitted or not rendered.
   */
  contentSelector?: string;
  /** Skip text that is hidden or not laid out. */
  visibleOnly?: boolean;
}

export interface DomTextFindSurfaceProps<Mode extends DomTextFindMode> {
  'data-find-surface'?: Mode;
  'data-find-scope'?: string;
  /** The root takes focus back when the bar closes without an opener. */
  tabIndex?: -1;
}

export interface DomTextFind<Mode extends DomTextFindMode> {
  /** Spread onto the panel root so Cmd/Ctrl+F routes to this surface. */
  surfaceProps: DomTextFindSurfaceProps<Mode>;
  /**
   * Render in a `<style>` inside the panel: the highlight colors, empty
   * until the surface first searches.
   */
  highlightStyle: string;
}

/**
 * Find-bar controller for a surface whose searchable content is rendered
 * text (CAN-3048): a DOM search with the CSS Custom Highlight API for the
 * match marks, registered in the window that owns the panel so a popped-out
 * panel paints its own. Only rendered nodes take part, so virtualized
 * content reports what is on and near the screen.
 */
export function useDomTextFind<Mode extends DomTextFindMode>({
  mode,
  enabled,
  scopeKey,
  title,
  rootRef,
  contentSelector,
  visibleOnly = false,
}: DomTextFindOptions<Mode>): DomTextFind<Mode> {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const names = useMemo(
    () => ({
      matches: `${mode}-find-matches-${id}`,
      active: `${mode}-find-active-${id}`,
      visibleOnly,
    }),
    [id, mode, visibleOnly],
  );
  const titleRef = useRef(title);
  titleRef.current = title;
  const shown = useFindSurfaceShown();
  const registered = enabled && shown;
  // Adding a stylesheet's rules invalidates styles across the document, so
  // the highlight rules are emitted once this surface first searches rather
  // than on every panel mount.
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const anchor = rootRef.current;
    if (!registered || !anchor) return undefined;
    const content = (): HTMLElement =>
      (contentSelector === undefined
        ? null
        : anchor.querySelector<HTMLElement>(contentSelector)) ?? anchor;
    const executor = createDomSearchExecutor(content, content, names);
    const store = useSurfaceFindStore.getState();
    let query = '';
    let index = 0;
    let count = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;

    // Content changes while a chat turn streams, older pages load, or a plan
    // re-renders; re-scan in place so the counts stay true to what is
    // rendered. Watching costs nothing until a query is active, and changes
    // outside the searched content (a header, a comments tray) are skipped;
    // a change to an ancestor of it may have replaced it, so it counts.
    let observer: MutationObserver | null = null;
    const watch = (): void => {
      if (observer !== null) return;
      observer = new MutationObserver((records) => {
        if (query.length < DOM_TEXT_FIND_MIN_LENGTH || timer !== null) return;
        const target = content();
        const touchesContent = records.some(
          (record) =>
            target.contains(record.target) || record.target.contains(target),
        );
        if (!touchesContent) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => search(true));
      });
      observer.observe(anchor, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    };
    const unwatch = (): void => {
      observer?.disconnect();
      observer = null;
      cancelAnimationFrame(frame);
    };
    const report = (): void => {
      store.updateControllerState(
        mode,
        scopeKey,
        count === 0
          ? EMPTY_FIND_CONTROLLER_STATE
          : { currentIndex: index, totalCount: count, error: null },
      );
    };
    const clearTimer = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    /** Scans the rendered content; `keepIndex` holds the active match
     * across a content change (streaming, an older page loading). */
    const search = (keepIndex: boolean): void => {
      clearTimer();
      if (query.length < DOM_TEXT_FIND_MIN_LENGTH) {
        unwatch();
        executor.clearHighlights();
        count = 0;
        index = 0;
        report();
        return;
      }
      setSearched(true);
      watch();
      count = executor.findMatches(query);
      index = count > 0 && keepIndex && index < count ? index : 0;
      if (count > 0) {
        executor.setActiveMatch(index);
        if (!keepIndex) executor.scrollToMatch(index);
      }
      report();
    };
    const step = (delta: number): void => {
      // Enter before the debounced scan: run it now and show its first match
      // rather than stepping past it.
      if (timer !== null) {
        search(false);
        return;
      }
      if (count === 0) return;
      index = (index + delta + count) % count;
      executor.setActiveMatch(index);
      executor.scrollToMatch(index);
      report();
    };
    const controller: FindController = {
      mode,
      scopeKey,
      title: titleRef.current,
      anchor,
      setQuery: (next): void => {
        if (next === query) return;
        query = next;
        index = 0;
        clearTimer();
        timer = setTimeout(() => search(false), DOM_TEXT_FIND_DEBOUNCE_MS);
      },
      next: (): void => step(1),
      previous: (): void => step(-1),
      close: (): void => {
        clearTimer();
        unwatch();
        query = '';
        count = 0;
        index = 0;
        executor.clearHighlights();
        report();
      },
    };
    store.registerController(controller);
    return (): void => {
      unwatch();
      clearTimer();
      executor.clearHighlights();
      useSurfaceFindStore.getState().unregisterController(controller);
    };
  }, [contentSelector, mode, names, registered, rootRef, scopeKey]);

  useEffect(() => {
    if (!registered) return;
    useSurfaceFindStore.getState().setControllerTitle(mode, scopeKey, title);
  }, [mode, registered, scopeKey, title]);

  return {
    surfaceProps: enabled
      ? {
          'data-find-surface': mode,
          'data-find-scope': scopeKey,
          tabIndex: -1,
        }
      : {},
    highlightStyle: searched
      ? `::highlight(${names.matches}) { background-color: color-mix(in srgb, var(--fg-warning) 35%, transparent); color: inherit; } ::highlight(${names.active}) { background-color: color-mix(in srgb, var(--fg-warning) 65%, transparent); }`
      : '',
  };
}
