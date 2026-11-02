import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import {
  alwaysAvailableReason,
  BUNDLED_SKILL_FOOTNOTE,
  DEFAULT_PIPELINE_FILTERS,
  entryHasInstalledStatus,
  isBundledSkill,
  marketplaceEntryInTab,
  pipelineFiltersActive,
  type MarketplaceCatalogTabId,
  type MarketplaceTypeTabId,
  type PipelineFilterValues,
  type UnifiedPluginEntry,
  type InstalledEntryStatusState,
  type InstalledEntryStatusStates,
} from '@canopy/ui-shared/lib';
import {
  buildMarketplaceBrowseGroups,
  listedAsItsPlugin,
  MARKETPLACE_BROWSE_SECTION_LIMIT,
  marketplaceResultEntries,
  marketplaceBrowseEntries,
  marketplaceEntryIsInstalled,
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
  /** Installed only: set while a listed row is a plugin-bundled skill. */
  readonly installedFootnote?: string;
  /** A line under the section's list, such as when workflows run. */
  readonly footnote?: string;
}

/** Under the Workflows tab's Installed list (CAN-4845). */
export const WORKFLOW_INSTALLED_FOOTNOTE =
  'Pipelines run when you start them or their trigger fires. Automations run on their schedule.';

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
  readonly keepInstalledVisible?: boolean;
  /** Ignored on tabs without statuses (`customizeTabHasInstalledStatuses`). */
  readonly installedStatusFilter?: InstalledItemStatus;
  readonly installedStatusStates?: InstalledEntryStatusStates;
  /** Pinned filter membership; entries absent from it are evaluated live. */
  readonly installedStatusSnapshot?: InstalledStatusMembership;
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

/**
 * Tabs whose Installed rows carry a status (CAN-4838). Workflows and agents
 * have none, Marketplaces and Project templates have no Installed section.
 */
export function customizeTabHasInstalledStatuses(
  tab: MarketplaceTypeTabId,
): boolean {
  switch (tab) {
    case 'all':
    case 'plugin':
    case 'app':
    case 'skill':
    case 'collection':
      return true;
    case 'workflow':
    case 'agent':
    case 'sources':
    case 'blueprint':
      return false;
  }
}

/** Entry id to whether it matched the status filter when first read ready. */
export type InstalledStatusMembership = Readonly<Record<string, boolean>>;

/**
 * A membership snapshot and the `tab|context|filter` key it belongs to.
 * Hosts hold it above the list so it outlives an entry detail page, which
 * unmounts the list; a different key starts a fresh snapshot. `scope` is the
 * key without its context (`tab|filter`): a page that remounts before its
 * context resolves must not replace the held snapshot with an empty one.
 */
export interface InstalledStatusSnapshot {
  readonly key: string;
  readonly scope: string;
  readonly members: InstalledStatusMembership;
}

export const NO_INSTALLED_STATUS_MEMBERS: InstalledStatusMembership =
  Object.freeze({});

export const EMPTY_INSTALLED_STATUS_SNAPSHOT: InstalledStatusSnapshot = {
  key: '',
  scope: '',
  members: NO_INSTALLED_STATUS_MEMBERS,
};

/**
 * The id whose installed status a row follows: a catalog row's local
 * installation when it has one (CAN-5272), so a share and its install agree.
 */
export function installedStatusEntryId(
  entry: Pick<UnifiedPluginEntry, 'id' | 'installedEntryId'>,
): string {
  return entry.installedEntryId ?? entry.id;
}

function installedStatusState(
  entry: UnifiedPluginEntry,
  states: InstalledEntryStatusStates | undefined,
): InstalledEntryStatusState | undefined {
  return (
    states?.[statusEntryIdOf(entry)] ??
    (isBundledSkill(entry) ? undefined : states?.[entry.id])
  );
}

/** A bundled skill reads its plugin status; shares read their exact install. */
export function statusEntryIdOf(entry: UnifiedPluginEntry): string {
  return isBundledSkill(entry)
    ? entry.bundledBy.entryId
    : installedStatusEntryId(entry);
}

export function installedStatusMatches(
  entry: UnifiedPluginEntry,
  filter: InstalledItemStatus,
  state: InstalledEntryStatusState | undefined,
): boolean {
  if (state?.kind === 'ready')
    return (
      state.item.status === filter ||
      (filter === 'active' && state.item.status === null)
    );
  if (state?.kind === 'fixed') return state.status === filter;
  // An unreadable status proves no match (CAN-5272).
  if (state?.kind === 'read-only') return false;
  // Built-in workflows show a fixed Available status, so they match it.
  if (state === undefined && alwaysAvailableReason(entry) !== undefined)
    return filter === 'available';
  // Unknown/error/loading states stay visible rather than implying that an
  // unread item is inactive; entries that cannot carry a status match none.
  // A bundled skill whose plugin status is unread stays listed, as an
  // installed plugin with an unread status does.
  return (
    state !== undefined ||
    isBundledSkill(entry) ||
    entryHasInstalledStatus(entry)
  );
}

/**
 * Filter membership: a pinned ready match keeps its place, but a fixed or
 * unreadable status always decides on its own.
 */
