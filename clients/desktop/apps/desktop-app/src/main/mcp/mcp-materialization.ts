import { readFile } from 'node:fs/promises';
import { catalogSha256 } from '@canopy/core-runtime/node/catalog';
import {
  mcpServerEntryId,
  type CatalogMaterializationMcpServerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import { isStoredSecretValue } from '@canopy/execution-engine/types/stored-secrets';
import { isAccountMcpConnectionEnabled } from '@canopy/protocol/mcp-servers';
import { accountMcpIndexEntry } from '@canopy/ui-app/capability/accountMcpRows';
import { accountMcpConnectionUnusableReason } from '../canopy-cloud/mcp-connection-usable';
import { getMcpServerFilePath, getMcpServersIndexFilePath } from '../lib/paths';
import {
  classifyIndexDocument,
  classifyServerDocument,
  readDocument,
  requireMutableState,
} from './config-repository-format';
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  projectMcpServerData,
} from './server-secret-view';

export interface DescribedMcpServer {
  readonly descriptor: CatalogMaterializationMcpServerDescriptor;
  readonly displayName: string;
  /** The config summary's `enabled` flag from the index. */
  readonly enabled: boolean;
  /** Before redemption: `{ binding, index, server }`, where `server` holds the projected definition and the one config (stored-secret references, no values), or null for an account binding. */
  readonly pinned: Readonly<Record<string, unknown>>;
  /** Why an enabled account connection cannot be used right now (CAN-5871). */
  readonly unusableReason?: string;
}

/** The account connection list could not be read for an account-only selection (CAN-5871). */
export class AccountMcpConnectionsUnavailableError extends Error {
  constructor() {
    super('Account MCP connections could not be read.');
    this.name = 'AccountMcpConnectionsUnavailableError';
  }
}

/** The descriptor's revision: 'sha256:' + hex(sha256(stableStringify({ version: 1, binding, index, server }))). */
export function mcpServerConfigRevision(input: {
  binding: 'device' | 'account';
  index: Readonly<Record<string, unknown>>;
  server: Readonly<Record<string, unknown>> | null;
}): string {
  return catalogSha256({
    version: 1,
    binding: input.binding,
    index: input.index,
    server: input.server,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a projected server, passing every stored-secret reference through
 * `map`. The OAuth client secret (CAN-4126) is left as its reference.
 */
function mapStoredSecrets(
  value: unknown,
  map: (ref: string) => unknown,
  path: readonly string[] = [],
): unknown {
  if (isStoredSecretValue(value))
    return path.join('/') === MCP_OAUTH_CLIENT_SECRET_SLOT
      ? value
      : map(value.ref);
  if (Array.isArray(value))
    return value.map((item, index) =>
      mapStoredSecrets(item, map, [...path, String(index)]),
    );
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      mapStoredSecrets(item, map, [...path, key]),
    ]),
  );
}

/**
 * An account connection described from the cloud account list, through the
 * lookup the plugin resolver uses (CAN-5871). The index entry is the one the
 * UI builds from the connection, so the revision follows CAN-4125 D10 and
 * changes with anything the cloud reports about the connection.
 */
function describeAccountMcpConnection(
  ref: { serverId: string; configId: string },
  connection: AccountMcpConnection,
): DescribedMcpServer {
  const entry = accountMcpIndexEntry(connection);
  const index = {
    ...entry,
    configs: entry.configs.filter((config) => config.id === ref.configId),
  };
  const enabled = isAccountMcpConnectionEnabled(connection);
  const unusableReason = enabled
    ? accountMcpConnectionUnusableReason(connection)
    : null;
  return {
    descriptor: {
      kind: 'mcp_server',
      entryId: mcpServerEntryId(ref),
      serverId: ref.serverId,
      configId: ref.configId,
      transport: 'http',
      binding: 'account',
      configRevision: mcpServerConfigRevision({
        binding: 'account',
        index,
        server: null,
      }),
      secretRefs: [],
    },
    displayName: connection.displayName,
    enabled,
    pinned: { binding: 'account', index, server: null },
    ...(unusableReason === null ? {} : { unusableReason }),
  };
}

