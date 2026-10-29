import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import { withAccountMcpInventory } from './account-catalog';
import {
  findAccountMcpConnection,
  type AccountMcpConnectionTarget,
} from '../canopy-cloud/mcp-connections';
import { isAccountMcpReauthRequired } from './account-route-status';
import { getMcpHttpAuthDefault } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { readFile } from 'node:fs/promises';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import type {
  McpHttpAuthHandler,
  McpServerAuthStatus,
  McpServerData,
  McpServerConfigSummary,
  McpServerHealthCheckResult,
  McpServerIndexEntry,
  McpServerStatusEntry,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/desktop-shared/types/mcp-servers';
import { getMcpOAuthAuthStatusForDefinition } from './oauth-token-store';
import { getMcpServerFilePath, getMcpServersIndexFilePath } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';

const endpointHealth = new Map<string, McpServerHealthCheckResult>();
const endpointHealthGenerations = new Map<string, number>();

export function getMcpServerHealthGeneration(serverId: string): number {
  return endpointHealthGenerations.get(serverId) ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfigSummary(value: unknown): value is McpServerConfigSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isIndexEntry(value: unknown): value is McpServerIndexEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.type === 'http' || value.type === 'command') &&
    Array.isArray(value.configs) &&
    value.configs.every(isConfigSummary) &&
    (value.logoUrl === undefined || typeof value.logoUrl === 'string') &&
    (value.curatedKey === undefined || typeof value.curatedKey === 'string') &&
    typeof value.updatedAt === 'string'
  );
}

export function recordMcpServerHealth(
  result: McpServerHealthCheckResult,
  expectedGeneration?: number,
): boolean {
  if (
    expectedGeneration !== undefined &&
    getMcpServerHealthGeneration(result.serverId) !== expectedGeneration
  ) {
    return false;
  }
  endpointHealth.set(result.serverId, result);
  return true;
}

export function clearMcpServerAuthHealthCache(serverIds: string[]): void {
  Array.from(new Set(serverIds)).forEach((id) => {
    endpointHealth.delete(id);
    endpointHealthGenerations.set(id, getMcpServerHealthGeneration(id) + 1);
  });
}

export function clearMcpServerHealthCache(): void {
  endpointHealth.clear();
  endpointHealthGenerations.clear();
}

export function getMcpServerHealth(
  serverId: string,
): McpServerHealthCheckResult | undefined {
  return endpointHealth.get(serverId);
}

async function readIndex(): Promise<McpServersIndexFile> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(getMcpServersIndexFilePath(), 'utf8'),
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.servers) ||
      !parsed.servers.every(isIndexEntry)
    ) {
      return { version: 1, servers: [] };
    }
    return { version: 1, servers: parsed.servers };
  } catch {
    return { version: 1, servers: [] };
  }
}

async function readServer(id: string): Promise<McpServerData | null> {
  try {
    const raw = await readFile(getMcpServerFilePath(id), 'utf8');
    const value: unknown = JSON.parse(raw);
    const parsed = normalizeMcpServerFile(value, id);
    return parsed.version === 1 && parsed.server ? parsed.server : null;
  } catch {
    return null;
  }
}

function reachabilityOf(
  health: McpServerHealthCheckResult | undefined,
): McpServerStatusEntry['reachability'] {
  if (!health) return 'unknown';
  return health.status === 'unhealthy' ? 'unreachable' : 'reachable';
}

function missingServerStatus(entry: McpServerIndexEntry): McpServerStatusEntry {
  const health = endpointHealth.get(entry.id);
  return {
    serverId: entry.id,
    transport: entry.type,
    connectionStatus:
      health?.status === 'unhealthy' ? 'unreachable' : 'unknown',
    reachability: reachabilityOf(health),
    configs: entry.configs.map((config) => ({
      configId: config.id,
      authStatus: entry.type === 'command' ? 'unsupported' : 'not_configured',
    })),
    ...(health ? { lastCheckedAt: health.checkedAt } : {}),
  };
}

