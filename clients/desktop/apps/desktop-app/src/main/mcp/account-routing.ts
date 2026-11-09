import { readFile } from 'node:fs/promises';
import type {
  McpServerIndexEntry,
  McpServerDefinitionData,
  McpServerConfigData,
} from '@canopy/execution-engine/types/mcp-servers';
import { getMcpServersIndexFilePath } from '../lib/paths';
import { resolveAccountMcpProxyTarget } from '../canopy-cloud/mcp-connections';
import type { McpHttpProxyServiceForResolver } from '../plugins/plugin-resolver';

/** The index is the owner of scope and account binding, not the definition. */
export async function readMcpAccountIndexEntry(
  serverId: string,
): Promise<
  | Pick<McpServerIndexEntry, 'scope' | 'authHandler' | 'accountConnectionId'>
  | undefined
> {
  try {
    const value: unknown = JSON.parse(
      await readFile(getMcpServersIndexFilePath(), 'utf8'),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('servers' in value) ||
      !Array.isArray(value.servers)
    )
      return undefined;
    const entry: unknown = value.servers.find(
      (row: unknown): boolean =>
        row !== null &&
        typeof row === 'object' &&
        'id' in row &&
        row.id === serverId,
    );
    if (!entry || typeof entry !== 'object') return undefined;
    return {
      ...('scope' in entry &&
      (entry.scope === 'account' || entry.scope === 'device')
        ? { scope: entry.scope }
        : {}),
      ...('authHandler' in entry &&
      (entry.authHandler === 'account' ||
        entry.authHandler === 'canopy' ||
        entry.authHandler === 'provider')
        ? { authHandler: entry.authHandler }
        : {}),
      ...('accountConnectionId' in entry &&
      typeof entry.accountConnectionId === 'string'
        ? { accountConnectionId: entry.accountConnectionId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function pluginMcpCuratedKey(
  raw: Record<string, unknown>,
): string | undefined {
  const curated = raw.curated;
  return curated &&
    typeof curated === 'object' &&
    'key' in curated &&
    typeof curated.key === 'string'
    ? curated.key
    : undefined;
}

/**
 * Register a temporary route for discovery/health and always dispose it. An
 * account row has no device definition, so it names its connection directly.
 */
export async function withAccountMcpProxy<T>(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
  proxy: McpHttpProxyServiceForResolver,
  port: number,
  run: (definition: McpServerDefinitionData) => Promise<T>,
  accountConnectionId?: string,
): Promise<T> {
  const { upstreamUrl } = await resolveAccountMcpProxyTarget({
    curatedKey: definition.curated?.key,
    accountConnectionId:
      accountConnectionId ??
      (await readMcpAccountIndexEntry(definition.id))?.accountConnectionId,
    configId: config.id,
  });
  await proxy.ensureStarted(port);
  const routeId = await proxy.registerRoute({
    sessionId: null,
    serverId: definition.id,
    configId: config.id,
    displayName: definition.name,
    upstreamUrl,
    headers: {},
    oauthEnabled: false,
    authSupplier: 'canopy-cloud',
  });
  try {
    return await run({
      ...definition,
      url: proxy.getProxyUrl(routeId),
      headers: undefined,
      oauth: undefined,
    });
  } finally {
    proxy.unregisterRoute(routeId);
  }
}
