'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsClient } from '../../host';
import { useSettingsErrorCopy } from '../../errors';
import type { MemberPagedLoader } from './profile-api';
import type { SettingsFailure } from '../../errors';

/** Logger scope for the member profile's paged sections. */
export const MEMBER_PROFILE_ERROR_SCOPE =
  'settings.organization.member-profile';

export interface MemberPagedResourceState<T> {
  items: T[];
  /** False until the first page resolves (success or error). */
  initialLoaded: boolean;
  /** True while a `loadMore` fetch is in flight. */
  loadingMore: boolean;
  /** Load copy for the last failed page; never server text. */
  error: SettingsFailure | null;
  /** True when another page is available. */
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /**
   * Runs the failed load again: the next page after a failed `loadMore`,
   * otherwise the first page (back through the loading placeholder).
   */
  retry: () => void;
}

/**
 * Cursor-paged loader for a member-profile section, generalizing the paging
 * logic in `ProfileActivitySection.tsx`. The `loader` (a `profile-api`
 * helper) receives the host's settings client first. It loads the first page on
 * `orgId`/`userId`, exposes a `loadMore` callback that appends the next page,
 * dedupes appended rows by `id`, and guards against overlapping fetches via a
 * `fetchingRef`. A superseded initial fetch is dropped through the `ignore`
 * guard so a stale response can't overwrite a newer one.
 */
export function useMemberPagedResource<T extends { id: string }>(
  orgId: string,
  userId: string,
  loader: MemberPagedLoader<T>,
): MemberPagedResourceState<T> {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBER_PROFILE_ERROR_SCOPE);
  // Bumped by `retry` to run the first-page load again.
  const [reloadToken, setReloadToken] = useState(0);
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const fetchingRef = useRef(false);
  // Bumped on every initial-fetch effect run. `loadMore` captures the current
  // value and discards its result if the context changed mid-flight, so a stale
  // page can't be appended onto a different member's list.
  const generationRef = useRef(0);

  useEffect(() => {
    // Bump the generation so any in-flight `loadMore` from the prior context
    // sees a mismatch and discards its result.
    generationRef.current += 1;
    let ignore = false;
    // All state updates live inside the async closure (not the synchronous
    // effect body) so the kickoff doesn't trigger a cascading re-render.
    void (async (): Promise<void> => {
      // Reset list state up front so a stale in-flight `loadMore` from the
      // previous context can't leave its rows/cursor visible during the load.
      setItems([]);
      setNextCursor(null);
      setLoadingMore(false);
      setInitialLoaded(false);
      setError(null);
      try {
        const page = await loader(client, orgId, userId);
        if (!ignore) {
          setItems(page.items);
          setNextCursor(page.nextCursor);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(errorCopy.loadFailure(err));
          setItems([]);
          setNextCursor(null);
        }
      } finally {
        if (!ignore) {
          setInitialLoaded(true);
        }
      }
    })();
    return (): void => {
      ignore = true;
      // Release the fetch guard so the new context's first `loadMore` isn't
      // blocked by a still-pending fetch from the superseded context.
      fetchingRef.current = false;
    };
  }, [client, orgId, userId, loader, errorCopy, reloadToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (fetchingRef.current || nextCursor === null) {
      return;
    }
    const generation = generationRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loader(client, orgId, userId, nextCursor);
      // The context changed while this page was in flight — the effect has
      // already reset state for the new context, so drop this result.
      if (generationRef.current !== generation) {
        return;
      }
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err: unknown) {
      if (generationRef.current === generation) {
        setError(errorCopy.loadFailure(err));
      }
    } finally {
      if (generationRef.current === generation) {
        fetchingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [client, orgId, userId, loader, errorCopy, nextCursor]);

  const hasItems = items.length > 0;
  const retry = useCallback((): void => {
    if (hasItems && nextCursor !== null) {
      void loadMore();
      return;
    }
    setReloadToken((token) => token + 1);
  }, [hasItems, nextCursor, loadMore]);

  return {
    items,
    initialLoaded,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    retry,
  };
}
