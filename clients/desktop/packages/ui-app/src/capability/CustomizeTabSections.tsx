import {
  type ComponentType,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CustomizeInstalledList,
  CustomizeInstalledRow,
  CustomizeInstalledUnavailable,
  CustomizeSection,
  InstalledItemStatusControl,
  InstalledItemStatusPicker,
  Notice,
  NoticeButton,
  PluginsDiscoveryList,
  PluginsDiscoveryListLoading,
  type CustomizeRowMenuItem,
  type PluginsEntryStatusBinding,
  type McpServerLogoProps,
} from '@canopy/ui-shared/components';
import {
  SECONDARY_ACTION_BUTTON_CLASS,
  alwaysAvailableReason,
  pipelineFiltersActive,
  type MarketplaceEntryShareStates,
  type MarketplaceCatalogTabId,
  type PipelineFilterValues,
  type PluginsDiscoverySection,
  type PluginsDiscoverySectionId,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  buildCustomizeTabModel,
  type CustomizeBrowseGroup,
  type CustomizeInventoryState,
  type CustomizeSectionId,
  type CustomizeSectionModel,
} from './customizeSections';

export interface CustomizeUpdateFailure {
  readonly entry: UnifiedPluginEntry;
  readonly error: unknown;
}

export interface CustomizeInstalledUnavailableCopy {
  readonly title: string;
  readonly body: string;
  /** The host's existing pairing or sign-in control, when one applies. */
  readonly action?: ReactNode;
}

export interface CustomizeTabSectionsProps {
  readonly tab: MarketplaceCatalogTabId;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly query: string;
  readonly searchMatchedEntryIds?: readonly string[];
  readonly installedInventory: CustomizeInventoryState;
  /** Catalog-wide loading; renders the shared list skeleton. */
  readonly loading?: boolean;
  readonly ownershipAvailable?: boolean;
  /** Kinds whose update the host can perform. Omitted: no Updates section. */
  readonly supportedUpdateKinds?: readonly ('skill' | 'automation')[];
  readonly pipelineFilters?: PipelineFilterValues;
  readonly pipelineCategory?: string | null;
  readonly suggestedNames?: readonly string[];
  readonly agentsAvailable?: boolean;
  readonly projectTemplatesAvailable?: boolean;
  /** Changes when the surrounding context (project, organization) does. */
  readonly contextKey?: string;

  readonly selectedEntryId?: string | null;
  readonly onSelectEntry: (entry: UnifiedPluginEntry) => void;
  readonly hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  readonly onAddEntry?: (entry: UnifiedPluginEntry) => void;
  readonly onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  readonly onOpenEntryId?: (entryId: string) => void;
  readonly entryShareStates?: MarketplaceEntryShareStates;
  readonly entryStatus?: PluginsEntryStatusBinding;
  readonly onShareEntry?: (entry: UnifiedPluginEntry) => void;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  readonly showPipelineSources?: boolean;
  /** Opens a Browse group's full category page. */
  readonly onExpandBrowseGroup?: (groupId: string) => void;
  /** Browse heading controls, such as the Workflows pipeline filters. */
  readonly browseActions?: ReactNode;

  readonly installedUnavailable?: CustomizeInstalledUnavailableCopy;
  readonly onRetryInventory?: () => void;

  /** Performs one update; rejects on failure. Hosts refresh in `onUpdatesSettled`. */
  readonly onUpdateEntry?: (entry: UnifiedPluginEntry) => Promise<void>;
  readonly onUpdateFailures?: (
    failures: readonly CustomizeUpdateFailure[],
  ) => void;
  readonly onUpdatesSettled?: () => void;

  /** Extension slots for sibling features; nothing renders when omitted. */
  readonly menuExtensions?: (
    entry: UnifiedPluginEntry,
    sectionId: CustomizeSectionId,
  ) => readonly CustomizeRowMenuItem[];
  readonly renderStatus?: (entry: UnifiedPluginEntry) => ReactNode;
  readonly renderSharedActions?: (entry: UnifiedPluginEntry) => ReactNode;

