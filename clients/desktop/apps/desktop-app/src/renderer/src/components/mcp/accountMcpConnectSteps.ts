import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import {
  curatedMcpDesktopOnly,
  curatedMcpProviderOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import {
  mcpClientSetupCollectsClient,
  mcpClientSetupExplanation,
  mcpConnectErrorMessage,
} from '@canopy/ui-shared/lib';
import {
  MCP_PROVIDER_CONNECTOR_LABELS,
  mcpProviderOnlyGuidance,
} from '@canopy/ui-app/capability';

/** The connection fields the connect flow reads. */
export type AccountMcpStepConnection = Pick<
  AccountMcpConnection,
  'id' | 'serverKey' | 'configId' | 'displayName' | 'kind' | 'authMode'
>;

/** Who a credential prompt connects: a connection, or a catalog server without one. */
export interface AccountMcpCredentialTarget {
  id: string;
  serverKey: string;
  configId: string;
  displayName: string;
}

export function accountMcpCredentialTarget(
  connection: AccountMcpStepConnection,
): AccountMcpCredentialTarget {
  return {
    id: connection.id,
    serverKey: connection.serverKey,
    configId: connection.configId,
    displayName: connection.displayName,
  };
}

interface AccountMcpSetupStep {
  kind: 'setup';
  entry: CuratedMcpServerEntry;
  configId: string;
}

interface AccountMcpStartStep {
  kind: 'connect';
  serverKey: string;
  configId: string;
}

/** What Connect does for an account server row. */
export type AccountMcpConnectStep<C extends AccountMcpStepConnection> =
  | { kind: 'unavailable' }
  | AccountMcpSetupStep
  | { kind: 'credential'; connection: C }
  | AccountMcpStartStep;

/**
 * A catalog server without a connection: its setup dialog when it has fields
 * or an endpoint list, otherwise a straight start, under `configId`.
 */
export function accountMcpCatalogConnectStep(
  entry: CuratedMcpServerEntry,
  configId = 'default',
): AccountMcpSetupStep | AccountMcpStartStep {
  return entry.requiredConfigFields?.length || entry.urlOptions?.length
    ? { kind: 'setup', entry, configId }
    : { kind: 'connect', serverKey: entry.key, configId };
}

/**
 * Connect or Reconnect for an account server, shared by Customize's MCP
 * servers and the Home sign-in strip: setup for a catalog server that needs
 * fields or an endpoint choice, a fresh token for a custom bearer connection,
 * and otherwise a start by server key. A connection keeps its own
 * configuration; without one the start uses `configId`, the selected
 * configuration, or `default`.
 */
export function accountMcpConnectStep<C extends AccountMcpStepConnection>({
  entry,
  connection,
  curatedKey,
  configId: selectedConfigId,
}: {
  entry?: CuratedMcpServerEntry;
  connection?: C;
  curatedKey?: string;
  configId?: string;
}): AccountMcpConnectStep<C> {
  const configId = connection?.configId ?? selectedConfigId ?? 'default';
  // The account broker cannot connect a desktop-only server: a provider-only
  // connector, or one the catalog marks desktop only (a device server
  // connects that one; see `curatedMcpAddTarget`).
  if (entry && curatedMcpDesktopOnly(entry)) return { kind: 'unavailable' };
  if (
    entry &&
    (entry.requiredConfigFields?.length || (entry.urlOptions?.length ?? 0) > 1)
  )
    return { kind: 'setup', entry, configId };
  if (entry && !connection)
    return accountMcpCatalogConnectStep(entry, configId);
  if (connection?.kind === 'CUSTOM' && connection.authMode === 'BEARER')
    return { kind: 'credential', connection };
  const serverKey = connection?.serverKey ?? curatedKey;
  if (!serverKey) return { kind: 'unavailable' };
  return { kind: 'connect', serverKey, configId };
}

/**
 * The catalog entry to ask an endpoint for after the cloud refused a start
 * with `endpoint_required`. The cloud only refuses when it has several
 * endpoints to choose from, so a held entry with fewer is stale and the
 * catalog is read again before giving up.
 */
export async function accountMcpEndpointEntry(
  serverKey: string,
  entries: readonly CuratedMcpServerEntry[],
  refreshCatalog: () => Promise<readonly CuratedMcpServerEntry[]>,
): Promise<CuratedMcpServerEntry | undefined> {
  const endpointsOf = (
    list: readonly CuratedMcpServerEntry[],
    minimum: number,
  ): CuratedMcpServerEntry | undefined =>
    list.find(
      (entry): boolean =>
        entry.key === serverKey && (entry.urlOptions?.length ?? 0) >= minimum,
    );
  return endpointsOf(entries, 2) ?? endpointsOf(await refreshCatalog(), 1);
}

/**
 * What an `unavailable` connect step tells the user. A provider connector
 * (Gmail, Google Drive) signs in through the user's Claude or Codex account,
 * so the sentence names what to connect first instead of doing nothing. A
 * server the catalog marks desktop only (REG-3035) cannot sign in through the
 * cloud account but does as a server on this device, so it points there.
 */
export function accountMcpUnavailableMessage(
  entry: CuratedMcpServerEntry | undefined,
): string {
  if (entry?.availability === 'desktop' && !curatedMcpProviderOnly(entry))
    return `Add ${entry.name} as a server on this device to connect it.`;
  if (!entry) return "This server can't be connected from here.";
  return mcpProviderOnlyGuidance(
    entry.name,
    (entry.providerConnector?.providers ?? []).map(
      (provider): string => MCP_PROVIDER_CONNECTOR_LABELS[provider],
    ),
  );
}

/** What a sign-in that needed no browser tells the user. */
export function mcpAlreadyConnectedMessage(serverName: string): string {
  return `${serverName} is already connected.`;
}

/** A finished Connect on a server without sign-in; never claims it connected. */
export function mcpNoSignInNeededMessage(serverName: string): string {
  return `${serverName} doesn't need sign-in.`;
}

/** How to answer `client_credentials_required`. */
export type AccountMcpClientPromptStep<C extends AccountMcpStepConnection> =
  | { kind: 'error'; message: string }
  | { kind: 'token'; target: AccountMcpCredentialTarget; intro: string }
  | {
      kind: 'setup';
      entry: CuratedMcpServerEntry;
      configId: string;
      clientSetup?: AccountMcpClientSetup;
      endpointUrl?: string;
    }
  | { kind: 'client'; connection: C; clientSetup?: AccountMcpClientSetup };

/**
 * The server registers no OAuth clients itself. A secret the cloud can't
 * store leaves an access token as the way in; otherwise the user's own app is
 * collected, in the catalog setup dialog (on the endpoint the attempt used)
 * or a custom connection's prompt.
 */
export function accountMcpClientPromptStep<C extends AccountMcpStepConnection>({
  entry,
  connection,
  configId,
  clientSetup,
  endpointUrl,
}: {
  entry?: CuratedMcpServerEntry;
  connection?: C;
  configId: string;
  clientSetup?: AccountMcpClientSetup;
  endpointUrl?: string;
}): AccountMcpClientPromptStep<C> {
  const target: AccountMcpCredentialTarget | undefined = connection
    ? accountMcpCredentialTarget(connection)
    : entry
      ? {
          id: `curated:${entry.key}`,
          serverKey: entry.key,
          configId,
          displayName: entry.name,
        }
      : undefined;
  if (!target)
    return {
      kind: 'error',
      message: mcpConnectErrorMessage('client_credentials_required'),
    };
  if (clientSetup && !mcpClientSetupCollectsClient(clientSetup))
    return {
      kind: 'token',
      target,
      intro: mcpClientSetupExplanation(
        entry?.name ?? target.displayName,
        clientSetup,
      ),
    };
  if (entry && connection?.kind !== 'CUSTOM')
    return {
      kind: 'setup',
      entry,
      configId,
      ...(clientSetup ? { clientSetup } : {}),
      ...(endpointUrl ? { endpointUrl } : {}),
    };
  if (connection)
    return {
      kind: 'client',
      connection,
      ...(clientSetup ? { clientSetup } : {}),
    };
  return {
    kind: 'error',
    message: mcpConnectErrorMessage('client_credentials_required'),
  };
}
