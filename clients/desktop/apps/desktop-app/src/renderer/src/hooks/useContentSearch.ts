import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchExecutor } from '@/components/shared/search/search-types';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 150;

interface ContentSearchResult {
  query: string;
  setQuery: (q: string) => void;
  currentIndex: number;
  totalCount: number;
  goToNext: () => void;
  goToPrevious: () => void;
  /** Clears query, highlights, and resets state. */
  close: () => void;
  /**
   * Re-run the current query against the (possibly changed) container and
   * re-register the highlights, preserving the current match position. Used to
   * restore highlights that another surface clobbered — the CSS Custom
   * Highlight registry is document-global and single-keyed, so a sibling
   * search panel's `findMatches` overwrites this one's highlights until they
   * are re-applied (e.g. when this panel regains focus). No-op when the query
   * is below the minimum length.
   */
  refresh: () => void;
}

/**
 * Core search state hook.
 *
 * Accepts a `SearchExecutor` ref that handles the actual
 * find-and-highlight logic (either ANSI string-level or DOM-based).
 * This hook manages query debouncing, match navigation, and lifecycle.
 */
export function useContentSearch(
  executorRef: React.RefObject<SearchExecutor | null>,
): ContentSearchResult {
  const [query, setQueryRaw] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingSearch = useCallback((): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const executeSearch = useCallback(
    (q: string): void => {
      const executor = executorRef.current;
      if (!executor) return;

      executor.clearHighlights();

      if (q.length < MIN_QUERY_LENGTH) {
        setTotalCount(0);
        setCurrentIndex(-1);
        return;
      }

      const count = executor.findMatches(q);
      setTotalCount(count);

      if (count > 0) {
        setCurrentIndex(0);
        executor.setActiveMatch(0);
        executor.scrollToMatch(0);
      } else {
        setCurrentIndex(-1);
      }
    },
    [executorRef],
  );

  const setQuery = useCallback(
    (q: string): void => {
      setQueryRaw(q);

      clearPendingSearch();

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        executeSearch(q);
      }, DEBOUNCE_MS);
    },
    [clearPendingSearch, executeSearch],
  );

  const goToNext = useCallback((): void => {
    if (totalCount === 0) return;
    const next = (currentIndex + 1) % totalCount;
    setCurrentIndex(next);
    const executor = executorRef.current;
    if (executor) {
      executor.setActiveMatch(next);
      executor.scrollToMatch(next);
    }
  }, [totalCount, currentIndex, executorRef]);

  const goToPrevious = useCallback((): void => {
    if (totalCount === 0) return;
    const prev = (currentIndex - 1 + totalCount) % totalCount;
    setCurrentIndex(prev);
    const executor = executorRef.current;
    if (executor) {
      executor.setActiveMatch(prev);
      executor.scrollToMatch(prev);
    }
  }, [totalCount, currentIndex, executorRef]);

  const refresh = useCallback((): void => {
    const executor = executorRef.current;
    if (!executor) return;
    if (query.length < MIN_QUERY_LENGTH) return;

    clearPendingSearch();

    const count = executor.findMatches(query);
    setTotalCount(count);

    if (count > 0) {
      // Preserve the user's current position when it is still in range;
      // otherwise fall back to the first match. Deliberately does not scroll —
      // regaining focus should restore highlights in place, not jump the view.
      const nextIndex =
        currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
      setCurrentIndex(nextIndex);
      executor.setActiveMatch(nextIndex);
    } else {
      setCurrentIndex(-1);
    }
  }, [clearPendingSearch, executorRef, query, currentIndex]);

  const close = useCallback((): void => {
    clearPendingSearch();
    setQueryRaw('');
    setTotalCount(0);
    setCurrentIndex(-1);
    executorRef.current?.clearHighlights();
  }, [clearPendingSearch, executorRef]);

  // Cleanup on unmount
  useEffect(() => {
    const executor = executorRef.current;
    return (): void => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      executor?.clearHighlights();
    };
  }, [executorRef]);

  return {
    query,
    setQuery,
    currentIndex,
    totalCount,
    goToNext,
    goToPrevious,
    close,
    refresh,
  };
}
