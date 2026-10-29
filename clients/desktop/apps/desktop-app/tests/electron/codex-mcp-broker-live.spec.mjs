import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  initializeIsolatedCodexState,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'codex-mcp-broker-chat';
// Realistic long identities verify that app-generated compact names initialize
// successfully while this fixture continues to exercise plugin-relative cwd.
const MARKETPLACE_ID = 'wallaby-production-integrations-marketplace';
const PLUGIN_NAME = 'production-hub-integration-plugin-with-long-name';
const CONVERSATION_MARKER = 'Canopy-CCODEXBROKER';
const ASSISTANT_REPLY = 'Brokered Codex plugin initialized';

function readFilesText(root) {
  if (!existsSync(root)) return '';
  const chunks = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      chunks.push(readFilesText(entryPath));
    } else if (entry.isFile()) {
      chunks.push(readFileSync(entryPath, 'utf8'));
    }
  }
  return chunks.join('\n');
}

function findSyntheticHomeDirectories(root) {
  if (!existsSync(root)) return [];
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === '__codex-homes__' || entry.name === 'codex-home') {
      matches.push(entryPath);
      continue;
    }
    matches.push(...findSyntheticHomeDirectories(entryPath));
  }
  return matches;
}

function readBrokerRuntimeText() {
  return readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('canopy-codex-mcp-brokers-'),
    )
    .map((entry) => readFilesText(path.join(os.tmpdir(), entry.name)))
    .join('\n');
}

function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function seedSecretEchoServer(userDataDir, sentinel) {
  const fixtureDir = path.join(userDataDir, 'mcp-fixtures', PLUGIN_NAME);
  const scriptPath = path.join(fixtureDir, 'mcp', 'secret-echo-mcp.cjs');
  const logPath = path.join(fixtureDir, 'secret-echo-calls.log');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    `
const { appendFileSync } = require('node:fs');

let buffer = '';

function send(message) {
  process.stdout.write(\`\${JSON.stringify(message)}\\n\`);
}

function handle(message) {
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  if (message.method === 'initialize') {
    const secretPresent =
      typeof process.env.BROKER_SENTINEL_SECRET === 'string' &&
      process.env.BROKER_SENTINEL_SECRET.startsWith('codex-broker-secret-');
    appendFileSync(
      process.env.BROKER_MCP_LOG,
      \`\${secretPresent ? 'secret-present' : 'secret-missing'}:initialize\\n\`,
    );
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-broker-fixture', version: '1.0.0' },
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
          name: 'secret_echo',
          description: 'Echoes text only when the parent broker supplies its secret environment.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        }],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const secretPresent =
      typeof process.env.BROKER_SENTINEL_SECRET === 'string' &&
      process.env.BROKER_SENTINEL_SECRET.startsWith('codex-broker-secret-');
    appendFileSync(
      process.env.BROKER_MCP_LOG,
      \`\${secretPresent ? 'secret-present' : 'secret-missing'}:\${message.params?.arguments?.message ?? ''}\\n\`,
    );
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{
          type: 'text',
          text: secretPresent ? 'brokered echo succeeded' : 'broker secret missing',
        }],
        isError: !secretPresent,
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
    handle(JSON.parse(line));
  }
});
`,
    'utf8',
  );

  const now = '2026-07-24T00:00:00.000Z';
  mkdirSync(path.join(fixtureDir, '.codex-plugin'), { recursive: true });
  writeFileSync(
    path.join(fixtureDir, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: PLUGIN_NAME,
      version: '1.0.0',
      mcpServers: './.mcp.json',
    })}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(fixtureDir, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        broker: {
          command: 'node',
          args: ['./mcp/secret-echo-mcp.cjs'],
          cwd: '.',
          env: {
            BROKER_SENTINEL_SECRET: sentinel,
            BROKER_MCP_LOG: logPath,
          },
        },
      },
    })}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'plugins-cache.json'),
    `${JSON.stringify({
      version: 2,
      lastRefreshed: now,
      lastProviderRefreshAt: now,
      marketplaces: [
        {
          id: MARKETPLACE_ID,
          name: 'Broker Fixture Marketplace',
          description: '',
          sourceType: 'local',
          sourceUrl: '',
          installLocation: fixtureDir,
          lastUpdated: now,
          pluginCount: 1,
          validProviders: ['codex'],
          providerStatus: {
            claude: {
              provider: 'claude',
              state: 'invalid',
              accepted: false,
              pluginCount: 0,
              lastCheckedAt: now,
            },
            codex: {
              provider: 'codex',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              lastCheckedAt: now,
            },
          },
          plugins: [
            {
              name: PLUGIN_NAME,
              description: 'Relative-cwd MCP broker fixture',
              sourcePath: fixtureDir,
              marketplaceId: MARKETPLACE_ID,
              providerSupport: { claude: 'none', codex: 'native' },
              facets: {
                codex: {
                  provider: 'codex',
                  mode: 'native',
                  name: PLUGIN_NAME,
                  installLocation: fixtureDir,
                  sourcePath: fixtureDir,
                },
              },
              details: {
                skills: [],
                agents: [],
                commands: [],
                apps: [],
                hooks: [],
                mcpServers: [
                  {
                    name: 'broker',
                    type: 'command',
                    command: 'node',
                    args: ['./mcp/secret-echo-mcp.cjs'],
                    cwd: '.',
                  },
                ],
                lspServers: [],
                hasReadme: false,
              },
            },
          ],
        },
      ],
    })}\n`,
    'utf8',
  );
  return logPath;
}

