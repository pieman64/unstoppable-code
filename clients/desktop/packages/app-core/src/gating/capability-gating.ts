/**
 * Capability-gating contract for the shared Code-workspace UI.
 *
 * This module is the single rulebook mapping each panel kind (and each
 * non-panel feature surface) to the {@link CanopyCapabilities} it requires,
 * so one shared root component can render on both desktop (full
 * capabilities) and web (relay-limited capabilities) without ever branching
 * on `isWeb`/`isDesktop`.
 *
 * Design rules:
 * - **Declarative, not imperative.** Requirements are data
 *   ({@link CapabilityRequirement}), evaluated by one pure predicate
 *   ({@link meetsCapabilityRequirement}). Hosts never encode platform
 *   knowledge; they only declare capabilities on their `CanopyClient`.
 * - **Conjunction semantics.** Every field present on a requirement must be
 *   satisfied. An empty requirement (`{}`) means the surface is universal.
 * - **Leveled capabilities are minimums.** `fileSystemAccess: 'read'` means
 *   "at least read"; a `'read-write'` host also qualifies.
 * - **Unknown kinds are hidden.** `isPanelAvailable` /
 *   `isFeatureSurfaceAvailable` return `false` for identifiers this build
 *   does not know. A kind minted by a newer build may carry requirements
 *   this build cannot evaluate, so showing it could leak a surface onto a
 *   host that cannot support it (e.g. a PTY terminal on Remote Control). Hiding an
 *   unknown surface degrades to "feature not present", which is always safe;
 *   showing one can degrade to a broken panel. Registry-driven hosts also
 *   cannot render a kind they have no definition for, so default-visible
 *   would promise something the host cannot deliver anyway.
 * - **`routing` is not a gating axis.** It selects a `NavigationController`
 *   adapter mode (in-memory vs URL); it never makes a surface unavailable.
 *
 * Purity: no React, no state, no side effects — only `@canopy/protocol`
 * (pure wire contracts) and local capability types.
 */

import type { PanelKind } from '@canopy/protocol';
import { PANEL_KINDS, isPanelKind } from '@canopy/protocol';
import type {
  CanopyCapabilities,
  FileSystemAccessLevel,
  PipelineCapability,
} from '../client/capabilities';

/**
 * The capabilities a surface needs before a host may render it.
 *
 * All fields are optional; every present field must be satisfied
 * (conjunction). Boolean fields may only demand `true` (demanding `false`
 * would gate a surface on the *absence* of power, which is a UX decision,
 * not a capability one). Leveled fields demand a minimum level, and the
 * bottom level of each scale is unrepresentable here because requiring it
 * would be a no-op.
 */
export interface CapabilityRequirement {
  /** Requires the host to run work locally (scripts, dev servers, agents). */
  readonly localExecution?: true;
  /** Requires an interactive PTY on the host. */
  readonly terminalPty?: true;
  /** Requires on-device voice dictation. */
  readonly voice?: true;
  /** Minimum file-system reach (`'read'` or `'read-write'`). */
  readonly fileSystemAccess?: Exclude<FileSystemAccessLevel, 'none'>;
  /** Minimum pipeline affordance (`'crud-only'` or `'execute'`). */
  readonly pipelines?: Exclude<PipelineCapability, 'read-only'>;
  /** Requires the full settings surface (not `'api-keys-only'`). */
  readonly settingsScope?: 'full';
  /** Requires the host to expose panel-layout controls. */
  readonly panelLayoutControls?: true;
  /** Requires the host's native worktree-open (IDE/Finder) surface. */
  readonly nativeWorktreeOpen?: true;
  /** Requires the host to list and manage the user's own automation shares. */
  readonly marketplaceOwnedAutomationShares?: true;
  /** Requires the host to list the user's own shares on every Marketplace tab. */
  readonly marketplaceOwnedShares?: true;
  /** Requires the host to edit shared collections from their detail. */
  readonly marketplaceSharedCollectionEdit?: true;
  /** Requires the host to manage and run automations. */
  readonly automations?: true;
  /** Requires the host to list and manage watchers. */
  readonly watchers?: true;
  /** Requires the host to have wired organization projects (CAN-2944). */
  readonly orgProjects?: true;
  /** Requires the host to read the Agent Ledger. */
  readonly ledger?: true;
  readonly itemGrouping?: true;
  /** Requires the host to read a work scope's observed cost. */
  readonly costInsights?: true;
}

