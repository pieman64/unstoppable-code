import {
  ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED,
  ACCOUNT_MCP_ENDPOINT_REQUIRED,
  ACCOUNT_MCP_SIGN_IN_UNAVAILABLE,
  type AccountMcpClientSetup,
  type AccountMcpOAuthClientCredentials,
} from '@canopy/protocol/mcp-servers';
import { customAccountMcpPromotable } from '@canopy/ui-app/capability';
import {
  mcpConnectErrorMessage,
  mcpSignInUnavailableMessage,
} from '@canopy/ui-shared/lib';
import { useRef, useState } from 'react';
import {
  AccountMcpConnectionError,
  type AccountMcpConnectionErrorCode,
  type AccountMcpConnectionErrorDetails,
} from '@canopy/desktop-shared/types/mcp-servers';
import type {
  AccountMcpConnectionSummary,
  AccountMcpSecretSource,
  McpServerIndexEntry,
  StartAccountMcpConnectionRequest,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { SecretValueInput } from '@canopy/desktop-shared/types/stored-secrets';

interface PendingConnection {
  /** Settles after cancellation rollback and owned-key release. */
  readonly done: Promise<void>;
  id?: string;
  cancelled: boolean;
  observing: boolean;
  /** Shared cleanup barrier for both cancellation paths. */
  releasePromise?: Promise<void>;
}
export interface AccountMcpConnectOptions {
  /** Text, or a device server's saved token named by `secretSource`. */
  bearerToken?: SecretValueInput;
  endpointUrl?: string;
  oauthClient?: AccountMcpOAuthClientCredentials;
  /** Account the credentials were captured under; see McpServersTab. */
  expectedAccountId?: string;
  /** Creates a custom connection for this HTTPS URL instead of a server key. */
  customUrl?: string;
  displayName?: string;
  /** Extra upstream headers stored with a new custom connection. */
  headers?: Record<string, SecretValueInput>;
  /** The device server whose saved secrets the request keeps. */
  secretSource?: AccountMcpSecretSource;
  /** Pending-flow key; defaults to the server key, then the custom URL. */
  pendingKey?: string;
  /** Receives the message for a recognized failure the caller shows itself. */
  onFailure?: (message: string) => void;
  /**
   * The server registers no OAuth clients itself: the caller collects the
   * user's own app and retries. `clientSetup` is absent from older clouds.
   * Without this callback the refusal is reported like any other failure.
   */
  onOAuthClientRequired?: (clientSetup?: AccountMcpClientSetup) => void;
  /**
   * The server has several endpoints and the start named none the cloud
   * could keep (`endpoint_required`): the caller asks which one and retries.
   * Without this callback the refusal is reported like any other failure.
   */
  onEndpointRequired?: () => void;
  /**
   * Runs once the connection exists, before any browser sign-in settles. If it
   * throws, the new connection is disconnected before the failure surfaces.
   */
  onStarted?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /**
   * Undoes `onStarted` when the flow is cancelled after it resolved. Runs
   * before the connection is disconnected; its failures are swallowed.
   */
  onCancelled?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /** Runs once the connection reports connected, after any browser sign-in. */
  onConnected?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /**
   * Answers a browser sign-in with its one-shot page instead of opening the
   * default browser. Only a local window may ask; see `startAccountConnection`.
   */
  browser?: 'embedded';
  /**
   * Runs once a browser sign-in is waiting, with the embedded page when
   * {@link browser} asked for one. Never persist or log that URL.
   */
  onAuthorizing?: (embeddedUrl: string | undefined) => void;
  /**
   * Runs exactly once with how this call ended. `recovering` hands the flow
   * to {@link onOAuthClientRequired} or {@link onEndpointRequired}.
   */
  onOutcome?: (outcome: AccountMcpConnectOutcome) => void;
}
export type AccountMcpConnectOutcome =
  | { kind: 'connected'; connection: AccountMcpConnectionSummary }
  | { kind: 'cancelled' }
  | { kind: 'recovering' }
  | { kind: 'failed'; message: string | null };
export interface AccountMcpActions {
  /** Stops UI observation without disconnecting or removing credentials. */
  stopObserving: () => void;
  pending: ReadonlySet<string>;
  error: string | null;
  /** The cloud's code behind {@link error}, kept out of the sentence. */
  errorCode: string | null;
  connect: (
    serverKey?: string,
    configId?: string,
    options?: AccountMcpConnectOptions,
  ) => Promise<AccountMcpConnectionErrorCode | undefined>;
  cancel: (serverKey: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

export function accountMcpRowKey(row: McpServerIndexEntry): string | undefined {
  return (
    row.accountConnection?.serverKey ??
    row.curatedKey ??
    (customAccountMcpPromotable(row) ? row.id : undefined)
  );
}

/**
 * A missing OAuth client or endpoint is recoverable: a caller that collects
 * it retries, so the refusal is handed to it rather than shown as a failure.
 * Without such a caller it is a failure like any other.
 */
function startRecovery(
  code: AccountMcpConnectionErrorCode | undefined,
  details: AccountMcpConnectionErrorDetails,
  options: AccountMcpConnectOptions,
): (() => void) | undefined {
  const { onOAuthClientRequired, onEndpointRequired } = options;
  if (code === 'oauth-client-required' && onOAuthClientRequired)
    return (): void => onOAuthClientRequired(details.clientSetup);
  if (
    code === 'connect-refused' &&
    details.serverCode === ACCOUNT_MCP_ENDPOINT_REQUIRED &&
    onEndpointRequired
  )
    return onEndpointRequired;
  return undefined;
}

export function useAccountMcpActions(
  refresh: () => Promise<void>,
): AccountMcpActions {
  const flows = useRef(new Map<string, PendingConnection>());
  const observationRevision = useRef(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<{
    message: string;
    code: string | null;
  } | null>(null);
  const setError = (message: string | null, code: string | null = null): void =>
    setFailure(message === null ? null : { message, code });
  const updatePending = (): void => setPending(new Set(flows.current.keys()));
  const disconnect = async (id: string): Promise<void> => {
    setError(null);
    try {
      await window.mcpServers.disconnectAccountConnection(id);
      await refresh();
    } catch {
      setError('Could not disconnect. Try again.');
    }
  };
  // Sends a flow's disconnect at most once, whichever of cancel and the
  // connect flow reaches it first.
  const release = async (flow: PendingConnection): Promise<void> => {
    if (!flow.id) return;
    flow.releasePromise ??= window.mcpServers
      .disconnectAccountConnection(flow.id)
      .catch((): void => {
        // A cancel or the caller's own failure is what the flow reports.
      });
    await flow.releasePromise;
  };
  const connect = async (
    serverKey?: string,
    configId = 'default',
    options: AccountMcpConnectOptions = {},
  ): Promise<AccountMcpConnectionErrorCode | undefined> => {
    const revision = observationRevision.current;
    const key = options.pendingKey ?? serverKey ?? options.customUrl;
    let outcome: AccountMcpConnectOutcome | null = null;

    const report = (next: AccountMcpConnectOutcome): void => {
      if (outcome || flow.observing === false) return;
      outcome = next;
      options.onOutcome?.(next);
    };
    // Retry may be activated before the old polling call has observed Cancel.
    // Finish its disconnect before another start can own the same connection.
    const previous = key ? flows.current.get(key) : undefined;
    if (previous?.cancelled) await previous.done;
    if (revision !== observationRevision.current) return undefined;
    if (!key || (!serverKey && !options.customUrl) || flows.current.has(key)) {
      options.onOutcome?.({ kind: 'failed', message: null });
      return undefined;
    }
    let finish: () => void = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const flow: PendingConnection = { cancelled: false, observing: true, done };
    // Every key this flow is registered under; a row can change key mid-flow.
    const keys = [key];
    flows.current.set(key, flow);
    updatePending();
    setError(null);
    let started: AccountMcpConnectionSummary | undefined;
    // A cancelled flow unbinds whatever onStarted bound before the connection
    // goes, so nothing is left routed to a disconnected connection.
    const rollBack = async (): Promise<undefined> => {
      if (started) {
        try {
          await options.onCancelled?.(started);
        } catch {
          // The connection still goes; the row keeps what it could.
        }
      }
      await release(flow);
      return undefined;
    };
    try {
      // Bind any credential in this request to the account it was captured
      // under (the dialog's account when one was open, else the account the
      // panel shows). A sign-in change in between is refused here, before any
      // secret leaves the renderer; main repeats the check as defense in depth.
      const currentAccountId = (await window.api?.loadCanopyCloudAccount?.())
        ?.account?.id;
      if (
        options.expectedAccountId !== undefined &&
        options.expectedAccountId !== currentAccountId
      )
        throw new AccountMcpConnectionError('account-changed');
      if (!flow.observing) return undefined;
      const expectedAccountId = options.expectedAccountId ?? currentAccountId;
      const credentials = {
        configId,
        ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
        ...(options.secretSource ? { secretSource: options.secretSource } : {}),
        ...(options.oauthClient ? { oauthClient: options.oauthClient } : {}),
        ...(expectedAccountId ? { expectedAccountId } : {}),
        ...(options.browser ? { browser: options.browser } : {}),
      };
      const customUrl = serverKey ? undefined : options.customUrl;
      // A browser sign-in answers with only its URL, and a new custom
      // connection's key is minted by the cloud, so the new row is found by
      // diffing the account's connections around the start.
      const knownIds = customUrl
        ? new Set(
            (await window.mcpServers.listAccountConnections()).map(
              (connection): string => connection.id,
            ),
          )
        : undefined;
      const request: StartAccountMcpConnectionRequest = serverKey
        ? {
            serverKey,
            ...(options.endpointUrl
              ? { endpointUrl: options.endpointUrl }
              : {}),
            ...credentials,
          }
        : {
            customUrl: customUrl ?? '',
            ...(options.displayName
              ? { displayName: options.displayName }
              : {}),
            ...(options.headers && Object.keys(options.headers).length > 0
              ? { headers: options.headers }
              : {}),
            ...credentials,
          };
      if (!flow.observing) return undefined;
      const result = await window.mcpServers.startAccountConnection(request);
      if (!flow.observing) return undefined;
      if ('error' in result)
        throw new AccountMcpConnectionError(
          result.error.code,
          result.error.header,
          {
            ...(result.error.clientSetup
              ? { clientSetup: result.error.clientSetup }
              : {}),
            ...(result.error.serverCode
              ? { serverCode: result.error.serverCode }
              : {}),
            ...(result.error.desktopSignIn !== undefined
              ? { desktopSignIn: result.error.desktopSignIn }
              : {}),
          },
        );
      let connection: AccountMcpConnectionSummary | undefined;
      if ('connection' in result) connection = result.connection;
      else if (knownIds) {
        const created = (
          await window.mcpServers.listAccountConnections()
        ).filter(
          (candidate): boolean =>
            candidate.kind === 'CUSTOM' && !knownIds.has(candidate.id),
        );
        connection =
          created.find(
            (candidate): boolean =>
              candidate.displayName === options.displayName,
          ) ?? (created.length === 1 ? created[0] : undefined);
      } else {
        const index = await window.mcpServers.loadIndex();
        connection = index.servers.find(
          (row): boolean =>
            row.accountConnection?.serverKey === serverKey &&
            row.accountConnection?.configId === configId,
        )?.accountConnection;
      }
      if (!flow.observing) return undefined;
      if (!connection) throw new Error('Pending connection unavailable.');
      if ('authorizationUrl' in result && !flow.cancelled)
        options.onAuthorizing?.(result.embeddedUrl);
      flow.id = connection.id;
      // Once bound, the row renders under the connection's key (see
      // accountMcpRowKey), so its Cancel must reach this same flow there too.
      if (!flows.current.has(connection.serverKey)) {
        flows.current.set(connection.serverKey, flow);
        keys.push(connection.serverKey);
        updatePending();
      }
      // Cancelled before the connection was known: bind nothing to it.
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      try {
        await options.onStarted?.(connection);
      } catch (startedError) {
        // Nothing is bound to the new connection; drop it so a retry does not
        // leave another one behind. The caller's failure is what is reported.
        await release(flow);
        throw startedError;
      }
      started = connection;
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      await refresh();
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      const settled =
        connection.status === 'PENDING'
          ? await window.mcpServers.awaitAccountConnection(connection.id)
          : connection;
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      if ('error' in settled)
        throw new AccountMcpConnectionError(
          settled.error.code,
          settled.error.header,
          settled.error.serverCode
            ? { serverCode: settled.error.serverCode }
            : {},
        );
      if (settled.status !== 'CONNECTED') {
        setError('Connection needs attention. Connect again.');
        report({
          kind: 'failed',
          message: 'Connection needs attention. Connect again.',
        });
        return undefined;
      }
      await options.onConnected?.(settled);
      report({ kind: 'connected', connection: settled });
      return undefined;
    } catch (error) {
      if (!flow.observing) return undefined;
      if (flow.cancelled) await rollBack();
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      const header =
        error instanceof AccountMcpConnectionError ? error.header : undefined;
      const details =
        error instanceof AccountMcpConnectionError ? error.details : {};
      const known: AccountMcpConnectionErrorCode | undefined =
        code === 'connection-timeout' ||
        code === 'account-changed' ||
        code === 'oauth-client-required' ||
        code === 'connection-limit-reached' ||
        code === 'invalid-headers' ||
        code === 'connect-refused'
          ? code
          : undefined;
      const recover = startRecovery(known, details, options);
      if (recover) {
        if (flow.cancelled) report({ kind: 'cancelled' });
        else {
          report({ kind: 'recovering' });
          recover();
        }
        return known;
      }
      const serverCode =
        known === 'oauth-client-required'
          ? ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED
          : details.serverCode;
      // The account can't sign in to this server; it never asks for an
      // OAuth app, and says when adding it to this device signs in instead.
      const message =
        known === 'connect-refused' &&
        serverCode === ACCOUNT_MCP_SIGN_IN_UNAVAILABLE
          ? mcpSignInUnavailableMessage(
              details.desktopSignIn === true,
              'desktop',
            )
          : known === 'connect-refused' || known === 'oauth-client-required'
            ? mcpConnectErrorMessage(serverCode)
            : known
              ? new AccountMcpConnectionError(known, header).message
              : 'Could not connect. Try again.';
      if (known) options.onFailure?.(message);
      if (!flow.cancelled) setError(message, serverCode ?? null);
      report(
        flow.cancelled ? { kind: 'cancelled' } : { kind: 'failed', message },
      );
      return known;
    } finally {
      // Every early return above that ends a cancelled flow lands here.
      report(
        flow.cancelled
          ? { kind: 'cancelled' }
          : { kind: 'failed', message: null },
      );
      // Keep Retry behind the actual disconnect, including when polling
      // settles independently while cancellation is still in flight.
      await flow.releasePromise;
      for (const registered of keys)
        if (flows.current.get(registered) === flow)
          flows.current.delete(registered);
      if (flow.observing) updatePending();
      finish();
      if (flow.observing) await refresh();
    }
  };
  const cancel = async (serverKey: string): Promise<void> => {
    const flow = flows.current.get(serverKey);
    if (!flow) return;
    flow.cancelled = true;
    if (!flow.id) return;
    flow.releasePromise ??= disconnect(flow.id);
    await flow.releasePromise;
  };
  const stopObserving = (): void => {
    observationRevision.current += 1;
    flows.current.forEach((flow): void => {
      flow.observing = false;
    });
    flows.current.clear();
    updatePending();
    setError(null);
  };
  return {
    stopObserving,
    pending,
    error: failure?.message ?? null,
    errorCode: failure?.code ?? null,
    connect,
    cancel,
    disconnect,
  };
}
