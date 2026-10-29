import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedAutomationInstallSource } from '@canopy/protocol/automations';
import {
  toCuratedAutomationInstallSource,
  type CuratedAutomationDetail,
  type CuratedAutomationListQuery,
  type CuratedAutomationSummary,
} from '@canopy/protocol/automation-catalog';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { installStateOf } from '@/lib/automationShareRelationship';
import { useAutomationsStore } from '@/stores/automationsStore';

/** Debounce before a query change reaches the catalog. */
const QUERY_DEBOUNCE_MS = 200;
const PAGE_SIZE = 25;
/** Page size used while a search pages through the whole catalog. */
const SEARCH_PAGE_SIZE = 100;

interface UseCuratedAutomationsOptions extends Pick<
  CuratedAutomationListQuery,
  'q' | 'category' | 'actionType'
> {
  /**
   * False while the account lacks the `automation-catalog-v1` capability or
   * the surface showing the catalog is not on screen. A disabled hook loads
   * nothing and holds no rows.
   */
  enabled?: boolean;
}

/** Whether a curated automation is installed here, and whether it is current. */
export type CuratedAutomationLocalState = 'installed' | 'update-available';

export interface CuratedAutomationsController {
  rows: CuratedAutomationSummary[];
  loading: boolean;
  error: string | null;
  /** The rows came from the saved catalog because the service was unreachable. */
  stale: boolean;
  nextCursor: string | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  selectedKey: string | null;
  detail: CuratedAutomationDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  /** The selected detail in the shape the install wizard consumes. */
  installSource: SharedAutomationInstallSource | null;
  onSelectKey: (key: string) => void;
  onClearDetail: () => void;
  /** Per-key install state of the loaded rows and the selected detail. */
  localStateByKey: ReadonlyMap<string, CuratedAutomationLocalState>;
}

function localStates(
  entries: readonly Pick<CuratedAutomationSummary, 'key' | 'contentHash'>[],
  activities: readonly ScheduledActivity[],
): ReadonlyMap<string, CuratedAutomationLocalState> {
  const states = new Map<string, CuratedAutomationLocalState>();
  for (const entry of entries) {
    const state = installStateOf(activities, {
      sourceKind: 'curated',
      remoteId: entry.key,
      contentHash: entry.contentHash,
    });
    if (state !== null) states.set(entry.key, state);
  }
  return states;
}

/**
 * Pages of the curated Automation catalog plus one explicitly selected
 * detail. Summaries never carry the automation document; selecting a key
 * loads it. The catalog belongs to the signed-in account, so an account
 * change drops every row and the open detail.
 */
export function useCuratedAutomations({
  q,
  category,
  actionType,
  enabled = true,
}: UseCuratedAutomationsOptions = {}): CuratedAutomationsController {
  const query = useMemo<CuratedAutomationListQuery>(
    () => ({
      limit: PAGE_SIZE,
      q: q?.trim() || undefined,
      category,
      actionType,
    }),
    [q, category, actionType],
  );
  const [rows, setRows] = useState<CuratedAutomationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CuratedAutomationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const activities = useAutomationsStore((state) => state.activities);

  const clearDetail = useCallback((): void => {
    detailSequence.current += 1;
    setSelectedKey(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    const changed = (): void => {
      listSequence.current += 1;
      setRows([]);
      setNextCursor(null);
      setError(null);
      setStale(false);
      clearDetail();
      setAccountEpoch((value) => value + 1);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void => {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
      listSequence.current += 1;
      detailSequence.current += 1;
    };
  }, [clearDetail]);

  const fetchPage = useCallback(
    async (cursor?: string, forceRefresh = false): Promise<void> => {
      const sequence = ++listSequence.current;
      setLoading(true);
      setError(null);
      try {
        // A search reads the whole catalog and leaves matching to the
        // Marketplace's own ranking, the same way curated pipelines do, so
        // every kind on the page answers a query by one rule.
        const search = Boolean(query.q) && cursor === undefined;
        const requestQuery = search
          ? { ...query, q: undefined, limit: SEARCH_PAGE_SIZE }
          : query;
        const pages: CuratedAutomationSummary[] = [];
        const seenCursors = new Set<string>();
        let requestCursor: string | null | undefined = cursor;
        let nextPageCursor: string | null = null;
        let pageIsStale = false;
        while (requestCursor !== null) {
          const result = await window.api.automations.listCurated({
            ...requestQuery,
            ...(requestCursor ? { cursor: requestCursor } : {}),
            ...(forceRefresh ? { forceRefresh: true } : {}),
          });
          if (listSequence.current !== sequence) return;
          pages.push(...result.data);
          pageIsStale ||= result.stale;
          nextPageCursor = result.nextCursor;
          if (!search || !nextPageCursor) {
            requestCursor = null;
            continue;
          }
          if (seenCursors.has(nextPageCursor)) {
            throw new Error('The curated automation catalog repeated a page.');
          }
          seenCursors.add(nextPageCursor);
          requestCursor = nextPageCursor;
        }
        setRows((previous) =>
          cursor
            ? [
                ...previous.filter(
                  (row) => !pages.some((next) => next.key === row.key),
                ),
                ...pages,
              ]
            : pages,
        );
        setNextCursor(search ? null : nextPageCursor);
        setStale(pageIsStale);
      } catch (failure) {
        if (listSequence.current === sequence) {
          // Rows already loaded stay if a later page or a refresh fails.
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      } finally {
        if (listSequence.current === sequence) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    listSequence.current += 1;
    setRows([]);
    setNextCursor(null);
    setError(null);
    setStale(false);
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timeout = setTimeout(() => {
      void fetchPage();
    }, QUERY_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timeout);
      listSequence.current += 1;
    };
  }, [fetchPage, accountEpoch, enabled]);

  const selectKey = useCallback(
    async (key: string): Promise<void> => {
      clearDetail();
      setSelectedKey(key);
      setDetailLoading(true);
      const sequence = ++detailSequence.current;
      try {
        const result = await window.api.automations.getCurated(key);
        if (detailSequence.current !== sequence) return;
        setDetail(result);
      } catch (failure) {
        if (detailSequence.current === sequence) {
          setDetailError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      } finally {
        if (detailSequence.current === sequence) setDetailLoading(false);
      }
    },
    [clearDetail],
  );

  const installSource = useMemo(
    () => (detail ? toCuratedAutomationInstallSource(detail) : null),
    [detail],
  );
  const localStateByKey = useMemo(
    () => localStates(detail ? [...rows, detail] : rows, activities),
    [activities, detail, rows],
  );

  const onRefresh = useCallback((): void => {
    if (!enabled) return;
    void fetchPage(undefined, true);
  }, [enabled, fetchPage]);
  const onLoadMore = useCallback((): void => {
    if (nextCursor && !loading) void fetchPage(nextCursor);
  }, [fetchPage, loading, nextCursor]);
  const onSelectKey = useCallback(
    (key: string): void => {
      void selectKey(key);
    },
    [selectKey],
  );

  return {
    rows,
    loading,
    error,
    stale,
    nextCursor,
    onRefresh,
    onLoadMore,
    selectedKey,
    detail,
    detailLoading,
    detailError,
    installSource,
    onSelectKey,
    onClearDetail: clearDetail,
    localStateByKey,
  };
}
