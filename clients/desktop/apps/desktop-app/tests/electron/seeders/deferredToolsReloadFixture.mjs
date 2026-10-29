import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedMcpServers } from './seedMcpServers.mjs';

const MCP_SERVER_ID = 'dr';
const MCP_CONFIG_ID = 'd';

// Must match buildManagedMcpServerName({ kind: 'dynamic', friendlyParts:
// ['Deferred Reload Fixture'], identityParts: [MCP_SERVER_ID, MCP_CONFIG_ID] }).
export const DEFERRED_ECHO_TOOL_NAME =
  'mcp__appdyn-deferred-reload-fixture--4413e6b1dd9abc47__deferred_echo';

export function seedDeferredEchoServer(userDataDir) {
  const fixtureDir = path.join(userDataDir, 'mcp-fixtures');
  mkdirSync(fixtureDir, { recursive: true });
  const logPath = path.join(fixtureDir, 'deferred-echo-calls.log');
  const scriptPath = path.join(fixtureDir, 'deferred-echo-mcp.cjs');

  writeFileSync(
    scriptPath,
    `
const { appendFileSync } = require('node:fs');

let buffer = '';

function send(message) {
  process.stdout.write(\`\${JSON.stringify(message)}\\n\`);
}

async function handle(message) {
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deferred-reload-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'deferred_echo',
          description: 'Echoes text after deferred loading enables this MCP server.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              delayMs: { type: 'number' },
            },
            required: ['message'],
          },
        }],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {};
    const delayMs = Math.max(0, Math.min(Number(args.delayMs) || 0, 20000));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    appendFileSync(process.env.DEFERRED_RELOAD_MCP_LOG, \`called: \${args.message}\\n\`);
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: \`deferred echo: \${args.message}\` }],
        isError: false,
      },
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: \`Unknown method: \${message.method}\` },
  });
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    handle(frame).catch((error) => {
      if (Object.prototype.hasOwnProperty.call(frame, 'id')) {
        send({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32603, message: error?.message ?? String(error) },
        });
      }
    });
  }
});
`,
    'utf8',
  );

  const now = '2026-07-14T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: MCP_SERVER_ID,
          name: 'Deferred Reload Fixture',
          description:
            'Fixture MCP server used to verify deferred tool reload resumes with new capabilities.',
          type: 'command',
          command: process.execPath,
          args: [scriptPath],
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: MCP_CONFIG_ID,
            name: 'Default',
            description: '',
            enabled: true,
            envVars: { DEFERRED_RELOAD_MCP_LOG: logPath },
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  return { logPath };
}
