import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// REG-3034: Plugins → MCP Servers explains a connect that can't start here.
//
// 1. Adding a provider connector (Gmail) from Browse used to open the device
//    dialog with no sign-in and no explanation. That modal dialog now says
//    which agent provider account to connect first.
// 2. Connect on a row whose valid token already exists finishes without a
//    browser. The tab now says the server is already connected.
//
// Deterministic and offline: the curated catalog cache is seeded fresh so
// startup keeps it, the status read is pinned to `auth_required` so the row
// offers Connect, and the real sign-in IPC answers `completed` from the seeded
// unexpired token without any network call.

const NOW = new Date().toISOString();

function seedCatalog(userDataDir, servers) {
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers,
  });
}

async function openMcpTab(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openPluginsPage();
  await app.openPluginsTab('mcp');
  await app.expectPluginsTab('mcp');
  return window.getByTestId('plugins-management-section-mcp');
}

test('adding a provider connector says inside its dialog which account to connect first', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mcp-provider-notice-'),
  );
  seedCatalog(userDataDir, [
    {
      key: 'gmail',
      name: 'Gmail',
      shortDescription: 'Read and send email',
      url: 'https://gmail.example.test/mcp',
      transport: 'http',
      categories: ['productivity'],
      popular: true,
      sortOrder: 0,
      updatedAt: NOW,
      providerConnector: { providers: ['claude', 'codex'] },
    },
  ]);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const panel = await openMcpTab(window);
    await expect(panel.getByTestId('mcp-connect-notice')).toHaveCount(0);

    await panel.getByTestId('mcp-add-menu-trigger').click();
    await window.getByTestId('mcp-add-browse').click();
    await window
      .getByTestId('mcp-browse-dialog')
      .getByTestId('mcp-browse-card')
      .filter({ hasText: 'Gmail' })
      .getByTestId('mcp-browse-card-add')
      .click();

    // The editor is modal, so the guidance is inside it where it can be read.
    const dialog = window.getByRole('dialog', { name: 'New MCP server' });
    const notice = dialog.getByTestId('mcp-server-provider-connector-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      'Gmail connects through your Claude or Codex account. Connect Claude or Codex first, then link Gmail there.',
    );
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(panel.getByTestId('mcp-connect-notice')).toHaveCount(0);

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Connect with a valid token says the server is already connected', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mcp-already-connected-'),
  );
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: 'Signed In Server',
          description: 'Already holds a valid token',
          type: 'http',
          url: 'https://mcp.example.test/mcp',
          oauth: {},
          httpAuthHandler: 'canopy',
          createdAt: NOW,
          updatedAt: NOW,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const encrypted = await electronApp.evaluate(({ safeStorage }) =>
      safeStorage.encryptString('fixture-access-token').toString('base64'),
    );
    writeJson(path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json'), {
      version: 1,
      records: {
        'aabbcc:ddeeff': {
          serverId: 'aabbcc',
          configId: 'ddeeff',
          encryptedAccessTokenBase64: encrypted,
          upstreamUrl: 'https://mcp.example.test/mcp',
          clientId: 'fixture-client',
          tokenUrl: 'https://mcp.example.test/token',
          tokenType: 'Bearer',
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          updatedAt: NOW,
        },
      },
    });
    // A stale status read still asks for sign-in, so the row offers Connect.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mcp-servers:list-status');
      ipcMain.handle('mcp-servers:list-status', () => [
        {
          serverId: 'aabbcc',
          transport: 'http',
          handler: 'canopy',
          connectionStatus: 'auth_required',
          reachability: 'unknown',
          configs: [{ configId: 'ddeeff', authStatus: 'not_connected' }],
        },
      ]);
    });

    const window = await electronApp.firstWindow();
    const panel = await openMcpTab(window);
    const row = panel.getByTestId('mcp-server-row-aabbcc');
    await row.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(panel.getByTestId('mcp-connect-notice')).toContainText(
      'Signed In Server is already connected.',
    );
    await expect(panel.getByTestId('mcp-connect-notice')).toHaveAttribute(
      'role',
      'status',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
