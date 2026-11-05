import { useEffect, useState } from 'react';

/** What a plugin chip and its hover card show beyond the plugin's name. */
export interface PluginMentionDetails {
  readonly logoUrl?: string;
  readonly description?: string;
}

type DetailsByPlugin = ReadonlyMap<string, PluginMentionDetails>;

let catalog: Promise<DetailsByPlugin> | null = null;
/** Marketplace operations that write the cache the chips read. */
const CATALOG_WRITES: ReadonlySet<string> = new Set([
  'load',
  'refresh',
  'update',
]);
let revision = 0;
const listeners = new Set<() => void>();
let unsubscribeProgress: (() => void) | null = null;

/**
 * Forget the read once a marketplace load, refresh or update completes, so
 * chips pick up new and edited plugins.
 */
function watchCatalog(listener: () => void): () => void {
  listeners.add(listener);
  if (
    !unsubscribeProgress &&
    typeof window.plugins.onMarketplaceOperationProgress === 'function'
  ) {
    unsubscribeProgress = window.plugins.onMarketplaceOperationProgress(
      (progress) => {
        if (
          !CATALOG_WRITES.has(progress.operation) ||
          progress.status !== 'complete'
        ) {
          return;
        }
        catalog = null;
        revision += 1;
        for (const notify of listeners) notify();
      },
    );
  }
  return (): void => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // Unwatched, the read could miss a change: the next chip reads again.
    catalog = null;
    unsubscribeProgress?.();
    unsubscribeProgress = null;
  };
}

function pluginKey(marketplaceId: string, pluginName: string): string {
  return `${marketplaceId}/${pluginName.toLowerCase()}`;
}

/**
 * One cache-only marketplace read shared by every plugin chip, never a
 * provider refresh. A failed read is retried by the next chip that mounts.
 */
function loadCatalog(): Promise<DetailsByPlugin> {
  catalog ??= window.plugins
    .loadMarketplacesCacheOnly()
    .then((result) => {
      const details = new Map<string, PluginMentionDetails>();
      if (!result.success || !result.data) {
        catalog = null;
        return details;
      }
      for (const marketplace of result.data.marketplaces) {
        for (const plugin of marketplace.plugins) {
          const logoUrl =
            plugin.logoUrl ??
            plugin.facets.codex?.logoUrl ??
            plugin.facets.claude?.logoUrl;
          const description = plugin.description?.trim();
          details.set(pluginKey(marketplace.id, plugin.name), {
            ...(logoUrl ? { logoUrl } : {}),
            ...(description ? { description } : {}),
          });
        }
      }
      return details;
    })
    .catch(() => {
      catalog = null;
      return new Map();
    });
  return catalog;
}

/** The plugin's logo and description from the cached marketplaces, once read. */
export function usePluginMentionDetails(
  marketplaceId: string,
  pluginName: string,
): PluginMentionDetails | null {
  const [details, setDetails] = useState<PluginMentionDetails | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(revision);
  useEffect(() => watchCatalog(() => setCatalogRevision(revision)), []);
  useEffect(() => {
    let cancelled = false;
    void loadCatalog().then((byPlugin) => {
      if (!cancelled) {
        setDetails(byPlugin.get(pluginKey(marketplaceId, pluginName)) ?? null);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [marketplaceId, pluginName, catalogRevision]);
  return details;
}

/** Test seam: forget the shared read. */
export function resetPluginMentionDetailsForTests(): void {
  catalog = null;
  revision = 0;
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  listeners.clear();
}
