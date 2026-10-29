import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { SharedCollectionSummary } from '@canopy/desktop-shared/types/collections';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';

const PAGE_SIZE = 25;
const COLLECTIONS_CRUD_CAPABILITY = 'collections-crud-v1';

export interface SharedCloudCollectionListState {
  cloudAccount: CanopyCloudAccountPublicState | null;
  cloudLoading: boolean;
  collections: SharedCollectionSummary[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: string | null;
  loaded: boolean;
}

export interface SharedCollectionListFilters {
  q?: string;
  createdBy?: 'me' | 'anyone';
}

export interface UseSharedCollectionListReturn extends SharedCloudCollectionListState {
  refreshShared: () => Promise<void>;
  loadMoreShared: () => Promise<void>;
  setFilters: (filters: SharedCollectionListFilters) => void;
  removeSharedRow: (remoteId: string) => void;
}

function hasCollectionsCapability(
  account: CanopyCloudAccountPublicState | null,
): boolean {
  return account?.capabilities.includes(COLLECTIONS_CRUD_CAPABILITY) === true;
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
 * Cursor-paginated loader for shared Collections from the configured Canopy
 * Cloud backend.
 *
 * Mirrors {@link useSharedPipelineList}/{@link useSharedSkillList}. Skipped
 * entirely when the account does not advertise `collections-crud-v1`.
 */
export function useSharedCollectionList(
  initialFilters?: SharedCollectionListFilters,
): UseSharedCollectionListReturn {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const [cloudAccount, setCloudAccount] =
    useState<CanopyCloudAccountPublicState | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [collections, setCollections] = useState<SharedCollectionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFiltersState] = useState<SharedCollectionListFilters>(
    initialFilters ?? {},
  );

  const requestSeqRef = useRef(0);
  const accountIdentityRef = useRef<string | null>(null);

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
            requestSeqRef.current += 1;
            setCollections([]);
            setLoading(false);
            setLoadingMore(false);
            setNextCursor(null);
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
            setCollections([]);
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
      if (!hasCollectionsCapability(cloudAccount)) {
        setLoading(false);
        setLoadingMore(false);
        setLoaded(true);
        return;
      }
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;

      if (mode === 'refresh') {
        setLoading(true);
        setLoadingMore(false);
        setNextCursor(null);
        setLoaded(false);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const response = await window.collections.listShared({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(filters.q ? { query: filters.q } : {}),
          ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
        });

        if (
          requestSeqRef.current !== seq ||
          (contextEnabled &&
            useWorkspaceContextStore.getState().appliedGeneration !==
              contextGeneration)
        )
          return;

        setLoading(false);
        setLoadingMore(false);
        setCollections((prev) =>
          mode === 'refresh'
            ? response.collections
            : [...prev, ...response.collections],
        );
        setNextCursor(response.nextCursor ?? null);
        setError(null);
        setLoaded(true);
      } catch (err: unknown) {
        if (
          requestSeqRef.current !== seq ||
          (contextEnabled &&
            useWorkspaceContextStore.getState().appliedGeneration !==
              contextGeneration)
        )
          return;
        const message = resolveSharedResourceErrorMessage(err);
        setLoading(false);
        setLoadingMore(false);
        setError(message);
        setLoaded(true);
      }
    },
    [
      cloudAccount,
      filters.createdBy,
      filters.q,
      contextEnabled,
      contextGeneration,
    ],
  );

  const refreshShared = useCallback(async (): Promise<void> => {
    await fetchPage(undefined, 'refresh');
  }, [fetchPage]);

  const loadMoreShared = useCallback(async (): Promise<void> => {
    if (loading || loadingMore || !nextCursor) return;
    await fetchPage(nextCursor, 'more');
  }, [fetchPage, loading, loadingMore, nextCursor]);

  const setFilters = useCallback(
    (nextFilters: SharedCollectionListFilters): void => {
      setFiltersState((prev) => {
        const same =
          prev.q === nextFilters.q && prev.createdBy === nextFilters.createdBy;
        if (same) return prev;
        return nextFilters;
      });
    },
    [],
  );

  const previousFiltersRef = useRef<SharedCollectionListFilters>(filters);
  useEffect(() => {
    const prev = previousFiltersRef.current;
    if (prev.q === filters.q && prev.createdBy === filters.createdBy) {
      return;
    }
    previousFiltersRef.current = filters;
    if (!loaded && !loading) return;
    if (!isCloudReady(cloudAccount)) return;
    void fetchPage(undefined, 'refresh');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const removeSharedRow = useCallback((remoteId: string): void => {
    setCollections((prev) =>
      prev.filter((collection) => collection.id !== remoteId),
    );
  }, []);

  return {
    cloudAccount,
    cloudLoading,
    collections,
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
