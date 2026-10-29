'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import type { ShareTarget } from '@canopy/ui-shared/components';

/**
 * The search/load behavior behind every share surface's team and organization
 * picker: a debounced query, a request-sequence guard that ignores stale
 * responses (after a newer query, a disable, a reset or an unmount), and error
 * mapping. In-flight loads are not aborted; their results are dropped. Selection,
 * remote-owner preselection and scope policy stay with each surface because
 * they genuinely differ; this hook only owns what must behave identically.
 */

export const SHARE_TARGET_SEARCH_DEBOUNCE_MS = 250;

export interface UseShareTargetSearchOptions<T> {
  /** Load only while true — e.g. the matching scope is selected. */
  readonly enabled: boolean;
  /**
   * Fetch targets for a trimmed query; `undefined` means no query. Keep the
   * reference stable (module function or `useCallback`): a new reference
   * reloads.
   */
  readonly load: (query?: string) => Promise<readonly T[]>;
  /**
   * Reloads when it changes, e.g. the signed-in account's id: switching to
   * another account with the same capabilities leaves `enabled` and `load`
   * untouched, so without it the picker would keep the previous account's
   * targets. Hosts clear their selection on the same key.
   */
  readonly resetKey?: string | null;
  readonly debounceMs?: number;
  /** Maps a rejected load to display copy. Defaults to the error message. */
  readonly formatError?: (error: unknown) => string;
}

export interface ShareTargetSearchState<T> {
  readonly search: string;
  readonly setSearch: (next: string) => void;
  /** `null` until the first load completes. */
  readonly items: readonly T[] | null;
  /** Trimmed query that produced the current successful results. */
  readonly resultQuery: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const FALLBACK_ERROR = 'Something went wrong. Try again.';

function defaultFormatError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return FALLBACK_ERROR;
}

export function useShareTargetSearch<T>({
  enabled,
  load,
  resetKey = null,
  debounceMs = SHARE_TARGET_SEARCH_DEBOUNCE_MS,
  formatError = defaultFormatError,
}: UseShareTargetSearchOptions<T>): ShareTargetSearchState<T> {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<readonly T[] | null>(null);
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  // Held in a ref so an inline formatter does not re-trigger the load.
  const formatErrorRef = useRef(formatError);
  formatErrorRef.current = formatError;

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(search.trim());
    }, debounceMs);
    return (): void => clearTimeout(handle);
  }, [search, debounceMs]);

  useEffect(() => {
    if (!enabled) {
      // Invalidate any in-flight request so it cannot land after disable.
      requestSeq.current += 1;
      setLoading(false);
      setError(null);
      setResultQuery(null);
      return undefined;
    }
    const seq = ++requestSeq.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResultQuery(null);
    load(debounced.length > 0 ? debounced : undefined)
      .then((result) => {
        if (cancelled || seq !== requestSeq.current) return;
        setItems(result);
        setResultQuery(debounced);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        setError(formatErrorRef.current(cause));
        setItems([]);
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [enabled, debounced, load, resetKey]);

  return { search, setSearch, items, resultQuery, loading, error };
}

/** Adapts a team or organization summary to the shared picker row. */
export function toShareTarget(
  target:
    | Pick<CanopyTeamSummary, 'id' | 'name' | 'organization'>
    | Pick<CanopyOrganizationSummary, 'id' | 'name'>,
): ShareTarget {
  if ('organization' in target) {
    return {
      id: target.id,
      name: target.name,
      organizationId: target.organization.id,
      secondaryLabel: target.organization.name,
    };
  }
  return { id: target.id, name: target.name };
}
