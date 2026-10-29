import {
  DEFAULT_PIPELINE_FILTERS,
  marketplaceEntryInTab,
  pipelineFiltersActive,
  type MarketplaceCatalogTabId,
  type PipelineFilterValues,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  buildMarketplaceBrowseGroups,
  MARKETPLACE_BROWSE_SECTION_LIMIT,
  marketplaceResultEntries,
  pipelineMatchesFilters,
} from './marketplaceBrowse';
import { searchUnifiedEntries } from './unifiedPluginEntries';

export const CUSTOMIZE_INSTALLED_PREVIEW_LIMIT = 8;

/** A failed read remains retryable; it must never look like ready/empty. */
export type CustomizeInventoryState =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error';
export type CustomizeSectionId =
  | 'updates'
  | 'installed'
  | 'shared-by-me'
  | 'browse';

export interface CustomizeBrowseGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly previewLimit?: number;
}

export interface CustomizeSectionModel {
  readonly id: CustomizeSectionId;
  readonly domId: `customize-section-${CustomizeSectionId}`;
  readonly title: string;
  /** Full matching membership, before any local preview/expansion. */
  readonly entries: readonly UnifiedPluginEntry[];
  readonly count: number;
  readonly showEntryTypes: boolean;
  readonly previewLimit?: number;
  readonly groups?: readonly CustomizeBrowseGroup[];
  readonly inventoryState?: CustomizeInventoryState;
  readonly emptyReason?: 'search' | 'pipeline-filters';
}

export interface CustomizeTabModelInput {
  readonly tab: MarketplaceCatalogTabId;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly query?: string;
  /** Ranked matches whose searchable metadata is held by the catalog reader. */
  readonly searchMatchedEntryIds?: readonly string[];
  readonly installedInventory: CustomizeInventoryState;
  readonly ownershipAvailable?: boolean;
  /** Initial web hosts pass no supported updates. */
  readonly supportedUpdateKinds?: readonly ('skill' | 'automation')[];
  readonly pipelineFilters?: PipelineFilterValues;
  readonly pipelineCategory?: string | null;
  readonly installedExpanded?: boolean;
  readonly suggestedNames?: readonly string[];
  readonly agentsAvailable?: boolean;
  readonly projectTemplatesAvailable?: boolean;
}

export interface CustomizeTabModel {
  readonly sections: readonly CustomizeSectionModel[];
  /** Distinct entries across eligible sections before previews, not row count. */
  readonly resultCount: number;
  readonly searchActive: boolean;
  readonly batchableUpdates: readonly UnifiedPluginEntry[];
  readonly showUpdateAll: boolean;
}

function unique(entries: readonly UnifiedPluginEntry[]): UnifiedPluginEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

const BROWSE_TITLES: Record<MarketplaceCatalogTabId, string> = {
  all: 'Browse',
  plugin: 'Browse plugins',
  app: 'Browse MCP servers',
  skill: 'Browse skills',
  workflow: 'Browse workflows',
  collection: 'Browse collections',
  agent: 'Shared with you',
  blueprint: 'Browse project templates',
};

function isInstalled(entry: UnifiedPluginEntry): boolean {
  return entry.state === 'installed' || entry.state === 'needs-auth';
}

function allBrowseGroups(
  entries: UnifiedPluginEntry[],
  searchActive: boolean,
  suggestedNames?: readonly string[],
): CustomizeBrowseGroup[] {
  const plugins = entries.filter(
    (entry) => entry.kind === 'plugin' || entry.kind === 'app',
  );
  const otherGroups: CustomizeBrowseGroup[] = [
    {
      id: 'shared-plugins',
      title: 'Shared plugins',
      entries: plugins.filter((entry) => entry.origin === 'shared'),
    },
    {
      id: 'skills',
      title: 'Skills',
      entries: entries.filter((entry) => entry.kind === 'skill'),
    },
    {
      id: 'workflows',
      title: 'Workflows',
      entries: entries.filter(
        (entry) => entry.kind === 'pipeline' || entry.kind === 'automation',
      ),
    },
    {
      id: 'collections',
      title: 'Collections',
      entries: entries.filter((entry) => entry.kind === 'collection'),
    },
    {
      id: 'agents',
      title: 'Agents',
      entries: entries.filter((entry) => entry.kind === 'agent'),
    },
    {
      id: 'project-templates',
      title: 'Project templates',
      entries: entries.filter((entry) => entry.kind === 'blueprint'),
    },
  ];
  if (searchActive) {
    return [
      {
        id: 'plugins-and-mcp',
        title: 'Plugins and MCP servers',
        entries: plugins,
      },
      ...otherGroups.slice(1),
    ].filter((group) => group.entries.length > 0);
  }
  const curated = buildMarketplaceBrowseGroups(
    searchUnifiedEntries(
      plugins.filter((entry) => entry.origin !== 'shared'),
      '',
      null,
    ),
    { suggestedNames },
  ).map((group) => ({
    ...group,
    previewLimit: MARKETPLACE_BROWSE_SECTION_LIMIT,
  }));
  return [...curated, ...otherGroups].filter(
    (group) => group.entries.length > 0,
  );
}

