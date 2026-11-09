import type { DetectedMcpServerInfo } from '@canopy/execution-engine/types/mcp-servers';

export function isUnboundPlugin(server: DetectedMcpServerInfo): boolean {
  return (
    server.source === 'plugin' &&
    server.type === 'http' &&
    server.enabled &&
    server.httpAuthHandler === 'account' &&
    !server.accountConnectionId &&
    !server.curatedKey &&
    !!server.marketplaceId &&
    !!server.pluginName &&
    !!server.pluginServerName &&
    (server.authStatus === 'not_connected' || server.authStatus === 'expired')
  );
}

/** A member preference has no provider dimension. Every selected sibling must agree. */
export function desktopRouteSupported(
  server: DetectedMcpServerInfo,
  inventory: readonly DetectedMcpServerInfo[],
  preview: readonly DetectedMcpServerInfo[],
): boolean {
  if (!isUnboundPlugin(server)) return false;
  const siblings = inventory.filter(
    (entry) =>
      entry.source === 'plugin' &&
      entry.marketplaceId === server.marketplaceId &&
      entry.pluginName === server.pluginName &&
      entry.pluginServerName === server.pluginServerName,
  );
  return (
    siblings.length > 0 &&
    siblings.every((entry) => {
      if (!isUnboundPlugin(entry)) return false;
      const candidates = preview.filter(
        (candidate) => candidate.key === entry.key,
      );
      const candidate = candidates[0];
      return (
        candidates.length === 1 &&
        candidate !== undefined &&
        candidate.httpAuthHandler === 'canopy' &&
        candidate.authHandler !== 'provider' &&
        (candidate.authStatus === 'connected' || candidate.canConnect) &&
        candidate.authStatus !== 'not_configured' &&
        candidate.authStatus !== 'unsupported' &&
        !candidate.accountConnectionId &&
        !candidate.curatedKey
      );
    })
  );
}
