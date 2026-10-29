import type {
  MarketplaceSource,
  MarketplaceSourcePlugin,
} from '@canopy/app-core/client';

/** Filter value that matches plugins with no category or author. */
export const MARKETPLACE_SOURCE_FILTER_NONE = '__none__';

export interface MarketplaceSourcePluginFilters {
  readonly query: string;
  /** `null` matches every plugin; {@link MARKETPLACE_SOURCE_FILTER_NONE} matches unset. */
  readonly category: string | null;
  readonly author: string | null;
}

export const EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS: MarketplaceSourcePluginFilters =
  { query: '', category: null, author: null };

/**
 * Mirrors the desktop `pluginNeedsInstall`: an externally hosted plugin with
 * no resolved content on any provider. Plugins without install state (cloud
 * sources) never need installing here.
 */
export function sourcePluginNeedsInstall(
  plugin: MarketplaceSourcePlugin,
): boolean {
  const state = plugin.installState;
  return state !== undefined && state.externalSource && !state.hasContent;
}

/** Counts every plugin in the source, independent of the active filters. */
export function countSourcePluginsNeedingInstall(
  source: MarketplaceSource,
): number {
  return source.plugins.filter(sourcePluginNeedsInstall).length;
}

export function hasMarketplaceSourcePluginFilters(
  filters: MarketplaceSourcePluginFilters,
): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.category !== null ||
    filters.author !== null
  );
}

function matchesFacet(
  values: readonly string[],
  selected: string | null,
): boolean {
  if (selected === null) return true;
  if (selected === MARKETPLACE_SOURCE_FILTER_NONE) return values.length === 0;
  return values.includes(selected);
}

/** Search covers display name and source-scoped key. */
export function filterMarketplaceSourcePlugins(
  plugins: readonly MarketplaceSourcePlugin[],
  filters: MarketplaceSourcePluginFilters,
): MarketplaceSourcePlugin[] {
  const query = filters.query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    if (
      query !== '' &&
      !plugin.name.toLowerCase().includes(query) &&
      !plugin.key.toLowerCase().includes(query)
    ) {
      return false;
    }
    return (
      matchesFacet(plugin.categories ?? [], filters.category) &&
      matchesFacet(plugin.author ? [plugin.author] : [], filters.author)
    );
  });
}

export interface MarketplaceSourceFacetOptions {
  readonly values: readonly string[];
  /** True when at least one plugin has no value, so "None" is meaningful. */
  readonly hasNone: boolean;
}

function facetOptions(
  plugins: readonly MarketplaceSourcePlugin[],
  read: (plugin: MarketplaceSourcePlugin) => readonly string[],
): MarketplaceSourceFacetOptions {
  const values = new Set<string>();
  let hasNone = false;
  for (const plugin of plugins) {
    const pluginValues = read(plugin);
    if (pluginValues.length === 0) hasNone = true;
    for (const value of pluginValues) values.add(value);
  }
  return {
    values: [...values].sort((a, b) => a.localeCompare(b)),
    hasNone,
  };
}

export function marketplaceSourceCategoryOptions(
  plugins: readonly MarketplaceSourcePlugin[],
): MarketplaceSourceFacetOptions {
  return facetOptions(plugins, (plugin) => plugin.categories ?? []);
}

export function marketplaceSourceAuthorOptions(
  plugins: readonly MarketplaceSourcePlugin[],
): MarketplaceSourceFacetOptions {
  return facetOptions(plugins, (plugin) =>
    plugin.author ? [plugin.author] : [],
  );
}

export interface MarketplaceSourcePluginGroups {
  readonly recommended: readonly MarketplaceSourcePlugin[];
  readonly others: readonly MarketplaceSourcePlugin[];
}

/** Split recommendations out, keeping each plugin key in exactly one group. */
export function groupMarketplaceSourcePlugins(
  plugins: readonly MarketplaceSourcePlugin[],
): MarketplaceSourcePluginGroups {
  const seen = new Set<string>();
  const recommended: MarketplaceSourcePlugin[] = [];
  const others: MarketplaceSourcePlugin[] = [];
  for (const plugin of plugins) {
    if (plugin.recommended !== true || seen.has(plugin.key)) continue;
    seen.add(plugin.key);
    recommended.push(plugin);
  }
  for (const plugin of plugins) {
    if (seen.has(plugin.key)) continue;
    seen.add(plugin.key);
    others.push(plugin);
  }
  return { recommended, others };
}

/** Only http(s) links render; hosts should already omit anything else. */
export function safeMarketplaceSourceUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function marketplaceSourcePluginCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'plugin' : 'plugins'}`;
}