function installedStatusMember(
  entry: UnifiedPluginEntry,
  filter: InstalledItemStatus,
  states: InstalledEntryStatusStates | undefined,
  snapshot: InstalledStatusMembership | undefined,
): boolean {
  const state = installedStatusState(entry, states);
  const pinned =
    state?.kind === 'fixed' || state?.kind === 'read-only'
      ? undefined
      : snapshot?.[installedStatusEntryId(entry)];
  return pinned ?? installedStatusMatches(entry, filter, state);
}

/**
 * Pins the filter match of every entry whose status is ready and not pinned
 * yet, so a status change while filtered keeps the row in place. Returns the
 * same reference when nothing was added; render-time callers rely on that.
 */
export function extendInstalledStatusSnapshot(
  snapshot: InstalledStatusMembership,
  filter: InstalledItemStatus,
  entries: readonly UnifiedPluginEntry[],
  states: InstalledEntryStatusStates | undefined,
): InstalledStatusMembership {
  let next: Record<string, boolean> | undefined;
  for (const entry of entries) {
    const key = installedStatusEntryId(entry);
    const state = installedStatusState(entry, states);
    if (state?.kind !== 'ready' || key in (next ?? snapshot)) continue;
    next ??= { ...snapshot };
    next[key] = installedStatusMatches(entry, filter, state);
  }
  return next ?? snapshot;
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
      !listedAsItsPlugin(entry) &&
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
      // Only All mixes kinds; single-kind tabs already name the kind in the
      // tab, so their rows drop the type chip (CAN-4840).
      showEntryTypes: input.tab === 'all',
      ...extras,
    });
  }
  function canonicalInstallsOf(
    rows: readonly UnifiedPluginEntry[],
  ): Map<string, UnifiedPluginEntry> {
    const result = new Map<string, UnifiedPluginEntry>();
    for (const entry of rows) {
      if (
        entry.kind === 'blueprint' ||
        !marketplaceEntryIsInstalled(
          entry,
          isBundledSkill(entry) ? undefined : input.installedStatusStates,
        )
      )
        continue;
      const key = installedStatusEntryId(entry);
      if (!result.has(key) || entry.id === key) result.set(key, entry);
    }
    return result;
  }
  const canonicalInstalls = canonicalInstallsOf(entries);
  // Missing desktop inventory does not erase known cloud/project installs.
  const allInstalled = [...canonicalInstalls.values()];
  const statusFilter =
    input.installedStatusFilter !== undefined &&
    customizeTabHasInstalledStatuses(input.tab)
      ? input.installedStatusFilter
      : undefined;
  const matchesStatus = (entry: UnifiedPluginEntry): boolean =>
    statusFilter === undefined ||
    installedStatusMember(
      entry,
      statusFilter,
      input.installedStatusStates,
      input.installedStatusSnapshot,
    );
  const installed = allInstalled.filter(matchesStatus);
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
    (installed.length ||
      input.installedInventory !== 'ready' ||
      input.keepInstalledVisible ||
      statusFilter)
  ) {
    const previewLimit =
      input.tab === 'all' && !searchActive && !input.installedExpanded
        ? CUSTOMIZE_INSTALLED_PREVIEW_LIMIT
        : undefined;
    // The footnote explains rows on screen, so a collapsed preview counts
    // only the rows it shows: `CustomizeInstalledList` renders the first
    // `previewLimit` of these rows, in this order.
    const visibleInstalled =
      previewLimit === undefined ? installed : installed.slice(0, previewLimit);
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
        ...(visibleInstalled.some(isBundledSkill)
          ? { installedFootnote: BUNDLED_SKILL_FOOTNOTE }
          : {}),
        ...(input.tab === 'workflow'
          ? { footnote: WORKFLOW_INSTALLED_FOOTNOTE }
          : {}),
        ...(previewLimit !== undefined ? { previewLimit } : {}),
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
            entry.kind !== 'app' &&
            matchesStatus(entry),
        )
      : [];
  if (owned.length) section('shared-by-me', 'Shared by me', owned);
  // Browse is what is not installed (CAN-5272): a status filter only applies
  // to installs, so it hides Browse, and an install never repeats there.
  if (!statusFilter) {
    const filters = input.pipelineFilters ?? DEFAULT_PIPELINE_FILTERS;
    const category = input.pipelineCategory?.trim().toLowerCase();
    // Exclusion reads the unsearched tab, so an alias matching by name stays
    // out even when its installation does not match.
    const installedKeys = searchActive
      ? canonicalInstallsOf(tabEntries)
      : canonicalInstalls;
    const browse = marketplaceBrowseEntries(
      entries,
      new Set(installedKeys.keys()),
    ).filter(
      (entry) =>
        !isBundledSkill(entry) &&
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
  }
  const batchableUpdates = updates.filter((entry) => entry.kind === 'skill');
  return {
    sections,
    // A share and its installation are one item.
    resultCount: new Set(
      sections.flatMap((section) =>
        section.entries.map(installedStatusEntryId),
      ),
    ).size,
    searchActive,
    batchableUpdates,
    showUpdateAll: batchableUpdates.length > 1,
  };
}
