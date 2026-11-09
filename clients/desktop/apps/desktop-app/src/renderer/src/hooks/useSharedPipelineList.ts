import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type {
  PipelineInfo,
  SharedPipelineSummary,
  SharedPipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import { DEFAULT_PIPELINE_SCOPES } from '@canopy/desktop-shared/pipelines/scope';
import { buildSharedPipelineId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import {
  readSharedPipelineCache,
  removeRowFromSharedPipelineCache,
  sharedPipelineCacheKey,
  writeLastSharedAccountIdentity,
  writeSharedPipelineCache,
} from '@/lib/sharedPipelineCache';

const PAGE_SIZE = 25;

/**
 * Compose a `PipelineInfo` row from a remote `SharedPipelineSummary`.
 *
 * The local id format for a shared pipeline is the canonical
 * `shared:canopy-cloud:${remoteId}` string — that string is what every
 * downstream consumer (editor, executor, preference locator) uses to refer
 * back to the same shared row. The renderer does not surface server identity
 * to the user, but the underlying executor/preference layer still keys on
 * this stable string.
 *
 * `shareScope` and `owner` are forwarded directly from the server payload
 * (no field renaming — the renderer and main process both use the same
 * names). Older Canopy Cloud backends (pre `organizations-v1` / `teams-v1`)
 * may omit these fields; in that case `shareScope` falls back to `'private'`
 * and `owner` stays undefined so existing rows continue to render.
 *
 * `scopes` (execution scopes) defaults to `['directory']` when the server
 * response omits it (older deployments). This keeps the summary visible in
 * directory AND worktree trigger surfaces via the capability relation until a
 * detail/raw-YAML hydration provides the desktop-derived scopes.
 */
export function buildSharedPipelineInfo(args: {
  summary: SharedPipelineSummary;
}): PipelineInfo {
  const { summary } = args;
  return {
    id: buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, summary.id),
    name: summary.name,
    filename: '',
    description: summary.description,
    icon: summary.icon,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    triggerTypes: summary.triggerTypes,
    scopes: summary.scopes ?? [...DEFAULT_PIPELINE_SCOPES],
    source: 'shared',
    readonly: !summary.canUpdate,
    serverId: CANOPY_CLOUD_SERVER_ID,
    remoteId: summary.id,
    canUpdate: summary.canUpdate,
    canDelete: summary.canDelete,
    shareScope: summary.shareScope ?? 'private',
    publicShare: summary.publicShare ?? null,
    ...(summary.owner ? { owner: summary.owner } : {}),
  };
}

export interface SharedCloudListState {
  cloudAccount: CanopyCloudAccountPublicState | null;
  cloudLoading: boolean;
  rows: PipelineInfo[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: string | null;
  loaded: boolean;
}

export interface SharedListFilters {
  q?: string;
  triggerType?: SharedPipelineTriggerType;
  createdBy?: string;
}

export interface UseSharedPipelineListReturn extends SharedCloudListState {
  refreshShared: () => Promise<void>;
  loadMoreShared: () => Promise<void>;
  setFilters: (filters: SharedListFilters) => void;
  /** Optimistically remove a row after a successful `deleteShared`. */
  removeSharedRow: (remoteId: string) => void;
}

function isCloudReady(account: CanopyCloudAccountPublicState | null): boolean {
  return isCanopyCloudConnected(account);
}

function getCloudAccountIdentity(
  account: CanopyCloudAccountPublicState | null,
): string {
  if (!account?.hasApiKey || !account.account) return 'unconfigured';
  return [
    account.account?.id ?? '',
    account.updatedAt ?? '',
    [...account.capabilities].sort().join(','),
  ].join(':');
}

/**
 * Cursor-paginated loader for shared pipelines from the configured Canopy
 * Cloud backend.
 *
 * The desktop app is bound to a single Canopy Cloud backend at build time, so
 * this hook exposes a single list state — there is no per-server tab UI to
 * select between. Consumers call `refreshShared()` on mount/when the user
 * triggers a manual refresh and `loadMoreShared()` to walk subsequent pages
 * until `nextCursor === null`.
 *
 * Filters (`q`, `triggerType`, `createdBy`) trigger a fresh first-page fetch
 * whenever the list has already been loaded once.
 */
export function useSharedPipelineList(
  initialFilters?: SharedListFilters,
): UseSharedPipelineListReturn {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const [cloudAccount, setCloudAccount] =
    useState<CanopyCloudAccountPublicState | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [rows, setRows] = useState<PipelineInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFiltersState] = useState<SharedListFilters>(
    initialFilters ?? {},
  );

  // Latest request id so a stale response can't overwrite a newer one. Bumped
  // on every fetch (refresh and loadMore alike).
  const requestSeqRef = useRef(0);
  const accountIdentityRef = useRef<string | null>(null);
  // Current filters, readable from the account-change effect without making it
  // depend on `filters`.
  const filtersRef = useRef<SharedListFilters>(filters);
  filtersRef.current = filters;

  // Load the configured Cloud account on mount and whenever Settings changes it.
  useEffect(() => {
    let cancelled = false;
    const reload = (): void => {
      setCloudLoading(true);
      window.api
        .loadCanopyCloudAccount()
        .then((next) => {
          if (cancelled) return;
          const nextIdentity = getCloudAccountIdentity(next);
          if (contextEnabled || accountIdentityRef.current !== nextIdentity) {
            accountIdentityRef.current = nextIdentity;
            // Only persist a real connected identity as the seed identity; a
            // transient disconnect ('unconfigured') must not orphan the warm
            // cache keyed under the connected account.
            if (isCloudReady(next)) {
              writeLastSharedAccountIdentity(nextIdentity);
            }
            requestSeqRef.current += 1;
            // Seed from cache only after the active account is verified. Reading
            // the persisted last identity before this point can briefly expose
            // rows from a previous account after logout or account switches.
            const seedKey = isCloudReady(next)
              ? sharedPipelineCacheKey(nextIdentity, filtersRef.current)
              : null;
            const seeded =
              seedKey && !contextEnabled
                ? readSharedPipelineCache(seedKey)
                : null;
            setRows(seeded?.rows ?? []);
            setLoading(false);
            setLoadingMore(false);
            setNextCursor(seeded?.nextCursor ?? null);
            setError(null);
            setLoaded(false);
          }
          setCloudAccount(next);
        })
        .catch(() => {
          if (cancelled) return;
          if (accountIdentityRef.current !== 'unconfigured') {
            accountIdentityRef.current = 'unconfigured';
            requestSeqRef.current += 1;
            setRows([]);
            setLoading(false);
            setLoadingMore(false);
            setNextCursor(null);
            setError(null);
            setLoaded(false);
          }
          setCloudAccount(null);
        })
        .finally(() => {
          if (!cancelled) setCloudLoading(false);
        });
    };

    reload();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    return (): void => {
      cancelled = true;
      if (contextEnabled) requestSeqRef.current += 1;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    };
  }, [contextEnabled, contextGeneration]);

  const fetchPage = useCallback(
    async (
      cursor: string | undefined,
      mode: 'refresh' | 'more',
    ): Promise<void> => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;

      if (mode === 'refresh') {
        // Stale-while-revalidate: keep any already-rendered rows visible while
        // the fresh page loads instead of blanking to an empty/loading state.
        // Surfaces gate their spinner on `loading && rows.length === 0`, so a
        // seeded/previously-loaded list shows no flash on refresh.
        setLoading(true);
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const result = await window.pipelines.listShared({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(filters.q ? { q: filters.q } : {}),
          ...(filters.triggerType ? { triggerType: filters.triggerType } : {}),
          ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
        });

        if (
          requestSeqRef.current !== seq ||
          (contextEnabled &&
            useWorkspaceContextStore.getState().appliedGeneration !==
              contextGeneration)
        )
          return;

        if (!result.success || !result.data) {
          setLoading(false);
          setLoadingMore(false);
          setError(result.error ?? 'Failed to load shared workflows');
          setLoaded(true);
          return;
        }

        const responseData = result.data;
        const newRows = responseData.data.map((summary) =>
          buildSharedPipelineInfo({ summary }),
        );
        const newCursor = responseData.nextCursor ?? null;
        setLoading(false);
        setLoadingMore(false);
        setRows((prev) =>
          mode === 'refresh' ? newRows : [...prev, ...newRows],
        );
        setNextCursor(newCursor);
        setError(null);
        setLoaded(true);

        // Persist the first page (the default, unfiltered list per trigger
        // type) so the next mount can seed from it. `load more` pages aren't
        // cached to keep the store bounded.
        if (mode === 'refresh' && !contextEnabled) {
          const cacheKey = sharedPipelineCacheKey(
            accountIdentityRef.current,
            filtersRef.current,
          );
          if (cacheKey) {
            writeSharedPipelineCache(cacheKey, {
              rows: newRows,
              nextCursor: newCursor,
            });
          }
        }
      } catch (err: unknown) {
        if (
          requestSeqRef.current !== seq ||
          (contextEnabled &&
            useWorkspaceContextStore.getState().appliedGeneration !==
              contextGeneration)
        )
          return;
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to load shared workflows';
        setLoading(false);
        setLoadingMore(false);
        setError(message);
        setLoaded(true);
      }
    },
    [
      contextEnabled,
      contextGeneration,
      filters.createdBy,
      filters.q,
      filters.triggerType,
    ],
  );

  const refreshShared = useCallback(async (): Promise<void> => {
    await fetchPage(undefined, 'refresh');
  }, [fetchPage]);

  useEffect(() => {
    const changed = (): void => {
      void refreshShared();
    };
    window.addEventListener('canopy:pipeline-public-share-changed', changed);
    return (): void =>
      window.removeEventListener(
        'canopy:pipeline-public-share-changed',
        changed,
      );
  }, [refreshShared]);

  const loadMoreShared = useCallback(async (): Promise<void> => {
    if (loading || loadingMore || !nextCursor) return;
    await fetchPage(nextCursor, 'more');
  }, [fetchPage, loading, loadingMore, nextCursor]);

  const setFilters = useCallback((nextFilters: SharedListFilters): void => {
    setFiltersState((prev) => {
      const same =
        prev.q === nextFilters.q &&
        prev.triggerType === nextFilters.triggerType &&
        prev.createdBy === nextFilters.createdBy;
      if (same) return prev;
      return nextFilters;
    });
  }, []);

  // Whenever filters change, refetch if already loaded so the displayed rows
  // stay consistent with the active filter set.
  const previousFiltersRef = useRef<SharedListFilters>(filters);
  useEffect(() => {
    const prev = previousFiltersRef.current;
    if (
      prev.q === filters.q &&
      prev.triggerType === filters.triggerType &&
      prev.createdBy === filters.createdBy
    ) {
      return;
    }
    previousFiltersRef.current = filters;
    if (!loaded && !loading) return;
    if (!isCloudReady(cloudAccount)) return;
    void fetchPage(undefined, 'refresh');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const removeSharedRow = useCallback((remoteId: string): void => {
    setRows((prev) => prev.filter((row) => row.remoteId !== remoteId));
    // Evict from every cached list so a remount can't resurrect the deleted
    // row from the local cache.
    removeRowFromSharedPipelineCache(remoteId);
  }, []);

  return {
    cloudAccount,
    cloudLoading,
    rows,
    loading,
    loadingMore,
    nextCursor,
    error,
    loaded,
    refreshShared,
    loadMoreShared,
    setFilters,
    removeSharedRow,
  };
}
