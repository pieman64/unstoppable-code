import {
  curateMarketplaceBrowse,
  type MarketplaceKindFilter,
  type PipelineFilterValues,
  type PluginsDiscoverySectionId,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  searchUnifiedEntries,
  type RankedResults,
} from './unifiedPluginEntries';

/**
 * The Marketplace browse rules shared by the desktop Plugins page and the web
 * portal Plugins page: which entries a type tab and the pipeline filters keep,
 * and how the All tab groups them. Hosts own their data and actions; the page
 * each one renders follows from these functions, so a tab reads the same on both.
 */

/** Browse sections show this many entries before their "See all" page. */
export const MARKETPLACE_BROWSE_SECTION_LIMIT = 10;

export interface MarketplaceEntryFilter {
  readonly kindFilter: MarketplaceKindFilter | null;
  /** Narrows pipeline entries only; every other kind passes through. */
  readonly pipelineFilters: PipelineFilterValues;
}

export function filterMarketplaceEntries(
  entries: readonly UnifiedPluginEntry[],
  { kindFilter, pipelineFilters }: MarketplaceEntryFilter,
): UnifiedPluginEntry[] {
  return entries.filter((entry) => {
    if (kindFilter !== null && entry.kind !== kindFilter) return false;
    if (entry.kind !== 'pipeline') return true;
    return pipelineMatchesFilters(entry, pipelineFilters);
  });
}

export function pipelineMatchesFilters(
  entry: UnifiedPluginEntry,
  filters: PipelineFilterValues,
): boolean {
  const facets = entry.pipeline;
  if (filters.source !== 'all' && facets?.source !== filters.source) {
    return false;
  }
  if (filters.scope !== 'all' && !facets?.scopes.includes(filters.scope)) {
    return false;
  }
  if (
    filters.trigger !== 'all' &&
    !facets?.triggerTypes.includes(filters.trigger)
  ) {
    return false;
  }
  return true;
}

export interface MarketplaceBrowseGroup {
  readonly id: PluginsDiscoverySectionId;
  readonly title: string;
  readonly entries: UnifiedPluginEntry[];
}

/**
 * The All tab's plugin and MCP groups: Suggested first (role picks when the
 * host knows the user's roles, the curated featured set otherwise), then one
 * group per catalog category.
 */
export function buildMarketplaceBrowseGroups(
  results: RankedResults,
  options: { readonly suggestedNames?: readonly string[] } = {},
): MarketplaceBrowseGroup[] {
  const browse = curateMarketplaceBrowse(
    [
      ...results.installed.filter(
        (entry) => entry.kind === 'plugin' || entry.kind === 'app',
      ),
      ...results.curatedPlugins,
      ...results.curatedApps,
      ...results.marketplace,
    ],
    options.suggestedNames === undefined
      ? undefined
      : { suggestedNames: [...options.suggestedNames] },
  );
  return [
    { id: 'suggested', title: 'Suggested', entries: browse.featured },
    ...browse.categories.map(
      ({ slug, title, entries }): MarketplaceBrowseGroup => ({
        id: `category-${slug}`,
        title,
        entries,
      }),
    ),
  ];
}

/** Every ranked band, in the order search results list them. */
export function marketplaceResultEntries(
  results: RankedResults,
): UnifiedPluginEntry[] {
  return [
    ...results.installed,
    ...results.curatedPlugins,
    ...results.curatedApps,
    ...results.marketplace,
    ...results.sharedPlugins,
    ...results.skills,
    ...results.pipelines,
    ...results.automations,
    ...results.collections,
    ...results.agents,
    ...results.projectTemplates,
  ];
}

/** A browse group's "See all" page, narrowed by the page's own search. */
export function marketplaceCategoryPageEntries(
  group: MarketplaceBrowseGroup,
  query: string,
): UnifiedPluginEntry[] {
  if (query.trim() === '') return group.entries;
  return marketplaceResultEntries(
    searchUnifiedEntries(group.entries, query, null),
  );
}
