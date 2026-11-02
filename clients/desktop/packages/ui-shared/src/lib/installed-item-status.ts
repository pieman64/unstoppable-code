import {
  installedItemKey,
  installedItemTargetForEntry,
  type InstalledItemMutationResult,
  type InstalledItemRef,
  type InstalledItemNotice,
  type InstalledItemSnapshot,
  type InstalledItemSnapshotEntry,
  type InstalledItemStatus,
  type InstalledItemTarget,
  type InstalledItemUninstallTarget,
  type SetInstalledItemStatusRequest,
  type UninstallInstalledItemRequest,
} from '@canopy/protocol/installed-items';
import type { UnifiedEntryRef } from '@canopy/protocol/unified-entry';
import type {
  UnifiedPluginEntry,
  UnifiedEntryConnection,
} from './unified-plugin-entry';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins';

/**
 * Installed-item status (CAN-4255): the shared copy, the snapshot-to-entry
 * projection and the source contract behind the status picker, the detail
 * Status row and the Settings Active summary. The snapshot hook lives in
 * `useInstalledItemStatuses.ts`, a client module, so these helpers stay
 * importable from server code.
 *
 * The desktop renderer and the paired-desktop Portal supply the transport as
 * an `InstalledItemStatusSource`; nothing here knows which host it runs in.
 */

export const INSTALLED_ITEM_STATUS_ORDER: readonly InstalledItemStatus[] = [
  'active',
  'available',
  'disabled',
];

export const INSTALLED_ITEM_STATUS_COPY: Record<
  InstalledItemStatus,
  { readonly label: string; readonly description: string }
> = {
  active: { label: 'Active', description: 'Added to every new chat' },
  available: {
    label: 'Available',
    description: 'Type / and the plugin name to use its skills',
  },
  disabled: { label: 'Disabled', description: 'Installed, but turned off' },
};

/**
 * Status description for a known item kind (CAN-5271). Available says how
 * that kind is reached: a standalone skill by its own name, collections and
 * MCP servers on demand. Other statuses, and an unknown kind, keep the
 * shared copy.
 */
export function installedItemStatusDescription(
  status: InstalledItemStatus,
  targetKind?: InstalledItemTarget['kind'],
): string {
  if (status === 'available' && targetKind !== undefined) {
    if (targetKind === 'skill') return 'Type / and the skill name to use it';
    if (targetKind !== 'plugin') return 'Loads when you or an agent need it';
  }
  return INSTALLED_ITEM_STATUS_COPY[status].description;
}

/**
 * Customize status filter copy (CAN-4838). The dropdown's status rows reuse
 * the picker descriptions above unchanged; these add the Any status option,
 * the Installed description line and the filtered-empty sentence.
 */
export const INSTALLED_STATUS_FILTER_ANY_LABEL = 'Any status';

export const INSTALLED_ITEM_STATUS_DESCRIPTION_LINE =
  'Active items are added to every new chat. Available ones load when you or an agent need them. Disabled ones stay installed but are hidden.';

export function installedStatusFilterEmptyText(
  status: InstalledItemStatus,
): string {
  return `Nothing is ${INSTALLED_ITEM_STATUS_COPY[status].label.toLowerCase()}.`;
}

export function installedStatusFilterLabel(
  status: InstalledItemStatus | null,
): string {
  return status === null
    ? INSTALLED_STATUS_FILTER_ANY_LABEL
    : INSTALLED_ITEM_STATUS_COPY[status].label;
}

/** Stable key for any status target, including server-wide MCP rows. */
export function installedItemTargetKey(target: InstalledItemTarget): string {
  return target.kind === 'mcp-server'
    ? JSON.stringify(['v1', target.kind, target.serverId])
    : installedItemKey(target);
}

export function findInstalledItem(
  snapshot: InstalledItemSnapshot,
  target: InstalledItemTarget,
): InstalledItemSnapshotEntry | undefined {
  const key = installedItemTargetKey(target);
  return snapshot.items.find(
    (item) => installedItemTargetKey(item.target) === key,
  );
}

