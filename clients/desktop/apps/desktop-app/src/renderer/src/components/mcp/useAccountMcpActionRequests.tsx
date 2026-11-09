import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  AccountMcpConnection,
  McpServerIndexEntry,
  McpServersIndexFile,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  accountMcpRowKey,
  accountMcpConnectionKey,
  accountMcpConfigurationKey,
  type AccountMcpErrorOperation,
} from '@/hooks/useAccountMcpActions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  ACCOUNT_MCP_ACTION_EVENT,
  isAccountMcpActionEventDetail,
  type AccountMcpActionEventDetail,
} from '@/lib/accountMcpEvents';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import {
  accountMcpEditableCopy,
  customizeInForeground,
  resolveAccountMcpAction,
  type AccountMcpConnectTarget,
} from './accountMcpActionRequests';
import {
  accountMcpConnectStep,
  accountMcpUnavailableMessage,
} from './accountMcpConnectSteps';
import { loadSignedInAccountId } from './mcpManagementOperations';
import {
  useAccountMcpSignIn,
  type AccountMcpSignInTarget,
} from './useAccountMcpSignIn';
import { useMcpPromotion } from './useMcpPromotion';

const SIGN_IN_UNDERWAY = 'Finish the current sign-in first.';
const CATALOG_LOADING =
  'The server catalog is still loading. Try again in a moment.';
const CATALOG_FAILED = "Couldn't load the server catalog. Try again.";

/**
 * Whether a Connect started. Accepted means the request was taken, not that
 * the sign-in finished; a later failure appears in the hook's error. Blocked
 * is temporary, and never licenses another path to the same sign-in.
 */
export type AccountMcpStartResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly message: string };

/** A row's sign-in in progress, and how to cancel exactly that one. */
export interface AccountMcpRowPending {
  readonly key: string;
  readonly cancel: () => void;
}

/** What an MCP detail reads from the page's sign-in for its own connection. */
export interface AccountMcpDetailSignIn {
  readonly start: (connection: AccountMcpConnection) => AccountMcpStartResult;
  readonly isPending: (targetKey: string) => boolean;
  readonly isConnectingConnection: (
    connection: AccountMcpConnection,
  ) => boolean;
  readonly cancel: (targetKey: string) => void;
  /** The failure of this target's action, never another connection or device. */
  readonly errorFor: (targetKey: string) => string | null;
  readonly errorOperationFor: (
    targetKey: string,
  ) => AccountMcpErrorOperation | null;
  /** Clears prior action errors on the page and its matching open detail. */
  readonly clearError: (targetKey: string) => void;
  readonly registerErrorClearer: (
    targetKey: string,
    clear: () => void,
  ) => () => void;
  /**
   * The detail's retained actions instance reports the keys it is signing in,
   * so the page never starts a second flow on the same connection.
   */
  readonly reportDetailPending: (keys: ReadonlySet<string>) => void;
}