const FILE_SYSTEM_ACCESS_RANK: Readonly<Record<FileSystemAccessLevel, number>> =
  {
    none: 0,
    read: 1,
    'read-write': 2,
  };

const PIPELINE_CAPABILITY_RANK: Readonly<Record<PipelineCapability, number>> = {
  'read-only': 0,
  'crud-only': 1,
  execute: 2,
};

/**
 * Pure predicate: does `capabilities` satisfy every demand in `requirement`?
 *
 * This is the one evaluation function behind {@link isPanelAvailable} and
 * {@link isFeatureSurfaceAvailable}; it is exported so the future shared
 * panel host can gate ad-hoc surfaces (menu items, toolbar buttons) with the
 * same semantics without minting a registry entry.
 */
export function meetsCapabilityRequirement(
  capabilities: CanopyCapabilities,
  requirement: CapabilityRequirement,
): boolean {
  if (requirement.localExecution === true && !capabilities.localExecution) {
    return false;
  }
  if (requirement.terminalPty === true && !capabilities.terminalPty) {
    return false;
  }
  if (requirement.voice === true && !capabilities.voice) {
    return false;
  }
  if (
    requirement.fileSystemAccess !== undefined &&
    FILE_SYSTEM_ACCESS_RANK[capabilities.fileSystemAccess] <
      FILE_SYSTEM_ACCESS_RANK[requirement.fileSystemAccess]
  ) {
    return false;
  }
  if (
    requirement.pipelines !== undefined &&
    PIPELINE_CAPABILITY_RANK[capabilities.pipelines] <
      PIPELINE_CAPABILITY_RANK[requirement.pipelines]
  ) {
    return false;
  }
  if (
    requirement.settingsScope === 'full' &&
    capabilities.settingsScope !== 'full'
  ) {
    return false;
  }
  // Optional, default-deny boolean axes: an unset (or `false`) capability field
  // fails the requirement via the `=== true` comparison, so a host that never
  // opts in stays hidden. This is an in-process default, not wire negotiation.
  if (
    requirement.panelLayoutControls === true &&
    capabilities.panelLayoutControls !== true
  ) {
    return false;
  }
  if (
    requirement.nativeWorktreeOpen === true &&
    capabilities.nativeWorktreeOpen !== true
  ) {
    return false;
  }
  if (
    requirement.marketplaceOwnedAutomationShares === true &&
    capabilities.marketplaceOwnedAutomationShares !== true
  ) {
    return false;
  }
  if (
    requirement.marketplaceOwnedShares === true &&
    capabilities.marketplaceOwnedShares !== true
  ) {
    return false;
  }
  if (
    requirement.marketplaceSharedCollectionEdit === true &&
    capabilities.marketplaceSharedCollectionEdit !== true
  ) {
    return false;
  }
  if (requirement.automations === true && capabilities.automations !== true) {
    return false;
  }
  if (requirement.watchers === true && capabilities.watchers !== true) {
    return false;
  }
  if (requirement.orgProjects === true && capabilities.orgProjects !== true) {
    return false;
  }
  if (requirement.ledger === true && capabilities.ledger !== true) {
    return false;
  }
  if (requirement.itemGrouping === true && capabilities.itemGrouping !== true) {
    return false;
  }
  if (requirement.costInsights === true && capabilities.costInsights !== true) {
    return false;
  }
  return true;
}

