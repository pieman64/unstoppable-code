import {
  curatedMcpDesktopOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import type { NavigationPage } from '@canopy/desktop-shared/types';
import {
  customAccountMcpPromotable,
  type UnifiedPluginEntry,
} from '@canopy/ui-app/capability';
import { mcpHasMultipleTargets } from '@canopy/ui-shared/lib/mcp-row-health';
import type { AccountMcpActionEventDetail } from '@/lib/accountMcpEvents';
import { CLOUD_SINGLE_CONFIG_REQUIRED } from './mcpManagementOperations';

/** Who an accepted Connect signs in: a listed row, or a catalog server alone. */
export type AccountMcpConnectTarget =
  | {
      readonly row: McpServerIndexEntry;
      readonly entry?: CuratedMcpServerEntry;
    }
  | { readonly row?: undefined; readonly entry: CuratedMcpServerEntry };

/** What one Orchestrator account action asks of the visible surface. */
export type AccountMcpActionResolution =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'edit'; readonly row: McpServerIndexEntry }
  | {
      readonly kind: 'disconnect';
      readonly connectionId: string;
      readonly serverKey: string;
    }
  | { readonly kind: 'promote'; readonly row: McpServerIndexEntry }
  | { readonly kind: 'connect'; readonly target: AccountMcpConnectTarget };

const IGNORE: AccountMcpActionResolution = { kind: 'ignore' };

/**
 * The decision table behind the five account actions. An ignored request stays
 * unacknowledged, so the dispatcher answers with its destination guidance. The
 * action named promote and custom promotion differ: a curated device row
 * promotes by connecting, and only a custom row moves itself to the cloud.
 */
export function resolveAccountMcpAction(input: {
  readonly operation: AccountMcpActionEventDetail['operation'];
  readonly serverId: string;
  readonly servers: readonly McpServerIndexEntry[];
  readonly curatedEntries: readonly CuratedMcpServerEntry[];
  readonly providerHandled: (serverId: string) => boolean;
}): AccountMcpActionResolution {
  const { operation, serverId, servers, curatedEntries } = input;
  // Account rows share the catalog id; the connection id selects one exact
  // configuration. Keep device/catalog ids as the existing compatibility path.
  const row =
    servers.find(
      (server): boolean => server.accountConnection?.id === serverId,
    ) ?? servers.find((server): boolean => server.id === serverId);
  const entry = curatedEntries.find(
    (catalog): boolean =>
      catalog.key ===
      (row?.curatedKey ?? row?.accountConnection?.serverKey ?? serverId),
  );
  // Desktop only blocks every cloud connect, never revoking a connection made
  // before the server was marked (REG-3035).
  if (entry && curatedMcpDesktopOnly(entry) && operation !== 'disconnect')
    return IGNORE;
  const customPromotable =
    row !== undefined &&
    customAccountMcpPromotable(row) &&
    !input.providerHandled(row.id);
  if (
    !row?.accountConnection &&
    !row?.curatedKey &&
    !entry &&
    !customPromotable
  )
    return IGNORE;
  const connection = row?.accountConnection;
  if (operation === 'edit')
    return row && connection?.kind === 'CUSTOM'
      ? { kind: 'edit', row }
      : IGNORE;
  if (operation === 'disconnect')
    return connection && connection.status !== 'DISCONNECTED'
      ? {
          kind: 'disconnect',
          connectionId: connection.id,
          serverKey: connection.serverKey,
        }
      : IGNORE;
  if (
    operation === 'promote' &&
    (!row || connection || (!row.curatedKey && !customPromotable))
  )
    return IGNORE;
  if (operation === 'reconnect' && connection?.status !== 'REAUTH_REQUIRED')
    return IGNORE;
  if (connection?.status === 'CONNECTED' || connection?.status === 'PENDING')
    return IGNORE;
  if (customPromotable) {
    return row.configs.length > 1
      ? { kind: 'refuse', message: CLOUD_SINGLE_CONFIG_REQUIRED }
      : { kind: 'promote', row };
  }
  if (row)
    return { kind: 'connect', target: { row, ...(entry ? { entry } : {}) } };
  return operation === 'connect' && entry
    ? { kind: 'connect', target: { entry } }
    : IGNORE;
}

/** The copy of a custom cloud row this device can edit, when it holds one. */
export function accountMcpEditableCopy(
  row: McpServerIndexEntry,
): McpServerIndexEntry | undefined {
  return row.deviceCopies?.find(
    (copy): boolean =>
      copy.accountConnectionId !== undefined &&
      copy.accountConnectionId === row.accountConnection?.id,
  );
}

/**
 * The account row behind a Customize entry: its explicit connection, otherwise
 * the local reference's server and configuration. An entry with several
 * connections names none of them, so a stale or ambiguous match finds nothing.
 */
export function accountRowOf(
  entry: UnifiedPluginEntry,
  servers: readonly McpServerIndexEntry[],
): McpServerIndexEntry | undefined {
  if (mcpHasMultipleTargets(entry)) return undefined;
  const connectionId = entry.integration?.connections[0]?.accountConnectionId;
  if (connectionId !== undefined)
    return servers.find(
      (server): boolean => server.accountConnection?.id === connectionId,
    );
  if (entry.ref.type !== 'local-mcp') return undefined;
  const { serverId, configId } = entry.ref;
  return servers.find(
    (server): boolean =>
      server.id === serverId &&
      server.accountConnection !== undefined &&
      server.accountConnection.configId === configId,
  );
}

/** The page-level half of what makes Customize's MCP surface visible. */
export function customizeInForeground(navigation: {
  readonly activePage: NavigationPage;
  readonly settingsOpen: boolean;
  readonly coversMainShell: boolean;
}): boolean {
  return (
    navigation.activePage === 'plugins' &&
    !navigation.settingsOpen &&
    !navigation.coversMainShell
  );
}

/**
 * The foreground surface decides, not the tab behind it: an open detail must be
 * an MCP detail, and only without one does the active tab count. A selected
 * entry that has not resolved yet is not an MCP surface.
 */
export function customizeMcpSurfaceInForeground(surface: {
  readonly activeTab: string | null;
  readonly selectedEntryId: string | null;
  readonly selectedEntryType: UnifiedPluginEntry['ref']['type'] | undefined;
}): boolean {
  if (surface.selectedEntryId !== null)
    return (
      surface.selectedEntryType === 'local-mcp' ||
      surface.selectedEntryType === 'curated-mcp'
    );
  return surface.activeTab === 'app';
}
