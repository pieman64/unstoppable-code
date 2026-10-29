/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { act, type JSX, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MarketplaceSourcesClient } from '@canopy/app-core/client';
import type {
  IPCResult,
  MarketplaceInfo,
  MarketplaceOperationProgress,
  MarketplaceRemovalResult,
  PluginDetails,
  PluginInfo,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import type {
  DesktopPublisherSkill,
  InstalledSkillInfo,
  SharedSkillSummary,
} from '@canopy/desktop-shared/types/skills';
import type {
  CollectionConfig,
  CollectionIndexEntry,
  SharedCollectionSummary,
} from '@canopy/desktop-shared/types/collections';
import type {
  McpServerData,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type {
  CuratedPipelineDetail,
  CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import type * as UiAppModule from '@canopy/ui-app';
import {
  buildUnifiedPluginEntries,
  curatedCatalogFromMarketplaces,
} from '@canopy/ui-app';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type { CapabilityMarketplaceInventory } from '../../../hooks/useCapabilityMarketplaceInventory';
import type {
  PreferencesData,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { CuratedAutomationSummary } from '@canopy/protocol/automation-catalog';
import type { UnifiedLocalAutomationInput } from '@canopy/ui-app/capability';
import { TITLEBAR_BUTTON_CLASSNAME } from '../../sidebar/sidebar-styles';
import type * as SkillsTabModule from '../SkillsTab';
import type * as EditSkillWithAIModule from '@/lib/editSkillWithAI';
import type * as McpServersTabModule from '../McpServersTab';
import { brandText } from '@/lib/brand';
import { CuratedMcpConnectionDetail } from '../../plugins/CuratedMcpConnectionDetail';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

// "Edit with AI" (CAN-1259) opens a Cowork chat through the standalone chat
// store; this suite checks the page wiring, so only the hand-off is stubbed.
const mockOpenEditSkillWithAIChat = jest.fn<
  Promise<void>,
  [{ sourceId: string; name: string }]
>();
jest.mock('@/lib/editSkillWithAI', () => ({
  ...jest.requireActual<typeof EditSkillWithAIModule>('@/lib/editSkillWithAI'),
  openEditSkillWithAIChat: (skill: {
    sourceId: string;
    name: string;
  }): Promise<void> => mockOpenEditSkillWithAIChat(skill),
}));
jest.mock('../../plugins/McpOAuthBrowser', () => ({
  McpOAuthBrowser: (): JSX.Element => (
    <aside data-testid="plugin-oauth-browser" />
  ),
}));

const mockRequestShare = jest.fn();
const mockPublisherSkills = {
  skills: [] as DesktopPublisherSkill[],
  loading: false,
  error: null as string | null,
  refresh: jest.fn(),
};
jest.mock('../../../hooks/usePublisherSkills', () => ({
  usePublisherSkills: (): typeof mockPublisherSkills => mockPublisherSkills,
}));

jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): { authenticated: boolean } => ({
    authenticated: true,
  }),
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): { authenticated: boolean } => ({
    authenticated: false,
  }),
}));
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => false,
}));

jest.mock('../../../hooks/useShareAccess', () => ({
  useShareAccess: (): {
    requestShare: typeof mockRequestShare;
    shareGateModal: null;
  } => ({
    requestShare: mockRequestShare,
    shareGateModal: null,
  }),
}));

const mockCapabilityMarketplaceInventory: CapabilityMarketplaceInventory = {
  removeSharedResource: jest.fn(),
  ownershipAccountReady: true,
  viewerId: 'account',
  ownedSharesLoading: false,
  refreshOwnedShares: jest.fn(),
  installedInventory: 'ready',
  pipelines: [],
  curated: {
    rows: [],
    query: {},
    onQueryChange: jest.fn(),
    loading: false,
    error: null,
    stale: false,
    nextCursor: null,
    onRefresh: jest.fn(),
    onLoadMore: jest.fn(),
    onSelect: jest.fn(),
    onBack: jest.fn(),
    onImport: jest.fn(),
  },
  loadMoreSharedPipelines: jest.fn(() => Promise.resolve()),
  sharedPipelineNextCursor: null,
  sharedPipelinesLoadingMore: false,
  refreshPipelines: jest.fn(() => Promise.resolve()),
  disabledPipelineIds: new Set<string>(),
  curatedReady: true,
  setPipelineEnabled: jest.fn(() => Promise.resolve()),
  localCollections: [],
  sharedSkills: [],
  sharedCollections: [],
  loading: false,
  error: null,
  loadErrors: [],
  refreshLocalCollections: jest.fn(() => Promise.resolve()),
  refreshSharedSkills: jest.fn(() => Promise.resolve()),
  refreshSharedCollections: jest.fn(() => Promise.resolve()),
  localAutomations: [],
  automationActivities: [],
  sharedAutomations: [],
  localAgents: [],
  localAgentDefinitions: [],
  localAgentsLoading: false,
  localAgentsLoaded: true,
  localAgentsError: null,
  refreshLocalAgents: jest.fn(() => Promise.resolve()),
  sharedAgents: [],
  refreshSharedAgents: jest.fn(),
  sharedPlugins: [],
  sharedBlueprints: [],
  curatedAutomations: {
    rows: [],
    loading: false,
    error: null,
    stale: false,
    nextCursor: null,
    onRefresh: jest.fn(),
    onLoadMore: jest.fn(),
    selectedKey: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    installSource: null,
    onSelectKey: jest.fn(),
    onClearDetail: jest.fn(),
    localStateByKey: new Map(),
  },
  loadMoreSharedAutomations: jest.fn(() => Promise.resolve()),
  sharedAutomationNextCursor: null,
  sharedAutomationsLoadingMore: false,
};

// The automation details own their loading and the install wizard; this suite
// covers what the page hands them and what it does with their callbacks.
jest.mock('../../automations/AutomationCatalogDetail', () => ({
  AutomationCatalogDetail: ({
    activity,
    updateAvailable,
    onOpenInAutomations,
  }: {
    activity: { id: string };
    updateAvailable: boolean;
    onOpenInAutomations: () => void;
  }): JSX.Element => (
    <div
      data-testid="mock-automation-local-detail"
      data-activity-id={activity.id}
      data-update-available={String(updateAvailable)}
    >
      <button
        type="button"
        data-testid="mock-automation-open"
        onClick={onOpenInAutomations}
      >
        Open in Automations
      </button>
    </div>
  ),
  SharedAutomationMarketplaceDetail: ({
    automationId,
    onNameLoaded,
  }: {
    automationId: string;
    onNameLoaded?: (name: string) => void;
  }): JSX.Element => {
    // A share opened by id outside the inventory reports its loaded name.
    useEffect(() => {
      if (!automationId.startsWith('owned-')) return;
      void Promise.resolve().then(() =>
        onNameLoaded?.(`Loaded ${automationId}`),
      );
    }, [automationId, onNameLoaded]);
    return (
      <div
        data-testid="mock-automation-shared-detail"
        data-automation-id={automationId}
      />
    );
  },
  CuratedAutomationMarketplaceDetail: ({
    loading,
  }: {
    loading: boolean;
  }): JSX.Element => (
    <div
      data-testid="mock-automation-curated-detail"
      data-loading={String(loading)}
    />
  ),
}));

// Local agent dialogs (CAN-4266): their own suites cover the forms; this one
// covers what the page opens, with which agent, and what it does on save.
jest.mock('../../agents/AgentModelModal', () => ({
  AgentModelModal: ({
    agent,
    onClose,
    onSave,
  }: {
    agent: { id: string; instructions?: string } | null;
    onClose: () => void;
    onSave: (request: { name: string }) => Promise<void>;
  }): JSX.Element => (
    <div
      data-testid="mock-agent-model-modal"
      data-agent-id={agent?.id ?? 'new'}
      data-agent-instructions={agent?.instructions ?? ''}
    >
      <button
        type="button"
        data-testid="mock-agent-model-save"
        onClick={() => void onSave({ name: 'Saved' }).then(onClose)}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="mock-agent-model-close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  ),
}));

jest.mock('../../agents/ShareAgentModal', () => ({
  ShareAgentModal: ({
    agent,
    onPublicLinkRemoved,
  }: {
    agent: { id: string };
    onPublicLinkRemoved?: () => void;
  }): JSX.Element => (
    <div data-testid="mock-share-agent-modal">
      {agent.id}
      <button
        data-testid="mock-agent-remove-public-link"
        aria-label="Remove public link"
        onClick={onPublicLinkRemoved}
      />
    </div>
  ),
}));

const mockAgentsStore = {
  save: jest.fn<Promise<void>, [unknown]>(() => Promise.resolve()),
  remove: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
};
jest.mock('@/stores/agentsStore', () => ({
  useAgentsStore: (
    selector: (state: typeof mockAgentsStore) => unknown,
  ): unknown => selector(mockAgentsStore),
}));

jest.mock('../../automations/ShareAutomationModal', () => ({
  ShareAutomationModal: ({
    activity,
  }: {
    activity: { id: string };
  }): JSX.Element => (
    <div data-testid="mock-share-automation-modal">{activity.id}</div>
  ),
}));

let mockInventoryOptions: Record<string, unknown> | undefined;
jest.mock('../../../hooks/useCapabilityMarketplaceInventory', () => ({
  useCapabilityMarketplaceInventory: (
    _query: string,
    options?: Record<string, unknown>,
  ): typeof mockCapabilityMarketplaceInventory => {
    mockInventoryOptions = options;
    return mockCapabilityMarketplaceInventory;
  },
}));

// Desktop reports the owned-automation-shares capability; a test can turn it
// off to check the facet stays hidden where the host cannot list them.
let mockOwnedAutomationSharesCapability = true;
let mockMarketplaceSourcesClient: MarketplaceSourcesClient | undefined;
// The every-tab "Shared by me" capability (CAN-4263), on for desktop.
let mockOwnedSharesCapability = true;
// Shared collection Edit (CAN-4263 AC2), on for desktop.
let mockSharedCollectionEditCapability = true;
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCapabilities: (): Record<string, unknown> => ({
    marketplaceOwnedAutomationShares: mockOwnedAutomationSharesCapability,
    marketplaceOwnedShares: mockOwnedSharesCapability,
    marketplaceSharedCollectionEdit: mockSharedCollectionEditCapability,
  }),
  // No source client: the Marketplaces tab stays hidden unless a test wires one.
  useCanopyClient: (): Record<string, unknown> => ({
    capabilities: mockMarketplaceSourcesClient
      ? { marketplaceSources: true, marketplaceSourcePluginInstall: true }
      : {},
    marketplaceSources: mockMarketplaceSourcesClient,
  }),
}));

// This suite does not exercise the shared content renderer.
jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<typeof UiAppModule>('@canopy/ui-app'),
  MarkdownFrontmatterContent: (): null => null,
}));
let mockPluginDetailViewProps: {
  plugin: PluginInfo;
  marketplace: MarketplaceInfo;
  onBack: () => void;
  onPluginUpdated: (plugin: PluginInfo) => void;
} | null = null;
const mockSharedDetailMounts = { skill: 0, collection: 0 };
// `PluginDetailView` owns install/uninstall, provider facets, and the Codex
// compatibility toggle behind heavy IPC of its own (covered by
// `PluginDetailView.test.tsx`). Both hosts — the marketplace-plugins modal and
// the unified entry detail wrapper — are asserted through the props they hand
// it, which is the contract that actually has to hold.
jest.mock('../PluginDetailView', () => ({
  PluginDetailView: (props: {
    plugin: PluginInfo;
    marketplace: MarketplaceInfo;
    onBack: () => void;
    onPluginUpdated: (plugin: PluginInfo) => void;
  }): JSX.Element => {
    mockPluginDetailViewProps = props;
    return <div data-testid="mock-plugin-detail-view">{props.plugin.name}</div>;
  },
}));
/**
 * Commit-phase mount/unmount tallies for the stubbed tab components.
 *
 * Counted through a *stable* ref callback rather than a render counter on
 * purpose: refs attach during commit, so a render React discards (the
 * derive-during-render section correction in `PluginsManagementView`) never
 * registers, while a section that genuinely reaches the DOM always does. A
 * stable callback identity also keeps React from re-running detach/attach on
 * every re-render.
 */
const mockTabLifecycle: Record<
  'skills' | 'mcp' | 'collections',
  { mounts: number; unmounts: number }
> = {
  skills: { mounts: 0, unmounts: 0 },
  mcp: { mounts: 0, unmounts: 0 },
  collections: { mounts: 0, unmounts: 0 },
};

function mockTabLifecycleRef(
  key: 'skills' | 'mcp' | 'collections',
): (node: HTMLDivElement | null) => void {
  return (node: HTMLDivElement | null): void => {
    if (node) {
      mockTabLifecycle[key].mounts += 1;
    } else {
      mockTabLifecycle[key].unmounts += 1;
    }
  };
}

const mockSkillsTabRef = mockTabLifecycleRef('skills');
const mockMcpServersTabRef = mockTabLifecycleRef('mcp');
const mockCollectionsTabRef = mockTabLifecycleRef('collections');

// The management view mounts the moved tab components. They own heavy IPC and
// Canopy Cloud state this suite does not exercise, so the tab components are
// stubbed while the dialogs the discovery dropdown opens (`AddSkillsModal`,
// `CreateSkillModal`, `McpServerDialog`) stay real.
jest.mock('../SkillsTab', () => ({
  ...jest.requireActual<typeof SkillsTabModule>('../SkillsTab'),
  // The stub keeps the real `onOpenSkill` contract so the page-level detail
  // routing (CAN-3483) is exercised without SkillsTab's own IPC.
  SkillsTab: ({
    onOpenSkill,
  }: {
    onOpenSkill?: (skill: {
      sourceId: string;
      name: string;
      edit?: true;
    }) => void;
  }): JSX.Element => (
    <div data-testid="mock-skills-tab" ref={mockSkillsTabRef}>
      <button
        type="button"
        data-testid="mock-skills-tab-open-review-checklist"
        onClick={() =>
          onOpenSkill?.({ sourceId: 'custom:app', name: 'review-checklist' })
        }
      >
        review-checklist
      </button>
      <button
        type="button"
        data-testid="mock-skills-tab-edit-review-checklist"
        onClick={() =>
          onOpenSkill?.({
            sourceId: 'custom:app',
            name: 'review-checklist',
            edit: true,
          })
        }
      >
        Edit skill
      </button>
    </div>
  ),
  SharedSkillDetailModal: ({
    mode,
    summary,
    presentation,
    onAdd,
    onUpdated,
    onSwitchToEdit,
  }: {
    mode: 'view' | 'edit';
    summary: SharedSkillSummary;
    presentation?: 'modal' | 'page';
    onAdd?: () => Promise<void>;
    onUpdated?: (updated: SharedSkillSummary) => void;
    onSwitchToEdit: () => void;
  }): JSX.Element => {
    useEffect(() => {
      mockSharedDetailMounts.skill += 1;
    }, []);
    return (
      <section
        data-testid="plugins-entry-detail"
        data-presentation={presentation}
        data-content-hash={summary.contentHash}
      >
        {summary.name}
        {onAdd && (
          <button
            data-testid="mock-shared-skill-add"
            onClick={() => void onAdd()}
          >
            Add
          </button>
        )}
        {onUpdated && (
          <button
            data-testid={`mock-shared-skill-update-${mode}`}
            onClick={() =>
              onUpdated({
                ...summary,
                name: `${summary.name} Renamed`,
                contentHash: 'updated-skill-hash',
              })
            }
          >
            Update
          </button>
        )}
        {mode === 'view' && (
          <button data-testid="mock-shared-skill-edit" onClick={onSwitchToEdit}>
            Edit
          </button>
        )}
      </section>
    );
  },
}));
jest.mock('../McpServersTab', () => ({
  ...jest.requireActual<typeof McpServersTabModule>('../McpServersTab'),
  McpServersTab: (): JSX.Element => (
    <div data-testid="mock-mcp-servers-tab" ref={mockMcpServersTabRef} />
  ),
}));
jest.mock('../CollectionsTab', () => ({
  resolveSharedCollectionImport: (detail: {
    collection: {
      items: Array<{
        type: string;
        skill_name: string;
        source: { type: string; id: string };
      }>;
    };
  }): Promise<{
    skills: Array<{ sourceId: string; skillName: string }>;
    plugins: [];
  }> =>
    Promise.resolve({
      skills: detail.collection.items.map((item) => ({
        sourceId: `${item.source.type}:${item.source.id}`,
        skillName: item.skill_name,
      })),
      plugins: [],
    }),
  CollectionsTab: (): JSX.Element => (
    <div data-testid="mock-collections-tab" ref={mockCollectionsTabRef} />
  ),
  // Serves both the detail page (`presentation="page"`) and the create-mode
  // dialog the Marketplace opens from "Add custom" and the empty Collections
  // tab. Only its identity and its close/save callbacks matter here.
  CollectionModal: ({
    presentation,
    onClose,
    onSaved,
    onDeleted,
  }: {
    presentation?: 'modal' | 'page';
    onClose: () => void;
    onSaved: () => Promise<void>;
    onDeleted?: () => void;
  }): JSX.Element => (
    <section
      data-testid="plugins-entry-detail"
      data-presentation={presentation}
      aria-labelledby="collection-modal-title"
    >
      <button
        type="button"
        data-testid="mock-collection-modal-close"
        onClick={onClose}
      >
        Close
      </button>
      <button
        data-testid="mock-local-collection-save"
        onClick={() => void onSaved()}
      >
        Save
      </button>
      {onDeleted && (
        <button data-testid="mock-local-collection-delete" onClick={onDeleted}>
          Delete
        </button>
      )}
    </section>
  ),
  SharedCollectionDetailModal: ({
    mode,
    summary,
    presentation,
    onAdd,
    onUpdated,
    onSwitchToEdit,
  }: {
    mode: 'view' | 'edit';
    summary: SharedCollectionSummary;
    presentation?: 'modal' | 'page';
    onAdd?: () => Promise<void>;
    onUpdated?: (updated: SharedCollectionSummary) => void;
    onSwitchToEdit?: () => void;
  }): JSX.Element => {
    useEffect(() => {
      mockSharedDetailMounts.collection += 1;
    }, []);
    return (
      <section
        data-testid="plugins-entry-detail"
        data-presentation={presentation}
        data-content-hash={summary.contentHash}
      >
        {summary.name}
        {onAdd && (
          <button
            data-testid="mock-shared-collection-add"
            onClick={() => void onAdd()}
          >
            Add
          </button>
        )}
        {onUpdated && (
          <button
            data-testid={`mock-shared-collection-update-${mode}`}
            onClick={() =>
              onUpdated({
                ...summary,
                name: `${summary.name} Renamed`,
                contentHash: 'updated-collection-hash',
              })
            }
          >
            Update
          </button>
        )}
        {mode === 'view' && onSwitchToEdit && (
          <button
            data-testid="mock-shared-collection-edit"
            onClick={onSwitchToEdit}
          >
            Edit
          </button>
        )}
      </section>
    );
  },
}));

import { PluginsPage } from '../PluginsPage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyDetails: PluginDetails = {
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'alpha-tool',
    sourcePath: '',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    details: null,
    externalSource: { source: 'github', url: 'https://github.com/acme/tool' },
    ...overrides,
  };
}

function makeMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Acme Plugins',
    sourceType: 'github',
    sourceUrl: 'acme/plugins',
    installLocation: '/tmp/mkt',
    lastUpdated: '2026-05-01T00:00:00.000Z',
    pluginCount: 0,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

function makeCuratedMarketplace(
  plugins: PluginInfo[],
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return makeMarketplace({
    id: 'curated/cloud',
    name: 'Canopy Curated Marketplace',
    curated: true,
    removable: false,
    sourceType: 'curated',
    sourceUrl: 'curated:cloud',
    pluginCount: plugins.length,
    plugins,
    ...overrides,
  });
}

function makeBuiltInMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return makeMarketplace({
    id: 'builtin/app',
    name: 'Canopy Marketplace',
    builtIn: true,
    removable: false,
    sourceType: 'builtin',
    sourceUrl: 'builtin:app',
    ...overrides,
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  const deferred: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((innerResolve) => {
    deferred.resolve = innerResolve;
  });
  if (!deferred.resolve) {
    throw new Error('Deferred promise resolver was not initialized');
  }
  return { promise, resolve: deferred.resolve };
}

function makeSkill(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  return {
    name: 'review-checklist',
    sourceId: 'custom:app',
    description: 'Zeta review checklist for pull requests.',
    source: 'custom',
    installedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

function makeMcpServer(
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id: 'srv-github',
    name: 'GitHub',
    description: 'GitHub MCP server.',
    type: 'http',
    configs: [{ id: 'cfg-1', name: 'default', enabled: true }],
    curatedKey: 'github',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMcpStatus(
  overrides: Partial<McpServerStatusEntry> = {},
): McpServerStatusEntry {
  return {
    serverId: 'srv-github',
    transport: 'http',
    connectionStatus: 'auth_required',
    reachability: 'unknown',
    configs: [{ configId: 'cfg-1', authStatus: 'required' }],
    ...overrides,
  };
}

function makeCuratedMcp(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'github',
    name: 'GitHub',
    shortDescription: 'Connect issues and pull requests.',
    url: 'https://mcp.github.com',
    transport: 'http',
    categories: ['developer-tools'],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

const CURATED_PLUGINS: PluginInfo[] = [
  makePlugin({
    name: 'writer-toolkit',
    displayName: 'Writer Toolkit',
    description: 'Draft and edit prose.',
    category: 'writing',
    marketplaceId: 'curated/cloud',
    curated: true,
    recommended: true,
    providerSupport: { claude: 'native', codex: 'native' },
    // This recommended catalog entry has not been downloaded into the app yet.
    details: null,
  }),
  makePlugin({
    name: 'data-cruncher',
    displayName: 'Data Cruncher',
    description: 'Crunch numbers fast.',
    category: 'analytics',
    marketplaceId: 'curated/cloud',
    curated: true,
    providerSupport: { claude: 'native', codex: 'native' },
  }),
  makePlugin({
    name: 'installed-helper',
    displayName: 'Installed Helper',
    description: 'Already installed helper.',
    category: 'writing',
    marketplaceId: 'curated/cloud',
    curated: true,
    recommended: true,
    providerSupport: { claude: 'native', codex: 'native' },
    globalInstallStatus: {
      claude: { available: true, installed: true },
      checkedAt: '2026-05-01T00:00:00.000Z',
    },
  }),
];

const MARKETPLACE_PLUGINS: PluginInfo[] = [
  makePlugin({
    name: 'alpha-tool',
    displayName: 'Alpha Tool',
    description: 'An alphabetical helper.',
    category: 'utilities',
  }),
  makePlugin({
    name: 'zeta-tool',
    displayName: 'Zeta Tool',
    description: 'A final helper.',
    category: 'utilities',
  }),
];

// ---------------------------------------------------------------------------
// window.* mocks
// ---------------------------------------------------------------------------

interface PluginsApiMock {
  loadMarketplaces: jest.Mock;
  loadMarketplacesCacheOnly: jest.Mock;
  installBuiltInPlugin: jest.Mock;
  refreshMarketplaces: jest.Mock;
  addMarketplace: jest.Mock;
  updateMarketplace: jest.Mock;
  removeMarketplace: jest.Mock;
  readComponentContent: jest.Mock;
  installPlugin: jest.Mock;
  onMarketplaceOperationProgress: jest.Mock;
}

interface SkillsApiMock {
  checkUpdates: jest.Mock;
  updateSkill: jest.Mock;
  loadSkills: jest.Mock;
  fetchAvailable: jest.Mock;
  installSkills: jest.Mock;
  readContent: jest.Mock;
  listFiles: jest.Mock;
  readFile: jest.Mock;
  saveCustomSkill: jest.Mock;
  removeSkill: jest.Mock;
}

interface McpServersApiMock {
  loadIndex: jest.Mock;
  listStatus: jest.Mock;
  listCurated: jest.Mock;
  refreshCurated: jest.Mock;
  listProviderConnectors: jest.Mock;
  openProviderConnectorSettings: jest.Mock;
  loadServer: jest.Mock;
  getAccountConnection: jest.Mock;
  saveServer: jest.Mock;
  deleteServer: jest.Mock;
  checkHealth: jest.Mock;
  testConnection: jest.Mock;
  startOAuthLogin: jest.Mock;
  cancelOAuthLogin: jest.Mock;
  startAccountConnection: jest.Mock;
  listAccountConnections: jest.Mock;
  onAuthChanged: jest.Mock<() => void, [() => void]>;
  resolveRemoteImage: jest.Mock;
}

function okResult<T>(data: T): IPCResult<T> {
  return { success: true, data };
}

function makeCache(marketplaces: MarketplaceInfo[]): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-05-22T00:00:00.000Z',
    marketplaces,
  };
}

/**
 * CAN-4261: a detail page shows no Back; its breadcrumb is the way out. The
 * named crumb (root, type or installed) leads where Back used to.
 */
async function leaveDetailByCrumb(
  crumb: 'root' | 'type' | 'installed',
  label: string,
): Promise<void> {
  expect(
    document.querySelector('[data-testid="plugins-entry-detail-back"]'),
  ).toBeNull();
  const node = document.querySelector(
    `[data-testid="plugins-entry-detail-breadcrumb-${crumb}"]`,
  );
  if (!(node instanceof HTMLElement))
    throw new Error(`${label} not found or wrong element type`);
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
}

function requireElement(node: Element | null, label: string): HTMLElement {
  if (!(node instanceof HTMLElement)) {
    throw new Error(`${label} not found or wrong element type`);
  }
  return node;
}

function requireButton(node: Element | null, label: string): HTMLButtonElement {
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`${label} not found or wrong element type`);
  }
  return node;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // Accessor is intentionally invoked with the input as its receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter) Reflect.apply(setter, input, [value]);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

interface MountOptions {
  marketplaces?: MarketplaceInfo[];
  skills?: InstalledSkillInfo[];
  mcpServers?: McpServerIndexEntry[];
  mcpStatuses?: McpServerStatusEntry[];
  curatedMcpServers?: CuratedMcpServerEntry[];
}

describe('PluginsPage discovery', () => {
  let container: HTMLElement;
  let root: Root;
  let pluginsApi: PluginsApiMock;
  let skillsApi: SkillsApiMock;
  let mcpServersApi: McpServersApiMock;
  let authChangedListeners: Set<() => void>;
  let collectionsApi: {
    getShared: jest.Mock;
    inspectImport: jest.Mock;
    installCapabilityPackage: jest.Mock;
    saveCollection: jest.Mock<
      Promise<CollectionConfig>,
      [Partial<CollectionConfig> & { name: string }]
    >;
  };
  /**
   * Every `onMarketplaceOperationProgress` subscriber. `useMarketplaceList`,
   * `AddMarketplaceModal`, and `RemoveConfirmDialog` each subscribe, so a test
   * emitting progress must reach all of them, not just the newest.
   */
  let marketplaceProgressCallbacks: ((
    progress: MarketplaceOperationProgress,
  ) => void)[] = [];
  const originalWindowValues = new Map<string, unknown>();

  function emitMarketplaceProgress(
    progress: MarketplaceOperationProgress,
  ): void {
    marketplaceProgressCallbacks.forEach((callback) => callback(progress));
  }

  function defineWindowApi(key: string, value: unknown): void {
    if (!originalWindowValues.has(key)) {
      originalWindowValues.set(key, Reflect.get(window, key));
    }
    Object.defineProperty(window, key, { configurable: true, value });
  }

  beforeEach(() => {
    mockCapabilityMarketplaceInventory.viewerId = 'account';
    mockCapabilityMarketplaceInventory.ownedSharesLoading = false;
    resetExperimentalFeaturesStoreForTest();
    mockOwnedAutomationSharesCapability = true;
    mockOwnedSharesCapability = true;
    mockSharedCollectionEditCapability = true;
    mockInventoryOptions = undefined;
    mockCapabilityMarketplaceInventory.error = null;
    mockCapabilityMarketplaceInventory.loadErrors = [];
    mockPublisherSkills.skills = [];
    mockPublisherSkills.error = null;
    mockPublisherSkills.loading = false;
    mockCapabilityMarketplaceInventory.pipelines = [];
    if (mockCapabilityMarketplaceInventory.curated) {
      mockCapabilityMarketplaceInventory.curated.rows = [];
      mockCapabilityMarketplaceInventory.curated.stale = false;
      mockCapabilityMarketplaceInventory.curated.nextCursor = null;
      mockCapabilityMarketplaceInventory.curated.selectedKey = null;
      mockCapabilityMarketplaceInventory.curated.detail = null;
      mockCapabilityMarketplaceInventory.curated.loading = false;
      mockCapabilityMarketplaceInventory.curated.onRefresh = jest.fn();
    }
    mockCapabilityMarketplaceInventory.refreshPipelines = jest.fn(() =>
      Promise.resolve(),
    );
    mockCapabilityMarketplaceInventory.sharedPipelineNextCursor = null;
    mockCapabilityMarketplaceInventory.localCollections = [];
    mockCapabilityMarketplaceInventory.sharedSkills = [];
    mockCapabilityMarketplaceInventory.sharedCollections = [];
    mockCapabilityMarketplaceInventory.localAutomations = [];
    mockCapabilityMarketplaceInventory.automationActivities = [];
    mockCapabilityMarketplaceInventory.sharedAutomations = [];
    mockCapabilityMarketplaceInventory.sharedAgents = [];
    mockCapabilityMarketplaceInventory.localAgents = [];
    mockCapabilityMarketplaceInventory.localAgentDefinitions = [];
    mockCapabilityMarketplaceInventory.localAgentsLoading = false;
    mockCapabilityMarketplaceInventory.localAgentsLoaded = true;
    mockCapabilityMarketplaceInventory.localAgentsError = null;
    mockCapabilityMarketplaceInventory.refreshLocalAgents = jest.fn(() =>
      Promise.resolve(),
    );
    mockCapabilityMarketplaceInventory.refreshSharedAgents = jest.fn();
    mockAgentsStore.save.mockReset().mockResolvedValue(undefined);
    mockAgentsStore.remove.mockReset().mockResolvedValue(undefined);
    mockCapabilityMarketplaceInventory.sharedPlugins = [];
    mockCapabilityMarketplaceInventory.sharedBlueprints = [];
    mockCapabilityMarketplaceInventory.sharedAutomationNextCursor = null;
    mockCapabilityMarketplaceInventory.sharedAutomationsLoadingMore = false;
    mockCapabilityMarketplaceInventory.loadMoreSharedAutomations = jest.fn(() =>
      Promise.resolve(),
    );
    const curatedAutomations =
      mockCapabilityMarketplaceInventory.curatedAutomations;
    curatedAutomations.rows = [];
    curatedAutomations.loading = false;
    curatedAutomations.error = null;
    curatedAutomations.stale = false;
    curatedAutomations.nextCursor = null;
    curatedAutomations.selectedKey = null;
    curatedAutomations.onRefresh = jest.fn();
    curatedAutomations.onLoadMore = jest.fn();
    // The real hook keeps its own selection; mirror that so the page's
    // selection sync settles instead of asking again on every render.
    curatedAutomations.onSelectKey = jest.fn((key: string): void => {
      curatedAutomations.selectedKey = key;
    });
    curatedAutomations.onClearDetail = jest.fn((): void => {
      curatedAutomations.selectedKey = null;
    });
    mockCapabilityMarketplaceInventory.loading = false;
    mockCapabilityMarketplaceInventory.error = null;
    mockCapabilityMarketplaceInventory.refreshLocalCollections = jest.fn(() =>
      Promise.resolve(),
    );
    mockCapabilityMarketplaceInventory.refreshSharedSkills = jest.fn(() =>
      Promise.resolve(),
    );
    mockCapabilityMarketplaceInventory.refreshSharedCollections = jest.fn(() =>
      Promise.resolve(),
    );
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    useNavigationStore.setState({
      pendingSkillViewer: undefined,
      pendingPluginsNavigation: undefined,
      pluginsBrowseSectionId: null,
      workflowEdit: undefined,
    });
    mockPluginDetailViewProps = null;
    mockSharedDetailMounts.skill = 0;
    mockSharedDetailMounts.collection = 0;
    mockRequestShare.mockReset();
    marketplaceProgressCallbacks = [];
    Object.values(mockTabLifecycle).forEach((counts) => {
      counts.mounts = 0;
      counts.unmounts = 0;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    pluginsApi = {
      loadMarketplaces: jest.fn(),
      loadMarketplacesCacheOnly: jest.fn(),
      installBuiltInPlugin: jest.fn(),
      refreshMarketplaces: jest.fn(),
      addMarketplace: jest.fn(),
      updateMarketplace: jest.fn(),
      removeMarketplace: jest.fn(),
      readComponentContent: jest.fn(),
      installPlugin: jest.fn(),
      onMarketplaceOperationProgress: jest.fn(
        (
          callback: (progress: MarketplaceOperationProgress) => void,
        ): (() => void) => {
          marketplaceProgressCallbacks.push(callback);
          return () => {
            marketplaceProgressCallbacks = marketplaceProgressCallbacks.filter(
              (entry) => entry !== callback,
            );
          };
        },
      ),
    };
    skillsApi = {
      checkUpdates: jest.fn().mockResolvedValue({ success: true, data: {} }),
      updateSkill: jest.fn().mockResolvedValue({ success: true }),
      loadSkills: jest.fn(),
      fetchAvailable: jest.fn(),
      installSkills: jest.fn(),
      readContent: jest.fn(),
      listFiles: jest.fn(),
      readFile: jest.fn(),
      saveCustomSkill: jest.fn(),
      removeSkill: jest.fn(),
    };
    authChangedListeners = new Set();
    mcpServersApi = {
      loadIndex: jest.fn(),
      listStatus: jest.fn(),
      listCurated: jest.fn(),
      refreshCurated: jest.fn(),
      listProviderConnectors: jest.fn().mockResolvedValue([]),
      openProviderConnectorSettings: jest.fn().mockResolvedValue(undefined),
      loadServer: jest.fn(),
      getAccountConnection: jest.fn(),
      saveServer: jest.fn().mockImplementation((server: McpServerData) =>
        Promise.resolve({
          version: 1,
          server: {
            ...server,
            definition: { ...server.definition, id: 'new-server' },
          },
        }),
      ),
      deleteServer: jest.fn(),
      checkHealth: jest.fn(),
      testConnection: jest.fn(),
      startOAuthLogin: jest.fn().mockResolvedValue({ status: 'completed' }),
      cancelOAuthLogin: jest.fn().mockResolvedValue(undefined),
      startAccountConnection: jest.fn(),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      onAuthChanged: jest.fn<() => void, [() => void]>((listener) => {
        authChangedListeners.add(listener);
        return (): void => {
          authChangedListeners.delete(listener);
        };
      }),
      getTools: jest.fn().mockResolvedValue({ tools: ['create_issue'] }),
      resolveRemoteImage: jest.fn(),
    };
    collectionsApi = {
      getShared: jest.fn(),
      inspectImport: jest.fn(),
      installCapabilityPackage: jest.fn(),
      saveCollection: jest.fn<
        Promise<CollectionConfig>,
        [Partial<CollectionConfig> & { name: string }]
      >(),
    };

    defineWindowApi('plugins', pluginsApi);
    defineWindowApi('skills', skillsApi);
    defineWindowApi('mcpServers', mcpServersApi);
    defineWindowApi('api', {
      loadPreferences: jest.fn().mockResolvedValue({
        mcpHttpAuthDefaultHandler: 'canopy',
        defaultChatProvider: 'claude',
        defaultChatModelByProvider: {
          claude: { model: 'opus', thinkingLevel: 'high' },
          codex: { model: 'gpt-6.1-sol', thinkingLevel: 'medium' },
          ollama: null,
        },
      } satisfies Pick<
        PreferencesData,
        | 'mcpHttpAuthDefaultHandler'
        | 'defaultChatProvider'
        | 'defaultChatModelByProvider'
      >),
      // A signed-in viewer, so the detail CTA offers Install (CAN-4359).
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: [],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
      }),
    });
    defineWindowApi('collections', collectionsApi);
    defineWindowApi('pipelines', {
      listCapabilityRefs: jest
        .fn()
        .mockResolvedValue(okResult({ pipelines: [] })),
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    mockMarketplaceSourcesClient = undefined;
    useNavigationStore.setState({
      pendingSkillViewer: undefined,
      pendingPluginsNavigation: undefined,
      pluginsBrowseSectionId: null,
      workflowEdit: undefined,
    });
    container.remove();
    originalWindowValues.forEach((value: unknown, key: string) => {
      if (value === undefined) {
        Reflect.deleteProperty(window, key);
      } else {
        Object.defineProperty(window, key, { configurable: true, value });
      }
    });
    originalWindowValues.clear();
  });

  function configureApis(options: MountOptions = {}): void {
    pluginsApi.loadMarketplacesCacheOnly.mockResolvedValue(
      okResult(makeCache(options.marketplaces ?? [])),
    );
    pluginsApi.loadMarketplaces.mockResolvedValue(
      okResult(makeCache(options.marketplaces ?? [])),
    );
    skillsApi.loadSkills.mockResolvedValue(okResult(options.skills ?? []));
    mcpServersApi.loadIndex.mockResolvedValue({
      version: 1,
      servers: options.mcpServers ?? [],
    });
    mcpServersApi.listStatus.mockResolvedValue(options.mcpStatuses ?? []);
    mcpServersApi.listCurated.mockResolvedValue({
      servers: options.curatedMcpServers ?? [],
    });
  }

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(<PluginsPage />);
      await Promise.resolve();
    });
    await settle();
  }

  async function mount(options: MountOptions = {}): Promise<void> {
    configureApis(options);
    await renderPage();
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function mountFullFixture(): Promise<void> {
    await mount({
      marketplaces: [
        makeCuratedMarketplace(CURATED_PLUGINS),
        makeMarketplace({
          pluginCount: MARKETPLACE_PLUGINS.length,
          plugins: MARKETPLACE_PLUGINS,
        }),
      ],
      skills: [makeSkill()],
      mcpServers: [makeMcpServer()],
      mcpStatuses: [makeMcpStatus()],
      curatedMcpServers: [
        makeCuratedMcp(),
        makeCuratedMcp({
          key: 'linear',
          name: 'Linear',
          shortDescription: 'Track issues and projects.',
          oauthHints: { usePkce: true },
          categories: ['productivity'],
        }),
      ],
    });
  }

  /**
   * Entry-card testids inside `root`.
   *
   * The card's action controls and detail surface share the `plugins-entry-`
   * prefix, so a raw prefix query over-counts cards. Every card assertion goes
   * through this helper.
   */
  function entryTestIdsWithin(root: ParentNode): string[] {
    return Array.from(root.querySelectorAll('[data-testid^="plugins-entry-"]'))
      .map((node) => node.getAttribute('data-testid') ?? '')
      .filter(
        (testId) =>
          !testId.startsWith('plugins-entry-menu-') &&
          !testId.startsWith('plugins-entry-add-') &&
          !testId.startsWith('plugins-entry-share-') &&
          !testId.startsWith('plugins-entry-installed-') &&
          testId !== 'plugins-entry-detail',
      );
  }

  function entryIds(): string[] {
    return Array.from(
      new Set(
        Array.from(
          container.querySelectorAll('[data-marketplace-entry="true"]'),
        ).map((node) =>
          (node.getAttribute('data-testid') ?? '').replace(
            /^(plugins-entry-|customize-row-)/,
            '',
          ),
        ),
      ),
    );
  }

  /**
   * Press a control the way a real pointer does, in full: pointerdown,
   * mousedown, mouseup, then click.
   *
   * The whole sequence matters here. Menus dismiss on `pointerdown` and
   * swallow the click that press completes (`suppressNextClick`), so a
   * `mousedown`+`click` shorthand exercises neither the dismissal nor the
   * suppression — it just opens a second menu on top of the first and reports
   * a passing "one press switches menus" that no real press performs.
   */
  async function press(node: Element | null, label: string): Promise<void> {
    const element = requireElement(node, label);
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      await Promise.resolve();
    });
    await settle();
  }

  /** Open a card's ⋯ menu and return the card's menu surface. */
  async function openEntryMenu(entryId: string): Promise<HTMLElement> {
    await press(
      container.querySelector(`[data-testid="plugins-entry-menu-${entryId}"]`),
      `Card menu trigger for ${entryId}`,
    );
    return requireElement(
      document.querySelector(
        `[data-testid="plugins-entry-menu-surface-${entryId}"]`,
      ),
      `Card menu surface for ${entryId}`,
    );
  }

  async function typeQuery(value: string): Promise<void> {
    const input = container.querySelector('[data-testid="plugins-search"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Search input not found');
    }
    act(() => {
      setInputValue(input, value);
    });
    await settle();
  }

  it('keeps shared project templates visible in All and search', async () => {
    mockCapabilityMarketplaceInventory.sharedBlueprints = [
      {
        externalId: 'template-section-regression',
        sharePath:
          '/portal/plugins/project-templates/template-section-regression',
        pinnedContentHash: 'a'.repeat(64),
        name: 'Release workspace template',
        description: 'A shared project template for release work.',
        audience: 'PUBLIC',
        owner: { type: 'user', id: 'account', name: 'Template Author' },
        createdBy: { id: 'account', name: 'Template Author' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ];
    await mount();
    const templateId = 'blueprint:shared:template-section-regression';
    expect(entryIds()).toContain(templateId);
    expect(entryTestIdsWithin(sectionBody('project-templates'))).toEqual([
      `plugins-entry-${templateId}`,
    ]);

    await typeQuery('Release workspace template');
    expect(entryIds()).toEqual([templateId]);
    expect(
      container
        .querySelector('[data-testid="customize-sections"]')
        ?.getAttribute('data-result-count'),
    ).toBe('1');
  });

  it('opens a requested template preview only once the catalog can load', async () => {
    const onSelectKey = jest.fn();
    Object.assign(mockCapabilityMarketplaceInventory.curated ?? {}, {
      onSelectKey,
    });
    mockCapabilityMarketplaceInventory.curatedReady = false;
    useNavigationStore.setState({
      pendingCuratedPipelinePreviewKey: 'curated-review-0',
    });
    try {
      await mount();
      // Signed out, or the account is still connecting: the request waits.
      expect(onSelectKey).not.toHaveBeenCalled();
      expect(
        useNavigationStore.getState().pendingCuratedPipelinePreviewKey,
      ).toBe('curated-review-0');

      mockCapabilityMarketplaceInventory.curatedReady = true;
      await renderPage();
      expect(onSelectKey).toHaveBeenCalledWith('curated-review-0');
      expect(
        useNavigationStore.getState().pendingCuratedPipelinePreviewKey,
      ).toBeUndefined();
    } finally {
      mockCapabilityMarketplaceInventory.curatedReady = true;
      useNavigationStore.setState({
        pendingCuratedPipelinePreviewKey: undefined,
      });
    }
  });

  it('discovers publisher skills on the native Skills tab even without local inventory', async () => {
    mockPublisherSkills.skills = [
      {
        externalId: 'publisher-guide',
        name: 'writing-guide',
        description: 'Write clearly',
        publisher: 'Anthropic',
      },
    ];
    mockCapabilityMarketplaceInventory.error = 'Local inventory unavailable';
    await mount();
    await click(
      container.querySelector('[data-testid="plugins-type-tab-skill"]'),
      'Skills',
    );
    await typeQuery('Anthropic');
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-public-share:skill:publisher-guide"]',
      ),
    ).not.toBeNull();
  });

  it('keeps publisher catalog failures retryable alongside installed skills', async () => {
    mockPublisherSkills.error =
      'Publisher skills could not be loaded. Try again.';
    await mount();
    const error = container.querySelector(
      '[data-testid="publisher-skills-error"]',
    );
    expect(error).not.toBeNull();
    await click(error?.querySelector('button') ?? null, 'Try again');
    expect(mockPublisherSkills.refresh).toHaveBeenCalled();
  });

  describe('load errors', () => {
    const CLOUD_NOT_CONFIGURED = 'Canopy Cloud base URL is not configured.';

    function failSharedSources(): void {
      mockCapabilityMarketplaceInventory.loadErrors = [
        { source: 'Shared skills', message: CLOUD_NOT_CONFIGURED },
        { source: 'Shared collections', message: CLOUD_NOT_CONFIGURED },
      ];
      mockCapabilityMarketplaceInventory.error = [
        "Couldn't load shared skills and collections.",
        `${brandText.appName} Cloud isn't set up in this build.`,
      ].join('\n');
    }

    function enableEarlyAccess(): void {
      defineWindowApi('api', {
        loadPreferences: jest.fn().mockResolvedValue({
          mcpHttpAuthDefaultHandler: 'canopy',
        }),
      });
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    }

    it('groups errors without a Labs opt-in', async () => {
      failSharedSources();
      await mount();
      const results = container.querySelector(
        '[data-testid="plugins-results-scroll"]',
      );
      expect(results?.textContent).toContain(
        "Couldn't load shared skills and collections.",
      );
      expect(results?.textContent).toContain(
        `${brandText.appName} Cloud isn't set up in this build.`,
      );
      expect(
        container.querySelector('[data-testid="plugins-load-error"]'),
      ).not.toBeNull();
    });

    it('groups sources that failed for one reason with early access on', async () => {
      enableEarlyAccess();
      failSharedSources();
      await mount();
      const notice = container.querySelector(
        '[data-testid="plugins-load-error"]',
      );
      expect(notice?.textContent).toContain(
        "Couldn't load shared skills and collections.",
      );
      expect(notice?.textContent).toContain(
        `${brandText.appName} Cloud isn't set up in this build.`,
      );
      expect(
        container.querySelector('[data-testid="plugins-results-scroll"]')
          ?.textContent,
      ).not.toContain('base URL');
    });

    it('shows a clear publisher error without a Labs opt-in', async () => {
      mockPublisherSkills.error = 'Publisher catalog timed out.';
      await mount();
      const error = container.querySelector(
        '[data-testid="publisher-skills-error"]',
      );
      expect(error?.textContent).not.toContain('Publisher catalog timed out.');
      expect(error?.textContent).toContain("Couldn't load publisher skills.");
    });

    it('says the publisher catalog failed in plain words with early access on', async () => {
      enableEarlyAccess();
      mockPublisherSkills.error = 'Publisher catalog timed out.';
      await mount();
      const error = container.querySelector(
        '[data-testid="publisher-skills-error"]',
      );
      expect(error?.textContent).toContain("Couldn't load publisher skills.");
      await click(error?.querySelector('button') ?? null, 'Try again');
      expect(mockPublisherSkills.refresh).toHaveBeenCalled();
    });
  });

  it('preserves a same-name local skill and deduplicates only the provenance-matched install', async () => {
    mockPublisherSkills.skills = [
      {
        externalId: 'publisher-guide',
        name: 'writing-guide',
        description: 'Write clearly',
        publisher: 'Anthropic',
        installedSkillName: 'writing-guide-2',
      },
    ];
    await mount({
      skills: [
        makeSkill({ name: 'writing-guide' }),
        makeSkill({ name: 'writing-guide-2' }),
      ],
    });
    await click(
      container.querySelector('[data-testid="plugins-type-tab-skill"]'),
      'Skills',
    );
    await typeQuery('writing-guide');
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-public-share:skill:publisher-guide"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="customize-row-skill:custom:app:writing-guide"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="customize-row-skill:custom:app:writing-guide-2"]',
      ),
    ).toBeNull();
  });

  async function openAddCustomMenu(): Promise<void> {
    await press(
      container.querySelector('[data-testid="plugins-add-custom-menu"]'),
      'Add-custom menu trigger',
    );
  }

  async function openInstalledSettings(): Promise<void> {
    await openManagement('installed');
  }

  /** Tile ids currently rendered by the installed icon strip. */
  function installedTileIds(): string[] {
    return Array.from(
      container.querySelectorAll(
        '#customize-section-installed [data-marketplace-entry="true"]',
      ),
    ).map((node) =>
      (node.getAttribute('data-testid') ?? '').replace('customize-row-', ''),
    );
  }

  async function clickMenuItem(testId: string): Promise<void> {
    const item = requireElement(
      document.querySelector(`[data-testid="${testId}"]`),
      `Menu item ${testId}`,
    );
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
  }

  // -------------------------------------------------------------------------
  // Management-view helpers
  // -------------------------------------------------------------------------

  async function click(node: Element | null, label: string): Promise<void> {
    const element = requireElement(node, label);
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
  }

  /** Management compatibility uses its existing event, never a catalog control. */
  async function openManagement(
    section:
      | 'installed'
      | 'skills'
      | 'mcp'
      | 'collections'
      | 'marketplaces' = 'installed',
  ): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canopy:plugins-open-management', {
          detail: { section },
        }),
      );
      await Promise.resolve();
    });
    await settle();
  }

  /** Mount with `marketplaces` and land on the management Marketplaces section. */
  async function mountMarketplaces(
    marketplaces: MarketplaceInfo[],
  ): Promise<void> {
    await mount({ marketplaces });
    await openManagement('marketplaces');
  }

  async function openMarketplaceRow(marketplaceId: string): Promise<void> {
    await click(
      container.querySelector(
        `[data-testid="marketplace-row-${marketplaceId}"]`,
      ),
      `Marketplace row ${marketplaceId}`,
    );
  }

  function requirePluginDetailViewProps(): NonNullable<
    typeof mockPluginDetailViewProps
  > {
    if (!mockPluginDetailViewProps) {
      throw new Error('Plugin detail view was not rendered');
    }
    return mockPluginDetailViewProps;
  }

  /** The projection App Advisor actually reads, not the raw reporter slice. */
  function pluginsSnapshot(): NonNullable<
    ReturnType<typeof useCurrentUiStateStore.getState>['envelope']['snapshot']
  >['plugins'] {
    return useCurrentUiStateStore.getState().envelope.snapshot.plugins;
  }

  function marketplaceModalSnapshot(): unknown {
    return pluginsSnapshot()?.marketplaceModal;
  }

  // -------------------------------------------------------------------------
  // Entry detail helpers
  // -------------------------------------------------------------------------

  /** Activate a discovery/management card body, which opens the entry detail. */
  async function openEntry(entryId: string): Promise<void> {
    await click(
      container.querySelector(`[data-testid="customize-row-${entryId}"]`) ??
        container.querySelector(`[data-testid="plugins-entry-${entryId}"]`),
      `Entry card for ${entryId}`,
    );
  }

  function entryDetail(): Element | null {
    return document.querySelector('[data-testid="plugins-entry-detail"]');
  }

  function mcpServerDialog(): Element | null {
    return document.querySelector(
      '[aria-labelledby="mcp-server-dialog-title"]',
    );
  }

  // -------------------------------------------------------------------------
  // Page shell
  // -------------------------------------------------------------------------

  it('renders the discovery shell: root, search, installed row, add-custom menu', async () => {
    await mountFullFixture();

    const page = requireElement(
      container.querySelector('[data-testid="page-plugins"]'),
      'Customize page',
    );
    expect(page.className).toContain('page-scroll-gutter');
    expect(page.className).toContain('marketplace-page-scroll');
    const marketplaceSearch = requireElement<HTMLInputElement>(
      container.querySelector('[data-testid="plugins-search"]'),
      'Customize search',
    );
    expect(marketplaceSearch.parentElement?.className).toContain('-ml-4');
    expect(marketplaceSearch.placeholder).toBe('Search…');
    expect(
      container.querySelector('[data-testid="customize-section-installed"]'),
    ).not.toBeNull();
    const addCustomMenu = requireButton(
      container.querySelector('[data-testid="plugins-add-custom-menu"]'),
      'Add custom menu',
    );
    expect(addCustomMenu.classList).toContain('gap-1');
    expect(addCustomMenu.classList).not.toContain('gap-1.5');
    const mcpTab = requireButton(
      container.querySelector('[data-testid="plugins-type-tab-app"]'),
      'MCP servers type tab',
    );
    const typeTabs = requireElement(
      container.querySelector('[data-testid="plugins-type-tabs"]'),
      'Capability type tabs',
    );
    const allTab = requireButton(
      container.querySelector('[data-testid="plugins-type-tab-all"]'),
      'All type tab',
    );
    expect(typeTabs.className).toContain('canopy-tab-list');
    expect(typeTabs.className).toContain('overflow-y-hidden');
    expect(typeTabs.parentElement?.className).toContain('gap-4');
    expect(allTab.className).toContain('canopy-tab-trigger');
    expect(allTab.className).not.toContain('border-b-2');
    expect(allTab.getAttribute('aria-selected')).toBe('true');
    expect(allTab.className).not.toContain('rounded-full');
    expect(allTab.className).not.toContain('bg-accent');
    expect(mcpTab.textContent).toBe('MCP servers');
    expect(container.textContent).toContain(
      'Add and manage plugins, MCP servers, skills, workflows, collections, and agents.',
    );
    expect(
      Array.from(
        typeTabs.querySelectorAll('[data-testid^="plugins-type-tab-"]'),
      ).map((tab) => tab.textContent),
    ).toEqual([
      'All',
      'Plugins',
      'MCP servers',
      'Skills',
      'Workflows',
      'Collections',
      // Behind the Agents rollout flag, which defaults on here.
      'Agents',
    ]);
    // Tab chrome is gone.
    expect(
      container.querySelector('[data-testid="plugins-tab-collections"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-tab-marketplace"]'),
    ).toBeNull();
  });

  it('keeps one query while switching capability types and offers no Extensions tab', async () => {
    await mountFullFixture();
    await typeQuery('zeta');

    const pipelineTab = requireButton(
      container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
      'Pipelines type tab',
    );
    await click(pipelineTab, 'Pipelines type tab');

    const search = requireElement(
      container.querySelector('[data-testid="plugins-search"]'),
      'Customize search',
    );
    expect(search).toHaveProperty('value', 'zeta');
    expect(pipelineTab.getAttribute('aria-selected')).toBe('true');

    // Nothing produces an `extension` entry, so the tab that only ever said
    // "not available in this build yet" is not offered at all.
    expect(
      container.querySelector('[data-testid="plugins-type-tab-extension"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Extensions');
  });

  it('uses the branded canonical stale message in the pipelines catalog', async () => {
    if (!mockCapabilityMarketplaceInventory.curated) {
      throw new Error('Expected curated pipeline inventory');
    }
    mockCapabilityMarketplaceInventory.curated.stale = true;
    mockCapabilityMarketplaceInventory.curated.nextCursor = 'next';
    mockCapabilityMarketplaceInventory.sharedPipelineNextCursor = 'next';
    await mount();

    await click(
      requireButton(
        container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
        'Pipelines type tab',
      ),
      'Pipelines type tab',
    );

    expect(container.textContent).toContain(
      `Showing saved catalog metadata. Connect to ${brandText.appName} Cloud to preview or add a pipeline.`,
    );
    // One filter control beside the tabs; no native selects, row counts, or
    // manual refresh under the list.
    expect(
      container.querySelector('[data-testid="plugins-pipeline-filters"]'),
    ).not.toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(
      container.querySelector('[data-testid="curated-pipeline-load-more"]')
        ?.textContent,
    ).toBe('Show more pipelines');
    expect(container.textContent).not.toContain('loaded pipelines');
    expect(container.textContent).not.toContain('Refresh pipelines');
  });

  it('explains a curated pipeline catalog load error', async () => {
    const curated = mockCapabilityMarketplaceInventory.curated;
    if (!curated) throw new Error('Expected curated pipeline inventory');
    curated.error = 'Catalog unavailable for acme-private';
    try {
      await mount();
      await click(
        requireButton(
          container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
          'Pipelines type tab',
        ),
        'Pipelines type tab',
      );

      const notice = container.querySelector(
        '[data-testid="plugins-curated-pipelines-error"]',
      );
      expect(notice?.textContent).toContain("Couldn't load curated pipelines.");
      expect(notice?.textContent).toContain(
        'Catalog unavailable for acme-private',
      );
    } finally {
      curated.error = null;
    }
  });

  it('breadcrumbs a curated pipeline preview back to its Marketplace type', async () => {
    const curated = mockCapabilityMarketplaceInventory.curated;
    if (!curated) throw new Error('Expected curated pipeline inventory');
    const row: CuratedPipelineSummary = {
      key: 'review-workflow',
      name: 'Review workflow',
      shortDescription: 'Review a change before release.',
      icon: '',
      version: '1.0.0',
      triggerTypes: ['dispatch'],
      scopes: ['worktree'],
      jobCount: 1,
      stepCount: 1,
      contentHash: 'sha256:review',
      contentSizeBytes: 100,
      categories: ['development'],
      popular: true,
      sortOrder: 1,
      revision: 1,
      authorName: 'Canopy',
      authorUrl: null,
      docsUrl: null,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    curated.rows = [row];
    curated.selectedKey = row.key;
    curated.detail = {
      ...row,
      rawPipeline: 'name: Review workflow\non: dispatch\n',
    } satisfies CuratedPipelineDetail;

    await mount();

    expect(
      document.querySelector(
        '[data-testid="plugins-curated-pipeline-breadcrumbs"]',
      )?.textContent,
    ).toBe('CustomizeWorkflowsReview workflow');

    await click(
      document.querySelector(
        '[data-testid="plugins-curated-pipeline-breadcrumb-type"]',
      ),
      'Curated pipeline type breadcrumb',
    );

    expect(curated.onBack).toHaveBeenCalledTimes(1);
    expect(
      container
        .querySelector('[data-testid="plugins-type-tab-workflow"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('shows pipeline filters only on the Pipelines tab', async () => {
    await mount();
    expect(
      container.querySelector('[data-testid="plugins-pipeline-filters"]'),
    ).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    await click(
      requireButton(
        container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
        'Pipelines type tab',
      ),
      'Pipelines type tab',
    );
    // The filters head the list they narrow.
    expect(
      container.querySelector(
        '[data-testid="customize-sections"] [data-testid="plugins-pipeline-filters"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-type-tabs"] [data-testid="plugins-pipeline-filters"]',
      ),
    ).toBeNull();
  });

  it('refreshes only the Pipelines tab from one compact control and ignores repeat clicks', async () => {
    const curated = mockCapabilityMarketplaceInventory.curated;
    if (!curated) throw new Error('Expected curated pipeline inventory');
    const curatedRefresh = jest.fn();
    curated.onRefresh = curatedRefresh;
    let finishRefresh: () => void = () => undefined;
    const refreshPipelines = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    mockCapabilityMarketplaceInventory.refreshPipelines = refreshPipelines;
    await mount();

    // Every other tab stays current without a manual refresh.
    for (const tab of ['all', 'plugin', 'app', 'skill', 'collection']) {
      await click(
        container.querySelector(`[data-testid="plugins-type-tab-${tab}"]`),
        `${tab} type tab`,
      );
      expect(
        container.querySelector('[data-testid="plugins-pipelines-refresh"]'),
      ).toBeNull();
    }

    await click(
      container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
      'Pipelines type tab',
    );
    const refreshSelector =
      '[data-testid="customize-sections"] [data-testid="plugins-pipelines-refresh"]';
    const button = requireButton(
      container.querySelector(refreshSelector),
      'Pipelines refresh',
    );
    // Icon-only, labelled, and on the list heading beside the filters.
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Refresh pipelines');
    expect(button.disabled).toBe(false);
    // The shared Tooltip names it on hover, in place of a native title.
    expect(button.hasAttribute('title')).toBe(false);
    await act(async () => {
      button.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(
      Array.from(document.querySelectorAll('[role="tooltip"]'), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(['Refresh pipelines']);

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(refreshPipelines).toHaveBeenCalledTimes(1);
    expect(curatedRefresh).toHaveBeenCalledTimes(1);
    const busy = requireButton(
      container.querySelector(refreshSelector),
      'Pipelines refresh',
    );
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-label')).toBe(
      'Refresh pipelines (in progress)',
    );
    busy.click();
    expect(refreshPipelines).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh();
      await Promise.resolve();
    });
    await settle();
    const idle = requireButton(
      container.querySelector(refreshSelector),
      'Pipelines refresh',
    );
    expect(idle.disabled).toBe(false);
    expect(idle.getAttribute('aria-label')).toBe('Refresh pipelines');
  });

  it('shows the Pipelines refresh as busy while the curated catalog loads', async () => {
    const curated = mockCapabilityMarketplaceInventory.curated;
    if (!curated) throw new Error('Expected curated pipeline inventory');
    curated.loading = true;
    await mount();
    await click(
      container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
      'Pipelines type tab',
    );
    const button = requireButton(
      container.querySelector('[data-testid="plugins-pipelines-refresh"]'),
      'Pipelines refresh',
    );
    expect(button.disabled).toBe(true);
    button.click();
    expect(
      mockCapabilityMarketplaceInventory.refreshPipelines,
    ).not.toHaveBeenCalled();
  });

  it('offers to create a collection from the empty Collections tab', async () => {
    await mountFullFixture();

    await click(
      container.querySelector('[data-testid="plugins-type-tab-collection"]'),
      'Collections type tab',
    );
    expect(container.textContent).toContain('No collections yet');
    expect(container.textContent).not.toContain(
      'Nothing here yet. Use Add custom to bring in your own.',
    );

    await click(
      container.querySelector(
        '[data-testid="plugins-collections-empty-create"]',
      ),
      'Add collection empty-state action',
    );
    expect(
      document.querySelector('[aria-labelledby="collection-modal-title"]'),
    ).not.toBeNull();

    await click(
      document.querySelector('[data-testid="mock-collection-modal-close"]'),
      'Collection editor close',
    );
    expect(
      document.querySelector('[aria-labelledby="collection-modal-title"]'),
    ).toBeNull();
  });

  it('opens marketplace sources from the Marketplaces tab without loading them on All (CAN-4262)', async () => {
    const list = jest.fn(() =>
      Promise.resolve({
        lastRefreshedAt: '2026-10-19T00:00:00.000Z',
        sources: [
          {
            id: 'acme',
            name: 'Acme plugins',
            kind: 'github',
            sourceLabel: 'acme/plugins',
            status: { state: 'valid' as const, errors: [] },
            pluginCount: 0,
            actions: { update: true, remove: true },
            plugins: [],
          },
        ],
      }),
    );
    mockMarketplaceSourcesClient = {
      list,
      refreshAll: list,
      update: jest.fn(),
      remove: jest.fn(),
    };
    await mountFullFixture();
    expect(list).not.toHaveBeenCalled();

    const sourcesTab = requireButton(
      container.querySelector('[data-testid="plugins-type-tab-sources"]'),
      'Customizes type tab',
    );
    await click(sourcesTab, 'Customizes type tab');

    expect(list).toHaveBeenCalledTimes(1);
    expect(sourcesTab.getAttribute('aria-selected')).toBe('true');
    expect(
      container.querySelector('[data-testid="plugins-ownership-sources"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-search"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="marketplace-source-row"]'),
    ).toHaveLength(1);

    await click(
      container.querySelector('[data-testid="marketplace-source-open"]'),
      'source row',
    );
    expect(
      container.querySelector('[data-testid="marketplace-source-detail"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="marketplace-source-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Acme plugins');

    await click(
      container.querySelector(
        '[data-testid="marketplace-source-breadcrumb-sources"]',
      ),
      'Customizes breadcrumb',
    );
    expect(sourcesTab.getAttribute('aria-selected')).toBe('true');
    expect(
      container.querySelectorAll('[data-testid="marketplace-source-row"]'),
    ).toHaveLength(1);
  });

  it('offers no Marketplaces tab without a source client', async () => {
    await mountFullFixture();
    expect(
      container.querySelector('[data-testid="plugins-type-tab-sources"]'),
    ).toBeNull();
  });

  it('filters the marketplace to MCP servers from the explicit type tab', async () => {
    await mountFullFixture();

    const mcpTab = requireButton(
      container.querySelector('[data-testid="plugins-type-tab-app"]'),
      'MCP servers type tab',
    );
    await click(mcpTab, 'MCP servers type tab');

    expect(mcpTab.getAttribute('aria-selected')).toBe('true');
    expect(entryIds()).toEqual(['mcp-catalog:github', 'mcp-catalog:linear']);
    expect(
      container.querySelector('[data-testid="plugins-kind-chip-app"]'),
    ).toBeNull();
  });

  it('shows installed skills only in the Installed summary strip', async () => {
    await mountFullFixture();

    await click(
      container.querySelector('[data-testid="plugins-type-tab-skill"]'),
      'Skills type tab',
    );

    expect(installedTileIds()).toContain('skill:custom:app:review-checklist');
    expect(
      container.querySelector('[data-testid="plugins-section-installed"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Installed skills');
    expect(container.textContent).not.toContain(
      'Nothing here yet. Use Add custom to bring in your own.',
    );
  });

  it('opens ordinary skill details from the Installed section on Skills', async () => {
    await mountFullFixture();
    await click(
      container.querySelector('[data-testid="plugins-type-tab-skill"]'),
      'Skills tab',
    );
    expect(
      container.querySelector('[data-testid="plugins-installed-row"]'),
    ).toBeNull();
    await openEntry('skill:custom:app:review-checklist');
    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-installed"]',
      ),
    ).toBeNull();
  });

  it('renders without curated content when the catalog is empty', async () => {
    await mount({
      marketplaces: [
        makeMarketplace({
          pluginCount: MARKETPLACE_PLUGINS.length,
          plugins: MARKETPLACE_PLUGINS,
        }),
      ],
    });

    expect(
      container.querySelector('[data-testid="plugins-section-recommended"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-section-curated"]'),
    ).toBeNull();
    // Browse presents marketplace content as canonical category sections; the flat
    // "From your marketplaces" band belongs to search mode only.
    expect(
      container.querySelector('[data-testid="plugins-section-marketplace"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
    ).not.toBeNull();
    expect(entryIds()).toEqual(['mkt:mkt-1/alpha-tool', 'mkt:mkt-1/zeta-tool']);
  });

  // -------------------------------------------------------------------------
  // Browse mode
  // -------------------------------------------------------------------------

  function makeReferencePlugins(
    rows: ReadonlyArray<readonly [string, string, string]>,
  ): PluginInfo[] {
    return rows.map(([name, displayName, category]) =>
      makePlugin({
        name,
        displayName,
        category,
        description: `${displayName} plugin description`,
        author: 'OpenAI',
        homepage: `https://example.com/${name}`,
        marketplaceId: 'openai-curated',
      }),
    );
  }

  function makeOpenAiCuratedMarketplace(
    plugins: PluginInfo[],
  ): MarketplaceInfo {
    return makeMarketplace({
      id: 'openai-curated',
      name: 'Codex official',
      pluginCount: plugins.length,
      plugins,
    });
  }

  const ROLE_REFERENCE_PLUGINS = [
    ['gmail', 'Gmail', 'Communication'],
    ['slack', 'Slack', 'Communication'],
    ['bigquery', 'BigQuery', 'Data'],
    ['snowflake', 'Snowflake', 'Data'],
    ['vercel', 'Vercel', 'Developer Tools'],
    ['figma', 'Figma', 'Creativity'],
    ['miro', 'Miro', 'Productivity'],
    ['canva', 'Canva', 'Creativity'],
    ['hubspot', 'HubSpot', 'Business & Operations'],
    ['stripe', 'Stripe', 'Business & Operations'],
  ] as const;

  /** Saved roles returned by `loadPreferences`, and a sync broadcaster. */
  function mockSavedRoles(roles: string[] | undefined): {
    setRoles: (next: string[] | undefined) => void;
    broadcast: () => Promise<void>;
  } {
    let current = roles;
    const listeners: Array<(prefs: unknown) => void> = [];
    defineWindowApi('api', {
      loadPreferences: jest.fn(() =>
        Promise.resolve({
          mcpHttpAuthDefaultHandler: 'canopy',
          ...(current ? { profileRoles: current } : {}),
        }),
      ),
      onPreferencesSynced: jest.fn((listener: (prefs: unknown) => void) => {
        listeners.push(listener);
        return (): void => undefined;
      }),
    });
    return {
      setRoles: (next): void => {
        current = next;
      },
      broadcast: async (): Promise<void> => {
        act(() => {
          for (const listener of listeners) listener({});
        });
        await settle();
      },
    };
  }

  function suggestedEntryIds(): string[] {
    const suggested = container.querySelector(
      '[data-testid="plugins-section-suggested"]',
    );
    return suggested ? entryTestIdsWithin(suggested) : [];
  }

  it('withholds Suggested until the saved roles are known', async () => {
    const preferences = createDeferred<{
      mcpHttpAuthDefaultHandler: 'canopy';
      profileRoles: ['designer'];
    }>();
    defineWindowApi('api', {
      loadPreferences: jest.fn(() => preferences.promise),
      onPreferencesSynced: jest.fn(() => (): void => undefined),
    });

    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(
          makeReferencePlugins(ROLE_REFERENCE_PLUGINS),
        ),
      ],
    });

    expect(
      container.querySelector('[data-testid="plugins-section-suggested"]'),
    ).toBeNull();

    preferences.resolve({
      mcpHttpAuthDefaultHandler: 'canopy',
      profileRoles: ['designer'],
    });
    await settle();

    expect(suggestedEntryIds()).toEqual([
      'plugins-entry-mkt:openai-curated/figma',
      'plugins-entry-mkt:openai-curated/miro',
      'plugins-entry-mkt:openai-curated/canva',
    ]);
  });

  it('fills Suggested from the default role picks when no role is saved', async () => {
    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(
          makeReferencePlugins(ROLE_REFERENCE_PLUGINS),
        ),
      ],
    });

    const suggested = requireElement(
      container.querySelector('[data-testid="plugins-section-suggested"]'),
      'Suggested section',
    );
    expect(
      suggested.querySelector(
        '[data-testid="plugins-section-heading-suggested"]',
      )?.textContent,
    ).toBe('Suggested');
    expect(container.textContent).not.toContain('Featured');
    // The same software-engineer fallback Getting Started uses; universal
    // Gmail/Slack picks stay in their categories.
    expect(entryTestIdsWithin(suggested)).toEqual([
      'plugins-entry-mkt:openai-curated/bigquery',
      'plugins-entry-mkt:openai-curated/snowflake',
      'plugins-entry-mkt:openai-curated/vercel',
    ]);
    expect(
      suggested.querySelector('[data-testid="plugins-section-more-suggested"]'),
    ).toBeNull();
    const body = sectionBody('suggested');
    expect(body.className).toContain('grid-cols-1');
    expect(body.className).toContain('md:grid-cols-2');

    await openEntry('mkt:openai-curated/bigquery');
    expect(
      document.querySelector('[data-testid="plugin-catalog-detail"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('BigQuery plugin description');
    // BigQuery has no entry in the official product table, so the author the
    // fixture declares stands; only listed products are re-credited.
    expect(document.body.textContent).toContain('By OpenAI');
    expect(
      document.querySelector('[data-testid="mock-plugin-detail-view"]'),
    ).toBeNull();
    await click(
      document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"]',
      ),
      'plugin detail Add button',
    );
    expect(requirePluginDetailViewProps().plugin.name).toBe('bigquery');
    act(() => {
      requirePluginDetailViewProps().onBack();
    });
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-root"]',
      ),
      'Customize breadcrumb',
    );
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-add-mkt:openai-curated/snowflake"]',
      ),
      'suggested Snowflake Add button',
    );
    expect(
      document.querySelector('[data-testid="plugin-catalog-detail"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="mock-plugin-detail-view"]'),
    ).not.toBeNull();
  });

  it('does not let an installed MCP app hide a same-named suggested plugin', async () => {
    mockSavedRoles(['designer']);
    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(
          makeReferencePlugins([['figma', 'Figma', 'Creativity']]),
        ),
      ],
      mcpServers: [
        makeMcpServer({
          id: 'srv-figma',
          name: 'Figma',
          curatedKey: 'figma',
        }),
      ],
      mcpStatuses: [makeMcpStatus({ serverId: 'srv-figma' })],
      curatedMcpServers: [makeCuratedMcp({ key: 'figma', name: 'Figma' })],
    });

    expect(suggestedEntryIds()).toEqual([
      'plugins-entry-mkt:openai-curated/figma',
    ]);
    expect(installedTileIds()).toContain('mcp-catalog:figma');
  });

  it('follows the saved role, leaves installed picks to Installed, and updates on role change', async () => {
    const roles = mockSavedRoles(['designer']);
    const initialRolePlugins = ROLE_REFERENCE_PLUGINS.filter(
      ([name]) => name !== 'hubspot' && name !== 'stripe',
    );
    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(makeReferencePlugins(initialRolePlugins)),
        // Figma is installed through another source, so its addable
        // openai-curated duplicate must not be suggested again.
        makeCuratedMarketplace([
          makePlugin({
            name: 'figma',
            displayName: 'Figma',
            category: 'design',
            marketplaceId: 'curated/cloud',
            curated: true,
            providerSupport: { claude: 'native', codex: 'native' },
            globalInstallStatus: {
              claude: { available: true, installed: true },
              checkedAt: '2026-05-01T00:00:00.000Z',
            },
          }),
        ]),
      ],
    });

    expect(suggestedEntryIds()).toEqual([
      'plugins-entry-mkt:openai-curated/miro',
      'plugins-entry-mkt:openai-curated/canva',
    ]);
    expect(installedTileIds()).toContain('curated:figma');

    pluginsApi.loadMarketplaces.mockResolvedValue(
      okResult(
        makeCache([
          makeOpenAiCuratedMarketplace(
            makeReferencePlugins(ROLE_REFERENCE_PLUGINS),
          ),
        ]),
      ),
    );
    roles.setRoles(['founder']);
    await roles.broadcast();
    expect(pluginsApi.loadMarketplaces).toHaveBeenCalledTimes(2);
    expect(suggestedEntryIds()).toEqual([
      'plugins-entry-mkt:openai-curated/hubspot',
      'plugins-entry-mkt:openai-curated/stripe',
    ]);
  });

  it('falls back to the default picks when none of the saved role picks are in the catalog', async () => {
    mockSavedRoles(['support']);
    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(
          makeReferencePlugins(ROLE_REFERENCE_PLUGINS),
        ),
      ],
    });

    expect(suggestedEntryIds()).toEqual([
      'plugins-entry-mkt:openai-curated/bigquery',
      'plugins-entry-mkt:openai-curated/snowflake',
      'plugins-entry-mkt:openai-curated/vercel',
    ]);
  });

  it('empties Suggested once every role pick is installed instead of refilling it', async () => {
    mockSavedRoles(['founder']);
    const installed = (name: string, displayName: string): PluginInfo =>
      makePlugin({
        name,
        displayName,
        marketplaceId: 'curated/cloud',
        curated: true,
        providerSupport: { claude: 'native', codex: 'native' },
        globalInstallStatus: {
          claude: { available: true, installed: true },
          checkedAt: '2026-05-01T00:00:00.000Z',
        },
      });
    await mount({
      marketplaces: [
        makeOpenAiCuratedMarketplace(
          makeReferencePlugins(ROLE_REFERENCE_PLUGINS),
        ),
        makeCuratedMarketplace([
          installed('hubspot', 'HubSpot'),
          installed('stripe', 'Stripe'),
        ]),
      ],
    });

    expect(
      container.querySelector('[data-testid="plugins-section-suggested"]'),
    ).toBeNull();
  });

  it('omits Suggested when no role pick is in the catalog', async () => {
    await mountFullFixture();

    expect(
      container.querySelector('[data-testid="plugins-section-suggested"]'),
    ).toBeNull();

    const developerTools = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-developer-tools"]',
      ),
      'Developer tools section',
    );
    expect(
      developerTools.querySelector(
        '[data-testid="plugins-section-heading-category-developer-tools"]',
      )?.textContent,
    ).toBe('Developer tools');
    expect(entryTestIdsWithin(developerTools)).toEqual([
      'plugins-entry-mcp-catalog:github',
    ]);

    const productivity = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-productivity"]',
      ),
      'Productivity section',
    );
    expect(entryTestIdsWithin(productivity)).toEqual([
      'plugins-entry-mcp-catalog:linear',
    ]);

    const analytics = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-data-analytics"]',
      ),
      'Data and Analytics section',
    );
    expect(entryTestIdsWithin(analytics)).toEqual([
      'plugins-entry-curated:data-cruncher',
    ]);

    // Unknown source categories consistently fall back to Other.
    const other = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Other category section',
    );
    expect(other.querySelector('h2')?.textContent).toBe('Other');
    // A recommended entry that is not a role pick stays in its category.
    expect(entryTestIdsWithin(other)).toEqual([
      'plugins-entry-curated:installed-helper',
      'plugins-entry-curated:writer-toolkit',
      'plugins-entry-mkt:mkt-1/alpha-tool',
      'plugins-entry-mkt:mkt-1/zeta-tool',
    ]);

    // Browse mode never renders installed/app/flat-marketplace bands.
    expect(
      container.querySelector('[data-testid="plugins-section-installed"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-section-apps"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-section-marketplace"]'),
    ).toBeNull();
  });

  it('opens a dedicated searchable category page from its heading', async () => {
    const curated = Array.from({ length: 13 }, (_unused, index) =>
      makePlugin({
        name: `curated-tool-${index}`,
        displayName: `Curated Tool ${index}`,
        marketplaceId: 'curated/cloud',
        curated: true,
      }),
    );
    await mount({
      marketplaces: [makeCuratedMarketplace(curated)],
    });

    const section = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Other section',
    );
    expect(entryTestIdsWithin(section)).toHaveLength(10);

    const categoryHeading = requireElement(
      section.querySelector(
        '[data-testid="plugins-section-heading-category-other"]',
      ),
      'Other category heading',
    );
    expect(categoryHeading.textContent).toBe('Other');
    expect(categoryHeading.getAttribute('aria-label')).toBe('Browse Other');

    await click(categoryHeading, 'Other category heading');

    const categoryPage = requireElement(
      container.querySelector('[data-testid="plugins-category-page"]'),
      'Other category page',
    );
    const categoryTitlebar = requireElement(
      container.querySelector('[data-testid="plugins-category-titlebar"]'),
      'Category titlebar',
    );
    // 9px top inset (the sidebar controls' line) with the same clearance
    // below, inside the 46px pinned bar.
    expect(categoryTitlebar.classList).toContain('pt-2.25');
    expect(categoryTitlebar.classList).toContain('items-start');
    const breadcrumbs = requireElement(
      categoryTitlebar.querySelector(
        '[data-testid="plugins-category-breadcrumbs"]',
      ),
      'Category breadcrumbs',
    );
    expect(breadcrumbs.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(breadcrumbs.classList).toContain('h-7');
    const categoryRoot = requireElement(
      breadcrumbs.querySelector(
        '[data-testid="plugins-category-breadcrumb-root"]',
      ),
      'Customize breadcrumb',
    );
    for (const className of `${TITLEBAR_BUTTON_CLASSNAME} whitespace-nowrap text-s font-normal`.split(
      ' ',
    )) {
      expect(categoryRoot.classList).toContain(className);
    }
    // The category page leads back to the page the sidebar calls Customize.
    expect(categoryRoot.textContent).toBe('Customize');
    expect(categoryRoot.classList).toContain('hover:bg-subtle');
    const categoryCurrent = requireElement(
      breadcrumbs.querySelector(
        '[data-testid="plugins-category-breadcrumb-current"]',
      ),
      'Current category breadcrumb',
    );
    expect(categoryCurrent.textContent).toBe('Other');
    expect(categoryCurrent.getAttribute('aria-current')).toBe('page');
    expect(
      categoryPage.querySelector(
        '[data-testid="plugins-category-breadcrumbs"]',
      ),
    ).toBeNull();
    expect(categoryPage.querySelector('h1')?.textContent).toBe('Other');
    expect(entryTestIdsWithin(categoryPage)).toHaveLength(13);
    expect(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
    ).toBeNull();

    await openEntry('curated:curated-tool-0');
    const detailBreadcrumbs = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumbs"]',
      ),
      'Entry detail breadcrumbs',
    );
    expect(detailBreadcrumbs.textContent).toContain('Customize');
    expect(detailBreadcrumbs.textContent).toContain('Other');
    expect(detailBreadcrumbs.textContent).toContain('Curated Tool 0');
    await click(
      detailBreadcrumbs.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-category"]',
      ),
      'Other detail breadcrumb',
    );
    expect(
      container.querySelector('[data-testid="plugins-category-page"]'),
    ).not.toBeNull();

    const categorySearch = requireElement<HTMLInputElement>(
      categoryPage.querySelector('[data-testid="plugins-category-search"]'),
      'Category search',
    );
    expect(categorySearch.parentElement?.className).toContain('-ml-4');
    expect(categorySearch.placeholder).toBe('Search…');
    act(() => setInputValue(categorySearch, 'Tool 8'));
    await settle();
    expect(entryTestIdsWithin(categoryPage)).toEqual([
      'plugins-entry-curated:curated-tool-8',
    ]);

    // Returning from the detail remounts the category titlebar.
    await click(
      container.querySelector(
        '[data-testid="plugins-category-breadcrumb-root"]',
      ),
      'Plugins breadcrumb',
    );
    const restoredSection = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Restored Other section',
    );
    expect(entryTestIdsWithin(restoredSection)).toHaveLength(10);
  });

  /**
   * Browse fixture of marketplace plugins, `categoryFor` deciding how they
   * spread across browse's category sections.
   */
  async function mountSampler(
    count: number,
    categoryFor: (index: number) => string = () => 'utilities',
  ): Promise<void> {
    const many: PluginInfo[] = Array.from({ length: count }, (_unused, index) =>
      makePlugin({
        name: `tool-${String(index).padStart(2, '0')}`,
        displayName: `Tool ${String(index).padStart(2, '0')}`,
        description: 'A sampler plugin.',
        category: categoryFor(index),
      }),
    );
    await mount({
      marketplaces: [
        makeMarketplace({ pluginCount: many.length, plugins: many }),
      ],
    });
  }

  function sectionBody(sectionId: string): HTMLElement {
    return requireElement(
      container.querySelector(
        `[data-testid="plugins-section-body-${sectionId}"]`,
      ),
      `Body of section ${sectionId}`,
    );
  }

  it('renders every section body as a responsive card grid capped at two columns', async () => {
    await mountFullFixture();

    for (const sectionId of ['category-data-analytics', 'category-other']) {
      const body = sectionBody(sectionId);
      expect(body.className).toContain('grid-cols-1');
      expect(body.className).toContain('md:grid-cols-2');
      expect(body.className).not.toContain('lg:grid-cols-3');
      expect(body.className).toContain('gap-y-2');
      expect(body.className).not.toContain('gap-y-1');
    }
  });

  it('gives each card a circular icon tile', async () => {
    await mountFullFixture();

    const card = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-curated:writer-toolkit"]',
      ),
      'Writer Toolkit card',
    );
    // The tile is the card's leading element; the trailing "Recommended"
    // badge remains its own pill.
    const tile = requireElement(card.firstElementChild, 'Card icon tile');
    expect(tile.className).toContain('rounded-full');
    expect(tile.className).not.toContain('rounded-xl');
    expect(card.className).toContain('py-3');
    expect(card.className).not.toContain('py-2');
  });

  it('caps a browse category section and makes its headline clickable', async () => {
    await mountSampler(13);

    const other = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Other category section',
    );
    expect(entryTestIdsWithin(other)).toHaveLength(10);
    const heading = requireButton(
      container.querySelector(
        '[data-testid="plugins-section-heading-category-other"]',
      ),
      'Other category heading',
    );
    expect(heading.textContent).toBe('Other');
    expect(heading.getAttribute('aria-label')).toBe('Browse Other');
    expect(
      container.querySelector(
        '[data-testid="plugins-section-more-category-other"]',
      ),
    ).toBeNull();
    expect(other.textContent).not.toContain('Search to see more');
  });

  it('opens installed settings directly from the gear', async () => {
    await mountFullFixture();
    await openInstalledSettings();

    const managementView = requireElement(
      container.querySelector('[data-testid="plugins-management-view"]'),
      'Management view',
    );
    const installedSection = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
      'Installed management section',
    );
    const installedHeading = requireElement(
      installedSection.querySelector('h1'),
      'Installed management heading',
    );
    expect(installedHeading.textContent).toBe('Installed plugins');
    expect(installedHeading.className).toContain('text-xl');
    expect(installedSection.className).toContain('max-w-6xl');
    expect(installedSection.closest('.page-scroll-gutter')).not.toBeNull();
    expect(managementView.getAttribute('data-open')).toBe('true');
    expect(
      container.querySelector('[data-testid="plugins-installed-gear-surface"]'),
    ).toBeNull();

    const sidebar = requireElement(
      container.querySelector('[data-testid="plugins-management-sidebar"]'),
      'Plugin management sidebar',
    );
    expect(sidebar.className).toContain('app-sidebar-material');
    expect(sidebar.className).toContain('sidebar-resizable-surface');
    expect(sidebar.className).toContain('sidebar-instant-interactions');
    expect(
      container.querySelector('[data-testid="plugins-management-back"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-management-sidebar-resize-handle"]',
      ),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="plugins-management-nav-installed"]')
        ?.hasAttribute('data-sidebar-nav-row'),
    ).toBe(true);
    for (const section of [
      'installed',
      'skills',
      'mcp',
      'collections',
      'marketplaces',
    ]) {
      const icon = container
        .querySelector(`[data-testid="plugins-management-nav-${section}"]`)
        ?.querySelector('svg');
      expect(icon?.getAttribute('data-app-icon')).toBe('true');
      expect(icon?.getAttribute('width')).toBe('14px');
      expect(icon?.getAttribute('height')).toBe('14px');
    }
    expect(
      container.querySelector('[data-testid="plugins-management-close"]'),
    ).toBeNull();
  });

  it('keeps the capped browse preview when returning from a category page', async () => {
    await mountSampler(13);

    await click(
      container.querySelector(
        '[data-testid="plugins-section-heading-category-other"]',
      ),
      'Other category heading',
    );

    expect(
      container.querySelector('[data-testid="plugins-category-page"]'),
    ).not.toBeNull();

    await click(
      container.querySelector(
        '[data-testid="plugins-category-breadcrumb-root"]',
      ),
      'Customize breadcrumb',
    );

    const other = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Other category section',
    );
    expect(entryTestIdsWithin(other)).toHaveLength(10);
    expect(
      other.querySelector(
        '[data-testid="plugins-section-heading-category-other"]',
      ),
    ).not.toBeNull();
  });

  it('browses marketplace content as category sections, each entry in exactly one', async () => {
    await mountSampler(8, (index) =>
      index < 3 ? 'Productivity' : 'developer tools',
    );

    const productivity = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-productivity"]',
      ),
      'Productivity category section',
    );
    expect(productivity.textContent).toContain('Productivity');
    expect(entryTestIdsWithin(productivity)).toEqual([
      'plugins-entry-mkt:mkt-1/tool-00',
      'plugins-entry-mkt:mkt-1/tool-01',
      'plugins-entry-mkt:mkt-1/tool-02',
    ]);

    const developerTools = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-developer-tools"]',
      ),
      'Developer tools category section',
    );
    expect(
      developerTools.querySelector(
        '[data-testid="plugins-section-heading-category-developer-tools"]',
      )?.textContent,
    ).toBe('Developer tools');
    expect(entryTestIdsWithin(developerTools)).toEqual([
      'plugins-entry-mkt:mkt-1/tool-03',
      'plugins-entry-mkt:mkt-1/tool-04',
      'plugins-entry-mkt:mkt-1/tool-05',
      'plugins-entry-mkt:mkt-1/tool-06',
      'plugins-entry-mkt:mkt-1/tool-07',
    ]);

    // No entry — and so no `plugins-entry-*` testid — is on the page twice.
    const ids = entryIds();
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);

    // Category sections are a browse-only affordance.
    await typeQuery('tool');
    expect(
      container.querySelector('[data-testid^="plugins-section-category-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="customize-sections"]'),
    ).not.toBeNull();
  });

  it('keys category sections by slug so casing variants merge into one section', async () => {
    // `Developer Tools` and `developer-tools` slug identically; keying groups
    // by lowercase name instead would emit two sections with the same testid
    // and the same React key.
    await mountSampler(4, (index) =>
      index % 2 === 0 ? 'Developer Tools' : 'developer-tools',
    );

    expect(
      container.querySelectorAll(
        '[data-testid="plugins-section-category-developer-tools"]',
      ),
    ).toHaveLength(1);
    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-category-developer-tools"]',
      ),
      'Developer tools category section',
    );
    expect(entryTestIdsWithin(section)).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Search mode
  // -------------------------------------------------------------------------

  it('search filters Installed and Browse while preserving their headings', async () => {
    await mountFullFixture();
    await typeQuery('github');
    expect(
      container.querySelector('[data-testid="customize-section-installed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="customize-section-browse"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-installed-strip"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-section-plugins-and-mcp"]',
      ),
    ).not.toBeNull();
  });

  it('includes curated apps in the flat search results', async () => {
    await mountFullFixture();
    await typeQuery('linear');

    expect(
      container.querySelector('[data-testid="customize-sections"]'),
    ).not.toBeNull();
    expect(entryIds()).toEqual(['mcp-catalog:linear']);
  });

  it('renders a large search band in the page flow', async () => {
    const many: PluginInfo[] = Array.from({ length: 150 }, (_unused, index) =>
      makePlugin({
        name: `search-tool-${String(index).padStart(3, '0')}`,
        displayName: `Search Tool ${String(index).padStart(3, '0')}`,
        description: 'A large-section sampler plugin.',
        category: 'utilities',
      }),
    );
    await mount({
      marketplaces: [
        makeMarketplace({ pluginCount: many.length, plugins: many }),
      ],
    });
    await typeQuery('search tool');

    const searchResults = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-plugins-and-mcp"]',
      ),
      'Search results',
    );
    expect(searchResults.getAttribute('data-row-count')).toBe('150');
    expect(searchResults.getAttribute('data-virtualized')).toBe('false');
    expect(entryTestIdsWithin(searchResults)).toHaveLength(150);
  });

  it('renders every row without windowing below the threshold', async () => {
    await mountFullFixture();

    const other = requireElement(
      container.querySelector('[data-testid="plugins-section-category-other"]'),
      'Other category section',
    );
    expect(other.getAttribute('data-virtualized')).toBe('false');
    expect(other.getAttribute('data-row-count')).toBe('4');
  });

  it('keeps the complete flat search list in the page flow', async () => {
    // 60 + 60 clears the former windowing threshold. The unified list must
    // remain part of the page's single scrolling flow.
    const curated = Array.from({ length: 60 }, (_unused, index) =>
      makePlugin({
        name: `curated-tool-${index}`,
        displayName: `Curated Tool ${index}`,
        marketplaceId: 'curated/cloud',
        curated: true,
      }),
    );
    const marketplace = Array.from({ length: 60 }, (_unused, index) =>
      makePlugin({
        name: `marketplace-tool-${index}`,
        displayName: `Marketplace Tool ${index}`,
      }),
    );
    await mount({
      marketplaces: [
        makeCuratedMarketplace(curated),
        makeMarketplace({
          pluginCount: marketplace.length,
          plugins: marketplace,
        }),
      ],
    });
    await typeQuery('tool');

    const searchResults = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-plugins-and-mcp"]',
      ),
      'Search results',
    );
    expect(searchResults.getAttribute('data-virtualized')).toBe('false');
    expect(searchResults.getAttribute('data-row-count')).toBe('120');
  });

  it('keeps browse category sections unwindowed past a page-wide 100 rows', async () => {
    // 120 marketplace plugins spread over 3 categories: well past the old
    // page-wide threshold, but every section is preview-capped at 10.
    await mountSampler(120, (index) =>
      index % 3 === 0
        ? 'utilities'
        : index % 3 === 1
          ? 'productivity'
          : 'developer tools',
    );

    const sections = container.querySelectorAll(
      '[data-testid^="plugins-section-category-"]',
    );
    expect(sections.length).toBe(3);
    sections.forEach((section) => {
      expect(section.getAttribute('data-virtualized')).toBe('false');
    });
  });

  it('does not create a nested scroller for a large search section', async () => {
    const many: PluginInfo[] = Array.from({ length: 150 }, (_unused, index) =>
      makePlugin({
        name: `search-tool-${String(index).padStart(3, '0')}`,
        displayName: `Search Tool ${String(index).padStart(3, '0')}`,
        category: 'utilities',
      }),
    );
    await mount({
      marketplaces: [
        makeMarketplace({ pluginCount: many.length, plugins: many }),
      ],
    });
    await typeQuery('search tool');

    const body = sectionBody('plugins-and-mcp');
    expect(body.className).not.toContain('overflow-auto');
    expect(body.className).toContain('grid');
  });

  it('resolves untrusted discovery logos through the safe remote-image bridge', async () => {
    const unsafeUrl = 'http://127.0.0.1:7777/private-logo.png';
    const safeUrl = 'data:image/png;base64,aGVsbG8=';
    mcpServersApi.resolveRemoteImage.mockResolvedValue(safeUrl);
    await mount({
      curatedMcpServers: [
        makeCuratedMcp({
          key: 'unsafe-logo-app',
          name: 'Unsafe Logo App',
          logoUrl: unsafeUrl,
        }),
      ],
    });
    await settle();

    expect(mcpServersApi.resolveRemoteImage).toHaveBeenCalledWith(unsafeUrl);
    expect(document.querySelector(`img[src="${unsafeUrl}"]`)).toBeNull();
    const productLogo = document.querySelector(`img[src="${safeUrl}"]`);
    expect(productLogo).not.toBeNull();
    expect(productLogo?.className).toContain(
      'ring-[length:var(--border-hairline)]',
    );
    expect(productLogo?.className).toContain('ring-line-secondary');
    expect(productLogo?.className).toContain('shadow-sm');
  });

  it('renders the product logo supplied by a marketplace plugin catalog', async () => {
    const catalogLogoUrl = 'https://cdn.example.test/air-ops-logo.png';
    const safeUrl = 'data:image/png;base64,aGVsbG8=';
    mcpServersApi.resolveRemoteImage.mockResolvedValue(safeUrl);
    await mount({
      marketplaces: [
        makeMarketplace({
          plugins: [
            makePlugin({
              name: 'air-ops',
              displayName: 'AirOps',
              logoUrl: catalogLogoUrl,
            }),
          ],
        }),
      ],
    });
    await settle();

    expect(mcpServersApi.resolveRemoteImage).toHaveBeenCalledWith(
      catalogLogoUrl,
    );
    expect(document.querySelector(`img[src="${safeUrl}"]`)).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="marketplace-product-logo-fallback-mkt:mkt-1/air-ops"]',
      ),
    ).toBeNull();
  });

  it('renders a safe product-site icon instead of a monogram when catalog artwork is missing', async () => {
    const fallbackUrl =
      'https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fwww.airops.com%2F&sz=128';
    const safeUrl = 'data:image/png;base64,YWlyb3Bz';
    mcpServersApi.resolveRemoteImage.mockResolvedValue(safeUrl);
    await mount({
      curatedMcpServers: [
        makeCuratedMcp({
          key: 'airops',
          name: 'AirOps',
          authorUrl: 'https://www.airops.com/',
          logoUrl: undefined,
        }),
      ],
    });
    await settle();

    expect(mcpServersApi.resolveRemoteImage).toHaveBeenCalledWith(fallbackUrl);
    expect(document.querySelector(`img[src="${safeUrl}"]`)).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="marketplace-product-logo-fallback-mcp-catalog:airops"]',
      ),
    ).toBeNull();
  });

  it('reports an empty-results message when nothing matches', async () => {
    await mountFullFixture();
    await typeQuery('nothing-matches-this-query');

    expect(entryIds()).toEqual([]);
    expect(container.textContent).toContain('Nothing matches your search.');
  });

  // -------------------------------------------------------------------------
  // Category chips
  // -------------------------------------------------------------------------

  it('does not render the category chip block', async () => {
    await mountFullFixture();

    expect(
      container.querySelector('[data-testid^="plugins-category-chip-"]'),
    ).toBeNull();
    expect(entryIds()).toContain('mkt:mkt-1/alpha-tool');
  });

  // -------------------------------------------------------------------------
  // Installed summary row
  // -------------------------------------------------------------------------

  it('renders a strip tile for every installed and needs-auth entry', async () => {
    await mountFullFixture();

    // installed: curated "Installed Helper" + the custom skill.
    // needs attention: the auth-required GitHub app (curated MCP merge).
    expect(installedTileIds()).toEqual([
      'curated:installed-helper',
      'mcp-catalog:github',
      'skill:custom:app:review-checklist',
    ]);
  });

  it('labels only installed rows that need attention', async () => {
    await mountFullFixture();
    const installed = container.querySelector(
      '[data-testid="customize-section-installed"]',
    );
    expect(
      installed?.querySelector(
        '[data-testid="customize-row-mcp-catalog:github"]',
      )?.textContent,
    ).toContain('Needs attention');
    expect(
      installed?.querySelector(
        '[data-testid="customize-row-curated:installed-helper"]',
      )?.textContent,
    ).not.toContain('Needs attention');
  });

  it('omits every badge when nothing needs attention', async () => {
    await mount({
      marketplaces: [makeCuratedMarketplace(CURATED_PLUGINS)],
      skills: [makeSkill()],
    });

    expect(installedTileIds()).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-testid^="plugins-installed-badge-"]'),
    ).toHaveLength(0);
  });

  it('hides the installed strip entirely when nothing is installed or needs attention', async () => {
    await mount({ marketplaces: [], skills: [], mcpServers: [] });

    expect(
      container.querySelector('[data-testid="plugins-installed-strip"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-installed-row"]'),
    ).toBeNull();
  });

  it('does not render a divider below the installed strip without category filters', async () => {
    await mountFullFixture();

    expect(
      container.querySelector('[data-testid="customize-section-installed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-category-chip-all"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-filters-divider"]'),
    ).toBeNull();
  });

  it('omits the rule when there is no installed strip above it', async () => {
    // Otherwise the rule floats directly under the search box, dividing
    // nothing from the filters.
    await mount({ marketplaces: [], skills: [], mcpServers: [] });

    expect(
      container.querySelector('[data-testid="plugins-installed-strip"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-filters-divider"]'),
    ).toBeNull();
  });

  it('omits the rule when there are no filters below it', async () => {
    // An installed skill puts the strip on screen, but skills carry no
    // categories, so there is nothing on the far side of the rule either.
    await mount({ marketplaces: [], skills: [makeSkill()], mcpServers: [] });

    expect(
      container.querySelector('[data-testid="customize-section-installed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-category-chip-all"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-filters-divider"]'),
    ).toBeNull();
  });

  it('keeps management reachable through its compatibility event only', async () => {
    await mountFullFixture();
    expect(
      container.querySelector('[data-testid="plugins-installed-row"]'),
    ).toBeNull();
    await openManagement();
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ view: 'management', managementSection: 'installed' });
  });

  it('reports search activity and result counts without the query text', async () => {
    await mountFullFixture();
    await typeQuery('zeta');

    const slice = useCurrentUiStateStore.getState().slices['plugins.page'];
    expect(slice).toMatchObject({
      view: 'discovery',
      searchActive: true,
      resultCount: 2,
    });
    expect(JSON.stringify(slice)).not.toContain('zeta');
  });

  it('reports all distinct matching entries before previews', async () => {
    // 13 uncategorized entries, capped at 10: the advisor should hear about what the user
    // can actually see, and never count one entry twice.
    await mountSampler(13);

    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ resultCount: 13 });

    await click(
      container.querySelector(
        '[data-testid="plugins-section-heading-category-other"]',
      ),
      'Other category heading',
    );

    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ resultCount: 13 });
  });

  // -------------------------------------------------------------------------
  // Add-custom dropdown → existing dialogs
  // -------------------------------------------------------------------------

  it('opens the existing Add marketplace dialog from the dropdown', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    expect(
      document.querySelector('[data-testid="plugins-add-custom-marketplace"]')
        ?.textContent,
    ).toBe('Add marketplace…');
    await clickMenuItem('plugins-add-custom-marketplace');

    expect(
      document.querySelector('[aria-labelledby="add-marketplace-modal-title"]'),
    ).not.toBeNull();
  });

  it('opens the existing MCP server create dialog from the dropdown', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-mcp');

    expect(
      document.querySelector('[aria-labelledby="mcp-server-dialog-title"]'),
    ).not.toBeNull();
    expect(mcpServersApi.loadServer).not.toHaveBeenCalled();
  });

  it('opens the existing GitHub skills install dialog from the dropdown', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-skills-github');

    expect(
      document.querySelector('[aria-labelledby="add-skills-modal-title"]'),
    ).not.toBeNull();
  });

  it('opens the collection editor in create mode from the dropdown', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-collection');

    expect(
      document.querySelector('[aria-labelledby="collection-modal-title"]'),
    ).not.toBeNull();
  });

  it('closes the collection editor when internal navigation leaves discovery', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-collection');
    expect(
      document.querySelector('[aria-labelledby="collection-modal-title"]'),
    ).not.toBeNull();

    // A deep link into management (App Advisor, Cmd+K) keeps the page
    // mounted, so the editor has to be closed like every other page-owned
    // dialog, or its overlay stays over the management view.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canopy:plugins-open-management', {
          detail: { section: 'installed' },
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(
      document.querySelector('[aria-labelledby="collection-modal-title"]'),
    ).toBeNull();
  });

  it('reports the collection editor state to App Advisor', async () => {
    await mountFullFixture();
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ createCollectionOpen: false });

    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-collection');
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ createCollectionOpen: true });

    await click(
      document.querySelector('[data-testid="mock-collection-modal-close"]'),
      'Collection editor close',
    );
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ createCollectionOpen: false });
  });

  it('opens the existing custom skill dialog from the dropdown', async () => {
    await mountFullFixture();
    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-skill-custom');

    expect(
      document.querySelector('[aria-labelledby="create-skill-modal-title"]'),
    ).not.toBeNull();
  });

  it('adds a marketplace through the dropdown dialog without a full refresh', async () => {
    await mount({ marketplaces: [] });
    const added = makeMarketplace({
      id: 'new/plugins',
      name: 'New Plugins',
      sourceUrl: 'new/plugins',
      pluginCount: 1,
      plugins: [
        makePlugin({
          name: 'new-tool',
          displayName: 'New Tool',
          description: 'Freshly added.',
          marketplaceId: 'new/plugins',
        }),
      ],
    });
    pluginsApi.addMarketplace.mockResolvedValue(
      okResult({ marketplace: added, providerOutcomes: added.providerStatus }),
    );

    await openAddCustomMenu();
    await clickMenuItem('plugins-add-custom-marketplace');

    const input = document.querySelector(
      'input[placeholder="owner/repo or https://github.com/owner/repo"]',
    );
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Customize repo input not found');
    }
    await act(async () => {
      setInputValue(input, 'new/plugins');
      await Promise.resolve();
    });

    const confirmButton = requireButton(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Add',
      ) ?? null,
      'Confirm add button',
    );
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(pluginsApi.addMarketplace).toHaveBeenCalledWith('new/plugins');
    expect(pluginsApi.refreshMarketplaces).not.toHaveBeenCalled();
    expect(entryIds()).toContain('mkt:new/plugins/new-tool');
  });

  // -------------------------------------------------------------------------
  // Entry rows
  // -------------------------------------------------------------------------

  it('opens pipeline details before preserving the editor round trip on CTA', async () => {
    const pipeline: PipelineInfo = {
      id: 'shared:canopy-cloud:review-pipeline',
      name: 'Review Pipeline',
      filename: '',
      description: 'Review a change before release.',
      icon: '',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      source: 'shared',
      readonly: false,
      serverId: 'canopy-cloud',
      remoteId: 'review-pipeline',
      triggerTypes: ['dispatch', 'plan_ready'],
      scopes: ['directory', 'worktree'],
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
    };
    mockCapabilityMarketplaceInventory.pipelines = [pipeline];
    useNavigationStore.setState({ activePage: 'plugins' });

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-add-pipeline:shared:shared:canopy-cloud:review-pipeline"]',
      ),
      'Review Pipeline Add button',
    );

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'plugins',
    });
    expect(
      document.querySelector('[data-testid="pipeline-catalog-detail"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Review Pipeline');
    expect(container.textContent).toContain('Review a change before release.');
    expect(container.textContent).toContain('Shared');
    expect(container.textContent).toContain('Canopy');
    expect(container.textContent).toContain('Organization');
    expect(container.textContent).toContain('Dispatch');
    expect(container.textContent).toContain('Plan ready');
    expect(container.textContent).toContain('Directory');
    expect(container.textContent).toContain('Worktree');
    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();

    await click(
      container.querySelector('[data-testid="pipeline-catalog-open-editor"]'),
      'Open in editor button',
    );

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'workflows-library',
      workflowEdit: {
        kind: 'pipeline',
        pipelineId: 'shared:canopy-cloud:review-pipeline',
        sharedRemoteId: 'review-pipeline',
        returnToMarketplace: { query: '', tab: 'all' },
        // The Plugins page unmounts while the editor is open; the editor's
        // Back replays this browse state through the entry-context intent.
        returnToEntryContext: {
          entryId: 'pipeline:shared:shared:canopy-cloud:review-pipeline',
          marketplace: { query: '', tab: 'all' },
        },
      },
    });
  });

  it('opens the install review from a shared card Add without visiting the detail', async () => {
    const skill: SharedSkillSummary = {
      id: 'review-skill',
      name: 'Review Skill',
      description: 'Review a change before release.',
      contentHash: 'review-skill-hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
      createdBy: { id: 'author', name: 'Author', email: null },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      publicShare: null,
    };
    mockCapabilityMarketplaceInventory.sharedSkills = [skill];
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingShareInstall: undefined,
    });

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-add-skill:shared:review-skill"]',
      ),
      'Review Skill Add button',
    );

    expect(entryDetail()).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: {
        entity: 'skill',
        externalId: 'review-skill',
        intent: 'install',
        audience: 'ORGANIZATION',
      },
      origin: 'in-app',
    });
    act(() => {
      useNavigationStore.getState().consumeShareInstall();
    });
  });

  it('renders an available shared skill as a Marketplace detail sub-page', async () => {
    const refresh = createDeferred<void>();
    mockCapabilityMarketplaceInventory.refreshSharedSkills = jest.fn(
      () => refresh.promise,
    );
    const skill: SharedSkillSummary = {
      id: 'review-skill',
      name: 'Review Skill',
      description: 'Review a change before release.',
      contentHash: 'review-skill-hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
      createdBy: { id: 'author', name: 'Author', email: null },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      publicShare: null,
    };
    mockCapabilityMarketplaceInventory.sharedSkills = [skill];
    useNavigationStore.setState({ activePage: 'plugins' });

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-skill:shared:review-skill"]',
      ),
      'Review Skill card',
    );

    expect(entryDetail()?.getAttribute('data-presentation')).toBe('page');
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Review Skill');

    expect(mockSharedDetailMounts.skill).toBe(1);
    await click(
      container.querySelector('[data-testid="mock-shared-skill-edit"]'),
      'Shared skill edit button',
    );
    await click(
      container.querySelector('[data-testid="mock-shared-skill-update-edit"]'),
      'Shared skill save callback',
    );

    expect(
      mockCapabilityMarketplaceInventory.refreshSharedSkills,
    ).toHaveBeenCalledTimes(1);
    expect(entryDetail()).not.toBeNull();
    expect(entryDetail()?.getAttribute('data-content-hash')).toBe(
      'updated-skill-hash',
    );

    mockCapabilityMarketplaceInventory.sharedSkills = [];
    await renderPage();
    expect(entryDetail()).not.toBeNull();
    // The retained entry's breadcrumb follows the rename even though the
    // refreshed server-filtered inventory no longer returns the row.
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Review Skill Renamed');

    refresh.resolve();
    await settle();
    expect(entryDetail()?.getAttribute('data-content-hash')).toBe(
      'updated-skill-hash',
    );
  });

  it('closes a shared detail and drops retention when the Cloud account changes', async () => {
    const skill: SharedSkillSummary = {
      id: 'review-skill',
      name: 'Review Skill',
      description: 'Review a change before release.',
      contentHash: 'review-skill-hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
      createdBy: { id: 'author', name: 'Author', email: null },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      publicShare: null,
    };
    mockCapabilityMarketplaceInventory.sharedSkills = [skill];
    useNavigationStore.setState({ activePage: 'plugins' });

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-skill:shared:review-skill"]',
      ),
      'Review Skill card',
    );
    expect(entryDetail()).not.toBeNull();

    // Sign-out/account switch: the shared rows are no longer this account's.
    mockCapabilityMarketplaceInventory.sharedSkills = [];
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });
    await renderPage();
    expect(entryDetail()).toBeNull();
  });

  describe('automations', () => {
    const HASH = 'a'.repeat(64);

    function localAutomation(
      overrides: Partial<UnifiedLocalAutomationInput> = {},
    ): UnifiedLocalAutomationInput {
      return {
        id: 'standup',
        name: 'Morning standup',
        description: 'Scheduled · App Advisor prompt: Summarize yesterday',
        ...overrides,
      };
    }

    function automationActivity(id: string): ScheduledActivity {
      return {
        version: 1,
        id,
        name: 'Morning standup',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Summarize yesterday' },
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        failureCount: 0,
      };
    }

    function sharedAutomation(
      overrides: Partial<SharedAutomationSummary> = {},
    ): SharedAutomationSummary {
      return {
        id: 'triage',
        name: 'Triage inbox',
        description: 'Sorts new issues every morning.',
        triggerKind: 'cron',
        actionType: 'app_advisor_prompt',
        contentHash: HASH,
        shareScope: 'organization',
        owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
        createdBy: { id: 'author', name: 'Author', email: null },
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        canUpdate: false,
        canDelete: false,
        ...overrides,
      };
    }

    function curatedAutomation(
      overrides: Partial<CuratedAutomationSummary> = {},
    ): CuratedAutomationSummary {
      return {
        key: 'daily-review',
        name: 'Daily review',
        shortDescription: 'Reviews open pull requests each weekday.',
        icon: '',
        triggerKind: 'cron',
        cronExpression: '0 9 * * 1-5',
        actionType: 'app_advisor_prompt',
        pipelineSource: null,
        referencedCuratedPipelineKey: null,
        pluginCount: 0,
        contentHash: HASH,
        contentSizeBytes: 64,
        categories: [],
        popular: false,
        sortOrder: 0,
        revision: 1,
        authorName: null,
        authorUrl: null,
        docsUrl: null,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
        ...overrides,
      };
    }

    async function selectAutomationsTab(): Promise<void> {
      await click(
        container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
        'Automations type tab',
      );
    }

    function seedThreeSources(): void {
      mockCapabilityMarketplaceInventory.localAutomations = [localAutomation()];
      mockCapabilityMarketplaceInventory.automationActivities = [
        automationActivity('standup'),
      ];
      mockCapabilityMarketplaceInventory.sharedAutomations = [
        sharedAutomation(),
      ];
      mockCapabilityMarketplaceInventory.curatedAutomations.rows = [
        curatedAutomation(),
      ];
    }

    it('lists local workflows in Installed and catalog workflows in the combined Browse band', async () => {
      seedThreeSources();
      await mountFullFixture();
      const installed = container.querySelector(
        '[data-testid="customize-section-installed"]',
      );
      expect(
        installed?.querySelector(
          '[data-testid="customize-row-automation:local:standup"]',
        ),
      ).not.toBeNull();
      const workflows = sectionBody('workflows');
      expect(entryTestIdsWithin(workflows).sort()).toEqual([
        'plugins-entry-automation:curated:daily-review',
        'plugins-entry-automation:shared:triage',
      ]);
      expect(
        container.querySelector('[data-testid="plugins-section-automations"]'),
      ).toBeNull();
    });

    it('keeps one canonical local install alongside its catalog copy and uses the update marker', async () => {
      const local = localAutomation({
        installedFrom: {
          remoteId: 'triage',
          contentHash: 'old',
          installedAt: '2026-08-19T00:00:00Z',
        },
        contentHash: 'old',
        sourceContentHash: 'new',
      });
      mockCapabilityMarketplaceInventory.localAutomations = [local];
      mockCapabilityMarketplaceInventory.sharedAutomations = [
        sharedAutomation(),
      ];
      await mount();
      await selectAutomationsTab();
      expect(
        container.querySelectorAll(
          '#customize-section-installed [data-marketplace-entry="true"]',
        ),
      ).toHaveLength(1);
      expect(
        container.querySelector(
          '#customize-section-browse [data-testid="plugins-entry-automation:shared:triage"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '#customize-section-installed [data-testid="customize-row-update-marker-automation:local:standup"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="plugins-update-available-automation:local:standup"]',
        ),
      ).toBeNull();
    });

    it('opens the install review from a team-shared automation Add without visiting the detail', async () => {
      seedThreeSources();
      useNavigationStore.setState({ pendingShareInstall: undefined });
      await mount();
      await selectAutomationsTab();
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-add-automation:shared:triage"]',
        ),
        'Triage inbox Add button',
      );

      expect(entryDetail()).toBeNull();
      expect(useNavigationStore.getState().pendingShareInstall).toEqual({
        link: {
          entity: 'automation',
          externalId: 'triage',
          intent: 'install',
          audience: 'ORGANIZATION',
        },
        origin: 'in-app',
      });
      act(() => {
        useNavigationStore.getState().consumeShareInstall();
      });
    });

    it('opens the install review from a curated automation Add by its catalog key', async () => {
      seedThreeSources();
      useNavigationStore.setState({ pendingShareInstall: undefined });
      await mount();
      await selectAutomationsTab();
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-add-automation:curated:daily-review"]',
        ),
        'Daily review Add button',
      );

      expect(entryDetail()).toBeNull();
      expect(useNavigationStore.getState().pendingShareInstall).toEqual({
        link: {
          entity: 'automation',
          externalId: 'daily-review',
          intent: 'install',
          automationSource: 'curated',
        },
        origin: 'in-app',
      });
      act(() => {
        useNavigationStore.getState().consumeShareInstall();
      });
    });

    it('previews a team-shared automation without starting an install when its card is opened', async () => {
      seedThreeSources();
      useNavigationStore.setState({ pendingShareInstall: undefined });
      await mount();
      await selectAutomationsTab();
      await openEntry('automation:shared:triage');

      expect(
        container
          .querySelector('[data-testid="mock-automation-shared-detail"]')
          ?.getAttribute('data-automation-id'),
      ).toBe('triage');
      expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
    });

    it('selects a curated automation in its catalog while its detail is open and releases it on close', async () => {
      seedThreeSources();
      const curated = mockCapabilityMarketplaceInventory.curatedAutomations;
      await mount();
      await selectAutomationsTab();
      await openEntry('automation:curated:daily-review');
      await renderPage();

      expect(curated.onSelectKey).toHaveBeenCalledTimes(1);
      expect(curated.onSelectKey).toHaveBeenCalledWith('daily-review');
      expect(
        container.querySelector(
          '[data-testid="mock-automation-curated-detail"]',
        ),
      ).not.toBeNull();

      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-root"]',
        ),
        'Customize breadcrumb',
      );
      await renderPage();

      expect(entryDetail()).toBeNull();
      expect(curated.onClearDetail).toHaveBeenCalledTimes(1);
    });

    it('opens a local automation in the Automations editor from its detail', async () => {
      seedThreeSources();
      useNavigationStore.setState({ activePage: 'plugins' });
      await mount();
      await selectAutomationsTab();
      await openEntry('automation:local:standup');

      const detail = requireElement(
        container.querySelector('[data-testid="mock-automation-local-detail"]'),
        'Local automation detail',
      );
      expect(detail.getAttribute('data-activity-id')).toBe('standup');
      expect(detail.getAttribute('data-update-available')).toBe('false');

      await click(
        container.querySelector('[data-testid="mock-automation-open"]'),
        'Open in Automations',
      );

      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useNavigationStore.getState().workflowEdit).toEqual({
        kind: 'automation',
        activityId: 'standup',
      });
    });

    it('leads an automation detail back to the Automations tab from its type crumb', async () => {
      seedThreeSources();
      await mount();
      await openEntry('automation:local:standup');
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-type"]',
        ),
        'Automations breadcrumb',
      );

      expect(entryDetail()).toBeNull();
      expect(
        container
          .querySelector('[data-testid="plugins-type-tab-workflow"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('closes a team-shared or curated automation detail when the Cloud account changes', async () => {
      seedThreeSources();
      await mount();
      await selectAutomationsTab();
      await openEntry('automation:shared:triage');
      expect(entryDetail()).not.toBeNull();

      mockCapabilityMarketplaceInventory.sharedAutomations = [];
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await renderPage();
      expect(entryDetail()).toBeNull();

      await openEntry('automation:curated:daily-review');
      expect(entryDetail()).not.toBeNull();
      mockCapabilityMarketplaceInventory.curatedAutomations.rows = [];
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await renderPage();
      expect(entryDetail()).toBeNull();
    });

    it('says there are no automations yet and leads to the Automations page', async () => {
      useNavigationStore.setState({ activePage: 'plugins' });
      await mountFullFixture();
      await selectAutomationsTab();

      expect(container.textContent).toContain('No workflows yet');
      const open = container.querySelector(
        '[data-testid="plugins-automations-empty-open"]',
      );
      expect(open?.textContent).toBe('Open Workflows');
      await click(open, 'Open Workflows');

      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
    });

    describe('Shared by me section', () => {
      function seedOwnedShare(): void {
        mockCapabilityMarketplaceInventory.viewerId = 'me';
        mockCapabilityMarketplaceInventory.localAutomations = [
          localAutomation({ sharedRemoteId: 'triage' }),
        ];
        mockCapabilityMarketplaceInventory.automationActivities = [
          automationActivity('standup'),
        ];
        mockCapabilityMarketplaceInventory.sharedAutomations = [
          sharedAutomation({
            shareScope: 'private',
            createdBy: { id: 'me', name: 'Me', email: null },
            publicShare: {
              externalId: 'public-triage',
              pinnedContentHash: 'hash',
              upToDate: true,
              sharePath: '/share/automations/public-triage',
              updatedAt: '2026-10-20T00:00:00Z',
              createdAt: '2026-10-20T00:00:00Z',
            },
          }),
        ];
      }
      it('lists owned published shares on All and Workflows without a second filter', async () => {
        seedOwnedShare();
        await mount();
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).not.toBeNull();
        expect(mockInventoryOptions).toMatchObject({
          ownedAutomationSharesEnabled: true,
        });
        await selectAutomationsTab();
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="plugins-automation-ownership-filter"]',
          ),
        ).toBeNull();
      });
      it('omits owned sections and reads when the capability is unavailable', async () => {
        mockOwnedAutomationSharesCapability = false;
        mockOwnedSharesCapability = false;
        seedOwnedShare();
        await mount();
        expect(mockInventoryOptions).toMatchObject({
          ownedAutomationSharesEnabled: false,
        });
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).toBeNull();
      });
      it('retains one local install and its published share as separate section identities', async () => {
        seedOwnedShare();
        await mount();
        await selectAutomationsTab();
        const installed = container.querySelector(
          '[data-testid="customize-section-installed"]',
        );
        expect(
          installed?.querySelectorAll('[data-marketplace-entry="true"]'),
        ).toHaveLength(1);
        expect(
          installed?.querySelector(
            '[data-testid="customize-row-automation:local:standup"]',
          ),
        ).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"] [data-testid="customize-row-automation:shared:triage"]',
          ),
        ).not.toBeNull();
      });
      it('does not read the owned automation lane on unrelated tabs', async () => {
        seedOwnedShare();
        await mount();
        await click(
          container.querySelector('[data-testid="plugins-type-tab-plugin"]'),
          'Plugins tab',
        );
        expect(mockInventoryOptions).toMatchObject({
          ownedAutomationSharesEnabled: false,
        });
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).toBeNull();
      });
      it('hides an empty owned section', async () => {
        await mount();
        await selectAutomationsTab();
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).toBeNull();
      });
      it('waits for owned data before spending a focus intent and scrolls once', async () => {
        seedOwnedShare();
        mockCapabilityMarketplaceInventory.ownedSharesLoading = true;
        const scroll = jest.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: scroll,
        });
        await mount();
        act(() =>
          useNavigationStore.getState().openPluginsNavigation({
            kind: 'marketplace-browse',
            query: '',
            tab: 'workflow',
            focusSection: 'shared-by-me',
          }),
        );
        await settle();
        expect(scroll).not.toHaveBeenCalled();
        mockCapabilityMarketplaceInventory.ownedSharesLoading = false;
        await renderPage();
        expect(scroll).toHaveBeenCalledTimes(1);
        await renderPage();
        expect(scroll).toHaveBeenCalledTimes(1);
      });
      it('restores canonical Workflows behind a detail reopened from a pipeline', async () => {
        seedOwnedShare();
        await mount();
        act(() =>
          useNavigationStore.getState().openPluginsNavigation({
            kind: 'entry-detail',
            entryId: 'automation:shared:triage',
            from: {
              kind: 'entry-context',
              stack: [],
              marketplace: { query: '', tab: 'workflow' },
            },
          }),
        );
        await settle();
        expect(mockInventoryOptions).toMatchObject({
          ownedAutomationSharesEnabled: true,
        });
      });

      it('opens an owned share by id even when the inventory does not list it', async () => {
        await mount();
        act(() => {
          useNavigationStore.getState().openPluginsNavigation({
            kind: 'entry-detail',
            entryId: 'automation:shared:owned-public-link',
          });
        });
        await settle();

        expect(
          container
            .querySelector('[data-testid="mock-automation-shared-detail"]')
            ?.getAttribute('data-automation-id'),
        ).toBe('owned-public-link');
        expect(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-current"]',
          )?.textContent,
        ).toBe('Loaded Owned-Public-Link');
      });
    });

    describe('Shared by me section eligibility across tabs', () => {
      it('keeps Installed available alongside ownership without a second filter', async () => {
        await mountFullFixture();
        await click(
          container.querySelector('[data-testid="plugins-type-tab-skill"]'),
          'Skills',
        );
        expect(
          container.querySelector(
            '[data-testid="customize-section-installed"]',
          ),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="plugins-ownership-skill"]'),
        ).toBeNull();
        expect(mockInventoryOptions).toMatchObject({
          completeSharedCatalogs: true,
        });
      });
      it('excludes MCP ownership without hiding its Installed rows', async () => {
        await mountFullFixture();
        await click(
          container.querySelector('[data-testid="plugins-type-tab-app"]'),
          'MCP servers',
        );
        expect(
          container.querySelector(
            '[data-testid="customize-section-shared-by-me"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="customize-section-installed"]',
          ),
        ).not.toBeNull();
      });
      it('does not complete owned catalogs when all ownership capabilities are unavailable', async () => {
        mockOwnedSharesCapability = false;
        mockOwnedAutomationSharesCapability = false;
        await mount();
        await click(
          container.querySelector('[data-testid="plugins-type-tab-skill"]'),
          'Skills',
        );
        expect(mockInventoryOptions).toMatchObject({
          completeSharedCatalogs: false,
        });
      });
    });

    it('holds the empty state while the automation sources are still loading', async () => {
      await mount();
      mockCapabilityMarketplaceInventory.loading = true;
      await selectAutomationsTab();
      expect(container.textContent).not.toContain('No workflows yet');
      expect(
        container.querySelector(
          '[data-testid="plugins-discovery-list-skeleton"]',
        ),
      ).not.toBeNull();
    });

    it('says a search found nothing rather than that there are no automations', async () => {
      seedThreeSources();
      await mount();
      await selectAutomationsTab();
      await typeQuery('no-such-automation');

      expect(container.textContent).not.toContain('No workflows yet');
      expect(container.textContent).toContain('Nothing matches your search.');
    });

    it('offers the next page of shared and curated automations on the Automations tab only', async () => {
      seedThreeSources();
      mockCapabilityMarketplaceInventory.sharedAutomationNextCursor = 'page-2';
      mockCapabilityMarketplaceInventory.curatedAutomations.nextCursor =
        'page-2';
      await mount();
      expect(
        container.querySelector('[data-testid="automation-catalog-load-more"]'),
      ).toBeNull();

      await selectAutomationsTab();
      const more = requireButton(
        container.querySelector('[data-testid="automation-catalog-load-more"]'),
        'Show more automations',
      );
      expect(more.textContent).toBe('Show more automations');
      await click(more, 'Show more automations');

      expect(
        mockCapabilityMarketplaceInventory.curatedAutomations.onLoadMore,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockCapabilityMarketplaceInventory.loadMoreSharedAutomations,
      ).toHaveBeenCalledTimes(1);
    });

    it('explains a curated automation catalog failure and retries it', async () => {
      seedThreeSources();
      mockCapabilityMarketplaceInventory.curatedAutomations.error =
        'Catalog unavailable';
      await mount();
      await selectAutomationsTab();

      const notice = requireElement(
        container.querySelector(
          '[data-testid="plugins-curated-automations-error"]',
        ),
        'Curated automations error',
      );
      expect(notice.textContent).toContain(
        "Couldn't load curated automations.",
      );
      expect(notice.textContent).toContain('Catalog unavailable');
      await click(notice.querySelector('button'), 'Retry');

      expect(
        mockCapabilityMarketplaceInventory.curatedAutomations.onRefresh,
      ).toHaveBeenCalledTimes(1);
    });
  });

  it('renders an available shared collection as a Marketplace detail sub-page', async () => {
    const refresh = createDeferred<void>();
    mockCapabilityMarketplaceInventory.refreshSharedCollections = jest.fn(
      () => refresh.promise,
    );
    const collection: SharedCollectionSummary = {
      id: 'review-collection',
      name: 'Review Collection',
      description: 'Review capabilities for release.',
      contentHash: 'review-collection-hash',
      itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
      createdBy: { id: 'author', name: 'Author', email: null },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
    };
    mockCapabilityMarketplaceInventory.sharedCollections = [collection];

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-collection:shared:review-collection"]',
      ),
      'Review Collection card',
    );
    await settle();

    expect(entryDetail()?.getAttribute('data-presentation')).toBe('page');
    expect(
      container
        .querySelector('[data-testid="plugins-management-view"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Review Collection');

    expect(mockSharedDetailMounts.collection).toBe(1);
    await click(
      container.querySelector('[data-testid="mock-shared-collection-edit"]'),
      'Shared collection edit button',
    );
    await click(
      container.querySelector(
        '[data-testid="mock-shared-collection-update-edit"]',
      ),
      'Shared collection save callback',
    );

    expect(
      mockCapabilityMarketplaceInventory.refreshSharedCollections,
    ).toHaveBeenCalledTimes(1);
    expect(entryDetail()).not.toBeNull();
    expect(entryDetail()?.getAttribute('data-content-hash')).toBe(
      'updated-collection-hash',
    );

    mockCapabilityMarketplaceInventory.sharedCollections = [];
    await renderPage();
    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Review Collection Renamed');

    refresh.resolve();
    await settle();
    expect(entryDetail()?.getAttribute('data-content-hash')).toBe(
      'updated-collection-hash',
    );
  });

  it('omits shared collection Edit on a host without the edit capability', async () => {
    mockSharedCollectionEditCapability = false;
    mockCapabilityMarketplaceInventory.sharedCollections = [
      {
        id: 'review-collection',
        name: 'Review Collection',
        description: 'Review capabilities for release.',
        contentHash: 'review-collection-hash',
        itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
        shareScope: 'organization',
        owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
        createdBy: { id: 'author', name: 'Author', email: null },
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
      },
    ];

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-collection:shared:review-collection"]',
      ),
      'Review Collection card',
    );
    await settle();

    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mock-shared-collection-edit"]'),
    ).toBeNull();
  });

  it('opens the install review from a shared collection detail Add without writing', async () => {
    const collection: SharedCollectionSummary = {
      id: 'review-collection',
      name: 'Review Collection',
      description: 'Review capabilities for release.',
      contentHash: 'review-collection-hash',
      itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
      shareScope: 'organization',
      owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
      createdBy: { id: 'author', name: 'Author', email: null },
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
    };
    mockCapabilityMarketplaceInventory.sharedCollections = [collection];
    useNavigationStore.setState({ pendingShareInstall: undefined });

    await mount();
    await click(
      container.querySelector(
        '[data-testid="plugins-entry-collection:shared:review-collection"]',
      ),
      'Review Collection card',
    );
    await click(
      container.querySelector('[data-testid="mock-shared-collection-add"]'),
      'Detail Add button',
    );
    await settle();

    // The shared install review (CAN-3710) owns the write; the detail only
    // opens it with the collection's audience.
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: {
        entity: 'collection',
        externalId: 'review-collection',
        intent: 'install',
        audience: 'ORGANIZATION',
      },
      origin: 'in-app',
    });
    expect(collectionsApi.inspectImport).not.toHaveBeenCalled();
    expect(collectionsApi.saveCollection).not.toHaveBeenCalled();
    act(() => {
      useNavigationStore.getState().consumeShareInstall();
    });
  });

  it('renders an installed local collection as a Marketplace detail sub-page', async () => {
    const collection: CollectionIndexEntry = {
      id: 'release-collection',
      name: 'Release Collection',
      description: 'Release capabilities.',
      skillCount: 1,
      pluginCount: 0,
      mcpServerCount: 0,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    mockCapabilityMarketplaceInventory.localCollections = [collection];

    await mount();
    await openEntry('collection:local:release-collection');

    expect(entryDetail()?.getAttribute('data-presentation')).toBe('page');
    expect(
      container
        .querySelector('[data-testid="plugins-management-view"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Release Collection');

    await click(
      container.querySelector('[data-testid="mock-local-collection-save"]'),
      'Local collection save callback',
    );
    expect(
      mockCapabilityMarketplaceInventory.refreshLocalCollections,
    ).toHaveBeenCalled();

    await click(
      container.querySelector('[data-testid="mock-local-collection-delete"]'),
      'Local collection delete callback',
    );
    expect(entryDetail()).toBeNull();
  });

  it('offers Connect in the card menu only for entries that need auth', async () => {
    await mountFullFixture();
    await typeQuery('github');

    const menu = await openEntryMenu('mcp-catalog:github');
    const connect = requireButton(
      menu.querySelector(
        '[data-testid="plugins-menu-connect-mcp-catalog:github"]',
      ),
      'GitHub Connect menu item',
    );
    expect(connect.textContent).toContain('Connect');
    expect(
      menu.querySelector(
        '[data-testid="plugins-menu-view-mcp-catalog:github"]',
      ),
    ).not.toBeNull();
  });

  it('omits the card menu when clicking the card already opens details', async () => {
    await mountFullFixture();

    expect(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:writer-toolkit"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:writer-toolkit"]',
      ),
    ).not.toBeNull();

    await openEntry('curated:writer-toolkit');

    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
  });

  it('closes an open card menu when the add-custom menu is opened', async () => {
    await mountFullFixture();
    await typeQuery('github');
    await openEntryMenu('mcp-catalog:github');
    await openAddCustomMenu();

    expect(
      document.querySelector(
        '[data-testid="plugins-entry-menu-surface-mcp-catalog:github"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="plugins-add-custom-marketplace"]'),
    ).not.toBeNull();
  });

  it('replaces the activated card browse view with its detail sub-page', async () => {
    await mountFullFixture();

    await openEntry('curated:writer-toolkit');

    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-curated:writer-toolkit"]',
      ),
    ).toBeNull();
  });

  it('closes the detail sub-page on document-level Escape', async () => {
    await mountFullFixture();
    await openEntry('curated:writer-toolkit');
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-search"]'),
    ).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Management view — shell, navigation, deep links
  // -------------------------------------------------------------------------

  it('opens the management view at the installed section from the installed row', async () => {
    await mountFullFixture();
    const closedView = requireElement(
      container.querySelector('[data-testid="plugins-management-view"]'),
      'Closed management view',
    );
    expect(closedView.getAttribute('data-open')).toBe('false');
    expect(closedView.hasAttribute('inert')).toBe(true);
    expect(closedView.className).toContain('invisible');
    expect(
      closedView.querySelector('.settings-sidebar-content'),
    ).not.toBeNull();
    expect(
      closedView.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
    ).toBeNull();

    await openManagement('installed');

    expect(
      container.querySelector('[data-testid="plugins-management-view"]'),
    ).toBe(closedView);
    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
      'Installed management section',
    );
    // Installed + needs-attention entries: the curated helper, the custom
    // skill, and the auth-required GitHub app.
    const ids = entryTestIdsWithin(section);
    expect(ids).toContain('plugins-entry-curated:installed-helper');
    expect(ids).toContain('plugins-entry-skill:custom:app:review-checklist');
    expect(ids).toContain('plugins-entry-mcp-catalog:github');
    expect(ids).not.toContain('plugins-entry-curated:data-cruncher');
  });

  it('closes the management view and returns to discovery', async () => {
    await mountFullFixture();
    await openManagement('installed');

    await click(
      container.querySelector('[data-testid="plugins-management-back"]'),
      'Management back button',
    );

    const exitingView = requireElement(
      container.querySelector('[data-testid="plugins-management-view"]'),
      'Exiting management view',
    );
    expect(exitingView.getAttribute('data-open')).toBe('false');
    expect(exitingView.hasAttribute('inert')).toBe(true);
    expect(
      container.querySelector('[data-testid="plugins-search"]'),
    ).not.toBeNull();
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ view: 'discovery', managementSection: null });
  });

  it('closes the management view on Escape', async () => {
    await mountFullFixture();
    await openManagement('installed');

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    await settle();

    const exitingView = requireElement(
      container.querySelector('[data-testid="plugins-management-view"]'),
      'Exiting management view',
    );
    expect(exitingView.getAttribute('data-open')).toBe('false');
    expect(exitingView.hasAttribute('inert')).toBe(true);
  });

  it('mounts each moved tab component from the management rail', async () => {
    await mountFullFixture();
    await openManagement('skills');
    const skillsSection = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-skills"]',
      ),
      'Skills management section',
    );
    expect(
      skillsSection.querySelector('[data-testid="page-heading"]'),
    ).not.toBeNull();
    expect(skillsSection.querySelector('h1')?.textContent).toBe('Skills');
    expect(
      container.querySelector('[data-testid="mock-skills-tab"]'),
    ).not.toBeNull();

    await click(
      container.querySelector('[data-testid="plugins-management-nav-mcp"]'),
      'MCP rail item',
    );
    const mcpSection = requireElement(
      container.querySelector('[data-testid="plugins-management-section-mcp"]'),
      'MCP management section',
    );
    expect(
      mcpSection.querySelector('[data-testid="page-heading"]'),
    ).not.toBeNull();
    expect(mcpSection.querySelector('h1')?.textContent).toBe('MCP servers');
    expect(
      container.querySelector('[data-testid="mock-mcp-servers-tab"]'),
    ).not.toBeNull();

    await click(
      container.querySelector(
        '[data-testid="plugins-management-nav-collections"]',
      ),
      'Collections rail item',
    );
    const collectionsSection = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-collections"]',
      ),
      'Collections management section',
    );
    expect(
      collectionsSection.querySelector('[data-testid="page-heading"]'),
    ).not.toBeNull();
    expect(collectionsSection.querySelector('h1')?.textContent).toBe(
      'Collections',
    );
    expect(
      container.querySelector('[data-testid="mock-collections-tab"]'),
    ).not.toBeNull();

    await click(
      container.querySelector(
        '[data-testid="plugins-management-nav-marketplaces"]',
      ),
      'Customizes rail item',
    );
    const marketplacesSection = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
      'Customizes management section',
    );
    expect(
      marketplacesSection.querySelector('[data-testid="page-heading"]'),
    ).not.toBeNull();
    expect(marketplacesSection.querySelector('h1')?.textContent).toBe(
      'Marketplaces',
    );
    expect(
      container.querySelector('[data-testid="marketplace-row-curated/cloud"]'),
    ).not.toBeNull();
  });

  it('never mounts the previous section when reopening at another section', async () => {
    await mountFullFixture();
    await openManagement('mcp');
    expect(mockTabLifecycle.mcp.mounts).toBe(1);

    await click(
      container.querySelector('[data-testid="plugins-management-back"]'),
      'Management back button',
    );
    expect(mockTabLifecycle.mcp.unmounts).toBe(1);

    // Reopening at `installed` must not transiently commit the previous
    // session's MCP section: `McpServersTab`'s mount effects kick a
    // `listStatus()` plus a sequential `checkHealth` sweep of every configured
    // server, which the user never asked for.
    await openManagement('installed');

    expect(mockTabLifecycle.mcp.mounts).toBe(1);
    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mock-mcp-servers-tab"]'),
    ).toBeNull();
  });

  it('unmounts the previous section when navigating the rail', async () => {
    await mountFullFixture();
    await openManagement('mcp');
    expect(mockTabLifecycle.mcp.mounts - mockTabLifecycle.mcp.unmounts).toBe(1);

    await click(
      container.querySelector(
        '[data-testid="plugins-management-nav-collections"]',
      ),
      'Collections rail item',
    );

    // Steady state: exactly one section component is mounted at a time.
    expect(mockTabLifecycle.mcp.mounts - mockTabLifecycle.mcp.unmounts).toBe(0);
    expect(
      container.querySelector('[data-testid="mock-mcp-servers-tab"]'),
    ).toBeNull();
    expect(
      mockTabLifecycle.collections.mounts -
        mockTabLifecycle.collections.unmounts,
    ).toBe(1);
    expect(mockTabLifecycle.skills.mounts).toBe(0);
  });

  it('reports the active management section for App Advisor', async () => {
    await mountFullFixture();
    await openManagement('mcp');

    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ view: 'management', managementSection: 'mcp' });
  });

  it.each([
    ['mcp', 'mcp'],
    ['skills', 'skills'],
    ['collections', 'collections'],
    ['bundles', 'collections'],
    ['marketplace', 'marketplaces'],
  ])(
    'opens the management view at the mapped section for a %s deep link',
    async (tab: string, section: string) => {
      await mountFullFixture();

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('canopy:plugins-open-tab', { detail: { tab } }),
        );
        await Promise.resolve();
      });
      await settle();

      expect(
        container.querySelector(
          `[data-testid="plugins-management-section-${section}"]`,
        ),
      ).not.toBeNull();
    },
  );

  it('opens an installed skill deep link as its Marketplace detail page', async () => {
    skillsApi.readContent.mockResolvedValue(
      okResult({
        frontmatter: { name: 'review-checklist', description: 'Checklist' },
        body: '# Review Checklist',
      }),
    );
    skillsApi.listFiles.mockResolvedValue(
      okResult({ files: ['SKILL.md'], truncated: false }),
    );
    await mountFullFixture();

    await act(async () => {
      useNavigationStore.setState({
        pendingSkillViewer: {
          kind: 'installed',
          sourceId: 'custom:app',
          skillName: 'review-checklist',
        },
      });
      await Promise.resolve();
    });
    await settle();

    // CAN-3483: the page itself consumes installed-skill links and opens the
    // detail page directly, without flashing the management overlay first.
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="plugins-management-view"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-installed"]',
      ),
    ).not.toBeNull();
    expect(skillsApi.readContent).toHaveBeenCalledWith(
      'custom:app',
      'review-checklist',
    );

    // The Skills crumb lands on the installed Skills list the link belongs to.
    await leaveDetailByCrumb('type', 'Skill detail Skills crumb');
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-skills"]',
      ),
    ).not.toBeNull();
  });

  it('opens an installed skill page for a deep link pending before the page mounts', async () => {
    skillsApi.readContent.mockResolvedValue(
      okResult({
        frontmatter: { name: 'not-yet-listed', description: 'Fresh' },
        body: '# Fresh',
      }),
    );
    skillsApi.listFiles.mockResolvedValue(
      okResult({ files: ['SKILL.md'], truncated: false }),
    );
    // The link can name a skill this page's inventory has not listed yet.
    useNavigationStore.setState({
      pendingSkillViewer: {
        kind: 'installed',
        sourceId: 'custom:app',
        skillName: 'not-yet-listed',
      },
    });
    await mountFullFixture();

    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Not Yet Listed');
  });

  it('opens the management view at Skills for a pending shared skill deep link', async () => {
    await mountFullFixture();

    await act(async () => {
      useNavigationStore.setState({
        pendingSkillViewer: { kind: 'shared', skillId: 'shared-skill-1' },
      });
      await Promise.resolve();
    });
    await settle();

    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-skills"]',
      ),
    ).not.toBeNull();
    // Shared links are forwarded, not consumed, by the page: SkillsTab still
    // owns consumption once it mounts inside the section.
    expect(
      useNavigationStore.getState().pendingSkillViewer,
    ).not.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Management view — Marketplaces section (restored from the pre-redesign
  // page-level marketplace UX suite; see task-2-report.md Finding 1)
  // -------------------------------------------------------------------------

  it('never frames the marketplaces section as a "Claude Marketplace"', async () => {
    await mountMarketplaces([makeBuiltInMarketplace()]);
    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
      'Customizes section',
    );
    expect(section.textContent).not.toMatch(/Claude Marketplace/);
    expect(section.textContent).toContain('Marketplaces');
  });

  it('renders the built-in marketplace row with a Built-in source badge and the brand name', async () => {
    const builtIn = makeBuiltInMarketplace();
    await mountMarketplaces([builtIn]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${builtIn.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Built-in');
    expect(row?.textContent).toContain('Canopy');
    // Built-in source must not be a clickable GitHub link.
    expect(row?.querySelector('a')).toBeNull();
    // Provider icons still render for the built-in row.
    expect(
      row?.querySelector('[data-testid="provider-support-icons"]'),
    ).not.toBeNull();
  });

  it('does not offer a remove action for the built-in marketplace row', async () => {
    const builtIn = makeBuiltInMarketplace();
    await mountMarketplaces([builtIn]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${builtIn.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('button[aria-label="More marketplace actions"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="remove-marketplace-action"]'),
    ).toBeNull();
  });

  it('renders the curated marketplace row with a Curated source badge and the brand name', async () => {
    const curated = makeCuratedMarketplace([]);
    await mountMarketplaces([curated]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${curated.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Curated');
    expect(row?.textContent).toContain('Canopy');
    expect(row?.querySelector('a')).toBeNull();
  });

  it('does not offer a remove action for the curated marketplace row', async () => {
    const curated = makeCuratedMarketplace([]);
    await mountMarketplaces([curated]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${curated.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('button[aria-label="More marketplace actions"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="remove-marketplace-action"]'),
    ).toBeNull();
  });

  it('does not offer a "Check for updates" action for the curated marketplace row', async () => {
    const curated = makeCuratedMarketplace([]);
    await mountMarketplaces([curated]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${curated.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('button[aria-label="Check for updates"]'),
    ).toBeNull();
    expect(pluginsApi.updateMarketplace).not.toHaveBeenCalled();
  });

  it('still offers a "Check for updates" action for the built-in marketplace row', async () => {
    const builtIn = makeBuiltInMarketplace();
    await mountMarketplaces([builtIn]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${builtIn.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('button[aria-label="Check for updates"]'),
    ).not.toBeNull();
  });

  it('updates a marketplace row in place when "Check for updates" succeeds', async () => {
    const builtIn = makeBuiltInMarketplace({ pluginCount: 1 });
    await mountMarketplaces([builtIn]);
    pluginsApi.updateMarketplace.mockResolvedValue(
      okResult(makeBuiltInMarketplace({ pluginCount: 7 })),
    );

    await click(
      container.querySelector(
        `[data-testid="marketplace-row-${builtIn.id}"] button[aria-label="Check for updates"]`,
      ),
      'Check for updates button',
    );

    expect(pluginsApi.updateMarketplace).toHaveBeenCalledWith(builtIn.id);
    expect(pluginsApi.refreshMarketplaces).not.toHaveBeenCalled();
    expect(
      container.querySelector(`[data-testid="marketplace-row-${builtIn.id}"]`)
        ?.textContent,
    ).toContain('7');
  });

  it('groups personalized curated recommendations ahead of the remaining plugins', async () => {
    const curated = makeCuratedMarketplace([
      makePlugin({ name: 'alpha-tool', marketplaceId: 'curated/cloud' }),
      makePlugin({
        name: 'zeta-recommended',
        marketplaceId: 'curated/cloud',
        recommended: true,
      }),
      makePlugin({
        name: 'beta-recommended',
        marketplaceId: 'curated/cloud',
        recommended: true,
      }),
    ]);
    await mountMarketplaces([curated]);
    await openMarketplaceRow(curated.id);

    expect(
      container.querySelector('[data-testid="recommended-plugins-section"]')
        ?.textContent,
    ).toContain('Recommended for you');
    expect(
      container.querySelector(
        '[data-testid="plugin-recommendation-badge-zeta-recommended"]',
      ),
    ).not.toBeNull();

    expect(
      container.querySelector('[data-testid="plugin-row-alpha-tool"]')
        ?.textContent,
    ).toContain('Alpha Tool');
    expect(
      container.querySelector('[data-testid="plugin-row-alpha-tool"]')
        ?.textContent,
    ).not.toContain('alpha-tool');

    const rows = Array.from(
      container.querySelectorAll('[data-testid^="plugin-row-"]'),
    ).map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'plugin-row-beta-recommended',
      'plugin-row-zeta-recommended',
      'plugin-row-alpha-tool',
    ]);
  });

  it.each([
    ['dbt', 'dbt labs', 'dbt labs'],
    ['crowdstrike-falcon-foundry', undefined, 'CrowdStrike Falcon Foundry'],
  ])(
    'lists resolved plugin name %s verbatim',
    async (name, displayName, expected): Promise<void> => {
      const curated = makeCuratedMarketplace([
        makePlugin({ name, displayName, marketplaceId: 'curated/cloud' }),
      ]);
      const entries = buildUnifiedPluginEntries({
        curatedPlugins: curatedCatalogFromMarketplaces([curated]),
        marketplaces: [curated],
        installedSkills: [],
        mcpServers: [],
        mcpStatuses: [],
        curatedMcpServers: [],
        providerConnectors: [],
      });
      expect(entries.find((entry) => entry.kind === 'plugin')?.name).toBe(
        expected,
      );
      await mountMarketplaces([curated]);
      await openMarketplaceRow(curated.id);
      expect(
        container.querySelector(`[data-testid="plugin-row-${name}"] td span`)
          ?.textContent,
      ).toBe(expected);
    },
  );

  it('renders and searches curated plugins by display name while retaining the key', async () => {
    const curated = makeCuratedMarketplace([
      makePlugin({
        name: 'writer-toolkit',
        displayName: 'Writer Toolkit',
        marketplaceId: 'curated/cloud',
      }),
    ]);
    await mountMarketplaces([curated]);
    await openMarketplaceRow(curated.id);

    const row = container.querySelector(
      '[data-testid="plugin-row-writer-toolkit"]',
    );
    expect(row?.textContent).toContain('Writer Toolkit');

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search by name…"]',
    );
    if (!input) {
      throw new Error('Customize plugin search input not found');
    }
    act(() => {
      setInputValue(input, 'Writer');
    });
    expect(
      container.querySelector('[data-testid="plugin-row-writer-toolkit"]'),
    ).not.toBeNull();
  });

  it('shows background marketplace refresh progress and reloads cache on completion', async () => {
    const initialMarketplace = makeMarketplace({ pluginCount: 1 });
    const refreshedMarketplace = makeMarketplace({ pluginCount: 2 });
    configureApis({});
    pluginsApi.loadMarketplaces
      .mockReset()
      .mockResolvedValueOnce(okResult(makeCache([initialMarketplace])))
      .mockResolvedValueOnce(okResult(makeCache([refreshedMarketplace])));
    await renderPage();
    await openManagement('marketplaces');

    expect(marketplaceProgressCallbacks.length).toBeGreaterThan(0);

    act(() => {
      emitMarketplaceProgress({
        operation: 'refresh',
        status: 'running',
        message: 'Checking installed marketplaces…',
      });
    });

    expect(
      container.querySelector('[data-testid="marketplace-list-progress"]')
        ?.textContent,
    ).toContain('Checking installed marketplaces…');

    await act(async () => {
      emitMarketplaceProgress({
        operation: 'refresh',
        status: 'complete',
        message: 'Customize refresh complete.',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(pluginsApi.loadMarketplaces).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="marketplace-list-progress"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        `[data-testid="marketplace-row-${refreshedMarketplace.id}"]`,
      )?.textContent,
    ).toContain('2');
  });

  it('shows marketplace helper text mentioning optional provider install', async () => {
    await mountMarketplaces([]);
    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
      'Customizes section',
    );
    expect(section.textContent).toContain('includes a built-in marketplace');
    expect(section.textContent).toContain(
      'installing them to Claude or Codex is optional',
    );
  });

  it('shows provider icons on a dual-valid marketplace row', async () => {
    const marketplace = makeMarketplace();
    await mountMarketplaces([marketplace]);

    const row = container.querySelector(
      `[data-testid="marketplace-row-${marketplace.id}"]`,
    );
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="provider-support-icons"]'),
    ).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="provider-support-icon-claude"]'),
    ).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="provider-support-icon-codex-native"]'),
    ).not.toBeNull();
  });

  it('renders full GitHub source URLs without duplicating the host', async () => {
    await mountMarketplaces([
      makeMarketplace({ sourceUrl: 'https://github.com/acme/plugins' }),
    ]);

    expect(
      container.querySelector('a[href="https://github.com/acme/plugins"]'),
    ).not.toBeNull();
    expect(container.innerHTML).not.toContain(
      'https://github.com/https://github.com/acme/plugins',
    );
  });

  it('displays GitHub source as owner/repo even when stored as a full URL', async () => {
    await mountMarketplaces([
      makeMarketplace({ sourceUrl: 'https://github.com/acme/plugins' }),
    ]);

    const link = container.querySelector(
      'a[href="https://github.com/acme/plugins"]',
    );
    expect(link?.textContent).toBe('acme/plugins');
  });

  it('renders the inline error banner with Retry refresh + Remove when both providers are invalid', async () => {
    const broken = makeMarketplace({
      id: 'mkt-broken',
      validProviders: [],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Provider rejected',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Provider rejected',
        },
      },
    });
    await mountMarketplaces([broken]);

    expect(
      container.querySelector(
        `[data-testid="marketplace-error-banner-${broken.id}"]`,
      ),
    ).not.toBeNull();
    const banner = container.querySelector(
      `[data-testid="marketplace-error-banner-${broken.id}"]`,
    );
    const providerErrors = Array.from(
      banner?.querySelectorAll('li span') ?? [],
    ).filter((el) => el.textContent === 'Provider rejected');
    expect(providerErrors).toHaveLength(2);
    expect(banner?.textContent).toContain('This marketplace is not available.');
    expect(
      container.querySelector(`[data-testid="marketplace-retry-${broken.id}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(
        `[data-testid="marketplace-remove-${broken.id}"]`,
      ),
    ).not.toBeNull();
  });

  it('explains suppressed Codex rechecks when the marketplace is structurally invalid', async () => {
    const broken = makeMarketplace({
      id: 'mkt-codex-structural',
      validProviders: [],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Customize is available only through Codex.',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Repository did not contain .codex-plugin/plugin.json',
          structurallyInvalidAtRevision: 'abc123',
        },
      },
    });
    await mountMarketplaces([broken]);

    const note = container.querySelector(
      `[data-testid="marketplace-codex-structural-note-${broken.id}"]`,
    );
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('Retry refresh');
  });

  it('omits the structural Codex note for a transient provider failure', async () => {
    const broken = makeMarketplace({
      id: 'mkt-transient',
      validProviders: [],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Provider rejected',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-01T00:00:00.000Z',
          error: 'Request timed out',
        },
      },
    });
    await mountMarketplaces([broken]);

    expect(
      container.querySelector(
        `[data-testid="marketplace-codex-structural-note-${broken.id}"]`,
      ),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Management view — marketplace plugin modal
  // -------------------------------------------------------------------------

  it('disables row installs while a bulk install is running', async () => {
    const firstInstall = createDeferred<IPCResult<PluginInfo>>();
    const alpha = makePlugin({ name: 'alpha-tool' });
    const beta = makePlugin({
      name: 'beta-tool',
      externalSource: { source: 'github', url: 'https://github.com/acme/beta' },
    });
    pluginsApi.installPlugin.mockImplementation(
      (
        _marketplaceId: string,
        pluginName: string,
      ): Promise<IPCResult<PluginInfo>> => {
        if (pluginName === 'alpha-tool') {
          return firstInstall.promise;
        }
        return Promise.resolve(
          okResult(makePlugin({ name: pluginName, details: emptyDetails })),
        );
      },
    );

    const marketplace = makeMarketplace({
      pluginCount: 2,
      plugins: [alpha, beta],
    });
    await mountMarketplaces([marketplace]);
    await openMarketplaceRow(marketplace.id);

    const bulkButton = requireButton(
      container.querySelector('[data-testid="bulk-install-plugins"]'),
      'Bulk install button',
    );
    await act(async () => {
      bulkButton.click();
      await Promise.resolve();
    });

    const queuedInstallButton = requireButton(
      container.querySelector('[data-testid="plugin-install-beta-tool"]'),
      'Queued install button',
    );
    expect(queuedInstallButton.disabled).toBe(true);

    act(() => {
      queuedInstallButton.click();
    });
    expect(pluginsApi.installPlugin).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstInstall.resolve(
        okResult(makePlugin({ name: 'alpha-tool', details: emptyDetails })),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pluginsApi.installPlugin).toHaveBeenCalledTimes(2);
    expect(pluginsApi.installPlugin).toHaveBeenNthCalledWith(
      2,
      marketplace.id,
      'beta-tool',
      'https://github.com/acme/beta',
    );
  });

  it('excludes already installing plugins from bulk install progress', async () => {
    const firstInstall = createDeferred<IPCResult<PluginInfo>>();
    const alpha = makePlugin({ name: 'alpha-tool' });
    const beta = makePlugin({
      name: 'beta-tool',
      externalSource: { source: 'github', url: 'https://github.com/acme/beta' },
    });
    pluginsApi.installPlugin.mockImplementation(
      (
        _marketplaceId: string,
        pluginName: string,
      ): Promise<IPCResult<PluginInfo>> => {
        if (pluginName === 'alpha-tool') {
          return firstInstall.promise;
        }
        return Promise.resolve(
          okResult(makePlugin({ name: pluginName, details: emptyDetails })),
        );
      },
    );

    const marketplace = makeMarketplace({
      pluginCount: 2,
      plugins: [alpha, beta],
    });
    await mountMarketplaces([marketplace]);
    await openMarketplaceRow(marketplace.id);

    const alphaButton = requireButton(
      container.querySelector('[data-testid="plugin-install-alpha-tool"]'),
      'Alpha install button',
    );
    await act(async () => {
      alphaButton.click();
      await Promise.resolve();
    });

    const bulkButton = requireButton(
      container.querySelector('[data-testid="bulk-install-plugins"]'),
      'Bulk install button',
    );
    await act(async () => {
      bulkButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bulkButton.disabled).toBe(true);
    expect(pluginsApi.installPlugin).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('failed');

    await act(async () => {
      firstInstall.resolve(
        okResult(makePlugin({ name: 'alpha-tool', details: emptyDetails })),
      );
      await Promise.resolve();
    });
  });

  it('reports marketplace modal install state for App Advisor', async () => {
    const firstInstall = createDeferred<IPCResult<PluginInfo>>();
    const alpha = makePlugin({ name: 'alpha-tool' });
    const beta = makePlugin({
      name: 'beta-tool',
      externalSource: { source: 'github', url: 'https://github.com/acme/beta' },
    });
    pluginsApi.installPlugin.mockImplementation(
      (
        _marketplaceId: string,
        pluginName: string,
      ): Promise<IPCResult<PluginInfo>> => {
        if (pluginName === 'alpha-tool') {
          return firstInstall.promise;
        }
        return Promise.resolve(
          okResult(makePlugin({ name: pluginName, details: emptyDetails })),
        );
      },
    );

    const marketplace = makeMarketplace({
      pluginCount: 2,
      plugins: [alpha, beta],
    });
    await mountMarketplaces([marketplace]);
    await openMarketplaceRow(marketplace.id);

    // Asserted at the SNAPSHOT level, which is what App Advisor actually
    // reads. Task 2 had to drop to the raw slice while
    // `buildCurrentUiStateSnapshot` still gated all of `snapshot.plugins` on
    // the removed `activeTab`; Task 4 rewrote that gate, so the original
    // assertion is restored.
    expect(marketplaceModalSnapshot()).toMatchObject({
      open: true,
      marketplaceId: marketplace.id,
      marketplaceName: marketplace.name,
      pluginCount: 2,
      filteredPluginCount: 2,
      missingPluginCount: 2,
      selectedPlugin: null,
      bulkInstall: { installing: false, cancelling: false },
    });

    const bulkButton = requireButton(
      container.querySelector('[data-testid="bulk-install-plugins"]'),
      'Bulk install button',
    );
    await act(async () => {
      bulkButton.click();
      await Promise.resolve();
    });

    expect(marketplaceModalSnapshot()).toMatchObject({
      bulkInstall: {
        installing: true,
        cancelling: false,
        progress: { done: 0, total: 2 },
      },
    });

    act(() => {
      bulkButton.click();
    });
    await settle();

    expect(marketplaceModalSnapshot()).toMatchObject({
      bulkInstall: { installing: true, cancelling: true },
    });

    await act(async () => {
      firstInstall.resolve(
        okResult(makePlugin({ name: 'alpha-tool', details: emptyDetails })),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(marketplaceModalSnapshot()).toMatchObject({
      bulkInstall: {
        installing: false,
        cancelling: false,
        summary: 'Installed 1 of 2 (cancelled)',
      },
    });
  });

  it('keeps detail updates keyed by the original marketplace plugin name', async () => {
    const marketplace = makeMarketplace({
      pluginCount: 1,
      plugins: [makePlugin({ name: 'marketplace-name' })],
    });
    await mountMarketplaces([marketplace]);
    await openMarketplaceRow(marketplace.id);
    await click(
      container.querySelector('[data-testid="plugin-row-marketplace-name"]'),
      'Customize plugin row',
    );

    expect(requirePluginDetailViewProps().plugin.name).toBe('marketplace-name');

    act(() => {
      requirePluginDetailViewProps().onPluginUpdated(
        makePlugin({ name: 'manifest-name', details: emptyDetails }),
      );
    });
    await settle();

    expect(requirePluginDetailViewProps().plugin.name).toBe('manifest-name');

    act(() => {
      const props = requirePluginDetailViewProps();
      props.onPluginUpdated({ ...props.plugin, codexCompatDisabled: true });
    });
    await settle();

    expect(requirePluginDetailViewProps().plugin.codexCompatDisabled).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // Management view — marketplace removal
  // -------------------------------------------------------------------------

  it('renders the marketplace overflow menu outside the clipping table', async () => {
    const marketplace = makeMarketplace();
    await mountMarketplaces([marketplace]);

    await click(
      container.querySelector('button[aria-label="More marketplace actions"]'),
      'Overflow menu button',
    );

    const removeAction = requireElement(
      document.querySelector('[data-testid="remove-marketplace-action"]'),
      'Remove Marketplace menu item',
    );
    // The removal row keeps its red tone and leads with an icon.
    expect(removeAction.firstElementChild?.querySelector('svg')).toBeInstanceOf(
      Element,
    );
    // The table wrapper clips overflow, so an in-row menu on the last row is
    // cut off. The menu must portal out of the table.
    expect(
      container
        .querySelector(`[data-testid="marketplace-row-${marketplace.id}"]`)
        ?.closest('table')
        ?.contains(removeAction),
    ).toBe(false);

    await click(removeAction, 'Remove Marketplace menu item');

    // A portaled click still bubbles through the React tree; it must not
    // also open the marketplace row behind the menu.
    expect(document.body.textContent).toContain(
      'Canopy will remove this marketplace from Claude and Codex.',
    );
    expect(
      useCurrentUiStateStore.getState().slices['plugins.managementView'],
    ).toMatchObject({ section: 'marketplaces' });
    expect(
      container.querySelector(
        `[data-testid="marketplace-row-${marketplace.id}"]`,
      ),
    ).not.toBeNull();
  });

  it('confirms removal and drops the row when removeMarketplace returns marketplace: null', async () => {
    const marketplace = makeMarketplace();
    await mountMarketplaces([marketplace]);

    await click(
      container.querySelector('button[aria-label="More marketplace actions"]'),
      'Overflow menu button',
    );
    await click(
      document.querySelector('[data-testid="remove-marketplace-action"]'),
      'Remove Marketplace menu item',
    );

    expect(document.body.textContent).toContain(
      'Canopy will remove this marketplace from Claude and Codex.',
    );
    // The removal-confirm state moved off `plugins.page` (now discovery-scoped)
    // onto the management view's own slice.
    expect(
      useCurrentUiStateStore.getState().slices['plugins.managementView'],
    ).toMatchObject({
      section: 'marketplaces',
      removeMarketplaceModal: {
        marketplaceId: marketplace.id,
        marketplaceName: marketplace.name,
      },
    });

    const removalResult: MarketplaceRemovalResult = {
      marketplace: null,
      removedProviders: ['claude', 'codex'],
      providerOutcomes: {
        claude: { removed: true, alreadyAbsent: false },
        codex: { removed: true, alreadyAbsent: false },
      },
    };
    pluginsApi.removeMarketplace.mockResolvedValue(okResult(removalResult));

    const confirmButton = requireButton(
      document.querySelector(
        '[data-testid="remove-marketplace-confirm-button"]',
      ),
      'Remove confirmation button',
    );
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(pluginsApi.removeMarketplace).toHaveBeenCalledWith(marketplace.id);
    expect(pluginsApi.refreshMarketplaces).not.toHaveBeenCalled();
    expect(pluginsApi.loadMarketplaces).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(
        `[data-testid="marketplace-row-${marketplace.id}"]`,
      ),
    ).toBeNull();
  });

  it('surfaces partial-failure toast when one provider returns an error', async () => {
    const marketplace = makeMarketplace();
    await mountMarketplaces([marketplace]);

    await click(
      container.querySelector('button[aria-label="More marketplace actions"]'),
      'Overflow menu button',
    );
    await click(
      document.querySelector('[data-testid="remove-marketplace-action"]'),
      'Remove Marketplace menu item',
    );

    const partial: MarketplaceRemovalResult = {
      marketplace,
      removedProviders: ['claude'],
      providerOutcomes: {
        claude: { removed: true, alreadyAbsent: false },
        codex: {
          removed: false,
          alreadyAbsent: false,
          error: 'Codex refused removal',
        },
      },
    };
    pluginsApi.removeMarketplace.mockResolvedValue(okResult(partial));

    const confirmButton = requireButton(
      document.querySelector(
        '[data-testid="remove-marketplace-confirm-button"]',
      ),
      'Remove confirmation button',
    );
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    const toast = container.querySelector(
      '[data-testid="marketplace-removal-toast"]',
    );
    expect(toast?.textContent).toContain('Codex refused removal');
    expect(
      container.querySelector(
        `[data-testid="marketplace-row-${marketplace.id}"]`,
      ),
    ).not.toBeNull();
    expect(pluginsApi.refreshMarketplaces).not.toHaveBeenCalled();
  });
  // -------------------------------------------------------------------------
  // Unified entry detail wrapper (Task 4 / spec section 4)
  // -------------------------------------------------------------------------

  it('opens the polished catalog detail for a Suggested plugin entry', async () => {
    await mount({
      marketplaces: [
        makeCuratedMarketplace(
          [
            makePlugin({
              name: 'bigquery',
              displayName: 'BigQuery',
              description: 'Query warehouse data.',
              category: 'analytics',
              marketplaceId: 'curated/cloud',
              curated: true,
              providerSupport: { claude: 'native', codex: 'native' },
            }),
          ],
          { sourceType: 'codex' },
        ),
      ],
    });
    await openEntry('curated:bigquery');

    expect(entryDetail()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="plugin-catalog-detail"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="plugin-catalog-detail"] button[aria-label="Back"]',
      ),
    ).toBeNull();
    expect(entryDetail()?.textContent).not.toContain('Back to plugins');
    expect(mockPluginDetailViewProps).toBeNull();
    // Share is page chrome at the top right of the Back row, not part of
    // the catalog summary beside Add.
    expect(
      document.querySelector(
        '[data-testid="plugin-catalog-detail"] [data-testid="plugins-entry-detail-share"]',
      ),
    ).toBeNull();
    const share = requireButton(
      document.querySelector('[data-testid="plugins-entry-detail-share"]'),
      'Suggested plugin Share button',
    );
    expect(share.textContent).toBe('Share');
    await click(share, 'Suggested plugin Share button');
    expect(mockRequestShare).toHaveBeenCalledWith(
      {
        title: 'Sign in to share plugins',
        description: 'Connect your account to create a public plugin link.',
      },
      expect.any(Function),
      undefined,
    );

    await click(
      document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"]',
      ),
      'Suggested plugin Add button',
    );
    const props = requirePluginDetailViewProps();
    expect(props.plugin.name).toBe('bigquery');
    expect(props.marketplace.id).toBe('curated/cloud');
  });

  it('opens the existing plugin detail view for a marketplace plugin entry', async () => {
    await mountFullFixture();
    await openEntry('mkt:mkt-1/alpha-tool');

    expect(entryDetail()).not.toBeNull();
    const props = requirePluginDetailViewProps();
    expect(props.plugin.name).toBe('alpha-tool');
    expect(props.marketplace.id).toBe('mkt-1');
  });

  it.each(['top-level', 'claude', 'codex'] as const)(
    'retains app installation after Add and reopening when content is %s',
    async (contentLocation) => {
      const plugin = makePlugin();
      await mount({
        marketplaces: [makeMarketplace({ plugins: [plugin], pluginCount: 1 })],
      });
      await typeQuery('alpha-tool');
      const addSelector =
        '[data-testid="plugins-entry-add-mkt:mkt-1/alpha-tool"]';
      await click(container.querySelector(addSelector), 'Plugin Add');
      const installed = makePlugin({
        details: contentLocation === 'top-level' ? emptyDetails : null,
        facets:
          contentLocation === 'top-level'
            ? {}
            : {
                [contentLocation]: {
                  provider: contentLocation,
                  mode: 'native',
                  name: plugin.name,
                  installLocation: '/tmp/plugin-cache',
                  sourcePath: '',
                  details: emptyDetails,
                },
              },
        globalInstallStatus: {
          claude: { available: true, installed: false },
          codex: { available: true, installed: false },
        },
      });
      act(() => requirePluginDetailViewProps().onPluginUpdated(installed));
      await settle();
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-root"]',
        ),
        'Customize breadcrumb',
      );
      expect(container.querySelector(addSelector)).toBeNull();
      await typeQuery('');
      expect(installedTileIds()).toContain('mkt:mkt-1/alpha-tool');
      await openEntry('mkt:mkt-1/alpha-tool');
      expect(requirePluginDetailViewProps().plugin).toEqual(installed);
      expect(requirePluginDetailViewProps().plugin.globalInstallStatus).toEqual(
        installed.globalInstallStatus,
      );
    },
  );

  it('renders plugin detail as a breadcrumb sub-page and preserves browse filters', async () => {
    await mountFullFixture();
    await typeQuery('alpha-tool');
    await openEntry('mkt:mkt-1/alpha-tool');

    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumbs"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Alpha Tool');
    expect(entryDetail()?.getAttribute('role')).not.toBe('dialog');

    await click(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-root"]',
      ),
      'Customize breadcrumb',
    );

    expect(entryDetail()).toBeNull();
    const search = requireElement<HTMLInputElement>(
      container.querySelector('[data-testid="plugins-search"]'),
      'Customize search',
    );
    expect(search.value).toBe('alpha-tool');
  });

  it('opens connection details for a removed catalog entry', async () => {
    await mount({
      mcpServers: [makeMcpServer({ curatedKey: 'removed-from-catalog' })],
      curatedMcpServers: [],
    });
    await typeQuery('github');
    await openEntry('mcp-local:srv-github');
    expect(mcpServerDialog()).toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="plugin-advanced-configuration"]'),
    ).not.toBeNull();
  });

  it.each(['flat', 'nested'] as const)(
    'retains the selected local connection when its curated catalog arrives late: %s',
    async (shape) => {
      const base = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...base,
          status: 'ready',
          values: {
            ...base.values,
            [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]: true,
          },
        },
      });
      try {
        const catalog = createDeferred<{ servers: CuratedMcpServerEntry[] }>();
        configureApis({
          mcpServers: [makeMcpServer({ id: 'other-github' }), makeMcpServer()],
          mcpStatuses: [
            makeMcpStatus({
              configs: [{ configId: 'cfg-1', authStatus: 'connected' }],
            }),
          ],
        });
        mcpServersApi.listCurated.mockReturnValue(catalog.promise);
        mcpServersApi.loadServer.mockResolvedValue({
          server: {
            definition: {
              id: 'srv-github',
              name: 'GitHub',
              type: 'http',
              url: 'https://mcp.github.com',
              oauth: { usePkce: true },
            },
            configs: [{ id: 'cfg-1', enabled: true }],
          },
        });
        await renderPage();
        await typeQuery('github');
        await openEntry('mcp-local:srv-github');
        expect(mcpServerDialog()).toBeNull();
        if (shape === 'nested') {
          mcpServersApi.loadIndex.mockResolvedValue({
            version: 1,
            servers: [
              makeMcpServer({
                id: 'github',
                scope: 'account',
                deviceCopies: [makeMcpServer()],
              }),
            ],
          });
          act(() => {
            window.dispatchEvent(new Event('focus'));
          });
          await settle();
        }
        await act(async () => {
          catalog.resolve({ servers: [makeCuratedMcp()] });
          await Promise.resolve();
        });
        await settle();
        expect(mcpServersApi.loadServer).toHaveBeenCalledWith('srv-github');
        expect(mcpServersApi.loadServer).not.toHaveBeenCalledWith(
          'other-github',
        );
        expect(
          document.querySelector('[data-testid="plugin-account-connection"]')
            ?.textContent,
        ).toContain('GitHub is connected on this desktop');
        await click(
          document.querySelector(
            '[data-testid="plugin-advanced-configuration"]',
          ),
          'Advanced configuration',
        );
        expect(mcpServerDialog()?.textContent).toContain('Edit MCP server');
        expect(mcpServersApi.saveServer).not.toHaveBeenCalled();
      } finally {
        useFeatureFlagsStore.setState({ snapshot: base });
      }
    },
  );

  it('offers a signed-out viewer Try it beside the curated connect action (CAN-4359)', async () => {
    defineWindowApi('api', {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ mcpHttpAuthDefaultHandler: 'canopy' }),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
        read: 'ok',
      }),
    });
    await mount({
      curatedMcpServers: [
        makeCuratedMcp({
          key: 'public',
          name: 'Public docs',
          tryNowPrompt: 'Find the install guide.',
        }),
      ],
    });
    await openEntry('mcp-catalog:public');
    const ctas = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="detail-primary-cta"]',
    );
    expect(ctas).toHaveLength(1);
    expect(ctas[0]?.dataset.state).toBe('try');
    expect(ctas[0]?.textContent).toBe('Try it');
    // Connecting a device server needs no account, so it stays available.
    await click(
      document.querySelector('[data-testid="mcp-browse-detail-add"]'),
      'Connect beside Try it',
    );
    expect(mcpServersApi.saveServer).toHaveBeenCalled();
  });

  it('adds a public curated server without inventing an OAuth requirement', async () => {
    await mount({
      curatedMcpServers: [
        makeCuratedMcp({ key: 'public', name: 'Public docs' }),
      ],
    });
    await openEntry('mcp-catalog:public');
    await click(
      document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"]',
      ),
      'Add public server',
    );
    expect(mcpServersApi.saveServer).toHaveBeenCalled();
    expect(mcpServersApi.saveServer.mock.calls).toMatchObject([
      [{ definition: { oauth: undefined } }],
    ]);
    expect(mcpServersApi.startOAuthLogin).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="plugin-account-connection"]')
        ?.textContent,
    ).toContain('Not required');
  });

  it('opens the curated app detail and starts a shared connection from Add', async () => {
    await mountFullFixture();
    // `linear` has no local server, so it is an `available` curated app.
    await openEntry('mcp-catalog:linear');

    expect(entryDetail()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="mcp-browse-back"]'),
    ).toBeNull();
    expect(entryDetail()?.textContent).not.toContain('Back to plugins');
    expect(mcpServerDialog()).toBeNull();

    await click(
      document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"]',
      ),
      'Curated detail Add button',
    );

    expect(mcpServerDialog()).toBeNull();
    expect(mcpServersApi.saveServer.mock.calls).toMatchObject([
      [
        {
          definition: {
            name: 'Linear',
            httpAuthHandler: 'canopy',
            oauth: { usePkce: true },
          },
        },
      ],
    ]);
    expect(mcpServersApi.startOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'new-server', browser: 'embedded' }),
    );
  });

  /**
   * Every detail sub-page opened straight from the marketplace has to offer
   * the same way out. Plugin details looked correct only by accident: their
   * content renders its own Back. Branches without one — connectors, curated
   * apps, skills, collections — left the breadcrumb as the sole exit.
   */
  it('offers Back out of a detail page opened straight from the marketplace', async () => {
    await mount({
      marketplaces: [makeCuratedMarketplace(CURATED_PLUGINS)],
      curatedMcpServers: [
        makeCuratedMcp({
          key: 'gmail',
          name: 'Gmail',
          shortDescription: 'Read and send mail.',
          categories: ['productivity'],
          providerConnector: { providers: ['claude', 'codex'] },
        }),
        makeCuratedMcp({
          key: 'linear',
          name: 'Linear',
          shortDescription: 'Track issues and projects.',
          categories: ['productivity'],
        }),
      ],
    });

    // The connector folds into the Gmail integration card (REG-3033): one
    // card, with the provider route as a binding on its detail.
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-provider-connector:Gmail"]',
      ),
    ).toBeNull();
    await openEntry('mcp-catalog:gmail');
    expect(
      document.querySelector('[data-testid="plugins-entry-connector-binding"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="provider-connector-detail"]'),
    ).not.toBeNull();
    await leaveDetailByCrumb(
      'root',
      'Provider connector detail Customize crumb',
    );
    expect(entryDetail()).toBeNull();

    await openEntry('mcp-catalog:linear');
    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
    await leaveDetailByCrumb('root', 'Curated app detail Customize crumb');
    expect(entryDetail()).toBeNull();
  });

  /**
   * The provider connector folded into an integration card (REG-3033) used to
   * render its own header above the card's, so the page showed the service
   * twice and nothing said which rows belonged to which route. The detail now
   * has one header, then the app's own MCP server, then the provider
   * connections.
   */
  it('separates the provider connections from the app MCP server under one header', async () => {
    await mount({
      marketplaces: [makeCuratedMarketplace(CURATED_PLUGINS)],
      curatedMcpServers: [
        makeCuratedMcp({
          key: 'gmail',
          name: 'Gmail',
          shortDescription: 'Read and send mail.',
          categories: ['productivity'],
          oauthHints: { usePkce: true },
          providerConnector: { providers: ['claude', 'codex'] },
        }),
      ],
    });
    await openEntry('mcp-catalog:gmail');

    const detail = document.querySelector('[data-testid="mcp-browse-detail"]');
    expect(detail).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="provider-connector-detail-header"]',
      ),
    ).toBeNull();
    expect(
      Array.from(detail?.querySelectorAll('h3') ?? []).filter(
        (heading) => heading.textContent === 'Gmail',
      ),
    ).toHaveLength(1);

    const appRoute = document.querySelector(
      '[data-testid="mcp-browse-detail-app-route"]',
    );
    expect(appRoute?.querySelector('h3')?.textContent).toBe(
      `${brandText.appName} MCP server`,
    );
    expect(
      appRoute?.querySelector('[data-testid="plugin-account-connection"]'),
    ).not.toBeNull();
    expect(
      appRoute?.querySelector('[data-testid="mcp-browse-tools"]'),
    ).not.toBeNull();

    const providers = document.querySelector(
      '[data-testid="provider-connector-detail"]',
    );
    expect(providers?.querySelector('h3')?.textContent).toBe(
      'Provider connections',
    );
    expect(appRoute?.contains(providers ?? null)).toBe(false);
    expect(
      appRoute && providers
        ? appRoute.compareDocumentPosition(providers) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
  });

  /**
   * CAN-4261: a plugin detail page draws no Back at all (neither the shell's
   * nor the plugin view's own); the breadcrumb above the title is the exit.
   */
  it('leaves the plugin detail page through its breadcrumb, without Back', async () => {
    await mountFullFixture();
    await openEntry('mkt:mkt-1/alpha-tool');

    expect(requirePluginDetailViewProps().onBack).toBeUndefined();
    await leaveDetailByCrumb('root', 'Plugin detail Customize crumb');
    await settle();

    expect(entryDetail()).toBeNull();
  });

  /**
   * A related-entry hop keeps its origin in the breadcrumb's reach: the page
   * shows no Back (CAN-4261), and the app's own history returns to it.
   */
  it('shows no Back on a plugin page opened from a related entry', async () => {
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: {
        kind: 'entry-detail',
        entryId: 'mkt:mkt-1/alpha-tool',
        from: { kind: 'entry', entryId: 'curated:writer-toolkit' },
      },
    });

    await mountFullFixture();

    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Alpha Tool');
    expect(
      container.querySelectorAll('[data-testid="plugins-entry-detail-back"]'),
    ).toHaveLength(0);
    expect(requirePluginDetailViewProps().onBack).toBeUndefined();
  });

  /**
   * The stale-entry state is the one most in need of an exit — there is
   * nothing on the page to act on — and it reaches `DetailShell` through
   * `MissingEntryDetail` rather than a resolved branch, so it needs its own
   * wiring and its own case.
   */
  it('offers Back from a detail whose source object disappeared', async () => {
    const pipeline: PipelineInfo = {
      id: 'review-pipeline',
      name: 'Review Pipeline',
      filename: '',
      description: 'Review a change before release.',
      icon: '',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      source: 'user',
      readonly: false,
      triggerTypes: ['dispatch'],
      scopes: ['worktree'],
    };
    mockCapabilityMarketplaceInventory.pipelines = [pipeline];
    useNavigationStore.setState({ activePage: 'plugins' });

    await mount();
    await openEntry('pipeline:user:review-pipeline');
    expect(
      document.querySelector('[data-testid="pipeline-catalog-detail"]'),
    ).not.toBeNull();

    // The pipeline is gone from the refreshed inventory while its detail is
    // still open; `retainedDetailEntry` keeps the row, so the branch falls
    // through to the missing-entry state.
    mockCapabilityMarketplaceInventory.pipelines = [];
    await renderPage();

    expect(
      document.querySelector('[data-testid="pipeline-catalog-detail"]'),
    ).toBeNull();
    expect(entryDetail()?.textContent).toContain(
      'This item is no longer available.',
    );

    await leaveDetailByCrumb('root', 'Missing entry detail Customize crumb');

    expect(entryDetail()).toBeNull();
  });

  // The bridge notifies every live subscriber, so the detail and its
  // management sections both hear one auth change.
  function authChangedBroadcast(): () => void {
    if (authChangedListeners.size === 0)
      throw new Error('Missing auth change subscription');
    return (): void => {
      Array.from(authChangedListeners).forEach((listener) => listener());
    };
  }

  async function openInstalledCuratedConnection(): Promise<void> {
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: 'srv-github',
          name: 'GitHub',
          type: 'http',
          oauth: { usePkce: true },
        },
        configs: [{ id: 'cfg-1', enabled: true }],
      },
    });
    await mountFullFixture();
    act(() => {
      useNavigationStore.getState().openPluginsNavigation({
        kind: 'entry-detail',
        entryId: 'mcp-catalog:github',
      });
    });
    await settle();
  }

  it.each([undefined, 'previous-error'])(
    'settles an unversioned OAuth failure after starting with revision %p',
    async (startingRevision) => {
      mcpServersApi.listStatus.mockResolvedValue([
        makeMcpStatus({
          configs: [
            {
              configId: 'cfg-1',
              authStatus: startingRevision ? 'error' : 'required',
              authErrorRevision: startingRevision,
              lastError: startingRevision
                ? 'Previous attempt failed'
                : undefined,
            },
          ],
        }),
      ]);
      mcpServersApi.startOAuthLogin.mockResolvedValue({
        status: 'started',
        authorizationUrl: 'about:blank',
        flowId: 'test-flow',
      });
      await openInstalledCuratedConnection();
      act(() =>
        requireButton(
          container.querySelector(
            '[data-testid="detail-primary-cta"][data-state="install"]',
          ),
          'Connect',
        ).click(),
      );
      await settle();
      expect(
        container.querySelector('[data-testid="plugin-oauth-browser"]'),
      ).not.toBeNull();
      expect(mcpServersApi.cancelOAuthLogin).not.toHaveBeenCalled();
      mcpServersApi.listStatus.mockResolvedValue([
        makeMcpStatus({
          configs: [
            {
              configId: 'cfg-1',
              authStatus: 'error',
              lastError: 'Secure storage unavailable',
            },
          ],
        }),
      ]);
      act(() => authChangedBroadcast()());
      await settle();
      expect(
        container.querySelector('[data-testid="plugin-oauth-browser"]'),
      ).toBeNull();
      expect(entryDetail()?.textContent).toContain(
        'Secure storage unavailable',
      );
      expect(mcpServersApi.cancelOAuthLogin).toHaveBeenCalledWith('test-flow');
      expect(
        requireButton(
          container.querySelector('[data-testid="detail-primary-cta"]'),
          'Connect',
        ).disabled,
      ).toBe(false);
    },
  );

  it('lists an added curated server by harness without listing the app', async () => {
    await openInstalledCuratedConnection();
    expect(
      document.querySelector('[data-testid="plugin-harness-claude"] td')
        ?.textContent,
    ).toBe('Installed');
    expect(
      document.querySelector('[data-testid="plugin-harness-app"]'),
    ).toBeNull();
  });

  it('lists harnesses as not installed before a curated server is added', async () => {
    await mountFullFixture();
    // `linear` has no local server, so it is an `available` curated app.
    await openEntry('mcp-catalog:linear');
    expect(
      document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="plugin-harness-claude"] td')
        ?.textContent,
    ).toBe('Not installed');
    expect(
      document.querySelector('[data-testid="plugin-harness-app"]'),
    ).toBeNull();
  });

  it('clears a recovered status-read error', async () => {
    await openInstalledCuratedConnection();
    const authChanged = authChangedBroadcast();
    mcpServersApi.loadServer.mockRejectedValueOnce(
      new Error('Temporary status read failure'),
    );
    act(() => authChanged());
    await settle();
    expect(entryDetail()?.textContent).toContain(
      'Temporary status read failure',
    );
    mcpServersApi.listStatus.mockResolvedValue([
      makeMcpStatus({
        configs: [{ configId: 'cfg-1', authStatus: 'connected' }],
      }),
    ]);
    act(() => authChanged());
    await settle();
    expect(entryDetail()?.textContent).toContain(
      'GitHub is connected on this desktop',
    );
    expect(entryDetail()?.textContent).not.toContain(
      'Temporary status read failure',
    );
  });

  it('keeps an action setup error during successful status refreshes', async () => {
    await openInstalledCuratedConnection();
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: 'srv-github',
          name: 'GitHub',
          type: 'http',
          oauth: { usePkce: true },
        },
        configs: [],
      },
    });
    const authChanged = authChangedBroadcast();
    act(() => authChanged());
    await settle();
    act(() =>
      requireButton(
        container.querySelector(
          '[data-testid="detail-primary-cta"][data-state="install"]',
        ),
        'Connect',
      ).click(),
    );
    await settle();
    expect(entryDetail()?.textContent).toContain('Enable a configuration');
    act(() => authChanged());
    await settle();
    expect(entryDetail()?.textContent).toContain('Enable a configuration');
  });

  it('ignores an older failed status read after a newer successful read', async () => {
    await openInstalledCuratedConnection();
    const authChanged = authChangedBroadcast();
    const oldRead = createDeferred<void>();
    mcpServersApi.loadServer.mockReturnValueOnce(
      oldRead.promise.then(() => {
        throw new Error('Stale status failure');
      }),
    );
    act(() => authChanged());
    act(() => authChanged());
    await settle();
    act(() => oldRead.resolve());
    await settle();
    expect(entryDetail()?.textContent).not.toContain('Stale status failure');
  });

  it('says a signed-in server is in no project yet and adds it to one', async () => {
    const originalApi = window.api;
    const saveProjectDefaultPlugins = jest
      .fn<
        Promise<void>,
        [{ projectId: string; defaultPluginSelections: unknown }]
      >()
      .mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...originalApi, saveProjectDefaultPlugins },
    });
    const project = {
      type: 'single-repo' as const,
      id: 'proj-acme',
      name: 'Acme',
      repoPath: '/repo',
      color: '#111111',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const previousProjects = useProjectsStore.getState();
    useProjectsStore.setState({
      projects: [project],
      loadProjects: jest.fn((): Promise<void> => {
        useProjectsStore.setState({
          projects: [
            {
              ...project,
              defaultPluginSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [{ serverId: 'srv-github', configId: 'cfg-1' }],
              },
            },
          ],
        });
        return Promise.resolve();
      }),
    });
    try {
      await openInstalledCuratedConnection();
      mcpServersApi.listStatus.mockResolvedValue([
        makeMcpStatus({
          configs: [{ configId: 'cfg-1', authStatus: 'connected' }],
        }),
      ]);
      act(() => authChangedBroadcast()());
      await settle();
      const status = (): string | null | undefined =>
        document.querySelector(
          '[data-testid="mcp-browse-detail-projects-status"]',
        )?.textContent;
      expect(status()).toBe(
        'Not in any project yet. Chats use it once you add it to a project or turn it on in a chat.',
      );
      expect(saveProjectDefaultPlugins).not.toHaveBeenCalled();
      await click(
        document.querySelector(
          '[data-testid="mcp-browse-detail-projects-add"]',
        ),
        'Add to Acme',
      );
      await settle();
      const [saved] = saveProjectDefaultPlugins.mock.calls[0];
      expect(saved.projectId).toBe('proj-acme');
      expect(saved.defaultPluginSelections).toMatchObject({
        mcpServerRefs: [{ serverId: 'srv-github', configId: 'cfg-1' }],
      });
      expect(status()).toBe('Enabled in Acme.');
      expect(
        document.querySelector(
          '[data-testid="mcp-browse-detail-projects-remove"]',
        ),
      ).not.toBeNull();
    } finally {
      useProjectsStore.setState(previousProjects, true);
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('keeps checking a credential expiry beyond the maximum timer delay', async () => {
    jest.useFakeTimers();
    try {
      await openInstalledCuratedConnection();
      const authChanged = authChangedBroadcast();
      const expiresAt = Date.now() + 2_147_483_647 + 10_000;
      mcpServersApi.listStatus.mockImplementation(() =>
        Promise.resolve([
          makeMcpStatus({
            configs: [
              {
                configId: 'cfg-1',
                authStatus: Date.now() < expiresAt ? 'connected' : 'expired',
                expiresAt: new Date(expiresAt).toISOString(),
              },
            ],
          }),
        ]),
      );
      act(() => authChanged());
      await settle();
      expect(entryDetail()?.textContent).toContain(
        'GitHub is connected on this desktop',
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_147_483_647);
      });
      await settle();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      await settle();
      expect(entryDetail()?.textContent).toContain(
        "GitHub isn't connected on this desktop",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['error', undefined, true],
    ['expired', true, false],
    ['expired', false, true],
    ['expired', undefined, true],
  ] as const)(
    'reads saved auth status before reconnecting: %s / refresh=%s',
    async (authStatus, canRefresh, force) => {
      mcpServersApi.loadServer.mockResolvedValue({
        server: {
          definition: {
            id: 'srv-github',
            name: 'GitHub',
            description: '',
            type: 'http',
            url: 'https://mcp.github.com',
            oauth: { usePkce: true },
          },
          configs: [
            {
              id: 'cfg-1',
              name: 'Default',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
            },
          ],
        },
      });
      await mountFullFixture();
      mcpServersApi.listStatus.mockResolvedValue([
        makeMcpStatus({
          configs: [
            {
              configId: 'cfg-1',
              authStatus,
              canRefresh,
              ...(authStatus === 'error'
                ? {
                    authErrorRevision: 'old-error',
                    lastError: 'Previous attempt failed',
                  }
                : {}),
            },
          ],
        }),
      ]);
      act(() => {
        const navigation = useNavigationStore.getState();
        navigation.openPluginsNavigation({
          kind: 'entry-detail',
          entryId: 'mcp-catalog:github',
          intent: 'connect',
        });
      });
      await settle();
      expect(mcpServersApi.startOAuthLogin).toHaveBeenCalledWith({
        serverId: 'srv-github',
        configId: 'cfg-1',
        force,
        browser: 'embedded',
      });
    },
  );

  it('does not start sign-in after leaving a detail while saved status loads', async () => {
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: 'srv-github',
          name: 'GitHub',
          description: '',
          type: 'http',
          url: 'https://mcp.github.com',
          oauth: { usePkce: true },
        },
        configs: [
          {
            id: 'cfg-1',
            name: 'Default',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
          },
        ],
      },
    });
    await mountFullFixture();
    const freshStatus = createDeferred<McpServerStatusEntry[]>();
    mcpServersApi.listStatus.mockReturnValue(freshStatus.promise);
    act(() => {
      const navigation = useNavigationStore.getState();
      navigation.openPluginsNavigation({
        kind: 'entry-detail',
        entryId: 'mcp-catalog:github',
        intent: 'connect',
      });
    });
    await settle();
    await leaveDetailByCrumb('root', 'Detail Customize crumb');
    await act(async () => {
      freshStatus.resolve([]);
      await Promise.resolve();
    });
    await settle();
    expect(mcpServersApi.startOAuthLogin).not.toHaveBeenCalled();
  });

  it('renders an installed curated app as a sub-page with a configuration dialog overlay', async () => {
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: 'srv-github',
          name: 'GitHub',
          description: 'GitHub MCP server.',
          type: 'http',
          url: 'https://mcp.github.com',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        configs: [],
      },
    });
    await mountFullFixture();
    await typeQuery('github');

    await openEntry('mcp-catalog:github');

    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('GitHub');
    expect(entryDetail()?.getAttribute('role')).not.toBe('dialog');
    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
    expect(mcpServerDialog()).toBeNull();

    await click(
      document.querySelector('[data-testid="plugin-advanced-configuration"]'),
      'Advanced configuration',
    );

    expect(entryDetail()).not.toBeNull();
    expect(mcpServerDialog()).not.toBeNull();
    expect(mcpServersApi.loadServer).toHaveBeenCalledWith('srv-github');

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    await settle();

    expect(mcpServerDialog()).toBeNull();
    expect(entryDetail()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
  });

  it('starts connecting directly from a marketplace Add button', async () => {
    await mountFullFixture();

    await click(
      container.querySelector(
        '[data-testid="plugins-entry-add-mcp-catalog:linear"]',
      ),
      'Linear Add button',
    );

    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
    expect(mcpServerDialog()).toBeNull();
    expect(mcpServersApi.saveServer).toHaveBeenCalled();
    expect(mcpServersApi.startOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ browser: 'embedded' }),
    );
  });

  it('keeps a curated app on its detail page when its configurations need enabling', async () => {
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: 'srv-github',
          name: 'GitHub',
          description: 'GitHub MCP server.',
          type: 'http',
          url: 'https://mcp.github.com',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        configs: [],
      },
    });
    await mountFullFixture();
    // Installed/needs-auth entries live in the search-mode Installed band;
    // browse mode only shows recommended/curated/marketplace.
    await typeQuery('github');

    // `github` is installed locally with `connectionStatus: auth_required`, so
    // its card menu offers "Connect", which must land on the existing auth flow
    // (the server editor), not the catalog detail.
    const menu = await openEntryMenu('mcp-catalog:github');
    await click(
      menu.querySelector(
        '[data-testid="plugins-menu-connect-mcp-catalog:github"]',
      ),
      'GitHub Connect menu item',
    );

    expect(mcpServerDialog()).toBeNull();
    expect(mcpServersApi.loadServer).toHaveBeenCalledWith('srv-github');
    expect(
      document.querySelector('[data-testid="mcp-browse-detail"]'),
    ).not.toBeNull();
    expect(entryDetail()?.textContent).toContain('Enable a configuration');
  });

  it.each(['command', 'http'] as const)(
    'opens local %s connection details before its existing editor',
    async (type) => {
      mcpServersApi.loadServer.mockResolvedValue({
        server: {
          definition: {
            id: 'srv-local',
            name: 'Local Tools',
            description: 'Local stdio server.',
            type,
            command: type === 'command' ? 'local-tools' : undefined,
            url: type === 'http' ? 'https://local.example.test/mcp' : undefined,
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
          configs: [
            {
              id: 'cfg-1',
              name: 'Default',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
            },
          ],
        },
      });
      await mount({
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'srv-local',
            transport: type,
            connectionStatus: 'unknown',
            configs: [
              {
                configId: 'cfg-1',
                authStatus:
                  type === 'command' ? 'unsupported' : 'not_configured',
              },
            ],
          }),
        ],
        mcpServers: [
          makeMcpServer({
            id: 'srv-local',
            name: 'Local Tools',
            description: 'Local stdio server.',
            type,
            curatedKey: undefined,
          }),
        ],
      });
      await typeQuery('local');

      await openEntry('mcp-local:srv-local');

      expect(mcpServerDialog()).toBeNull();
      expect(entryDetail()).not.toBeNull();
      expect(mcpServersApi.loadServer).toHaveBeenCalledWith('srv-local');
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]')
          ?.textContent,
      ).toContain('Not required');
      expect(
        document.querySelector(
          '[data-testid="detail-primary-cta"][data-state="install"]',
        ),
      ).toBeNull();
      expect(mcpServersApi.startOAuthLogin).not.toHaveBeenCalled();
      await click(
        document.querySelector('[data-testid="plugin-advanced-configuration"]'),
        'Advanced configuration',
      );
      expect(mcpServerDialog()?.textContent).toContain('Edit MCP server');
      expect(mcpServerDialog()?.textContent).toContain('Health check');
      expect(mcpServerDialog()?.textContent).toContain('Test connection');
      expect(mcpServersApi.saveServer).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not auto-start OAuth for a command connection (stored OAuth: %s)',
    async (storedOAuth) => {
      const localServer = makeMcpServer({
        id: 'srv-command',
        type: 'command',
        curatedKey: undefined,
      });
      configureApis({
        mcpServers: [localServer],
        mcpStatuses: [
          makeMcpStatus({
            serverId: localServer.id,
            transport: 'command',
            connectionStatus: 'unknown',
            configs: [{ configId: 'cfg-1', authStatus: 'unsupported' }],
          }),
        ],
      });
      mcpServersApi.loadServer.mockResolvedValue({
        server: {
          definition: {
            id: localServer.id,
            name: 'Command tools',
            type: 'command',
            command: 'npx',
            ...(storedOAuth ? { oauth: { clientId: 'legacy-client' } } : {}),
          },
          configs: [
            {
              id: 'cfg-1',
              name: 'Default',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
            },
          ],
        },
      });
      await act(async () => {
        root.render(
          <CuratedMcpConnectionDetail
            localServer={localServer}
            installedServerId={localServer.id}
            autoConnect
            onServersChanged={() => Promise.resolve()}
          />,
        );
        await Promise.resolve();
      });
      await settle();
      expect(mcpServersApi.loadServer).toHaveBeenCalledWith(localServer.id);
      expect(mcpServersApi.startOAuthLogin).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]')
          ?.textContent,
      ).toContain('Not required');
      expect(
        document.querySelector(
          '[data-testid="detail-primary-cta"][data-state="install"]',
        ),
      ).toBeNull();
      expect(mcpServersApi.saveServer).not.toHaveBeenCalled();
    },
  );

  it('records the MCP connection detail in session replay', async () => {
    const localServer = makeMcpServer({
      id: 'srv-command',
      type: 'command',
      curatedKey: undefined,
    });
    configureApis({
      mcpServers: [localServer],
      mcpStatuses: [
        makeMcpStatus({
          serverId: localServer.id,
          transport: 'command',
          connectionStatus: 'unknown',
          configs: [{ configId: 'cfg-1', authStatus: 'unsupported' }],
        }),
      ],
    });
    mcpServersApi.loadServer.mockResolvedValue({
      server: {
        definition: {
          id: localServer.id,
          name: 'Command tools',
          type: 'command',
          command: 'npx',
        },
        configs: [
          {
            id: 'cfg-1',
            name: 'Default',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
          },
        ],
      },
    });
    await act(async () => {
      root.render(
        <CuratedMcpConnectionDetail
          localServer={localServer}
          installedServerId={localServer.id}
          onServersChanged={() => Promise.resolve()}
        />,
      );
      await Promise.resolve();
    });
    await settle();
    // The component returns a fragment; its first element holds the detail.
    const detailRoot = container.firstElementChild;
    expect(detailRoot).not.toBeNull();
    expect(detailRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    const connection = document.querySelector(
      '[data-testid="plugin-account-connection"]',
    );
    expect(connection).not.toBeNull();
    expect(connection?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  const FOLDED_GITHUB_PLUGIN = makePlugin({
    name: 'github',
    displayName: 'GitHub',
    description: 'GitHub skills.',
    category: 'developer-tools',
    marketplaceId: 'curated/cloud',
    curated: true,
    externalSource: undefined,
    providerSupport: { claude: 'native', codex: 'native' },
    details: {
      skills: [{ name: 'Triage', description: 'Triage issues.', path: 's' }],
      agents: [],
      commands: [],
      hooks: [],
      mcpServers: [
        { name: 'github', type: 'http', url: 'https://mcp.github.com' },
      ],
      lspServers: [],
      hasReadme: false,
    },
    globalInstallStatus: {
      claude: { available: true, installed: false },
      codex: { available: true, installed: false },
      checkedAt: '2026-05-01T00:00:00.000Z',
    },
  });

  function withAccountConnectionsFlag(): () => void {
    const base = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...base,
        status: 'ready',
        values: {
          ...base.values,
          [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]: true,
        },
      },
    });
    return (): void => useFeatureFlagsStore.setState({ snapshot: base });
  }

  it('keeps a device-backed folded card on its device server even when an account row shares the key (REG-3033)', async () => {
    // The account connection used to be resolved for every curated card, so
    // a device-backed card showed the account's status while Connect ran the
    // device sign-in and Advanced opened the account details.
    const restore = withAccountConnectionsFlag();
    try {
      const connection = {
        id: 'conn-github',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        status: 'CONNECTED' as const,
        routeId: 'route',
        enabledTools: null,
        kind: 'CURATED' as const,
      };
      const device = makeMcpServer({ id: 'srv-github' });
      mcpServersApi.loadServer.mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: 'srv-github',
            name: 'GitHub',
            description: '',
            type: 'http',
            url: 'https://mcp.github.com',
            oauth: { usePkce: true },
            curated: { key: 'github' },
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
          configs: [
            {
              id: 'cfg-1',
              name: 'default',
              description: '',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-05-01T00:00:00.000Z',
              updatedAt: '2026-05-01T00:00:00.000Z',
            },
          ],
        },
      });
      await mount({
        marketplaces: [makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN])],
        mcpServers: [
          makeMcpServer({
            id: 'github',
            scope: 'account',
            accountConnectionId: connection.id,
            accountConnection: connection,
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            deviceCopies: [device],
          }),
        ],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'srv-github',
            connectionStatus: 'auth_required',
            configs: [{ configId: 'cfg-1', authStatus: 'not_connected' }],
          }),
        ],
        curatedMcpServers: [makeCuratedMcp()],
      });
      await typeQuery('github');
      await openEntry('mcp-catalog:github');
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]')
          ?.textContent,
      ).toContain("GitHub isn't connected on this desktop");
      // The device sign-in completes and the status read after it reports
      // the device configuration connected; the card settles on that.
      mcpServersApi.listStatus.mockResolvedValue([
        makeMcpStatus({
          serverId: 'srv-github',
          connectionStatus: 'connected',
          configs: [{ configId: 'cfg-1', authStatus: 'connected' }],
        }),
      ]);
      await click(
        document.querySelector(
          '[data-testid="detail-primary-cta"][data-state="install"]',
        ),
        'Connect',
      );
      expect(mcpServersApi.startOAuthLogin).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'srv-github' }),
      );
      expect(mcpServersApi.startAccountConnection).not.toHaveBeenCalled();
      await settle();
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]')
          ?.textContent,
      ).toContain('GitHub is connected on this desktop');
      expect(
        document.querySelector(
          '[data-testid="detail-primary-cta"][data-state="install"]',
        ),
      ).toBeNull();
      await click(
        document.querySelector('[data-testid="plugin-advanced-configuration"]'),
        'Advanced configuration',
      );
      expect(mcpServerDialog()).not.toBeNull();
      expect(
        document.querySelector('[data-testid="mcp-account-details"]'),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it('starts the account reconnect from Add on a disconnected account row without a second click (REG-3033)', async () => {
    const restore = withAccountConnectionsFlag();
    try {
      const connection = {
        id: 'conn-github',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        status: 'DISCONNECTED' as const,
        routeId: 'route',
        enabledTools: null,
        kind: 'CURATED' as const,
      };
      mcpServersApi.startAccountConnection.mockResolvedValue({
        connection: { ...connection, status: 'CONNECTED' },
      });
      await mount({
        marketplaces: [makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN])],
        mcpServers: [
          makeMcpServer({
            id: 'github',
            scope: 'account',
            accountConnectionId: connection.id,
            accountConnection: connection,
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            deviceCopies: [],
          }),
        ],
        curatedMcpServers: [makeCuratedMcp()],
      });
      await typeQuery('github');
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-add-mcp-catalog:github"]',
        ),
        'Add',
      );
      await settle();
      expect(mcpServersApi.startAccountConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverKey: 'github', configId: 'default' }),
      );
      expect(mcpServersApi.saveServer).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('connects and installs the folded plugin once when Add creates the account connection (REG-3033)', async () => {
    // The connection Add creates used to remount the open detail, whose Add
    // intent then connected and installed the folded plugin a second time.
    const restore = withAccountConnectionsFlag();
    const pending = {
      id: 'conn-github',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub',
      status: 'PENDING' as const,
      routeId: 'route',
      enabledTools: null,
      kind: 'CURATED' as const,
    };
    const accountRow = makeMcpServer({
      id: 'github',
      scope: 'account',
      accountConnectionId: pending.id,
      accountConnection: pending,
      configs: [{ id: 'default', name: 'Default', enabled: true }],
      deviceCopies: [],
    });
    defineWindowApi('mcpServers', {
      ...mcpServersApi,
      // The browser sign-in is still open while the detail shows the binding.
      awaitAccountConnection: jest.fn(() => new Promise(() => undefined)),
    });
    try {
      configureApis({
        marketplaces: [makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN])],
        curatedMcpServers: [makeCuratedMcp()],
      });
      mcpServersApi.loadIndex.mockResolvedValue({
        version: 1,
        servers: [],
        accountConnectionsAvailable: true,
      });
      mcpServersApi.startAccountConnection.mockImplementation(() => {
        mcpServersApi.loadIndex.mockResolvedValue({
          version: 1,
          servers: [accountRow],
          accountConnectionsAvailable: true,
        });
        return Promise.resolve({ connection: pending });
      });
      pluginsApi.installBuiltInPlugin.mockResolvedValue(
        okResult({
          plugin: FOLDED_GITHUB_PLUGIN,
          providerOutcomes: {
            claude: { installed: true },
            codex: { installed: true },
          },
        }),
      );
      await renderPage();
      await typeQuery('github');
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-add-mcp-catalog:github"]',
        ),
        'Add',
      );
      for (let round = 0; round < 5; round += 1) await settle();
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]'),
      ).not.toBeNull();
      expect(mcpServersApi.startAccountConnection).toHaveBeenCalledTimes(1);
      expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledTimes(1);
      expect(mcpServersApi.saveServer).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  describe('a desktop-only card with a cloud connection made before it was marked (REG-3035)', () => {
    const desktopOnly = makeCuratedMcp({
      availability: 'desktop',
      oauthHints: { scopes: ['read'] },
    });
    const staleConnection = (
      status: 'DISCONNECTED' | 'REAUTH_REQUIRED' | 'CONNECTED',
    ): McpServerIndexEntry => {
      const connection = {
        id: 'conn-github',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        status,
        routeId: 'route',
        enabledTools: null,
        kind: 'CURATED' as const,
      };
      return makeMcpServer({
        id: 'github',
        scope: 'account',
        accountConnectionId: connection.id,
        accountConnection: connection,
        configs: [{ id: 'default', name: 'Default', enabled: true }],
        deviceCopies: [],
      });
    };
    const expectDeviceSaved = (): void =>
      expect(mcpServersApi.saveServer.mock.calls).toMatchObject([
        [
          {
            definition: {
              curated: { key: 'github' },
              httpAuthHandler: 'canopy',
            },
          },
        ],
      ]);
    const cloudDisconnect = (): Element | null =>
      document.querySelector(
        '[data-testid="mcp-browse-detail-cloud-disconnect"]',
      );

    it.each(['DISCONNECTED', 'REAUTH_REQUIRED', 'CONNECTED'] as const)(
      'Add creates the device server over a %s cloud connection',
      async (status) => {
        // A disconnected cloud row used to send Add to its read-only account
        // details, and a lapsed one hid Add behind a cloud Connect that the
        // broker refuses, so the device server was never created.
        const restore = withAccountConnectionsFlag();
        try {
          await mount({
            mcpServers: [staleConnection(status)],
            curatedMcpServers: [desktopOnly],
          });
          await typeQuery('github');
          await click(
            container.querySelector(
              '[data-testid="plugins-entry-add-mcp-catalog:github"]',
            ),
            'Add',
          );
          await settle();
          expectDeviceSaved();
          expect(mcpServersApi.startAccountConnection).not.toHaveBeenCalled();
        } finally {
          restore();
        }
      },
    );

    it.each(['REAUTH_REQUIRED', 'CONNECTED'] as const)(
      'keeps Disconnect and no cloud reconnect for a %s cloud connection on an integrated card',
      async (status) => {
        const restore = withAccountConnectionsFlag();
        const disconnect = jest.fn().mockResolvedValue(undefined);
        defineWindowApi('mcpServers', {
          ...mcpServersApi,
          disconnectAccountConnection: disconnect,
        });
        try {
          await mount({
            marketplaces: [makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN])],
            mcpServers: [staleConnection(status)],
            curatedMcpServers: [desktopOnly],
          });
          await typeQuery('github');
          await openEntry('mcp-catalog:github');
          // The card reads the device server it lacks, not the cloud copy.
          expect(
            document.querySelector('[data-testid="plugin-account-connection"]')
              ?.textContent,
          ).toContain("GitHub isn't connected on this desktop");
          await click(
            document.querySelector(
              '[data-testid="detail-primary-cta"][data-state="install"]',
            ),
            'Add',
          );
          expectDeviceSaved();
          expect(mcpServersApi.startAccountConnection).not.toHaveBeenCalled();
          await click(cloudDisconnect(), 'Disconnect cloud connection');
          expect(disconnect).toHaveBeenCalledWith('conn-github');
          expect(mcpServersApi.startAccountConnection).not.toHaveBeenCalled();
        } finally {
          restore();
        }
      },
    );

    it('offers no Disconnect once the cloud connection is disconnected', async () => {
      const restore = withAccountConnectionsFlag();
      try {
        await mount({
          marketplaces: [makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN])],
          mcpServers: [staleConnection('DISCONNECTED')],
          curatedMcpServers: [desktopOnly],
        });
        await typeQuery('github');
        await openEntry('mcp-catalog:github');
        expect(
          document.querySelector(
            '[data-testid="detail-primary-cta"][data-state="install"]',
          )?.textContent,
        ).toBe('Install');
        expect(cloudDisconnect()).toBeNull();
      } finally {
        restore();
      }
    });
  });

  it.each([
    // Gmail, Calendar, and Drive: no app connection, only the provider route.
    ['a provider-only', {}],
    ['a dual-route', { oauthHints: { usePkce: true } }],
  ])(
    'installs the folded plugin when Add takes the provider-connector route of %s card (REG-3033)',
    async (_kind, appRoute) => {
      // The folded connector route only re-read the connectors, so connecting
      // through Claude or Codex never installed the plugin folded into the card.
      const connectorCatalog = makeCuratedMcp({
        ...appRoute,
        providerConnector: { providers: ['claude'] },
      });
      mcpServersApi.listProviderConnectors.mockResolvedValue([
        { provider: 'claude', connectors: [] },
        { provider: 'codex', connectors: [] },
      ]);
      const curated = makeCuratedMarketplace([FOLDED_GITHUB_PLUGIN]);
      pluginsApi.loadMarketplacesCacheOnly.mockResolvedValue(
        okResult(makeCache([curated])),
      );
      pluginsApi.installBuiltInPlugin.mockResolvedValue(
        okResult({
          plugin: {
            ...FOLDED_GITHUB_PLUGIN,
            globalInstallStatus: {
              claude: { available: true, installed: true },
              codex: { available: true, installed: true },
              checkedAt: '2026-05-01T00:00:00.000Z',
            },
          },
          providerOutcomes: {
            claude: { installed: true },
            codex: { installed: true },
          },
        }),
      );
      await mount({
        marketplaces: [curated],
        curatedMcpServers: [connectorCatalog],
      });
      await typeQuery('github');
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-add-mcp-catalog:github"]',
        ),
        'Add',
      );
      // Re-read the provider routes first (the hook caches reads across the
      // page); a plain re-read with nothing linked installs nothing.
      await click(
        document.querySelector(
          '[data-testid="provider-connector-detail-refresh"]',
        ),
        'Re-check connectors',
      );
      await settle();
      expect(pluginsApi.installBuiltInPlugin).not.toHaveBeenCalled();
      await click(
        document.querySelector(
          '[data-testid="provider-connector-detail-connect-claude"]',
        ),
        'Connect with Claude',
      );
      await settle();
      expect(mcpServersApi.openProviderConnectorSettings).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'claude' }),
      );
      expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          marketplaceId: 'curated/cloud',
          pluginName: 'github',
        }),
      );
    },
  );

  it('keeps the folded plugin actions reachable for an account-backed integration (REG-3033)', async () => {
    // The account overlay used to return before the integrated detail, so a
    // connected user could never reach "Install skills only" for the plugin
    // folded into the card.
    const base = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...base,
        status: 'ready',
        values: {
          ...base.values,
          [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]: true,
        },
      },
    });
    try {
      const connection = {
        id: 'conn-github',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        status: 'CONNECTED' as const,
        routeId: 'route',
        enabledTools: null,
        kind: 'CURATED' as const,
      };
      mcpServersApi.getAccountConnection.mockResolvedValue(connection);
      await mount({
        marketplaces: [
          makeCuratedMarketplace([
            makePlugin({
              name: 'github',
              displayName: 'GitHub',
              description: 'GitHub skills.',
              category: 'developer-tools',
              marketplaceId: 'curated/cloud',
              curated: true,
              externalSource: undefined,
              providerSupport: { claude: 'native', codex: 'native' },
              details: {
                skills: [
                  { name: 'Triage', description: 'Triage issues.', path: 's' },
                ],
                agents: [],
                commands: [],
                hooks: [],
                mcpServers: [
                  {
                    name: 'github',
                    type: 'http',
                    url: 'https://mcp.github.com',
                  },
                ],
                lspServers: [],
                hasReadme: false,
              },
              globalInstallStatus: {
                claude: { available: true, installed: false },
                codex: { available: true, installed: false },
                checkedAt: '2026-05-01T00:00:00.000Z',
              },
            }),
          ]),
        ],
        mcpServers: [
          makeMcpServer({
            id: 'github',
            scope: 'account',
            accountConnectionId: connection.id,
            accountConnection: connection,
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            deviceCopies: [],
          }),
        ],
        curatedMcpServers: [makeCuratedMcp()],
      });
      await typeQuery('github');
      expect(
        container.querySelector('[data-testid="plugins-entry-curated:github"]'),
      ).toBeNull();
      await openEntry('mcp-catalog:github');
      expect(
        document.querySelector(
          '[data-testid="mcp-browse-detail-install-skills"]',
        ),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="plugin-account-connection"]')
          ?.textContent,
      ).toContain('GitHub is connected to your account');
      expect(
        document.querySelector('[data-testid="mcp-account-details"]'),
      ).toBeNull();
    } finally {
      useFeatureFlagsStore.setState({ snapshot: base });
    }
  });

  it.each(['custom', 'curated'] as const)(
    'opens the unified detail for an account-backed app entry instead of the device editor: %s',
    async (kind) => {
      const base = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...base,
          status: 'ready',
          values: {
            ...base.values,
            [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]: true,
          },
        },
      });
      try {
        const connection = {
          id: 'conn-1',
          serverKey: 'custom:abc',
          configId: 'default',
          displayName: 'internal.example.test',
          status: 'CONNECTED' as const,
          routeId: 'route',
          enabledTools: null,
          kind: 'CUSTOM' as const,
        };
        mcpServersApi.getAccountConnection.mockResolvedValue(connection);
        await mount({
          mcpServers: [
            makeMcpServer({
              id: kind === 'curated' ? 'github' : 'custom:abc',
              name: 'internal.example.test',
              description: 'Custom account server.',
              curatedKey: kind === 'curated' ? 'github' : undefined,
              scope: 'account',
              accountConnectionId: 'conn-1',
              accountConnection: connection,
              deviceCopies: [],
            }),
          ],
          curatedMcpServers: kind === 'curated' ? [makeCuratedMcp()] : [],
        });
        await typeQuery(kind === 'curated' ? 'github' : 'internal');

        // An account row's local entry carries its configuration, since
        // rows for one key share the server id (REG-3033).
        await openEntry(
          kind === 'curated'
            ? 'mcp-catalog:github'
            : 'mcp-local:custom:abc/default',
        );

        // Account entries manage health and placement in the same detail
        // as device entries (CAN-4265), never through the device editor.
        expect(mcpServersApi.loadServer).not.toHaveBeenCalled();
        expect(
          document.querySelector(
            '[data-testid="mcp-browse-detail-management"]',
          ),
        ).not.toBeNull();
        expect(
          document.querySelector('[data-testid="mcp-account-details"]'),
        ).toBeNull();
        expect(mcpServerDialog()).toBeNull();
      } finally {
        useFeatureFlagsStore.setState({ snapshot: base });
      }
    },
  );

  it('renders a marketplace skill as a breadcrumb sub-page and restores browse scroll', async () => {
    skillsApi.readContent.mockResolvedValue(
      okResult({
        frontmatter: { name: 'release-notes', description: 'Release notes' },
        body: '# Release Notes',
      }),
    );
    skillsApi.listFiles.mockResolvedValue(
      okResult({ files: ['SKILL.md'], truncated: false }),
    );
    await mount({
      skills: [
        makeSkill({
          name: 'release-notes',
          sourceId: 'plugin:release-tools',
          source: 'plugin',
        }),
      ],
    });
    await typeQuery('release-notes');
    const page = requireElement<HTMLElement>(
      container.querySelector('[data-testid="page-plugins"]'),
      'Customize page',
    );
    page.scrollTop = 240;

    await openEntry('skill:plugin:release-tools:release-notes');

    expect(entryDetail()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-current"]',
      )?.textContent,
    ).toBe('Release Notes');
    expect(entryDetail()?.getAttribute('role')).not.toBe('dialog');
    expect(skillsApi.readContent).toHaveBeenCalledWith(
      'plugin:release-tools',
      'release-notes',
    );

    await click(
      container.querySelector(
        '[data-testid="plugins-entry-detail-breadcrumb-root"]',
      ),
      'Customize breadcrumb',
    );

    expect(entryDetail()).toBeNull();
    expect(page.scrollTop).toBe(240);
  });

  describe('installed skill detail page (CAN-3483)', () => {
    function breadcrumbLabels(): string[] {
      const nav = requireElement(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumbs"]',
        ),
        'Entry detail breadcrumbs',
      );
      return Array.from(nav.querySelectorAll('li'))
        .filter((item) => item.getAttribute('aria-hidden') !== 'true')
        .map((item) => item.textContent?.trim() ?? '');
    }

    async function openSkillFromInstalledSkills(): Promise<void> {
      skillsApi.readContent.mockResolvedValue(
        okResult({
          frontmatter: { name: 'review-checklist', description: 'Checklist' },
          body: '# Review Checklist',
        }),
      );
      skillsApi.listFiles.mockResolvedValue(
        okResult({ files: ['SKILL.md'], truncated: false }),
      );
      await mountFullFixture();
      // The list's own inventory may be ahead of the page's: opening a skill
      // re-reads it, and the actions follow the refreshed custom record.
      skillsApi.loadSkills.mockResolvedValue(
        okResult([makeSkill({ custom: true })]),
      );
      await openManagement('skills');
      await click(
        container.querySelector(
          '[data-testid="mock-skills-tab-open-review-checklist"]',
        ),
        'Installed Skills row',
      );
    }

    function managementOpen(): string | null | undefined {
      return container
        .querySelector('[data-testid="plugins-management-view"]')
        ?.getAttribute('data-open');
    }

    it('opens the skill as a Marketplace page under Installed > Skills', async () => {
      await openSkillFromInstalledSkills();

      expect(
        container.querySelector('[data-testid="plugins-entry-detail-page"]'),
      ).not.toBeNull();
      expect(entryDetail()?.getAttribute('role')).not.toBe('dialog');
      expect(managementOpen()).toBe('false');
      expect(breadcrumbLabels()).toEqual([
        'Customize',
        'Installed',
        'Skills',
        'Review Checklist',
      ]);
      // The custom skill keeps its list row's Share, Edit, and Delete; Delete
      // sits in the header's More menu (CAN-4264).
      expect(
        container.querySelector('[data-testid="skill-read-detail-share"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="skill-read-detail-edit"]'),
      ).not.toBeNull();
      await click(
        container.querySelector('[data-testid="skill-read-detail-more"]'),
        'More actions',
      );
      expect(
        document.querySelector('[data-testid="skill-read-detail-remove"]')
          ?.textContent,
      ).toContain('Delete');
    });

    it('keeps the Skills list mounted behind the page so Back restores it', async () => {
      await openSkillFromInstalledSkills();
      // The list stays mounted (hidden) while its detail page shows, so its
      // tab, filters, and scroll survive the round trip.
      expect(mockTabLifecycle.skills.unmounts).toBe(0);
      const mountsBefore = mockTabLifecycle.skills.mounts;

      await leaveDetailByCrumb('type', 'Skill detail Skills crumb');

      expect(managementOpen()).toBe('true');
      expect(
        container.querySelector(
          '[data-testid="plugins-management-section-skills"]',
        ),
      ).not.toBeNull();
      expect(mockTabLifecycle.skills.mounts).toBe(mountsBefore);
      expect(mockTabLifecycle.skills.unmounts).toBe(0);
    });

    it('returns to the same Skills list from the Skills breadcrumb', async () => {
      await openSkillFromInstalledSkills();
      const mountsBefore = mockTabLifecycle.skills.mounts;

      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-type"]',
        ),
        'Skills breadcrumb',
      );

      expect(managementOpen()).toBe('true');
      expect(
        container.querySelector(
          '[data-testid="plugins-management-section-skills"]',
        ),
      ).not.toBeNull();
      expect(mockTabLifecycle.skills.mounts).toBe(mountsBefore);
      expect(mockTabLifecycle.skills.unmounts).toBe(0);
    });

    it('treats Escape on the page like Back', async () => {
      await openSkillFromInstalledSkills();
      const mountsBefore = mockTabLifecycle.skills.mounts;

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });
      await settle();

      expect(
        container.querySelector('[data-testid="plugins-entry-detail-page"]'),
      ).toBeNull();
      expect(managementOpen()).toBe('true');
      expect(mockTabLifecycle.skills.mounts).toBe(mountsBefore);
      expect(mockTabLifecycle.skills.unmounts).toBe(0);
    });

    it('releases the hidden list when the page leaves for the Marketplace root', async () => {
      await openSkillFromInstalledSkills();

      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-root"]',
        ),
        'Customize breadcrumb',
      );

      expect(managementOpen()).toBe('false');
      expect(mockTabLifecycle.skills.unmounts).toBe(1);
    });

    describe('custom skill edit page (CAN-3485)', () => {
      function breadcrumbLabels(): string[] {
        const nav = requireElement(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumbs"]',
          ),
          'Entry detail breadcrumbs',
        );
        return Array.from(nav.querySelectorAll('li'))
          .filter((item) => item.getAttribute('aria-hidden') !== 'true')
          .map((item) => item.textContent?.trim() ?? '');
      }

      function editorPage(): Element | null {
        return container.querySelector('[data-testid="skill-editor-page"]');
      }

      function detailContent(): Element | null {
        return container.querySelector('[data-testid="skill-read-detail"]');
      }

      async function pressEscape(
        target: EventTarget = document,
      ): Promise<void> {
        await act(async () => {
          target.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          await Promise.resolve();
        });
        await settle();
      }

      async function openEditPage(): Promise<void> {
        await openSkillFromInstalledSkills();
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
      }

      it('replaces the detail with the edit page and an Edit breadcrumb level', async () => {
        await openEditPage();

        expect(editorPage()).not.toBeNull();
        expect(detailContent()).toBeNull();
        expect(
          document.querySelector(
            '[aria-labelledby="create-skill-modal-title"]',
          ),
        ).toBeNull();
        expect(breadcrumbLabels()).toEqual([
          'Customize',
          'Installed',
          'Skills',
          'Review Checklist',
          'Edit',
        ]);
        expect(
          container
            .querySelector(
              '[data-testid="plugins-entry-detail-breadcrumb-edit"]',
            )
            ?.getAttribute('aria-current'),
        ).toBe('page');
        // The editor keeps the existing fields, loaded from the skill.
        const nameInput = editorPage()?.querySelector(
          'input[placeholder="my-skill-name"]',
        );
        if (!(nameInput instanceof HTMLInputElement)) {
          throw new Error('Skill name input not found');
        }
        expect(nameInput.value).toBe('review-checklist');
        expect(
          editorPage()?.querySelector(
            '[data-testid="skill-editor-page-actions"]',
          ),
        ).not.toBeNull();
        expect(
          useCurrentUiStateStore.getState().slices['plugins.page'],
        ).toMatchObject({ skillEditorOpen: true });
      });

      it('opens the list row Edit as the edit page over the skill detail', async () => {
        skillsApi.readContent.mockResolvedValue(
          okResult({
            frontmatter: {
              name: 'review-checklist',
              description: 'Checklist',
            },
            body: '# Review Checklist',
          }),
        );
        skillsApi.listFiles.mockResolvedValue(
          okResult({ files: ['SKILL.md'], truncated: false }),
        );
        await mountFullFixture();
        skillsApi.loadSkills.mockResolvedValue(
          okResult([makeSkill({ custom: true })]),
        );
        await openManagement('skills');
        await click(
          container.querySelector(
            '[data-testid="mock-skills-tab-edit-review-checklist"]',
          ),
          'Installed Skills row Edit',
        );

        expect(editorPage()).not.toBeNull();
        expect(breadcrumbLabels()).toEqual([
          'Customize',
          'Installed',
          'Skills',
          'Review Checklist',
          'Edit',
        ]);

        // Cancel lands on the skill's details, not back on the list.
        await click(
          container.querySelector('[data-testid="skill-editor-cancel"]'),
          'Editor Cancel',
        );
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();
        expect(managementOpen()).toBe('false');
      });

      it('returns to the details from Cancel, Back, the name crumb, and Escape', async () => {
        await openEditPage();
        await click(
          container.querySelector('[data-testid="skill-editor-cancel"]'),
          'Editor Cancel',
        );
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-current"]',
          )?.textContent,
        ).toBe('Review Checklist');
        expect(
          useCurrentUiStateStore.getState().slices['plugins.page'],
        ).toMatchObject({ skillEditorOpen: false });

        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        await click(
          container.querySelector('[data-testid="plugins-entry-detail-back"]'),
          'Editor Back',
        );
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();

        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-entry"]',
          ),
          'Skill name breadcrumb',
        );
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();

        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        // Escape typed inside a field keeps the edits being typed.
        const description = requireElement(
          container.querySelector(
            '[data-testid="skill-editor-description-input"]',
          ),
          'Description input',
        );
        await pressEscape(description);
        expect(editorPage()).not.toBeNull();
        // Escape from editor controls that are not text fields still goes back.
        await pressEscape(
          requireElement(
            container.querySelector(
              '[data-testid="skill-editor-mode-preview"]',
            ),
            'Preview toggle',
          ),
        );
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        // Elsewhere it acts as Back: first to the details, then to the list.
        await pressEscape();
        expect(editorPage()).toBeNull();
        expect(detailContent()).not.toBeNull();
        await pressEscape();
        expect(
          container.querySelector('[data-testid="plugins-entry-detail-page"]'),
        ).toBeNull();
        expect(managementOpen()).toBe('true');
      });

      it('shows validation inline and keeps Save disabled', async () => {
        await openEditPage();
        const nameInput = container.querySelector(
          'input[placeholder="my-skill-name"]',
        );
        if (!(nameInput instanceof HTMLInputElement)) {
          throw new Error('Skill name input not found');
        }
        await act(async () => {
          setInputValue(nameInput, 'Review_Checklist');
          await Promise.resolve();
        });
        await settle();

        expect(nameInput.getAttribute('aria-invalid')).toBe('true');
        expect(
          container.querySelector('#skill-name-help')?.textContent,
        ).toContain(
          'Skill name can only contain lowercase letters, numbers, and hyphens.',
        );
        const save = requireButton(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );
        expect(save.disabled).toBe(true);
        await click(save, 'Editor Save');
        expect(skillsApi.saveCustomSkill).not.toHaveBeenCalled();
        expect(editorPage()).not.toBeNull();
      });

      it('saves, refreshes the installed list, and lands on the updated details', async () => {
        skillsApi.saveCustomSkill.mockResolvedValue(
          okResult({ name: 'review-checklist' }),
        );
        await openEditPage();
        const skillsChanged = jest.fn();
        window.addEventListener('canopy:skills-changed', skillsChanged);
        try {
          skillsApi.readContent.mockResolvedValue(
            okResult({
              frontmatter: {
                name: 'review-checklist',
                description: 'Updated checklist',
              },
              body: '# Review Checklist',
            }),
          );
          const readsBefore = skillsApi.readContent.mock.calls.length;
          const loadsBefore = skillsApi.loadSkills.mock.calls.length;

          await click(
            container.querySelector('[data-testid="skill-editor-save"]'),
            'Editor Save',
          );

          expect(skillsApi.saveCustomSkill).toHaveBeenCalledWith(
            expect.objectContaining({
              name: 'review-checklist',
              originalName: 'review-checklist',
            }),
          );
          expect(skillsChanged).toHaveBeenCalled();
          expect(skillsApi.loadSkills.mock.calls.length).toBeGreaterThan(
            loadsBefore,
          );
          expect(editorPage()).toBeNull();
          expect(detailContent()).not.toBeNull();
          // The details re-read the saved skill.
          expect(skillsApi.readContent.mock.calls.length).toBeGreaterThan(
            readsBefore,
          );
          expect(container.textContent).toContain('Updated checklist');
        } finally {
          window.removeEventListener('canopy:skills-changed', skillsChanged);
        }
      });

      it('does not reopen a renamed skill after the user left during the save', async () => {
        const save = createDeferred<IPCResult<{ name: string }>>();
        skillsApi.saveCustomSkill.mockReturnValue(save.promise);
        await openEditPage();
        await click(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );

        // Leave for the Marketplace root while the rename is still saving.
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-root"]',
          ),
          'Customize breadcrumb',
        );
        expect(
          container.querySelector('[data-testid="plugins-entry-detail-page"]'),
        ).toBeNull();

        save.resolve(okResult({ name: 'review-checklist-renamed' }));
        await settle();

        expect(
          container.querySelector('[data-testid="plugins-entry-detail-page"]'),
        ).toBeNull();
      });

      it('follows a rename that finishes after Back returned to the details', async () => {
        const save = createDeferred<IPCResult<{ name: string }>>();
        skillsApi.saveCustomSkill.mockReturnValue(save.promise);
        await openEditPage();
        await click(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );
        await click(
          container.querySelector('[data-testid="plugins-entry-detail-back"]'),
          'Editor Back',
        );
        expect(editorPage()).toBeNull();

        save.resolve(okResult({ name: 'review-checklist-renamed' }));
        await settle();

        // The old name no longer exists, so the details follow the rename.
        expect(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-current"]',
          )?.textContent,
        ).toBe('Review Checklist Renamed');
        expect(editorPage()).toBeNull();
      });

      it('does not close a newer edit session when an earlier save finishes', async () => {
        const save = createDeferred<IPCResult<{ name: string }>>();
        skillsApi.saveCustomSkill.mockReturnValue(save.promise);
        await openEditPage();
        await click(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );
        await click(
          container.querySelector('[data-testid="plugins-entry-detail-back"]'),
          'Editor Back',
        );
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        expect(editorPage()).not.toBeNull();

        save.resolve(okResult({ name: 'review-checklist' }));
        await settle();

        expect(editorPage()).not.toBeNull();
        expect(
          useCurrentUiStateStore.getState().slices['plugins.page'],
        ).toMatchObject({ skillEditorOpen: true });
      });

      it('follows a late rename out of a newer edit session of the old name', async () => {
        const save = createDeferred<IPCResult<{ name: string }>>();
        skillsApi.saveCustomSkill.mockReturnValue(save.promise);
        await openEditPage();
        await click(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );
        await click(
          container.querySelector('[data-testid="plugins-entry-detail-back"]'),
          'Editor Back',
        );
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        expect(editorPage()).not.toBeNull();

        save.resolve(okResult({ name: 'review-checklist-renamed' }));
        await settle();

        // The newer editor targeted a name that no longer exists.
        expect(editorPage()).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="plugins-entry-detail-breadcrumb-current"]',
          )?.textContent,
        ).toBe('Review Checklist Renamed');
      });

      it('keeps the edit page and shows the error when saving fails', async () => {
        skillsApi.saveCustomSkill.mockResolvedValue({
          success: false,
          error: 'A skill named review-checklist already exists.',
        });
        await openEditPage();

        await click(
          container.querySelector('[data-testid="skill-editor-save"]'),
          'Editor Save',
        );

        expect(editorPage()).not.toBeNull();
        expect(editorPage()?.textContent).toContain(
          'A skill named review-checklist already exists.',
        );
      });
    });

    describe('Edit with AI (CAN-1259)', () => {
      const prompt = 'Help me edit review-checklist.';

      // CAN-4261: Edit with AI sits in the page's ⋯ menu.
      function editWithAIOnDetail(): HTMLButtonElement {
        if (!document.querySelector('[data-testid="skill-read-detail-menu"]')) {
          act(() =>
            requireButton(
              container.querySelector('[data-testid="skill-read-detail-more"]'),
              'Detail More actions',
            ).click(),
          );
        }
        return requireButton(
          document.querySelector(
            '[data-testid="skill-read-detail-edit-with-ai"]',
          ),
          'Detail Edit with AI',
        );
      }

      function editWithAIOnEditor(): HTMLButtonElement {
        return requireButton(
          container.querySelector('[data-testid="skill-editor-edit-with-ai"]'),
          'Editor Edit with AI',
        );
      }

      beforeEach(() => {
        mockOpenEditSkillWithAIChat.mockReset();
        mockOpenEditSkillWithAIChat.mockResolvedValue(undefined);
      });

      it('opens a chat for the exact skill from its detail page', async () => {
        await openSkillFromInstalledSkills();
        const action = editWithAIOnDetail();
        expect(action.textContent).toBe('Edit with AI');
        expect(action.getAttribute('aria-disabled')).toBeNull();

        await click(action, 'Detail Edit with AI');

        expect(mockOpenEditSkillWithAIChat).toHaveBeenCalledTimes(1);
        expect(mockOpenEditSkillWithAIChat).toHaveBeenCalledWith({
          sourceId: 'custom:app',
          name: 'review-checklist',
        });
        expect(prompt).toContain('review-checklist');
      });

      it('opens a chat from the edit page, before Cancel', async () => {
        await openSkillFromInstalledSkills();
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        const actions = requireElement(
          container.querySelector('[data-testid="skill-editor-page-actions"]'),
          'Editor actions',
        );
        const labels = Array.from(actions.querySelectorAll('button')).map(
          (button) => button.textContent,
        );
        expect(labels.indexOf('Edit with AI')).toBeLessThan(
          labels.indexOf('Cancel'),
        );

        await click(editWithAIOnEditor(), 'Editor Edit with AI');

        expect(mockOpenEditSkillWithAIChat).toHaveBeenCalledWith({
          sourceId: 'custom:app',
          name: 'review-checklist',
        });
      });

      it('keeps unsaved edits: the edit page action waits for Save or Cancel', async () => {
        await openSkillFromInstalledSkills();
        await click(
          container.querySelector('[data-testid="skill-read-detail-edit"]'),
          'Detail Edit action',
        );
        const nameInput = container.querySelector(
          'input[placeholder="my-skill-name"]',
        );
        if (!(nameInput instanceof HTMLInputElement)) {
          throw new Error('Skill name input not found');
        }
        await act(async () => {
          setInputValue(nameInput, 'review-checklist-draft');
          await Promise.resolve();
        });
        await settle();

        const action = editWithAIOnEditor();
        expect(action.getAttribute('aria-disabled')).toBe('true');
        expect(container.textContent).toContain(
          'Save or cancel your changes first.',
        );
        await click(action, 'Editor Edit with AI');
        expect(mockOpenEditSkillWithAIChat).not.toHaveBeenCalled();

        // Restoring the saved value makes it available again.
        await act(async () => {
          setInputValue(nameInput, 'review-checklist');
          await Promise.resolve();
        });
        await settle();
        expect(editWithAIOnEditor().getAttribute('aria-disabled')).toBeNull();
      });

      it('keeps the page and says so when the chat cannot open', async () => {
        mockOpenEditSkillWithAIChat.mockRejectedValue(new Error('no chats'));
        await openSkillFromInstalledSkills();

        await click(editWithAIOnDetail(), 'Detail Edit with AI');
        await settle();

        expect(
          container.querySelector('[data-testid="plugins-entry-detail-page"]'),
        ).not.toBeNull();
        expect(container.textContent).toContain(
          "Couldn't start the chat. Try again.",
        );
        expect(editWithAIOnDetail().getAttribute('aria-disabled')).toBeNull();
      });

      it('explains a read-only installed skill instead of opening a chat', async () => {
        await mount({
          skills: [
            makeSkill({
              name: 'release-notes',
              sourceId: 'plugin:release-tools',
              source: 'plugin',
            }),
          ],
        });
        await typeQuery('release-notes');
        await openEntry('skill:plugin:release-tools:release-notes');

        // In the ⋯ menu the item is disabled with its reason beneath it.
        const action = editWithAIOnDetail();
        expect(action.disabled).toBe(true);
        expect(document.body.textContent).toContain(
          'This skill is read-only here. Change it where it was installed from.',
        );
        await click(action, 'Detail Edit with AI');
        expect(mockOpenEditSkillWithAIChat).not.toHaveBeenCalled();
      });
    });

    it('returns from a delete only after the inventory refresh lands', async () => {
      skillsApi.removeSkill.mockResolvedValue(okResult(undefined));
      await openSkillFromInstalledSkills();
      const reload = createDeferred<IPCResult<InstalledSkillInfo[]>>();
      skillsApi.loadSkills.mockReturnValue(reload.promise);

      await click(
        container.querySelector('[data-testid="skill-read-detail-more"]'),
        'More actions',
      );
      await click(
        document.querySelector('[data-testid="skill-read-detail-remove"]'),
        'Delete action',
      );
      await click(
        document.querySelector('[data-testid="skill-delete-confirm"]'),
        'Confirm delete',
      );

      // The list behind the page must not reappear with the deleted row.
      expect(skillsApi.removeSkill).toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="plugins-entry-detail-page"]'),
      ).not.toBeNull();
      expect(managementOpen()).toBe('false');

      reload.resolve(okResult([]));
      await settle();

      expect(
        container.querySelector('[data-testid="plugins-entry-detail-page"]'),
      ).toBeNull();
      expect(managementOpen()).toBe('true');
    });

    it('deletes the skill from the page and returns to the Skills list', async () => {
      skillsApi.removeSkill.mockResolvedValue(okResult(undefined));
      await openSkillFromInstalledSkills();
      const skillsChanged = jest.fn();
      window.addEventListener('canopy:skills-changed', skillsChanged);

      try {
        await click(
          container.querySelector('[data-testid="skill-read-detail-more"]'),
          'More actions',
        );
        await click(
          document.querySelector('[data-testid="skill-read-detail-remove"]'),
          'Delete action',
        );
        await click(
          document.querySelector('[data-testid="skill-delete-confirm"]'),
          'Confirm delete',
        );

        expect(skillsApi.removeSkill).toHaveBeenCalledWith(
          'custom:app',
          'review-checklist',
        );
        // The hidden list and discovery both refresh from the shared event.
        expect(skillsChanged).toHaveBeenCalled();
        expect(
          container.querySelector('[data-testid="plugins-entry-detail-page"]'),
        ).toBeNull();
        expect(managementOpen()).toBe('true');
        expect(
          container.querySelector(
            '[data-testid="plugins-management-section-skills"]',
          ),
        ).not.toBeNull();
      } finally {
        window.removeEventListener('canopy:skills-changed', skillsChanged);
      }
    });
  });

  describe('shared agents and plugins (CAN-3009)', () => {
    const growthTeam = {
      type: 'team',
      id: 'team-1',
      name: 'Growth',
      organization: { id: 'org-1', name: 'Acme' },
    } as const;

    function seedSharedRows(): void {
      mockCapabilityMarketplaceInventory.sharedAgents = [
        {
          id: 'agent-1',
          name: 'Release notes writer',
          modelId: 'agent_model_release',
          baseModel: 'claude-sonnet-4-5',
          instructionsPreview: 'Draft release notes.',
          contentHash: 'hash',
          shareScope: 'team',
          owner: growthTeam,
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          createdBy: { id: 'user-1', name: 'Aaron', email: null },
          canUpdate: false,
          canDelete: false,
        },
      ];
      mockCapabilityMarketplaceInventory.sharedPlugins = [
        {
          owner: { type: 'organization', id: 'org-1', name: 'Acme' },
          shareScope: 'organization',
          createdBy: { id: 'user-1', name: 'Aaron' },
          externalId: 'plugin-share-1',
          refKey: 'plugin:github:acme/tools:deploy',
          ref: {
            type: 'plugin',
            marketplace: { type: 'github', repo: 'acme/tools' },
            plugin_name: 'deploy',
          },
          name: 'Deploy tools',
          description: 'Ship from chat.',
          marketplaceOrigin: 'acme/tools',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ];
    }

    function withAgentsFlag(enabled: boolean, run: () => Promise<void>) {
      return async (): Promise<void> => {
        const base = getDefaultFeatureFlagSnapshot();
        useFeatureFlagsStore.setState({
          snapshot: {
            ...base,
            status: 'ready',
            values: {
              ...base.values,
              [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
            },
          },
        });
        try {
          await run();
        } finally {
          useFeatureFlagsStore.setState({ snapshot: base });
        }
      };
    }

    it(
      'lists shared agents and shared plugins in their own All sections, naming who they are shared with',
      withAgentsFlag(true, async () => {
        seedSharedRows();
        await mountFullFixture();

        expect(entryTestIdsWithin(sectionBody('agents'))).toEqual([
          'plugins-entry-agent:shared:agent-1',
        ]);
        expect(entryTestIdsWithin(sectionBody('shared-plugins'))).toEqual([
          'plugins-entry-plugin:shared:plugin-share-1',
        ]);
        expect(
          container.querySelector(
            '[data-testid="plugins-card-shared-with-agent:shared:agent-1"]',
          )?.textContent,
        ).toBe('Team: Growth');
        expect(
          container.querySelector(
            '[data-testid="plugins-card-shared-with-plugin:shared:plugin-share-1"]',
          )?.textContent,
        ).toBe('Organization');
        // Neither is installed, so neither joins the installed strip.
        expect(
          installedTileIds().some(
            (id) => id.includes('agent:') || id.includes('plugin:shared:'),
          ),
        ).toBe(false);
      }),
    );

    it(
      'gives shared agents a tab of their own',
      withAgentsFlag(true, async () => {
        seedSharedRows();
        await mount();
        await click(
          container.querySelector('[data-testid="plugins-type-tab-agent"]'),
          'Agents type tab',
        );

        expect(entryIds()).toEqual(['agent:shared:agent-1']);
      }),
    );

    it(
      'shows no Agents tab while the Agents flag is off',
      withAgentsFlag(false, async () => {
        seedSharedRows();
        await mount();

        expect(
          container.querySelector('[data-testid="plugins-type-tab-agent"]'),
        ).toBeNull();
        // Project templates have no desktop list yet, so no tab either.
        expect(
          container.querySelector('[data-testid="plugins-type-tab-blueprint"]'),
        ).toBeNull();
      }),
    );

    it(
      'opens a shared agent detail from its card',
      withAgentsFlag(true, async () => {
        seedSharedRows();
        await mount();
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-agent:shared:agent-1"]',
          ),
          'Shared agent card',
        );

        const detail = requireElement(
          document.querySelector(
            '[data-testid="shared-agent-marketplace-detail"]',
          ),
          'Shared agent detail',
        );
        // The page header names it and says who it is shared with (CAN-4266).
        const header = requireElement(
          document.querySelector('[data-testid="plugins-entry-detail-header"]'),
          'Shared agent header',
        );
        expect(header.textContent).toContain('Release notes writer');
        expect(
          header.querySelector('[data-testid="shared-agent-detail-audience"]')
            ?.textContent,
        ).toBe('Team: Growth');
        expect(
          document.querySelector('[data-testid="plugins-entry-detail-back"]'),
        ).toBeNull();
        // Install is the page's primary action, in the header's action bar
        // rather than the agent's body.
        expect(
          detail.querySelector('[data-testid="shared-agent-detail-add"]'),
        ).toBeNull();
        expect(
          document.querySelector(
            '[data-testid="detail-action-bar"] [data-testid="shared-agent-detail-add"]',
          ),
        ).not.toBeNull();
      }),
    );

    it(
      "puts the owner's Unshare last in the header ⋯ menu, with its confirm (CAN-4266)",
      withAgentsFlag(true, async () => {
        seedSharedRows();
        const [owned] = mockCapabilityMarketplaceInventory.sharedAgents ?? [];
        if (!owned) throw new Error('Expected a seeded shared agent');
        mockCapabilityMarketplaceInventory.sharedAgents = [
          { ...owned, canDelete: true },
        ];
        await mount();
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-agent:shared:agent-1"]',
          ),
          'Shared agent card',
        );
        // No visible Unshare: it lives in the ⋯ menu that leads the header.
        expect(
          document.querySelector('[data-testid="marketplace-unshare"]'),
        ).toBeNull();
        await click(
          document.querySelector('[data-testid="plugins-entry-detail-more"]'),
          'More actions',
        );
        const item = document.querySelector(
          '[data-testid="marketplace-unshare"]',
        );
        expect(item?.textContent).toBe('Unshare');
        expect(item?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
          'link-2-off',
        );
        await click(item, 'Unshare');
        expect(
          document.querySelector('[data-testid="marketplace-unshare-dialog"]')
            ?.textContent,
        ).toContain('Unshare “Release notes writer”?');
      }),
    );

    it(
      'opens a shared plugin detail that names its source',
      withAgentsFlag(true, async () => {
        seedSharedRows();
        await mount();
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-plugin:shared:plugin-share-1"]',
          ),
          'Shared plugin card',
        );

        const detail = requireElement(
          document.querySelector(
            '[data-testid="shared-plugin-marketplace-detail"]',
          ),
          'Shared plugin detail',
        );
        expect(
          document.querySelector(
            '[data-testid="plugins-entry-detail-header-title"]',
          )?.textContent,
        ).toBe('Deploy tools');
        expect(detail.textContent).toContain('acme/tools');
      }),
    );
  });

  describe('local agents (CAN-4266)', () => {
    const localDefinition = {
      id: 'agent_model_reviewer',
      name: 'iOS Reviewer',
      baseModel: 'claude-sonnet-4-5',
      instructions: 'Review Swift changes.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      remoteId: 'agent-1',
    };

    function seedLocalAgent(): void {
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        localDefinition,
      ];
      mockCapabilityMarketplaceInventory.localAgents = [
        {
          id: localDefinition.id,
          name: localDefinition.name,
          description: 'Review Swift changes.',
          baseModelLabel: 'Claude Sonnet',
          pluginCount: 0,
          updatedAt: localDefinition.updatedAt,
          available: true,
          sharedRemoteId: 'agent-1',
        },
      ];
      mockCapabilityMarketplaceInventory.sharedAgents = [
        {
          id: 'agent-1',
          name: 'iOS Reviewer',
          modelId: localDefinition.id,
          baseModel: 'claude-sonnet-4-5',
          instructionsPreview: 'Review Swift changes.',
          contentHash: 'hash',
          shareScope: 'team',
          owner: {
            type: 'team',
            id: 'team-1',
            name: 'Growth',
            organization: { id: 'org-1', name: 'Acme' },
          },
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          createdBy: { id: 'user-1', name: 'Aaron', email: null },
          canUpdate: true,
          canDelete: true,
        },
        {
          id: 'agent-2',
          name: 'Release notes writer',
          modelId: 'agent_model_release',
          baseModel: 'claude-sonnet-4-5',
          instructionsPreview: 'Draft release notes.',
          contentHash: 'hash',
          shareScope: 'team',
          owner: {
            type: 'team',
            id: 'team-1',
            name: 'Growth',
            organization: { id: 'org-1', name: 'Acme' },
          },
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          createdBy: { id: 'user-1', name: 'Aaron', email: null },
          canUpdate: false,
          canDelete: false,
        },
      ];
    }

    function setAgentsFlag(enabled: boolean): void {
      const base = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...base,
          status: 'ready',
          values: {
            ...base.values,
            [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
          },
        },
      });
    }

    beforeEach(() => setAgentsFlag(true));
    afterEach(() => {
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot(),
      });
    });

    async function openAgentsTab(): Promise<void> {
      await click(
        container.querySelector('[data-testid="plugins-type-tab-agent"]'),
        'Agents type tab',
      );
    }

    function modal(): Element | null {
      return document.querySelector('[data-testid="mock-agent-model-modal"]');
    }

    it('lists local agents before shared ones and folds the shared copy', async () => {
      seedLocalAgent();
      await mount();
      await openAgentsTab();

      expect(entryIds()).toEqual([
        'agent:local:agent_model_reviewer',
        'agent:shared:agent-2',
      ]);
      expect(mockInventoryOptions).toMatchObject({ localAgentsEnabled: true });
      // Local agents appear in the shared Installed section.
      expect(installedTileIds().some((id) => id.startsWith('agent:'))).toBe(
        true,
      );
    });

    it('keeps owned agent shares visible when a local copy exists', async () => {
      seedLocalAgent();
      mockCapabilityMarketplaceInventory.viewerId = 'user-1';
      await mount();
      await openAgentsTab();
      expect(
        Array.from(
          container.querySelectorAll(
            '[data-testid="customize-section-shared-by-me"] [data-marketplace-entry="true"]',
          ),
        ).map((node) => node.getAttribute('data-testid')),
      ).toEqual([
        'customize-row-agent:shared:agent-1',
        'customize-row-agent:shared:agent-2',
      ]);
    });

    it('offers New agent in Add custom and opens the editor in create mode', async () => {
      await mount();
      await openAddCustomMenu();
      await clickMenuItem('plugins-add-custom-agent');

      expect(modal()?.getAttribute('data-agent-id')).toBe('new');
      await click(
        document.querySelector('[data-testid="mock-agent-model-save"]'),
        'Save agent',
      );
      expect(mockAgentsStore.save).toHaveBeenCalledWith({ name: 'Saved' });
      expect(modal()).toBeNull();
    });

    it('hydrates local definitions when New agent opens from another type tab', async () => {
      await mount();
      await click(
        container.querySelector('[data-testid="plugins-type-tab-skill"]'),
        'Skills tab',
      );
      await openAddCustomMenu();
      await clickMenuItem('plugins-add-custom-agent');
      expect(modal()).not.toBeNull();
      expect(mockInventoryOptions).toMatchObject({ localAgentsEnabled: true });
    });

    it('offers the editor from an empty Agents tab', async () => {
      await mount();
      await openAgentsTab();
      await click(
        container.querySelector('[data-testid="plugins-agents-empty-create"]'),
        'Empty Agents create',
      );
      expect(modal()?.getAttribute('data-agent-id')).toBe('new');
    });

    it('opens a local agent detail with edit, delete and share', async () => {
      seedLocalAgent();
      await mount();
      await openAgentsTab();
      await click(
        container.querySelector(
          '[data-testid="customize-row-agent:local:agent_model_reviewer"]',
        ),
        'Local agent card',
      );

      const detail = requireElement(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
        'Local agent detail',
      );
      expect(detail.textContent).toContain('agent_model_reviewer');
      expect(detail.textContent).toContain('Review Swift changes.');

      await click(
        document.querySelector('[data-testid="local-agent-detail-edit"]'),
        'Edit agent',
      );
      expect(modal()?.getAttribute('data-agent-id')).toBe(
        'agent_model_reviewer',
      );
      await click(
        document.querySelector('[data-testid="mock-agent-model-close"]'),
        'Close editor',
      );

      await click(
        document.querySelector('[data-testid="plugins-entry-detail-share"]'),
        'Share agent',
      );
      expect(
        document.querySelector('[data-testid="mock-share-agent-modal"]')
          ?.textContent,
      ).toBe('agent_model_reviewer');
      await click(
        document.querySelector('[data-testid="mock-agent-remove-public-link"]'),
        'Remove public link',
      );
      expect(
        mockCapabilityMarketplaceInventory.refreshLocalAgents,
      ).toHaveBeenCalled();
      expect(
        mockCapabilityMarketplaceInventory.refreshSharedAgents,
      ).toHaveBeenCalled();
    });

    it('closes the detail only after a delete succeeds', async () => {
      seedLocalAgent();
      mockAgentsStore.remove.mockRejectedValueOnce(new Error('Disk is full'));
      await mount();
      await openAgentsTab();
      await click(
        container.querySelector(
          '[data-testid="customize-row-agent:local:agent_model_reviewer"]',
        ),
        'Local agent card',
      );
      await click(
        document.querySelector('[data-testid="local-agent-detail-delete"]'),
        'Delete agent',
      );
      expect(document.body.textContent).toContain(
        'Existing chats and pipelines that use agent_model_reviewer will fail until another model is selected.',
      );
      const confirm = (): Element | null =>
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent === 'Delete agent',
        ) ?? null;

      await click(confirm(), 'Confirm delete');
      await settle();
      expect(mockAgentsStore.remove).toHaveBeenCalledWith(
        'agent_model_reviewer',
      );
      expect(document.body.textContent).toContain('Disk is full');
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).not.toBeNull();

      await click(confirm(), 'Confirm delete again');
      await settle();
      expect(mockAgentsStore.remove).toHaveBeenCalledTimes(2);
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).toBeNull();
    });

    it('opens a requested editor once, on the Agents tab, whichever tab was open', async () => {
      seedLocalAgent();
      await mount();
      await click(
        container.querySelector('[data-testid="plugins-type-tab-skill"]'),
        'Skills type tab',
      );
      await typeQuery('stale');

      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: 'agent_model_reviewer', mode: 'edit' });
      });
      await settle();

      expect(modal()?.getAttribute('data-agent-id')).toBe(
        'agent_model_reviewer',
      );
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).not.toBeNull();
      expect(useNavigationStore.getState().pendingPluginsNavigation).toBe(
        undefined,
      );

      await click(
        document.querySelector('[data-testid="mock-agent-model-close"]'),
        'Close editor',
      );
      // A later inventory refresh never reopens a dismissed editor.
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        { ...localDefinition },
      ];
      await renderPage();
      expect(modal()).toBeNull();
    });

    it('waits for agents to hydrate before opening a requested editor', async () => {
      mockCapabilityMarketplaceInventory.localAgentsLoading = true;
      mockCapabilityMarketplaceInventory.localAgentsLoaded = false;
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: 'agent_model_reviewer', mode: 'edit' });
      });
      await settle();
      expect(modal()).toBeNull();
      expect(
        document.querySelector('[data-testid="local-agent-detail-loading"]'),
      ).not.toBeNull();

      seedLocalAgent();
      mockCapabilityMarketplaceInventory.localAgentsLoading = false;
      mockCapabilityMarketplaceInventory.localAgentsLoaded = true;
      await renderPage();
      expect(modal()?.getAttribute('data-agent-id')).toBe(
        'agent_model_reviewer',
      );
    });

    it('keeps a requested editor until a fresh agent load settles', async () => {
      // A stale cached inventory reports loaded without the agent; the agent
      // only arrives in the refresh the request triggers.
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [];
      mockCapabilityMarketplaceInventory.localAgentsLoading = false;
      mockCapabilityMarketplaceInventory.localAgentsLoaded = true;
      mockCapabilityMarketplaceInventory.refreshLocalAgents = jest.fn(() => {
        seedLocalAgent();
        return Promise.resolve();
      });
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: 'agent_model_reviewer', mode: 'edit' });
      });
      await settle();
      expect(
        mockCapabilityMarketplaceInventory.refreshLocalAgents,
      ).toHaveBeenCalled();
      await renderPage();
      expect(modal()?.getAttribute('data-agent-id')).toBe(
        'agent_model_reviewer',
      );
    });

    it('opens a requested editor on the fresh definition, not the cached one', async () => {
      // The cached inventory already lists the agent, but it changed while
      // this page held no subscription; the editor seeds its fields once.
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        { ...localDefinition, instructions: 'Old cached instructions.' },
      ];
      mockCapabilityMarketplaceInventory.localAgentsLoading = false;
      mockCapabilityMarketplaceInventory.localAgentsLoaded = true;
      let finishRefresh: () => void = () => undefined;
      mockCapabilityMarketplaceInventory.refreshLocalAgents = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve;
          }),
      );
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: localDefinition.id, mode: 'edit' });
      });
      await settle();
      expect(modal()).toBeNull();

      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        { ...localDefinition, instructions: 'Fresh instructions.' },
      ];
      await act(async () => {
        finishRefresh();
        await Promise.resolve();
      });
      await renderPage();
      expect(modal()?.getAttribute('data-agent-instructions')).toBe(
        'Fresh instructions.',
      );
    });

    it('keeps a requested editor closed through a failed refresh, then opens it after Try again', async () => {
      // The store keeps its cached list when a read fails; that list may be
      // older than the agent, so it must not seed the editor.
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        { ...localDefinition, instructions: 'Old cached instructions.' },
      ];
      mockCapabilityMarketplaceInventory.localAgentsLoading = false;
      mockCapabilityMarketplaceInventory.localAgentsLoaded = true;
      mockCapabilityMarketplaceInventory.refreshLocalAgents = jest.fn(() => {
        mockCapabilityMarketplaceInventory.localAgentsError = 'Disk is full';
        return Promise.resolve();
      });
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: localDefinition.id, mode: 'edit' });
      });
      await settle();
      await renderPage();
      expect(modal()).toBeNull();

      // Try again succeeds with the current definition.
      mockCapabilityMarketplaceInventory.localAgentsError = null;
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [
        { ...localDefinition, instructions: 'Fresh instructions.' },
      ];
      await renderPage();
      expect(modal()?.getAttribute('data-agent-instructions')).toBe(
        'Fresh instructions.',
      );
    });

    it('shows a failed refresh on a cached agent detail and holds Edit until Try again', async () => {
      seedLocalAgent();
      mockCapabilityMarketplaceInventory.localAgentsError = 'Disk is full';
      await mount();
      act(() => {
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'entry-detail',
          entryId: `agent:local:${localDefinition.id}`,
        });
      });
      await settle();
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).not.toBeNull();
      const error = document.querySelector(
        '[data-testid="local-agent-detail-error"]',
      );
      expect(error?.textContent).toContain("Couldn't load your agents.");
      // The cached definition may be older than the agent: no editing it.
      const edit = document.querySelector<HTMLButtonElement>(
        '[data-testid="local-agent-detail-edit"]',
      );
      expect(edit?.disabled).toBe(true);
      await click(error?.querySelector('button') ?? null, 'Try again');
      expect(
        mockCapabilityMarketplaceInventory.refreshLocalAgents,
      ).toHaveBeenCalled();

      mockCapabilityMarketplaceInventory.localAgentsError = null;
      await renderPage();
      expect(
        document.querySelector('[data-testid="local-agent-detail-error"]'),
      ).toBeNull();
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="local-agent-detail-edit"]',
        )?.disabled,
      ).toBe(false);
    });

    it('reports a requested agent that no longer exists instead of a blank editor', async () => {
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: 'agent_model_gone', mode: 'edit' });
      });
      await settle();

      expect(modal()).toBeNull();
      expect(document.body.textContent).toContain(
        'This item is no longer available.',
      );
    });

    it('keeps shared agents listed and offers a retry when local agents fail', async () => {
      seedLocalAgent();
      mockCapabilityMarketplaceInventory.localAgents = [];
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [];
      mockCapabilityMarketplaceInventory.localAgentsError = 'Disk is full';
      await mount();
      await openAgentsTab();

      expect(entryIds()).toEqual([
        'agent:shared:agent-1',
        'agent:shared:agent-2',
      ]);
      expect(container.textContent).not.toContain('No agents yet');
      await click(
        requireElement(
          container.querySelector('[data-testid="plugins-local-agents-error"]'),
          'Local agents error',
        ).querySelector('button'),
        'Try again',
      );
      expect(
        mockCapabilityMarketplaceInventory.refreshLocalAgents,
      ).toHaveBeenCalled();
    });

    it('hides every agent surface when agents are switched off live', async () => {
      seedLocalAgent();
      await mount();
      await openAgentsTab();
      await click(
        container.querySelector(
          '[data-testid="customize-row-agent:local:agent_model_reviewer"]',
        ),
        'Local agent card',
      );
      await click(
        document.querySelector('[data-testid="local-agent-detail-edit"]'),
        'Edit agent',
      );
      expect(modal()).not.toBeNull();

      act(() => setAgentsFlag(false));
      await settle();

      expect(modal()).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="plugins-type-tab-agent"]'),
      ).toBeNull();
      expect(entryIds().some((id) => id.startsWith('agent:'))).toBe(false);
      expect(mockInventoryOptions).toMatchObject({
        localAgentsEnabled: false,
      });

      // Turning agents back on replays nothing.
      act(() => setAgentsFlag(true));
      await settle();
      expect(modal()).toBeNull();
    });

    it('closes an agent editor and detail when the context changes', async () => {
      const base = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...base,
          status: 'ready',
          values: {
            ...base.values,
            [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      const previousContext = useWorkspaceContextStore.getState();
      useWorkspaceContextStore.setState({ hydrated: true });
      try {
        seedLocalAgent();
        await mount();
        await openAgentsTab();
        await click(
          container.querySelector(
            '[data-testid="customize-row-agent:local:agent_model_reviewer"]',
          ),
          'Local agent card',
        );
        await click(
          document.querySelector('[data-testid="local-agent-detail-edit"]'),
          'Edit agent',
        );
        expect(modal()).not.toBeNull();

        act(() => {
          useWorkspaceContextStore.setState((state) => ({
            appliedGeneration: state.appliedGeneration + 1,
          }));
        });
        await settle();

        expect(modal()).toBeNull();
        expect(
          document.querySelector(
            '[data-testid="local-agent-marketplace-detail"]',
          ),
        ).toBeNull();
      } finally {
        useWorkspaceContextStore.setState({
          hydrated: previousContext.hydrated,
          appliedGeneration: previousContext.appliedGeneration,
        });
      }
    });

    it('opens a shared agent directly even when its row is folded into a local copy', async () => {
      seedLocalAgent();
      await mount();
      await click(
        container.querySelector('[data-testid="plugins-type-tab-skill"]'),
        'Skills tab',
      );
      act(() => {
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'entry-detail',
          entryId: 'agent:shared:agent-1',
        });
      });
      await settle();
      expect(
        document.querySelector(
          '[data-testid="shared-agent-marketplace-detail"]',
        ),
      ).not.toBeNull();
      expect(entryIds()).not.toContain('agent:shared:agent-1');
      expect(mockInventoryOptions).toMatchObject({ sharedAgentsEnabled: true });
    });

    it('offers a retry on a failed local detail load and resolves its pending editor after retry', async () => {
      mockCapabilityMarketplaceInventory.localAgentsError = 'Disk is full';
      await mount();
      act(() => {
        useNavigationStore.getState().openAgentReveal({
          agentId: localDefinition.id,
          mode: 'edit',
        });
      });
      await settle();
      const error = document.querySelector(
        '[data-testid="local-agent-detail-error"]',
      );
      expect(error).not.toBeNull();
      expect(document.body.textContent).not.toContain(
        'This item is no longer available.',
      );
      await click(error?.querySelector('button') ?? null, 'Retry local detail');
      expect(
        mockCapabilityMarketplaceInventory.refreshLocalAgents,
      ).toHaveBeenCalled();
      seedLocalAgent();
      mockCapabilityMarketplaceInventory.localAgentsError = null;
      await renderPage();
      expect(modal()?.getAttribute('data-agent-id')).toBe(localDefinition.id);
    });

    it('keeps an editor through a failed refresh and closes it only after confirmed deletion', async () => {
      seedLocalAgent();
      await mount();
      act(() => {
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: localDefinition.id, mode: 'edit' });
      });
      await settle();
      expect(modal()).not.toBeNull();
      // The store retains canonical same-context definitions on refresh failure.
      mockCapabilityMarketplaceInventory.localAgentsError = 'Refresh failed';
      await renderPage();
      expect(modal()).not.toBeNull();
      mockCapabilityMarketplaceInventory.localAgentsError = null;
      mockCapabilityMarketplaceInventory.localAgentDefinitions = [];
      await renderPage();
      expect(modal()).toBeNull();
    });

    it('drops an agent request while agents are off', async () => {
      setAgentsFlag(false);
      seedLocalAgent();
      await mount();
      act(() => {
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'entry-detail',
          entryId: 'agent:local:agent_model_reviewer',
          intent: 'edit',
        });
      });
      await settle();
      expect(modal()).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="local-agent-marketplace-detail"]',
        ),
      ).toBeNull();
    });
  });

  describe("sharing the user's own entries (CAN-3009)", () => {
    function ownAutomation(): void {
      mockCapabilityMarketplaceInventory.localAutomations = [
        {
          id: 'standup',
          name: 'Standup',
          description: 'Scheduled · App Advisor prompt: Summarize the day',
        },
      ];
      mockCapabilityMarketplaceInventory.automationActivities = [
        {
          version: 1,
          id: 'standup',
          name: 'Standup',
          enabled: true,
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Summarize the day' },
          createdAt: '2026-08-19T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
          failureCount: 0,
        },
      ];
    }

    it('shares a local automation from its card without a gate in front', async () => {
      ownAutomation();
      await mount();

      await press(
        container.querySelector(
          '[data-testid="customize-row-menu-automation:local:standup"]',
        ),
        'Row menu',
      );
      await click(
        document.querySelector(
          '[data-testid="customize-row-menu-automation:local:standup-share"]',
        ),
        'Standup Share button',
      );

      // Automations open their dialog directly; it carries its own connect
      // state, so their Public audience stays reachable without Teams.
      expect(mockRequestShare).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="mock-share-automation-modal"]')
          ?.textContent,
      ).toBe('standup');
    });

    it('offers Share in the header of a local automation detail', async () => {
      ownAutomation();
      await mount();
      await click(
        container.querySelector(
          '[data-testid="customize-row-automation:local:standup"]',
        ),
        'Standup card',
      );

      const share = requireButton(
        document.querySelector('[data-testid="plugins-entry-detail-share"]'),
        'Detail Share button',
      );
      expect(share.getAttribute('aria-label')).toBe('Share Standup');
      await click(share, 'Detail Share button');
      expect(
        document.querySelector('[data-testid="mock-share-automation-modal"]'),
      ).not.toBeNull();
    });

    it('sends a stored pipeline through the pipeline sign-in prompt', async () => {
      mockCapabilityMarketplaceInventory.pipelines = [
        {
          id: 'release',
          name: 'Release',
          description: 'Ship it.',
          icon: '',
          version: '1',
          source: 'user',
        },
      ];
      await mount();

      await press(
        container.querySelector(
          '[data-testid="customize-row-menu-pipeline:user:release"]',
        ),
        'Row menu',
      );
      await click(
        document.querySelector(
          '[data-testid="customize-row-menu-pipeline:user:release-share"]',
        ),
        'Release Share button',
      );

      expect(mockRequestShare).toHaveBeenCalledTimes(1);
      expect(mockRequestShare).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Sign in to share' }),
        expect.any(Function),
        undefined,
      );
    });

    it('offers no Share on an entry someone else shared', async () => {
      mockCapabilityMarketplaceInventory.sharedAutomations = [
        {
          id: 'triage',
          name: 'Triage inbox',
          description: null,
          triggerKind: 'cron',
          cronExpression: '0 9 * * 1-5',
          actionType: 'app_advisor_prompt',
          pipelineSource: null,
          contentHash: 'hash',
          shareScope: 'team',
          owner: {
            type: 'team',
            id: 'team-1',
            name: 'Growth',
            organization: { id: 'org-1', name: 'Acme' },
          },
          createdBy: { id: 'user-2', name: 'Grace', email: null },
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          canUpdate: false,
          canDelete: false,
        },
      ];
      await mount();

      expect(
        container.querySelector(
          '[data-testid="plugins-entry-automation:shared:triage"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="plugins-entry-share-automation:shared:triage"]',
        ),
      ).toBeNull();
    });
  });

  // CAN-3704: Share sits beside Add on every plugin card, installed or not.
  // A plugin without a public source keeps a visible Share that explains
  // why, instead of losing the action; it never opens a gate or a dialog.
  describe('Share on every plugin card (CAN-3704)', () => {
    function shareMarketplaces(): MarketplaceInfo[] {
      return [
        makeMarketplace({
          sourceUrl: 'https://github.com/acme/plugins',
          pluginCount: 1,
          plugins: [makePlugin({ externalSource: undefined })],
        }),
        makeMarketplace({
          id: 'local',
          name: 'Local plugins',
          sourceType: 'local',
          sourceUrl: '/tmp/local',
          pluginCount: 1,
          plugins: [
            makePlugin({
              name: 'local-tool',
              marketplaceId: 'local',
              externalSource: undefined,
            }),
          ],
        }),
      ];
    }

    async function mountSharePlugins(): Promise<void> {
      await mount({ marketplaces: shareMarketplaces() });
    }

    it('shows an enabled Share on an uninstalled plugin with a public source', async () => {
      await mountSharePlugins();
      const share = requireButton(
        container.querySelector(
          '[data-testid="plugins-entry-share-mkt:mkt-1/alpha-tool"]',
        ),
        'Alpha Share button',
      );
      expect(share.getAttribute('aria-disabled')).toBeNull();
      await click(share, 'Alpha Share button');
      expect(mockRequestShare).toHaveBeenCalledTimes(1);
    });

    it('still shares when the inventory snapshot changes while the share resolves', async () => {
      await mountSharePlugins();
      const pendingCache = createDeferred<IPCResult<PluginsCache>>();
      pluginsApi.loadMarketplacesCacheOnly.mockReturnValueOnce(
        pendingCache.promise,
      );
      const originalSharedSkills =
        mockCapabilityMarketplaceInventory.sharedSkills;
      try {
        await click(
          container.querySelector(
            '[data-testid="plugins-entry-share-mkt:mkt-1/alpha-tool"]',
          ),
          'Alpha Share button',
        );
        // An unrelated inventory refresh lands mid-resolution, as opening a
        // detail page does. The click must not be dropped.
        mockCapabilityMarketplaceInventory.sharedSkills = [];
        await renderPage();
        await act(async () => {
          pendingCache.resolve(okResult(makeCache(shareMarketplaces())));
          await Promise.resolve();
        });
        await settle();
        expect(mockRequestShare).toHaveBeenCalledTimes(1);
      } finally {
        mockCapabilityMarketplaceInventory.sharedSkills = originalSharedSkills;
      }
    });

    it('does not open sharing when the current cache no longer contains the rendered plugin', async () => {
      await mountSharePlugins();
      pluginsApi.loadMarketplacesCacheOnly.mockResolvedValue(
        okResult(makeCache([])),
      );
      const share = requireButton(
        container.querySelector(
          '[data-testid="plugins-entry-share-mkt:mkt-1/alpha-tool"]',
        ),
        'Alpha Share button',
      );
      await click(share, 'Alpha Share button');
      expect(pluginsApi.loadMarketplacesCacheOnly).toHaveBeenCalled();
      expect(mockRequestShare).not.toHaveBeenCalled();
    });

    it('explains an uninstalled plugin with no public source and never activates it', async () => {
      await mountSharePlugins();
      const share = requireButton(
        container.querySelector(
          '[data-testid="plugins-entry-share-mkt:local/local-tool"]',
        ),
        'Local Share button',
      );
      expect(share.getAttribute('aria-disabled')).toBe('true');
      expect(share.getAttribute('aria-description')).toBe(
        'This plugin has no public source to share.',
      );
      await click(share, 'Local Share button');
      expect(mockRequestShare).not.toHaveBeenCalled();
      // Nor did the click open the card's detail.
      expect(
        document.querySelector('[data-testid="plugins-entry-detail-share"]'),
      ).toBeNull();
    });
  });

  describe('detail breadcrumb entity type (CAN-3484)', () => {
    function breadcrumbLabels(): string[] {
      const nav = requireElement<HTMLElement>(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumbs"]',
        ),
        'Entry detail breadcrumbs',
      );
      return Array.from(nav.querySelectorAll('li'))
        .filter((item) => item.getAttribute('aria-hidden') !== 'true')
        .map((item) => item.textContent?.trim() ?? '');
    }

    async function mountReleaseNotesSkill(): Promise<void> {
      skillsApi.readContent.mockResolvedValue(
        okResult({
          frontmatter: { name: 'release-notes', description: 'Release notes' },
          body: '# Release Notes',
        }),
      );
      skillsApi.listFiles.mockResolvedValue(
        okResult({ files: ['SKILL.md'], truncated: false }),
      );
      await mount({
        skills: [
          makeSkill({
            name: 'release-notes',
            sourceId: 'plugin:release-tools',
            source: 'plugin',
          }),
        ],
      });
    }

    it('shows the entity type before the title and leads to that type list', async () => {
      await mountReleaseNotesSkill();
      await typeQuery('release-notes');
      await openEntry('skill:plugin:release-tools:release-notes');

      expect(breadcrumbLabels()).toEqual([
        'Customize',
        'Skills',
        'Release Notes',
      ]);
      const typeCrumb = requireElement<HTMLElement>(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-type"]',
        ),
        'Entity type breadcrumb',
      );
      expect(typeCrumb.tagName).toBe('BUTTON');
      expect(typeCrumb.getAttribute('data-entry-kind')).toBe('skill');
      expect(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-installed"]',
        ),
      ).toBeNull();

      await click(typeCrumb, 'Entity type breadcrumb');

      expect(entryDetail()).toBeNull();
      expect(
        container
          .querySelector('[data-testid="plugins-type-tab-skill"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      const search = container.querySelector('[data-testid="plugins-search"]');
      expect(search instanceof HTMLInputElement ? search.value : null).toBe('');
    });

    it('keeps the search when Back leaves a detail opened from search', async () => {
      await mountReleaseNotesSkill();
      await typeQuery('release-notes');
      await openEntry('skill:plugin:release-tools:release-notes');

      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-root"]',
        ),
        'Customize breadcrumb',
      );

      expect(entryDetail()).toBeNull();
      const search = container.querySelector('[data-testid="plugins-search"]');
      expect(search instanceof HTMLInputElement ? search.value : null).toBe(
        'release-notes',
      );
      expect(
        container
          .querySelector('[data-testid="plugins-type-tab-all"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('uses ordinary breadcrumbs for an Installed section detail', async () => {
      await mountReleaseNotesSkill();
      await openEntry('skill:plugin:release-tools:release-notes');
      expect(breadcrumbLabels()).toEqual([
        'Customize',
        'Skills',
        'Release Notes',
      ]);
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-type"]',
        ),
        'Skills breadcrumb',
      );
      expect(entryDetail()).toBeNull();
      expect(
        container
          .querySelector('[data-testid="plugins-type-tab-skill"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('leads an installed plugin type crumb to the Plugins filtered view', async () => {
      await mountFullFixture();
      await click(
        container.querySelector(
          '[data-testid="customize-row-curated:installed-helper"]',
        ),
        'Installed plugin tile',
      );

      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-type"]',
        ),
        'Plugins breadcrumb',
      );

      expect(entryDetail()).toBeNull();
      expect(
        container
          .querySelector('[data-testid="plugins-type-tab-plugin"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('leads the Installed level to the installed list', async () => {
      await mountReleaseNotesSkill();
      await openManagement();
      await openEntry('skill:plugin:release-tools:release-notes');
      expect(breadcrumbLabels()).toContain('Installed');
      await click(
        container.querySelector(
          '[data-testid="plugins-entry-detail-breadcrumb-installed"]',
        ),
        'Installed breadcrumb',
      );
      expect(entryDetail()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="plugins-management-section-installed"]',
        ),
      ).not.toBeNull();
    });

    it('returns Back to the installed management section that opened the detail', async () => {
      await mountReleaseNotesSkill();
      await openManagement();
      const managementView = requireElement<HTMLElement>(
        container.querySelector('[data-testid="plugins-management-view"]'),
        'Plugin management view',
      );
      await click(
        managementView.querySelector(
          '[data-testid="plugins-entry-skill:plugin:release-tools:release-notes"]',
        ),
        'Installed management skill',
      );

      expect(entryDetail()).not.toBeNull();
      await leaveDetailByCrumb('installed', 'Detail Installed crumb');

      expect(entryDetail()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="plugins-management-section-installed"]',
        ),
      ).not.toBeNull();
    });

    it('restores the Installed origin carried back from a pipeline editor', async () => {
      const returnTarget = {
        kind: 'entry-context' as const,
        stack: [],
        fromInstalled: true,
        managementReturn: 'installed' as const,
      };
      useNavigationStore.setState({
        activePage: 'plugins',
        pendingPluginsNavigation: {
          kind: 'entry-detail',
          entryId: 'skill:plugin:release-tools:release-notes',
          from: returnTarget,
        },
      });

      await mountReleaseNotesSkill();

      expect(breadcrumbLabels()).toEqual([
        'Customize',
        'Installed',
        'Skills',
        'Release Notes',
      ]);
      await leaveDetailByCrumb('installed', 'Detail Installed crumb');
      expect(
        container.querySelector(
          '[data-testid="plugins-management-section-installed"]',
        ),
      ).not.toBeNull();
    });
  });

  it('keeps an installed-pill skill load alive across marketplace parent renders', async () => {
    const contentLoad = createDeferred<
      IPCResult<{
        frontmatter: { name: string; description: string };
        body: string;
      }>
    >();
    const filesLoad =
      createDeferred<IPCResult<{ files: string[]; truncated: boolean }>>();
    skillsApi.readContent.mockReturnValue(contentLoad.promise);
    skillsApi.listFiles.mockReturnValue(filesLoad.promise);
    await mount({ skills: [makeSkill()] });

    await click(
      container.querySelector(
        '[data-testid="customize-row-skill:custom:app:review-checklist"]',
      ),
      'Installed custom skill pill',
    );
    expect(skillsApi.readContent).toHaveBeenCalledTimes(1);
    expect(skillsApi.listFiles).toHaveBeenCalledTimes(1);

    // The marketplace can re-render while inventory and current-UI state are
    // settling. A re-render must not make the viewer treat the same source/name
    // pair as a different skill and cancel/restart both IPC reads.
    await renderPage();
    expect(skillsApi.readContent).toHaveBeenCalledTimes(1);
    expect(skillsApi.listFiles).toHaveBeenCalledTimes(1);

    contentLoad.resolve(
      okResult({
        frontmatter: {
          name: 'review-checklist',
          description: 'Checklist',
        },
        body: '# Review Checklist',
      }),
    );
    filesLoad.resolve(okResult({ files: ['SKILL.md'], truncated: false }));
    await settle();
    expect(skillsApi.readContent).toHaveBeenCalledTimes(1);
    expect(skillsApi.listFiles).toHaveBeenCalledTimes(1);
  });

  it('opens a custom skill as a detail page and edits it on its edit page', async () => {
    skillsApi.readContent.mockResolvedValue(
      okResult({
        frontmatter: { name: 'review-checklist', description: 'Checklist' },
        body: '# Review Checklist',
      }),
    );
    skillsApi.listFiles.mockResolvedValue(
      okResult({ files: ['SKILL.md'], truncated: false }),
    );
    await mountFullFixture();
    await typeQuery('review-checklist');
    await openEntry('skill:custom:app:review-checklist');

    // CAN-3483: custom skills share the installed-skill detail page.
    expect(
      container.querySelector('[data-testid="plugins-entry-detail-page"]'),
    ).not.toBeNull();
    expect(entryDetail()?.getAttribute('role')).not.toBe('dialog');

    await click(
      container.querySelector('[data-testid="skill-read-detail-edit"]'),
      'Custom skill Edit button',
    );

    // CAN-3485: the editor replaces the detail on the same Marketplace page
    // rather than opening a dialog over it.
    expect(
      document.querySelector('[aria-labelledby="create-skill-modal-title"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-detail-page"] [data-testid="skill-editor-page"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="skill-read-detail"]'),
    ).toBeNull();
  });

  it('closes an open entry detail before opening management from a deep link', async () => {
    await mountFullFixture();
    await openEntry('curated:writer-toolkit');
    expect(entryDetail()).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canopy:plugins-open-management', {
          detail: { section: 'marketplaces' },
        }),
      );
      await Promise.resolve();
    });
    await settle();

    expect(entryDetail()).toBeNull();
    expect(container.textContent).toContain('Marketplaces');
    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
    ).not.toBeNull();
  });

  it('points the installed empty state to Customize', async () => {
    await mount({ marketplaces: [], skills: [], mcpServers: [] });
    await openManagement('installed');
    expect(container.textContent).toContain(
      'Nothing is installed yet. Browse Customize to get started.',
    );
  });

  it('surfaces skill and MCP inventory failures instead of an empty inventory', async () => {
    pluginsApi.loadMarketplaces.mockResolvedValue(okResult(makeCache([])));
    skillsApi.loadSkills.mockResolvedValue({
      success: false,
      error: 'Skills inventory unavailable',
    });
    mcpServersApi.loadIndex.mockRejectedValue(
      new Error('MCP inventory unavailable'),
    );
    mcpServersApi.listStatus.mockResolvedValue([]);
    mcpServersApi.listCurated.mockResolvedValue({ servers: [] });

    await renderPage();

    expect(container.textContent).toContain('Skills inventory unavailable');
    expect(container.textContent).toContain('MCP inventory unavailable');
    expect(container.textContent).not.toContain(
      'Nothing here yet. Use Add custom to bring in your own.',
    );
  });

  it('retries a failed automation inventory from the Installed notice', async () => {
    const hydrate = jest
      .spyOn(useAutomationsStore.getState(), 'hydrate')
      .mockImplementation(async () => {
        mockCapabilityMarketplaceInventory.installedInventory = 'ready';
        await Promise.resolve();
      });
    try {
      mockCapabilityMarketplaceInventory.installedInventory = 'error';
      await mount();
      const notice = container.querySelector(
        '[data-testid="customize-installed-error"]',
      );
      expect(notice?.textContent).toContain('Couldn’t load installed items.');
      await click(notice?.querySelector('button') ?? null, 'Try again');
      await renderPage();
      expect(hydrate).toHaveBeenCalledTimes(1);
      // Retry also re-reads the viewer's own shares (CAN-4261).
      expect(
        mockCapabilityMarketplaceInventory.refreshOwnedShares,
      ).toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="customize-installed-error"]'),
      ).toBeNull();
    } finally {
      hydrate.mockRestore();
      mockCapabilityMarketplaceInventory.installedInventory = 'ready';
    }
  });

  it('keeps the pipeline filters reachable when an unrelated inventory load fails', async () => {
    configureApis({});
    skillsApi.loadSkills.mockResolvedValue({
      success: false,
      error: 'Skills offline',
    });
    await renderPage();
    await click(
      container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
      'Workflows tab',
    );
    expect(
      container.querySelector('[data-testid="plugins-pipeline-filters"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="customize-installed-error"]'),
    ).not.toBeNull();
  });

  it('gives search empties precedence over the workflow creation state', async () => {
    await mount();
    await click(
      container.querySelector('[data-testid="plugins-type-tab-workflow"]'),
      'Workflows tab',
    );
    expect(container.textContent).toContain('No workflows yet');
    await typeQuery('no match');
    expect(
      container.querySelector('#customize-section-browse')?.textContent,
    ).toContain('Nothing matches your search.');
    expect(container.textContent).not.toContain('No workflows yet');
  });

  it('opens the entry detail from the management view installed section', async () => {
    await mountFullFixture();
    await openManagement('installed');

    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
      'Installed management section',
    );
    await click(
      section.querySelector(
        '[data-testid="plugins-entry-curated:installed-helper"]',
      ),
      'Installed-section entry card',
    );

    expect(entryDetail()).not.toBeNull();
    const props = requirePluginDetailViewProps();
    expect(props.plugin.name).toBe('installed-helper');
    expect(props.marketplace.id).toBe('curated/cloud');
    // The management view stays open behind the detail so closing returns
    // the user to where they were.
    expect(
      container.querySelector('[data-testid="plugins-management-view"]'),
    ).not.toBeNull();
  });

  it('keeps the management installed section to one heading and offers Connect', async () => {
    await mountFullFixture();
    await openManagement('installed');

    const section = requireElement(
      container.querySelector(
        '[data-testid="plugins-management-section-installed"]',
      ),
      'Installed management section',
    );
    // The section already has its own "Installed plugins" heading; the list
    // must not stack a second "Installed" on top of it.
    expect(section.querySelectorAll('h2')).toHaveLength(0);

    // Needs-auth entries here need the same Connect shortcut discovery has.
    const menu = await openEntryMenu('mcp-catalog:github');
    expect(
      menu.querySelector(
        '[data-testid="plugins-menu-connect-mcp-catalog:github"]',
      ),
    ).not.toBeNull();
  });

  it('reports the open entry detail for App Advisor without leaking source data', async () => {
    await mountFullFixture();
    expect(pluginsSnapshot()?.entryDetail).toBeUndefined();

    await openEntry('curated:writer-toolkit');

    expect(pluginsSnapshot()?.entryDetail).toEqual({
      open: true,
      entryId: 'curated:writer-toolkit',
      kind: 'plugin',
      state: 'available',
      refType: 'curated-plugin',
      mcpEditorOpen: false,
      editingSharedSkill: false,
      editingCollection: false,
    });
  });

  // -------------------------------------------------------------------------
  // Discovery projection refresh after management-view mutations (API-2153
  // final whole-branch review, finding 1). The page's `useSkillList()` /
  // `useMcpServerList()` are separate hook instances from the ones the
  // management view's `SkillsTab`/`McpServersTab` own (those are stubbed in
  // this suite, so their IPC calls don't run here) — a mutation made through
  // them only reaches discovery if the page refreshes its own instances.
  // -------------------------------------------------------------------------

  it('refreshes the skills and MCP servers projection when the management view closes', async () => {
    await mount({ marketplaces: [], skills: [], mcpServers: [] });

    // Nothing installed yet, so the strip (and its row) is hidden entirely.
    expect(
      container.querySelector('[data-testid="plugins-installed-strip"]'),
    ).toBeNull();
    expect(skillsApi.loadSkills).toHaveBeenCalledTimes(1);
    expect(mcpServersApi.loadIndex).toHaveBeenCalledTimes(1);

    await openManagement('skills');

    // Simulate a skill install + MCP server add made through the management
    // view's own (here-stubbed) SkillsTab/McpServersTab instances: the
    // underlying IPC now reflects the mutation, mirroring what those real
    // components' own hook instances would have already persisted.
    skillsApi.loadSkills.mockResolvedValue(okResult([makeSkill()]));
    mcpServersApi.loadIndex.mockResolvedValue({
      version: 1,
      servers: [makeMcpServer()],
    });

    await click(
      container.querySelector('[data-testid="plugins-management-back"]'),
      'Management back button',
    );

    expect(skillsApi.loadSkills).toHaveBeenCalledTimes(2);
    expect(mcpServersApi.loadIndex).toHaveBeenCalledTimes(2);
    expect(installedTileIds()).toHaveLength(2);
  });

  it('refreshes skills when a `canopy:skills-changed` event fires', async () => {
    await mount({ marketplaces: [], skills: [] });

    expect(
      container.querySelector('[data-testid="plugins-installed-strip"]'),
    ).toBeNull();
    expect(skillsApi.loadSkills).toHaveBeenCalledTimes(1);

    // Dispatched (no detail) by App Advisor skill actions and SkillsTab's own
    // mutations — see `dispatcher.ts` / `SkillsTab.tsx`.
    skillsApi.loadSkills.mockResolvedValue(okResult([makeSkill()]));
    await act(async () => {
      window.dispatchEvent(new Event('canopy:skills-changed'));
      await Promise.resolve();
    });
    await settle();

    expect(skillsApi.loadSkills).toHaveBeenCalledTimes(2);
    expect(installedTileIds()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Compatibility: MCP browse + management deep links (spec section 5)
  // -------------------------------------------------------------------------

  it('focuses discovery search on the MCP servers tab for the curated MCP browse event', async () => {
    await mountFullFixture();

    await act(async () => {
      window.dispatchEvent(new Event('canopy:mcp-open-browse'));
      await Promise.resolve();
    });
    await settle();

    const search = requireElement(
      container.querySelector('[data-testid="plugins-search"]'),
      'Search input',
    );
    expect(document.activeElement).toBe(search);
    // MCP mode: nothing but `kind: 'app'` entries survive band selection.
    expect(entryIds()).toEqual(['mcp-catalog:github', 'mcp-catalog:linear']);
    expect(
      container
        .querySelector('[data-testid="plugins-type-tab-app"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="plugins-kind-chip-app"]'),
    ).toBeNull();
    // Discovery owns curated browse now — the management view must stay shut.
    const managementView = requireElement(
      container.querySelector('[data-testid="plugins-management-view"]'),
      'Closed management view',
    );
    expect(managementView.getAttribute('data-open')).toBe('false');
    expect(managementView.className).toContain('invisible');
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ view: 'discovery', resultCount: 2 });
  });

  it('clears MCP server filtering when All is selected', async () => {
    await mountFullFixture();
    await act(async () => {
      window.dispatchEvent(new Event('canopy:mcp-open-browse'));
      await Promise.resolve();
    });
    await settle();

    await click(
      container.querySelector('[data-testid="plugins-type-tab-all"]'),
      'All type tab',
    );

    expect(
      container
        .querySelector('[data-testid="plugins-type-tab-all"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(entryIds().length).toBeGreaterThan(1);
  });

  it('opens the management view at a section for the management deep link', async () => {
    await mountFullFixture();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canopy:plugins-open-management', {
          detail: { section: 'marketplaces' },
        }),
      );
      await Promise.resolve();
    });
    await settle();

    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
    ).not.toBeNull();
    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({ view: 'management', managementSection: 'marketplaces' });
  });

  it('consumes a durable management destination after the page mounts', async () => {
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: {
        kind: 'management',
        section: 'marketplaces',
      },
    });

    await mountFullFixture();

    expect(
      container.querySelector(
        '[data-testid="plugins-management-section-marketplaces"]',
      ),
    ).not.toBeNull();
    expect(
      useNavigationStore.getState().pendingPluginsNavigation,
    ).toBeUndefined();
  });

  it('lands the discovery intent on the unfiltered discovery view', async () => {
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: { kind: 'discovery' },
    });

    await mountFullFixture();

    // Unfiltered: every kind survives band selection, and the apps chip that
    // marks `kindFilter === 'app'` is absent. This is the property the
    // onboarding checklist's "Enable a skill or plugin" item depends on — an
    // inherited app-only filter would hide the skills and plugins it installs.
    expect(
      container.querySelector('[data-testid="plugins-kind-chip-app"]'),
    ).toBeNull();
    // Pin the kinds rather than just the count: the apps chip renders only for
    // `kindFilter === 'app'`, so a regression setting any OTHER kind would
    // leave the chip absent and still clear a bare length assertion.
    const discoveryIds = entryIds();
    expect(discoveryIds).toContain('mcp-catalog:linear');
    expect(discoveryIds.some((id) => id.startsWith('mkt:'))).toBe(true);
    expect(
      container
        .querySelector('[data-testid="plugins-management-view"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
    expect(
      useNavigationStore.getState().pendingPluginsNavigation,
    ).toBeUndefined();
  });

  it('resets an already-filtered discovery view when the discovery intent arrives', async () => {
    // The four resets in the shared branch are load-bearing only against a
    // page that is ALREADY mounted and filtered: on a fresh mount they are
    // no-ops over the `useState` defaults, so the sibling tests above would
    // still pass if the discovery case stopped resetting entirely. This is a
    // real flow, not a hypothetical — the checklist renders inside
    // SidebarAccountMenu, which is visible while on the Plugins page.
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: { kind: 'browse-apps' },
    });

    await mountFullFixture();

    expect(entryIds().every((id) => id.startsWith('mcp-catalog:'))).toBe(true);
    expect(entryIds().some((id) => id.startsWith('mkt:'))).toBe(false);

    await act(async () => {
      useNavigationStore.setState({
        pendingPluginsNavigation: { kind: 'discovery' },
      });
      await Promise.resolve();
    });
    await settle();

    expect(
      container.querySelector('[data-testid="plugins-kind-chip-app"]'),
    ).toBeNull();
    expect(entryIds()).toContain('mcp-catalog:linear');
    expect(entryIds().some((id) => id.startsWith('mkt:'))).toBe(true);
  });

  it('keeps the browse-apps intent filtered to apps', async () => {
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: { kind: 'browse-apps' },
    });

    await mountFullFixture();

    // The live path for `plugins.open_mcp_browse`: nothing in production
    // dispatches `canopy:mcp-open-browse` any more, so this intent is the
    // only remaining producer of apps mode.
    expect(entryIds()).toEqual(expect.arrayContaining(['mcp-catalog:linear']));
    expect(entryIds().every((id) => id.startsWith('mcp-catalog:'))).toBe(true);
    expect(
      useNavigationStore.getState().pendingPluginsNavigation,
    ).toBeUndefined();
  });

  it('reports entry-detail history and its pipeline Back target', async () => {
    useNavigationStore.setState({
      activePage: 'plugins',
      pendingPluginsNavigation: {
        kind: 'entry-detail',
        entryId: 'curated:writer-toolkit',
        from: {
          kind: 'pipeline',
          pipelineId: 'review-pipeline',
          source: 'user',
          returnToEntryContext: {
            entryId: 'skill:builtin:app:review-checklist',
            stack: ['skill:builtin:app:source-skill'],
          },
        },
      },
    });

    await mountFullFixture();

    expect(
      useCurrentUiStateStore.getState().slices['plugins.page'],
    ).toMatchObject({
      selectedEntryId: 'curated:writer-toolkit',
      detailHistoryDepth: 0,
      detailBackTarget: 'pipeline',
    });
  });

  it('projects the management view slice into the App Advisor snapshot', async () => {
    await mountFullFixture();
    await openManagement('mcp');

    expect(pluginsSnapshot()).toMatchObject({
      page: { view: 'management', managementSection: 'mcp' },
      managementView: { section: 'mcp' },
    });
  });
});
