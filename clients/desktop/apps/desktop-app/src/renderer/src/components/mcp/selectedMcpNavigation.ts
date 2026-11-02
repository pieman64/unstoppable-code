import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';
import { unifiedEntryIdForRef } from '@canopy/ui-app/capability';
import type { PluginsNavigationIntent } from '@/stores/navigationStore';

let request = 0;

/** Exact refs only: an account key must never resolve through a catalog aggregate. */
export function selectedMcpNavigation(
  server: DetectedMcpServerInfo,
  settings: boolean,
): PluginsNavigationIntent | null {
  if (server.source === 'plugin' && server.marketplaceId && server.pluginName) {
    const entryId = unifiedEntryIdForRef({
      type: 'marketplace-plugin',
      marketplaceId: server.marketplaceId,
      pluginName: server.pluginName,
    });
    const resolvedId =
      server.marketplaceId === CURATED_PLUGIN_MARKETPLACE_ID
        ? `curated:${server.pluginName}`
        : entryId;
    if (!resolvedId || (settings && !server.pluginServerName)) return null;
    return {
      kind: 'entry-detail',
      entryId: resolvedId,
      ...(settings && server.pluginServerName
        ? {
            mcpTarget: {
              serverName: server.pluginServerName,
              ...(server.pluginProvider
                ? { provider: server.pluginProvider }
                : {}),
              requestId: String(++request),
            },
          }
        : {}),
    };
  }
  if (server.serverId && server.configId) {
    const entryId = unifiedEntryIdForRef({
      type: 'local-mcp',
      serverId: server.serverId,
      ...(server.scope === 'account' || server.accountConnectionId
        ? { configId: server.configId }
        : {}),
    });
    return entryId ? { kind: 'entry-detail', entryId } : null;
  }
  if (server.curatedKey && !server.accountConnectionId)
    return {
      kind: 'entry-detail',
      entryId: `mcp-catalog:${server.curatedKey}`,
    };
  return null;
}