/**
 * The rulebook: capability requirements for every panel kind in
 * `@canopy/protocol`'s closed {@link PanelKind} union.
 *
 * Rationale per kind:
 * - `chat` — universal. Chat is fully relayed over the `CanopyClient`
 *   transport (desktop IPC / web portal); no local power needed.
 * - `file-diff` — needs at least `'read'` file-system reach: it renders file
 *   contents and diffs served through the client.
 * - `terminal` — needs a live interactive PTY; desktop and cloud support it.
 *   Remote Control only relays output.
 * - `activity-section` / `activity-card` — universal. Activity views are
 *   data projections relayed over the client.
 * - `browser` — needs `localExecution`: the in-app browser is a host-native
 *   view whose primary job is previewing locally running dev servers. A host
 *   that cannot execute work locally has nothing local to preview. (If a
 *   future host ever has local execution without an embeddable browser
 *   view, add an optional dedicated capability rather than overloading this
 *   one.)
 * - `file-explorer` — needs at least `'read'` file-system reach to browse
 *   the worktree tree.
 * - `usage` — universal. The usage/rate-limit view is a data projection of
 *   provider account state relayed over the client; no local power needed.
 * - `automations` — universal. The automations view is a data projection of
 *   automation/watcher state relayed over the client; no local power needed.
 *   (The web portal currently excludes it from its add menu regardless.)
 * - `pipeline-execution` — needs `localExecution`: a run's detail view reads
 *   step logs and reports that only exist on the host that executed it, so a
 *   relay-only host has nothing to render. Web, Portal, and shared containers
 *   also exclude it explicitly.
 * - `plan` / `plan-diagram` — need `localExecution`: a tracked plan is
 *   worktree-local state read and annotated on the host, and its follow-up
 *   actions run agents there. Hosts without local execution keep today's
 *   read-only plan views outside the panel grid.
 * - `chat-visuals` — universal. It lists visuals a chat on the same host has
 *   already read through the client, and shows none where the host does not
 *   report `chatVisuals`.
 * - `subagents` / `subagent-chat` — universal. The subagent tree and a
 *   subagent's transcript are projections of the root chat's transcript,
 *   relayed over the client like chat itself. Actions inside them (stop,
 *   message, worktree details, native interrupt) gate on their own
 *   capability fields, not on the panel kind.
 * - `ledger` — needs the `ledger` capability: only a host that reads the
 *   scope's Agent Ledger can render it.
 * - `cost` / `session-breakdown` — need the `costInsights` capability: only a
 *   host that reads the scope's observed cost can render them.
 *
 * Keyed by the closed union so adding a kind to `PANEL_KINDS` without
 * deciding its gating is a compile error.
 */
export const PANEL_CAPABILITY_REQUIREMENTS: Readonly<
  Record<PanelKind, CapabilityRequirement>
> = {
  chat: {},
  'file-diff': { fileSystemAccess: 'read' },
  terminal: { terminalPty: true },
  'activity-section': {},
  'activity-card': {},
  browser: { localExecution: true },
  'change-diagram': { localExecution: true },
  'file-explorer': { fileSystemAccess: 'read' },
  usage: {},
  automations: {},
  'pipeline-execution': { localExecution: true },
  plan: { localExecution: true },
  'plan-diagram': { localExecution: true },
  'chat-visuals': {},
  subagents: {},
  'subagent-chat': {},
  ledger: { ledger: true },
  cost: { costInsights: true },
  'session-breakdown': { costInsights: true },
  // Desktop-only for now: the web panel grid has no new-tab picker yet.
  'new-tab': { localExecution: true },
};

/**
 * Whether a host with `capabilities` may render panels of `panelKind`.
 *
 * Accepts an open `string` (matching the panels engine's open-`kind`
 * posture) so callers holding registry/persisted data need no narrowing
 * first. Unknown kinds return `false` — see the module doc for why the
 * default is deliberately hidden.
 */
export function isPanelAvailable(
  capabilities: CanopyCapabilities,
  panelKind: string,
): boolean {
  if (!isPanelKind(panelKind)) {
    return false;
  }
  return meetsCapabilityRequirement(
    capabilities,
    PANEL_CAPABILITY_REQUIREMENTS[panelKind],
  );
}

/**
 * All panel kinds a host with `capabilities` may render, in canonical
 * `PANEL_KINDS` order. The future shared panel host derives its effective
 * registry (and its "new panel" affordances) from this list.
 */
export function getAvailablePanelKinds(
  capabilities: CanopyCapabilities,
): readonly PanelKind[] {
  return PANEL_KINDS.filter((kind): boolean =>
    meetsCapabilityRequirement(
      capabilities,
      PANEL_CAPABILITY_REQUIREMENTS[kind],
    ),
  );
}

