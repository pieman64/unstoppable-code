import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed standalone MCP servers.
 *
 * On-disk paths (`apps/desktop-app/src/main/lib/paths.ts`):
 *   - `mcp-servers/index.json`            (`McpServersIndexFile`)
 *   - `mcp-servers/server-<id>.json`      (`McpServerFile`, one per server)
 *
 * Shapes (`packages/execution-engine/src/types/mcp-servers.ts`):
 *   McpServersIndexFile = { version: 1, servers: McpServerIndexEntry[] }
 *   McpServerFile       = { version: 1, server: McpServerData }
 *   McpServerData       = { definition: McpServerDefinitionData,
 *                           configs: McpServerConfigData[] }
 *
 * The IPC handler (`apps/desktop-app/src/main/ipc/mcp-servers.ts`) reads the
 * index only when `version === 1` and `servers` is an array, reads each
 * server file only when `version === 1` and `server` is present, and derives
 * each index entry from the server via `toIndexEntry`. This seeder mirrors
 * `toIndexEntry` so the index and per-server files stay consistent.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {import('@canopy/execution-engine/types/mcp-servers').McpServerData[]} options.servers
 * @returns {{
 *   indexFilePath: string,
 *   serverFilePaths: Record<string, string>,
 *   index: import('@canopy/execution-engine/types/mcp-servers').McpServersIndexFile,
 * }}
 */
export function seedMcpServers(options) {
  const { userDataDir, servers = [] } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedMcpServers requires userDataDir');
  }
  if (!Array.isArray(servers)) {
    throw new Error('seedMcpServers requires a servers array');
  }

  const mcpDir = path.join(userDataDir, 'mcp-servers');

  /** @type {Record<string, string>} */
  const serverFilePaths = {};
  for (const server of servers) {
    const id = server?.definition?.id;
    if (!id) {
      throw new Error('seedMcpServers: each server requires definition.id');
    }
    const serverFilePath = path.join(mcpDir, `server-${id}.json`);
    writeJson(serverFilePath, { version: 1, server });
    serverFilePaths[id] = serverFilePath;
  }

  const index = {
    version: 1,
    servers: servers.map((server) => toIndexEntry(server)),
  };
  const indexFilePath = path.join(mcpDir, 'index.json');
  writeJson(indexFilePath, index);

  return { indexFilePath, serverFilePaths, index };
}

// Mirrors `toIndexEntry` in apps/desktop-app/src/main/ipc/mcp-servers.ts so the
// seeded index matches what the app would write for the same server.
function toIndexEntry(server) {
  return {
    id: server.definition.id,
    name: server.definition.name,
    description: server.definition.description,
    type: server.definition.type,
    configs: (server.configs ?? []).map((config) => ({
      id: config.id,
      name: config.name,
      enabled: config.enabled,
    })),
    ...(server.definition.curated?.logoUrl
      ? { logoUrl: server.definition.curated.logoUrl }
      : {}),
    ...(server.definition.curated?.key
      ? { curatedKey: server.definition.curated.key }
      : {}),
    ...urlIndexFields(server.definition),
    updatedAt: server.definition.updatedAt,
  };
}

// Mirrors toIndexEntry: only the host and scheme, never a path or credentials.
function urlIndexFields(definition) {
  if (definition.type !== 'http' || !definition.url) return {};
  let parsed;
  try {
    parsed = new URL(definition.url);
  } catch {
    return {};
  }
  if (!parsed.hostname) return {};
  return {
    urlHost: parsed.hostname,
    urlScheme: parsed.protocol.replace(/:$/, ''),
  };
}
