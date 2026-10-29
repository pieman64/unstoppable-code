import { AccountMcpConnectionError } from '@canopy/desktop-shared/types/mcp-servers';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  AccountMcpConnection,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import {
  hasLegacyAccountMcpRefs,
  normalizeAccountMcpSelectionRefs,
  normalizeAccountMcpTombstoneRefs,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { mergeAccountMcpInventory } from '@canopy/ui-app/capability/accountMcpRows';
import { getFeatureFlagService } from '../feature-flags/service';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { listAccountMcpConnections } from '../canopy-cloud/mcp-connections';

export {
  accountMcpIndexEntry,
  mergeAccountMcpInventory,
} from '@canopy/ui-app/capability/accountMcpRows';

export function accountMcpConnectionsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key,
  );
}

interface AccountMcpRefLoadOptions {
  /** Loaders on hydration paths give up after this long and keep the refs. */
  waitMs?: number;
}

/** Null when account connections are off or the list cannot be read. */
export async function loadAccountMcpRefConnections(
  options: AccountMcpRefLoadOptions = {},
): Promise<AccountMcpConnection[] | null> {
  if (!accountMcpConnectionsEnabled()) return null;
  const request = listAccountMcpConnections().catch(
    (): AccountMcpConnection[] | null => null,
  );
  if (options.waitMs === undefined) return request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve): void => {
    timer = setTimeout((): void => resolve(null), options.waitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Selection loaders feeding pickers wait briefly, never for a slow cloud. */
export const ACCOUNT_MCP_REF_LOADER_WAIT: AccountMcpRefLoadOptions = {
  waitMs: 1_000,
};

/**
 * Read-time mapping of legacy `account:<connectionId>` refs to the shared
 * `{ serverId: serverKey, configId }` shape. Only selections that still carry
 * a legacy ref read the (cached) connection list. When it cannot be read the
 * refs are kept so resolution can warn; refs to deleted connections are
 * dropped and reported through `warnings`.
 */
export async function normalizeAccountMcpSelections<
  T extends ChatTabPluginSelections | undefined,
>(
  selections: T,
  warnings?: string[],
  options?: AccountMcpRefLoadOptions,
): Promise<T> {
  if (!selections || !hasLegacyAccountMcpRefs(selections)) return selections;
  const connections = await loadAccountMcpRefConnections(options);
  if (!connections) return selections;
  const normalized = normalizeAccountMcpSelectionRefs(selections, connections);
  if (normalized.dropped.length > 0)
    warnings?.push('Account MCP connection is unavailable. Connect again.');
  return normalized.selections;
}

export async function normalizeAccountMcpTombstones(
  tombstones: PluginSelectionTombstones | undefined,
  options?: AccountMcpRefLoadOptions,
): Promise<PluginSelectionTombstones | undefined> {
  if (!hasLegacyAccountMcpRefs(tombstones)) return tombstones;
  const connections = await loadAccountMcpRefConnections(options);
  return connections
    ? normalizeAccountMcpTombstoneRefs(tombstones, connections)
    : tombstones;
}

export async function withAccountMcpInventory(
  index: McpServersIndexFile,
): Promise<McpServersIndexFile> {
  if (!accountMcpConnectionsEnabled()) return index;
  try {
    const connections = await listAccountMcpConnections();
    if (!accountMcpConnectionsEnabled()) return index;
    return {
      ...index,
      servers: mergeAccountMcpInventory(index.servers, connections),
      accountConnectionsAvailable: true,
    };
  } catch (error) {
    if (
      error instanceof CanopyCloudClientError ||
      error instanceof AccountMcpConnectionError ||
      (typeof error === 'object' &&
        error !== null &&
        (('status' in error &&
          typeof error.status === 'number' &&
          error.status >= 400 &&
          error.status <= 599) ||
          ('code' in error &&
            typeof error.code === 'string' &&
            [
              'ECONNREFUSED',
              'ECONNRESET',
              'ENOTFOUND',
              'EAI_AGAIN',
              'ETIMEDOUT',
              'ENETUNREACH',
              'EHOSTUNREACH',
            ].includes(error.code))))
    )
      return {
        ...index,
        accountConnectionsAvailable: false,
        accountConnectionsUnavailableReason:
          error instanceof CanopyCloudClientError &&
          [
            'missing-api-key',
            'cloud-not-configured',
            'unsupported-capability',
          ].includes(error.code)
            ? 'sign-in-required'
            : 'unavailable',
      };
    throw error;
  }
}
