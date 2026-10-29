// ---------------------------------------------------------------------------
// Helpers extracted from useDetectedMcpServers so they can be unit-tested
// without spinning up a React tree. The hook itself only orchestrates state
// transitions; pure derivations live here.
// ---------------------------------------------------------------------------

import type {
  DetectedMcpServerInfo,
  McpHttpAuthTarget,
} from '@canopy/desktop-shared/types/mcp-servers';

/**
 * Compute the {@link McpHttpAuthTarget} that uniquely identifies `server`
 * inside a chat's plugin selections.
 *
 * Returns `null` when the server lacks the fields required to be addressed
 * (e.g. command rows, plugins missing marketplace/server metadata). Callers
 * should treat a `null` return as "no toggle target available" and skip any
 * proxy-toggle write.
 */
export function targetForDetectedServer(
  server: DetectedMcpServerInfo,
): McpHttpAuthTarget | null {
  if (server.serverId && server.configId) {
    return {
      kind: 'standalone',
      serverId: server.serverId,
      configId: server.configId,
    };
  }
  if (server.marketplaceId && server.pluginName && server.pluginServerName) {
    return {
      kind: 'plugin',
      marketplaceId: server.marketplaceId,
      pluginName: server.pluginName,
      serverName: server.pluginServerName,
    };
  }
  return null;
}