/**
 * Strict, read-only description of one selected server configuration
 * (CAN-4125 D9, D10). Reads the index, and for a device binding the server
 * file, through classifyIndexDocument and classifyServerDocument with
 * requireMutableState. Legacy and custom account refs, and refs with no index
 * entry, are described from the account connection list (CAN-5871). Null when
 * the server or config is absent; throws McpConfigStateError on damaged state
 * and AccountMcpConnectionsUnavailableError when the account list cannot be
 * read. Writes nothing.
 */
export async function describeMcpServerForMaterialization(
  ref: { serverId: string; configId: string },
  deps: {
    readFile?: (path: string) => Promise<string>;
    loadAccountConnections?: () => Promise<AccountMcpConnection[] | null>;
  } = {},
): Promise<DescribedMcpServer | null> {
  const read =
    deps.readFile ??
    ((path: string): Promise<string> => readFile(path, 'utf8'));
  // With account connections turned off there are none to describe.
  const loadAccountConnections =
    deps.loadAccountConnections ??
    (async (): Promise<AccountMcpConnection[] | null> => {
      const catalog = await import('./account-catalog');
      return catalog.accountMcpConnectionsEnabled()
        ? catalog.loadAccountMcpRefConnections()
        : [];
    });
  const fromAccount = async (): Promise<DescribedMcpServer | null> => {
    const connections = await loadAccountConnections();
    if (connections === null) throw new AccountMcpConnectionsUnavailableError();
    const connection = accountMcpConnectionForRef(ref, connections);
    return connection === undefined
      ? null
      : describeAccountMcpConnection(ref, connection);
  };
  if (
    legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
    isCustomAccountMcpServerKey(ref.serverId)
  )
    return fromAccount();
  const indexDocument = requireMutableState(
    'index',
    classifyIndexDocument(
      await readDocument(() => read(getMcpServersIndexFilePath())),
    ),
  );
  const entry = indexDocument?.index.servers.find(
    (candidate) => candidate.id === ref.serverId,
  );
  if (entry === undefined) return fromAccount();
  const summary = entry.configs.find((config) => config.id === ref.configId);
  if (summary === undefined) return null;
  const binding = entry.scope === 'account' ? 'account' : 'device';
  const index = { ...entry, configs: [summary] };
  let server: Readonly<Record<string, unknown>> | null = null;
  let type = entry.type;
  if (binding === 'device') {
    const serverDocument = requireMutableState(
      'server',
      classifyServerDocument(
        await readDocument(() => read(getMcpServerFilePath(ref.serverId))),
        ref.serverId,
      ),
    );
    const projected =
      serverDocument === undefined
        ? undefined
        : projectMcpServerData(serverDocument.file.server);
    const config = projected?.configs.find(
      (candidate) => candidate.id === ref.configId,
    );
    if (projected === undefined || config === undefined) return null;
    server = { definition: projected.definition, config };
    type = projected.definition.type;
  }
  const secretRefs = new Set<string>();
  mapStoredSecrets(server, (secretRef) => secretRefs.add(secretRef));
  return {
    descriptor: {
      kind: 'mcp_server',
      entryId: mcpServerEntryId(ref),
      serverId: ref.serverId,
      configId: ref.configId,
      transport: type === 'command' ? 'stdio' : 'http',
      binding,
      configRevision: mcpServerConfigRevision({ binding, index, server }),
      secretRefs: [...secretRefs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    },
    displayName: entry.name,
    enabled: summary.enabled,
    pinned: { binding, index, server },
  };
}

/** Replaces each stored-secret reference in a pinned record by its value; the OAuth client secret stays a reference. Throws when a reference has no value. */
export function pinMcpServerSecrets(
  pinned: Readonly<Record<string, unknown>>,
  values: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  return {
    ...pinned,
    server: mapStoredSecrets(pinned.server, (ref) => {
      const value = values.get(ref);
      if (value === undefined)
        throw new Error('An MCP server secret was not redeemed.');
      return value;
    }),
  };
}
