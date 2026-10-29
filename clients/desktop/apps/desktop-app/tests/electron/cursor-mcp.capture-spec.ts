// @capture-keep: reusable paired visual proof for Cursor MCP picker and approval flows
// @capture-reference: docs/cursor-chat.md
// Cursor MCP over ACP — feature-verification captures (Cursor provider plan, Task 4).
//
// What changed: the local Cursor chat now hands the pinned Cursor CLI the
// app's own HTTP MCP servers plus selected plugin/standalone MCP servers as
// ACP `mcpServers`. The composer plus-menu keeps the Plugins entry enabled for
// Cursor, the plugin picker opens under the `cursor` scope, and an MCP tool
// call on a plugin server goes through the shared approval card
// (`Cursor wants to use echo`). Before the change the Plugins entry was
// disabled and the fixture agent received no MCP servers at all.
//
// Run (light, then dark) on the unmodified tree, then on the changed tree:
//   CURSOR_MCP_STAGE=before pnpm run test:electron:captures:built cursor-mcp.capture-spec.ts --reporter=line
//   CURSOR_MCP_STAGE=before pnpm run test:electron:captures:built cursor-mcp.capture-spec.ts --reporter=line --dark-mode
//   # apply the change, rebuild with `pnpm run build:e2e`
//   CURSOR_MCP_STAGE=after pnpm run test:electron:captures:built cursor-mcp.capture-spec.ts --reporter=line
//   CURSOR_MCP_STAGE=after pnpm run test:electron:captures:built cursor-mcp.capture-spec.ts --reporter=line --dark-mode
//
// Determinism: the managed Cursor runtime is the deterministic ACP fixture
// agent served through the real installer (no live Cursor, no account usage),
// the plugin MCP server is a loopback HTTP server owned by this spec, and all
// chat state is seeded on disk. No network.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedMcpServers, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';

const STAGE = process.env.CURSOR_MCP_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'cursor-mcp');

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'cursor-mcp';
const MCP_SERVER_ID = 'e2e-mcp';
const MCP_SERVER_NAME = 'E2E MCP Fixture';

async function startMcpFixtureServer() {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    const message = body ? JSON.parse(body) : null;
    if (!message || !('id' in message)) {
      response.writeHead(204);
      response.end();
      return;
    }
    const reply = (result: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-mcp-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      reply({
        tools: [
          {
            name: 'echo',
            description: 'Echoes a message.',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      });
    } else if (message.method === 'tools/call') {
      reply({
        content: [
          {
            type: 'text',
            text: `E2E_MCP_ECHO:${message.params?.arguments?.message ?? ''}`,
          },
        ],
      });
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unknown method' },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('MCP fixture server did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test(`Cursor MCP over ACP captures (${STAGE})`, async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-capture-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const mcp = await startMcpFixtureServer();
  const now = '2026-09-12T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: MCP_SERVER_ID,
          name: MCP_SERVER_NAME,
          description: 'Loopback MCP fixture',
          type: 'http',
          url: mcp.url,
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
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'cursor',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: MCP_SERVER_ID, configId: 'default' }],
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1200, height: 860 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );

    // 1. Composer plus-menu: Plugins entry (disabled before, enabled after).
    await panel.getByTestId('chat-input-plus-button').click();
    const menu = window.getByRole('menu').filter({ hasText: 'Plugins' });
    await expect(menu).toBeVisible();
    const pluginsButton = window.getByTestId('chat-plugins-button');
    if (STAGE === 'after') {
      await expect(pluginsButton).toBeEnabled();
      await expect(
        window.getByTestId('chat-input-commands-button'),
      ).toBeDisabled();
    } else {
      await expect(pluginsButton).toBeDisabled();
    }
    await menu.screenshot({
      path: path.join(captureDir, `composer-plus-menu-${STAGE}.png`),
      animations: 'disabled',
    });

    // 2. Plugin picker under the Cursor scope (after only).
    if (STAGE === 'after') {
      await pluginsButton.click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder('Search by name…').fill(MCP_SERVER_NAME);
      await expect(
        dialog.getByRole('checkbox', { name: `Select ${MCP_SERVER_NAME}` }),
      ).toBeChecked();
      await dialog.screenshot({
        path: path.join(captureDir, `plugin-picker-${STAGE}.png`),
        animations: 'disabled',
      });
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } else {
      await window.keyboard.press('Escape');
    }

    // 3. Plugin MCP tool call: approval card (after) or unavailable (before).
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MCP_PLUGIN: Call the echo tool.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    if (STAGE === 'after') {
      const card = panel.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('Cursor wants to use echo');
      await card.screenshot({
        path: path.join(captureDir, `mcp-approval-card-${STAGE}.png`),
        animations: 'disabled',
      });
      await card.getByTestId('tool-approval-allow').click();
      await expect(
        panel.getByText('MCP_RESULT: E2E_MCP_ECHO:hello', { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(panel.getByText(/MCP_UNAVAILABLE/)).toBeVisible({
        timeout: 30_000,
      });
    }
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    await panel.screenshot({
      path: path.join(captureDir, `mcp-turn-transcript-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await mcp.close();
    cleanupDemoWorkspaces(seeded);
  }
});
