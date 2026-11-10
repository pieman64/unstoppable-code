import { catalogSha256 } from '@canopy/core-runtime/node/catalog';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';

const FACET_KEYS = ['claude', 'codex', 'codexCompatibility'] as const;

/**
 * The install identity a materialization pins (CAN-4123 D11): a SHA-256 over
 * the catalog row's version, facets and the marketplace update stamp. Paths
 * are hashed, never returned.
 */
export function pluginCatalogRevision(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
): string {
  return catalogSha256({
    marketplaceId: marketplace.id,
    pluginName: plugin.name,
    version: plugin.version ?? null,
    marketplaceUpdated: marketplace.lastUpdated ?? null,
    facets: Object.fromEntries(
      FACET_KEYS.map((key) => {
        const facet = plugin.facets[key];
        return [
          key,
          facet
            ? {
                version: facet.version ?? null,
                cachedAt: facet.cachedAt ?? null,
                external: facet.externalSource ?? null,
                sourcePath: facet.sourcePath,
                installLocation: facet.installLocation,
                cachePath: facet.cachePath ?? null,
              }
            : null,
        ];
      }),
    ),
  });
}

/** The providers a session can load this plugin for. */
export function pluginCatalogProviders(
  plugin: PluginInfo,
): ('claude' | 'codex')[] {
  const providers: ('claude' | 'codex')[] = [];
  if (plugin.providerSupport.claude === 'native') providers.push('claude');
  if (
    plugin.providerSupport.codex === 'native' ||
    (plugin.providerSupport.codex === 'compat' &&
      plugin.codexCompatDisabled !== true)
  )
    providers.push('codex');
  return providers;
}
