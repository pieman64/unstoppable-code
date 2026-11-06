import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  DetectedMcpServerInfo,
  McpServerIndexEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { PluginMcpServerInfo } from '@canopy/protocol/plugins';
import type {
  McpTestConnectionOutcome,
  PluginDetailMcpConnection,
  PluginDetailMcpHealth,
  PluginDetailMcpServerHealth,
} from '@canopy/ui-app/capability';
import {
  MCP_MANAGEMENT_REASONS,
  mcpAuthConnectLabel,
} from '@canopy/ui-shared/lib/mcp-card-display';
import { mcpEndpointKey } from '@canopy/ui-shared/lib/mcp-endpoint-key';
import { PLUGIN_DETAIL_MCP_NOT_CONFIGURED } from '@canopy/ui-shared/lib/plugin-detail-mcp';
import type { UnifiedEntryBundledServerRow } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { formatRelativeTime } from '@/lib/format';
import { withIpcErrorMessage } from '@/lib/ipcErrorMessage';
import { useDetectedMcpServers } from './useDetectedMcpServers';
import { useMcpServerStatuses } from './useMcpServerStatuses';

interface LoadedIndex {
  /** The server id set this read answered. */
  readonly key: string;
  readonly entries: McpServerIndexEntry[];
}

const NO_ENTRIES: McpServerIndexEntry[] = [];

/** An installed plugin, whose bundled servers can connect from its page. */
export interface PluginMcpConnectTarget {
  readonly marketplaceId: string;
  readonly pluginName: string;
}

/**
 * The plugin detail's MCP server health on this device (CAN-4842): each
 * bundled server the plugin installed reads its device index entry and cached
 * status, and tests through the same IPC as the MCP server page.
 *
 * The index is read once per distinct server id set. Once a server has a
 * target, a status refresh (after Test connection or an auth change) keeps
 * it, so the row never falls back to loading.
 *
 * With a `connectTarget`, a server also offers Connect, matched by plugin and
 * manifest name so a same-named server elsewhere never answers for it. A
 * server without a device row can still connect through its plugin target.
 */
