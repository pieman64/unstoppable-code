import { useEffect, useMemo, useState } from 'react';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import type { PluginMcpServerInfo } from '@canopy/protocol/plugins';
import type {
  McpTestConnectionOutcome,
  PluginDetailMcpHealth,
  PluginDetailMcpServerHealth,
} from '@canopy/ui-app/capability';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import { mcpEndpointKey } from '@canopy/ui-shared/lib/mcp-endpoint-key';
import { PLUGIN_DETAIL_MCP_NOT_CONFIGURED } from '@canopy/ui-shared/lib/plugin-detail-mcp';
import type { UnifiedEntryBundledServerRow } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { formatRelativeTime } from '@/lib/format';
import { withIpcErrorMessage } from '@/lib/ipcErrorMessage';
import { useMcpServerStatuses } from './useMcpServerStatuses';

interface LoadedIndex {
  /** The server id set this read answered. */
  readonly key: string;
  readonly entries: McpServerIndexEntry[];
}

const NO_ENTRIES: McpServerIndexEntry[] = [];

/**
 * The plugin detail's MCP server health on this device (CAN-4842): each
 * bundled server the plugin installed reads its device index entry and cached
 * status, and tests through the same IPC as the MCP server page.
 *
 * The index is read once per distinct server id set. Once a server has a
 * target, a status refresh (after Test connection or an auth change) keeps
 * it, so the row never falls back to loading.
 */
export function usePluginMcpServerHealth(
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[],
): PluginDetailMcpHealth {
  const serverIdsKey = useMemo(
    () =>
      bundledServerRows
        ? Array.from(new Set(bundledServerRows.map((row) => row.serverId)))
            .sort()
            .join('\n')
        : '',
    [bundledServerRows],
  );
  const [index, setIndex] = useState<LoadedIndex | null>(null);

  useEffect(() => {
    if (serverIdsKey === '') return;
    let cancelled = false;
    const ids = new Set(serverIdsKey.split('\n'));
    const settle = (entries: McpServerIndexEntry[]): void => {
      if (!cancelled) setIndex({ key: serverIdsKey, entries });
    };
    window.mcpServers.loadIndex().then(
      (file) => {
        settle(file.servers.filter((entry) => ids.has(entry.id)));
      },
      () => {
        // No handler / transport failure → no device configuration to show.
        settle([]);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [serverIdsKey]);

  const entries = index?.entries ?? NO_ENTRIES;
  const { statuses, refresh } = useMcpServerStatuses(entries);

  return useMemo((): PluginDetailMcpHealth => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const loadedCurrentSet = index?.key === serverIdsKey;
    return {
      resolve: (
        server: PluginMcpServerInfo,
      ): PluginDetailMcpServerHealth | undefined => {
        const endpoint = mcpEndpointKey(server);
        const row = bundledServerRows?.find(
          (candidate) =>
            candidate.serverName === server.name &&
            candidate.endpoint === endpoint,
        );
        if (!row) return undefined;
        const entry = byId.get(row.serverId);
        if (!entry) {
          return loadedCurrentSet
            ? { kind: 'unavailable', reason: PLUGIN_DETAIL_MCP_NOT_CONFIGURED }
            : { kind: 'loading' };
        }
        const status = statuses.get(entry.id);
        const provider =
          entry.authHandler === 'provider' || status?.handler === 'provider';
        return {
          kind: 'target',
          target: {
            targetKey: entry.id,
            status,
            configs: entry.configs.map(({ id, name }) => ({ id, name })),
            testConnection: provider
              ? { available: false, reason: MCP_MANAGEMENT_REASONS.provider }
              : entry.scope === 'account'
                ? { available: false, reason: MCP_MANAGEMENT_REASONS.cloudTest }
                : {
                    available: true,
                    run: (
                      configId: string,
                    ): Promise<McpTestConnectionOutcome> =>
                      withIpcErrorMessage(() =>
                        window.mcpServers.testConnection(entry.id, configId),
                      ),
                  },
            onTested: refresh,
          },
        };
      },
      formatTimestamp: formatRelativeTime,
    };
  }, [bundledServerRows, entries, index?.key, refresh, serverIdsKey, statuses]);
}
