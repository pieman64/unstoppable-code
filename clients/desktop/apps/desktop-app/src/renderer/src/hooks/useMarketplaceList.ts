import { createMarketplaceSourceOperations } from '@canopy/app-core/client';

export const marketplaceSourceOperations = createMarketplaceSourceOperations();

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  MarketplaceInfo,
  MarketplaceRemovalResult,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';

interface UseMarketplaceListReturn {
  cache: PluginsCache | null;
  loading: boolean;
  error: string | null;
  progressMessage: string | null;
  /** Re-read the persisted marketplace cache without forcing provider sync. */
  reload: () => Promise<void>;
  /**
   * `providerUpdates` defaults to `'if-stale'`, honouring the 24h provider
   * TTL. Pass `'always'` only from a deliberate user gesture.
   */
  refresh: (providerUpdates?: 'always' | 'if-stale') => Promise<void>;
  upsertMarketplace: (marketplace: MarketplaceInfo) => void;
  applyMarketplaceRemoval: (
    marketplaceId: string,
    result: MarketplaceRemovalResult,
  ) => void;
}

export type MarketplaceCachePatcher = (cache: PluginsCache) => PluginsCache;

let currentMarketplaceCache: PluginsCache | null = null;

export function getCurrentMarketplaceCache(): PluginsCache | null {
  return currentMarketplaceCache;
}

export function subscribeMarketplaceCachePatches(
  listener: (patch: MarketplaceCachePatcher) => void,
): () => void {
  marketplaceCacheSubscribers.add(listener);
  return () => {
    marketplaceCacheSubscribers.delete(listener);
  };
}

const marketplaceCacheSubscribers = new Set<
  (patch: MarketplaceCachePatcher) => void
>();

/**
 * Apply an immutable patch to every mounted useMarketplaceList cache. Used to
 * propagate per-plugin derived-state changes (e.g. Codex compatibility
 * disabled) across the independent hook instances without a full reload.
 */
function patchAllMarketplaceCaches(patch: MarketplaceCachePatcher): void {
  if (currentMarketplaceCache)
    currentMarketplaceCache = patch(currentMarketplaceCache);
  marketplaceCacheSubscribers.forEach((subscriber) => {
    subscriber(patch);
  });
}

/**
 * Update the derived `codexCompatDisabled` flag for a single plugin across all
 * mounted marketplace caches. Plugin name match is case-insensitive to mirror
 * resolution/overlay key handling.
 */
export function applyCodexCompatDisabledToMarketplaceCaches(
  marketplaceId: string,
  pluginName: string,
  disabled: boolean,
): void {
  const target = pluginName.toLowerCase();
  patchAllMarketplaceCaches((cache) => ({
    ...cache,
    marketplaces: cache.marketplaces.map((marketplace) =>
      marketplace.id !== marketplaceId
        ? marketplace
        : {
            ...marketplace,
            plugins: marketplace.plugins.map((plugin) =>
              plugin.name.toLowerCase() === target
                ? { ...plugin, codexCompatDisabled: disabled }
                : plugin,
            ),
          },
    ),
  }));
}

/**
 * Replace a single plugin entry across all mounted marketplace caches with an
 * updated `PluginInfo` (e.g. after installing an external plugin). This keeps
 * the marketplace-list uninstalled counter and a reopened plugins modal in sync
 * without waiting for a full background refresh. Plugin name match is
 * case-insensitive to mirror resolution/overlay key handling.
 */
export function applyPluginUpdateToMarketplaceCaches(
  marketplaceId: string,
  marketplacePluginName: string,
  updated: PluginInfo,
): void {
  const target = marketplacePluginName.toLowerCase();
  patchAllMarketplaceCaches((cache) => ({
    ...cache,
    marketplaces: cache.marketplaces.map((marketplace) =>
      marketplace.id !== marketplaceId
        ? marketplace
        : {
            ...marketplace,
            plugins: marketplace.plugins.map((plugin) =>
              plugin.name.toLowerCase() === target ? updated : plugin,
            ),
          },
    ),
  }));
}

/**
 * Replace one marketplace row across all mounted caches, e.g. after the
 * shared Marketplaces surface updated it.
 */
export function applyMarketplaceUpsertToMarketplaceCaches(
  marketplace: MarketplaceInfo,
): void {
  patchAllMarketplaceCaches((cache) => ({
    ...cache,
    marketplaces: [
      ...cache.marketplaces.filter((entry) => entry.id !== marketplace.id),
      marketplace,
    ],
  }));
}

/** Apply a removal result (row gone, or its surviving state) to all caches. */
export function applyMarketplaceRemovalToMarketplaceCaches(
  marketplaceId: string,
  result: MarketplaceRemovalResult,
): void {
  patchAllMarketplaceCaches((cache) => ({
    ...cache,
    marketplaces:
      result.marketplace === null
        ? cache.marketplaces.filter((entry) => entry.id !== marketplaceId)
        : [
            ...cache.marketplaces.filter((entry) => entry.id !== marketplaceId),
            result.marketplace,
          ],
  }));
}

/** Replace every mounted cache with a fresher authoritative snapshot. */
export function applyPluginsCacheToMarketplaceCaches(next: PluginsCache): void {
  currentMarketplaceCache = next;
  patchAllMarketplaceCaches(() => next);
}

