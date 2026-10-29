import type { MarketplaceInfo, PluginInfo } from '@canopy/protocol/plugins';

/**
 * True when a plugin is hosted externally and has not yet been installed
 * (cloned/cached) — it has an external source but no resolved details on any
 * facet or at the top level. Mirrors PluginDetailView's `needsInstall`.
 */
export function pluginNeedsInstall(plugin: PluginInfo): boolean {
  if (plugin.parked) return false;
  if (!plugin.externalSource) {
    return false;
  }
  return !pluginHasContent(plugin);
}

/** Count of plugins in a marketplace that still need installing. */
export function countPluginsNeedingInstall(
  marketplace: MarketplaceInfo,
): number {
  return marketplace.plugins.filter(pluginNeedsInstall).length;
}

/** Resolved content on any provider is authoritative, including empty manifests. */
export function pluginHasContent(plugin: PluginInfo): boolean {
  return (
    !!plugin.facets.claude?.details ||
    !!plugin.facets.codex?.details ||
    !!plugin.facets.codexCompatibility?.details ||
    !!plugin.details
  );
}
