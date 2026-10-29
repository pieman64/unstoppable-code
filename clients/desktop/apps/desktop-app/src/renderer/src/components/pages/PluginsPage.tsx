import {
  CustomizeTabSections,
  buildCustomizeTabModel,
  useResourceContext,
} from '@canopy/ui-app/capability';
import { useCapabilities } from '@canopy/app-state';
import type { MarketplaceSource } from '@canopy/app-core/client';
import {
  EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
  MarketplaceSourceDetail,
  MarketplaceSourcesList,
  useMarketplaceSources,
  useMarketplaceSourcesAccess,
  type MarketplaceSourcePluginFilters,
} from '@canopy/ui-app/marketplace-sources';
import {
  formatMarketplaceRemoveBodyCopy,
  marketplaceSourceValidProviders,
} from '@/client/marketplace-source-summary';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import { CuratedPipelinePreview } from '../pipeline/CuratedPipelinePreview';
import { curatedPipelineId } from '../pipeline/pipeline-catalog-entry';
import {
  type JSX,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageHeading } from '../shared/PageHeading';
import { PageContent } from '../shared/PageContent';
import { TITLEBAR_BUTTON_CLASSNAME } from '../sidebar/sidebar-styles';
import { useMarketplaceList } from '../../hooks/useMarketplaceList';
import { useCuratedMcpServers } from '../../hooks/useCuratedMcpServers';
import { useMcpServerList } from '../../hooks/useMcpServerList';
import { useSkillList } from '../../hooks/useSkillList';
import { useCustomizeSkillUpdates } from '../../hooks/useCustomizeSkillUpdates';
import { usePublisherSkills } from '../../hooks/usePublisherSkills';
import { useCapabilityMarketplaceInventory } from '../../hooks/useCapabilityMarketplaceInventory';
import { McpServerDialog } from './McpServersTab';
import { AddSkillsModal, CreateSkillModal } from './SkillsTab';
import { CollectionModal } from './CollectionsTab';
import { ErrorBanner } from '../shared';
import { McpServerLogo } from '../shared/McpServerLogo';
import { summarizeLoadErrors } from '@/lib/summarizeLoadErrors';
import {
  buildInstalledSkillEntry,
  buildUnifiedPluginEntries,
  collectEntryCategories,
  curatedCatalogFromMarketplaces,
  marketplaceTitleCase,
  findAccountMcpRow,
  pickerMcpServers,
  searchUnifiedEntries,
  buildMarketplaceBrowseGroups,
  marketplaceCategoryPageEntries,
  localAgentIdFromEntryId,
  pendingLocalAgentEntry,
  pendingSharedAutomationEntry,
  type UnifiedPluginEntry,
  visibleEntryId,
} from '../../lib/unifiedPluginEntries';
import { marketplaceBrowseNameKey } from '../../lib/marketplaceBrowseCuration';
import {
  ROLE_PLUGIN_RECOMMENDATIONS,
  resolveRolePluginRecommendations,
} from '@canopy/desktop-shared/lib/role-plugin-recommendations';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useSavedProfileRoles } from '@/hooks/useSavedProfileRoles';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { PluginsDiscoveryList } from '../plugins/PluginsDiscoveryList';
import type { PluginsDiscoverySectionId } from '../plugins/pluginsDiscoverySections';
import { PluginEntryDetail } from '../plugins/PluginEntryDetail';
import { PipelineCatalogStatus } from '../plugins/PipelineCatalogStatus';
import { AutomationCatalogStatus } from '../plugins/AutomationCatalogStatus';
import {
  AddMarketplaceModal,
  MarketplacePluginsModal,
  PluginsManagementView,
  type PluginsManagementSection,
} from '../plugins/PluginsManagementView';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import { useProviderConnectors } from '@/hooks/useProviderConnectors';
import { advertisesProviderConnector } from '@/lib/unifiedPluginEntries';
import { SharePluginModal } from '@/components/plugins/SharePluginModal';
import {
  useNavigationStore,
  type CapabilityMarketplaceTabId,
  type PipelineReturnTarget,
} from '@/stores/navigationStore';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import { PLUGINS_MANAGEMENT_SECTIONS } from '@canopy/desktop-shared/types';
import type {
  McpServerStatusEntry,
  McpServerIndexEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import { ChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  CustomizeSectionHeading,
  EmptyState,
  MarketplaceSearchField,
  MarketplaceTypeTabs,
  PluginsAddCustomMenu,
  Notice,
  NoticeButton,
  PluginsPipelineFilters,
  RefreshButton,
  useOverlayEscape,
  CustomizeBreadcrumbs,
} from '@canopy/ui-shared/components';
import {
  DEFAULT_PIPELINE_FILTERS,
  type MarketplaceCatalogTabId,
  marketplaceEntityTypeLabel,
  marketplaceShareAction,
  marketplaceTypeTabs,
  marketplaceEntryInTab,
  marketplaceTabForKind,
  normalizeMarketplaceNavigation,
  type MarketplaceEntryShareState,
  type PipelineFilterValues,
} from '@canopy/ui-shared/lib';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useShareAction } from '@/hooks/useShareAction';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useMarketplaceOwnedShare } from '../plugins/useMarketplaceOwnedShare';
import {
  createMarketplaceEntryShareResolver,
  refreshMarketplaceEntryShareResolution,
  marketplaceEntryShareState,
  type MarketplaceShareResolution,
  type PluginShareTarget,
} from '../plugins/marketplaceShareResolution';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import { SKILLS_CHANGED_EVENT, trackSkillsRefresh } from '@/lib/skillsChanged';
import { COLLECTIONS_CHANGED_EVENT } from '../share/installReveal';
import { marketplaceEntryInstallLink } from '@/lib/sharedResourceInstallLink';
import { AgentModelModal } from '../agents/AgentModelModal';
import { DeleteConfirmModal } from '../shared/DeleteConfirmModal';
import { useAgentsStore } from '@/stores/agentsStore';
import { extractIpcErrorMessage } from '@/lib/errors';
import type { SaveAgentModelRequest } from '@canopy/desktop-shared/types/agent-models';

type PluginsTab = 'collections' | 'marketplace' | 'skills' | 'mcp';
const PLUGINS_OPEN_TAB_EVENT = 'canopy:plugins-open-tab';
const PLUGINS_OPEN_MANAGEMENT_EVENT = 'canopy:plugins-open-management';
const PLUGIN_OPEN_DETAIL_EVENT = 'canopy:plugin-open-detail';
/**
 * Curated MCP browse. The event used to be handled by `McpServersTab`, but the
 * redesign removed the curated Browse affordance from the MCP section and gave
 * discovery ownership of it (API-2153, design section 5).
 */
const MCP_OPEN_BROWSE_EVENT = 'canopy:mcp-open-browse';
function entryUsesDetailPage(
  entry: UnifiedPluginEntry,
  mcpServers: readonly McpServerIndexEntry[],
): boolean {
  const ref = entry.ref;
  // Every installed skill, custom ones included, opens as a page (CAN-3483);
  // editing a custom skill opens its editor dialog over that page.
  if (ref.type === 'skill') return true;
  if (ref.type === 'local-mcp')
    return !findAccountMcpRow(mcpServers, ref.serverId);
  if (ref.type === 'curated-mcp') return true;
  return true;
}

export type { PluginsManagementSection };

/** Every curated name any role can recommend, in first-seen order. */
const ROLE_RECOMMENDATION_NAMES = Array.from(
  new Set(Object.values(ROLE_PLUGIN_RECOMMENDATIONS).flat()),
);

/**
 * Normalize an inbound tab id from an external event/action. The legacy
 * `bundles` alias still resolves to the `collections` tab so old App Advisor
 * prompts and persisted state continue to work after the rename.
 */
function normalizePluginsTabId(raw: string | undefined): PluginsTab | null {
  if (!raw) return null;
  if (raw === 'bundles' || raw === 'collections') return 'collections';
  if (raw === 'skills' || raw === 'mcp' || raw === 'marketplace') return raw;
  return null;
}

/**
 * Map a legacy tab id onto the management view's section id. The tabs became
 * sections of the "Your plugins" view in the discovery redesign (API-2153), so
 * every existing `canopy:plugins-open-tab` deep link still lands somewhere
 * meaningful.
 */
function managementSectionForTabId(tab: PluginsTab): PluginsManagementSection {
  return tab === 'marketplace' ? 'marketplaces' : tab;
}

/**
 * Preserve the active marketplace type when the Installed summary opens the
 * management surface. Plugin and pipeline have no dedicated management
 * section, so callers can fall back to either the mixed Installed list or the
 * corresponding Marketplace type tab.
 */
function managementSectionForCapabilityType(
  tab: CapabilityMarketplaceTabId,
): PluginsManagementSection | null {
  switch (tab) {
    case 'app':
      return 'mcp';
    case 'skill':
      return 'skills';
    case 'collection':
      return 'collections';
    default:
      return null;
  }
}

const MANAGEMENT_SECTION_IDS: readonly PluginsManagementSection[] =
  PLUGINS_MANAGEMENT_SECTIONS;

