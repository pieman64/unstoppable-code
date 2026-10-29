/**
 * Whether a chat on the current surface can take a capability catalog row.
 * Pure and browser-safe, so the cloud Plugins picker and Getting started's
 * Connect your tools chips offer the same rows. Only the cloud catalog sets
 * these signals; a desktop-relayed catalog has no unified entries and no
 * account `connectionState`, and its desktop connects every row itself.
 * Provider support is a separate, per-chat question.
 */
import type {
  PortalMcpConnectionMetadata,
  PortalPluginCatalogUnifiedEntry,
} from './index';

/**
 * Why a chat here cannot take a catalog entry, most specific first:
 * - `desktop_only`: an account server only a desktop agent provider can sign
 *   in to.
 * - `mcp_only_plugin`: a plugin with only MCP members, which cloud sessions
 *   cannot run as a plugin.
 * - `unavailable`: the catalog marks the entry unavailable (for example, a
 *   marketplace plugin whose sync has not succeeded).
 */
export type PortalCatalogEntryBlocker =
  | 'desktop_only'
  | 'mcp_only_plugin'
  | 'unavailable';

export function portalCatalogEntryBlocker(
  entry: Pick<
    PortalPluginCatalogUnifiedEntry,
    'kind' | 'state' | 'connectionState' | 'cloudCapabilities'
  >,
): PortalCatalogEntryBlocker | null {
  if (!portalCatalogMcpServerConnectable(entry)) return 'desktop_only';
  if (entry.kind === 'plugin' && entry.cloudCapabilities.mcpOnly)
    return 'mcp_only_plugin';
  if (entry.state !== 'available') return 'unavailable';
  return null;
}

/** Whether an MCP server row can be connected from this surface. */
export function portalCatalogMcpServerConnectable(
  server: Pick<PortalMcpConnectionMetadata, 'connectionState'>,
): boolean {
  return server.connectionState !== 'desktop_only';
}