/** Pure section policy. Hosts own reads, expansion resets, mutations and retries. */
export function buildCustomizeTabModel(
  input: CustomizeTabModelInput,
): CustomizeTabModel {
  const query = input.query?.trim() ?? '';
  const searchActive = query !== '';
  const tabEntries = unique(input.entries).filter(
    (entry) =>
      marketplaceEntryInTab(entry, input.tab) &&
      (entry.kind !== 'agent' || input.agentsAvailable === true) &&
      (entry.kind !== 'blueprint' || input.projectTemplatesAvailable === true),
  );
  // Ranked search determines matching identities; section order remains stable.
  const matches = searchActive
    ? new Set(
        marketplaceResultEntries(searchUnifiedEntries(tabEntries, query, null))
          .map((entry) => entry.id)
          .concat(input.searchMatchedEntryIds ?? []),
      )
    : null;
  const entries = tabEntries.filter(
    (entry) => matches === null || matches.has(entry.id),
  );
  const sections: CustomizeSectionModel[] = [];
  function section(
    id: CustomizeSectionId,
    title: string,
    rows: readonly UnifiedPluginEntry[],
    extras: Partial<CustomizeSectionModel> = {},
  ): void {
    sections.push({
      id,
      domId: `customize-section-${id}`,
      title,
      entries: rows,
      count: rows.length,
      // Every row names its tinted type, single-kind tabs included, so
      // Updates, Installed and Browse rows read the same (CAN-4261).
      showEntryTypes: true,
      ...extras,
    });
  }
  const canonicalInstalls = new Map<string, UnifiedPluginEntry>();
  for (const entry of entries) {
    if (entry.kind === 'blueprint' || !isInstalled(entry)) continue;
    const key = entry.installedEntryId ?? entry.id;
    if (!canonicalInstalls.has(key) || entry.id === key)
      canonicalInstalls.set(key, entry);
  }
  // Missing desktop inventory does not erase known cloud/project installs.
  const installed = [...canonicalInstalls.values()];
  const updates = installed.filter(
    (entry) =>
      entry.updateAvailable === true &&
      ((entry.kind === 'skill' &&
        entry.ref.type === 'skill' &&
        !entry.builtIn &&
        !entry.custom &&
        input.supportedUpdateKinds?.includes('skill')) ||
        (entry.kind === 'automation' &&
          entry.ref.type === 'automation' &&
          input.supportedUpdateKinds?.includes('automation'))),
  );
  if (updates.length) section('updates', 'Updates', updates);
  if (
    input.tab !== 'blueprint' &&
    (installed.length || input.installedInventory !== 'ready')
  ) {
    section(
      'installed',
      input.tab === 'collection'
        ? 'Added'
        : input.tab === 'agent'
          ? 'Your agents'
          : 'Installed',
      installed,
      {
        inventoryState: input.installedInventory,
        ...(input.tab === 'all' && !searchActive && !input.installedExpanded
          ? { previewLimit: CUSTOMIZE_INSTALLED_PREVIEW_LIMIT }
          : {}),
      },
    );
  }
  const owned =
    input.ownershipAvailable && input.tab !== 'app'
      ? entries.filter(
          (entry) =>
            entry.origin === 'shared' &&
            entry.isShared !== false &&
            entry.ownedByViewer === true &&
            entry.kind !== 'app',
        )
      : [];
  if (owned.length) section('shared-by-me', 'Shared by me', owned);
  const filters = input.pipelineFilters ?? DEFAULT_PIPELINE_FILTERS;
  const category = input.pipelineCategory?.trim().toLowerCase();
  const browse = entries.filter(
    (entry) =>
      ['curated', 'marketplace', 'shared'].includes(entry.origin) &&
      (entry.origin !== 'shared' || entry.isShared !== false) &&
      (entry.kind !== 'pipeline' ||
        (pipelineMatchesFilters(entry, filters) &&
          (!category ||
            entry.categories.some(
              (value) => value.toLowerCase() === category,
            )))),
  );
  const groups =
    input.tab === 'all'
      ? allBrowseGroups(browse, searchActive, input.suggestedNames)
      : undefined;
  const browseEntries = groups
    ? unique(groups.flatMap((group) => group.entries))
    : browse;
  if (
    browseEntries.length ||
    (input.tab === 'workflow' &&
      (searchActive || pipelineFiltersActive(filters) || !!category))
  ) {
    section('browse', BROWSE_TITLES[input.tab], browseEntries, {
      ...(groups ? { groups } : {}),
      ...(!browseEntries.length
        ? { emptyReason: searchActive ? 'search' : 'pipeline-filters' }
        : {}),
    });
  }
  const batchableUpdates = updates.filter((entry) => entry.kind === 'skill');
  return {
    sections,
    resultCount: unique(sections.flatMap((section) => section.entries)).length,
    searchActive,
    batchableUpdates,
    showUpdateAll: batchableUpdates.length > 1,
  };
}