export async function accountMcpAuthState(
  target: AccountMcpConnectionTarget & { serverId: string; configId: string },
): Promise<{ authStatus: McpServerAuthStatus; accountConnectionId?: string }> {
  try {
    const connection = await findAccountMcpConnection(target);
    // A route shared with the connection itself (REG-3033) is keyed by the
    // connection's server key and config, so a device row checks both.
    if (
      connection?.status === 'REAUTH_REQUIRED' ||
      (connection &&
        (isAccountMcpReauthRequired(
          target.serverId,
          target.configId,
          connection.routeId,
        ) ||
          isAccountMcpReauthRequired(
            connection.serverKey,
            connection.configId,
            connection.routeId,
          )))
    )
      return { authStatus: 'error', accountConnectionId: connection?.id };
    return {
      authStatus:
        connection?.status === 'CONNECTED' ? 'connected' : 'not_connected',
      accountConnectionId: connection?.id,
    };
  } catch {
    return { authStatus: 'not_connected' };
  }
}

async function authStatusForConfig(
  server: McpServerData,
  configId: string,
  enabled: boolean,
  handler: McpHttpAuthHandler,
  entry: McpServerIndexEntry,
): Promise<{
  authStatus: McpServerAuthStatus;
  canRefresh?: boolean;
  expiresAt?: string;
  authErrorRevision?: string;
  lastError?: string;
}> {
  if (server.definition.type === 'command') {
    return { authStatus: 'unsupported' };
  }
  if (!enabled || handler === 'provider') {
    return { authStatus: 'not_configured' };
  }
  if (handler === 'account')
    return {
      ...(await accountMcpAuthState({
        serverId: server.definition.id,
        configId,
        curatedKey: server.definition.curated?.key,
        accountConnectionId: entry.accountConnectionId,
      })),
    };
  const config = server.configs.find((candidate) => candidate.id === configId);
  if (!config) return { authStatus: 'not_configured' };
  if (config.authToken) return { authStatus: 'connected' };

  // Standard OAuth-discovery servers do not need an explicit `oauth` block in
  // their persisted definition. A successful login still leaves an
  // authoritative, upstream-bound token record that must drive status.
  const auth = await getMcpOAuthAuthStatusForDefinition(
    server.definition,
    config,
  );
  if (!server.definition.oauth && auth.hasStoredToken !== true) {
    return { authStatus: 'not_configured' };
  }
  return {
    authStatus: auth.status,
    ...(auth.canRefresh ? { canRefresh: true } : {}),
    ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
    ...(auth.lastError ? { lastError: auth.lastError } : {}),
    ...(auth.authErrorRevision
      ? { authErrorRevision: auth.authErrorRevision }
      : {}),
  };
}

async function buildStatus(
  entry: McpServerIndexEntry,
  server: McpServerData,
  globalHandler: McpHttpAuthHandler,
): Promise<McpServerStatusEntry> {
  const health = endpointHealth.get(entry.id);
  const reachability = reachabilityOf(health);
  if (server.definition.type === 'command') {
    return {
      serverId: entry.id,
      transport: 'command',
      connectionStatus:
        reachability === 'reachable'
          ? 'connected'
          : reachability === 'unreachable'
            ? 'unreachable'
            : 'unknown',
      reachability,
      configs: server.configs.map((config) => ({
        configId: config.id,
        authStatus: 'unsupported',
      })),
      ...(health ? { lastCheckedAt: health.checkedAt } : {}),
    };
  }

  const handler = getMcpHttpAuthDefault(
    server.definition,
    entry,
    globalHandler,
  );
  const handlerSource = server.definition.httpAuthHandler
    ? 'server'
    : 'default';
  const configs = await Promise.all(
    server.configs.map(async (config) => ({
      configId: config.id,
      ...(await authStatusForConfig(
        server,
        config.id,
        config.enabled,
        handler,
        entry,
      )),
    })),
  );
  const enabledIds = new Set(
    server.configs
      .filter((config) => config.enabled)
      .map((config) => config.id),
  );
  const enabledAuth = configs.filter((config) =>
    enabledIds.has(config.configId),
  );

  let connectionStatus: McpServerStatusEntry['connectionStatus'];
  // The handler discriminator keeps account recovery separate from local OAuth.
  if (handler === 'account') {
    connectionStatus =
      enabledAuth.length === 0
        ? 'unknown'
        : enabledAuth.every(
              (config): boolean => config.authStatus === 'connected',
            )
          ? 'connected'
          : 'auth_required';
  } else if (reachability === 'unreachable') {
    connectionStatus = 'unreachable';
  } else if (reachability === 'unknown') {
    connectionStatus = 'unknown';
  } else if (
    handler !== 'provider' &&
    health?.status === 'needs_auth' &&
    !enabledAuth.some(
      (config) => config.authStatus === 'expired' && config.canRefresh,
    )
  ) {
    connectionStatus = 'auth_required';
  } else if (handler === 'provider') {
    // Provider-managed auth is deliberately reachability-only. Canopy has no
    // local token/config verdict to layer over a successful direct probe.
    connectionStatus = 'connected';
  } else if (enabledAuth.length === 0) {
    connectionStatus = 'unknown';
  } else if (
    enabledAuth.some(
      (config) => config.authStatus === 'expired' && config.canRefresh,
    ) &&
    enabledAuth.every(
      (config) =>
        config.authStatus === 'connected' ||
        (config.authStatus === 'expired' && config.canRefresh),
    )
  ) {
    connectionStatus = 'unknown';
  } else if (
    enabledAuth.every((config) => config.authStatus === 'connected') ||
    (!server.definition.oauth &&
      health?.status === 'healthy' &&
      enabledAuth.every(
        (config) =>
          config.authStatus === 'not_configured' ||
          config.authStatus === 'connected',
      ))
  ) {
    connectionStatus = 'connected';
  } else {
    connectionStatus = 'auth_required';
  }

  return {
    serverId: entry.id,
    transport: 'http',
    connectionStatus,
    reachability,
    handler,
    handlerSource,
    configs,
    ...(health ? { lastCheckedAt: health.checkedAt } : {}),
  };
}