export function usePluginMcpServerHealth(
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[],
  connectTarget?: PluginMcpConnectTarget,
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

  const marketplaceId = connectTarget?.marketplaceId;
  const pluginName = connectTarget?.pluginName;
  const selections = useMemo((): ChatTabPluginSelections | null => {
    if (marketplaceId === undefined || pluginName === undefined) return null;
    return {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId, pluginName }],
      mcpServerRefs: entries.flatMap((entry) =>
        entry.configs.map((config) => ({
          serverId: entry.id,
          configId: config.id,
        })),
      ),
    };
  }, [entries, marketplaceId, pluginName]);
  const detectedMcp = useDetectedMcpServers(selections, {
    ownerKey: `plugin-detail/${marketplaceId ?? ''}/${pluginName ?? ''}`,
    cancelOnDispose: true,
  });
  const {
    servers: detected,
    connectingKey,
    signInUrl,
    awaitingAuthorization,
    error: detectedError,
  } = detectedMcp;
  // Keep a failed member visible even when its inventory refresh fails, and
  // preserve its error while another member is connected.
  const [attemptedKey, setAttemptedKey] = useState<string | null>(null);
  const [attemptedServer, setAttemptedServer] =
    useState<DetectedMcpServerInfo | null>(null);
  const [memberErrors, setMemberErrors] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  useEffect((): void => {
    if (attemptedKey && detectedError && connectingKey === null)
      setMemberErrors((previous) => ({
        ...previous,
        [attemptedKey]: detectedError,
      }));
  }, [attemptedKey, detectedError, connectingKey]);
  const connect = useCallback(
    (server: DetectedMcpServerInfo, signInRequired: boolean): void => {
      setAttemptedKey(server.key);
      setAttemptedServer(server);
      setMemberErrors((previous) => ({ ...previous, [server.key]: undefined }));
      void detectedMcp.connect(server, { signInRequired }).then(async () => {
        try {
          await window.mcpServers.listStatus();
          if (mounted.current) refresh();
        } catch {
          if (mounted.current)
            setMemberErrors((previous) => ({
              ...previous,
              [server.key]: 'Couldn’t refresh connection health. Try again.',
            }));
        }
      });
    },
    [detectedMcp, refresh],
  );

  return useMemo((): PluginDetailMcpHealth => {
    const pluginRowsOf = (name: string): DetectedMcpServerInfo[] => {
      const rows = detected.filter(
        (candidate) =>
          candidate.source === 'plugin' &&
          candidate.marketplaceId === marketplaceId &&
          candidate.pluginName === pluginName &&
          candidate.pluginServerName === name,
      );
      if (
        rows.length === 0 &&
        attemptedServer?.pluginServerName === name &&
        attemptedServer.marketplaceId === marketplaceId &&
        attemptedServer.pluginName === pluginName &&
        (detectedError !== null ||
          memberErrors[attemptedServer.key] !== undefined)
      )
        return [attemptedServer];
      return rows;
    };
    const hasAuthRequiredHealth = (server: DetectedMcpServerInfo): boolean =>
      server.enabled &&
      server.type === 'http' &&
      server.httpAuthHandler === 'canopy' &&
      server.serverId !== undefined &&
      server.configId !== undefined &&
      statuses.get(server.serverId)?.connectionStatus === 'auth_required';
    const requiresSignIn = (server: DetectedMcpServerInfo): boolean => {
      if (!hasAuthRequiredHealth(server)) return false;
      const config = statuses
        .get(server.serverId ?? '')
        ?.configs.find((candidate) => candidate.configId === server.configId);
      if (config && mcpAuthConnectLabel(config.authStatus, config.canRefresh))
        return true;
      // Aggregate health cannot identify a rejected token among siblings.
      // Only a sole enabled config is an unambiguous health recovery target.
      const enabled = entries
        .find((entry) => entry.id === server.serverId)
        ?.configs.filter((candidate) => candidate.enabled);
      return enabled?.length === 1 && enabled[0]?.id === server.configId;
    };
    const connectionOf = (
      rows: readonly DetectedMcpServerInfo[],
    ): PluginDetailMcpConnection | undefined => {
      const server =
        rows.find((candidate) => candidate.key === connectingKey) ??
        rows.find(requiresSignIn) ??
        rows.find((candidate) => candidate.enabled && candidate.canConnect) ??
        rows.find(
          (candidate) =>
            memberErrors[candidate.key] !== undefined ||
            (candidate.key === attemptedKey && detectedError !== null),
        ) ??
        rows.find(hasAuthRequiredHealth);
      if (!server) return undefined;
      const active = connectingKey === server.key;
      const authLabel = mcpAuthConnectLabel(
        server.authStatus,
        server.canRefresh,
      );
      return {
        label: authLabel ?? server.connectLabel ?? 'Connect',
        kind: authLabel === 'Reconnect' ? 'reconnect' : 'connect',
        action:
          (server.enabled && (server.canConnect || requiresSignIn(server))) ||
          active
            ? {
                available: true,
                run: () => connect(server, requiresSignIn(server)),
              }
            : {
                available: false,
                reason: hasAuthRequiredHealth(server)
                  ? 'Choose a configuration in MCP servers to reconnect.'
                  : server.authStatusLabel,
              },
        phase: !active
          ? 'idle'
          : awaitingAuthorization
            ? 'waiting'
            : 'connecting',
        disabled: connectingKey !== null && !active,
        ...(active && signInUrl ? { authorizationUrl: signInUrl } : {}),
        ...(active ? { onCancel: () => detectedMcp.cancelConnect() } : {}),
        error:
          memberErrors[server.key] ??
          (attemptedKey === server.key ? detectedError : null),
      };
    };
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
        const pluginRows = pluginRowsOf(server.name);
        if (!row) {
          // No device row says nothing about its state: only the inventory's
          // own row does, and an empty inventory keeps "Not configured yet".
          const [pluginRow] = pluginRows;
          if (!pluginRow) return undefined;
          const connection = connectionOf(pluginRows);
          return {
            kind: 'unavailable',
            reason:
              pluginRow.authStatus === 'connected'
                ? 'Connected'
                : pluginRow.authStatusLabel,
            // Signed in: the row shows this with the green connected dot.
            connected: pluginRow.authStatus === 'connected',
            ...(connection ? { connection } : {}),
          };
        }
        const entry = byId.get(row.serverId);
        if (!entry) {
          return loadedCurrentSet
            ? { kind: 'unavailable', reason: PLUGIN_DETAIL_MCP_NOT_CONFIGURED }
            : { kind: 'loading' };
        }
        const deviceRows = detected.filter(
          (candidate) =>
            candidate.source === 'standalone' &&
            candidate.serverId === entry.id,
        );
        const connection = connectionOf(
          deviceRows.length > 0 ? deviceRows : pluginRows,
        );
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
          ...(connection ? { connection } : {}),
        };
      },
      formatTimestamp: formatRelativeTime,
    };
  }, [
    attemptedKey,
    attemptedServer,
    memberErrors,
    awaitingAuthorization,
    bundledServerRows,
    connect,
    connectingKey,
    detected,
    detectedError,
    detectedMcp,
    entries,
    index?.key,
    marketplaceId,
    pluginName,
    refresh,
    serverIdsKey,
    signInUrl,
    statuses,
  ]);
}
