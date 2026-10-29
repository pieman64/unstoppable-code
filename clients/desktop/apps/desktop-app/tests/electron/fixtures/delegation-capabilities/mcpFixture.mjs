// Minimal single-tool HTTP MCP fixture server for
// `managed-delegation-capabilities.spec.mjs`, modeled on
// `startAgentCapabilityMcpFixture` in `managed-delegation.spec.mjs` but pared
// down to exactly the one tool each capability case needs.
import { createServer } from 'node:http';
import { seedMcpServers } from '../../seeders/index.mjs';

/**
 * Start an HTTP MCP server exposing exactly one tool (`toolName`) that
 * returns `evidence` as its text result on every `tools/call`, and records
 * every call it receives (so a test can assert the child actually invoked
 * it, not just that the tool was offered).
 */
export async function startCapabilityMcpFixture({
  toolName,
  evidence,
  serverName = 'delegation-capability-fixture',
}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = raw ? JSON.parse(raw) : null;
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!message || !('id' in message)) {
      response.writeHead(204).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          {
            name: toolName,
            description:
              'Fixture tool for managed-delegation capability tests.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    } else if (message.method === 'tools/call') {
      calls.push({ ...message.params });
      result = { content: [{ type: 'text', text: evidence }] };
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Seed a single HTTP MCP server with one enabled `default` config. */
export function seedCapabilityMcpServer({
  userDataDir,
  serverId,
  name,
  origin,
}) {
  const now = '2026-09-26T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: serverId,
          name,
          description: name,
          type: 'http',
          url: origin,
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
}
