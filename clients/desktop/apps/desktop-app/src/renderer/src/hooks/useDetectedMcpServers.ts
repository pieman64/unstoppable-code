import { mcpAuthConnectLabel, mcpAuthStatusLabel } from '@canopy/ui-shared/lib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  DetectedMcpServerInfo,
  ListDetectedMcpServersResponse,
  McpServerAuthStatus,
} from '@canopy/desktop-shared/types/mcp-servers';
import { setMcpHttpAuthPreference } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { targetForDetectedServer } from './detectedMcpServerHelpers';

const DEFAULT_LOGIN_FAILED_MESSAGE = 'OAuth sign-in failed.';
const OAUTH_LOGIN_TIMEOUT_MESSAGE =
  'OAuth sign-in timed out before completion.';
const DEFAULT_PROXY_TOGGLE_FAILED_MESSAGE =
  'Could not update MCP proxy setting.';
const OAUTH_POLL_INTERVAL_MS = 1_500;
const OAUTH_POLL_TIMEOUT_MS = 120_000;
const OAUTH_POLL_PENDING_STATUSES: readonly McpServerAuthStatus[] = [
  'not_connected',
  'expired',
];

export interface UseDetectedMcpServersOptions {
  /**
   * Optional callback invoked with the next {@link ChatTabPluginSelections}
   * after a per-server proxy toggle. Hosts pass their `setPluginSelections`
   * here so the toggle persists into the active chat tab.
   */
  onSelectionsChange?: (next: ChatTabPluginSelections) => void;
}

export interface UseDetectedMcpServersResult {
  initializing: boolean;
  servers: DetectedMcpServerInfo[];
  warnings: string[];
  loading: boolean;
  error: string | null;
  connectingKey: string | null;
  /**
   * Server key currently being toggled between Canopy proxy and provider auth.
   * Cleared on both success and failure.
   */
  proxyUpdatingKey: string | null;
  refresh(this: void): Promise<void>;
  connect(server: DetectedMcpServerInfo): Promise<void>;
  setCanopyProxyEnabled(
    server: DetectedMcpServerInfo,
    enabled: boolean,
  ): Promise<void>;
}