/**
 * Non-panel feature surfaces of the shared Code-workspace UI that are
 * capability-gated. These name affordances *within* universal surfaces
 * (e.g. the mic button inside chat), not panels.
 *
 * Growth pattern (matches `PANEL_KINDS`): add the identifier here first,
 * then map it in {@link FEATURE_CAPABILITY_REQUIREMENTS} (compile error
 * until you do), then consume it from the shared components.
 */
export const FEATURE_SURFACES = [
  /** Mic/dictation affordances in chat input (macOS desktop only). */
  'voice-dictation',
  /** Editing/saving files (beyond read-only viewing) in file surfaces. */
  'file-editing',
  /** Running pipelines from the UI (vs merely viewing/editing them). */
  'pipeline-execution',
  /** Creating/editing pipelines (vs read-only listing). */
  'pipeline-editing',
  /** The full settings surface (web renders API keys only). */
  'full-settings',
  /**
   * Panel-layout controls in the worktree top bar (e.g. a layout toggle).
   * Gated on the optional `panelLayoutControls` capability; no shipped host
   * enables it yet (dormant scaffolding until a real desktop toggle lands).
   */
  'panel-layout-controls',
  /** Native worktree Open (IDE/Finder) trigger in the worktree top bar. */
  'native-worktree-open',
  /** Marketplace → Automations "Shared by me" filter and owner actions. */
  'marketplace-owned-automation-shares',
  /** Marketplace "Shared by me" filter on every type tab (CAN-4263). */
  'marketplace-owned-shares',
  /** Marketplace shared collection detail → Edit (CAN-4263, desktop-only). */
  'marketplace-shared-collection-edit',
  /** Workflows → Schedule, the calendar of scheduled automations. */
  'workflow-schedule',
  /** Automation rows, runs and editing in Workflows. */
  'workflow-automations',
  /** Watcher rows and the Watcher kind filter in Workflows → Runs. */
  'workflow-watchers',
] as const;

/** Identifies one capability-gated non-panel feature surface. */
export type FeatureSurface = (typeof FEATURE_SURFACES)[number];

/** Type guard for {@link FeatureSurface}. */
export function isFeatureSurface(value: unknown): value is FeatureSurface {
  return (
    typeof value === 'string' &&
    FEATURE_SURFACES.some((surface) => surface === value)
  );
}

/**
 * Capability requirements for every {@link FeatureSurface}, keyed by the
 * closed union so new surfaces cannot ship ungated.
 */
export const FEATURE_CAPABILITY_REQUIREMENTS: Readonly<
  Record<FeatureSurface, CapabilityRequirement>
> = {
  'voice-dictation': { voice: true },
  'file-editing': { fileSystemAccess: 'read-write' },
  'pipeline-execution': { pipelines: 'execute' },
  'pipeline-editing': { pipelines: 'crud-only' },
  'full-settings': { settingsScope: 'full' },
  'panel-layout-controls': { panelLayoutControls: true },
  'native-worktree-open': { nativeWorktreeOpen: true },
  'marketplace-owned-automation-shares': {
    marketplaceOwnedAutomationShares: true,
  },
  'marketplace-owned-shares': { marketplaceOwnedShares: true },
  'marketplace-shared-collection-edit': {
    marketplaceSharedCollectionEdit: true,
  },
  'workflow-schedule': { automations: true },
  'workflow-automations': { automations: true },
  'workflow-watchers': { watchers: true },
};

/**
 * Whether a host with `capabilities` may render the feature surface named
 * `surface`. Accepts an open `string`; unknown surfaces return `false`
 * (same deliberate default-hidden posture as {@link isPanelAvailable}).
 */
export function isFeatureSurfaceAvailable(
  capabilities: CanopyCapabilities,
  surface: string,
): boolean {
  if (!isFeatureSurface(surface)) {
    return false;
  }
  return meetsCapabilityRequirement(
    capabilities,
    FEATURE_CAPABILITY_REQUIREMENTS[surface],
  );
}

/**
 * All feature surfaces a host with `capabilities` may render, in canonical
 * {@link FEATURE_SURFACES} order.
 */
export function getAvailableFeatureSurfaces(
  capabilities: CanopyCapabilities,
): readonly FeatureSurface[] {
  return FEATURE_SURFACES.filter((surface): boolean =>
    meetsCapabilityRequirement(
      capabilities,
      FEATURE_CAPABILITY_REQUIREMENTS[surface],
    ),
  );
}