  /** Creation-oriented state for a genuinely empty, unfiltered tab. */
  readonly emptyState?: ReactNode;
  readonly emptyMessage?: string;
  readonly searchEmptyMessage?: string;

  /** One-shot scroll target, honored once data settles. */
  readonly focusSection?: CustomizeSectionId | null;
  /** True while the data that decides the focus target is still loading. */
  readonly focusPending?: boolean;
  readonly onFocusSectionSettled?: () => void;
}

const TYPE_TAB_SECTION_IDS: Record<
  Exclude<MarketplaceCatalogTabId, 'all'>,
  PluginsDiscoverySectionId
> = {
  plugin: 'marketplace',
  app: 'apps',
  skill: 'skills',
  workflow: 'workflows',
  collection: 'collections',
  agent: 'agents',
  blueprint: 'project-templates',
};

const KNOWN_GROUP_IDS: readonly PluginsDiscoverySectionId[] = [
  'featured',
  'suggested',
  'recommended',
  'curated',
  'apps',
  'marketplace',
  'shared-plugins',
  'skills',
  'workflows',
  'collections',
  'agents',
  'project-templates',
  'plugins-and-mcp',
];

function discoverySectionId(id: string): PluginsDiscoverySectionId {
  const known = KNOWN_GROUP_IDS.find((candidate) => candidate === id);
  if (known) return known;
  return `category-${id.startsWith('category-') ? id.slice(9) : id}`;
}

function groupSection(
  group: CustomizeBrowseGroup,
  showEntryTypes: boolean,
  onExpand: ((groupId: string) => void) | undefined,
): PluginsDiscoverySection {
  const collapsed =
    group.previewLimit !== undefined && onExpand !== undefined
      ? Math.max(0, group.entries.length - group.previewLimit)
      : 0;
  return {
    id: discoverySectionId(group.id),
    title: group.title,
    entries: [...group.entries],
    showEntryTypes,
    ...(group.previewLimit !== undefined && onExpand
      ? { collapsedCount: collapsed, onExpand: () => onExpand(group.id) }
      : {}),
  };
}

const DEFAULT_UNAVAILABLE: CustomizeInstalledUnavailableCopy = {
  title: 'Installed items aren’t available here',
  body: 'Browse is still available. Installed items show up once this device can read them.',
};

/**
 * The Customize page body shared by desktop and web: Updates, Installed,
 * Shared by me and Browse, in that order. Hosts supply reads and actions.
 */