export interface AccountMcpActionRequests {
  readonly connectRow: (row: McpServerIndexEntry) => AccountMcpStartResult;
  readonly pendingOf: (
    row: McpServerIndexEntry,
  ) => AccountMcpRowPending | undefined;
  readonly detailSignIn: AccountMcpDetailSignIn;
  readonly error: string | null;
  /** The cloud's code behind {@link error}, only while that error shows. */
  readonly errorCode: string | null;
  /** The sign-in and promotion dialogs; render once. */
  readonly dialogs: JSX.Element | null;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * Owns Orchestrator's account MCP actions and the page's account sign-ins for
 * Customize. An action is taken only while the person can see the surface it
 * acts on; each event gets at most one synchronous acknowledgement or refusal,
 * and that answer means the request was accepted, not that remote work ended.
 * Hiding Customize stops new requests and leaves accepted ones running; losing
 * the account or the flag invalidates them.
 */
export function useAccountMcpActionRequests({
  servers,
  curatedEntries,
  statuses,
  loading,
  accountConnectionsAvailable,
  accountConnectionsUnavailableReason,
  refresh,
  mcpSurfaceInForeground,
  detailRowId,
  openDeviceEditor,
  openCloudEditor,
  clearSurfaceError,
}: {
  servers: readonly McpServerIndexEntry[];
  curatedEntries: readonly CuratedMcpServerEntry[];
  statuses: readonly McpServerStatusEntry[];
  loading: boolean;
  accountConnectionsAvailable: boolean | undefined;
  accountConnectionsUnavailableReason: McpServersIndexFile['accountConnectionsUnavailableReason'];
  refresh: () => Promise<void>;
  /** The open detail, or the active tab without one, is the MCP surface. */
  mcpSurfaceInForeground: boolean;
  detailRowId: string | null;
  openDeviceEditor: (serverId: string) => void;
  openCloudEditor: (connection: AccountMcpConnection) => void;
  clearSurfaceError?: () => void;
}): AccountMcpActionRequests {
  const flagEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const enabled = flagEnabled && accountConnectionsAvailable === true;
  // A failed inventory read blocks new requests, but does not end accepted
  // work or discard credentials already entered under this account.
  const canObserve =
    flagEnabled && accountConnectionsUnavailableReason !== 'sign-in-required';
  const signIn = useAccountMcpSignIn(refresh, { enabled });
  const promotion = useMcpPromotion(signIn.actions, refresh);

  const pageInForeground = customizeInForeground({
    activePage: useNavigationStore((state) => state.activePage),
    settingsOpen: useNavigationStore((state) => state.settingsOpen),
    coversMainShell: useSidebarPageHandoffStore(
      (state) => state.coversMainShell,
    ),
  });
  const visible = pageInForeground && mcpSurfaceInForeground;

  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect((): void => {
    if (accountConnectionsAvailable === true) setRefusal(null);
  }, [accountConnectionsAvailable]);
  const [failure, setFailure] = useState<{
    readonly key: string;
    readonly message: string;
    readonly operation: AccountMcpErrorOperation;
  } | null>(null);
  // Taken synchronously, so two events in one tick cannot start two flows.
  const reserved = useRef(new Set<string>());
  const [reservedKeys, setReservedKeys] =
    useState<ReadonlySet<string>>(EMPTY_KEYS);
  const disconnecting = useRef(new Set<string>());
  const disconnectingKeys = useRef(new Map<string, string>());
  const cancelling = useRef(new Map<string, string>());
  const requestGeneration = useRef(0);
  const detailPending = useRef<ReadonlySet<string>>(EMPTY_KEYS);
  const detailErrorClearers = useRef(new Map<string, () => void>());
  const registerErrorClearer = useCallback(
    (key: string, clear: () => void): (() => void) => {
      detailErrorClearers.current.set(key, clear);
      return (): void => {
        if (detailErrorClearers.current.get(key) === clear)
          detailErrorClearers.current.delete(key);
      };
    },
    [],
  );
  const providerHandled = (serverId: string): boolean =>
    statuses.find((status): boolean => status.serverId === serverId)
      ?.handler === 'provider';

  const unavailableMessage =
    accountConnectionsUnavailableReason === 'unavailable'
      ? 'Account MCP connections are unavailable.'
      : 'Sign in to see account connections';

  const clearErrors = (key?: string): void => {
    clearSurfaceError?.();
    setRefusal(null);
    setFailure(null);
    promotion.clearError();
    signIn.clearError();
    if (key) detailErrorClearers.current.get(key)?.();
    else detailErrorClearers.current.forEach((clear): void => clear());
  };
  const cancel = (key: string): void => {
    clearErrors(key);
    const connection = servers.find(
      (row): boolean =>
        row.accountConnection !== undefined &&
        accountMcpConnectionKey(row.accountConnection) === key,
    )?.accountConnection;
    signIn.cancel(pendingKeyFor(key), connection?.id);
  };
  const pendingKeyFor = (key: string): string => {
    const connection = servers.find(
      (row): boolean =>
        row.accountConnection !== undefined &&
        accountMcpConnectionKey(row.accountConnection) === key,
    )?.accountConnection;
    return (
      (connection
        ? signIn.actions.pendingKeyForConnection(connection)
        : undefined) ?? key
    );
  };

  const reserve = (key: string): void => {
    reserved.current.add(key);
    setReservedKeys(new Set(reserved.current));
  };
  const release = (key: string): void => {
    reserved.current.delete(key);
    setReservedKeys(new Set(reserved.current));
  };
  const isPending = (key: string): boolean =>
    signIn.pending.has(pendingKeyFor(key)) ||
    reserved.current.has(pendingKeyFor(key)) ||
    promotion.isPending(key) ||
    Array.from(disconnectingKeys.current.values()).includes(key) ||
    detailPending.current.has(key);
  // A flow past its start shows in `pending` and can overlap another server's.
  // One still choosing its dialog cannot: a second start would supersede it.
  const startingAnother = (): boolean =>
    signIn.setupOpen ||
    Array.from(reserved.current).some(
      (key): boolean => !signIn.pending.has(key),
    );

  const startSignIn = (
    target: AccountMcpSignInTarget,
    key: string,
    entry: CuratedMcpServerEntry | undefined,
  ): AccountMcpStartResult => {
    // The sign-in's catalog read is off here, so a setup step would be skipped.
    if (!enabled) return { kind: 'unsupported', message: unavailableMessage };
    if (target.connection?.status === 'PENDING' || isPending(key))
      return { kind: 'blocked', reason: SIGN_IN_UNDERWAY };
    if (signIn.waitsForCatalog(target)) {
      if (signIn.catalogFailed) {
        signIn.retryCatalog();
        return { kind: 'blocked', reason: CATALOG_FAILED };
      }
      return { kind: 'blocked', reason: CATALOG_LOADING };
    }
    if (
      accountMcpConnectStep({
        ...(entry ? { entry } : {}),
        ...(target.connection ? { connection: target.connection } : {}),
        ...(target.curatedKey ? { curatedKey: target.curatedKey } : {}),
      }).kind === 'unavailable'
    )
      return {
        kind: 'unsupported',
        message: accountMcpUnavailableMessage(entry),
      };
    if (startingAnother()) return { kind: 'blocked', reason: SIGN_IN_UNDERWAY };
    reserve(key);
    const generation = requestGeneration.current;
    clearErrors(key);
    signIn.connect(target, {
      pendingKey: key,
      onSettled: (outcome): void => {
        if (generation !== requestGeneration.current) return;
        release(key);
        if (outcome.kind === 'failed' && outcome.message !== null)
          setFailure({ key, message: outcome.message, operation: 'connect' });
      },
    });
    return { kind: 'accepted' };
  };

  const startTarget = (
    target: AccountMcpConnectTarget,
  ): AccountMcpStartResult => {
    const { row, entry } = target;
    if (!row)
      return startSignIn(
        { curatedKey: entry.key },
        accountMcpConfigurationKey(entry.key),
        entry,
      );
    const connection = row.accountConnection;
    const key = accountMcpRowKey(row);
    if (!key)
      return {
        kind: 'unsupported',
        message: accountMcpUnavailableMessage(entry),
      };
    return startSignIn(
      {
        ...(connection ? { connection } : {}),
        ...(row.curatedKey ? { curatedKey: row.curatedKey } : {}),
      },
      key,
      entry,
    );
  };

  const entryOf = (
    key: string | undefined,
  ): CuratedMcpServerEntry | undefined =>
    curatedEntries.find((catalog): boolean => catalog.key === key);

  const connectRow = (row: McpServerIndexEntry): AccountMcpStartResult => {
    const entry = entryOf(row.curatedKey ?? row.accountConnection?.serverKey);
    return startTarget({ row, ...(entry ? { entry } : {}) });
  };

  const startConnection = (
    connection: AccountMcpConnection,
  ): AccountMcpStartResult => {
    const row = servers.find(
      (candidate): boolean => candidate.accountConnection?.id === connection.id,
    );
    return startSignIn(
      {
        connection,
        ...(row?.curatedKey ? { curatedKey: row.curatedKey } : {}),
      },
      accountMcpConnectionKey(connection),
      entryOf(connection.serverKey),
    );
  };

  const openEditor = (row: McpServerIndexEntry): void => {
    const copy = accountMcpEditableCopy(row);
    if (copy) openDeviceEditor(copy.id);
    else if (row.accountConnection) openCloudEditor(row.accountConnection);
  };

  const refuse = (
    detail: AccountMcpActionEventDetail,
    message: string,
  ): void => {
    setRefusal(message);
    detail.refuse?.(message);
  };

  const disconnect = (connectionId: string): void => {
    if (disconnecting.current.has(connectionId)) return;
    const generation = requestGeneration.current;
    disconnecting.current.add(connectionId);
    const key = accountMcpConnectionKey({ id: connectionId });
    clearErrors(key);
    if (key) disconnectingKeys.current.set(connectionId, key);
    void signIn.actions
      .disconnect(connectionId, (message): void => {
        if (key && generation === requestGeneration.current)
          setFailure({ key, message, operation: 'disconnect' });
      })
      .finally((): void => {
        if (generation === requestGeneration.current) {
          disconnecting.current.delete(connectionId);
          disconnectingKeys.current.delete(connectionId);
        }
      });
  };

  const handleEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!isAccountMcpActionEventDetail(detail)) return;
    // Read at dispatch: an action can follow a navigation before any render.
    const navigation = useNavigationStore.getState();
    const foreground = customizeInForeground({
      activePage: navigation.activePage,
      settingsOpen: navigation.settingsOpen,
      coversMainShell: useSidebarPageHandoffStore.getState().coversMainShell,
    });
    if (!flagEnabled || !foreground || !mcpSurfaceInForeground) return;
    if (accountConnectionsAvailable === false) {
      refuse(detail, unavailableMessage);
      return;
    }
    if (accountConnectionsAvailable !== true || loading) return;
    const resolution = resolveAccountMcpAction({
      operation: detail.operation,
      serverId: detail.serverId,
      servers,
      curatedEntries,
      providerHandled,
    });
    switch (resolution.kind) {
      case 'ignore':
        return;
      case 'refuse':
        refuse(detail, resolution.message);
        return;
      case 'edit':
        clearErrors(accountMcpRowKey(resolution.row) ?? resolution.row.id);
        openEditor(resolution.row);
        detail.acknowledge();
        return;
      case 'disconnect': {
        const { connectionId } = resolution;
        const targetKey = accountMcpConnectionKey({ id: connectionId });
        if (
          disconnecting.current.has(connectionId) ||
          detailPending.current.has(targetKey)
        )
          return;
        const connection = servers.find(
          (row): boolean => row.accountConnection?.id === connectionId,
        )?.accountConnection;
        // Only its own flow may be cancelled; another configuration stays live.
        const flowKey = connection
          ? signIn.actions.pendingKeyForConnection(connection)
          : undefined;
        if (flowKey) {
          disconnecting.current.add(connectionId);
          disconnectingKeys.current.set(connectionId, targetKey);
          cancelling.current.set(flowKey, connectionId);
          cancel(targetKey);
        } else {
          // An unsubmitted setup must not reconnect a credential just revoked.
          if (reserved.current.has(targetKey)) cancel(targetKey);
          disconnect(connectionId);
        }
        detail.acknowledge();
        return;
      }
      case 'promote':
        if (isPending(resolution.row.id) || !promotion.request(resolution.row))
          return;
        clearErrors(resolution.row.id);
        detail.acknowledge();
        return;
      case 'connect': {
        const result = startTarget(resolution.target);
        if (result.kind === 'accepted') detail.acknowledge();
        else if (result.kind === 'unsupported') refuse(detail, result.message);
        return;
      }
    }
  };
  // One subscription for the page's life, always answering with fresh data.
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  useEffect((): (() => void) => {
    const listener = (event: Event): void => handleEventRef.current(event);
    window.addEventListener(ACCOUNT_MCP_ACTION_EVENT, listener);
    return (): void =>
      window.removeEventListener(ACCOUNT_MCP_ACTION_EVENT, listener);
  }, []);

  // Nothing started under an account or a flag outlives it.
  const invalidateRef = useRef((): void => undefined);
  invalidateRef.current = (): void => {
    requestGeneration.current += 1;
    signIn.stopObserving();
    promotion.invalidate();
    reserved.current.clear();
    disconnecting.current.clear();
    disconnectingKeys.current.clear();
    cancelling.current.clear();
    detailPending.current = EMPTY_KEYS;
    setReservedKeys(EMPTY_KEYS);
    clearErrors();
  };
  // Unmount removes the request listener, but accepted promotions still need
  // their onConnected step to remove the device's copy of the token.
  useEffect((): void => {
    for (const [key, id] of cancelling.current) {
      const revokeFailed =
        signIn.actions.errorOperation === 'disconnect' &&
        signIn.actions.errorKey === accountMcpConnectionKey({ id });
      if (
        !revokeFailed &&
        (signIn.pending.has(key) || reserved.current.has(key))
      )
        continue;
      cancelling.current.delete(key);
      disconnecting.current.delete(id);
      disconnectingKeys.current.delete(id);
    }
  }, [
    signIn.pending,
    reservedKeys,
    signIn.actions.errorOperation,
    signIn.actions.errorKey,
  ]);
  const wasObserving = useRef(canObserve);
  useEffect((): void => {
    if (wasObserving.current && !canObserve) invalidateRef.current();
    wasObserving.current = canObserve;
  }, [canObserve]);
  useEffect((): (() => void) | undefined => {
    if (!canObserve) return undefined;
    let current = true;
    let known: string | undefined;
    let initialized = false;
    let readGeneration = 0;
    const read = (authChanged = false): void => {
      const generation = ++readGeneration;
      if (authChanged && !initialized) invalidateRef.current();
      void loadSignedInAccountId().then((accountId): void => {
        if (!current || generation !== readGeneration) return;
        if (initialized && accountId !== known) invalidateRef.current();
        known = accountId;
        initialized = true;
      });
    };
    read();
    const unsubscribe = window.mcpServers?.onAuthChanged?.((): void =>
      read(true),
    );
    return (): void => {
      current = false;
      unsubscribe?.();
    };
  }, [canObserve]);

  useCurrentUiStateReporter(
    'mcp.accountConnections.plugins',
    flagEnabled && visible
      ? {
          available: accountConnectionsAvailable === true,
          loading,
          setupOpen: signIn.setupOpen || promotion.tokenPromptOpen,
          detailsOpen: detailRowId !== null,
          promoteDialogOpen: promotion.dialogOpen,
          detailsRowId: detailRowId,
          pendingCount: signIn.actions.pendingCount,
          rows: servers.slice(0, 50).map((row) => ({
            id: row.accountConnection?.id ?? row.id,
            serverKey:
              row.accountConnection?.serverKey ?? row.curatedKey ?? null,
            status: row.accountConnection?.status ?? null,
          })),
        }
      : null,
  );

  // Rows and details read these through stable callbacks that change only with
  // the pending set, so an unrelated page render does not rebuild every row.
  const pageIsPending = (key: string): boolean =>
    signIn.pending.has(pendingKeyFor(key)) ||
    reserved.current.has(pendingKeyFor(key)) ||
    Array.from(disconnectingKeys.current.values()).includes(key) ||
    promotion.isPending(key);
  const latest = useRef({
    connectRow,
    startConnection,
    cancel,
    clearErrors,
    disconnect,
    isPending: pageIsPending,
  });
  latest.current = {
    connectRow,
    startConnection,
    cancel,
    clearErrors,
    disconnect,
    isPending: pageIsPending,
  };
  const stableConnectRow = useCallback(
    (row: McpServerIndexEntry): AccountMcpStartResult =>
      latest.current.connectRow(row),
    [],
  );
  const pendingKeys = signIn.pending;
  const pendingKeyForConnection = signIn.actions.pendingKeyForConnection;
  const pendingOf = useCallback(
    (row: McpServerIndexEntry): AccountMcpRowPending | undefined => {
      const key = accountMcpRowKey(row);
      const connection = row.accountConnection;
      const flowKey = connection
        ? pendingKeyForConnection(connection)
        : undefined;
      if (key && flowKey)
        return { key, cancel: (): void => latest.current.cancel(key) };
      if (key && (pendingKeys.has(key) || reservedKeys.has(key)))
        return { key, cancel: (): void => latest.current.cancel(key) };
      // A sign-in this page did not start has no flow here to cancel.
      return key && connection?.status === 'PENDING'
        ? { key, cancel: (): void => latest.current.disconnect(connection.id) }
        : undefined;
    },
    [pendingKeys, reservedKeys, pendingKeyForConnection],
  );
  const reportDetailPending = useCallback((keys: ReadonlySet<string>): void => {
    detailPending.current = keys;
  }, []);
  const promotionErrorFor = promotion.errorFor;
  const actionErrorFor = signIn.actions.errorFor;
  const actionErrorOperation = signIn.actions.errorOperation;
  const isConnectingConnection = signIn.actions.isConnectingConnection;
  const configurationKeyFor = (targetKey: string): string => {
    const connection = servers.find(
      (row): boolean =>
        row.accountConnection !== undefined &&
        accountMcpConnectionKey(row.accountConnection) === targetKey,
    )?.accountConnection;
    return connection
      ? accountMcpConfigurationKey(connection.serverKey, connection.configId)
      : targetKey;
  };
  const detailSignIn = useMemo(
    (): AccountMcpDetailSignIn => ({
      start: (connection): AccountMcpStartResult =>
        latest.current.startConnection(connection),
      isPending: (targetKey): boolean => latest.current.isPending(targetKey),
      isConnectingConnection,
      cancel: (targetKey): void => latest.current.cancel(targetKey),
      clearError: (targetKey): void => latest.current.clearErrors(targetKey),
      registerErrorClearer,
      errorFor: (targetKey): string | null =>
        failure?.key === targetKey ||
        failure?.key === configurationKeyFor(targetKey)
          ? failure.message
          : (promotionErrorFor(targetKey) ??
            actionErrorFor(targetKey) ??
            actionErrorFor(configurationKeyFor(targetKey))),
      errorOperationFor: (targetKey): AccountMcpErrorOperation | null =>
        failure?.key === targetKey ||
        failure?.key === configurationKeyFor(targetKey)
          ? failure.operation
          : promotionErrorFor(targetKey)
            ? 'promote'
            : actionErrorFor(targetKey) !== null ||
                actionErrorFor(configurationKeyFor(targetKey)) !== null
              ? actionErrorOperation
              : null,
      reportDetailPending,
    }),
    [
      failure,
      configurationKeyFor,
      actionErrorFor,
      isConnectingConnection,
      actionErrorOperation,
      pendingKeys,
      promotionErrorFor,
      reportDetailPending,
      reservedKeys,
      registerErrorClearer,
    ],
  );

  const shownError = refusal ?? promotion.error ?? signIn.error;
  return {
    connectRow: stableConnectRow,
    pendingOf,
    detailSignIn,
    error: shownError,
    errorCode:
      refusal === null && promotion.error === null ? signIn.errorCode : null,
    // Hidden beneath another page, a dialog would float over it.
    dialogs: pageInForeground ? (
      <>
        {signIn.dialogs}
        {promotion.dialogs}
      </>
    ) : null,
  };
}
