import {
  curateMarketplaceBrowse,
  type MarketplaceKindFilter,
  type InstalledEntryStatusStates,
  type PipelineFilterValues,
  type PluginsDiscoverySectionId,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  bundledServerStandsBehindPlugin,
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

/**
 * A server an installed plugin bundles is listed as that plugin, not as a
 * standalone server beside it (CAN-3653), unless it needs attention: hiding
 * it then would also hide the only place to connect it or see its failure.
 * A bundled skill keeps its own row, which follows the plugin (CAN-4844).
 */
export function listedAsItsPlugin(entry: UnifiedPluginEntry): boolean {
  return (
    entry.kind === 'app' &&
    entry.bundledBy !== undefined &&
    bundledServerStandsBehindPlugin(entry)
  );
}

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

/** The inventory and status snapshot agree on what still has an installation. */
export function marketplaceEntryIsInstalled(
  entry: UnifiedPluginEntry,
  states?: InstalledEntryStatusStates,
): boolean {
  if (entry.state === 'installed' || entry.state === 'needs-auth') return true;
  const state = states?.[entry.id];
  return (
    state?.kind === 'ready' &&
    state.item.notices.some((notice) => notice.code === 'partial_removal')
  );
}

/** One exclusion policy for section previews and standalone Browse pages. */
export function marketplaceBrowseEntries(
  entries: readonly UnifiedPluginEntry[],
  installedKeys: ReadonlySet<string> = new Set(),
  states?: InstalledEntryStatusStates,
  /** MCP search only: results that link to their plugin stay listed. */
  options: { readonly keepPluginProvided?: boolean } = {},
): UnifiedPluginEntry[] {
  return entries.filter(
    (entry) =>
      !installedKeys.has(entry.installedEntryId ?? entry.id) &&
      (entry.kind === 'blueprint' ||
        !marketplaceEntryIsInstalled(entry, states)) &&
      entry.installedEntryId === undefined &&
      (options.keepPluginProvided === true ||
        (entry.installedVia === undefined && !listedAsItsPlugin(entry))),
  );
}

/**
 * The All tab's plugin and MCP groups: Suggested first (role picks when the
 * host knows the user's roles, the curated featured set otherwise), then one
 * group per catalog category.
 */
export function buildMarketplaceBrowseGroups(
  results: RankedResults,
  options: {
    readonly suggestedNames?: readonly string[];
    readonly installedStatusStates?: InstalledEntryStatusStates;
  } = {},
): MarketplaceBrowseGroup[] {
  const browse = curateMarketplaceBrowse(
    marketplaceBrowseEntries(
      [
        ...results.installed.filter(
          (entry) =>
            (entry.kind === 'plugin' || entry.kind === 'app') &&
            !listedAsItsPlugin(entry),
        ),
        ...results.curatedPlugins,
        ...results.curatedApps,
        ...results.marketplace,
      ],
      new Set(),
      options.installedStatusStates,
    ),
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