export interface UseMarketplaceListOptions {
  /**
   * When false, the initial catalog load is deferred until it flips true.
   * Lets always-mounted hosts (the composer menu) stay off the startup IPC
   * path until the user actually opens the surface that needs the catalog.
   */
  enabled?: boolean;
}

export function useMarketplaceList({
  enabled = true,
}: UseMarketplaceListOptions = {}): UseMarketplaceListReturn {
  const [cache, setCache] = useState<PluginsCache | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const cacheRevisionRef = useRef(0);

  const upsertMarketplace = useCallback((marketplace: MarketplaceInfo) => {
    applyMarketplaceUpsertToMarketplaceCaches(marketplace);
    cacheRevisionRef.current += 1;
    setCache((prev) => {
      const base: PluginsCache = prev ?? {
        version: 2,
        lastRefreshed: new Date().toISOString(),
        marketplaces: [],
      };
      return {
        ...base,
        lastRefreshed: new Date().toISOString(),
        marketplaces: [
          ...base.marketplaces.filter((entry) => entry.id !== marketplace.id),
          marketplace,
        ],
      };
    });
  }, []);

  const applyMarketplaceRemoval = useCallback(
    (marketplaceId: string, result: MarketplaceRemovalResult) => {
      applyMarketplaceRemovalToMarketplaceCaches(marketplaceId, result);
      cacheRevisionRef.current += 1;
      setCache((prev) => {
        if (!prev) return prev;
        const marketplaces =
          result.marketplace === null
            ? prev.marketplaces.filter((entry) => entry.id !== marketplaceId)
            : [
                ...prev.marketplaces.filter(
                  (entry) => entry.id !== marketplaceId,
                ),
                result.marketplace,
              ];
        return {
          ...prev,
          lastRefreshed: new Date().toISOString(),
          marketplaces,
        };
      });
    },
    [],
  );

  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    const revision = cacheRevisionRef.current;
    setLoading(true);
    setError(null);
    setProgressMessage('Loading cached marketplaces…');
    try {
      const result = await window.plugins.loadMarketplaces();
      if (
        generation !== requestGenerationRef.current ||
        revision !== cacheRevisionRef.current
      )
        return;
      if (result.success && result.data) {
        cacheRevisionRef.current += 1;
        applyPluginsCacheToMarketplaceCaches(result.data);
        setCache(result.data);
      } else {
        setError(result.error || 'Failed to load marketplaces');
      }
    } catch (err) {
      if (
        generation !== requestGenerationRef.current ||
        revision !== cacheRevisionRef.current
      )
        return;
      setError(String((err as Error)?.message || err));
    } finally {
      if (generation === requestGenerationRef.current) {
        setLoading(false);
        setProgressMessage(null);
      }
    }
  }, []);

  const refresh = useCallback(
    async (providerUpdates?: 'always' | 'if-stale') => {
      const release = marketplaceSourceOperations.acquire(null, 'update');
      if (!release) return;
      const generation = ++requestGenerationRef.current;
      const revision = cacheRevisionRef.current;
      setLoading(true);
      setError(null);
      setProgressMessage('Checking installed marketplaces…');
      try {
        const result =
          await window.plugins.refreshMarketplaces(providerUpdates);
        if (
          generation !== requestGenerationRef.current ||
          revision !== cacheRevisionRef.current
        )
          return;
        if (result.success && result.data) {
          cacheRevisionRef.current += 1;
          applyPluginsCacheToMarketplaceCaches(result.data);
          setCache(result.data);
        } else {
          setError(result.error || 'Failed to refresh marketplaces');
        }
      } catch (err) {
        if (
          generation !== requestGenerationRef.current ||
          revision !== cacheRevisionRef.current
        )
          return;
        setError(String((err as Error)?.message || err));
      } finally {
        release();
        if (generation === requestGenerationRef.current) {
          setLoading(false);
          setProgressMessage(null);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window.plugins.onMarketplaceOperationProgress !== 'function') {
      return undefined;
    }
    return window.plugins.onMarketplaceOperationProgress((progress) => {
      if (progress.operation !== 'load' && progress.operation !== 'refresh') {
        return;
      }
      if (progress.status === 'running') {
        setLoading(true);
        setError(null);
        setProgressMessage(progress.message);
      } else if (progress.status === 'complete') {
        setProgressMessage(null);
        void load();
      } else if (progress.status === 'error') {
        setLoading(false);
        setProgressMessage(null);
        setError(progress.message || 'Failed to refresh marketplaces');
      }
    });
  }, [load]);

  useEffect(() => {
    const subscriber = (patch: MarketplaceCachePatcher): void => {
      cacheRevisionRef.current += 1;
      setCache((prev) => {
        const base = prev ?? currentMarketplaceCache;
        return base ? patch(base) : prev;
      });
    };
    marketplaceCacheSubscribers.add(subscriber);
    return (): void => {
      marketplaceCacheSubscribers.delete(subscriber);
    };
  }, []);

  // Latch the first enable: a host that toggles `enabled` with its open state
  // (the composer menu) must not refetch the catalog on every reopen.
  const loadRequestedRef = useRef(false);
  useEffect(() => {
    if (!enabled || loadRequestedRef.current) return;
    loadRequestedRef.current = true;
    void load();
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled) return;
    return window.installedItems?.onChanged(() => {
      void load();
    });
  }, [enabled, load]);

  return {
    cache,
    loading,
    error,
    progressMessage,
    reload: load,
    refresh,
    upsertMarketplace,
    applyMarketplaceRemoval,
  };
}
