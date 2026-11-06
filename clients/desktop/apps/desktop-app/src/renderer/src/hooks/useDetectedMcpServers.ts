import {
  mcpAuthConnectLabel,
  mcpAuthStatusLabel,
  mcpRequirementUnknown,
} from '@canopy/ui-shared/lib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  DetectedMcpServerInfo,
  ListDetectedMcpServersResponse,
  McpServerAuthStatus,
} from '@canopy/desktop-shared/types/mcp-servers';
import { setMcpHttpAuthPreference } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  isNoAuthCompletion,
  sameDetectedMcpTarget,
  targetForDetectedServer,
} from './detectedMcpServerHelpers';

const DEFAULT_LOGIN_FAILED_MESSAGE = 'OAuth sign-in failed.';
const OAUTH_LOGIN_TIMEOUT_MESSAGE =
  'OAuth sign-in timed out before completion.';
const TARGET_UNAVAILABLE_MESSAGE = 'This MCP server is no longer available';
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
  onSelectionsChange?: (
    next: ChatTabPluginSelections,
  ) => void | boolean | Promise<void | boolean>;
  /** Invalidates observation when the draft or captured chat changes. */
  ownerKey?: string;
  isCurrent?: () => Promise<boolean>;
  /** A detail-owned flow is cancelled when that detail leaves the screen. */
  cancelOnDispose?: boolean;
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
  /** True only after confirmed completion; failures retain the sign-in error. */
  connect(
    server: DetectedMcpServerInfo,
    options?: { readonly signInRequired: boolean },
  ): Promise<boolean>;
  /** Re-resolves eligibility using selections already accepted by the host writer. */
  connectOnDevice(
    key: string,
    accepted: ChatTabPluginSelections,
    stillCurrent?: () => boolean,
  ): Promise<void>;
  cancelConnect(): void;
  signInUrl: string | undefined;
  awaitingAuthorization: boolean;
  setCanopyProxyEnabled(
    server: DetectedMcpServerInfo,
    enabled: boolean,
  ): Promise<void>;
}

interface InternalState {
  ownerKey: string | null;
  selectionKey: string | null;
  initialized: boolean;
  servers: DetectedMcpServerInfo[];
  warnings: string[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: InternalState = {
  ownerKey: null,
  selectionKey: null,
  initialized: false,
  servers: [],
  warnings: [],
  loading: false,
  error: null,
};

function findMatchingServer(
  response: ListDetectedMcpServersResponse,
  server: DetectedMcpServerInfo,
): DetectedMcpServerInfo | undefined {
  return response.servers.find((entry) => sameDetectedMcpTarget(server, entry));
}

function isOAuthStillPending(
  server: DetectedMcpServerInfo | undefined,
  initialErrorRevision?: string,
  startedUnknown = false,
): boolean {
  // An unknown requirement only waits for an attempt that began there; any
  // other attempt arriving in that state has lost its sign-in.
  if (startedUnknown && server && mcpRequirementUnknown(server)) return true;
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

interface LocalAttempt {
  readonly key: string;
  readonly owner: string;
  /** The selections this attempt started under. */
  readonly selectionKey: string | null;
  cancelled: boolean;
  cancelFlow: boolean;
  flowId?: string;
  wake?: () => void;
}

export function useDetectedMcpServers(
  selections: ChatTabPluginSelections | null,
  options: UseDetectedMcpServersOptions = {},
): UseDetectedMcpServersResult {
  const [state, setState] = useState<InternalState>(EMPTY_STATE);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | undefined>();
  const [awaitingAuthorization, setAwaitingAuthorization] = useState(false);
  const localAttempt = useRef<LocalAttempt | null>(null);
  const ownerRef = useRef(options.ownerKey ?? 'default');
  ownerRef.current = options.ownerKey ?? 'default';
  const isCurrentRef = useRef(options.isCurrent);
  isCurrentRef.current = options.isCurrent;
  const cancelOnDisposeRef = useRef(options.cancelOnDispose === true);
  cancelOnDisposeRef.current = options.cancelOnDispose === true;
  const mounted = useRef(true);
  const validAttempt = useCallback(
    (attempt: LocalAttempt): boolean =>
      mounted.current &&
      !attempt.cancelled &&
      localAttempt.current === attempt &&
      ownerRef.current === attempt.owner &&
      (selectionsRef.current ? JSON.stringify(selectionsRef.current) : null) ===
        attempt.selectionKey,
    [],
  );
  const stopAttempt = useCallback((cancelFlow: boolean): void => {
    const attempt = localAttempt.current;
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.cancelFlow = cancelFlow;
    attempt.wake?.();
    if (cancelFlow && attempt.flowId)
      void window.mcpServers
        .cancelOAuthLogin(attempt.flowId)
        .catch(() => undefined);
    localAttempt.current = null;
    if (mounted.current) {
      setConnectingKey(null);
      setSignInUrl(undefined);
      setAwaitingAuthorization(false);
    }
  }, []);
  const cancelConnect = useCallback(
    (): void => stopAttempt(true),
    [stopAttempt],
  );
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      stopAttempt(cancelOnDisposeRef.current);
      requestSeqRef.current += 1;
    };
  }, [stopAttempt]);
  useEffect(() => {
    stopAttempt(cancelOnDisposeRef.current);
    requestSeqRef.current += 1;
    setState({ ...EMPTY_STATE });
  }, [options.ownerKey, stopAttempt]);
  const [proxyUpdatingKey, setProxyUpdatingKey] = useState<string | null>(null);