test.describe('Codex parent stdio MCP broker live turn', () => {
  test('the real Codex app-server initializes a relative-cwd plugin MCP without retaining its secret', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-mcp-broker-'),
    );
    const sentinel = `codex-broker-secret-${Date.now()}`;
    seedPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const mcpLogPath = seedSecretEchoServer(userDataDir, sentinel);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: CHAT_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Codex MCP broker',
          providerType: 'codex',
          pluginSelections: {
            marketplacePluginIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME },
            ],
            mcpServerRefs: [],
            collectionIds: [],
          },
          messages: [],
        },
      ],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            text: ASSISTANT_REPLY,
            stopReason: 'end_turn',
          },
        ],
      },
    });

    initializeIsolatedCodexState(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      await expect(window.getByText('1 server', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const prompt = `[${CONVERSATION_MARKER}] Confirm the selected brokered plugin initialized.`;
      const composer = window.getByRole('textbox').first();
      await composer.fill(prompt);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(prompt, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        panel.getByText(ASSISTANT_REPLY, { exact: true }),
      ).toBeVisible({ timeout: 120_000 });
      await expect
        .poll(
          () =>
            existsSync(mcpLogPath) ? readFileSync(mcpLogPath, 'utf8') : '',
          { timeout: 60_000 },
        )
        // Initialization proves the long selected identity reached Codex
        // without a provider MCP name-limit failure.
        .toContain('secret-present:initialize');

      const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
      expect(
        existsSync(
          path.join(
            workspaceRoot,
            'chat-storage-manifests',
            `${WORKTREE_ID}.json`,
          ),
        ),
      ).toBe(true);
      expect(
        readFilesText(path.join(workspaceRoot, 'chat-storage-v2', WORKTREE_ID)),
      ).not.toContain(sentinel);
      expect(
        readFilesText(path.join(userDataDir, 'codex-capabilities')),
      ).not.toContain(sentinel);
      expect(
        readFilesText(path.join(userDataDir, 'codex-runtime')),
      ).not.toContain(sentinel);
      expect(readBrokerRuntimeText()).not.toContain(sentinel);
      expect(findSyntheticHomeDirectories(userDataDir)).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// Extend the real broker coverage with a mixed healthy/unavailable selection.
test('a failed HTTP MCP does not block a real Codex turn or its healthy stdio tool', async () => {
  test.setTimeout(180_000);
  const { runUnavailableMcpFlow } =
    await import('./codex-mcp-unavailable.scenario.mjs');
  await runUnavailableMcpFlow();
});