/** Account MCP selection identities differ from connection mutation identities. */
export function installedSelectionIsDisabled(
  snapshot: InstalledItemSnapshot,
  ref: InstalledItemRef,
): boolean {
  if (ref.kind === 'mcp-config') {
    const account = snapshot.items.find(
      (item) =>
        item.target.kind === 'account-mcp' &&
        (item.selectionRef?.serverId === ref.serverId ||
          `account:${item.target.connectionId}` === ref.serverId) &&
        item.selectionRef?.configId === ref.configId,
    );
    if (account) return account.status === 'disabled';
  }
  return findInstalledItem(snapshot, ref)?.status === 'disabled';
}

/** What the host knows about installed-item status right now. */
export type InstalledItemSnapshotState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'ready'; readonly snapshot: InstalledItemSnapshot };

/** One catalog row's status, as the status picker and Status row render it. */
export type InstalledEntryStatusState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read-only'; readonly reason: string }
  /** A status the catalog row proves on its own and nothing here changes. */
  | {
      readonly kind: 'fixed';
      readonly status: InstalledItemStatus;
      readonly reason: string;
    }
  | {
      readonly kind: 'ready';
      readonly item: InstalledItemSnapshotEntry;
      /** Per-configuration rows of a device MCP server, in snapshot order. */
      readonly configurations: readonly InstalledItemSnapshotEntry[];
    };

export type InstalledEntryStatusStates = Readonly<
  Record<string, InstalledEntryStatusState>
>;

/** Catalog refs that name an installable item kind with a status. */
const STATUS_REF_TYPES: ReadonlySet<UnifiedEntryRef['type']> = new Set([
  'marketplace-plugin',
  'skill',
  'local-collection',
  'local-mcp',
  'mcp-server',
  'curated-plugin',
  'curated-mcp',
]);

export const BUILT_IN_WORKFLOW_STATUS_REASON =
  "Built-in workflows are always available and can't be turned off.";

/**
 * Why an installed row with no status of its own is always Available, or
 * undefined when the row has no fixed status. Only built-in workflows do.
 */
export function alwaysAvailableReason(
  entry: Pick<UnifiedPluginEntry, 'ref'>,
): string | undefined {
  return entry.ref.type === 'pipeline' && entry.ref.source === 'bundled'
    ? BUILT_IN_WORKFLOW_STATUS_REASON
    : undefined;
}

export const PROVIDER_CONNECTED_STATUS_REASON =
  'Active in chats through your connected provider account.';

/**
 * Whether every connection of a curated MCP card is an established provider
 * account link (CAN-5272). Such a card is active in that provider's chats
 * whatever the device snapshot says; a mix with device or account rows keeps
 * the snapshot's status.
 */
function providerConnected(
  ref: UnifiedEntryRef,
  connections: readonly UnifiedEntryConnection[] | undefined,
): boolean {
  return (
    ref.type === 'curated-mcp' &&
    connections !== undefined &&
    connections.length > 0 &&
    connections.every(
      (connection) =>
        connection.binding === 'provider' && connection.state === 'installed',
    )
  );
}

/** Whether a catalog row names an installed item that carries a status. */
export function entryHasInstalledStatus(
  entry: Pick<UnifiedPluginEntry, 'state' | 'ref' | 'integration'>,
  state?: InstalledItemSnapshotState,
): boolean {
  if (!STATUS_REF_TYPES.has(entry.ref.type)) return false;
  if (entry.state !== 'available') return true;
  if (state?.kind !== 'ready') return false;
  const resolved = installedEntryStatusState(
    entry.ref,
    state,
    entry.integration?.connections,
  );
  return (
    resolved.kind === 'ready' &&
    resolved.item.notices.some((notice) => notice.code === 'partial_removal')
  );
}

/**
 * Projects a snapshot onto catalog rows. Browse-only rows get no status; a
 * failed or unsupported read is a read-only reason, never a silent Available.
 */
