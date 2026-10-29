import type {
  UnifiedEntryKind,
  UnifiedEntryOrigin,
  UnifiedEntryRef,
  UnifiedEntryState,
} from '@canopy/protocol/unified-entry';
import type {
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/protocol/pipelines';
import type { PipelineSourceBadgeKey } from './pipeline-source-badges';

export type UnifiedEntrySurface = 'cloud' | 'desktop';

export const UNIFIED_ENTRY_SURFACE_LABELS: Record<UnifiedEntrySurface, string> =
  {
    cloud: 'Cloud + desktop',
    desktop: 'Desktop only',
  };

/** What the Marketplace Pipelines tab filters on; set on every pipeline entry. */
export interface UnifiedPipelineFacets {
  source: PipelineSourceBadgeKey;
  scopes: readonly PipelineExecutionScope[];
  triggerTypes: readonly PipelineTriggerType[];
}

/** How one connection on an integration card is bound. */
export type UnifiedEntryBinding = 'account' | 'device' | 'provider';

/** One connection an integration card lists, named as the user sees it. */
export interface UnifiedEntryConnection {
  /** Picker `serverId`: the connection's server key for account rows. */
  readonly serverId: string;
  readonly configId?: string;
  readonly name: string;
  readonly binding: UnifiedEntryBinding;
  readonly state: UnifiedEntryState;
  readonly accountConnectionId?: string;
}

/** The curated plugin folded into its integration card (REG-3033). */
export interface UnifiedEntryFoldedPlugin {
  /** Curated plugin key; the host installs it from here. */
  readonly key: string;
  readonly name: string;
  readonly skills: number;
  readonly installed: boolean;
}

/** A provider-account connector folded into its integration card. */
export interface UnifiedEntryFoldedConnector {
  readonly displayName: string;
  readonly connected: boolean;
}

/**
 * Everything one curated integration card stands for: its connections, the
 * plugin that ships its skills, and a provider connector that can bind it
 * through a Claude or Codex account instead (REG-3033).
 */
export interface UnifiedEntryIntegration {
  readonly curatedKey: string;
  readonly plugin?: UnifiedEntryFoldedPlugin;
  readonly connector?: UnifiedEntryFoldedConnector;
  readonly connections: readonly UnifiedEntryConnection[];
}

/** An integration a multi-connection plugin needs, linking to its card. */
export interface UnifiedEntryRequirement {
  readonly key: string;
  readonly name: string;
  readonly entryId: string;
}

/**
 * The team or organization a shared entry is shared with. Personal and public
 * shares carry none: nothing narrower than "everyone" or "only you" to name.
 */
export interface UnifiedEntrySharedWith {
  audience: 'team' | 'organization';
  organizationId?: string;
  personal?: boolean;
  /** The team's or organization's name, when the server reports one. */
  name?: string;
}

/** The shared status badge's input, derived once for list and detail. */
export interface UnifiedEntryConnectionStatus {
  status: 'connected' | 'auth_required' | 'unreachable' | 'unknown';
  provider?: boolean;
}

/** Display projection shared by catalog surfaces; contains no host behavior. */
export interface UnifiedPluginEntry {
  id: string;
  kind: UnifiedEntryKind;
  origin: UnifiedEntryOrigin;
  name: string;
  description: string;
  logoUrl?: string;
  bundledLogo?: string;
  brandMark?: boolean;
  categories: string[];
  authorName?: string;
  /** Human-readable result metadata used by cross-capability search. */
  typeLabel?: string;
  sourceLabel?: string;
  ownershipLabel?: string;
  /** Set on every entry shared with a team or organization. */
  sharedWith?: UnifiedEntrySharedWith;
  availabilityLabel?: string;
  components: {
    skills: number;
    mcpServers: number;
    commands: number;
    agents: number;
  };
  providerSupport: { claude: boolean; codex: boolean };
  state: UnifiedEntryState;
  /**
   * The source this installed entry came from has changed since it was
   * installed. Cards badge it; the detail surface offers the update.
   */
  updateAvailable?: boolean;
  /** Installed version only; omitted when its provenance is unknown. */
  version?: string;
  latestVersion?: string;
  /** Actual installations, independent of provider support. Cursor is unavailable. */
  installedHarnesses?: { claude?: boolean; codex?: boolean };
  builtIn?: boolean;
  custom?: boolean;
  /** Explicit creator identity match, never inferred from organization ownership. */
  ownedByViewer?: boolean;
  /** Explicit publication state; a private cloud record alone is not a share. */
  isShared?: boolean;
  /** Catalog representation of this canonical local install, when distinct. */
  installedEntryId?: string;
  /** Where an MCP entry runs: cloud sessions and desktop, or desktop only. */
  surface?: UnifiedEntrySurface;
  /** Cached connection health of an installed MCP entry; absent elsewhere. */
  connection?: UnifiedEntryConnectionStatus;
  recommended: boolean;
  /** Stable catalog order used only as a browse-ranking fallback. */
  catalogSortOrder?: number;
  pipeline?: UnifiedPipelineFacets;
  /** Set on a curated integration card; see {@link UnifiedEntryIntegration}. */
  integration?: UnifiedEntryIntegration;
  /** Set on a plugin that needs several integrations, one chip per key. */
  requirements?: readonly UnifiedEntryRequirement[];
  ref: UnifiedEntryRef;
}