  // Stable cancellation token so concurrent refreshes don't clobber each
  // other. The latest call wins.
  const requestSeqRef = useRef<number>(0);
  const inventoryFailure = useRef<string | null>(null);
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
      const owner = ownerRef.current;
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      inventoryFailure.current = null;
      setState((prev) => ({
        initialized: prev.initialized,
        ownerKey: prev.ownerKey,
        selectionKey: prev.selectionKey,
        servers: prev.servers,
        warnings: prev.warnings,
        loading: true,
        error: null,
      }));
      try {
        const response: ListDetectedMcpServersResponse =
          await window.mcpServers.listDetected({ selections: current });
        if (
          !mounted.current ||
          ownerRef.current !== owner ||
          seq !== requestSeqRef.current
        )
          return null;
        setState({
          ownerKey: owner,
          selectionKey: JSON.stringify(current),
          initialized: true,
          servers: response.servers,
          warnings: response.warnings,
          loading: false,
          error: null,
        });
        return response;
      } catch (err: unknown) {
        if (
          !mounted.current ||
          ownerRef.current !== owner ||
          seq !== requestSeqRef.current
        )
          return null;
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not load MCP servers.';
        inventoryFailure.current = message;
        setState({
          ownerKey: owner,
          selectionKey: JSON.stringify(current),
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
    async (
      server: DetectedMcpServerInfo,
      attempt: LocalAttempt,
      finishedWithoutFlow: boolean,
      signInRequired = false,
    ): Promise<boolean> => {
      const startedAt = Date.now();
      const initialErrorRevision =
        server.authStatus === 'error' ? server.authErrorRevision : undefined;
      const startedUnknown = mcpRequirementUnknown(server);
      while (
        validAttempt(attempt) &&
        Date.now() - startedAt < OAUTH_POLL_TIMEOUT_MS
      ) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, OAUTH_POLL_INTERVAL_MS);
          attempt.wake = (): void => {
            window.clearTimeout(timer);
            resolve();
          };
        });
        if (!validAttempt(attempt)) return false;
        if (isCurrentRef.current && !(await isCurrentRef.current()))
          return false;
        if (!validAttempt(attempt)) return false;
        const response = await fetchInventory();
        if (!validAttempt(attempt)) return false;
        if (!response) {
          if (inventoryFailure.current !== null)
            throw new Error('Couldn’t refresh sign-in status. Try again.');
          continue;
        }
        const matchingServer = findMatchingServer(response, server);
        if (!matchingServer) throw new Error(TARGET_UNAVAILABLE_MESSAGE);
        const failureMessage = getOAuthFailureMessage(
          matchingServer,
          initialErrorRevision,
        );
        if (failureMessage) throw new Error(failureMessage);
        if (matchingServer.authStatus === 'connected') return true;
        if (finishedWithoutFlow && isNoAuthCompletion(server, matchingServer))
          return true;
        if (
          !isOAuthStillPending(
            matchingServer,
            initialErrorRevision,
            startedUnknown,
          ) &&
          !(signInRequired && matchingServer.authStatus === 'not_configured')
        )
          throw new Error(
            'Couldn’t confirm this MCP server’s sign-in. Try again.',
          );
      }
      if (validAttempt(attempt)) throw new Error(OAUTH_LOGIN_TIMEOUT_MESSAGE);
      return false;
    },
    [fetchInventory, validAttempt],
  );

  // Refetch whenever selections change. Use a stable JSON snapshot so we
  // don't re-run on object identity changes that produce equal contents.
  const selectionsKey = selections ? JSON.stringify(selections) : null;
  useEffect((): void => {
    void fetchInventory();
    // selectionsKey intentionally captures the structural identity.
  }, [fetchInventory, selectionsKey, options.ownerKey]);

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

  useEffect(() => {
    const attempt = localAttempt.current;
    if (
      attempt &&
      state.initialized &&
      !state.loading &&
      state.error === null &&
      !state.servers.some((server) => server.key === attempt.key)
    ) {
      stopAttempt(false);
      // Removing it from the selections is the user's own doing; vanishing
      // from the same selections leaves the attempt unfinished, so say so.
      if (state.selectionKey === attempt.selectionKey)
        setState((previous) => ({
          ...previous,
          error: TARGET_UNAVAILABLE_MESSAGE,
        }));
    }
  }, [state, stopAttempt]);

  // Clearing the selections removes every server, but the empty inventory is
  // never initialized, so the check above can't see it. End the attempt here
  // so a later selection doesn't inherit its stale wait.
  useEffect(() => {
    if (selectionsKey === null) stopAttempt(false);
  }, [selectionsKey, stopAttempt]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetchInventory();
  }, [fetchInventory]);

  const connect = useCallback(
    async (
      server: DetectedMcpServerInfo,
      options?: { readonly signInRequired: boolean },
    ): Promise<boolean> => {
      // A tools request can require auth even when initialize was open.
      // Health may request sign-in without rewriting the cached requirement.
      const signInRequired =
        options?.signInRequired === true &&
        server.enabled &&
        server.type === 'http' &&
        server.httpAuthHandler === 'canopy' &&
        server.serverId !== undefined &&
        server.configId !== undefined;
      if (
        !server.enabled ||
        (!server.canConnect && !signInRequired) ||
        localAttempt.current !== null
      ) {
        return false;
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
        return false;
      }

      const attempt: LocalAttempt = {
        key: server.key,
        owner: ownerRef.current,
        selectionKey: selectionsRef.current
          ? JSON.stringify(selectionsRef.current)
          : null,
        cancelled: false,
        cancelFlow: false,
      };
      localAttempt.current = attempt;
      setConnectingKey(server.key);
      setState((prev) => ({ ...prev, error: null }));
      try {
        if (isCurrentRef.current && !(await isCurrentRef.current()))
          return false;
        if (!validAttempt(attempt)) return false;
        const response = await window.mcpServers.startOAuthLogin({
          ...request,
          force: signInRequired,
        });
        attempt.flowId = response.flowId;
        if (!validAttempt(attempt)) {
          if (attempt.cancelFlow && response.flowId)
            await window.mcpServers.cancelOAuthLogin(response.flowId);
          return false;
        }
        setSignInUrl(response.authorizationUrl);
        setAwaitingAuthorization(response.status === 'started');
        // No flow ran, so the row either holds a valid token or needs no
        // sign-in. Neither says the server is reachable.
        const finishedWithoutFlow =
          response.status === 'completed' && response.flowId === undefined;
        if (response.status === 'completed') {
          const inventory = await fetchInventory();
          if (!validAttempt(attempt)) return false;
          if (!inventory && inventoryFailure.current !== null)
            throw new Error('Couldn’t refresh sign-in status. Try again.');
          if (inventory) {
            const current = findMatchingServer(inventory, server);
            if (!current) throw new Error(TARGET_UNAVAILABLE_MESSAGE);
            if (
              current.authStatus === 'connected' ||
              (finishedWithoutFlow && isNoAuthCompletion(server, current))
            )
              return true;
          }
        }
        // A launch/completed acknowledgement is not proof of connection.
        return await pollUntilOAuthCompletes(
          server,
          attempt,
          finishedWithoutFlow,
          signInRequired && response.status === 'started',
        );
      } catch (err: unknown) {
        if (attempt.flowId)
          void window.mcpServers
            .cancelOAuthLogin(attempt.flowId)
            .catch(() => undefined);
        const message =
          err instanceof Error && err.message.length > 0
            ? extractIpcErrorMessage(err)
            : DEFAULT_LOGIN_FAILED_MESSAGE;
        if (validAttempt(attempt))
          setState((prev) => ({ ...prev, error: message }));
        return false;
      } finally {
        if (localAttempt.current === attempt) {
          localAttempt.current = null;
          if (mounted.current) {
            setConnectingKey(null);
            setSignInUrl(undefined);
            setAwaitingAuthorization(false);
          }
        }
      }
    },
    [fetchInventory, pollUntilOAuthCompletes, validAttempt],
  );

  const connectOnDevice = useCallback(
    async (
      key: string,
      accepted: ChatTabPluginSelections,
      stillCurrent?: () => boolean,
    ): Promise<void> => {
      const owner = ownerRef.current;
      const response = await window.mcpServers.listDetected({
        selections: accepted,
      });
      if (
        !mounted.current ||
        ownerRef.current !== owner ||
        stillCurrent?.() === false
      )
        return;
      const server = response.servers.find((entry) => entry.key === key);
      if (
        !server ||
        server.httpAuthHandler !== 'canopy' ||
        (!server.canConnect && server.authStatus !== 'connected')
      )
        throw new Error('This MCP server cannot sign in on this desktop.');
      selectionsRef.current = accepted;
      setState({
        ownerKey: owner,
        selectionKey: JSON.stringify(accepted),
        initialized: true,
        servers: response.servers,
        warnings: response.warnings,
        loading: false,
        error: null,
      });
      if (server.authStatus !== 'connected') await connect(server);
    },
    [connect],
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

      const owner = ownerRef.current;
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
          if ((await callback(next)) === false)
            throw new Error(DEFAULT_PROXY_TOGGLE_FAILED_MESSAGE);
          if (!mounted.current || ownerRef.current !== owner) return;
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

  const hasSelections = selections !== null;
  const initializing =
    hasSelections &&
    (!state.initialized ||
      state.selectionKey !== selectionsKey ||
      state.ownerKey !== (options.ownerKey ?? 'default'));
  return useMemo(
    (): UseDetectedMcpServersResult => ({
      servers: !hasSelections || initializing ? [] : state.servers,
      warnings: !hasSelections || initializing ? [] : state.warnings,
      loading: hasSelections && (state.loading || initializing),
      initializing,
      error: !hasSelections || initializing ? null : state.error,
      connectingKey,
      proxyUpdatingKey,
      refresh,
      connect,
      connectOnDevice,
      cancelConnect,
      signInUrl,
      awaitingAuthorization,
      setCanopyProxyEnabled,
    }),
    [
      hasSelections,
      state.servers,
      state.warnings,
      state.loading,
      initializing,
      state.error,
      connectingKey,
      proxyUpdatingKey,
      refresh,
      connect,
      connectOnDevice,
      cancelConnect,
      signInUrl,
      awaitingAuthorization,
      setCanopyProxyEnabled,
    ],
  );
}
