import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';

interface UseMcpServerStatusesReturn {
  /** Per-server connection status, keyed by `serverId`. Empty when unknown. */
  statuses: Map<string, McpServerStatusEntry>;
  /** Re-read cached status (e.g. after a save/connect). */
  refresh: () => void;
}

/**
 * Read cached connection/auth state without contacting remote servers.
 * Mount, token changes, and expiry must not initialize servers or provoke
 * authentication prompts. Health Check and Test Connection are explicit UI
 * actions; runtime requests perform silent token renewal on demand.
 */
export function useMcpServerStatuses(
  servers: McpServerIndexEntry[],
): UseMcpServerStatusesReturn {
  const [statuses, setStatuses] = useState<Map<string, McpServerStatusEntry>>(
    () => new Map(),
  );
  const [nonce, setNonce] = useState(0);

  // Stable signature of the current server set so the read re-runs only when
  // servers are added/removed, not on every render.
  const idsKey = servers
    .map((s) => JSON.stringify([s.id, s.updatedAt, s.configs]))
    .sort()
    .join(',');

  const refresh = useCallback((): void => {
    setNonce((n) => n + 1);
  }, []);

  // Latest server list, read inside async callbacks without re-subscribing.
  const serversRef = useRef<McpServerIndexEntry[]>([]);
  serversRef.current = servers;

  useEffect(() => {
    const current = serversRef.current;
    if (current.length === 0) {
      setStatuses(new Map());
      return;
    }

    let cancelled = false;
    let readVersion = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;

    const readStatuses = async (): Promise<void> => {
      const version = ++readVersion;
      try {
        const entries = await window.mcpServers.listStatus();
        if (cancelled || version !== readVersion) return;
        clearTimeout(expiryTimer);
        const expirations = entries.flatMap((entry) =>
          entry.configs.flatMap((config) =>
            config.authStatus === 'connected' &&
            config.expiresAt &&
            Number.isFinite(Date.parse(config.expiresAt))
              ? [Date.parse(config.expiresAt)]
              : [],
          ),
        );
        if (expirations.length) {
          expiryTimer = setTimeout(
            () => {
              void readStatuses();
            },
            Math.min(
              2_147_483_647,
              Math.max(0, Math.min(...expirations) - Date.now()),
            ),
          );
        }
        setStatuses(
          new Map(
            entries.map((entry): [string, McpServerStatusEntry] => [
              entry.serverId,
              entry,
            ]),
          ),
        );
      } catch {
        // No handler / transport failure → leave everything "Not checked".
      }
    };

    void readStatuses();
    const unsubscribe = window.mcpServers.onAuthChanged?.(() => {
      void readStatuses();
    });

    return (): void => {
      cancelled = true;
      clearTimeout(expiryTimer);
      unsubscribe?.();
    };
  }, [idsKey, nonce]);

  return { statuses, refresh };
}