/** Derive one status entry per indexed server without network probing. */
export async function listMcpServerStatuses(): Promise<McpServerStatusEntry[]> {
  const [index, preferences] = await Promise.all([
    readIndex(),
    readPreferencesFile(),
  ]);
  const defaultHandler =
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER;
  const statuses: McpServerStatusEntry[] = [];
  const catalog = await withAccountMcpInventory(index);
  for (const entry of flattenMcpServerRows(catalog.servers)) {
    if (entry.accountConnection) {
      const state = await accountMcpAuthState({
        serverId: entry.id,
        configId: entry.accountConnection.configId,
        accountConnectionId: entry.accountConnection.id,
      });
      statuses.push({
        serverId: entry.id,
        transport: 'http',
        handler: 'account',
        handlerSource: 'server',
        connectionStatus:
          state.authStatus === 'connected' ? 'connected' : 'auth_required',
        reachability: 'unknown',
        configs: [
          {
            configId: entry.accountConnection.configId,
            authStatus: state.authStatus,
          },
        ],
      });
      continue;
    }
    const server = await readServer(entry.id);
    statuses.push(
      server
        ? await buildStatus(entry, server, defaultHandler)
        : missingServerStatus(entry),
    );
  }
  return statuses;
}

function normalizeServerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve an MCP server a shared skill names in its instructions to local
 * state. A skill writes the server as it appears in tool names
 * (`mcp__Linear_App__...`), not as a curated catalog id, so this matches the
 * server's id, name, or catalog key ignoring case and separators. A heuristic
 * by design: the result only ever informs a readiness warning.
 */
export async function getMcpServerStatusByName(
  name: string,
): Promise<McpServerStatusEntry | null> {
  const wanted = normalizeServerName(name);
  if (wanted.length === 0) return null;
  const [index, preferences] = await Promise.all([
    readIndex(),
    readPreferencesFile(),
  ]);
  const entry = index.servers.find((candidate) =>
    [candidate.id, candidate.name, candidate.curatedKey].some(
      (value) => value !== undefined && normalizeServerName(value) === wanted,
    ),
  );
  if (!entry) return null;
  const server = await readServer(entry.id);
  if (!server) return missingServerStatus(entry);
  return buildStatus(
    entry,
    server,
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
}

/** Resolve a package's portable curated catalog id to local MCP state. */
export async function getMcpServerStatusByCatalogId(
  catalogId: string,
): Promise<McpServerStatusEntry | null> {
  const [index, preferences] = await Promise.all([
    readIndex(),
    readPreferencesFile(),
  ]);
  const entry = index.servers.find(
    (candidate) =>
      candidate.curatedKey === catalogId || candidate.id === catalogId,
  );
  if (!entry) return null;
  const server = await readServer(entry.id);
  if (!server) return missingServerStatus(entry);
  return buildStatus(
    entry,
    server,
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
}
