import type { ResourceOwner } from '@canopy/protocol/resource-owner';
/**
 * Unified capability marketplace projection (CAN-1080 / API-2153 / CAN-1565).
 * A PURE projection over already-loaded desktop data — no React, no IPC, no
 * side effects. Every function here is deterministic given its inputs and
 * never mutates them.
 *
 * See `docs/planning/2026-08-17-plugins-discovery-redesign/design.md` for the
 * design decisions this module implements (unified entry shape, dedup rules,
 * search bands).
 */
import {
  curatedMcpDesktopOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type {
  McpServerIndexEntry,
  McpServerStatusEntry,
  ProviderConnectorListResult,
} from '@canopy/protocol/mcp-servers';
import { resolveMcpConnectionBadge } from '@canopy/ui-shared/lib/mcp-card-display';
import type { CuratedPluginEntry } from '@canopy/protocol/plugin-catalog';
import type { PluginProviderSupport } from '@canopy/protocol/plugins/catalog';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
  type PluginDetails,
  type PluginInfo,
  type SharedPluginSummary,
} from '@canopy/protocol/plugins';
import type { SharedAgentSummary } from '@canopy/protocol/agents';
import {
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  type WorkspaceTemplateShareSummary,
} from '@canopy/protocol/workspace-templates';
import type {
  InstalledSkillInfo,
  SharedSkillSummary,
} from '@canopy/protocol/skills';
import type { PipelineInfo } from '@canopy/protocol/pipelines';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { CuratedAutomationSummary } from '@canopy/protocol/automation-catalog';
import type {
  CollectionIndexEntry,
  SharedCollectionSummary,
} from '@canopy/protocol/collections';
import {
  localAgentEntryId,
  type UnifiedEntryOrigin,
  type UnifiedEntryState,
  type UnifiedLocalAgentInput,
} from '@canopy/protocol/unified-entry';
import {
  marketplaceTitleCase,
  officialProductLogoKey,
  pluginDisplayAuthor,
  pluginDisplayName,
  type UnifiedEntryConnection,
  type UnifiedEntryConnectionStatus,
  type UnifiedEntryFoldedConnector,
  type UnifiedEntryFoldedPlugin,
  type UnifiedEntryRequirement,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
export { marketplaceTitleCase } from '@canopy/ui-shared';
import { MCP_BRAND_LOGOS } from '@canopy/ui-shared/lib/mcp-brand-logos';

// ---------------------------------------------------------------------------
// Public types — verbatim per the task brief; later tasks depend on these
// exact names.
// ---------------------------------------------------------------------------

// Shared with the connector rows so "what do we advertise" has one answer.
import { buildProviderConnectorRows } from './providerConnectorRows';

export type {
  UnifiedEntryKind,
  UnifiedEntryOrigin,
  UnifiedEntryRef,
  UnifiedEntryState,
} from '@canopy/protocol/unified-entry';
export type { UnifiedPluginEntry } from '@canopy/ui-shared';

/** Structural marketplace row required by the pure unified projection. */
export interface UnifiedMarketplacePluginInput extends Pick<
  PluginInfo,
  | 'name'
  | 'displayName'
  | 'description'
  | 'version'
  | 'author'
  | 'category'
  | 'builtIn'
  | 'providerSupport'
  | 'logoUrl'
  | 'homepage'
  | 'externalSource'
  | 'globalInstallStatus'
  | 'parked'
> {
  marketplaceId: string;
  curated?: boolean;
  recommended?: boolean;
  details?: Pick<
    PluginDetails,
    'skills' | 'mcpServers' | 'commands' | 'agents'
  > | null;
  /** Browser summaries collapse provider-specific install state to one bit. */
  installed?: boolean;
}

export interface UnifiedMarketplaceInput extends Pick<
  MarketplaceInfo,
  'id' | 'name' | 'curated'
> {
  plugins: UnifiedMarketplacePluginInput[];
}

export type UnifiedInstalledSkillInput = Pick<
  InstalledSkillInfo,
  'name' | 'sourceId' | 'description' | 'builtIn'
> &
  Partial<Pick<InstalledSkillInfo, 'updateAvailable' | 'custom'>>;

/**
 * Structural local automation row. `@canopy/ui-app` cannot import the desktop
 * `ScheduledActivity`, so the host maps its automations onto this shape.
 */
export interface UnifiedLocalAutomationInput {
  /** Local scheduled-activity id. */
  id: string;
  name: string;
  /** One line saying when it runs and what it does. */
  description: string;
  /** Team share this automation was published as, when the user shared it. */
  sharedRemoteId?: string;
  /** Where this copy was installed from, when it was installed. */
  installedFrom?: {
    /** Team-share id, public-share id, or curated key, per `sourceKind`. */
    remoteId: string;
    contentHash: string;
    /** Absent means a team share. */
    sourceKind?: 'shared' | 'public' | 'curated';
  };
  /** Current source hash resolved independently of the paginated browse list. */
  sourceContentHash?: string;
}

/**
 * Cached MCP status a host supplies. Desktop status entries and the Portal's
 * redacted row projection (with its row id as `serverId`) both satisfy it.
 */
export interface UnifiedMcpStatusInput {
  serverId: string;
  connectionStatus: McpServerStatusEntry['connectionStatus'];
  reachability: McpServerStatusEntry['reachability'];
  handler?: McpServerStatusEntry['handler'];
  configs: ReadonlyArray<
    Pick<McpServerStatusEntry['configs'][number], 'configId' | 'authStatus'>
  >;
}

export interface UnifiedEntryInputs {
  /** Authenticated account id in the shared summaries' creator namespace. */
  viewerId?: string | null;
  personalOrganizationId?: string | null;
  curatedPlugins: CuratedPluginEntry[];
  marketplaces: UnifiedMarketplaceInput[];
  installedSkills: UnifiedInstalledSkillInput[];
  mcpServers: McpServerIndexEntry[];
  mcpStatuses: UnifiedMcpStatusInput[];
  curatedMcpServers: CuratedMcpServerEntry[];
  /** Per-provider connector reads; empty until they resolve. */
  providerConnectors: ProviderConnectorListResult[];
  pipelines?: PipelineInfo[];
  localCollections?: CollectionIndexEntry[];
  sharedSkills?: SharedSkillSummary[];
  sharedCollections?: SharedCollectionSummary[];
  localAutomations?: UnifiedLocalAutomationInput[];
  sharedAutomations?: SharedAutomationSummary[];
  curatedAutomations?: CuratedAutomationSummary[];
  /**
   * List every shared automation even when a local copy or source exists.
   * Only the Automations tab's "Shared by me" facet sets it, so the user's
   * own share appears beside the local automation it was published from.
   */
  skipLocalAutomationDedupe?: boolean;
  /** New section hosts keep installed catalog rows in Browse as well. */
  retainAutomationCatalogEntries?: boolean;
  /**
   * The host's complete local agent inventory; omitted while the Agents flag
   * is off or when the host has no local agents to supply.
   */
  localAgents?: UnifiedLocalAgentInput[];
  /** Agents shared with the viewer; omitted while the Agents flag is off. */
  sharedAgents?: SharedAgentSummary[];
  /** Plugin references shared with the viewer. */
  sharedPlugins?: SharedPluginSummary[];
  /** Project templates shared with the viewer's teams and organizations. */
  sharedBlueprints?: WorkspaceTemplateShareSummary[];
  appName?: string;
  /**
   * Fold a curated plugin that declares exactly one curated MCP key into that
   * key's integration card (REG-3033). Only a host whose MCP detail can
   * install the folded plugin opts in; a host whose card detail cannot keeps
   * the plugin's own card so it stays reachable and installable.
   */
  foldSingleKeyPlugins?: boolean;
}

export interface RankedResults {
  installed: UnifiedPluginEntry[];
  curatedPlugins: UnifiedPluginEntry[];
  curatedApps: UnifiedPluginEntry[];
  marketplace: UnifiedPluginEntry[];
  /** Plugin references shared with the viewer, apart from the catalog. */
  sharedPlugins: UnifiedPluginEntry[];
  skills: UnifiedPluginEntry[];
  pipelines: UnifiedPluginEntry[];
  automations: UnifiedPluginEntry[];
  collections: UnifiedPluginEntry[];
  agents: UnifiedPluginEntry[];
  projectTemplates: UnifiedPluginEntry[];
}

/**
 * Project the curated marketplace row back into catalog-entry shape for the
 * unified projection.
 *
 * The curated **plugin** catalog is fetched, hashed, and materialized entirely
 * in the main process (`main/plugins/curated-plugin-catalog.ts`); the renderer
 * has no `CuratedPluginEntry` accessor and this change adds no IPC. What the
 * renderer does receive is the synced `curated/cloud` marketplace row, whose
 * `PluginInfo` entries carry the catalog's display metadata (`displayName`,
 * `description`, `category`, `author`) plus the per-user `recommended` flag
 * that the curated scan copies out of the managed marketplace manifest.
 *
 * Fields the row genuinely cannot carry (`logoUrl`, `contentHash`,
 * `sortOrder`, `updatedAt`, `popular`) are filled with inert defaults — the
 * projection never reads them. `key` is the plugin `name`, which is exactly the
 * join key `buildUnifiedPluginEntries` uses to merge a catalog entry with its
 * marketplace row.
 */
export function curatedCatalogFromMarketplaces(
  marketplaces: UnifiedMarketplaceInput[],
): CuratedPluginEntry[] {
  const curated = marketplaces.find(
    (marketplace) =>
      marketplace.curated === true ||
      marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID,
  );
  if (!curated) return [];
  return curated.plugins.map((plugin, index): CuratedPluginEntry => {
    const details = plugin.details;
    return {
      key: plugin.name,
      name: pluginDisplayName(plugin),
      shortDescription: plugin.description ?? '',
      version: plugin.version,
      authorName: plugin.author,
      categories: plugin.category ? [plugin.category] : [],
      popular: false,
      recommended: plugin.recommended === true,
      sortOrder: index,
      contentHash: '',
      mcpServers: (details?.mcpServers ?? []).map((server) => server.name),
      skills: (details?.skills ?? []).map((skill) => ({
        key: skill.name,
        name: skill.name,
        contentHash: '',
        files: [],
      })),
      updatedAt: '',
    };
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NEUTRAL_PROVIDER_SUPPORT: { claude: boolean; codex: boolean } = {
  claude: true,
  codex: true,
};

function emptyComponents(): UnifiedPluginEntry['components'] {
  return { skills: 0, mcpServers: 0, commands: 0, agents: 0 };
}

function availabilityLabel(state: UnifiedEntryState): string {
  if (state === 'installed') return 'Installed';
  if (state === 'needs-auth') return 'Needs attention';
  return 'Available';
}

function sharedOwnershipLabel(
  owner: ResourceOwner | undefined,
  shareScope: string | undefined,
): string | undefined {
  const ownerLabel =
    owner && owner.type !== 'system'
      ? owner.name?.trim() || undefined
      : undefined;
  const scopeLabel =
    shareScope && shareScope !== 'private'
      ? `${shareScope.charAt(0).toUpperCase()}${shareScope.slice(1)}`
      : undefined;
  return [ownerLabel, scopeLabel].filter(Boolean).join(' · ') || undefined;
}

/**
 * The team or organization a shared row is shared with, read from its owner.
 * A personal owner (a private or public share) names no narrower audience.
 */
function sharedWithFromOwner(
  owner: ResourceOwner | undefined,
): Pick<UnifiedPluginEntry, 'sharedWith'> {
  if (!owner || (owner.type !== 'team' && owner.type !== 'organization')) {
    return {};
  }
  const name = owner.name?.trim();
  return {
    sharedWith: {
      audience: owner.type,
      ...(owner.type === 'organization' ? { organizationId: owner.id } : {}),
      ...(name ? { name } : {}),
    },
  };
}

/** Which providers a capability can actually run on. */
export interface CapabilityReach {
  claude: boolean;
  codex: boolean;
}

/**
 * `PluginProviderSupport` uses per-facet mode strings; every consumer of this
 * module only needs a boolean per provider. Codex `'compat'` still counts as
 * supported — the compatibility layer makes the plugin usable from Codex.
 *
 * Exported so the plugin picker derives reach the same way this page does,
 * instead of re-deriving it from the mode strings and drifting.
 */
export function capabilityReach(
  support: PluginProviderSupport,
): CapabilityReach {
  return {
    claude: support.claude === 'native',
    codex: support.codex !== 'none',
  };
}

/**
 * Whether `a` reaches every provider `b` does, so dropping `b` in favour of
 * `a` takes nothing away.
 *
 * Exported because the picker collapses the same duplicates this page does and
 * must not use a different rule: a Claude-only copy and a Codex-only copy both
 * "reach one provider", so a plain first-wins tie-break lets marketplace order
 * decide which survives, and whichever loses takes that capability away
 * entirely from users of its provider.
 */
export function capabilityCovers(
  a: CapabilityReach,
  b: CapabilityReach,
): boolean {
  return (a.claude || !b.claude) && (a.codex || !b.codex);
}

function pluginProviderSupport(
  plugin: UnifiedMarketplacePluginInput,
): CapabilityReach {
  return capabilityReach(plugin.providerSupport);
}

function builtInAnyProviderInstalled(
  status: PluginInfo['globalInstallStatus'],
): boolean {
  if (!status) return false;
  return Boolean(status.claude?.installed) || Boolean(status.codex?.installed);
}

function pluginDetailsComponents(
  details:
    | Pick<PluginDetails, 'skills' | 'mcpServers' | 'commands' | 'agents'>
    | null
    | undefined,
): UnifiedPluginEntry['components'] {
  return {
    skills: details?.skills.length ?? 0,
    mcpServers: details?.mcpServers.length ?? 0,
    commands: details?.commands.length ?? 0,
    agents: details?.agents.length ?? 0,
  };
}

function isCuratedMarketplace(marketplace: UnifiedMarketplaceInput): boolean {
  return (
    marketplace.curated === true ||
    marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID
  );
}

// ---------------------------------------------------------------------------
// Rule 1 — curated plugins: catalog entry + curated/cloud marketplace row.
// ---------------------------------------------------------------------------

function findCuratedMarketplace(
  marketplaces: UnifiedMarketplaceInput[],
): UnifiedMarketplaceInput | undefined {
  return marketplaces.find(isCuratedMarketplace);
}

/** Distinct curated MCP keys a plugin declares, in declaration order. */
function pluginCuratedMcpKeys(entry: CuratedPluginEntry): string[] {
  return Array.from(new Set(entry.mcpServers));
}

/**
 * Whether the user installed this curated plugin. Provider install state is
 * the answer when the row carries it; the portal's collapsed bit otherwise.
 * The desktop marks every materialized curated plugin `installed` because
 * its content is on disk, which is not the same as the user having added it.
 */
function curatedPluginInstalled(
  row: UnifiedMarketplacePluginInput | undefined,
): boolean {
  if (!row) return false;
  if (row.parked) return true;
  if (row.globalInstallStatus)
    return builtInAnyProviderInstalled(row.globalInstallStatus);
  return row.installed === true;
}

interface CuratedPluginProjection {
  entries: UnifiedPluginEntry[];
  /** Plugins folded into the integration card for their one curated key. */
  folded: Map<string, UnifiedEntryFoldedPlugin>;
}

/**
 * Rule 1 with the REG-3033 fold: a curated plugin that declares exactly one
 * curated MCP key the catalog lists becomes part of that key's integration
 * card instead of a card of its own. A plugin that needs several integrations
 * stays a plugin card with one requirement chip per key, because folding it
 * anywhere would hide the other requirements.
 */
function buildCuratedPluginEntries(
  curatedPlugins: CuratedPluginEntry[],
  marketplaces: UnifiedMarketplaceInput[],
  curatedMcpByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  foldSingleKeyPlugins: boolean,
): CuratedPluginProjection {
  const curatedMarketplace = findCuratedMarketplace(marketplaces);
  const rowsByPluginName = new Map<string, UnifiedMarketplacePluginInput>();
  if (curatedMarketplace) {
    for (const plugin of curatedMarketplace.plugins) {
      rowsByPluginName.set(plugin.name, plugin);
    }
  }

  const folded = new Map<string, UnifiedEntryFoldedPlugin>();
  const entries: UnifiedPluginEntry[] = [];
  for (const entry of curatedPlugins) {
    const row = rowsByPluginName.get(entry.key);
    const name = pluginDisplayName({
      name: entry.name,
      displayName: row?.displayName,
    });
    const keys = pluginCuratedMcpKeys(entry);
    const [onlyKey] = keys;
    const foldable =
      foldSingleKeyPlugins &&
      keys.length === 1 &&
      onlyKey !== undefined &&
      curatedMcpByKey.has(onlyKey);
    // One key, one card: the first plugin to claim a key folds into it. A
    // later plugin for the same key keeps its own card, naming the
    // integration it needs, rather than vanishing behind the first.
    if (foldable && !folded.has(onlyKey)) {
      folded.set(onlyKey, {
        key: entry.key,
        name,
        skills: entry.skills.length,
        installed: curatedPluginInstalled(row),
      });
      continue;
    }
    const state: UnifiedEntryState = row
      ? marketplacePluginState(row)
      : 'available';
    const providerSupport = row
      ? pluginProviderSupport(row)
      : NEUTRAL_PROVIDER_SUPPORT;
    const requirements: UnifiedEntryRequirement[] = keys.map((key) => ({
      key,
      name: curatedMcpByKey.get(key)?.name ?? key,
      entryId: `mcp-catalog:${key}`,
    }));
    entries.push({
      id: `curated:${entry.key}`,
      kind: 'plugin',
      origin: 'curated',
      name,
      description: entry.shortDescription,
      logoUrl: entry.logoUrl ?? marketplaceProductIconUrl(entry.authorUrl),
      categories: [...entry.categories],
      authorName: entry.authorName,
      typeLabel: 'Plugin',
      sourceLabel: 'Curated',
      ownershipLabel: entry.authorName,
      availabilityLabel: availabilityLabel(state),
      components: {
        skills: entry.skills.length,
        mcpServers: entry.mcpServers.length,
        commands: 0,
        agents: 0,
      },
      providerSupport,
      ...installedPluginFacts(row),
      state,
      recommended: entry.recommended === true,
      catalogSortOrder: entry.sortOrder,
      ...(requirements.length > 1 || foldable ? { requirements } : {}),
      ref: { type: 'curated-plugin', key: entry.key },
    });
  }
  return { entries, folded };
}

// ---------------------------------------------------------------------------
// Rules 2 & 5 — MCP server entries: curated-catalog merge, and local-only.
// ---------------------------------------------------------------------------

/** Portable Portal account rows carry configuration identity without cloud credentials. */
function accountConfigId(server: McpServerIndexEntry): string | undefined {
  return (
    server.accountConnection?.configId ??
    (server.scope === 'account' && server.configs.length === 1
      ? server.configs[0]?.id
      : undefined)
  );
}

function findMcpStatus(
  serverId: string,
  statuses: readonly UnifiedMcpStatusInput[],
  configId?: string,
): UnifiedMcpStatusInput | undefined {
  return statuses.find(
    (status) =>
      status.serverId === serverId &&
      (configId === undefined ||
        status.configs.some((config) => config.configId === configId)),
  );
}

function mcpStateFromStatus(
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  return status?.connectionStatus === 'auth_required'
    ? 'needs-auth'
    : 'installed';
}

function mcpServerState(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  if (status) return mcpStateFromStatus(status);
  switch (server.accountConnection?.status) {
    case 'REAUTH_REQUIRED':
      return 'needs-auth';
    case 'DISCONNECTED':
    case 'PENDING':
      return 'available';
    default:
      return 'installed';
  }
}

/**
 * The Installed badge for one server, from the same derivation the detail
 * health section uses. An account row reads only its own configuration's
 * status; without one it falls back to the cloud connection state.
 */
function mcpEntryConnection(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryConnectionStatus {
  const configId = accountConfigId(server);
  const own =
    status !== undefined &&
    (configId === undefined ||
      status.configs.length === 0 ||
      status.configs.some((config) => config.configId === configId))
      ? status
      : undefined;
  const badge = resolveMcpConnectionBadge(
    own,
    server.accountConnection?.status,
  );
  return badge.isProvider
    ? { status: badge.status, provider: true }
    : { status: badge.status };
}

function mcpAppComponents(): UnifiedPluginEntry['components'] {
  return { ...emptyComponents(), mcpServers: 1 };
}

/** The card's state from everything bound to it: the best binding wins. */
function integrationState(
  connections: readonly UnifiedEntryConnection[],
  plugin: UnifiedEntryFoldedPlugin | undefined,
): UnifiedEntryState {
  if (connections.some((connection) => connection.state === 'installed'))
    return 'installed';
  if (connections.some((connection) => connection.state === 'needs-auth'))
    return 'needs-auth';
  // The plugin is installed but has nothing to run against: the card asks
  // for the connection rather than offering Add again.
  if (plugin?.installed) return 'needs-auth';
  return 'available';
}

/** How an index row names itself on its integration card. */
function connectionName(server: McpServerIndexEntry): string {
  const account =
    server.scope === 'account' || server.accountConnection !== undefined;
  if (account) {
    return (
      server.configs[0]?.name ??
      server.accountConnection?.displayName ??
      server.name
    );
  }
  return server.name;
}

/**
 * The state of one connection on a card. Account rows for one key share the
 * provider server id, so a status matched on the id alone handed every
 * connection the first match's state; an account row reads the status entry's
 * own configuration, and falls back to the connection's cloud status when the
 * entry does not list it.
 */
function connectionState(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  const configId = accountConfigId(server);
  if (status && configId !== undefined && status.configs.length > 0) {
    const config = status.configs.find(
      (candidate) => candidate.configId === configId,
    );
    if (config) return authStatusState(config.authStatus);
    // The entry describes other configurations, not this one.
    return mcpServerState(server, undefined);
  }
  return mcpServerState(server, status);
}

function authStatusState(
  authStatus: McpServerStatusEntry['configs'][number]['authStatus'],
): UnifiedEntryState {
  switch (authStatus) {
    case 'not_connected':
    case 'expired':
    case 'error':
      return 'needs-auth';
    default:
      return 'installed';
  }
}

function serverConnection(
  server: McpServerIndexEntry,
  state: UnifiedEntryState,
): UnifiedEntryConnection {
  const account =
    server.scope === 'account' || server.accountConnection !== undefined;
  const configId =
    server.accountConnection?.configId ??
    server.configs.find((config) => config.enabled)?.id ??
    server.configs[0]?.id;
  return {
    serverId: server.id,
    ...(configId !== undefined ? { configId } : {}),
    name: connectionName(server),
    binding: account ? 'account' : 'device',
    state,
    ...(server.accountConnectionId !== undefined
      ? { accountConnectionId: server.accountConnectionId }
      : {}),
  };
}

interface FoldedConnector extends UnifiedEntryFoldedConnector {
  /** Providers the connector is linked on, for the card's connection rows. */
  connectedProviders: readonly ('claude' | 'codex')[];
}

const PROVIDER_ACCOUNT_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude account',
  codex: 'Codex account',
};

/**
 * Rule 2 with the REG-3033 fold: one card per curated key carrying every
 * connection to it (account, device, or a provider account) and the plugin
 * that ships its skills.
 */
function buildCuratedMcpEntry(
  entry: CuratedMcpServerEntry,
  servers: readonly McpServerIndexEntry[],
  mcpStatuses: readonly UnifiedMcpStatusInput[],
  plugin: UnifiedEntryFoldedPlugin | undefined,
  connector: FoldedConnector | undefined,
): UnifiedPluginEntry {
  const connections: UnifiedEntryConnection[] = servers.map((server) =>
    serverConnection(
      server,
      connectionState(
        server,
        findMcpStatus(server.id, mcpStatuses, accountConfigId(server)),
      ),
    ),
  );
  for (const provider of connector?.connectedProviders ?? []) {
    connections.push({
      serverId: entry.key,
      name: PROVIDER_ACCOUNT_LABELS[provider],
      binding: 'provider',
      state: 'installed',
    });
  }
  const desktopOnly = curatedMcpDesktopOnly(entry);
  // The cloud account never runs a desktop-only server (REG-3035). A
  // connection made before it was marked stays on the card so its detail can
  // disconnect it, but it never decides the card's state: it cannot make the
  // card set up, ask for a cloud reconnect, or stand in for the device
  // server Add creates.
  const state = integrationState(
    desktopOnly
      ? connections.filter((connection) => connection.binding !== 'account')
      : connections,
    plugin,
  );
  const accountBound = connections.some(
    (connection) => connection.binding === 'account',
  );
  const surface = desktopOnly ? 'desktop' : accountBound ? 'cloud' : undefined;
  const logoUrl =
    entry.logoUrl ?? servers.find((server) => server.logoUrl)?.logoUrl;
  // One binding has one health; several (Personal and Work) keep theirs on
  // the detail rather than an invented aggregate.
  const onlyServer = servers.length === 1 ? servers[0] : undefined;
  const connection =
    onlyServer === undefined
      ? undefined
      : mcpEntryConnection(
          onlyServer,
          findMcpStatus(
            onlyServer.id,
            mcpStatuses,
            accountConfigId(onlyServer),
          ),
        );
  return {
    id: `mcp-catalog:${entry.key}`,
    kind: 'app',
    origin: 'curated',
    name: entry.name,
    description: entry.shortDescription,
    logoUrl: logoUrl ?? marketplaceProductIconUrl(entry.authorUrl),
    categories: [...entry.categories],
    authorName: entry.authorName,
    typeLabel: 'MCP server',
    sourceLabel: 'Curated',
    ownershipLabel: entry.authorName,
    availabilityLabel: availabilityLabel(state),
    components: { ...mcpAppComponents(), skills: plugin?.skills ?? 0 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state,
    ...(surface ? { surface } : {}),
    ...(connection ? { connection } : {}),
    recommended: false,
    catalogSortOrder: entry.sortOrder,
    integration: {
      curatedKey: entry.key,
      ...(plugin ? { plugin } : {}),
      ...(connector
        ? {
            connector: {
              displayName: connector.displayName,
              connected: connector.connected,
            },
          }
        : {}),
      connections,
    },
    ref: { type: 'curated-mcp', key: entry.key },
  };
}

function buildLocalMcpEntry(
  server: McpServerIndexEntry,
  state: UnifiedEntryState,
  connection: UnifiedEntryConnectionStatus,
): UnifiedPluginEntry {
  // Account rows for one key share the server id, so the configuration is
  // part of the identity; a device row's id is already its own.
  const configId = accountConfigId(server);
  return {
    id:
      configId === undefined
        ? `mcp-local:${server.id}`
        : `mcp-local:${server.id}/${configId}`,
    kind: 'app',
    origin: 'installed-standalone',
    name: server.name,
    description: server.description,
    logoUrl: server.logoUrl,
    categories: [],
    authorName: undefined,
    typeLabel: 'MCP server',
    sourceLabel: 'Local',
    availabilityLabel: availabilityLabel(state),
    components: mcpAppComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state,
    surface:
      server.scope === 'account' || server.accountConnection
        ? 'cloud'
        : 'desktop',
    connection,
    recommended: false,
    ref: {
      type: 'local-mcp',
      serverId: server.id,
      ...(configId !== undefined ? { configId } : {}),
      // The catalog can be empty or stale while the bundled mark for this key
      // ships with the app; keep the key so the logo still resolves.
      ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
    },
  };
}

interface CuratedServerGroups {
  /** Every server for a key, in index order: a Personal and a Work connection are two rows on one card. */
  serversByKey: Map<string, McpServerIndexEntry[]>;
  /** Curated keys in the order the index first names them. */
  cardOrder: string[];
  /** Rows no catalog entry claims; each keeps a card of its own. */
  uncurated: McpServerIndexEntry[];
}

/**
 * Groups the index by curated key. The inventory nests a device file under
 * the account row it shadows, and the picker projection lifts only the copies
 * whose key differs from the row's; a same-key copy is still one of the key's
 * bindings, so it counts on the card. A device id is taken once even where a
 * copy was also lifted to the top level.
 */
function groupServersByCuratedKey(
  mcpServers: readonly McpServerIndexEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
): CuratedServerGroups {
  const groups: CuratedServerGroups = {
    serversByKey: new Map(),
    cardOrder: [],
    uncurated: [],
  };
  const seenDeviceIds = new Set<string>();
  const place = (server: McpServerIndexEntry): void => {
    const curated = server.curatedKey
      ? curatedByKey.get(server.curatedKey)
      : undefined;
    if (!curated) return;
    if (server.scope !== 'account') {
      if (seenDeviceIds.has(server.id)) return;
      seenDeviceIds.add(server.id);
    }
    const group = groups.serversByKey.get(curated.key);
    if (group) group.push(server);
    else {
      groups.serversByKey.set(curated.key, [server]);
      groups.cardOrder.push(curated.key);
    }
  };
  for (const server of mcpServers) {
    const curated = server.curatedKey
      ? curatedByKey.get(server.curatedKey)
      : undefined;
    if (!curated) {
      groups.uncurated.push(server);
      continue;
    }
    place(server);
    for (const copy of server.deviceCopies ?? []) place(copy);
  }
  return groups;
}

function buildMcpAppEntries(
  mcpServers: McpServerIndexEntry[],
  mcpStatuses: readonly UnifiedMcpStatusInput[],
  curatedMcpServers: CuratedMcpServerEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  foldedPlugins: ReadonlyMap<string, UnifiedEntryFoldedPlugin>,
  foldedConnectors: ReadonlyMap<string, FoldedConnector>,
): UnifiedPluginEntry[] {
  const { serversByKey, cardOrder, uncurated } = groupServersByCuratedKey(
    mcpServers,
    curatedByKey,
  );
  const entries: UnifiedPluginEntry[] = uncurated.map((server) => {
    const status = findMcpStatus(
      server.id,
      mcpStatuses,
      accountConfigId(server),
    );
    return buildLocalMcpEntry(
      server,
      connectionState(server, status),
      mcpEntryConnection(server, status),
    );
  });

  const cards: UnifiedPluginEntry[] = [];
  for (const key of [
    ...cardOrder,
    ...curatedMcpServers
      .map((entry) => entry.key)
      .filter((key) => !serversByKey.has(key)),
  ]) {
    const curated = curatedByKey.get(key);
    if (!curated) continue;
    cards.push(
      buildCuratedMcpEntry(
        curated,
        serversByKey.get(key) ?? [],
        mcpStatuses,
        foldedPlugins.get(key),
        foldedConnectors.get(key),
      ),
    );
  }
  return [...cards, ...entries];
}

// ---------------------------------------------------------------------------
// Rule 3 — non-curated marketplace plugins.
// ---------------------------------------------------------------------------

function marketplacePluginState(
  plugin: UnifiedMarketplacePluginInput,
): UnifiedEntryState {
  if (plugin.parked || plugin.installed === true) return 'installed';
  if (!plugin.globalInstallStatus) return 'available';
  return builtInAnyProviderInstalled(plugin.globalInstallStatus)
    ? 'installed'
    : 'available';
}

/** Pixel size requested from GitHub's avatar endpoint. */
const GITHUB_AVATAR_SIZE_PX = 128;

/**
 * A GitHub handle: alphanumeric, single interior hyphens, no leading/trailing
 * hyphen. Owners are interpolated into a URL below, so anything that could
 * carry a path, query, or scheme out of that position is refused outright
 * rather than escaped.
 */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * GitHub owner avatar for a repository URL, or nothing if it is not one.
 *
 * Fetching is not done here: the returned URL is handed to the existing
 * main-process image resolver (`useSafeRemoteImageUrl`), which fetches off the
 * renderer, refuses private hosts, caps size and redirects, and hands back an
 * inert data URL.
 */
export function githubOwnerAvatarUrl(
  repoUrl: string | undefined,
): string | undefined {
  if (repoUrl === undefined || repoUrl === '') {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  // Compared exactly, never by prefix/suffix: `github.com.evil.example` and
  // `notgithub.com` must not match.
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return undefined;
  }
  // Indexed rather than filtered for empties: on `github.com//repo` the owner
  // slot is genuinely empty, and skipping it would promote the NEXT segment
  // into the owner position and resolve a plausible-looking wrong avatar.
  const owner = parsed.pathname.split('/')[1];
  if (owner === undefined || !GITHUB_OWNER_PATTERN.test(owner)) {
    return undefined;
  }
  return `https://github.com/${owner}.png?size=${String(GITHUB_AVATAR_SIZE_PX)}`;
}

/**
 * A product-site favicon for catalog records whose provider omitted artwork.
 *
 * The result still goes through the main-process remote-image resolver before
 * it reaches an `<img>`, so the renderer never loads the third-party resource
 * directly. Keeping this as a final fallback means catalog product artwork and
 * bundled marks always win, while every official connector with an author URL
 * avoids dropping all the way to a misleading initial-only avatar.
 */
function marketplaceProductIconUrl(
  productUrl: string | undefined,
): string | undefined {
  if (productUrl === undefined || productUrl === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(productUrl);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return undefined;
  }
  parsed.hash = '';
  return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(parsed.toString())}&sz=128`;
}

/**
 * Bundled mark for a marketplace plugin, when Canopy already ships one.
 *
 * Two cases, both resolved from data rather than from a per-plugin mapping:
 *
 * - Canopy's OWN built-in plugins wear the app's brand mark. They ship inside
 *   the app, so there is no publisher repo to point at, and the brand asset
 *   comes from the runtime rather than a constant so whitelabel builds show
 *   their own mark rather than Canopy's.
 * - Recognizable entries from Codex's built-in marketplace reuse their product
 *   mark. Publisher metadata is not consistent enough to establish identity:
 *   the same official feed may identify the publisher as OpenAI, the connected
 *   product, or omit it. The marketplace id plus the explicit product mapping
 *   below is stable, while an arbitrary plugin merely named `github` cannot
 *   impersonate GitHub.
 */
function bundledPluginLogo(
  marketplaceId: string,
  plugin: MarketplacePluginLogoInput,
): string | undefined {
  const logoKey = officialProductLogoKey(marketplaceId, plugin);
  return logoKey === undefined ? undefined : MCP_BRAND_LOGOS[logoKey];
}

/**
 * Fallback logo for a marketplace plugin: the avatar of whoever publishes it.
 *
 * Codex catalog entries normally carry their own product logo. Older cached
 * rows and provider catalogs without that field still use this source-derived
 * fallback before the card gives up and renders a monogram.
 *
 * Resolved PER PLUGIN, from the plugin's own source, never from the
 * marketplace that lists it. A marketplace is usually an aggregator:
 * `claude-plugins-official` publishes 286 plugins from 179 different owners
 * (Auth0, CrowdStrike, Adobe, Figma…). Using the marketplace owner would badge
 * every one of those with Anthropic's mark, which is worse than a monogram —
 * a blank tile says nothing, but the wrong logo asserts the wrong provenance.
 *
 * `externalSource.url` is the vendored repo the plugin is pulled from and is
 * the strongest signal; `homepage` covers the plugins that live in the
 * marketplace repo itself (it points at their own subdirectory, so the owner
 * still resolves correctly — including genuinely first-party ones). A plugin
 * with neither keeps its monogram rather than borrowing the marketplace's
 * identity.
 */
export function pluginOwnerAvatarUrl(
  plugin: Pick<UnifiedMarketplacePluginInput, 'externalSource' | 'homepage'>,
): string | undefined {
  return (
    githubOwnerAvatarUrl(plugin.externalSource?.url) ??
    githubOwnerAvatarUrl(plugin.homepage)
  );
}

/** The fields a marketplace listing's mark is resolved from. */
export type MarketplacePluginLogoInput = Pick<
  UnifiedMarketplacePluginInput,
  'name' | 'logoUrl' | 'homepage' | 'externalSource' | 'builtIn'
>;

/**
 * The mark a non-curated marketplace listing wears, resolved exactly as its
 * card resolves it. Curated listings' cards resolve through
 * `buildCuratedPluginEntries` instead; on the portal the two agree today only
 * because the wire row carries no `logoUrl`, `homepage` or `authorUrl`.
 *
 * Exported because a detail page can load a listing on its own — the web
 * portal's does, by route, and never sees the entry its card was built from.
 * Resolving there by hand is how the portal detail came to show a monogram
 * beside a card wearing the Microsoft 365 mark; sharing the resolver keeps the
 * two from drifting.
 */
export function marketplacePluginLogo(
  marketplaceId: string,
  plugin: MarketplacePluginLogoInput,
): Pick<UnifiedPluginEntry, 'logoUrl' | 'bundledLogo' | 'brandMark'> {
  const bundledLogo = bundledPluginLogo(marketplaceId, plugin);
  return {
    logoUrl:
      plugin.logoUrl ??
      pluginOwnerAvatarUrl(plugin) ??
      (bundledLogo === undefined
        ? marketplaceProductIconUrl(plugin.homepage)
        : undefined),
    bundledLogo,
    brandMark: plugin.builtIn === true,
  };
}

function installedPluginFacts(
  plugin: UnifiedMarketplacePluginInput | undefined,
): Pick<UnifiedPluginEntry, 'version' | 'installedHarnesses'> {
  const status = plugin?.globalInstallStatus;
  if (!status) return {};
  const installed = [status.claude, status.codex].filter(
    (provider) => provider?.installed === true,
  );
  const version = installed[0]?.version;
  return {
    installedHarnesses: {
      claude: status.claude?.installed === true,
      codex: status.codex?.installed === true,
    },
    ...(version && installed.every((provider) => provider?.version === version)
      ? { version }
      : {}),
  };
}

function buildMarketplacePluginEntries(
  marketplaces: UnifiedMarketplaceInput[],
): UnifiedPluginEntry[] {
  const entries: UnifiedPluginEntry[] = [];
  for (const marketplace of marketplaces) {
    if (isCuratedMarketplace(marketplace)) continue;
    for (const plugin of marketplace.plugins) {
      const logo = marketplacePluginLogo(marketplace.id, plugin);
      // Product over publisher, the same rule the mark above follows.
      const author = pluginDisplayAuthor(marketplace.id, plugin);
      entries.push({
        id: `mkt:${marketplace.id}/${plugin.name}`,
        kind: 'plugin',
        origin: 'marketplace',
        name: pluginDisplayName(plugin),
        description: plugin.description ?? '',
        logoUrl: logo.logoUrl,
        bundledLogo: logo.bundledLogo,
        brandMark: logo.brandMark,
        categories: plugin.category ? [plugin.category] : [],
        authorName: author,
        typeLabel: 'Plugin',
        sourceLabel: marketplace.name,
        ownershipLabel: author,
        availabilityLabel: availabilityLabel(marketplacePluginState(plugin)),
        components: pluginDetailsComponents(plugin.details),
        providerSupport: pluginProviderSupport(plugin),
        state: marketplacePluginState(plugin),
        ...installedPluginFacts(plugin),
        recommended: false,
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: marketplace.id,
          pluginName: plugin.name,
        },
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Rule 4 — installed skills.
// ---------------------------------------------------------------------------

/**
 * Publisher avatar for an installed skill, from the repo it was installed
 * from.
 *
 * Skills record their origin as `github:<owner>:<repo>` (colon-separated, not
 * a URL — see `SkillLockEntry.sourceId`), so this reassembles the repo URL and
 * reuses the same resolution the plugin entries use. Locally authored and
 * built-in skills have no such origin and keep their monogram.
 */
export function skillOwnerAvatarUrl(
  skill: UnifiedInstalledSkillInput,
): string | undefined {
  const [kind, owner, repo] = skill.sourceId.split(':');
  if (kind !== 'github' || !owner || !repo) {
    return undefined;
  }
  return githubOwnerAvatarUrl(`https://github.com/${owner}/${repo}`);
}

function projectInstalledSkill(
  skill: UnifiedInstalledSkillInput,
): UnifiedPluginEntry {
  return {
    id: `skill:${skill.sourceId}:${skill.name}`,
    kind: 'skill',
    origin: 'installed-standalone',
    name: skill.name,
    description: skill.description,
    logoUrl: skillOwnerAvatarUrl(skill),
    // Built-in skills ship inside the app, same as built-in plugins, so they
    // wear the app's mark rather than a publisher's.
    brandMark: skill.builtIn === true,
    categories: [],
    authorName: undefined,
    typeLabel: 'Skill',
    sourceLabel: skill.builtIn
      ? 'Built-in'
      : skill.sourceId.startsWith('github:')
        ? 'GitHub'
        : 'Local',
    ownershipLabel: skill.sourceId.startsWith('github:')
      ? skill.sourceId.split(':')[1]
      : undefined,
    availabilityLabel: 'Installed',
    components: { ...emptyComponents(), skills: 1 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'installed',
    updateAvailable: skill.updateAvailable,
    builtIn: skill.builtIn,
    custom: skill.custom,
    recommended: false,
    ref: { type: 'skill', sourceId: skill.sourceId, skillName: skill.name },
  };
}

function buildSkillEntries(
  installedSkills: UnifiedInstalledSkillInput[],
): UnifiedPluginEntry[] {
  return installedSkills.map(projectInstalledSkill);
}

/**
 * The `buildUnifiedPluginEntries` entry for one locally installed skill,
 * display name included. Exported so a host can open an installed skill's
 * detail page before its own inventory projection has caught up (CAN-3483).
 */
export function buildInstalledSkillEntry(
  skill: UnifiedInstalledSkillInput,
): UnifiedPluginEntry {
  const entry = projectInstalledSkill(skill);
  return { ...entry, name: marketplaceTitleCase(entry.name) };
}

// ---------------------------------------------------------------------------
// Capability marketplace additions (CAN-1565 / CAN-1567).
// ---------------------------------------------------------------------------

function pipelineSourceLabel(source: PipelineInfo['source']): string {
  switch (source) {
    case 'curated':
      return 'Curated';
    case 'bundled':
      return 'Built-in';
    case 'project':
      return 'Project';
    case 'shared':
      return 'Shared';
    case 'user':
      return 'Local';
  }
}

function pipelineOrigin(source: PipelineInfo['source']): UnifiedEntryOrigin {
  switch (source) {
    case 'curated':
      return 'curated';
    case 'bundled':
      return 'built-in';
    case 'project':
      return 'project';
    case 'shared':
      return 'shared';
    case 'user':
      return 'installed-standalone';
  }
}

function buildPipelineEntries(pipelines: PipelineInfo[]): UnifiedPluginEntry[] {
  return pipelines
    .filter(
      (
        pipeline,
      ): pipeline is PipelineInfo & {
        source: Exclude<PipelineInfo['source'], 'curated'>;
      } => pipeline.source !== 'curated',
    )
    .map((pipeline): UnifiedPluginEntry => {
      const state: UnifiedEntryState =
        pipeline.source === 'shared' ? 'available' : 'installed';
      return {
        id: `pipeline:${pipeline.source}:${pipeline.id}`,
        kind: 'pipeline',
        origin: pipelineOrigin(pipeline.source),
        name: pipeline.name,
        description: pipeline.description,
        categories: [],
        authorName: pipeline.owner?.name ?? undefined,
        typeLabel: 'Pipeline',
        sourceLabel: pipelineSourceLabel(pipeline.source),
        ownershipLabel: sharedOwnershipLabel(
          pipeline.owner,
          pipeline.shareScope,
        ),
        ...(pipeline.source === 'shared'
          ? sharedWithFromOwner(pipeline.owner)
          : {}),
        availabilityLabel: availabilityLabel(state),
        components: emptyComponents(),
        providerSupport: NEUTRAL_PROVIDER_SUPPORT,
        state,
        recommended: false,
        pipeline: {
          source: pipeline.source,
          scopes: pipeline.scopes ?? ['directory'],
          triggerTypes: pipeline.triggerTypes ?? [],
        },
        ref: {
          type: 'pipeline',
          pipelineId: pipeline.id,
          source: pipeline.source,
          ...(pipeline.filePath ? { filePath: pipeline.filePath } : {}),
          ...(pipeline.remoteId ? { remoteId: pipeline.remoteId } : {}),
        },
      };
    });
}

function buildSharedSkillEntries(
  skills: SharedSkillSummary[],
): UnifiedPluginEntry[] {
  return skills.map(
    (skill): UnifiedPluginEntry => ({
      id: `skill:shared:${skill.id}`,
      kind: 'skill',
      origin: 'shared',
      name: skill.name,
      description: skill.description,
      categories: [],
      authorName:
        skill.owner.type === 'system'
          ? undefined
          : (skill.owner.name ?? undefined),
      typeLabel: 'Skill',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(skill.owner, skill.shareScope),
      ...sharedWithFromOwner(skill.owner),
      availabilityLabel: 'Available',
      components: { ...emptyComponents(), skills: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-skill', skillId: skill.id },
    }),
  );
}

function buildLocalCollectionEntries(
  collections: CollectionIndexEntry[],
): UnifiedPluginEntry[] {
  return collections.map(
    (collection): UnifiedPluginEntry => ({
      id: localCollectionEntryId(collection.id),
      kind: 'collection',
      origin: 'installed-standalone',
      name: collection.name,
      description: collection.description,
      categories: [],
      typeLabel: 'Collection',
      sourceLabel: 'Local',
      availabilityLabel: 'Installed',
      components: {
        skills: collection.skillCount,
        mcpServers: collection.mcpServerCount,
        commands: 0,
        agents: 0,
      },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'installed',
      recommended: false,
      ref: { type: 'local-collection', collectionId: collection.id },
    }),
  );
}

/** The unified entry id of a local collection, as its detail page opens it. */
export function localCollectionEntryId(collectionId: string): string {
  return `collection:local:${collectionId}`;
}

function buildSharedCollectionEntries(
  collections: SharedCollectionSummary[],
): UnifiedPluginEntry[] {
  return collections.map(
    (collection): UnifiedPluginEntry => ({
      id: `collection:shared:${collection.id}`,
      kind: 'collection',
      origin: 'shared',
      name: collection.name,
      description: collection.description,
      categories: [],
      authorName:
        collection.owner.type === 'system'
          ? undefined
          : (collection.owner.name ?? undefined),
      typeLabel: 'Collection',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(
        collection.owner,
        collection.shareScope,
      ),
      ...sharedWithFromOwner(collection.owner),
      availabilityLabel: 'Available',
      components: {
        skills:
          collection.itemCounts.skills + collection.itemCounts.customSkills,
        mcpServers: 0,
        commands: 0,
        agents: 0,
      },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-collection', collectionId: collection.id },
    }),
  );
}

// ---------------------------------------------------------------------------
// Agents, plugin references and project templates shared with the viewer.
// ---------------------------------------------------------------------------

function ownerDisplayName(owner: ResourceOwner): string | undefined {
  return owner.type === 'system' ? undefined : (owner.name ?? undefined);
}

function buildLocalAgentEntries(
  agents: UnifiedLocalAgentInput[],
): UnifiedPluginEntry[] {
  return agents.map(
    (agent): UnifiedPluginEntry => ({
      id: localAgentEntryId(agent.id),
      kind: 'agent',
      origin: 'installed-standalone',
      name: agent.name,
      description: agent.description,
      categories: [],
      typeLabel: 'Agent',
      sourceLabel: 'Local',
      availabilityLabel: agent.available ? 'Installed' : 'Unavailable',
      components: { ...emptyComponents(), agents: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'installed',
      recommended: false,
      ref: { type: 'local-agent', agentId: agent.id },
    }),
  );
}

const LOCAL_AGENT_ENTRY_PREFIX = localAgentEntryId('');

/** The local agent id an entry id names, or `null` for any other entry. */
export function localAgentIdFromEntryId(entryId: string): string | null {
  if (!entryId.startsWith(LOCAL_AGENT_ENTRY_PREFIX)) return null;
  const agentId = entryId.slice(LOCAL_AGENT_ENTRY_PREFIX.length);
  return agentId === '' ? null : agentId;
}

/**
 * A local agent opened by id before the inventory lists it, such as a deep
 * link that lands while agents hydrate. Its detail resolves the definition,
 * or reports the agent missing once the inventory has settled.
 */
export function pendingLocalAgentEntry(
  entryId: string,
): UnifiedPluginEntry | null {
  const agentId = localAgentIdFromEntryId(entryId);
  if (agentId === null) return null;
  return {
    id: entryId,
    kind: 'agent',
    origin: 'installed-standalone',
    name: 'Agent',
    description: '',
    categories: [],
    typeLabel: 'Agent',
    sourceLabel: 'Local',
    availabilityLabel: 'Installed',
    components: { ...emptyComponents(), agents: 1 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'installed',
    recommended: false,
    ref: { type: 'local-agent', agentId },
  };
}

/**
 * Shared agents the viewer already holds a local copy of are listed once, as
 * the local row. Only an exact `sharedRemoteId` match folds; names never do,
 * and the shared resource itself stays resolvable for direct links.
 */
function sharedAgentsWithoutLocalCopies(
  shared: SharedAgentSummary[],
  local: UnifiedLocalAgentInput[],
  viewerId?: string | null,
): SharedAgentSummary[] {
  const localRemoteIds = new Set(
    local.flatMap((agent) =>
      agent.sharedRemoteId ? [agent.sharedRemoteId] : [],
    ),
  );
  if (localRemoteIds.size === 0) return shared;
  return shared.filter(
    (agent) =>
      !localRemoteIds.has(agent.id) ||
      (viewerId != null &&
        agent.createdBy.id === viewerId &&
        agent.shareScope !== 'private'),
  );
}

function buildSharedAgentEntries(
  agents: SharedAgentSummary[],
): UnifiedPluginEntry[] {
  return agents.map(
    (agent): UnifiedPluginEntry => ({
      id: `agent:shared:${agent.id}`,
      kind: 'agent',
      origin: 'shared',
      name: agent.name,
      description: agent.instructionsPreview,
      categories: [],
      authorName: agent.createdBy.name ?? ownerDisplayName(agent.owner),
      typeLabel: 'Agent',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(agent.owner, agent.shareScope),
      ...sharedWithFromOwner(agent.owner),
      availabilityLabel: 'Available',
      components: { ...emptyComponents(), agents: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-agent', agentId: agent.id },
    }),
  );
}

function buildSharedPluginEntries(
  plugins: SharedPluginSummary[],
): UnifiedPluginEntry[] {
  return plugins.map(
    (plugin): UnifiedPluginEntry => ({
      id: `plugin:shared:${plugin.externalId}`,
      kind: 'plugin',
      origin: 'shared',
      name: plugin.name,
      description: plugin.description ?? '',
      categories: [],
      authorName: plugin.createdBy.name ?? ownerDisplayName(plugin.owner),
      typeLabel: 'Plugin',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(plugin.owner, plugin.shareScope),
      ...sharedWithFromOwner(plugin.owner),
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-plugin', pluginId: plugin.externalId },
    }),
  );
}

function buildSharedBlueprintEntries(
  blueprints: WorkspaceTemplateShareSummary[],
): UnifiedPluginEntry[] {
  return blueprints.map(
    (blueprint): UnifiedPluginEntry => ({
      id: `blueprint:shared:${blueprint.externalId}`,
      kind: 'blueprint',
      origin: 'shared',
      name: blueprint.name,
      description: blueprint.description,
      categories: [],
      authorName: blueprint.createdBy.name ?? ownerDisplayName(blueprint.owner),
      // `blueprint` is the internal kind; users read "project template".
      typeLabel: WORKSPACE_TEMPLATE_SHARE_LABEL,
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(
        blueprint.owner,
        blueprint.audience === 'PUBLIC'
          ? undefined
          : blueprint.audience.toLowerCase(),
      ),
      ...sharedWithFromOwner(blueprint.owner),
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-blueprint', blueprintId: blueprint.externalId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Automations: local copies, team shares, and the curated catalog.
// ---------------------------------------------------------------------------

type AutomationInstallSourceKind = 'shared' | 'curated';

/**
 * Which Marketplace source a local automation was installed from, or `null`
 * for one the user authored or installed from a public share. Public installs
 * record a public-share id, a different namespace from team-share ids and
 * curated keys, so they never pair with a Marketplace row.
 */
function automationInstallSourceKind(
  automation: UnifiedLocalAutomationInput,
): AutomationInstallSourceKind | null {
  if (!automation.installedFrom) return null;
  const sourceKind = automation.installedFrom.sourceKind ?? 'shared';
  return sourceKind === 'public' ? null : sourceKind;
}

interface AutomationEntryOptions {
  /**
   * Keep a shared row even when a local copy or source exists. Set only by
   * the "Shared by me" facet; curated rows keep their local-copy rule.
   */
  readonly skipLocalDedupe?: boolean;
  readonly retainCatalogEntries?: boolean;
}

/** Entry id prefix of a team-shared automation: `automation:shared:<id>`. */
const SHARED_AUTOMATION_ENTRY_PREFIX = 'automation:shared:';

function sharedAutomationEntry(
  summary: SharedAutomationSummary,
): UnifiedPluginEntry {
  return {
    id: `${SHARED_AUTOMATION_ENTRY_PREFIX}${summary.id}`,
    kind: 'automation',
    origin: 'shared',
    name: summary.name,
    description: markdownDescriptionToPlainText(summary.description) ?? '',
    categories: [],
    authorName:
      summary.owner.type === 'system'
        ? undefined
        : (summary.owner.name ?? undefined),
    typeLabel: 'Automation',
    sourceLabel: 'Shared',
    ownershipLabel: sharedOwnershipLabel(summary.owner, summary.shareScope),
    ...sharedWithFromOwner(summary.owner),
    availabilityLabel: 'Available',
    components: emptyComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'available',
    recommended: false,
    ref: { type: 'shared-automation', automationId: summary.id },
  };
}

/**
 * A stand-in entry for a shared automation opened by id while the browse
 * inventory does not list it, such as the user's own public-link-only share
 * outside the "Shared by me" facet. The detail loads the share by id and
 * reports its real name. Returns `null` for any other entry id.
 */
export function pendingSharedAutomationEntry(
  entryId: string,
): UnifiedPluginEntry | null {
  if (!entryId.startsWith(SHARED_AUTOMATION_ENTRY_PREFIX)) return null;
  const automationId = entryId.slice(SHARED_AUTOMATION_ENTRY_PREFIX.length);
  if (automationId === '') return null;
  return {
    id: entryId,
    kind: 'automation',
    origin: 'shared',
    name: 'Shared automation',
    description: '',
    categories: [],
    typeLabel: 'Automation',
    sourceLabel: 'Shared',
    availabilityLabel: 'Available',
    components: emptyComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'available',
    recommended: false,
    ref: { type: 'shared-automation', automationId },
  };
}

/**
 * One row per automation, and the local copy wins. A team share the user
 * published or installed lists only as their local automation, and so does a
 * curated automation they installed; the local row says when its source has
 * changed since. The "Shared by me" facet skips that rule for shares, so an
 * owned share lists beside its local source.
 */
function buildAutomationEntries(
  localAutomations: UnifiedLocalAutomationInput[],
  sharedAutomations: SharedAutomationSummary[],
  curatedAutomations: CuratedAutomationSummary[],
  {
    skipLocalDedupe = false,
    retainCatalogEntries = false,
  }: AutomationEntryOptions = {},
  viewerId?: string | null,
): UnifiedPluginEntry[] {
  const sharedHashes = new Map<string, string>();
  for (const summary of sharedAutomations) {
    sharedHashes.set(summary.id, summary.contentHash);
  }
  const curatedHashes = new Map<string, string>();
  for (const summary of curatedAutomations) {
    curatedHashes.set(summary.key, summary.contentHash);
  }

  const localSharedIds = new Map<string, string>();
  const localCuratedKeys = new Map<string, string>();
  const entries: UnifiedPluginEntry[] = [];

  for (const automation of localAutomations) {
    if (automation.sharedRemoteId !== undefined) {
      localSharedIds.set(
        automation.sharedRemoteId,
        `automation:local:${automation.id}`,
      );
    }
    const sourceKind = automationInstallSourceKind(automation);
    const installedFrom = automation.installedFrom;
    let sourceHash: string | undefined;
    if (installedFrom && sourceKind === 'shared') {
      localSharedIds.set(
        installedFrom.remoteId,
        `automation:local:${automation.id}`,
      );
      sourceHash =
        automation.sourceContentHash ??
        sharedHashes.get(installedFrom.remoteId);
    } else if (installedFrom && sourceKind === 'curated') {
      localCuratedKeys.set(
        installedFrom.remoteId,
        `automation:local:${automation.id}`,
      );
      sourceHash =
        automation.sourceContentHash ??
        curatedHashes.get(installedFrom.remoteId);
    }
    const updateAvailable =
      installedFrom !== undefined &&
      sourceHash !== undefined &&
      sourceHash !== installedFrom.contentHash;
    entries.push({
      id: `automation:local:${automation.id}`,
      kind: 'automation',
      origin: 'installed-standalone',
      name: automation.name,
      description: automation.description,
      categories: [],
      typeLabel: 'Automation',
      sourceLabel: 'Local',
      availabilityLabel: updateAvailable ? 'Update available' : 'Installed',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'installed',
      ...(updateAvailable ? { updateAvailable: true } : {}),
      recommended: false,
      ref: { type: 'automation', activityId: automation.id },
    });
  }

  for (const summary of sharedAutomations) {
    if (
      !retainCatalogEntries &&
      !skipLocalDedupe &&
      localSharedIds.has(summary.id) &&
      (!viewerId || summary.createdBy?.id !== viewerId)
    )
      continue;
    const installedEntryId = localSharedIds.get(summary.id);
    entries.push({
      ...sharedAutomationEntry(summary),
      ...(retainCatalogEntries && installedEntryId
        ? {
            state: 'installed',
            availabilityLabel: 'Installed',
            installedEntryId,
          }
        : {}),
    });
  }

  for (const summary of curatedAutomations) {
    if (!retainCatalogEntries && localCuratedKeys.has(summary.key)) continue;
    const installedEntryId = localCuratedKeys.get(summary.key);
    entries.push({
      id: `automation:curated:${summary.key}`,
      kind: 'automation',
      origin: 'curated',
      name: summary.name,
      description: summary.shortDescription,
      categories: [...summary.categories],
      authorName: summary.authorName ?? undefined,
      typeLabel: 'Automation',
      sourceLabel: 'Curated',
      ownershipLabel: summary.authorName ?? undefined,
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: summary.popular,
      catalogSortOrder: summary.sortOrder,
      ref: { type: 'curated-automation', key: summary.key },
      ...(retainCatalogEntries && installedEntryId
        ? {
            state: 'installed',
            availabilityLabel: 'Installed',
            installedEntryId,
          }
        : {}),
    });
  }

  return entries;
}

/**
 * Marketplaces whose catalogues overlap, so the same plugin arrives more than
 * once.
 *
 * Deliberately a fixed set rather than a global name match. Codex subscribes to
 * Anthropic's marketplace as well as OpenAI's, so `slack` shows up from
 * `claude-plugins-official` through both providers plus OpenAI's own wrapper —
 * three rows, identical name, identical subtitle, no way to tell them apart.
 * Collapsing on name across *every* marketplace would also silently merge two
 * genuinely different plugins that a user or org happened to name the same,
 * and the card renders no source, so they would have no signal it happened.
 */
export const OVERLAPPING_MARKETPLACE_IDS: ReadonlySet<string> = new Set([
  'openai-curated-remote',
  'openai-curated',
  'claude-plugins-official',
]);

/**
 * Whether a catalog entry advertises a connector that can actually produce a
 * row. One predicate for all three consumers — the picker's read gate, the
 * source options, and the Plugins page — because they had drifted into three.
 * An entry with `providerConnector: { providers: [] }`, a shape the catalog
 * reader tolerates for forward-compatibility, passed a `!== undefined` gate
 * and then produced no row and no source option: a Claude CLI spawn and a
 * Codex cache parse paid for nothing.
 */
export function advertisesProviderConnector(
  entry: CuratedMcpServerEntry,
): boolean {
  return (entry.providerConnector?.providers.length ?? 0) > 0;
}

/** Names and catalog keys already covered by a provider-account connector. */
export interface ConnectorOwnership {
  names: ReadonlySet<string>;
  keys: ReadonlySet<string>;
}

/**
 * Whether a connector row already covers this capability, so listing it again
 * would show the same thing twice.
 *
 * Shared by the Plugins page and the chat plugin picker. The picker grew
 * connector rows without this rule and immediately showed two Gmails — the
 * connector plus the provider's own marketplace wrapper — which is the
 * duplicate this whole change exists to remove. The wrapper is also the worse
 * of the two: its `ON_INSTALL` auth is not implemented, so it is the copy that
 * dead-ends, and it is the one the user can actually tick.
 *
 * Curated entries match on catalog key, which is what the connector actually
 * replaces; a display name is neither unique nor stable. Everything else is
 * matched case-folded, because Codex's plugin manifests carry no displayName
 * and fall back to a bare `name` — `slack`, not `Slack`.
 */
export function supersededByConnector(
  candidate: { name: string; curatedKey?: string },
  ownership: ConnectorOwnership,
): boolean {
  if (candidate.curatedKey !== undefined) {
    return ownership.keys.has(candidate.curatedKey);
  }
  return ownership.names.has(candidate.name.toLowerCase());
}

/**
 * Collapse duplicate copies of a capability, keeping every copy that reaches a
 * provider no kept copy reaches.
 *
 * Exported and generic because the chat plugin picker collapses the same
 * duplicates this page does, and sharing only the `capabilityCovers` predicate
 * was not enough: the picker had its own single-slot first-seen comparison, so
 * with three overlapping copies the two surfaces still returned different
 * counts, and a pinned subset could evict the covering superset. Sharing the
 * whole traversal is what makes them agree.
 *
 * @param groupKey Folded key for collapsible items; `null` passes an item
 *   through untouched.
 * @param pinned Items that must never be dropped — installed copies on the
 *   Plugins page, already-selected rows in the picker. A pinned item displaces
 *   another only when it actually covers it.
 */
export function collapseByCoverage<T>(
  items: readonly T[],
  options: {
    groupKey: (item: T) => string | null;
    reach: (item: T) => CapabilityReach;
    pinned?: (item: T) => boolean;
  },
): T[] {
  const { groupKey, reach, pinned } = options;
  const groups = new Map<string, T[]>();
  const order: Array<{ key: string | null; item: T }> = [];
  for (const item of items) {
    const key = groupKey(item);
    if (key === null) {
      order.push({ key: null, item });
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    groups.set(key, [item]);
    order.push({ key, item });
  }

  const covers = (a: T, b: T): boolean => capabilityCovers(reach(a), reach(b));

  /** Keep every copy that nothing else in the same set covers. */
  const survivorsOf = (items: readonly T[]): T[] =>
    items.filter(
      (candidate, index) =>
        !items.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            covers(other, candidate) &&
            // A strict cover, or the earlier of two equals — so mutually
            // covering copies collapse to one rather than eliminating both.
            (!covers(candidate, other) || otherIndex < index),
        ),
    );

  const chosen = new Map<string, T[]>();
  for (const [key, group] of Array.from(groups.entries())) {
    const keep = pinned ? group.filter((item) => pinned(item)) : [];
    // Pinned copies are always kept, and they hide another copy only when they
    // actually cover it — otherwise pinning a Codex-only copy would take the
    // Claude-capable one away from Claude users.
    if (keep.length > 0) {
      const uncovered = group.filter(
        (candidate) =>
          !(pinned?.(candidate) ?? false) &&
          !keep.some((survivor) => covers(survivor, candidate)),
      );
      // The survivors of what the pinned copies did not cover still have to be
      // deduped against each other. Comparing them only against `keep` left two
      // identical uninstalled copies both standing — the same "three Slacks"
      // the unpinned branch below has always collapsed, surviving whenever one
      // copy happened to be installed.
      chosen.set(key, [...keep, ...survivorsOf(uncovered)]);
      continue;
    }
    const survivors = survivorsOf(group);
    chosen.set(
      key,
      survivors.length > 0
        ? survivors
        : [group[0]].flatMap((item) => (item ? [item] : [])),
    );
  }

  return order.flatMap(({ key, item }) =>
    key === null ? [item] : (chosen.get(key) ?? [item]),
  );
}

/**
 * Collapse the same capability published by overlapping marketplaces.
 *
 * Never collapses two copies the user has installed: those are two things they
 * can uninstall, and hiding one leaves no way to reach it from this list —
 * which is the invariant `notOwned` above spends fifteen lines defending.
 *
 * Among uninstalled copies, one is dropped only when another genuinely covers
 * it — its provider support is a superset. A count-based comparison looked
 * equivalent and was not: a Claude-only copy and a Codex-only copy both
 * "reach one provider", so marketplace order decided which survived, and
 * whichever lost took that capability away entirely from users of its
 * provider. Copies that cover each other collapse; copies that merely tie do
 * not.
 *
 * The copies not shown remain listed in the per-marketplace plugins modal,
 * which reads `marketplace.plugins` directly rather than this projection.
 */
function collapseDuplicateCapabilities(
  entries: UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  return collapseByCoverage(entries, {
    groupKey: (entry) =>
      entry.ref.type === 'marketplace-plugin' &&
      OVERLAPPING_MARKETPLACE_IDS.has(entry.ref.marketplaceId)
        ? entry.name.toLowerCase()
        : null,
    reach: (entry) => entry.providerSupport,
    // Two installs are two things the user can uninstall; hiding either leaves
    // no way to reach it from this list.
    pinned: (entry) => entry.state !== 'available',
  });
}

// ---------------------------------------------------------------------------
// Projection entry point
// ---------------------------------------------------------------------------

export function buildUnifiedPluginEntries(
  inputs: UnifiedEntryInputs,
): UnifiedPluginEntry[] {
  const curatedMcpByKey = new Map<string, CuratedMcpServerEntry>();
  for (const entry of inputs.curatedMcpServers) {
    curatedMcpByKey.set(entry.key, entry);
  }
  const connectors = buildProviderConnectorEntries(
    inputs.providerConnectors,
    inputs.curatedMcpServers,
    curatedMcpByKey,
    inputs.appName,
  );
  const providerEntries = connectors.entries;
  // One card per curated key (REG-3033). A connector the catalog advertises
  // for a key folds into that key's card as an alternative binding; it no
  // longer stands in for the entry. Gmail and Drive once needed the stand-in
  // because their curated endpoints could not authenticate; the card now
  // carries the connector route alongside, so the working path stays visible
  // and the user sees one Gmail rather than three.
  //
  // Connectors the catalog does not describe keep their own row, and their
  // names still suppress the provider marketplace's connector wrappers (whose
  // ON_INSTALL auth is not implemented), as the folded connectors' names do.
  //
  // A server the user installed is never suppressed. The advertised set is
  // served, so suppressing on it alone would let a catalog change hide a
  // server the user configured and authenticated — their configuration, hidden
  // by remote data they cannot see.
  //
  // Case-folded for the rest: Codex's plugin manifests carry no displayName, so
  // their entries fall back to a bare `name` — `slack`, not `Slack` — and an
  // exact comparison let every one of them through as a duplicate.
  const ownedNames = new Set(
    [
      ...providerEntries.map((entry) => entry.name),
      ...Array.from(connectors.folded.values()).map(
        (connector) => connector.displayName,
      ),
    ].map((name) => name.toLowerCase()),
  );
  // Nothing the user already has is ever suppressed, whatever kind it is.
  //
  // Keyed on state rather than ref type, because `notOwned` guards three lists
  // and narrower exemptions kept missing one. A `local-mcp`-only exemption
  // missed installed curated servers; adding those missed installed curated
  // and marketplace plugins — and Codex's marketplace publishes connector
  // wrappers for these very capabilities, so that collision is the expected
  // shape. Each miss was the same failure: a working, authenticated capability
  // vanishing from the grid and the Installed list, replaced by a row reading
  // "not set up", triggerable remotely by a hub checkbox.
  //
  // `mcpServerState` returns `available` only for a disconnected or pending
  // account connection, so "not available" is exactly "the user has this
  // already".
  const ownership: ConnectorOwnership = {
    names: ownedNames,
    // Every keyed connector folds into its card, so no key is owned by a
    // stand-in any more.
    keys: new Set<string>(),
  };
  const notOwned = (entry: UnifiedPluginEntry): boolean => {
    if (entry.state !== 'available') return true;
    // Name suppression is for a provider marketplace's wrapper of the
    // connector. A curated plugin is not one: a multi-key plugin named like a
    // folded connector keeps its card and its requirement chips.
    if (entry.ref.type === 'curated-plugin') return true;
    // Curated entries match on catalog key, which is what the connector
    // actually replaces; a display name is neither unique nor stable.
    return !supersededByConnector(
      {
        name: entry.name,
        curatedKey:
          entry.ref.type === 'curated-mcp' ? entry.ref.key : undefined,
      },
      ownership,
    );
  };

  const curatedPlugins = buildCuratedPluginEntries(
    inputs.curatedPlugins,
    inputs.marketplaces,
    curatedMcpByKey,
    inputs.foldSingleKeyPlugins === true,
  );
  const entries = [
    ...providerEntries,
    ...curatedPlugins.entries.filter(notOwned),
    ...buildMcpAppEntries(
      inputs.mcpServers,
      inputs.mcpStatuses,
      inputs.curatedMcpServers,
      curatedMcpByKey,
      curatedPlugins.folded,
      connectors.folded,
    ).filter(notOwned),
    ...buildSkillEntries(inputs.installedSkills),
    ...buildSharedSkillEntries(inputs.sharedSkills ?? []),
    ...buildPipelineEntries(inputs.pipelines ?? []),
    ...buildAutomationEntries(
      inputs.localAutomations ?? [],
      [
        ...new Map(
          (inputs.sharedAutomations ?? []).map((share) => [share.id, share]),
        ).values(),
      ],
      inputs.curatedAutomations ?? [],
      {
        skipLocalDedupe: inputs.skipLocalAutomationDedupe === true,
        retainCatalogEntries: inputs.retainAutomationCatalogEntries === true,
      },
      inputs.viewerId,
    ),
    ...buildLocalCollectionEntries(inputs.localCollections ?? []),
    ...buildSharedCollectionEntries(inputs.sharedCollections ?? []),
    ...buildLocalAgentEntries(inputs.localAgents ?? []),
    ...buildSharedAgentEntries(
      sharedAgentsWithoutLocalCopies(
        inputs.sharedAgents ?? [],
        inputs.localAgents ?? [],
        inputs.viewerId,
      ),
    ),
    ...buildSharedBlueprintEntries(inputs.sharedBlueprints ?? []),
    ...collapseDuplicateCapabilities(
      buildMarketplacePluginEntries(inputs.marketplaces).filter(notOwned),
    ),
    ...buildSharedPluginEntries(inputs.sharedPlugins ?? []),
  ];
  const creators = new Map<string, string>();
  const publications = new Map<string, boolean>();
  function recordShare(
    id: string,
    share: {
      createdBy: { id: string };
      shareScope: string;
      publicShare?: unknown;
    },
  ): void {
    creators.set(id, share.createdBy?.id);
    publications.set(
      id,
      share.shareScope === 'team' ||
        share.shareScope === 'organization' ||
        !!share.publicShare,
    );
  }
  for (const share of inputs.sharedSkills ?? [])
    recordShare(`skill:shared:${share.id}`, share);
  for (const share of inputs.sharedAutomations ?? [])
    recordShare(`${SHARED_AUTOMATION_ENTRY_PREFIX}${share.id}`, share);
  for (const share of inputs.sharedCollections ?? [])
    recordShare(`collection:shared:${share.id}`, share);
  for (const share of inputs.sharedAgents ?? [])
    recordShare(`agent:shared:${share.id}`, share);
  for (const share of inputs.sharedPlugins ?? [])
    recordShare(`plugin:shared:${share.externalId}`, share);
  for (const share of inputs.sharedBlueprints ?? []) {
    creators.set(`blueprint:shared:${share.externalId}`, share.createdBy?.id);
    publications.set(`blueprint:shared:${share.externalId}`, true);
  }
  return entries.map((entry) => ({
    ...entry,
    ...(publications.has(entry.id)
      ? { isShared: publications.get(entry.id) }
      : {}),
    ...(inputs.viewerId && entry.origin === 'shared'
      ? {
          ownedByViewer: creators.get(entry.id) === inputs.viewerId,
        }
      : {}),
    ...(entry.sharedWith?.audience === 'organization' &&
    inputs.personalOrganizationId &&
    entry.sharedWith.organizationId === inputs.personalOrganizationId
      ? {
          sharedWith: { ...entry.sharedWith, personal: true, name: 'Personal' },
        }
      : {}),
    // Plugins, agents and project templates carry an authored display name;
    // every other kind is named by a slug that reads better title-cased.
    name:
      entry.kind === 'plugin' ||
      entry.kind === 'agent' ||
      entry.kind === 'blueprint'
        ? entry.name
        : marketplaceTitleCase(entry.name),
  }));
}

interface ProviderConnectorProjection {
  /** Connectors the catalog does not describe, as rows of their own. */
  entries: UnifiedPluginEntry[];
  /** Connectors folded into the integration card for their catalog key. */
  folded: Map<string, FoldedConnector>;
}

/**
 * Connectors reachable through a provider's own account.
 *
 * These are advertised whether or not anything is linked — a user with nothing
 * set up still has to be able to discover that Gmail is connectable, and the
 * providers publish no way to ask "could I connect this?" without asking the
 * account. The served catalog is the only source of what to advertise; there
 * is no bundled fallback, so a cold or unreachable catalog hides connectors
 * exactly as it already hides every other curated entry.
 */
function buildProviderConnectorEntries(
  results: ProviderConnectorListResult[],
  curated: CuratedMcpServerEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  appName: string | undefined,
): ProviderConnectorProjection {
  // Deliberately not gated on `results`. The catalog decides which connectors
  // exist and is available on first paint; the reads only decide whether each
  // is linked and take seconds. Returning [] here meant the first paint had no
  // connector rows, so nothing was suppressed and the provider's own
  // marketplace plugins rendered — then swapped once the reads landed. It also
  // conflated "the catalog advertises nothing" with "the read failed".
  // Linked state comes from the same builder the detail panel uses. Computing
  // it here independently meant the two joins could disagree: this one matched
  // on the catalog display name alone, so a connector linked under a different
  // account-side name (`claudeConnectorName`, or a Codex entry pinned by id)
  // read "Connected" in the detail panel and `available` in this list.
  const rows = buildProviderConnectorRows(results, curated);
  const folded = new Map<string, FoldedConnector>();
  const entries: UnifiedPluginEntry[] = [];
  for (const row of rows) {
    const connected = row.providers.some((provider) => provider.connected);
    const catalogEntry = row.curatedKey
      ? curatedByKey.get(row.curatedKey)
      : undefined;
    if (catalogEntry) {
      folded.set(catalogEntry.key, {
        displayName: row.displayName,
        connected,
        connectedProviders: row.providers
          .filter((provider) => provider.connected)
          .map((provider) => provider.provider),
      });
      continue;
    }
    entries.push({
      id: `provider-connector:${row.displayName}`,
      kind: 'app',
      origin: 'curated',
      name: row.displayName,
      description: `Connect with your Claude or Codex account. ${appName ?? 'The app'} never sees these credentials.`,
      categories: [],
      authorName: undefined,
      components: mcpAppComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      // `needs-auth` buckets into Installed, which is right for a curated
      // server the user added and wrong here: an unlinked connector was never
      // installed, so listing it as such — with a "Needs attention" badge —
      // reports work the user never started.
      state: connected ? 'installed' : 'available',
      recommended: false,
      ref: {
        type: 'provider-connector',
        displayName: row.displayName,
        ...(row.curatedKey ? { curatedKey: row.curatedKey } : {}),
      },
    });
  }
  return { entries, folded };
}

// ---------------------------------------------------------------------------
// Search / ranking
// ---------------------------------------------------------------------------

interface ScoredEntry {
  entry: UnifiedPluginEntry;
  score: number;
}

function matchScore(
  entry: UnifiedPluginEntry,
  normalizedQuery: string,
): number {
  let score = 0;
  const readableQuery = normalizedQuery.replace(/[-_]+/g, ' ');
  if (entry.name.toLowerCase().includes(readableQuery)) score += 3;
  if (entry.description.toLowerCase().includes(normalizedQuery)) score += 2;
  if (
    entry.categories.some((category) =>
      category.toLowerCase().includes(normalizedQuery),
    )
  ) {
    score += 1;
  }
  if (
    [
      entry.typeLabel,
      entry.sourceLabel,
      entry.ownershipLabel,
      entry.sharedWith?.name,
      entry.availabilityLabel,
      entry.authorName,
    ].some((value) => value?.toLowerCase().includes(normalizedQuery))
  ) {
    score += 1;
  }
  return score;
}

type RankedResultsKey = keyof RankedResults;

const BAND_ORDER: RankedResultsKey[] = [
  'installed',
  'curatedPlugins',
  'curatedApps',
  'marketplace',
  'sharedPlugins',
  'skills',
  'pipelines',
  'automations',
  'collections',
  'agents',
  'projectTemplates',
];

function bandFor(entry: UnifiedPluginEntry): RankedResultsKey {
  if (entry.kind === 'pipeline') return 'pipelines';
  if (entry.kind === 'automation') return 'automations';
  if (entry.kind === 'collection') return 'collections';
  if (entry.kind === 'agent') return 'agents';
  if (entry.kind === 'blueprint') return 'projectTemplates';
  if (entry.kind === 'skill' && entry.origin === 'shared') return 'skills';
  // A shared plugin reference is not a catalog listing: it has no category
  // and is listed under its own heading, like shared skills.
  if (entry.kind === 'plugin' && entry.origin === 'shared') {
    return 'sharedPlugins';
  }
  if (entry.state !== 'available') return 'installed';
  if (entry.origin === 'curated' && entry.kind === 'plugin') {
    return 'curatedPlugins';
  }
  if (entry.origin === 'curated' && entry.kind === 'app') {
    return 'curatedApps';
  }
  return 'marketplace';
}

function isCuratedBand(band: RankedResultsKey): boolean {
  return band === 'curatedPlugins' || band === 'curatedApps';
}

function compareByScoreThenName(a: ScoredEntry, b: ScoredEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.entry.name.localeCompare(b.entry.name);
}

function compareCuratedBand(a: ScoredEntry, b: ScoredEntry): number {
  if (a.entry.recommended !== b.entry.recommended) {
    return a.entry.recommended ? -1 : 1;
  }
  return compareByScoreThenName(a, b);
}

/** Local agents lead their section; each group keeps a stable order. */
function compareAgentBand(a: ScoredEntry, b: ScoredEntry): number {
  const aLocal = a.entry.ref.type === 'local-agent';
  const bLocal = b.entry.ref.type === 'local-agent';
  if (aLocal !== bLocal) return aLocal ? -1 : 1;
  return compareByScoreThenName(a, b) || a.entry.id.localeCompare(b.entry.id);
}

function bandComparator(
  band: RankedResultsKey,
): (a: ScoredEntry, b: ScoredEntry) => number {
  if (isCuratedBand(band)) return compareCuratedBand;
  if (band === 'agents') return compareAgentBand;
  return compareByScoreThenName;
}

function emptyRankedResults(): RankedResults {
  return {
    installed: [],
    curatedPlugins: [],
    curatedApps: [],
    marketplace: [],
    sharedPlugins: [],
    skills: [],
    pipelines: [],
    automations: [],
    collections: [],
    agents: [],
    projectTemplates: [],
  };
}

export function searchUnifiedEntries(
  entries: UnifiedPluginEntry[],
  query: string,
  category: string | null,
): RankedResults {
  const normalizedCategory = category === null ? null : category.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  const banded: Record<RankedResultsKey, ScoredEntry[]> = {
    installed: [],
    curatedPlugins: [],
    curatedApps: [],
    marketplace: [],
    sharedPlugins: [],
    skills: [],
    pipelines: [],
    automations: [],
    collections: [],
    agents: [],
    projectTemplates: [],
  };

  for (const entry of entries) {
    if (
      normalizedCategory !== null &&
      !entry.categories.some(
        (category_) => category_.toLowerCase() === normalizedCategory,
      )
    ) {
      continue;
    }
    const score =
      normalizedQuery === '' ? 0 : matchScore(entry, normalizedQuery);
    if (normalizedQuery !== '' && score === 0) continue;
    banded[bandFor(entry)].push({ entry, score });
  }

  const results = emptyRankedResults();
  for (const band of BAND_ORDER) {
    results[band] = [...banded[band]]
      .sort(bandComparator(band))
      .map((scored) => scored.entry);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Category union
// ---------------------------------------------------------------------------

export function collectEntryCategories(
  entries: UnifiedPluginEntry[],
): string[] {
  // Catalog and marketplace data mix casings ("productivity" vs
  // "Productivity"); merge case-insensitively, keeping the first-seen
  // display casing. Filtering already lowercases, so any variant matches.
  const categories = new Map<string, string>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      const key = category.toLowerCase();
      if (!categories.has(key)) {
        categories.set(key, category);
      }
    }
  }
  return Array.from(categories.values()).sort((a, b) => a.localeCompare(b));
}