/** Narrow an inbound `plugins.open_management` section id. */
function normalizeManagementSection(
  raw: unknown,
): PluginsManagementSection | null {
  return MANAGEMENT_SECTION_IDS.find((section) => section === raw) ?? null;
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** The local-agent dialog the page hosts over discovery or a detail. */
type AgentDialog =
  | { mode: 'create' }
  | { mode: 'edit'; agentId: string }
  | { mode: 'delete'; agentId: string };

function noopOpenAccountSettings(): void {}

// ---------------------------------------------------------------------------
// PluginsPage main export
// ---------------------------------------------------------------------------

interface PluginsPageProps {
  onOpenAccountSettings?: () => void;
}

/**
 * Unified capability marketplace (API-2153 / CAN-1565 / CAN-1567).
 *
 * The page IS discovery: search over one unified list of
 * curated plugins, curated/local MCP "apps", local/shared skills, pipelines,
 * and Collections. Installed content collapses into a single summary row that
 * opens the management view, and the technical add-flows live behind the "Add
 * custom…" dropdown — each item opening the pre-existing dialog.
 */
export function PluginsPage({
  onOpenAccountSettings,
}: PluginsPageProps): JSX.Element {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  // --- Data sources (composed through existing hooks and wire contracts) ---
  // Exactly one `useMarketplaceList` for the whole surface: the hook loads on
  // mount and its `upsert`/`removal` mutators are per-instance, so the
  // management view is fed from here rather than mounting a second copy.
  const {
    cache,
    loading,
    error,
    progressMessage,
    reload: reloadMarketplaces,
    refresh: refreshMarketplaces,
    upsertMarketplace,
    applyMarketplaceRemoval,
  } = useMarketplaceList();
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
    refresh: refreshSkills,
    refreshOrThrow: refreshSkillsOrThrow,
  } = useSkillList();
  const skillUpdates = useCustomizeSkillUpdates(refreshSkills);
  const updateSkillEntry = skillUpdates.update;
  const {
    servers,
    loading: mcpLoading,
    error: mcpError,
    refresh: refreshServers,
    accountConnectionsAvailable,
  } = useMcpServerList();
  const { entries: curatedMcpServers } = useCuratedMcpServers();
  const savedRoles = useSavedProfileRoles();
  const previousSavedRolesRef = useRef<typeof savedRoles>(undefined);
  useEffect(() => {
    if (savedRoles === undefined) return;
    const previous = previousSavedRolesRef.current;
    previousSavedRolesRef.current = savedRoles;
    if (previous !== undefined) void reloadMarketplaces();
  }, [reloadMarketplaces, savedRoles]);
  const pickerServers = useMemo(
    (): McpServerIndexEntry[] => pickerMcpServers(servers),
    [servers],
  );
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatusEntry[]>([]);

  // Read-only status snapshot. Deliberately does NOT drive the health sweep
  // that `useMcpServerStatuses` performs for the MCP Servers table: discovery
  // only needs the already-derived auth state, and probing every configured
  // server on page open would be a new cost on a landing surface.
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const entries = await window.mcpServers.listStatus();
        if (!cancelled) setMcpStatuses(entries);
      } catch {
        // No handler / transport failure → degrade to "no status known".
        if (!cancelled) setMcpStatuses([]);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [servers]);

  // --- Discovery state ---
  const [category, setCategory] = useState<string | null>(null);
  /** Restricts discovery to the capability type selected in the peer tabs. */
  const [kindFilter, setKindFilter] = useState<Exclude<
    CapabilityMarketplaceTabId,
    'all'
  > | null>(null);
  const [pipelineFilterValues, setPipelineFilterValues] =
    useState<PipelineFilterValues>(DEFAULT_PIPELINE_FILTERS);
  // Every filter narrows pipelines only, so they apply on the Pipelines tab
  // alone and a choice made there never hides rows on another tab.
  const pipelineFilters =
    kindFilter === 'workflow' ? pipelineFilterValues : DEFAULT_PIPELINE_FILTERS;
  const capabilities = useCapabilities();
  const ownershipAvailable =
    isFeatureSurfaceAvailable(capabilities, 'marketplace-owned-shares') ||
    isFeatureSurfaceAvailable(
      capabilities,
      'marketplace-owned-automation-shares',
    );
  const [focusSection, setFocusSection] = useState<'shared-by-me' | null>(null);
  // Shared agents list behind the Agents rollout flag, like the Agents page.
  // Project templates get a tab once the desktop can list team and
  // organization template shares.
  const sharedCustomAgentsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key),
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [managementSection, setManagementSection] =
    useState<PluginsManagementSection | null>(null);
  const marketplaceSourcesAccess = useMarketplaceSourcesAccess();
  const marketplaceSourcesAvailable = marketplaceSourcesAccess.client !== null;
  const typeTabs = useMemo(
    () =>
      marketplaceTypeTabs({
        agents: sharedCustomAgentsEnabled,
        sources: marketplaceSourcesAvailable,
      }),
    [marketplaceSourcesAvailable, sharedCustomAgentsEnabled],
  );
  // The Marketplaces tab (CAN-4262) is navigation state, not a catalog kind:
  // it swaps the catalog for the shared source list and loads nothing else.
  const showingSources =
    kindFilter === 'sources' && marketplaceSourcesAvailable;
  const sourcesVisible =
    showingSources && managementSection === null && selectedEntryId === null;
  const marketplaceSources = useMarketplaceSources(marketplaceSourcesAccess, {
    enabled: sourcesVisible,
  });
  const [sourceBulkState, setSourceBulkState] = useState({
    running: false,
    cancelling: false,
    done: 0,
    total: 0,
  });
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourcePluginFilters, setSourcePluginFilters] =
    useState<MarketplaceSourcePluginFilters>(
      EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
    );
  const openMarketplaceSource = useCallback((sourceId: string): void => {
    setSourcePluginFilters(EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS);
    setSelectedSourceId(sourceId);
  }, []);
  const closeMarketplaceSource = useCallback((): void => {
    setSelectedSourceId(null);
  }, []);
  const sourceDetailOpen = sourcesVisible && selectedSourceId !== null;
  const selectedSource = sourceDetailOpen
    ? marketplaceSources.sources?.find(
        (source) => source.id === selectedSourceId,
      )
    : undefined;
  const marketplaceSourceRemoveConfirmation = useCallback(
    (source: MarketplaceSource) => ({
      title: (
        <>
          Remove <span className="ph-mask">{source.name}</span>?
        </>
      ),
      message: formatMarketplaceRemoveBodyCopy(
        marketplaceSourceValidProviders(source),
      ),
    }),
    [],
  );
  // Local agents (CAN-4266): the page hosts their dialogs; a pending editor
  // request waits here until the inventory can resolve it.
  const [agentDialog, setAgentDialog] = useState<AgentDialog | null>(null);
  const [pendingAgentEditId, setPendingAgentEditId] = useState<string | null>(
    null,
  );
  const selectedLocalAgentId =
    selectedEntryId === null ? null : localAgentIdFromEntryId(selectedEntryId);
  const curatedEnabled = kindFilter === null || kindFilter === 'workflow';
  const capabilityInventory = useCapabilityMarketplaceInventory(deferredQuery, {
    category: category ?? undefined,
    curatedEnabled,
    completeSharedCatalogs:
      ownershipAvailable &&
      (kindFilter === null ||
        kindFilter === 'skill' ||
        kindFilter === 'collection'),
    // Automations list on the All and Automations tabs only, so their catalog
    // stays unloaded everywhere else. "Shared by me" lists no curated rows.
    curatedAutomationsEnabled: kindFilter === null || kindFilter === 'workflow',
    ownedAutomationSharesEnabled:
      ownershipAvailable && (kindFilter === null || kindFilter === 'workflow'),
    // Shared agents and plugin references load only where they list. Agents
    // stay behind the Agents rollout flag.
    sharedAgentsEnabled:
      sharedCustomAgentsEnabled &&
      (kindFilter === null || kindFilter === 'agent'),
    ownedAgentSharesEnabled:
      ownershipAvailable && (kindFilter === null || kindFilter === 'agent'),
    // Local agents also load for an open agent detail or a pending editor,
    // so a deep link resolves whichever tab was selected before.
    localAgentsEnabled:
      sharedCustomAgentsEnabled &&
      (kindFilter === null ||
        kindFilter === 'agent' ||
        selectedLocalAgentId !== null ||
        pendingAgentEditId !== null ||
        agentDialog !== null),
    sharedPluginsEnabled: kindFilter === null || kindFilter === 'plugin',
    sharedBlueprintsEnabled: kindFilter === null || kindFilter === 'blueprint',
  });
  const [retainedDetailEntry, setRetainedDetailEntry] =
    useState<UnifiedPluginEntry | null>(null);
  // A rename saved from an open detail's edit overlay, applied on top of the
  // resolved entry so the breadcrumb tracks the fresh name even while the
  // inventory row is stale or (server-filtered) missing entirely.
  const [detailNameOverride, setDetailNameOverride] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [entryDetailIntent, setEntryDetailIntent] = useState<'view' | 'add'>(
    'view',
  );
  /**
   * Entry ids behind the currently open detail: a related-item click swaps
   * the detail in place and pushes the previous entry here so its Back
   * affordance can restore it (CAN-2382).
   */
  const [entryDetailStack, setEntryDetailStack] = useState<string[]>([]);
  /**
   * Pipeline to reopen when the current detail was opened from a pipeline
   * editor's related-capability click (CAN-2382). Back on the detail
   * restores that editor instead of stranding the user on this page.
   */
  const [entryDetailPipelineReturn, setEntryDetailPipelineReturn] =
    useState<PipelineReturnTarget | null>(null);
  /**
   * Whether the open detail page was reached from an installed list (the
   * Installed strip or the management view), so its breadcrumb keeps the
   * Installed level: `Customize > Installed > Skills > <name>` (CAN-3484).
   */
  const [entryDetailFromInstalled, setEntryDetailFromInstalled] =
    useState(false);
  /** Management section restored by the detail's Back control, when any. */
  const [entryDetailManagementReturn, setEntryDetailManagementReturn] =
    useState<PluginsManagementSection | null>(null);
  /**
   * Installed skill opened by identity (the Installed Skills list or a deep
   * link), resolved by `selectedEntry` until the projection lists it.
   */
  const [installedSkillDetailEntry, setInstalledSkillDetailEntry] =
    useState<UnifiedPluginEntry | null>(null);
  /** Supporting file an installed skill's deep link opens its page on. */
  const [skillDetailFilePath, setSkillDetailFilePath] = useState<{
    entryId: string;
    filePath: string;
  } | null>(null);
  /**
   * Installed custom skill whose edit page replaces its detail page
   * (CAN-3485): `Customize > Installed > Skills > <name> > Edit`. Keyed by
   * entry id, so moving to any other detail (a rename included) ends it.
   */
  const [skillEditorEntryId, setSkillEditorEntryId] = useState<string | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const categorySearchInputRef = useRef<HTMLInputElement>(null);
  const pageScrollRef = useRef<HTMLDivElement>(null);
  // Whether the page has scrolled past its top. The pinned titlebar draws its
  // bottom hairline only then: at rest the bar is just the window's top
  // inset, and a divider there would underline nothing.
  const [pageScrolled, setPageScrolled] = useState(false);
  useEffect(() => {
    const node = pageScrollRef.current;
    if (!node) return undefined;
    const update = (): void => {
      const next = node.scrollTop > 0;
      setPageScrolled((previous) => (previous === next ? previous : next));
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    return (): void => node.removeEventListener('scroll', update);
  }, []);
  const browseScrollTopRef = useRef(0);
  const detailReturnScrollTopRef = useRef(0);
  const detailPageEntryIdRef = useRef<string | null>(null);

  /**
   * Capture the browse scroll position synchronously in the opening event
   * handler: by the time any effect runs, the detail DOM has replaced the
   * browse content and the scroller has already clamped `scrollTop`.
   * Related-entry hops keep the original capture, so closing a chain of
   * details restores the pre-detail browse position.
   */
  const captureDetailReturnScrollTop = useCallback((): void => {
    if (detailPageEntryIdRef.current !== null) return;
    detailReturnScrollTopRef.current = pageScrollRef.current?.scrollTop ?? 0;
  }, []);
  const browseSectionId = useNavigationStore(
    (state) => state.pluginsBrowseSectionId,
  ) as PluginsDiscoverySectionId | null;
  const setBrowseSectionId = useNavigationStore(
    (state) => state.setPluginsBrowseSectionId,
  );
  const previousBrowseSectionIdRef = useRef<string | null>(browseSectionId);
  const [categoryQuery, setCategoryQuery] = useState('');
  const deferredCategoryQuery = useDeferredValue(categoryQuery);
  const [managementStatusFilter, setManagementStatusFilter] = useState<
    'active' | null
  >(null);

  // --- Dialog state (every dialog is an existing component) ---
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [marketplaceInitialRepo, setMarketplaceInitialRepo] = useState('');
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [addSkillsOpen, setAddSkillsOpen] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [pluginShareTarget, setPluginShareTarget] =
    useState<PluginShareTarget | null>(null);
  const shareAction = useShareAction();
  const { shareGateModal } = shareAction;
  const shareScopingContext = useSidebarScopingContext();

  // Marketplace-plugin detail deep link (Cmd+K palette) keeps working through
  // the existing marketplace modal until Task 4's unified detail surface.
  const [selectedMarketplace, setSelectedMarketplace] =
    useState<MarketplaceInfo | null>(null);
  const [detailPluginName, setDetailPluginName] = useState<string | null>(null);
  const [pendingPluginDetail, setPendingPluginDetail] = useState<{
    marketplaceId: string;
    pluginName: string;
  } | null>(null);

  const closePageOwnedDialogs = useCallback((): void => {
    setSelectedEntryId(null);
    setFocusSection(null);
    setEntryDetailIntent('view');
    setEntryDetailStack([]);
    setEntryDetailPipelineReturn(null);
    setEntryDetailFromInstalled(false);
    setEntryDetailManagementReturn(null);
    setSkillDetailFilePath(null);
    setInstalledSkillDetailEntry(null);
    setSkillEditorEntryId(null);
    setSelectedMarketplace(null);
    setDetailPluginName(null);
    setPendingPluginDetail(null);
    setAddMarketplaceOpen(false);
    setMarketplaceInitialRepo('');
    setMcpDialogOpen(false);
    setAddSkillsOpen(false);
    setCreateSkillOpen(false);
    setCreateCollectionOpen(false);
    setAgentDialog(null);
    setPendingAgentEditId(null);
    setBrowseSectionId(null);
    setCategoryQuery('');
  }, [setBrowseSectionId]);

  const marketplaces = useMemo(
    () => cache?.marketplaces ?? [],
    [cache?.marketplaces],
  );

  const {
    results: providerConnectors,
    loading: providerConnectorsLoading,
    refresh: refreshProviderConnectors,
  } = useProviderConnectors({
    // The third call site. Same gate the picker uses: with no advertised
    // connector nothing can join the read, so the Claude CLI spawn and the
    // Codex cache parse would be paid for a discarded result.
    enabled: curatedMcpServers.some(advertisesProviderConnector),
  });

  const publisherSkills = usePublisherSkills();
  const { personalOrganizationId } = useResourceContext();
  const entries = useMemo(
    () =>
      buildUnifiedPluginEntries({
        personalOrganizationId,
        viewerId: capabilityInventory.viewerId,
        retainAutomationCatalogEntries: true,
        publisherSkills: publisherSkills.skills,
        curatedPlugins: curatedCatalogFromMarketplaces(marketplaces),
        // App availability comes from materialized plugin content. Global
        // provider installation is separate and remains visible in details.
        marketplaces: marketplaces.map((marketplace) => ({
          ...marketplace,
          plugins: marketplace.plugins.map((plugin) => ({
            ...plugin,
            installed: !pluginNeedsInstall(plugin),
          })),
        })),
        installedSkills: skills,
        mcpServers: pickerServers,
        mcpStatuses,
        curatedMcpServers,
        // The integration card's detail installs the folded plugin here
        // (REG-3033); the portal's MCP panel cannot, so it keeps plugin cards.
        foldSingleKeyPlugins: true,
        providerConnectors: providerConnectors ?? [],
        pipelines: capabilityInventory.pipelines,
        curatedPipelines: capabilityInventory.curated?.rows,
        localCollections: capabilityInventory.localCollections,
        sharedSkills: capabilityInventory.sharedSkills,
        sharedCollections: capabilityInventory.sharedCollections,
        localAutomations: capabilityInventory.localAutomations,
        sharedAutomations: capabilityInventory.sharedAutomations,
        curatedAutomations: capabilityInventory.curatedAutomations.rows,
        // Both agent lists follow the flag here too, so a list still in
        // flight when agents switch off never reaches the page.
        // Owned shares must keep their shared rows even when copied locally.
        localAgents: sharedCustomAgentsEnabled
          ? capabilityInventory.localAgents
          : undefined,
        sharedAgents: sharedCustomAgentsEnabled
          ? capabilityInventory.sharedAgents
          : undefined,
        sharedPlugins: capabilityInventory.sharedPlugins,
        sharedBlueprints: capabilityInventory.sharedBlueprints,
      }).map(skillUpdates.project),
    [
      personalOrganizationId,
      marketplaces,
      publisherSkills.skills,
      skills,
      pickerServers,
      mcpStatuses,
      curatedMcpServers,
      providerConnectors,
      capabilityInventory.pipelines,
      capabilityInventory.curated?.rows,
      capabilityInventory.localCollections,
      capabilityInventory.sharedSkills,
      capabilityInventory.sharedCollections,
      capabilityInventory.localAutomations,
      capabilityInventory.sharedAutomations,
      capabilityInventory.curatedAutomations.rows,
      capabilityInventory.localAgents,
      capabilityInventory.sharedAgents,
      capabilityInventory.sharedPlugins,
      capabilityInventory.sharedBlueprints,
      capabilityInventory.viewerId,
      skillUpdates.project,
      sharedCustomAgentsEnabled,
    ],
  );

  // A collection installed from the share install review (CAN-3710) is listed
  // before its detail opens, even when this page was already mounted.
  const refreshLocalCollections = capabilityInventory.refreshLocalCollections;
  useEffect(() => {
    const handleCollectionsChanged = (): void => {
      void refreshLocalCollections();
    };
    window.addEventListener(
      COLLECTIONS_CHANGED_EVENT,
      handleCollectionsChanged,
    );
    return (): void => {
      window.removeEventListener(
        COLLECTIONS_CHANGED_EVENT,
        handleCollectionsChanged,
      );
    };
  }, [refreshLocalCollections]);

  // The user's own skills, pipelines, automations and collections share
  // through the dialogs their own pages use.
  const ownedShare = useMarketplaceOwnedShare({
    shareAction,
    onOpenAccountSettings: onOpenAccountSettings ?? noopOpenAccountSettings,
    onSharedSkillsChanged: (): void =>
      void capabilityInventory.refreshSharedSkills(),
    onSharedCollectionsChanged: (): void =>
      void capabilityInventory.refreshSharedCollections(),
    onPipelinesChanged: (): void => void capabilityInventory.refreshPipelines(),
    onLocalAgentsChanged: (): void =>
      void capabilityInventory.refreshLocalAgents(),
    onSharedAgentsChanged: capabilityInventory.refreshSharedAgents,
  });
  const { canShare: canShareOwned, share: shareOwned } = ownedShare;
  // CAN-3704: one resolver per inventory snapshot. Every plugin, MCP and
  // skill entry resolves to a target or a blocked reason, installed or not;
  // the card, the detail and the click all read the same result.
  const resolveEntryShare = useMemo(
    () =>
      createMarketplaceEntryShareResolver({
        marketplaces,
        skills,
        sharedSkills: capabilityInventory.sharedSkills,
        sharedPlugins: capabilityInventory.sharedPlugins,
        localCollections: capabilityInventory.localCollections,
        pipelines: capabilityInventory.pipelines,
        automationActivities: capabilityInventory.automationActivities,
        localAgents: capabilityInventory.localAgentDefinitions,
        context: shareScopingContext,
      }),
    [
      capabilityInventory.automationActivities,
      capabilityInventory.localAgentDefinitions,
      capabilityInventory.localCollections,
      capabilityInventory.pipelines,
      capabilityInventory.sharedSkills,
      capabilityInventory.sharedPlugins,
      marketplaces,
      shareScopingContext,
      skills,
    ],
  );
  const canShareResolution = useCallback(
    (resolution: MarketplaceShareResolution | null): boolean =>
      resolution?.status !== 'shareable' ||
      (resolution.activation.kind === 'plugin'
        ? shareAction.canShare('plugin')
        : canShareOwned(resolution.activation.target.kind)),
    [canShareOwned, shareAction],
  );
  const entryShareStates = useMemo(() => {
    const states = new Map<string, MarketplaceEntryShareState>();
    for (const entry of entries) {
      const resolution = resolveEntryShare(entry);
      if (!canShareResolution(resolution)) continue;
      const state = marketplaceEntryShareState(entry, resolution);
      if (state) states.set(entry.id, state);
    }
    return states;
  }, [canShareResolution, entries, resolveEntryShare]);

  // A newer click or unmount cancels an in-flight share. An inventory
  // snapshot that changes mid-click (opening a detail page refreshes one)
  // does not: the click proceeds only if the newest snapshot still resolves
  // the entry as shareable, so it fails closed without being dropped.
  const shareRequest = useRef(0);
  const shareSnapshot = useRef(0);
  const latestEntryShareable = useRef<(entry: UnifiedPluginEntry) => boolean>(
    () => false,
  );
  useEffect(() => {
    shareSnapshot.current += 1;
    latestEntryShareable.current = (entry): boolean => {
      const latest = resolveEntryShare(entry);
      return latest?.status === 'shareable' && canShareResolution(latest);
    };
  }, [canShareResolution, resolveEntryShare]);
  useEffect(
    () => (): void => {
      shareRequest.current += 1;
    },
    [],
  );
  const handleShareEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      const current = resolveEntryShare(entry);
      if (current?.status !== 'shareable' || !canShareResolution(current))
        return;
      const sequence = ++shareRequest.current;
      const snapshot = shareSnapshot.current;
      void refreshMarketplaceEntryShareResolution(entry, {
        marketplaces,
        skills,
        sharedSkills: capabilityInventory.sharedSkills,
        sharedPlugins: capabilityInventory.sharedPlugins,
        localCollections: capabilityInventory.localCollections,
        pipelines: capabilityInventory.pipelines,
        automationActivities: capabilityInventory.automationActivities,
        localAgents: capabilityInventory.localAgentDefinitions,
        context: shareScopingContext,
      }).then((resolution) => {
        if (
          sequence !== shareRequest.current ||
          (snapshot !== shareSnapshot.current &&
            !latestEntryShareable.current(entry)) ||
          resolution?.status !== 'shareable' ||
          !canShareResolution(resolution)
        )
          return;
        const { activation } = resolution;
        if (activation.kind === 'owned') {
          shareOwned(activation.target);
          return;
        }
        shareAction.share('plugin', () =>
          setPluginShareTarget(activation.target),
        );
      });
    },
    [
      canShareResolution,
      capabilityInventory,
      marketplaces,
      resolveEntryShare,
      shareAction,
      shareOwned,
      shareScopingContext,
      skills,
    ],
  );

  // Membership is determined before section-specific filters.
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) =>
        marketplaceEntryInTab(entry, kindFilter ?? 'all'),
      ),
    [entries, kindFilter],
  );

  const categories = useMemo(
    () => collectEntryCategories(visibleEntries),
    [visibleEntries],
  );

  // Category chips can outlive the entries that produced them (a marketplace
  // removal, a catalog refresh); drop a filter that no longer matches anything.
  useEffect(() => {
    if (
      category !== null &&
      !categories.includes(category) &&
      !capabilityInventory.curated?.loading &&
      !capabilityInventory.curated?.nextCursor &&
      !capabilityInventory.curated?.error
    ) {
      setCategory(null);
    }
  }, [
    categories,
    category,
    capabilityInventory.curated?.loading,
    capabilityInventory.curated?.nextCursor,
    capabilityInventory.curated?.error,
  ]);

  const searchActive = deferredQuery.trim() !== '';
  const activeTypeTab: CapabilityMarketplaceTabId = kindFilter ?? 'all';
  const activeCatalogTab: MarketplaceCatalogTabId =
    activeTypeTab === 'sources' ? 'all' : activeTypeTab;
  const results = useMemo(
    () => searchUnifiedEntries(visibleEntries, deferredQuery, category),
    [visibleEntries, deferredQuery, category],
  );

  // Suggested follows Getting Started's role shortlist: resolved against the
  // whole catalog (installed or not) so the role/fallback choice is stable,
  // then stripped of anything already installed from any source.
  const suggestedNames = useMemo(() => {
    if (savedRoles === undefined) return [];
    const catalogKeys = new Set<string>();
    const installedKeys = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'plugin') continue;
      const key = marketplaceBrowseNameKey(entry.name);
      catalogKeys.add(key);
      if (entry.state !== 'available') installedKeys.add(key);
    }
    const inCatalog = ROLE_RECOMMENDATION_NAMES.filter((name) =>
      catalogKeys.has(marketplaceBrowseNameKey(name)),
    );
    return resolveRolePluginRecommendations(
      savedRoles,
      inCatalog,
      inCatalog.filter((name) =>
        installedKeys.has(marketplaceBrowseNameKey(name)),
      ),
    );
  }, [entries, savedRoles]);

  const browseGroups = useMemo(
    () => buildMarketplaceBrowseGroups(results, { suggestedNames }),
    [results, suggestedNames],
  );

  const activeBrowseGroup = useMemo(
    () => browseGroups.find((group) => group.id === browseSectionId) ?? null,
    [browseGroups, browseSectionId],
  );

  useEffect(() => {
    const previousSectionId = previousBrowseSectionIdRef.current;
    previousBrowseSectionIdRef.current = browseSectionId;
    if (previousSectionId === null && browseSectionId !== null) {
      if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
    } else if (previousSectionId !== null && browseSectionId === null) {
      if (pageScrollRef.current) {
        pageScrollRef.current.scrollTop = browseScrollTopRef.current;
      }
    }
  }, [browseSectionId]);

  const openBrowseGroup = useCallback(
    (sectionId: PluginsDiscoverySectionId): void => {
      browseScrollTopRef.current = pageScrollRef.current?.scrollTop ?? 0;
      setCategoryQuery('');
      setBrowseSectionId(sectionId);
    },
    [setBrowseSectionId],
  );

  const closeBrowseGroup = useCallback((): void => {
    setBrowseSectionId(null);
    setCategoryQuery('');
  }, [setBrowseSectionId]);

  const categoryPageEntries = useMemo(
    () =>
      activeBrowseGroup
        ? marketplaceCategoryPageEntries(
            activeBrowseGroup,
            deferredCategoryQuery,
          )
        : [],
    [activeBrowseGroup, deferredCategoryQuery],
  );

  // Manual refresh for the Pipelines tab, the one tab whose content does not
  // stay current by itself: the curated catalog is served from a saved copy
  // that only a forced refresh replaces. The other inventories load with the
  // page and stay current through their mutation callbacks or existing change,
  // focus, and account events. The ref swallows a second click that lands
  // before the disabled state renders.
  const refreshPipelineLists = capabilityInventory.refreshPipelines;
  const curatedPipelineRefreshRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    curatedPipelineRefreshRef.current = curatedEnabled
      ? capabilityInventory.curated?.onRefresh
      : undefined;
  });
  const pipelinesRefreshInFlightRef = useRef(false);
  const [pipelinesRefreshing, setPipelinesRefreshing] = useState(false);
  const pipelinesRefreshBusy =
    pipelinesRefreshing ||
    (curatedEnabled && capabilityInventory.curated?.loading === true);
  const handleRefreshPipelines = useCallback((): void => {
    if (pipelinesRefreshInFlightRef.current) return;
    pipelinesRefreshInFlightRef.current = true;
    setPipelinesRefreshing(true);
    curatedPipelineRefreshRef.current?.();
    void (async (): Promise<void> => {
      try {
        await refreshPipelineLists();
      } finally {
        pipelinesRefreshInFlightRef.current = false;
        setPipelinesRefreshing(false);
      }
    })();
  }, [refreshPipelineLists]);

  const sectionModel = useMemo(
    () =>
      buildCustomizeTabModel({
        tab: activeCatalogTab,
        entries,
        query: deferredQuery,
        installedInventory: capabilityInventory.installedInventory,
        ownershipAvailable:
          ownershipAvailable && !!capabilityInventory.viewerId,
        supportedUpdateKinds: ['skill', 'automation'],
        pipelineFilters,
        pipelineCategory: category,
        suggestedNames,
        agentsAvailable: sharedCustomAgentsEnabled,
        projectTemplatesAvailable: true,
      }),
    [
      activeCatalogTab,
      entries,
      deferredQuery,
      capabilityInventory.installedInventory,
      ownershipAvailable,
      capabilityInventory.viewerId,
      pipelineFilters,
      category,
      suggestedNames,
      sharedCustomAgentsEnabled,
    ],
  );
  const resultCount = sectionModel.resultCount;
  const categorySearchActive = deferredCategoryQuery.trim() !== '';
  const reportedSearchActive = activeBrowseGroup
    ? categorySearchActive
    : searchActive;
  const reportedResultCount = activeBrowseGroup
    ? categoryPageEntries.length
    : resultCount;
  // Never report the search text — only whether a search is active and how
  // many rows it produced.
  useCurrentUiStateReporter(
    'plugins.page',
    useMemo(
      () => ({
        view: managementSection === null ? 'discovery' : 'management',
        managementSection,
        searchActive: reportedSearchActive,
        resultCount: reportedResultCount,
        selectedEntryId,
        detailHistoryDepth: entryDetailStack.length,
        detailBackTarget:
          entryDetailStack.length > 0
            ? 'entry'
            : entryDetailPipelineReturn
              ? 'pipeline'
              : null,
        // The create-mode collection editor is page-owned modal state, so
        // App Advisor sees it like every other dialog this page can open.
        createCollectionOpen,
        // A custom skill's edit page replaces its detail (CAN-3485).
        skillEditorOpen:
          selectedEntryId !== null && skillEditorEntryId === selectedEntryId,
        // Local agent dialogs the page hosts (CAN-4266); ids only, never the
        // agent's instructions or plugin configuration.
        agentDialog: agentDialog?.mode ?? null,
        agentDialogAgentId:
          agentDialog && agentDialog.mode !== 'create'
            ? agentDialog.agentId
            : null,
      }),
      [
        agentDialog,
        managementSection,
        reportedSearchActive,
        reportedResultCount,
        selectedEntryId,
        entryDetailStack.length,
        entryDetailPipelineReturn,
        createCollectionOpen,
        skillEditorEntryId,
      ],
    ),
  );

  // App Advisor sees the Marketplaces tab beside the legacy snapshot keys.
  const reportedSources = marketplaceSources.sources;
  useCurrentUiStateReporter(
    sourcesVisible ? 'plugins.marketplaceSources' : null,
    useMemo(
      () => ({
        sourceCount: reportedSources?.length ?? null,
        invalidCount:
          reportedSources?.filter((source) => source.status.state === 'invalid')
            .length ?? null,
        loading: marketplaceSources.loading,
        refreshing: marketplaceSources.refreshing,
        listError: marketplaceSources.listError !== null,
        selectedSourceId,
        filters:
          selectedSourceId === null
            ? null
            : {
                searchActive: sourcePluginFilters.query.trim() !== '',
                categoryActive: sourcePluginFilters.category !== null,
                authorActive: sourcePluginFilters.author !== null,
              },
        busySourceIds: Object.keys(marketplaceSources.operations),
        bulkInstall: sourceBulkState,
      }),
      [
        marketplaceSources.listError,
        marketplaceSources.loading,
        marketplaceSources.operations,
        marketplaceSources.refreshing,
        reportedSources,
        selectedSourceId,
        sourcePluginFilters,
        sourceBulkState,
      ],
    ),
  );

  // Legacy tab deep links now open the management view at the matching section.
  useEffect(() => {
    const handleOpenTab = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      const tab =
        typeof detail === 'object' &&
        detail !== null &&
        'tab' in detail &&
        typeof detail.tab === 'string'
          ? detail.tab
          : undefined;
      const normalized = normalizePluginsTabId(tab);
      if (normalized !== null) {
        closePageOwnedDialogs();
        setManagementSection(managementSectionForTabId(normalized));
      }
    };
    window.addEventListener(PLUGINS_OPEN_TAB_EVENT, handleOpenTab);
    return (): void => {
      window.removeEventListener(PLUGINS_OPEN_TAB_EVENT, handleOpenTab);
    };
  }, [closePageOwnedDialogs]);

  // `plugins.open_management` targets a section directly, including the two
  // (`installed`, `marketplaces`) that never had a legacy tab id.
  useEffect(() => {
    const handleOpenManagement = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      const section =
        typeof detail === 'object' && detail !== null && 'section' in detail
          ? normalizeManagementSection(detail.section)
          : null;
      closePageOwnedDialogs();
      setManagementSection(section ?? 'installed');
    };
    window.addEventListener(
      PLUGINS_OPEN_MANAGEMENT_EVENT,
      handleOpenManagement,
    );
    return (): void => {
      window.removeEventListener(
        PLUGINS_OPEN_MANAGEMENT_EVENT,
        handleOpenManagement,
      );
    };
  }, [closePageOwnedDialogs]);

  // Curated MCP browse: focus discovery search on the MCP servers tab. It does
  // NOT open the management view — discovery owns curated browse now, and the
  // overlay would cover the surface being focused.
  useEffect(() => {
    const handleOpenBrowse = (): void => {
      closePageOwnedDialogs();
      setManagementSection(null);
      setQuery('');
      setCategory(null);
      setKindFilter('app');
      searchInputRef.current?.focus();
    };
    window.addEventListener(MCP_OPEN_BROWSE_EVENT, handleOpenBrowse);
    return (): void => {
      window.removeEventListener(MCP_OPEN_BROWSE_EVENT, handleOpenBrowse);
    };
  }, [closePageOwnedDialogs]);

  const pendingPluginsNavigation = useNavigationStore(
    (state) => state.pendingPluginsNavigation,
  );
  const consumePluginsNavigation = useNavigationStore(
    (state) => state.consumePluginsNavigation,
  );
  useEffect(() => {
    if (!pendingPluginsNavigation) return;
    closePageOwnedDialogs();
    // A `switch` rather than an if/else chain so the union stays closed: a
    // new `PluginsNavigationIntent` kind must add its own case instead of
    // silently inheriting the discovery reset below.
    switch (pendingPluginsNavigation.kind) {
      case 'management':
        setManagementSection(
          normalizeManagementSection(pendingPluginsNavigation.section) ??
            'installed',
        );
        setManagementStatusFilter(
          pendingPluginsNavigation.statusFilter ?? null,
        );
        break;
      case 'entry-detail': {
        const agentId = localAgentIdFromEntryId(
          pendingPluginsNavigation.entryId,
        );
        if (
          agentId !== null ||
          pendingPluginsNavigation.entryId.startsWith('agent:shared:')
        ) {
          // A local agent (CAN-4266) opens on the Agents tab with no stale
          // search narrowing it. With agents switched off the request is
          // dropped rather than replayed when they return.
          if (!sharedCustomAgentsEnabled) break;
          setManagementSection(null);
          setQuery('');
          setCategory(null);
          setKindFilter('agent');
          setEntryDetailIntent('view');
          captureDetailReturnScrollTop();
          setSelectedEntryId(pendingPluginsNavigation.entryId);
          if (agentId !== null && pendingPluginsNavigation.intent === 'edit') {
            setPendingAgentEditId(agentId);
          }
          break;
        }
        setEntryDetailIntent(
          pendingPluginsNavigation.intent === 'connect' ? 'add' : 'view',
        );
        // Related-item navigation from pipeline surfaces (CAN-2382). The
        // resolved entry decides whether management closes for an inline page
        // or remains behind a dialog-owned detail. The `from` context becomes
        // the detail's Back target: a source entry seeds the detail stack, a
        // source pipeline reopens its editor. The browse DOM is still mounted
        // when this intent is consumed, so the scroll capture is still valid.
        captureDetailReturnScrollTop();
        setSelectedEntryId(pendingPluginsNavigation.entryId);
        const from = pendingPluginsNavigation.from;
        if (
          from?.kind === 'entry' &&
          from.entryId !== pendingPluginsNavigation.entryId
        ) {
          setEntryDetailStack([from.entryId]);
        } else if (from?.kind === 'entry-context') {
          setEntryDetailStack(from.stack);
          setEntryDetailPipelineReturn(from.pipelineReturn ?? null);
          setEntryDetailFromInstalled(from.fromInstalled === true);
          setEntryDetailManagementReturn(from.managementReturn ?? null);
          // The page unmounted while the pipeline editor was open, so the
          // browse state behind the detail comes back through the intent.
          if (from.marketplace) {
            setQuery(from.marketplace.query);
            setCategory(from.marketplace.category ?? null);
            const normalized = normalizeMarketplaceNavigation(
              from.marketplace.tab,
              Reflect.get(from.marketplace, 'ownership'),
            );
            setKindFilter(normalized.tab === 'all' ? null : normalized.tab);
          }
        } else if (from?.kind === 'pipeline') {
          setEntryDetailPipelineReturn({
            pipelineId: from.pipelineId,
            cwd: from.cwd,
            filePath: from.filePath,
            source: from.source,
            sharedRemoteId: from.sharedRemoteId,
            returnToEntryId: from.returnToEntryId,
            returnToEntryContext: from.returnToEntryContext,
            returnToPipeline: from.returnToPipeline,
          });
        }
        break;
      }
      case 'browse-apps':
      case 'discovery':
        // Both open discovery and differ only in the kind filter:
        // `browse-apps` narrows to MCP apps, while `discovery` is the
        // unfiltered browse surface and must not inherit an app-only filter
        // (that filter hides exactly the skills and plugins its callers want).
        setManagementSection(null);
        setQuery(
          pendingPluginsNavigation.kind === 'discovery'
            ? (pendingPluginsNavigation.searchQuery ?? '')
            : '',
        );
        setCategory(null);
        setKindFilter(
          pendingPluginsNavigation.kind === 'browse-apps' ? 'app' : null,
        );
        searchInputRef.current?.focus();
        break;
      case 'marketplace-browse': {
        setManagementSection(null);
        setQuery(pendingPluginsNavigation.query);
        setCategory(pendingPluginsNavigation.category ?? null);
        const normalized = normalizeMarketplaceNavigation(
          pendingPluginsNavigation.tab,
          pendingPluginsNavigation.focusSection ??
            Reflect.get(pendingPluginsNavigation, 'ownership'),
        );
        setKindFilter(normalized.tab === 'all' ? null : normalized.tab);
        setFocusSection(normalized.focusSection ?? null);
        break;
      }
      default: {
        const exhaustive: never = pendingPluginsNavigation;
        void exhaustive;
        break;
      }
    }
    consumePluginsNavigation();
  }, [
    captureDetailReturnScrollTop,
    closePageOwnedDialogs,
    consumePluginsNavigation,
    pendingPluginsNavigation,
    sharedCustomAgentsEnabled,
  ]);

  // Discovery's `useSkillList()` is its own hook instance with its own cache,
  // so a skill installed, created, imported or removed elsewhere (App Advisor,
  // the management view's `SkillsTab`, an installed skill's detail page) only
  // reaches this projection by refreshing on the shared skills-changed event.
  // The refresh is tracked so a sender can wait for it.
  useEffect(() => {
    const handleSkillsChanged = (event: Event): void => {
      trackSkillsRefresh(event, refreshSkillsOrThrow());
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, handleSkillsChanged);
    return (): void => {
      window.removeEventListener(SKILLS_CHANGED_EVENT, handleSkillsChanged);
    };
  }, [refreshSkillsOrThrow]);

  /**
   * Entry for an installed skill opened by identity (the Installed Skills list
   * or a deep link). That list and deep links can run ahead of this page's
   * inventory, and publisher installs are not listed as plain skill entries,
   * so the entry is built from the identity until the projection has it.
   */
  const installedSkillEntry = useCallback(
    (sourceId: string, name: string): UnifiedPluginEntry => {
      const record = skills.find(
        (skill) => skill.sourceId === sourceId && skill.name === name,
      );
      const built = buildInstalledSkillEntry({
        sourceId,
        name,
        description: record?.description ?? '',
        builtIn: record?.builtIn,
      });
      return entries.find((entry) => entry.id === built.id) ?? built;
    },
    [entries, skills],
  );

  /**
   * Open an installed skill's detail page as part of Your Installed Skills
   * (CAN-3483): `Customize > Installed > Skills > <name>`, with Back and the
   * Skills crumb returning to that list. `edit` opens a custom skill's edit
   * page over that detail (CAN-3485), so Cancel lands on the detail.
   */
  const openInstalledSkillDetail = useCallback(
    (skill: {
      sourceId: string;
      name: string;
      filePath?: string;
      edit?: true;
    }): void => {
      const entry = installedSkillEntry(skill.sourceId, skill.name);
      captureDetailReturnScrollTop();
      setEntryDetailIntent('view');
      setEntryDetailStack([]);
      setEntryDetailPipelineReturn(null);
      setEntryDetailFromInstalled(true);
      setEntryDetailManagementReturn('skills');
      setSkillDetailFilePath(
        skill.filePath ? { entryId: entry.id, filePath: skill.filePath } : null,
      );
      setManagementSection(null);
      setInstalledSkillDetailEntry(entry);
      setSkillEditorEntryId(skill.edit ? entry.id : null);
      setSelectedEntryId(entry.id);
    },
    [captureDetailReturnScrollTop, installedSkillEntry],
  );

  // Store-backed skill deep link (Cmd+K palette, chat artifacts, App Advisor):
  // the pending payload survives this page's lazy mount. An installed skill
  // opens its detail page here; a shared skill opens the management view's
  // Skills section, whose SkillsTab consumes the payload once it mounts.
  const pendingSkillViewer = useNavigationStore((s) => s.pendingSkillViewer);
  useEffect(() => {
    if (!pendingSkillViewer) return;
    if ('kind' in pendingSkillViewer && pendingSkillViewer.kind === 'shared') {
      setManagementSection('skills');
      return;
    }
    closePageOwnedDialogs();
    openInstalledSkillDetail({
      sourceId: pendingSkillViewer.sourceId,
      name: pendingSkillViewer.skillName,
      ...(pendingSkillViewer.filePath
        ? { filePath: pendingSkillViewer.filePath }
        : {}),
    });
    useNavigationStore.getState().consumeSkillViewer();
  }, [closePageOwnedDialogs, openInstalledSkillDetail, pendingSkillViewer]);

  useEffect(() => {
    const handleOpenDetail = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        typeof detail === 'object' &&
        detail !== null &&
        'marketplaceId' in detail &&
        typeof detail.marketplaceId === 'string' &&
        'pluginName' in detail &&
        typeof detail.pluginName === 'string'
      ) {
        setPendingPluginDetail({
          marketplaceId: detail.marketplaceId,
          pluginName: detail.pluginName,
        });
      }
    };
    window.addEventListener(PLUGIN_OPEN_DETAIL_EVENT, handleOpenDetail);
    return (): void => {
      window.removeEventListener(PLUGIN_OPEN_DETAIL_EVENT, handleOpenDetail);
    };
  }, []);

  // Open the matched plugin's detail view once its marketplace is in the cache.
  useEffect(() => {
    if (!pendingPluginDetail) return;
    const marketplace = marketplaces.find(
      (entry) => entry.id === pendingPluginDetail.marketplaceId,
    );
    if (!marketplace) return;
    setSelectedMarketplace(marketplace);
    setDetailPluginName(pendingPluginDetail.pluginName);
    setPendingPluginDetail(null);
  }, [marketplaces, pendingPluginDetail]);

  const existingRepos = marketplaces
    .filter((marketplace) => marketplace.sourceUrl)
    .map((marketplace) => marketplace.sourceUrl);

  const selectEntry = useCallback(
    (entry: UnifiedPluginEntry, fromInstalled: boolean): void => {
      if (entry.ref.type === 'curated-pipeline') {
        const key = entry.ref.key;
        const row = capabilityInventory.curated?.rows.find(
          (row) => row.key === key,
        );
        if (row) capabilityInventory.curated?.onSelect(row);
        return;
      }
      setEntryDetailIntent('view');
      if (entryUsesDetailPage(entry, servers)) {
        captureDetailReturnScrollTop();
        // The management view lists only installed content, so a detail it
        // opens keeps the Installed breadcrumb level just like the strip.
        setEntryDetailFromInstalled(
          fromInstalled || managementSection !== null,
        );
        setEntryDetailManagementReturn(managementSection);
        setManagementSection(null);
      }
      setSelectedEntryId(entry.id);
    },
    [
      captureDetailReturnScrollTop,
      capabilityInventory.curated,
      managementSection,
      servers,
    ],
  );
  const handleSelectEntry = useCallback(
    (entry: UnifiedPluginEntry): void => selectEntry(entry, false),
    [selectEntry],
  );
  const handleUpdateEntry = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (entry.ref.type === 'skill') await updateSkillEntry(entry);
      else if (entry.ref.type === 'automation') handleSelectEntry(entry);
    },
    [handleSelectEntry, updateSkillEntry],
  );
  // A requirement chip on a multi-connection plugin card opens that
  // integration's card (REG-3033).
  const handleOpenEntryId = useCallback(
    (entryId: string): void => {
      const target = entries.find((entry) => entry.id === entryId);
      if (target) selectEntry(target, false);
    },
    [entries, selectEntry],
  );
  // A source plugin opens the catalog entry the inventory built for it; a
  // plugin the catalog does not list stays non-interactive.
  const sourcePluginEntry = useCallback(
    (sourceId: string, pluginKey: string): UnifiedPluginEntry | undefined => {
      const source = marketplaceSources.sources?.find(
        (entry) => entry.id === sourceId,
      );
      const entryId =
        source?.kind === 'curated'
          ? `curated:${pluginKey}`
          : `mkt:${sourceId}/${pluginKey}`;
      return entries.find((entry) => entry.id === entryId);
    },
    [entries, marketplaceSources.sources],
  );

  // Only the shared lists, so the card handler is not rebuilt on every
  // unrelated inventory change.
  const {
    sharedSkills,
    sharedCollections,
    sharedAgents,
    sharedPlugins,
    sharedBlueprints,
  } = capabilityInventory;
  const sharedInstallInventory = useMemo(
    () => ({
      sharedSkills,
      sharedCollections,
      sharedAgents,
      sharedPlugins,
      sharedBlueprints,
      sharedAutomations: capabilityInventory.sharedAutomations,
    }),
    [
      sharedSkills,
      sharedCollections,
      sharedAgents,
      sharedPlugins,
      sharedBlueprints,
      capabilityInventory.sharedAutomations,
    ],
  );
  const handleAddEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      // A shared resource's Add opens the install review straight from the
      // card (CAN-3710); the detail page is not visited first. A private
      // share has nothing to install from here, so it opens its detail.
      const installLink = marketplaceEntryInstallLink(
        entry.ref,
        sharedInstallInventory,
      );
      if (installLink !== undefined) {
        if (installLink === null) {
          handleSelectEntry(entry);
          return;
        }
        useNavigationStore.getState().openShareInstall(installLink, 'in-app');
        return;
      }
      const opensAddSurface =
        entry.ref.type === 'curated-mcp' ||
        entry.ref.type === 'curated-plugin' ||
        entry.ref.type === 'marketplace-plugin';
      if (!opensAddSurface) {
        handleSelectEntry(entry);
        return;
      }
      setEntryDetailIntent('add');
      if (entryUsesDetailPage(entry, servers)) {
        captureDetailReturnScrollTop();
        setEntryDetailFromInstalled(managementSection !== null);
        setEntryDetailManagementReturn(managementSection);
        setManagementSection(null);
      }
      setSelectedEntryId(entry.id);
    },
    [
      captureDetailReturnScrollTop,
      handleSelectEntry,
      sharedInstallInventory,
      managementSection,
      servers,
    ],
  );

  // Resolved against the full projection, not `visibleEntries`: a detail
  // surface must survive the user switching away from the MCP servers tab.
  const foundSelectedEntry = useMemo(() => {
    const entry = entries.find((item) => item.id === selectedEntryId);
    if (entry) return entry;
    // Dedupe affects browsing only. Direct shared-agent links still resolve
    // from the unfiltered shared inventory and retain their install review.
    if (
      !sharedCustomAgentsEnabled ||
      !selectedEntryId?.startsWith('agent:shared:')
    )
      return null;
    return (
      buildUnifiedPluginEntries({
        curatedPlugins: [],
        marketplaces: [],
        installedSkills: [],
        mcpServers: [],
        mcpStatuses: [],
        curatedMcpServers: [],
        providerConnectors: [],
        sharedAgents: capabilityInventory.sharedAgents,
      }).find((item) => item.id === selectedEntryId) ?? null
    );
  }, [
    entries,
    selectedEntryId,
    sharedCustomAgentsEnabled,
    capabilityInventory.sharedAgents,
  ]);
  // Shared skills and collections are filtered server-side. Retain the last
  // resolved entry so a rename that stops matching the query does not close
  // its open detail page when the refreshed inventory omits that row.
  useEffect(() => {
    if (selectedEntryId === null) {
      setRetainedDetailEntry(null);
    } else if (foundSelectedEntry) {
      setRetainedDetailEntry(foundSelectedEntry);
    }
  }, [foundSelectedEntry, selectedEntryId]);
  useEffect(() => {
    if (
      showingSources &&
      selectedSourceId &&
      marketplaceSources.sources !== null &&
      !selectedSource
    ) {
      setSelectedEntryId(null);
      setRetainedDetailEntry(null);
    }
  }, [
    marketplaceSources.sources,
    selectedSource,
    selectedSourceId,
    showingSources,
  ]);
  const selectedEntry = useMemo(() => {
    const base =
      foundSelectedEntry ??
      (retainedDetailEntry?.id === selectedEntryId
        ? retainedDetailEntry
        : null) ??
      (installedSkillDetailEntry?.id === selectedEntryId
        ? installedSkillDetailEntry
        : null) ??
      // A shared automation the browse inventory does not list, such as the
      // user's own public-link-only share outside "Shared by me", still opens
      // by id: its detail loads the share and reports the real name.
      (selectedEntryId === null
        ? null
        : (pendingSharedAutomationEntry(selectedEntryId) ??
          (sharedCustomAgentsEnabled
            ? pendingLocalAgentEntry(selectedEntryId)
            : null)));
    if (!base) return null;
    return detailNameOverride &&
      detailNameOverride.id === base.id &&
      detailNameOverride.name !== base.name
      ? { ...base, name: detailNameOverride.name }
      : base;
  }, [
    detailNameOverride,
    foundSelectedEntry,
    retainedDetailEntry,
    installedSkillDetailEntry,
    selectedEntryId,
    sharedCustomAgentsEnabled,
  ]);
  useEffect(() => {
    setDetailNameOverride(null);
  }, [selectedEntryId]);
  const selectedEntryUsesDetailPage = useMemo(() => {
    if (!selectedEntry) return false;
    return entryUsesDetailPage(selectedEntry, servers);
  }, [selectedEntry, servers]);
  const selectedDetailPageEntryId =
    selectedEntryUsesDetailPage && selectedEntry ? selectedEntry.id : null;
  const skillEditorOpen =
    selectedDetailPageEntryId !== null &&
    skillEditorEntryId === selectedDetailPageEntryId;

  useEffect(() => {
    const previousId = detailPageEntryIdRef.current;
    detailPageEntryIdRef.current = selectedDetailPageEntryId;
    if (
      selectedDetailPageEntryId !== null &&
      previousId !== selectedDetailPageEntryId
    ) {
      // Entering a detail page or hopping between related details: both start
      // reading from the top.
      if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
    } else if (previousId !== null && selectedDetailPageEntryId === null) {
      if (pageScrollRef.current) {
        pageScrollRef.current.scrollTop = detailReturnScrollTopRef.current;
      }
    }
  }, [selectedDetailPageEntryId]);

  useEffect(() => {
    if (selectedEntryUsesDetailPage) setManagementSection(null);
  }, [selectedEntryUsesDetailPage]);

  const closeEntryDetail = useCallback((): void => {
    setPendingAgentEditId(null);
    setSelectedEntryId(null);
    setEntryDetailIntent('view');
    setEntryDetailStack([]);
    setEntryDetailPipelineReturn(null);
    setEntryDetailFromInstalled(false);
    setEntryDetailManagementReturn(null);
    setSkillDetailFilePath(null);
    setInstalledSkillDetailEntry(null);
    setSkillEditorEntryId(null);
  }, []);
  const navigateBackFromEntryDetail = useCallback((): void => {
    const managementReturn = entryDetailManagementReturn;
    closeEntryDetail();
    if (managementReturn !== null) setManagementSection(managementReturn);
  }, [closeEntryDetail, entryDetailManagementReturn]);

  // --- Local agents (CAN-4266) ---
  const {
    localAgentDefinitions,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
    refreshLocalAgents,
  } = capabilityInventory;
  const saveAgent = useAgentsStore((state) => state.save);
  const removeAgent = useAgentsStore((state) => state.remove);
  const agentDialogTarget =
    agentDialog && agentDialog.mode !== 'create'
      ? (localAgentDefinitions.find(
          (agent) => agent.id === agentDialog.agentId,
        ) ?? null)
      : null;
  // A pending editor asks for a fresh agent list: the cached one may predate
  // an agent created elsewhere while this page held no subscription.
  const [pendingAgentEditRefreshed, setPendingAgentEditRefreshed] =
    useState(false);
  useEffect(() => {
    setPendingAgentEditRefreshed(false);
    if (pendingAgentEditId === null) return undefined;
    let current = true;
    void refreshLocalAgents().finally(() => {
      if (current) setPendingAgentEditRefreshed(true);
    });
    return (): void => {
      current = false;
    };
  }, [pendingAgentEditId, refreshLocalAgents]);
  // A pending editor opens once that fresh load settled without an error and
  // the inventory resolves it, exactly once: the editor seeds its fields when it opens, so
  // a cached definition could save stale values over a newer one. A later
  // refresh never reopens a dismissed editor, and only an inventory that
  // settled after the fresh load leaves its detail to report it missing.
  useEffect(() => {
    if (pendingAgentEditId === null || !pendingAgentEditRefreshed) return;
    // A failed read keeps the cached list, which may predate the agent; the
    // request waits for a successful one (the detail offers Try again).
    if (localAgentsLoading || localAgentsError) return;
    if (
      localAgentDefinitions.some((agent) => agent.id === pendingAgentEditId)
    ) {
      setAgentDialog({ mode: 'edit', agentId: pendingAgentEditId });
      setPendingAgentEditId(null);
    } else if (localAgentsLoaded) {
      setPendingAgentEditId(null);
    }
  }, [
    localAgentDefinitions,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
    pendingAgentEditId,
    pendingAgentEditRefreshed,
  ]);
  // An agent deleted elsewhere takes its editor or confirmation with it.
  useEffect(() => {
    if (
      agentDialog &&
      agentDialog.mode !== 'create' &&
      localAgentsLoaded &&
      !localAgentsLoading &&
      !localAgentsError &&
      agentDialogTarget === null
    ) {
      setAgentDialog(null);
    }
  }, [
    agentDialog,
    agentDialogTarget,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
  ]);
  const [agentDeletePending, setAgentDeletePending] = useState(false);
  const [agentDeleteError, setAgentDeleteError] = useState<string | null>(null);
  const agentDeleteInFlightRef = useRef(false);
  const selectedEntryForAgentDeleteRef = useRef<string | null>(null);
  useEffect(() => {
    selectedEntryForAgentDeleteRef.current = selectedLocalAgentId;
  }, [selectedLocalAgentId]);
  const openAgentDialog = useCallback((dialog: AgentDialog): void => {
    setAgentDeleteError(null);
    setAgentDialog(dialog);
  }, []);
  const handleSaveAgent = useCallback(
    async (request: SaveAgentModelRequest): Promise<void> => {
      await saveAgent(request);
    },
    [saveAgent],
  );
  const handleConfirmDeleteAgent = useCallback(
    (agentId: string): void => {
      if (agentDeleteInFlightRef.current) return;
      agentDeleteInFlightRef.current = true;
      setAgentDeletePending(true);
      setAgentDeleteError(null);
      void (async (): Promise<void> => {
        try {
          await removeAgent(agentId);
          setAgentDialog(null);
          // The detail closes only once the agent is really gone.
          if (selectedEntryForAgentDeleteRef.current === agentId) {
            navigateBackFromEntryDetail();
          }
        } catch (error: unknown) {
          setAgentDeleteError(extractIpcErrorMessage(error));
        } finally {
          agentDeleteInFlightRef.current = false;
          setAgentDeletePending(false);
        }
      })();
    },
    [navigateBackFromEntryDetail, removeAgent],
  );
  // A Personal/organization switch takes the previous context's agent
  // dialog, pending editor and open agent detail with it.
  useWorkspaceContextReset((): void => {
    setAgentDialog(null);
    setPendingAgentEditId(null);
    if (ownedShare.openKind === 'agent') ownedShare.close();
    if (selectedLocalAgentId !== null) closeEntryDetail();
  });
  // Switching agents off live hides every agent surface: dialogs close, a
  // pending editor is dropped, and an agent view returns to an allowed state.
  // Turning them back on replays nothing.
  const closeOwnedShare = ownedShare.close;
  const ownedShareKind = ownedShare.openKind;
  useEffect(() => {
    if (sharedCustomAgentsEnabled) return;
    setAgentDialog(null);
    setPendingAgentEditId(null);
    if (ownedShareKind === 'agent') closeOwnedShare();
    if (kindFilter === 'agent') setKindFilter(null);
    if (selectedEntry?.kind === 'agent') closeEntryDetail();
  }, [
    closeEntryDetail,
    closeOwnedShare,
    kindFilter,
    ownedShareKind,
    selectedEntry?.kind,
    sharedCustomAgentsEnabled,
  ]);

  // A Cloud sign-out or account switch invalidates shared rows outright; a
  // retained shared detail must not survive it the way it survives a
  // same-account filtered refresh (CAN-2779 review round 6). The latest
  // selected entry rides in a ref so the listener registers once.
  const selectedEntryForAccountRef = useRef<UnifiedPluginEntry | null>(null);
  useEffect(() => {
    selectedEntryForAccountRef.current = selectedEntry;
  }, [selectedEntry]);
  useEffect(() => {
    const handleAccountChanged = (): void => {
      const current = selectedEntryForAccountRef.current;
      if (
        current &&
        (current.ref.type === 'shared-skill' ||
          current.ref.type === 'shared-collection' ||
          current.ref.type === 'shared-automation' ||
          current.ref.type === 'curated-automation' ||
          current.ref.type === 'shared-agent' ||
          current.ref.type === 'shared-plugin')
      ) {
        closeEntryDetail();
      }
      setRetainedDetailEntry(null);
      setDetailNameOverride(null);
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      handleAccountChanged,
    );
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        handleAccountChanged,
      );
    };
  }, [closeEntryDetail]);

  // The curated automation catalog owns the one detail it has loaded. Keep
  // its selection on whichever curated automation is open, however the entry
  // was reached (a card, its Add, a deep link, or a related-item hop), and
  // release it when the detail closes.
  const selectedCuratedAutomationKey =
    selectedEntry?.ref.type === 'curated-automation'
      ? selectedEntry.ref.key
      : null;
  const {
    selectedKey: curatedAutomationSelectedKey,
    onSelectKey: selectCuratedAutomation,
    onClearDetail: clearCuratedAutomation,
  } = capabilityInventory.curatedAutomations;
  useEffect(() => {
    if (selectedCuratedAutomationKey === curatedAutomationSelectedKey) return;
    if (selectedCuratedAutomationKey === null) {
      clearCuratedAutomation();
    } else {
      selectCuratedAutomation(selectedCuratedAutomationKey);
    }
  }, [
    clearCuratedAutomation,
    curatedAutomationSelectedKey,
    selectCuratedAutomation,
    selectedCuratedAutomationKey,
  ]);

  const openAutomationInEditor = useCallback((activityId: string): void => {
    useNavigationStore.getState().openAutomationEdit({ activityId });
  }, []);

  // Escape leaves the detail sub-page only while nothing sits above it: the
  // shared overlay stack lets a dialog opened from inside the detail (add
  // flows, share modal) consume Escape first instead of unmounting the page.
  // It acts as Back, so a detail opened from an installed list returns there,
  // and a skill's edit page returns to the skill's detail (CAN-3485). As a
  // page layer it stays beneath a dialog that opened first, such as the
  // install review over a detail an install just landed on (CAN-3710).
  useOverlayEscape(
    selectedDetailPageEntryId !== null,
    (): void => {
      if (skillEditorOpen) {
        setSkillEditorEntryId(null);
        return;
      }
      navigateBackFromEntryDetail();
    },
    undefined,
    { layer: 'page' },
  );

  // One prop wiring for both presentations: the inline sub-page (shell-owned
  // branches) and the dialog fallback (skill/MCP-owned branches) must stay
  // behaviorally identical, so they render from the same closure.
  const renderEntryDetail = (
    detailEntry: UnifiedPluginEntry,
    presentation: 'modal' | 'page',
  ): JSX.Element => (
    <PluginEntryDetail
      key={`${detailEntry.id}:${entryDetailIntent}`}
      entry={detailEntry}
      presentation={presentation}
      initialIntent={entryDetailIntent}
      shareAction={marketplaceShareAction(
        entryShareStates.get(detailEntry.id),
        (): void => handleShareEntry(detailEntry),
      )}
      preferCatalogDetail={browseGroups.some(
        (group) =>
          group.id === 'suggested' &&
          group.entries.some((entry) => entry.id === detailEntry.id),
      )}
      marketplaces={marketplaces}
      mcpServers={servers}
      accountConnectionsAvailable={accountConnectionsAvailable}
      sharedCollectionEditAvailable={isFeatureSurfaceAvailable(
        capabilities,
        'marketplace-shared-collection-edit',
      )}
      curatedMcpServers={curatedMcpServers}
      localCollections={capabilityInventory.localCollections}
      sharedCollections={capabilityInventory.sharedCollections}
      sharedSkills={capabilityInventory.sharedSkills}
      pipelines={capabilityInventory.pipelines}
      automationActivities={capabilityInventory.automationActivities}
      curatedAutomations={capabilityInventory.curatedAutomations}
      onOpenAutomation={openAutomationInEditor}
      localAgents={localAgentDefinitions}
      localAgentsLoading={localAgentsLoading}
      localAgentsError={localAgentsError}
      onRetryLocalAgents={() => void refreshLocalAgents()}
      onEditLocalAgent={(agent): void =>
        openAgentDialog({ mode: 'edit', agentId: agent.id })
      }
      onDeleteLocalAgent={(agent): void =>
        openAgentDialog({ mode: 'delete', agentId: agent.id })
      }
      sharedAgents={capabilityInventory.sharedAgents}
      sharedPlugins={capabilityInventory.sharedPlugins}
      sharedBlueprints={capabilityInventory.sharedBlueprints}
      providerConnectors={providerConnectors ?? []}
      providerConnectorsLoading={providerConnectorsLoading}
      onProviderConnectorsChanged={refreshProviderConnectors}
      // A page leaves to where it was opened from (a delete, a related
      // navigation): the list, or the management section that opened it.
      onClose={
        presentation === 'page' ? navigateBackFromEntryDetail : closeEntryDetail
      }
      onOpenEntry={(requestedEntryId) => {
        const entryId = visibleEntryId(
          requestedEntryId,
          publisherSkills.skills,
        );
        // No-op while a detail page is already open; captures when a
        // dialog-owned detail hops to a page-owned related entry.
        captureDetailReturnScrollTop();
        setEntryDetailStack((prev) =>
          detailEntry.id === entryId ? prev : [...prev, detailEntry.id],
        );
        setSelectedEntryId(entryId);
        setEntryDetailIntent('view');
      }}
      onOpenPipeline={(target) => {
        const returnToEntryContext = {
          entryId: detailEntry.id,
          stack: entryDetailStack,
          ...(entryDetailPipelineReturn
            ? { pipelineReturn: entryDetailPipelineReturn }
            : {}),
          ...(entryDetailFromInstalled ? { fromInstalled: true } : {}),
          ...(entryDetailManagementReturn
            ? { managementReturn: entryDetailManagementReturn }
            : {}),
          marketplace: {
            query,
            tab: activeTypeTab,
            ...(category ? { category } : {}),
          },
        };
        closeEntryDetail();
        useNavigationStore.getState().openPipelineEdit({
          ...target,
          returnToEntryContext,
        });
      }}
      returnToMarketplace={{
        query,
        tab: activeTypeTab,
        ...(category ? { category } : {}),
      }}
      onDisplayNameChange={(name): void => {
        const displayName = marketplaceTitleCase(name);
        // Bail out on identical content so repeated reports cannot feed a
        // render loop through a fresh object identity.
        setDetailNameOverride((prev) =>
          prev && prev.id === detailEntry.id && prev.name === displayName
            ? prev
            : { id: detailEntry.id, name: displayName },
        );
      }}
      // A page's breadcrumb sits right above the title, so it shows no Back
      // (CAN-4261): leaving goes through the breadcrumb, the app's history,
      // or `onClose` after a delete. A dialog keeps Back for its own stack.
      onNavigateBack={
        presentation === 'page'
          ? undefined
          : entryDetailStack.length > 0
            ? (): void => {
                const previous = entryDetailStack[entryDetailStack.length - 1];
                setEntryDetailStack((prev) => prev.slice(0, -1));
                setSelectedEntryId(previous);
              }
            : entryDetailPipelineReturn
              ? (): void => {
                  const target = entryDetailPipelineReturn;
                  closeEntryDetail();
                  useNavigationStore.getState().openPipelineEdit(target);
                }
              : undefined
      }
      onServersChanged={refreshServers}
      installedSkills={skills}
      initialSkillFilePath={
        skillDetailFilePath?.entryId === detailEntry.id
          ? skillDetailFilePath.filePath
          : undefined
      }
      skillEditing={skillEditorEntryId === detailEntry.id}
      onSkillEditingChange={(editing): void =>
        setSkillEditorEntryId(editing ? detailEntry.id : null)
      }
      onInstalledSkillRenamed={(skill): void => {
        // Follow the renamed skill in place, keeping the detail's Back and
        // breadcrumb context.
        const renamed = installedSkillEntry(skill.sourceId, skill.name);
        setInstalledSkillDetailEntry(renamed);
        setSelectedEntryId(renamed.id);
      }}
      onOpenAccountSettings={onOpenAccountSettings}
      onLocalCollectionsChanged={capabilityInventory.refreshLocalCollections}
      onSharedSkillsChanged={capabilityInventory.refreshSharedSkills}
      onSharedCollectionsChanged={capabilityInventory.refreshSharedCollections}
      onSharedResourceUnshared={capabilityInventory.removeSharedResource}
    />
  );

  const handleAddMarketplaceFromSkills = (repo: string): void => {
    setMarketplaceInitialRepo(repo);
    setAddMarketplaceOpen(true);
  };

  const showLoading =
    (loading ||
      skillsLoading ||
      mcpLoading ||
      capabilityInventory.loading ||
      publisherSkills.loading) &&
    entries.length === 0;
  // A failed local load is never shown as an empty inventory, and never
  // hides the shared agents that did load.
  const showLocalAgentsError =
    sharedCustomAgentsEnabled &&
    localAgentsError !== null &&
    (kindFilter === null || kindFilter === 'agent');
  const inventoryError = [
    skillsError ? `Skills: ${skillsError}` : null,
    mcpError ? `MCP servers: ${mcpError}` : null,
    capabilityInventory.error,
  ]
    .filter((message): message is string => message !== null)
    .join('\n');
  // Early access: every source that failed, in one notice. Sources that
  // failed for the same reason (usually the Cloud not being set up) are named
  // together rather than repeating the raw error once per source.
  const inventoryErrorSummary = summarizeLoadErrors([
    ...(skillsError ? [{ source: 'Skills', message: skillsError }] : []),
    ...(mcpError ? [{ source: 'MCP servers', message: mcpError }] : []),
    ...capabilityInventory.loadErrors,
  ]);

  // Entity-type level of a detail page's breadcrumb (CAN-3484). It leads to
  // the list of that type: the matching management section when the detail
  // was reached from an installed list, otherwise the Marketplace narrowed to
  // that type tab. The search and category are cleared so the crumb always
  // lands on the full list; Back is what returns to the search that led here.
  const selectedEntryKindFilter = selectedEntry
    ? marketplaceTabForKind(selectedEntry.kind)
    : null;
  const openInstalledFromDetail = (section: PluginsManagementSection): void => {
    closeEntryDetail();
    closeBrowseGroup();
    setManagementSection(section);
  };
  const openEntryTypeFromDetail = (): void => {
    if (selectedEntryKindFilter === null) return;
    if (entryDetailFromInstalled) {
      const managementSection = managementSectionForCapabilityType(
        selectedEntryKindFilter,
      );
      if (managementSection !== null) {
        openInstalledFromDetail(managementSection);
        return;
      }
    }
    detailReturnScrollTopRef.current = 0;
    closeEntryDetail();
    closeBrowseGroup();
    setQuery('');
    setCategory(null);
    setKindFilter(
      selectedEntryKindFilter === 'all' ? null : selectedEntryKindFilter,
    );
  };
  // A requested curated pipeline preview (App Advisor) opens once the
  // catalog is available here.
  const pendingCuratedPipelinePreviewKey = useNavigationStore(
    (state) => state.pendingCuratedPipelinePreviewKey,
  );
  const selectCuratedPipeline = capabilityInventory.curated?.onSelectKey;
  // The request waits for the catalog, as it did on the Pipelines page.
  const { curatedReady } = capabilityInventory;
  useEffect(() => {
    if (
      !pendingCuratedPipelinePreviewKey ||
      !selectCuratedPipeline ||
      !curatedReady
    ) {
      return;
    }
    useNavigationStore.getState().consumeCuratedPipelinePreview();
    selectCuratedPipeline(pendingCuratedPipelinePreviewKey);
  }, [curatedReady, pendingCuratedPipelinePreviewKey, selectCuratedPipeline]);
  // A template keeps the launch on/off preference the Pipelines list's
  // template preview owned before Workflows › Library replaced that list.
  const [curatedTemplateToggling, setCuratedTemplateToggling] = useState(false);
  const selectedCuratedTemplateId =
    capabilityInventory.curated?.selectedKey !== null &&
    capabilityInventory.curated?.selectedKey !== undefined
      ? curatedPipelineId(capabilityInventory.curated.selectedKey)
      : null;
  const { disabledPipelineIds, setPipelineEnabled } = capabilityInventory;
  const curatedTemplateAvailability =
    selectedCuratedTemplateId !== null
      ? {
          enabled: !disabledPipelineIds.has(selectedCuratedTemplateId),
          pending: curatedTemplateToggling,
          onChange: (enabled: boolean): void => {
            setCuratedTemplateToggling(true);
            void setPipelineEnabled(selectedCuratedTemplateId, enabled).finally(
              () => setCuratedTemplateToggling(false),
            );
          },
        }
      : undefined;
  const curatedPipelineBreadcrumbTitle =
    capabilityInventory.curated?.selectedKey !== null &&
    capabilityInventory.curated?.selectedKey !== undefined
      ? (capabilityInventory.curated.detail?.name ??
        capabilityInventory.curated.rows.find(
          (row) => row.key === capabilityInventory.curated?.selectedKey,
        )?.name ??
        capabilityInventory.curated.selectedKey)
      : null;
  const openCuratedPipelineType = (): void => {
    capabilityInventory.curated?.onBack();
    closeBrowseGroup();
    setQuery('');
    setCategory(null);
    setKindFilter('workflow');
  };

  // A breadcrumb (entry detail or category page) needs the taller bar; the
  // root Marketplace keeps the shared 40px so its title stays on the
  // sidebar's Search row, which the Suggested E2E test pins.
  const titlebarHasBreadcrumb = Boolean(
    (selectedEntryUsesDetailPage && selectedEntry) ||
    sourceDetailOpen ||
    activeBrowseGroup,
  );

  return (
    <div
      ref={pageScrollRef}
      className="marketplace-page-scroll page-scroll-gutter h-full w-full overflow-y-auto"
      data-testid="page-plugins"
      data-tall-titlebar={titlebarHasBreadcrumb ? 'true' : undefined}
    >
      {/*
        Pinned: the page root is the only vertical scroller, so without the
        bar staying put the breadcrumb ("Customize > Productivity", or an
        entry's trail) scrolls away with the first screen of a long category
        or detail page and the way back disappears with it. The pinned bar is
        opaque and carries the bottom hairline that fades in once the page has
        scrolled; `z-20` keeps it above the list's own stacking.

        With a breadcrumb the bar is 46px rather than the shared 40px: the
        breadcrumb keeps the sidebar's 9px top inset so it stays on the
        sidebar controls' line, and gets the same 9px below it before the
        divider. The page content under it pulls up by the 6px difference so
        the category and detail headings sit exactly where the root
        Marketplace heading sits.
      */}
      <PageTitlebar
        pinned
        scrolled={pageScrolled}
        height={titlebarHasBreadcrumb ? 'breadcrumb' : 'bar'}
        className="z-20"
        testId="plugins-page-titlebar"
      >
        {selectedEntryUsesDetailPage && selectedEntry ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="plugins-entry-detail-titlebar"
          >
            <div className="electron-no-drag min-w-0">
              <CustomizeBreadcrumbs
                testId="plugins-entry-detail-breadcrumbs"
                items={[
                  {
                    key: 'root',
                    label: CUSTOMIZE_LABEL,
                    testId: 'plugins-entry-detail-breadcrumb-root',
                    onSelect: (): void => {
                      if (activeBrowseGroup) {
                        detailReturnScrollTopRef.current =
                          browseScrollTopRef.current;
                      }
                      closeEntryDetail();
                      closeBrowseGroup();
                    },
                  },
                  ...(entryDetailFromInstalled
                    ? [
                        {
                          key: 'installed',
                          label: 'Installed',
                          testId: 'plugins-entry-detail-breadcrumb-installed',
                          onSelect: (): void =>
                            openInstalledFromDetail('installed'),
                        },
                      ]
                    : activeBrowseGroup
                      ? [
                          {
                            key: 'category',
                            label: activeBrowseGroup.title,
                            testId: 'plugins-entry-detail-breadcrumb-category',
                            onSelect: closeEntryDetail,
                          },
                        ]
                      : []),
                  {
                    key: 'type',
                    label: marketplaceEntityTypeLabel(selectedEntry.kind),
                    testId: 'plugins-entry-detail-breadcrumb-type',
                    entryKind: selectedEntry.kind,
                    ...(selectedEntryKindFilter === null
                      ? {}
                      : { onSelect: openEntryTypeFromDetail }),
                  },
                  ...(skillEditorOpen
                    ? [
                        {
                          key: 'entry',
                          label: selectedEntry.name,
                          title: selectedEntry.name,
                          shrink: true,
                          testId: 'plugins-entry-detail-breadcrumb-entry',
                          onSelect: (): void => setSkillEditorEntryId(null),
                        },
                        {
                          key: 'edit',
                          label: 'Edit',
                          testId: 'plugins-entry-detail-breadcrumb-edit',
                        },
                      ]
                    : [
                        {
                          key: 'current',
                          label: selectedEntry.name,
                          testId: 'plugins-entry-detail-breadcrumb-current',
                        },
                      ]),
                ]}
              />
            </div>
          </div>
        ) : sourceDetailOpen ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="marketplace-source-titlebar"
          >
            <nav
              aria-label="Breadcrumb"
              className="electron-no-drag flex h-7 min-w-0 items-center text-s font-normal"
              data-testid="marketplace-source-breadcrumbs"
            >
              <ol className="flex h-full min-w-0 items-center gap-1">
                <li className="flex h-full shrink-0 items-center">
                  <button
                    type="button"
                    data-testid="marketplace-source-breadcrumb-root"
                    onClick={() => {
                      setSelectedSourceId(null);
                      setKindFilter(null);
                    }}
                    className={`${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`}
                  >
                    {CUSTOMIZE_LABEL}
                  </button>
                </li>
                <li
                  aria-hidden="true"
                  className="flex h-full shrink-0 items-center fg-tertiary"
                >
                  <ChevronRightMediumIcon size={16} />
                </li>
                <li className="flex h-full shrink-0 items-center">
                  <button
                    type="button"
                    data-testid="marketplace-source-breadcrumb-sources"
                    onClick={closeMarketplaceSource}
                    className={`${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`}
                  >
                    Marketplaces
                  </button>
                </li>
                <li
                  aria-hidden="true"
                  className="flex h-full shrink-0 items-center fg-tertiary"
                >
                  <ChevronRightMediumIcon size={16} />
                </li>
                <li className="flex h-full min-w-0 items-center">
                  <span
                    aria-current="page"
                    className="flex h-7 min-w-0 items-center truncate px-1.5 fg-primary"
                    data-testid="marketplace-source-breadcrumb-current"
                  >
                    <span className="ph-mask truncate">
                      {selectedSource?.name ?? 'Marketplace'}
                    </span>
                  </span>
                </li>
              </ol>
            </nav>
          </div>
        ) : activeBrowseGroup ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="plugins-category-titlebar"
          >
            <nav
              aria-label="Breadcrumb"
              className="electron-no-drag flex h-7 min-w-0 items-center text-s font-normal"
              data-testid="plugins-category-breadcrumbs"
            >
              <ol className="flex h-full min-w-0 items-center gap-1">
                <li className="flex h-full shrink-0 items-center">
                  <button
                    type="button"
                    data-testid="plugins-category-breadcrumb-root"
                    onClick={closeBrowseGroup}
                    className={`${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`}
                  >
                    {CUSTOMIZE_LABEL}
                  </button>
                </li>
                <li
                  aria-hidden="true"
                  className="flex h-full shrink-0 items-center fg-tertiary"
                >
                  <ChevronRightMediumIcon size={16} />
                </li>
                <li className="flex h-full min-w-0 items-center">
                  <span
                    aria-current="page"
                    className="flex h-7 min-w-0 items-center truncate px-1.5 fg-primary"
                    data-testid="plugins-category-breadcrumb-current"
                  >
                    {activeBrowseGroup.title}
                  </span>
                </li>
              </ol>
            </nav>
          </div>
        ) : null}
      </PageTitlebar>
      <PageContent bottomInset="spacious">
        {selectedEntryUsesDetailPage && selectedEntry ? (
          <div data-testid="plugins-entry-detail-page" className="-mt-1.5">
            {renderEntryDetail(selectedEntry, 'page')}
          </div>
        ) : sourceDetailOpen && selectedSourceId !== null ? (
          <div data-testid="marketplace-source-page" className="-mt-1.5">
            <MarketplaceSourceDetail
              state={marketplaceSources}
              onBulkStateChange={setSourceBulkState}
              sourceId={selectedSourceId}
              onNavigateBack={closeMarketplaceSource}
              breadcrumbs={null}
              filters={sourcePluginFilters}
              onFiltersChange={setSourcePluginFilters}
              canOpenPlugin={(sourceId, pluginKey) =>
                sourcePluginEntry(sourceId, pluginKey) !== undefined
              }
              onOpenPlugin={(sourceId, pluginKey) => {
                const entry = sourcePluginEntry(sourceId, pluginKey);
                if (entry) selectEntry(entry, false);
              }}
            />
          </div>
        ) : activeBrowseGroup ? (
          <div data-testid="plugins-category-page" className="-mt-1.5">
            <PageHeading
              title={activeBrowseGroup.title}
              subtitle={`Browse all ${activeBrowseGroup.title.toLowerCase()} capabilities.`}
            />

            <MarketplaceSearchField
              className="mt-6"
              inputRef={categorySearchInputRef}
              value={categoryQuery}
              onChange={setCategoryQuery}
              onEscapeEmpty={closeBrowseGroup}
              ariaLabel={`Search ${activeBrowseGroup.title}`}
              clearAriaLabel={`Clear ${activeBrowseGroup.title} search`}
              testId="plugins-category-search"
              clearTestId="plugins-category-search-clear"
            />

            <div className="mt-10">
              <PluginsDiscoveryList
                sections={[
                  {
                    id: 'category-page',
                    title: '',
                    entries: categoryPageEntries,
                  },
                ]}
                selectedEntryId={selectedEntryId}
                onSelectEntry={handleSelectEntry}
                onAddEntry={handleAddEntry}
                entryShareStates={entryShareStates}
                onShareEntry={handleShareEntry}
                onConnectEntry={handleAddEntry}
                onOpenEntryId={handleOpenEntryId}
                emptyMessage="Nothing matches your search."
              />
            </div>
          </div>
        ) : (
          <>
            <PageHeading
              heading={<CustomizeSectionHeading />}
              actions={
                <PluginsAddCustomMenu
                  onAddMarketplace={() => setAddMarketplaceOpen(true)}
                  onAddMcpServer={() => setMcpDialogOpen(true)}
                  onInstallSkillsFromGitHub={() => setAddSkillsOpen(true)}
                  onCreateCustomSkill={() => setCreateSkillOpen(true)}
                  onCreateCollection={() => setCreateCollectionOpen(true)}
                  onCreateAgent={
                    sharedCustomAgentsEnabled
                      ? (): void => openAgentDialog({ mode: 'create' })
                      : undefined
                  }
                />
              }
            />

            {/* Marketplace controls and results use the full shared page width,
            matching the other top-level utility pages. */}
            <div className="mt-6 flex flex-col gap-4">
              {/* Pill search: the page's primary control, so it gets the full
              column width and the only rounded-full shape on the surface. */}
              {!showingSources && (
                <MarketplaceSearchField
                  inputRef={searchInputRef}
                  value={query}
                  onChange={(value) => {
                    setQuery(value);
                    setFocusSection(null);
                  }}
                  onEscapeEmpty={() => setCategory(null)}
                  ariaLabel="Search all capabilities"
                  clearAriaLabel={`Clear ${CUSTOMIZE_LABEL} search`}
                  testId="plugins-search"
                  clearTestId="plugins-search-clear"
                />
              )}

              <MarketplaceTypeTabs
                value={activeTypeTab}
                tabs={typeTabs}
                onChange={(tab) => {
                  setKindFilter(tab === 'all' ? null : tab);
                  setFocusSection(null);
                  setCategory(null);
                  setSelectedSourceId(null);
                }}
              />
            </div>

            {showingSources ? (
              <div className="mt-6" data-testid="plugins-marketplace-sources">
                <MarketplaceSourcesList
                  state={marketplaceSources}
                  onOpenSource={openMarketplaceSource}
                  removeConfirmation={marketplaceSourceRemoveConfirmation}
                />
              </div>
            ) : (
              <div data-testid="plugins-results-scroll">
                <ErrorBanner error={error} />
                {inventoryErrorSummary && (
                  <Notice
                    intent="destructive"
                    title={inventoryErrorSummary.title}
                    className="mb-4"
                    data-testid="plugins-load-error"
                  >
                    {inventoryErrorSummary.message}
                  </Notice>
                )}
                {publisherSkills.error ? (
                  <Notice
                    intent="destructive"
                    className="mb-4"
                    data-testid="publisher-skills-error"
                    actions={
                      <NoticeButton
                        onClick={() => void publisherSkills.refresh()}
                      >
                        Try again
                      </NoticeButton>
                    }
                  >
                    Couldn't load publisher skills.
                  </Notice>
                ) : null}

                {showLocalAgentsError && (
                  <Notice
                    intent="destructive"
                    className="mb-4"
                    data-testid="plugins-local-agents-error"
                    actions={
                      <NoticeButton onClick={() => void refreshLocalAgents()}>
                        Try again
                      </NoticeButton>
                    }
                  >
                    Couldn't load your agents.
                  </Notice>
                )}

                <div className="mt-10">
                  <ErrorBanner error={skillUpdates.error} />
                  <CustomizeTabSections
                    tab={activeCatalogTab}
                    entries={entries}
                    query={deferredQuery}
                    installedInventory={
                      error ||
                      skillsError ||
                      mcpError ||
                      capabilityInventory.installedInventory === 'error'
                        ? 'error'
                        : loading ||
                            skillsLoading ||
                            mcpLoading ||
                            capabilityInventory.installedInventory === 'loading'
                          ? 'loading'
                          : 'ready'
                    }
                    loading={
                      showLoading ||
                      (kindFilter === 'agent' && localAgentsLoading)
                    }
                    ownershipAvailable={
                      ownershipAvailable && !!capabilityInventory.viewerId
                    }
                    supportedUpdateKinds={['skill', 'automation']}
                    pipelineFilters={pipelineFilters}
                    pipelineCategory={category}
                    suggestedNames={suggestedNames}
                    agentsAvailable={sharedCustomAgentsEnabled}
                    projectTemplatesAvailable
                    McpServerLogoComponent={McpServerLogo}
                    showPipelineSources
                    contextKey={JSON.stringify([
                      shareScopingContext,
                      capabilityInventory.viewerId,
                    ])}
                    selectedEntryId={selectedEntryId}
                    onSelectEntry={handleSelectEntry}
                    onAddEntry={handleAddEntry}
                    onConnectEntry={handleAddEntry}
                    onOpenEntryId={handleOpenEntryId}
                    entryShareStates={entryShareStates}
                    onShareEntry={handleShareEntry}
                    onExpandBrowseGroup={(id) =>
                      openBrowseGroup(
                        id.startsWith('category-')
                          ? `category-${id.slice(9)}`
                          : 'suggested',
                      )
                    }
                    onUpdateEntry={handleUpdateEntry}
                    onUpdateFailures={skillUpdates.reportFailures}
                    onRetryInventory={() => {
                      void useAutomationsStore.getState().hydrate();
                      void reloadMarketplaces();
                      void refreshSkills();
                      void refreshServers();
                      void capabilityInventory.refreshPipelines();
                      void capabilityInventory.refreshLocalCollections();
                      capabilityInventory.refreshOwnedShares();
                    }}
                    focusSection={focusSection}
                    focusPending={
                      capabilityInventory.ownedSharesLoading ||
                      capabilityInventory.loading
                    }
                    onFocusSectionSettled={() => setFocusSection(null)}
                    browseActions={
                      <div className="flex flex-wrap items-center gap-3">
                        <PluginsPipelineFilters
                          values={pipelineFilterValues}
                          onChange={setPipelineFilterValues}
                        />
                        <RefreshButton
                          dataTestId="plugins-pipelines-refresh"
                          ariaLabel="Refresh pipelines"
                          busy={pipelinesRefreshBusy}
                          onClick={handleRefreshPipelines}
                        />
                      </div>
                    }
                    emptyMessage="Nothing here yet. Use Add custom to bring in your own."
                    emptyState={
                      kindFilter === 'collection' ? (
                        <EmptyState
                          title="No collections yet"
                          subtitle="Group skills, plugins, and MCP servers so a chat or pipeline can pick them up together."
                          action={
                            <button
                              type="button"
                              data-testid="plugins-collections-empty-create"
                              onClick={() => setCreateCollectionOpen(true)}
                              className={SECONDARY_ACTION_BUTTON_CLASS}
                            >
                              Add collection
                            </button>
                          }
                        />
                      ) : kindFilter === 'agent' && !showLocalAgentsError ? (
                        <EmptyState
                          title="No agents yet"
                          subtitle="Create an agent to reuse instructions and plugins from model pickers and pipelines."
                          action={
                            <button
                              type="button"
                              data-testid="plugins-agents-empty-create"
                              onClick={() =>
                                openAgentDialog({ mode: 'create' })
                              }
                              className={SECONDARY_ACTION_BUTTON_CLASS}
                            >
                              New agent
                            </button>
                          }
                        />
                      ) : kindFilter === 'workflow' && !inventoryError ? (
                        <EmptyState
                          title="No workflows yet"
                          subtitle="Run an agent or a pipeline on a schedule. Workflows you create or add show up here."
                          action={
                            <button
                              type="button"
                              data-testid="plugins-automations-empty-open"
                              onClick={() =>
                                useNavigationStore
                                  .getState()
                                  .navigate('automations')
                              }
                              className={SECONDARY_ACTION_BUTTON_CLASS}
                            >
                              Open Workflows
                            </button>
                          }
                        />
                      ) : undefined
                    }
                  />
                </div>
                {kindFilter === 'workflow' && (
                  <PipelineCatalogStatus
                    curated={
                      curatedEnabled ? capabilityInventory.curated : undefined
                    }
                    sharedNextCursor={
                      pipelineFilters.source === 'all' ||
                      pipelineFilters.source === 'shared'
                        ? capabilityInventory.sharedPipelineNextCursor
                        : null
                    }
                    sharedLoadingMore={
                      capabilityInventory.sharedPipelinesLoadingMore
                    }
                    onLoadMoreShared={() =>
                      void capabilityInventory.loadMoreSharedPipelines()
                    }
                  />
                )}
                {kindFilter === 'workflow' && (
                  <AutomationCatalogStatus
                    curated={capabilityInventory.curatedAutomations}
                    sharedNextCursor={
                      capabilityInventory.sharedAutomationNextCursor
                    }
                    sharedLoadingMore={
                      capabilityInventory.sharedAutomationsLoadingMore
                    }
                    onLoadMoreShared={() =>
                      void capabilityInventory.loadMoreSharedAutomations()
                    }
                  />
                )}
              </div>
            )}
          </>
        )}
      </PageContent>
      {capabilityInventory.curated && (
        <CuratedPipelinePreview
          breadcrumbs={
            curatedPipelineBreadcrumbTitle ? (
              <nav
                aria-label="Breadcrumb"
                className="mb-4 flex h-7 min-w-0 items-center text-s font-normal"
                data-testid="plugins-curated-pipeline-breadcrumbs"
              >
                <ol className="flex h-full min-w-0 items-center gap-1">
                  <li className="flex h-full shrink-0 items-center">
                    <button
                      type="button"
                      data-testid="plugins-curated-pipeline-breadcrumb-root"
                      onClick={capabilityInventory.curated.onBack}
                      className={`${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`}
                    >
                      {CUSTOMIZE_LABEL}
                    </button>
                  </li>
                  <li
                    aria-hidden="true"
                    className="flex h-full shrink-0 items-center fg-tertiary"
                  >
                    <ChevronRightMediumIcon size={16} />
                  </li>
                  <li className="flex h-full shrink-0 items-center">
                    <button
                      type="button"
                      data-testid="plugins-curated-pipeline-breadcrumb-type"
                      onClick={openCuratedPipelineType}
                      className={`${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`}
                    >
                      Workflows
                    </button>
                  </li>
                  <li
                    aria-hidden="true"
                    className="flex h-full shrink-0 items-center fg-tertiary"
                  >
                    <ChevronRightMediumIcon size={16} />
                  </li>
                  <li className="flex h-full min-w-0 items-center">
                    <span
                      aria-current="page"
                      className="flex h-7 min-w-0 items-center truncate px-1.5 fg-primary"
                      data-testid="plugins-curated-pipeline-breadcrumb-current"
                    >
                      {curatedPipelineBreadcrumbTitle}
                    </span>
                  </li>
                </ol>
              </nav>
            ) : undefined
          }
          catalog={{
            ...capabilityInventory.curated,
            launchAvailability: curatedTemplateAvailability,
            onOpenImported: (id) =>
              useNavigationStore
                .getState()
                .openPipelineEdit({ pipelineId: id, source: 'user' }),
          }}
        />
      )}

      <PluginsManagementView
        open={managementSection !== null}
        initialSection={managementSection ?? 'installed'}
        // A detail page opened from the management view keeps that view's
        // list mounted behind it, so Back restores its state (CAN-3483).
        retainContent={
          selectedDetailPageEntryId !== null &&
          entryDetailManagementReturn !== null
        }
        statusFilter={managementStatusFilter}
        onClearStatusFilter={() => setManagementStatusFilter(null)}
        onClose={() => {
          setManagementSection(null);
          setManagementStatusFilter(null);
          // The management view's `SkillsTab`/`McpServersTab` mutate through
          // their own hook instances (see the top-level `useSkillList`/
          // `useMcpServerList` comment); refresh discovery's projection on
          // close so any install/uninstall/edit made in there is reflected.
          void refreshSkills();
          void refreshServers();
        }}
        onSectionChange={setManagementSection}
        entries={entries}
        selectedEntryId={selectedEntryId}
        onSelectEntry={handleSelectEntry}
        onOpenSkill={(skill) => {
          // The list's inventory can be ahead of this page's (it owns its own
          // `useSkillList`); catch up so the page's actions see the skill.
          void refreshSkills();
          openInstalledSkillDetail(skill);
        }}
        marketplaces={marketplaces}
        marketplacesLoading={loading}
        marketplacesError={error}
        marketplacesProgressMessage={progressMessage}
        marketplacesLastRefreshed={cache?.lastRefreshed ?? null}
        // Deliberate user gesture (Refresh button / invalid-marketplace
        // Retry), so force the provider recheck past the 24h TTL. Incidental
        // callers leave this unset and inherit 'if-stale'.
        onRefreshMarketplaces={() => refreshMarketplaces('always')}
        onMarketplaceUpserted={upsertMarketplace}
        onMarketplaceRemoved={applyMarketplaceRemoval}
        onOpenMarketplace={(marketplace) => {
          setDetailPluginName(null);
          setSelectedMarketplace(marketplace);
        }}
        onAddMarketplace={() => setAddMarketplaceOpen(true)}
        onAddMarketplaceFromSkills={handleAddMarketplaceFromSkills}
        onOpenAccountSettings={onOpenAccountSettings}
      />

      <AddMarketplaceModal
        isOpen={addMarketplaceOpen}
        onClose={() => {
          setAddMarketplaceOpen(false);
          setMarketplaceInitialRepo('');
        }}
        existingRepos={existingRepos}
        onAdded={upsertMarketplace}
        initialRepo={marketplaceInitialRepo}
      />

      {mcpDialogOpen && (
        <McpServerDialog
          serverId={null}
          curatedEntries={curatedMcpServers}
          onClose={() => setMcpDialogOpen(false)}
          onSaved={async () => {
            setMcpDialogOpen(false);
            await refreshServers();
          }}
        />
      )}

      <AddSkillsModal
        isOpen={addSkillsOpen}
        onClose={() => setAddSkillsOpen(false)}
        onInstalled={refreshSkills}
        onAddMarketplace={handleAddMarketplaceFromSkills}
      />

      <CreateSkillModal
        isOpen={createSkillOpen}
        onClose={() => setCreateSkillOpen(false)}
        onSaved={async () => {
          setCreateSkillOpen(false);
          await refreshSkills();
        }}
      />
      {createCollectionOpen && (
        <CollectionModal
          collectionId={null}
          onClose={() => setCreateCollectionOpen(false)}
          onSaved={async (): Promise<void> => {
            setCreateCollectionOpen(false);
            await capabilityInventory.refreshLocalCollections();
          }}
        />
      )}

      <MarketplacePluginsModal
        marketplace={selectedMarketplace}
        initialPluginName={detailPluginName}
        onClose={() => {
          setSelectedMarketplace(null);
          setDetailPluginName(null);
        }}
      />

      {sharedCustomAgentsEnabled &&
        (agentDialog?.mode === 'create' ||
          (agentDialog?.mode === 'edit' && agentDialogTarget)) && (
          <AgentModelModal
            agent={agentDialog.mode === 'edit' ? agentDialogTarget : null}
            existingAgents={localAgentDefinitions}
            onClose={() => setAgentDialog(null)}
            onSave={handleSaveAgent}
          />
        )}
      {sharedCustomAgentsEnabled &&
        agentDialog?.mode === 'delete' &&
        agentDialogTarget && (
          <DeleteConfirmModal
            title="Delete agent"
            message={`Existing chats and pipelines that use ${agentDialogTarget.id} will fail until another model is selected.`}
            confirmLabel="Delete agent"
            pending={agentDeletePending}
            error={agentDeleteError}
            onCancel={() => {
              if (agentDeletePending) return;
              setAgentDialog(null);
            }}
            onConfirm={() => handleConfirmDeleteAgent(agentDialogTarget.id)}
          />
        )}
      {ownedShare.shareModal}
      {pluginShareTarget && (
        <SharePluginModal
          pluginRef={pluginShareTarget.pluginRef}
          name={pluginShareTarget.name}
          description={pluginShareTarget.description}
          onClose={() => setPluginShareTarget(null)}
        />
      )}
      {shareGateModal}

      {/* Dialog-owned branches remain over the browse/management surface. */}
      {selectedEntry &&
        !selectedEntryUsesDetailPage &&
        renderEntryDetail(selectedEntry, 'modal')}
    </div>
  );
}