interface InternalState {
  initialized: boolean;
  servers: DetectedMcpServerInfo[];
  warnings: string[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: InternalState = {
  initialized: false,
  servers: [],
  warnings: [],
  loading: false,
  error: null,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function findMatchingServer(
  response: ListDetectedMcpServersResponse,
  server: DetectedMcpServerInfo,
): DetectedMcpServerInfo | undefined {
  return response.servers.find((entry) => entry.key === server.key);
}

function isOAuthStillPending(
  server: DetectedMcpServerInfo | undefined,
  initialErrorRevision?: string,
): boolean {
  if (
    server?.authStatus === 'error' &&
    initialErrorRevision !== undefined &&
    server.authErrorRevision === initialErrorRevision
  ) {
    return true;
  }
  return server
    ? OAUTH_POLL_PENDING_STATUSES.includes(server.authStatus)
    : false;
}

export function getOAuthFailureMessage(
  server: DetectedMcpServerInfo | undefined,
  initialErrorRevision?: string,
): string | null {
  if (server?.authStatus !== 'error') {
    return null;
  }
  if (
    initialErrorRevision !== undefined &&
    server.authErrorRevision === initialErrorRevision
  ) {
    return null;
  }
  return server.lastError ?? DEFAULT_LOGIN_FAILED_MESSAGE;
}

export function useDetectedMcpServers(
  selections: ChatTabPluginSelections | null,
  options: UseDetectedMcpServersOptions = {},
): UseDetectedMcpServersResult {
  const [state, setState] = useState<InternalState>(EMPTY_STATE);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [proxyUpdatingKey, setProxyUpdatingKey] = useState<string | null>(null);

  // Stable cancellation token so concurrent refreshes don't clobber each
  // other. The latest call wins.
  const requestSeqRef = useRef<number>(0);
  const selectionsRef = useRef<ChatTabPluginSelections | null>(selections);
  selectionsRef.current = selections;

  const onSelectionsChangeRef = useRef<
    UseDetectedMcpServersOptions['onSelectionsChange']
  >(options.onSelectionsChange);
  onSelectionsChangeRef.current = options.onSelectionsChange;

  const fetchInventory =
    useCallback(async (): Promise<ListDetectedMcpServersResponse | null> => {
      const current = selectionsRef.current;
      if (current === null) {
        requestSeqRef.current += 1;
        setState({ ...EMPTY_STATE });
        return null;
      }
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      setState((prev) => ({
        initialized: prev.initialized,
        servers: prev.servers,
        warnings: prev.warnings,
        loading: true,
        error: null,
      }));
      try {
        const response: ListDetectedMcpServersResponse =
          await window.mcpServers.listDetected({ selections: current });
        if (seq !== requestSeqRef.current) return null;
        setState({
          initialized: true,
          servers: response.servers,
          warnings: response.warnings,
          loading: false,
          error: null,
        });
        return response;
      } catch (err: unknown) {
        if (seq !== requestSeqRef.current) return null;
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not load MCP servers.';
        setState({
          initialized: true,
          servers: [],
          warnings: [],
          loading: false,
          error: message,
        });
        return null;
      }
    }, []);

  const pollUntilOAuthCompletes = useCallback(
    async (server: DetectedMcpServerInfo): Promise<void> => {
      const startedAt = Date.now();
      const initialErrorRevision =
        server.authStatus === 'error' ? server.authErrorRevision : undefined;
      while (Date.now() - startedAt < OAUTH_POLL_TIMEOUT_MS) {
        await wait(OAUTH_POLL_INTERVAL_MS);
        const response = await fetchInventory();
        if (!response) {
          continue;
        }
        const matchingServer = findMatchingServer(response, server);
        const failureMessage = getOAuthFailureMessage(
          matchingServer,
          initialErrorRevision,
        );
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        if (!isOAuthStillPending(matchingServer, initialErrorRevision)) {
          return;
        }
      }
      throw new Error(OAUTH_LOGIN_TIMEOUT_MESSAGE);
    },
    [fetchInventory],
  );

  // Refetch whenever selections change. Use a stable JSON snapshot so we
  // don't re-run on object identity changes that produce equal contents.
  const selectionsKey = selections ? JSON.stringify(selections) : null;
  useEffect((): void => {
    void fetchInventory();
    // selectionsKey intentionally captures the structural identity.
  }, [fetchInventory, selectionsKey]);

  useEffect(
    () =>
      window.mcpServers.onAuthChanged?.(() => {
        void fetchInventory();
      }),
    [fetchInventory],
  );

  // Token expiry changes cached validity without a disk write. Update the
  // visible snapshot locally; never probe servers or open auth from a timer.
  useEffect(() => {
    const expirations = state.servers.flatMap((server) =>
      server.authStatus === 'connected' &&
      server.expiresAt &&
      Number.isFinite(Date.parse(server.expiresAt))
        ? [Date.parse(server.expiresAt)]
        : [],
    );
    if (expirations.length === 0) return;
    const timer = window.setTimeout(
      () => {
        setState((previous) => ({
          ...previous,
          servers: previous.servers.map((server): DetectedMcpServerInfo => {
            if (
              server.authStatus !== 'connected' ||
              !server.expiresAt ||
              Date.parse(server.expiresAt) > Date.now()
            )
              return server;
            return {
              ...server,
              authStatus: 'expired',
              authStatusLabel: mcpAuthStatusLabel('expired', server.canRefresh),
              canConnect:
                mcpAuthConnectLabel('expired', server.canRefresh) !== undefined,
              connectLabel: mcpAuthConnectLabel('expired', server.canRefresh),
            };
          }),
        }));
      },
      Math.min(
        2_147_483_647,
        Math.max(0, Math.min(...expirations) - Date.now()),
      ),
    );
    return (): void => window.clearTimeout(timer);
  }, [state.servers]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetchInventory();
  }, [fetchInventory]);

  const connect = useCallback(
    async (server: DetectedMcpServerInfo): Promise<void> => {
      if (!server.canConnect) {
        return;
      }
      const standaloneRequest =
        server.serverId && server.configId
          ? {
              serverId: server.serverId,
              configId: server.configId,
            }
          : null;
      const pluginRequest =
        server.marketplaceId && server.pluginName && server.pluginServerName
          ? {
              plugin: {
                marketplaceId: server.marketplaceId,
                pluginName: server.pluginName,
                serverName: server.pluginServerName,
                ...(server.pluginProvider
                  ? { provider: server.pluginProvider }
                  : {}),
              },
            }
          : null;
      const request = standaloneRequest ?? pluginRequest;
      if (!request) {
        return;
      }

      setConnectingKey(server.key);
      setState((prev) => ({ ...prev, error: null }));
      try {
        const response = await window.mcpServers.startOAuthLogin({
          ...request,
          force: false,
        });
        if (response.status === 'completed') {
          await fetchInventory();
          return;
        }
        await pollUntilOAuthCompletes(server);
      } catch (err: unknown) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : DEFAULT_LOGIN_FAILED_MESSAGE;
        setState((prev) => ({ ...prev, error: message }));
      } finally {
        setConnectingKey((current) =>
          current === server.key ? null : current,
        );
      }
    },
    [fetchInventory, pollUntilOAuthCompletes],
  );

  const setCanopyProxyEnabled = useCallback(
    async (server: DetectedMcpServerInfo, enabled: boolean): Promise<void> => {
      if (!server.canToggleCanopyProxy) {
        return;
      }
      const target = targetForDetectedServer(server);
      if (target === null) {
        return;
      }

      const currentSelections =
        selectionsRef.current ??
        ({
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        } satisfies ChatTabPluginSelections);

      setProxyUpdatingKey(server.key);
      setState((prev) => ({ ...prev, error: null }));
      try {
        const next = setMcpHttpAuthPreference(
          currentSelections,
          target,
          enabled ? 'canopy' : 'provider',
        );
        const callback = onSelectionsChangeRef.current;
        if (callback) {
          callback(next);
          // Optimistically reflect the change locally so the inventory
          // refresh below sees the override even if the host's
          // `setPluginSelections` has not yet flowed back through props.
          selectionsRef.current = next;
        }
        await fetchInventory();
      } catch {
        setState((prev) => ({
          ...prev,
          error: DEFAULT_PROXY_TOGGLE_FAILED_MESSAGE,
        }));
      } finally {
        setProxyUpdatingKey((current) =>
          current === server.key ? null : current,
        );
      }
    },
    [fetchInventory],
  );

  const initializing = selections !== null && !state.initialized;
  return useMemo(
    (): UseDetectedMcpServersResult => ({
      servers: state.servers,
      warnings: state.warnings,
      loading: state.loading || initializing,
      initializing,
      error: state.error,
      connectingKey,
      proxyUpdatingKey,
      refresh,
      connect,
      setCanopyProxyEnabled,
    }),
    [
      state.servers,
      state.warnings,
      state.loading,
      initializing,
      state.error,
      connectingKey,
      proxyUpdatingKey,
      refresh,
      connect,
      setCanopyProxyEnabled,
    ],
  );
}
