// ---------------------------------------------------------------------------
// Helpers extracted from useDetectedMcpServers so they can be unit-tested
// without spinning up a React tree. The hook itself only orchestrates state
// transitions; pure derivations live here.
// ---------------------------------------------------------------------------

import type {
  DetectedMcpServerInfo,
  McpHttpAuthTarget,
} from '@canopy/execution-engine/types/mcp-servers';
import { mcpRequirementUnknown } from '@canopy/ui-shared/lib/mcp-card-display';

/** Identity and auth route must survive a refresh of an in-flight target. */
export function sameDetectedMcpTarget(
  started: DetectedMcpServerInfo,
  current: DetectedMcpServerInfo,
): boolean {
  return (
    current.key === started.key &&
    current.source === started.source &&
    current.serverId === started.serverId &&
    current.configId === started.configId &&
    current.marketplaceId === started.marketplaceId &&
    current.pluginName === started.pluginName &&
    current.pluginServerName === started.pluginServerName &&
    current.pluginProvider === started.pluginProvider &&
    current.url === started.url &&
    current.type === started.type &&
    current.httpAuthHandler === started.httpAuthHandler &&
    current.enabled === started.enabled
  );
}

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

/**
 * Whether a Connect that finished without a sign-in left `current` needing
 * none. A row can also be non-connectable because it was disabled or moved to
 * another auth route, so the same enabled HTTP target on the same route must
 * remain. Direct plugin inventory cannot distinguish no-auth from
 * plugin-managed auth, so only a config-backed target can confirm this.
 * Says nothing about whether the server is reachable.
 */
export function isNoAuthCompletion(
  started: DetectedMcpServerInfo,
  current: DetectedMcpServerInfo,
): boolean {
  return (
    mcpRequirementUnknown(started) &&
    current.serverId !== undefined &&
    current.configId !== undefined &&
    sameDetectedMcpTarget(started, current) &&
    current.authStatus === 'not_configured' &&
    !current.canConnect &&
    current.enabled &&
    current.type === 'http' &&
    current.httpAuthHandler === 'canopy'
  );
}