export function installedEntryStatusStates(
  entries: readonly UnifiedPluginEntry[],
  state: InstalledItemSnapshotState,
): InstalledEntryStatusStates {
  const result: Record<string, InstalledEntryStatusState> = {};
  for (const entry of entries) {
    if (!entryHasInstalledStatus(entry, state)) continue;
    result[entry.id] = installedEntryStatusState(
      entry.ref,
      state,
      entry.integration?.connections,
    );
  }
  // Catalog aliases follow the exact installed identity resolved by the shared
  // projection, including author-side shares whose names differ from the copy.
  for (const entry of entries) {
    const installed = entry.installedEntryId && result[entry.installedEntryId];
    if (installed) result[entry.id] = installed;
  }
  return result;
}

export function installedEntryStatusState(
  ref: UnifiedEntryRef,
  state: InstalledItemSnapshotState,
  connections?: readonly UnifiedEntryConnection[],
): InstalledEntryStatusState {
  if (providerConnected(ref, connections))
    return {
      kind: 'fixed',
      status: 'active',
      reason: PROVIDER_CONNECTED_STATUS_REASON,
    };
  if (state.kind === 'loading') return { kind: 'loading' };
  if (state.kind === 'error')
    return { kind: 'read-only', reason: state.message };
  if (state.kind === 'unsupported')
    return { kind: 'read-only', reason: state.reason };
  let targetRef = ref;
  const bindings: Array<{
    entry: UnifiedEntryRef;
    target: InstalledItemTarget;
  }> = [];
  if (ref.type === 'curated-plugin')
    targetRef = {
      type: 'marketplace-plugin',
      marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
      pluginName: ref.key,
    };
  if (ref.type === 'curated-mcp' && connections) {
    const targets = new Map<string, InstalledItemTarget>();
    for (const connection of connections) {
      const target: InstalledItemTarget = connection.accountConnectionId
        ? { kind: 'account-mcp', connectionId: connection.accountConnectionId }
        : { kind: 'mcp-server', serverId: connection.serverId };
      if (findInstalledItem(state.snapshot, target))
        targets.set(installedItemTargetKey(target), target);
    }
    if (targets.size === 1)
      bindings.push({ entry: ref, target: Array.from(targets.values())[0] });
  }
  const resolved = installedItemTargetForEntry(
    targetRef,
    state.snapshot,
    bindings,
  );
  if (!('target' in resolved))
    return { kind: 'read-only', reason: resolved.reason };
  const item = findInstalledItem(state.snapshot, resolved.target);
  if (!item)
    return {
      kind: 'read-only',
      reason: 'This item is not in the installed list.',
    };
  const configurations =
    item.target.kind === 'mcp-server'
      ? (item.configurations ?? []).flatMap((configuration) => {
          const found = findInstalledItem(state.snapshot, configuration);
          return found ? [found] : [];
        })
      : [];
  return { kind: 'ready', item, configurations };
}

export interface ActiveInstalledItemCounts {
  readonly plugins: number;
  readonly skills: number;
  readonly collections: number;
  readonly mcpServers: number;
}

/** Host transport for status reads and mutations. */
export interface InstalledItemStatusSource {
  listStatus(): Promise<InstalledItemSnapshot>;
  setStatus(
    request: SetInstalledItemStatusRequest,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    request: UninstallInstalledItemRequest,
  ): Promise<InstalledItemMutationResult>;
  /** Fires when the host learns state changed elsewhere; returns cleanup. */
  subscribe?(onChange: () => void): () => void;
}

/** A mutation's outcome, reconciled to the effective state the host returned. */
export interface InstalledItemMutationOutcome {
  readonly ok: boolean;
  /** Failure copy for an inline error; absent on success. */
  readonly message?: string;
  readonly notices: readonly InstalledItemNotice[];
}

export interface InstalledItemStatusController {
  readonly state: InstalledItemSnapshotState;
  /** Target keys with a mutation in flight. */
  readonly pendingKeys: ReadonlySet<string>;
  readonly refresh: () => void;
  readonly setStatus: (
    target: InstalledItemTarget,
    status: InstalledItemStatus,
  ) => Promise<InstalledItemMutationOutcome>;
  readonly uninstall: (
    target: InstalledItemUninstallTarget,
  ) => Promise<InstalledItemMutationOutcome>;
}