export function CustomizeTabSections(
  props: CustomizeTabSectionsProps,
): JSX.Element {
  const {
    tab,
    entries,
    query,
    searchMatchedEntryIds,
    installedInventory,
    loading = false,
    ownershipAvailable,
    supportedUpdateKinds,
    pipelineFilters,
    pipelineCategory,
    suggestedNames,
    agentsAvailable,
    projectTemplatesAvailable,
    contextKey = '',
    selectedEntryId = null,
    onSelectEntry,
    hrefForEntry,
    onAddEntry,
    onConnectEntry,
    onOpenEntryId,
    entryShareStates,
    entryStatus,
    onShareEntry,
    McpServerLogoComponent,
    showPipelineSources,
    onExpandBrowseGroup,
    browseActions,
    installedUnavailable = DEFAULT_UNAVAILABLE,
    onRetryInventory,
    onUpdateEntry,
    onUpdateFailures,
    onUpdatesSettled,
    menuExtensions,
    renderStatus,
    renderSharedActions,
    emptyState,
    emptyMessage = 'Nothing here yet.',
    searchEmptyMessage = 'Nothing matches your search.',
    focusSection,
    focusPending = false,
    onFocusSectionSettled,
  } = props;
  const searchActive = query.trim() !== '';
  // Expansion belongs to one tab/context/search mode; changing any resets it,
  // while inventory refreshes leave an expanded list expanded.
  const expansionScope = `${tab}|${contextKey}|${searchActive ? 'search' : 'browse'}`;
  const [expansion, setExpansion] = useState({
    scope: expansionScope,
    expanded: false,
  });
  if (expansion.scope !== expansionScope) {
    // Adjusting state during render resets before the stale value paints.
    setExpansion({ scope: expansionScope, expanded: false });
  }
  const installedExpanded =
    expansion.scope === expansionScope && expansion.expanded;

  const model = useMemo(
    () =>
      buildCustomizeTabModel({
        tab,
        entries,
        query,
        searchMatchedEntryIds,
        installedInventory,
        ownershipAvailable,
        supportedUpdateKinds,
        pipelineFilters,
        pipelineCategory,
        installedExpanded,
        suggestedNames,
        agentsAvailable,
        projectTemplatesAvailable,
      }),
    [
      tab,
      entries,
      query,
      searchMatchedEntryIds,
      installedInventory,
      ownershipAvailable,
      supportedUpdateKinds,
      pipelineFilters,
      pipelineCategory,
      installedExpanded,
      suggestedNames,
      agentsAvailable,
      projectTemplatesAvailable,
    ],
  );

  // Refs guard against double submission before React re-renders.
  const inFlight = useRef(new Set<string>());
  const batchRunningRef = useRef(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);

  const runUpdate = useCallback(
    async (
      entry: UnifiedPluginEntry,
    ): Promise<CustomizeUpdateFailure | null> => {
      if (!onUpdateEntry || inFlight.current.has(entry.id)) return null;
      inFlight.current.add(entry.id);
      setBusyIds(new Set(inFlight.current));
      try {
        await onUpdateEntry(entry);
        return null;
      } catch (error) {
        return { entry, error };
      } finally {
        inFlight.current.delete(entry.id);
        setBusyIds(new Set(inFlight.current));
      }
    },
    [onUpdateEntry],
  );

  const updateOne = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (batchRunningRef.current || inFlight.current.has(entry.id)) return;
      const failure = await runUpdate(entry);
      if (failure) onUpdateFailures?.([failure]);
      onUpdatesSettled?.();
    },
    [onUpdateFailures, onUpdatesSettled, runUpdate],
  );

  const batchSnapshot = model.batchableUpdates;
  const updateAll = useCallback(async (): Promise<void> => {
    if (batchRunningRef.current || inFlight.current.size > 0 || !onUpdateEntry)
      return;
    batchRunningRef.current = true;
    setBatchRunning(true);
    const failures: CustomizeUpdateFailure[] = [];
    try {
      // Sequential, continuing past individual failures.
      for (const entry of batchSnapshot) {
        if (inFlight.current.has(entry.id)) continue;
        const failure = await runUpdate(entry);
        if (failure) failures.push(failure);
      }
    } finally {
      batchRunningRef.current = false;
      setBatchRunning(false);
    }
    if (failures.length > 0) onUpdateFailures?.(failures);
    onUpdatesSettled?.();
  }, [
    batchSnapshot,
    onUpdateEntry,
    onUpdateFailures,
    onUpdatesSettled,
    runUpdate,
  ]);

  const focusTargetDomId = focusSection
    ? (model.sections.find((section) => section.id === focusSection)?.domId ??
      null)
    : null;
  useEffect(() => {
    if (!focusSection || !onFocusSectionSettled || loading || focusPending)
      return;
    if (focusTargetDomId) {
      document
        .getElementById(focusTargetDomId)
        ?.scrollIntoView?.({ block: 'start' });
    }
    // Absent or present, the intent is spent so a later render cannot scroll.
    onFocusSectionSettled();
  }, [
    focusSection,
    focusPending,
    focusTargetDomId,
    loading,
    onFocusSectionSettled,
  ]);

  if (loading) return <PluginsDiscoveryListLoading />;

  const updateIds = new Set(
    model.sections
      .find((section) => section.id === 'updates')
      ?.entries.map((entry) => entry.id) ?? [],
  );

  function menuItems(
    entry: UnifiedPluginEntry,
    sectionId: CustomizeSectionId,
  ): CustomizeRowMenuItem[] {
    const items: CustomizeRowMenuItem[] = [];
    if (entry.state === 'needs-auth' && onConnectEntry)
      items.push({
        id: 'connect',
        label: 'Connect',
        onSelect: () => onConnectEntry(entry),
      });
    items.push({
      id: 'details',
      label: 'Open details',
      onSelect: () => onSelectEntry(entry),
    });
    if (updateIds.has(entry.id) && onUpdateEntry)
      items.push({
        id: 'update',
        label: 'Update',
        disabled: batchRunning || busyIds.has(entry.id),
        onSelect: () => void updateOne(entry),
      });
    const share = entryShareStates?.get(entry.id);
    if (share && onShareEntry)
      items.push({
        id: 'share',
        label: 'Share',
        disabled: share.status === 'blocked',
        disabledReason: share.status === 'blocked' ? share.reason : undefined,
        onSelect: () => onShareEntry(entry),
      });
    return [...items, ...(menuExtensions?.(entry, sectionId) ?? [])];
  }

  function renderRow(
    entry: UnifiedPluginEntry,
    section: CustomizeSectionModel,
  ): ReactNode {
    const updating = busyIds.has(entry.id);
    const statusState = entryStatus?.states[entry.id];
    // A row with a connection badge already shows its one status; a
    // read-only Unavailable beside "Connected" would contradict it. The
    // section's unavailable notice explains the missing desktop (CAN-4261).
    const showStatusControl =
      statusState !== undefined &&
      !(statusState.kind === 'read-only' && entry.connection !== undefined);
    return (
      <CustomizeInstalledRow
        entry={entry}
        sectionId={section.id}
        selected={entry.id === selectedEntryId}
        showEntryType={section.showEntryTypes}
        onSelect={onSelectEntry}
        href={hrefForEntry?.(entry)}
        menuItems={menuItems(entry, section.id)}
        status={
          renderStatus?.(entry) ??
          (entryStatus &&
            (showStatusControl ||
              (statusState === undefined &&
                alwaysAvailableReason(entry) !== undefined)) && (
              // Only a row that shows a status keeps the aligned slot; an empty
              // one would squeeze the name in a half-width column.
              <span
                data-testid="customize-row-status-slot"
                className="flex w-36 shrink-0 justify-end"
              >
                {showStatusControl ? (
                  <InstalledItemStatusControl
                    itemName={entry.name}
                    state={statusState}
                    pendingKeys={entryStatus.pendingKeys}
                    onSetStatus={entryStatus.onSetStatus}
                    onError={entryStatus.onError}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                ) : statusState === undefined &&
                  alwaysAvailableReason(entry) !== undefined ? (
                  <InstalledItemStatusPicker
                    itemName={entry.name}
                    status="available"
                    disabledReason={alwaysAvailableReason(entry)}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                ) : null}
              </span>
            ))
        }
        McpServerLogoComponent={McpServerLogoComponent}
        actions={
          section.id === 'updates' && onUpdateEntry ? (
            <button
              type="button"
              data-testid={`customize-update-${entry.id}`}
              aria-label={`Update ${entry.name}`}
              disabled={updating || batchRunning}
              aria-busy={updating}
              onClick={() => void updateOne(entry)}
              className={`${SECONDARY_ACTION_BUTTON_CLASS} disabled:opacity-60`}
            >
              {updating ? 'Updating…' : 'Update'}
            </button>
          ) : section.id === 'shared-by-me' ? (
            renderSharedActions?.(entry)
          ) : undefined
        }
      />
    );
  }

  function renderInstalled(section: CustomizeSectionModel): ReactNode {
    const state = section.inventoryState ?? 'ready';
    return (
      <>
        {section.entries.length > 0 && (
          <CustomizeInstalledList
            sectionId={section.id}
            entries={section.entries}
            previewLimit={section.previewLimit}
            onShowAll={() =>
              setExpansion({ scope: expansionScope, expanded: true })
            }
            renderRow={(entry) => renderRow(entry, section)}
          />
        )}
        {state === 'loading' && section.entries.length === 0 && (
          <p
            role="status"
            data-testid="customize-installed-loading"
            className="mt-3 px-0 py-3 text-s fg-secondary"
          >
            Loading installed items…
          </p>
        )}
        {state === 'error' && (
          <Notice
            intent="destructive"
            className="mt-3"
            data-testid="customize-installed-error"
            actions={
              onRetryInventory ? (
                <NoticeButton onClick={onRetryInventory}>
                  Try again
                </NoticeButton>
              ) : undefined
            }
          >
            Couldn’t load installed items.
          </Notice>
        )}
        {state === 'unavailable' && (
          <CustomizeInstalledUnavailable
            title={installedUnavailable.title}
            body={installedUnavailable.body}
            action={installedUnavailable.action}
          />
        )}
      </>
    );
  }

  function renderBrowse(section: CustomizeSectionModel): ReactNode {
    const sections: PluginsDiscoverySection[] = section.groups
      ? section.groups.map((group) =>
          groupSection(group, section.showEntryTypes, onExpandBrowseGroup),
        )
      : [
          {
            id: tab === 'all' ? 'marketplace' : TYPE_TAB_SECTION_IDS[tab],
            title: '',
            entries: [...section.entries],
            showEntryTypes: section.showEntryTypes,
          },
        ];
    return (
      <div className="mt-3">
        <PluginsDiscoveryList
          sections={sections}
          selectedEntryId={selectedEntryId}
          onSelectEntry={onSelectEntry}
          onAddEntry={onAddEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={onConnectEntry}
          onOpenEntryId={onOpenEntryId}
          emptyMessage={
            section.emptyReason === 'pipeline-filters'
              ? 'No pipelines match these filters.'
              : searchEmptyMessage
          }
          McpServerLogoComponent={McpServerLogoComponent}
          showPipelineSources={showPipelineSources}
          hrefForEntry={hrefForEntry}
          installedAction="label"
          entryStatus={entryStatus}
        />
      </div>
    );
  }

  const remainingBrowseActions =
    tab === 'workflow' &&
    !model.sections.some((section) => section.id === 'browse')
      ? browseActions
      : null;
  if (model.sections.length === 0) {
    const filtered =
      searchActive ||
      !!pipelineCategory ||
      (pipelineFilters !== undefined && pipelineFiltersActive(pipelineFilters));
    return (
      <div data-testid="customize-sections" data-result-count={0}>
        {remainingBrowseActions}
        {filtered || !emptyState ? (
          <p
            data-testid="customize-sections-empty"
            className="py-10 text-center text-s fg-secondary"
          >
            {filtered ? searchEmptyMessage : emptyMessage}
          </p>
        ) : (
          emptyState
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="customize-sections"
      data-result-count={model.resultCount}
      className="space-y-10"
    >
      {searchActive && (
        <p
          data-testid="customize-result-count"
          aria-live="polite"
          className="sr-only"
        >
          {model.resultCount === 1
            ? '1 result'
            : `${model.resultCount} results`}
        </p>
      )}
      {model.sections.map((section) => (
        <CustomizeSection
          key={section.id}
          domId={section.domId}
          title={section.title}
          count={
            // An unread inventory is unknown, not zero.
            section.count === 0 &&
            (section.inventoryState ?? 'ready') !== 'ready'
              ? undefined
              : section.count
          }
          actions={
            section.id === 'updates' && model.showUpdateAll && onUpdateEntry ? (
              <button
                type="button"
                data-testid="customize-update-all"
                disabled={batchRunning || busyIds.size > 0}
                aria-busy={batchRunning}
                onClick={() => void updateAll()}
                className={`${SECONDARY_ACTION_BUTTON_CLASS} disabled:opacity-60`}
              >
                {batchRunning ? 'Updating…' : 'Update all'}
              </button>
            ) : section.id === 'browse' && tab === 'workflow' ? (
              browseActions
            ) : undefined
          }
        >
          {section.id === 'installed' ? (
            renderInstalled(section)
          ) : section.id === 'browse' ? (
            renderBrowse(section)
          ) : (
            <CustomizeInstalledList
              sectionId={section.id}
              entries={section.entries}
              renderRow={(entry) => renderRow(entry, section)}
            />
          )}
        </CustomizeSection>
      ))}
      {remainingBrowseActions}
    </div>
  );
}
