/**
 * Access-derived panel filter for the shared-container recipient view.
 *
 * The recipient view mounts the standard desktop panel host and registry for
 * the read-only scope `(shared-container-viewer, containerId)`. Read-only is a
 * property of that scope, so this module no longer supplies renderers. It
 * decides which standard panel kinds the host may MOUNT and which it may ADD,
 * and it still fails closed: an unknown string, or a kind added to
 * {@link PanelKind} later, is refused until it is listed here.
 * Subagents and subagent chats are intentionally excluded: a recipient has
 * no access to the publisher's subagent tree or transcript bindings.
 *
 * The file explorer and browser only read the sealed replica, so they are
 * always available with no consent step. A recipient's Plan panel is the
 * read-only plan document (Q1); its `plan-diagram` split stays excluded, so a
 * persisted diagram tab is refused on render and closed by layout repair. Run consent (CAN-2831) gates only
 * what executes code: the terminal. Main re-checks consent on every spawn, so
 * this list is what makes a granted capability reachable, not the boundary.
 */
import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import type { CanopyCapabilities } from '@canopy/app-core';
import { isPanelAvailable } from '@canopy/app-core/gating';
import { isPanelKind, PANEL_KINDS, type PanelKind } from '@canopy/protocol';
import type { WorkspaceAccess } from '@/lib/workspace-access';

/** Kinds the recipient view always mounts, rendered by the standard registry. */
export const SHARED_CONTAINER_PANEL_KINDS: readonly PanelKind[] = Object.freeze<
  PanelKind[]
>([
  'chat',
  'file-diff',
  'activity-section',
  'activity-card',
  'file-explorer',
  'browser',
  'plan',
]);

/** Kinds unlocked by run consent (CAN-2831): only what executes code. */
export const SHARED_CONTAINER_RUN_PANEL_KINDS: readonly PanelKind[] =
  Object.freeze<PanelKind[]>(['terminal']);

/** Canonical app-core capability projection for the recipient workspace. */
export function sharedContainerCapabilities(
  runEnabled: boolean,
): CanopyCapabilities {
  return {
    localExecution: true,
    terminalPty: runEnabled,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'in-memory',
    overviewNotifications: false,
    panelLayoutControls: true,
    nativeWorktreeOpen: false,
    marketplaceOwnedAutomationShares: false,
    marketplaceOwnedShares: false,
    marketplaceSharedCollectionEdit: false,
    customSkillEdit: false,
    workspaceCreation: false,
    workspaceReordering: false,
    worktreeReordering: false,
    worktreePinning: false,
    workspaceSettings: false,
    workspaceRemoval: false,
    worktreeRemoval: false,
  };
}

/**
 * Kinds that can be mounted but never created from `+`. A chat view is a
 * projection of a published chat, so a recipient cannot start one; file diffs
 * open from the Changes section and chat file links, not from the menu.
 */
const NOT_CREATABLE_PANEL_KINDS: readonly PanelKind[] = Object.freeze<
  PanelKind[]
>(['chat', 'file-diff']);

/**
 * The kinds mountable for a given run-consent state.
 *
 * `runEnabled` has no default anywhere in this module. A default would let a
 * caller that has not yet resolved consent collapse to the permissive branch,
 * which is exactly the failure mode a fail-closed allowlist exists to prevent.
 */
export function sharedContainerPanelKinds(
  runEnabled: boolean,
): readonly PanelKind[] {
  const capabilities = sharedContainerCapabilities(runEnabled);
  const allowlisted = runEnabled
    ? [...SHARED_CONTAINER_PANEL_KINDS, ...SHARED_CONTAINER_RUN_PANEL_KINDS]
    : SHARED_CONTAINER_PANEL_KINDS;
  return allowlisted.filter((kind) => isPanelAvailable(capabilities, kind));
}

/**
 * Kinds hidden from the add-panel menu: every kind that is not mountable, plus
 * the mountable kinds a recipient cannot create. Derived from
 * {@link PANEL_KINDS} so a newly added kind is hidden by default.
 */
export function sharedContainerExcludedPanelKinds(
  runEnabled: boolean,
): readonly PanelKind[] {
  const allowed = sharedContainerPanelKinds(runEnabled);
  return PANEL_KINDS.filter(
    (kind) =>
      !allowed.includes(kind) || NOT_CREATABLE_PANEL_KINDS.includes(kind),
  );
}

/**
 * Whether the recipient view may mount `kind` under the given run consent.
 * A run-gated kind answers `false` whenever `runEnabled` is `false`, which is
 * what closes a persisted terminal tab after consent is revoked.
 */
export function isSharedContainerPanelKind(
  kind: string,
  runEnabled: boolean,
): kind is PanelKind {
  return (
    isPanelKind(kind) && sharedContainerPanelKinds(runEnabled).includes(kind)
  );
}

/**
 * Activity sections the recipient sees: the publisher's sections for that
 * workspace type, minus the ones that only exist to write, run agents, or read
 * live local state the replica does not carry. Scripts need run consent.
 */
export function sharedContainerActivitySectionIds(
  containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY',
  runEnabled: boolean,
): readonly ActivitySectionId[] {
  if (containerType === 'COWORK_WORK_ENTRY') {
    return ['notes', 'prompts', 'attachments'];
  }
  return [
    'changed-files',
    ...(runEnabled ? (['scripts'] as const) : []),
    'plans',
    'notes',
    'prompts',
    'attachments',
  ];
}

/** Whether a listed recipient entry grants access to its read-only surface. */
export function sharedContainerCanView(
  capabilities: readonly string[] | null | undefined,
): boolean {
  return capabilities?.includes('VIEW') === true;
}

/**
 * Whether an activity section may render under the given workspace access.
 * Read-write scopes allow every section their surface already offers; the
 * read-only recipient scope allows only {@link sharedContainerActivitySectionIds}.
 */
export function isActivitySectionAllowedForAccess(
  sectionId: string,
  access: WorkspaceAccess,
): boolean {
  if (access.mode === 'read-write') return true;
  return sharedContainerActivitySectionIds(
    access.containerType,
    access.runAllowed,
  ).some((allowed) => allowed === sectionId);
}
