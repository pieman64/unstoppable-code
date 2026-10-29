import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type {
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';

interface UseMcpServerListReturn {
  servers: McpServerIndexEntry[];
  accountConnectionsAvailable?: boolean;
  accountConnectionsUnavailableReason?: McpServersIndexFile['accountConnectionsUnavailableReason'];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMcpServerList(): UseMcpServerListReturn {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const generation = useRef(0);
  const [accountConnectionsAvailable, setAccountConnectionsAvailable] =
    useState<boolean>();
  const [
    accountConnectionsUnavailableReason,
    setAccountConnectionsUnavailableReason,
  ] = useState<McpServersIndexFile['accountConnectionsUnavailableReason']>();
  const [servers, setServers] = useState<McpServerIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.mcpServers.loadIndex();
      if (requestGeneration !== generation.current) return;
      setServers(result.servers);
      setAccountConnectionsAvailable(result.accountConnectionsAvailable);
      setAccountConnectionsUnavailableReason(
        result.accountConnectionsUnavailableReason,
      );
    } catch (err) {
      if (requestGeneration === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    void load();
    const refresh = (): void => {
      void load();
    };
    const unsubscribe = window.mcpServers.onAuthChanged?.(refresh);
    const unsubscribeInstalled = window.installedItems?.onChanged(refresh);
    window.addEventListener('focus', refresh);
    return (): void => {
      generation.current += 1;
      unsubscribe?.();
      unsubscribeInstalled?.();
      window.removeEventListener('focus', refresh);
    };
    // A live flag flip changes which rows the index reports, so reload then.
  }, [load, accountEnabled]);

  // Consumers key effects on this list (PluginsPage refreshes statuses from
  // it), so it must keep its identity between renders.
  const visibleServers = useMemo(
    (): McpServerIndexEntry[] =>
      accountEnabled
        ? servers
        : servers.flatMap((row): McpServerIndexEntry[] =>
            row.scope === 'account' ? (row.deviceCopies ?? []) : [row],
          ),
    [accountEnabled, servers],
  );
  return {
    servers: visibleServers,
    loading,
    error,
    refresh,
    accountConnectionsAvailable,
    accountConnectionsUnavailableReason,
  };
}
