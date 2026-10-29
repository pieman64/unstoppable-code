import type {
  MarketplaceSource,
  MarketplaceSourcePluginInstallResult,
  MarketplaceSourceProgress,
  MarketplaceSourceRemoveResult,
  MarketplaceSourcesClient,
  MarketplaceSourcesSnapshot,
} from '@canopy/app-core/client';
import type {
  MarketplaceInfo,
  MarketplaceRemovalResult,
  PluginProvider,
  PluginsAPI,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import {
  getCurrentMarketplaceCache,
  marketplaceSourceOperations,
  subscribeMarketplaceCachePatches,
  type MarketplaceCachePatcher,
  applyMarketplaceRemovalToMarketplaceCaches,
  applyMarketplaceUpsertToMarketplaceCaches,
  applyPluginsCacheToMarketplaceCaches,
  applyPluginUpdateToMarketplaceCaches,
} from '@/hooks/useMarketplaceList';
import {
  marketplaceProviderLabel,
  toMarketplaceSource,
  toMarketplaceSourcePlugin,
} from './marketplace-source-summary';

type MarketplaceSourcesPluginsApi = Pick<
  PluginsAPI,
  | 'loadMarketplaces'
  | 'refreshMarketplaces'
  | 'updateMarketplace'
  | 'removeMarketplace'
  | 'installPlugin'
  | 'onMarketplaceOperationProgress'
>;

export interface IpcMarketplaceSourcesCacheSync {
  readonly current?: () => PluginsCache | null;
  readonly subscribe?: (
    listener: (patch: MarketplaceCachePatcher) => void,
  ) => () => void;
  readonly cache: (next: PluginsCache) => void;
  readonly upsert: (marketplace: MarketplaceInfo) => void;
  readonly remove: (id: string, result: MarketplaceRemovalResult) => void;
  readonly plugin: typeof applyPluginUpdateToMarketplaceCaches;
}

const DEFAULT_CACHE_SYNC: IpcMarketplaceSourcesCacheSync = {
  current: getCurrentMarketplaceCache,
  subscribe: subscribeMarketplaceCachePatches,
  cache: applyPluginsCacheToMarketplaceCaches,
  upsert: applyMarketplaceUpsertToMarketplaceCaches,
  remove: applyMarketplaceRemovalToMarketplaceCaches,
  plugin: applyPluginUpdateToMarketplaceCaches,
};

async function unwrap<T>(
  call: Promise<IPCResult<T>>,
  fallback: string,
): Promise<T> {
  const result = await call;
  if (!result.success || result.data === undefined) {
    throw new Error(result.error || fallback);
  }
  return result.data;
}

function partialRemovalWarning(result: MarketplaceRemovalResult): string {
  const failed = (
    ['claude', 'codex'] as const satisfies readonly PluginProvider[]
  )
    .map((provider) => {
      const outcome = result.providerOutcomes[provider];
      return outcome.error
        ? `${marketplaceProviderLabel(provider)}: ${outcome.error}`
        : null;
    })
    .filter((line): line is string => line !== null);
  return failed.length > 0
    ? `Some providers still list this marketplace. ${failed.join(' ')}`
    : 'Some providers still list this marketplace.';
}

/**
 * Desktop source management over the existing `window.plugins` IPC. Every
 * authoritative result is also patched into the mounted legacy
 * `useMarketplaceList` caches so the management view, modal and catalog
 * stay in step with the shared surface.
 */
export function createIpcMarketplaceSourcesClient(
  plugins: MarketplaceSourcesPluginsApi,
  sync: IpcMarketplaceSourcesCacheSync = DEFAULT_CACHE_SYNC,
): MarketplaceSourcesClient {
  const rows = new Map<string, MarketplaceInfo>();
  let lastCache: PluginsCache | null = null;
  let publishingRead = false;
  let cacheOperations = marketplaceSourceOperations.getSnapshot();

  const remember = (marketplace: MarketplaceInfo): void => {
    rows.set(marketplace.id, marketplace);
  };

  const snapshotFrom = (cache: PluginsCache): MarketplaceSourcesSnapshot => {
    lastCache = cache;
    rows.clear();
    cache.marketplaces.forEach(remember);
    return {
      sources: cache.marketplaces
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toMarketplaceSource),
      lastRefreshedAt: cache.lastRefreshed,
    };
  };

  const rowFor = async (sourceId: string): Promise<MarketplaceInfo> => {
    const cached = rows.get(sourceId);
    if (cached) return cached;
    snapshotFrom(
      await unwrap(plugins.loadMarketplaces(), 'Failed to load marketplaces'),
    );
    const loaded = rows.get(sourceId);
    if (!loaded) throw new Error('This marketplace is no longer available.');
    return loaded;
  };

  return {
    operations: marketplaceSourceOperations,
    cachedSnapshot(): MarketplaceSourcesSnapshot | null {
      if (cacheOperations !== marketplaceSourceOperations.getSnapshot())
        return null;
      const cache = sync.current?.();
      return cache ? snapshotFrom(cache) : null;
    },
    async list(): Promise<MarketplaceSourcesSnapshot> {
      const cache = await unwrap(
        plugins.loadMarketplaces(),
        'Failed to load marketplaces',
      );
      publishingRead = true;
      try {
        sync.cache(cache);
      } finally {
        publishingRead = false;
      }
      cacheOperations = marketplaceSourceOperations.getSnapshot();
      return snapshotFrom(cache);
    },

    subscribeSnapshot(listener): () => void {
      return (
        sync.subscribe?.((patch) => {
          if (publishingRead) return;
          const base = lastCache ?? sync.current?.();
          if (base) listener(snapshotFrom(patch(base)));
        }) ?? ((): void => undefined)
      );
    },

    async refreshAll(): Promise<MarketplaceSourcesSnapshot> {
      // A deliberate user gesture, so provider updates always run.
      const cache = await unwrap(
        plugins.refreshMarketplaces('always'),
        'Failed to refresh marketplaces',
      );
      sync.cache(cache);
      return snapshotFrom(cache);
    },

    async update(sourceId): Promise<MarketplaceSource> {
      const marketplace = await unwrap(
        plugins.updateMarketplace(sourceId),
        'Failed to update marketplace',
      );
      remember(marketplace);
      sync.upsert(marketplace);
      return toMarketplaceSource(marketplace);
    },

    async remove(sourceId): Promise<MarketplaceSourceRemoveResult> {
      const result = await unwrap(
        plugins.removeMarketplace(sourceId),
        'Failed to remove marketplace',
      );
      sync.remove(sourceId, result);
      if (result.marketplace === null) {
        rows.delete(sourceId);
        return { removed: true };
      }
      remember(result.marketplace);
      return {
        removed: false,
        source: toMarketplaceSource(result.marketplace),
        warning: partialRemovalWarning(result),
      };
    },

    async installPlugin(
      sourceId,
      pluginKey,
    ): Promise<MarketplaceSourcePluginInstallResult> {
      const marketplace = await rowFor(sourceId);
      const target = pluginKey.toLowerCase();
      const plugin = marketplace.plugins.find(
        (entry) => entry.name.toLowerCase() === target,
      );
      if (!plugin) throw new Error('This plugin is no longer available.');
      const result = await unwrap(
        plugins.installPlugin(
          sourceId,
          plugin.name,
          plugin.externalSource?.url ?? '',
        ),
        'Failed to install plugin.',
      );
      // The source key names the catalog row; a manifest may use a different
      // display name. Preserve that key through cache patches and reloads.
      const installed =
        result.name === plugin.name
          ? result
          : {
              ...result,
              name: plugin.name,
              displayName: result.displayName ?? result.name,
            };
      remember({
        ...marketplace,
        plugins: marketplace.plugins.map((entry) =>
          entry === plugin ? installed : entry,
        ),
      });
      sync.plugin(sourceId, plugin.name, installed);
      const providerOutcomes: Partial<
        Record<PluginProvider, { installed: boolean; error?: string }>
      > = {};
      for (const provider of ['claude', 'codex'] as const) {
        const status = installed.globalInstallStatus?.[provider];
        if (status?.available) {
          providerOutcomes[provider] = {
            installed: status.installed,
            ...((status.installError ?? status.error)
              ? { error: status.installError ?? status.error }
              : {}),
          };
        }
      }
      return {
        sourceId,
        plugin: toMarketplaceSourcePlugin(installed),
        providerOutcomes,
      };
    },

    subscribeProgress(listener): () => void {
      if (typeof plugins.onMarketplaceOperationProgress !== 'function') {
        return () => undefined;
      }
      return plugins.onMarketplaceOperationProgress((progress) => {
        if (
          progress.operation !== 'refresh' &&
          progress.operation !== 'update' &&
          progress.operation !== 'remove'
        ) {
          return;
        }
        const mapped: MarketplaceSourceProgress = {
          operation: progress.operation,
          status: progress.status,
          message: progress.message,
          ...(progress.marketplaceId
            ? { sourceId: progress.marketplaceId }
            : {}),
          ...(progress.currentStep !== undefined
            ? { currentStep: progress.currentStep }
            : {}),
          ...(progress.totalSteps !== undefined
            ? { totalSteps: progress.totalSteps }
            : {}),
        };
        listener(mapped);
      });
    },
  };
}
