import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  initializeIsolatedCodexState,
  DEFAULT_MOCK_BASE_URL,
  DEFERRED_ECHO_TOOL_NAME,
  registerScenario,
  seedDeferredEchoServer,
  seedMcpServers,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

// Real bundled Codex and real MCP transports, with deterministic local LLM responses.
// Both the durable spec and before/after capture use this exact composer flow.
export async function runUnavailableMcpFlow({
  stage = 'after',
  captureDir,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-mcp-unavailable-'),
  );
  let initializeRequests = 0;
  const failedServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (body.includes('initialize')) initializeRequests++;
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': '30',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32002,
            message:
              'MCP authorization is temporarily unavailable. Try again shortly.',
          },
          id: null,
        }),
      );
    });
  });
  await new Promise((resolve) => failedServer.listen(0, '127.0.0.1', resolve));
  let electronApp;
  let failed = false;
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      defaultMode: 'full-access',
    });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
        defaultChatInterfaceMode: 'canopy',
        mcpProxyPort: 43000 + (Date.now() % 10000),
        defaultWorktreeModelByProvider: {
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
        },
      },
    });
    const { logPath } = seedDeferredEchoServer(userDataDir);
    const healthy = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'mcp-servers/server-dr.json'),
        'utf8',
      ),
    ).server;
    const now = '2026-09-09T12:00:00.000Z';
    seedMcpServers({
      userDataDir,
      servers: [
        healthy,
        {
          definition: {
            id: 'unavailable',
            name: 'Unavailable HTTP Fixture',
            description: 'Returns a temporary authorization outage.',
            type: 'http',
            url: `http://127.0.0.1:${failedServer.address().port}/mcp`,
            httpAuthHandler: 'provider',
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
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'codex',
      activeTabId: 'unavailable-chat',
      tabs: [
        {
          id: 'unavailable-chat',
          title: 'MCP availability',
          providerType: 'codex',
          messages: [],
          pluginSelections: {
            marketplacePluginIds: [],
            skillRefs: [],
            pluginRefs: [],
            collectionIds: [],
            mcpServerRefs: [
              { serverId: 'dr', configId: 'd' },
              { serverId: 'unavailable', configId: 'default' },
            ],
          },
        },
      ],
    });
    const marker = 'Canopy-CMCPUNAVAILABLE';
    const reply = 'The healthy MCP responded. Work can continue.';
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            toolSearch: { query: 'deferred echo', limit: 5 },
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                namespace: DEFERRED_ECHO_TOOL_NAME.slice(
                  0,
                  DEFERRED_ECHO_TOOL_NAME.lastIndexOf('__'),
                ).replaceAll('-', '_'),
                name: 'deferred_echo',
                input: { message: 'healthy despite outage' },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: reply, stopReason: 'end_turn' },
        ],
      },
    });
    initializeIsolatedCodexState(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    await expect(window.getByText('2 servers', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        `[${marker}] Use the healthy echo tool and continue even if another MCP is unavailable.`,
      );
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(() => initializeRequests, { timeout: 30_000 })
      .toBeGreaterThan(0);
    if (stage === 'before') {
      await expect
        .poll(
          () => readFileSync(path.join(userDataDir, 'logs/main.log'), 'utf8'),
          { timeout: 30_000 },
        )
        .toContain('required MCP servers failed to initialize');
      await expect(panel.getByText(/Completed in/)).toBeVisible();
      await expect(panel.getByText(reply, { exact: true })).toHaveCount(0);
    } else {
      await expect(panel.getByText(reply, { exact: true })).toBeVisible({
        timeout: 45_000,
      });
      await expect
        .poll(
          () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
          { timeout: 10_000 },
        )
        .toContain('called: healthy despite outage');
      await expect(
        panel.getByText(/Selected Codex MCP server .* failed:/),
      ).toHaveCount(0);
    }
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await panel.screenshot({
        path: path.join(captureDir, `chat-${stage}.png`),
        animations: 'disabled',
      });
    }
  } catch (error) {
    failed = true;
    console.log(`MCP failure fixture retained at ${userDataDir}`);
    throw error;
  } finally {
    if (electronApp)
      await closeCanopy(electronApp, userDataDir, { keepUserData: failed });
    failedServer.closeAllConnections();
    await new Promise((resolve) => failedServer.close(resolve));
  }
}
