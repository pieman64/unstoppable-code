import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedCuratedPlugins } from './seeders/seedCuratedPlugins.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// REG-3033: one card per MCP integration, one Add path, every connection kept.
//
// The curated Linear plugin (one MCP key plus skills), the curated Linear MCP
// entry, and a Linear account connection used to be three rows that each
// added something different. The marketplace now shows one Linear card that
// says it includes the plugin's skills; Add from it follows the same rule as
// the MCP tab (an account connection with the shared-account flag on) and
// installs the skills in the same step; and the inventory lists a Personal and
// a Work connection as two named rows instead of collapsing them to one.
//
// Deterministic: the account cloud is the `accountMcpCloud` fixture, the
// curated catalogs are seeded on disk, and the built-in plugin install is
// answered by a stubbed IPC handler. No live agents, no network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
// The catalog cache is honored for an hour; an older stamp triggers a cloud
// refresh the fixture cannot answer, which empties the catalog.
const NOW = new Date().toISOString();
const LINEAR_PLUGIN_DEFS = [
  {
    key: 'linear',
    displayName: 'Linear',
    shortDescription: 'Plan and triage issues with Linear.',
    version: '1.0.0',
    authorName: 'Canopy Curated',
    category: 'productivity',
    docsUrl: 'https://example.com/docs/linear',
    skill: {
      key: 'linear-triage',
      name: 'Linear Triage',
      description: 'Triage incoming Linear issues.',
    },
    mcpServer: { key: 'linear', url: 'https://mcp.linear.example/mcp' },
  },
];

function seedLinearCatalogs(userDataDir) {
  seedMcpServers({ userDataDir, servers: [] });
  seedCuratedPlugins({ userDataDir, pluginDefs: LINEAR_PLUGIN_DEFS });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [
      {
        key: 'linear',
        name: 'Linear',
        shortDescription: 'Issues, projects, and cycles.',
        url: 'https://mcp.linear.example/mcp',
        transport: 'http',
        categories: ['productivity'],
        popular: true,
        sortOrder: 0,
        updatedAt: NOW,
      },
    ],
  });
}

/**
 * Answers the built-in plugin install the way the real handler does for a
 * materialized curated plugin, without touching provider configuration: the
 * seeded cache row comes back with both providers installed. The row is read
 * here and handed to the main process, which cannot load modules inside
 * `evaluate`.
 */
async function stubBuiltInInstall(electronApp, cacheFilePath) {
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const seeded = cache.marketplaces
    .flatMap((marketplace) => marketplace.plugins)
    .find((plugin) => plugin.name === 'linear');
  if (!seeded) throw new Error('The Linear curated plugin was not seeded.');
  await electronApp.evaluate(
    ({ ipcMain }, { plugin }) => {
      globalThis.__reg3033Installs = [];
      ipcMain.removeHandler('plugins:install-built-in-plugin');
      ipcMain.handle('plugins:install-built-in-plugin', (_event, request) => {
        globalThis.__reg3033Installs.push(request);
        if (
          request.marketplaceId !== plugin.marketplaceId ||
          request.pluginName !== plugin.name
        )
          return { success: false, error: 'Plugin not seeded.' };
        return {
          success: true,
          data: {
            plugin: {
              ...plugin,
              globalInstallStatus: {
                claude: { available: true, installed: true },
                codex: { available: true, installed: true },
                checkedAt: new Date().toISOString(),
              },
            },
            providerOutcomes: {
              claude: { installed: true },
              codex: { installed: true },
            },
          },
        };
      });
    },
    { plugin: seeded },
  );
}

async function launchWithAccountCloud(userDataDir, cloud) {
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-mcp-account-connections': true,
      }),
    },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  const signIn = await window.evaluate(async () =>
    window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
  );
  expect(signIn.status.authenticated, JSON.stringify(signIn.status)).toBe(true);
  return { electronApp, window, app };
}

test('the marketplace shows one Linear card and Add connects the account and installs the skills', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3033-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedLinearCatalogs(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud);
    electronApp = launched.electronApp;
    const { window, app } = launched;
    await stubBuiltInInstall(
      electronApp,
      path.join(userDataDir, 'plugins-cache.json'),
    );
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Linear');

    // One card: the curated MCP entry, carrying the plugin's skills. The
    // curated plugin no longer renders a card of its own.
    const card = window.getByTestId('plugins-entry-mcp-catalog:linear');
    await expect(card).toBeVisible();
    await expect(
      window.getByTestId('plugins-includes-mcp-catalog:linear'),
    ).toHaveText('Includes Linear skills');
    await expect(
      window.getByTestId('plugins-entry-curated:linear'),
    ).toHaveCount(0);
    await expect(
      window
        .locator('[data-testid^="plugins-entry-"]')
        .filter({ hasText: 'Linear' }),
    ).toHaveCount(1);

    // Add from the card: the shared rule creates an account connection, not
    // a device file, and installs the folded plugin once it exists.
    await window.getByTestId('plugins-entry-add-mcp-catalog:linear').click();
    await expect
      .poll(
        () =>
          cloud.calls.filter(
            (call) =>
              call.method === 'POST' && call.body?.serverKey === 'linear',
          ).length,
      )
      .toBe(1);
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__reg3033Installs.length),
      )
      .toBe(1);
    expect(
      await electronApp.evaluate(() => globalThis.__reg3033Installs[0]),
    ).toMatchObject({ marketplaceId: 'curated/cloud', pluginName: 'linear' });
    const deviceFiles = await window.evaluate(async () => {
      const index = await window.mcpServers.loadIndex();
      return index.servers
        .flatMap((row) => [row, ...(row.deviceCopies ?? [])])
        .filter((row) => row.curatedKey === 'linear' && row.scope !== 'account')
        .map((row) => row.id);
    });
    expect(deviceFiles).toEqual([]);

    // The connection now exists and the card keeps its integrated detail:
    // the account's own sign-in state, no device sign-in, and the folded
    // plugin's skills already installed.
    const accountConnection = window.getByTestId('plugin-account-connection');
    await expect(accountConnection).toContainText('Waiting for sign-in', {
      timeout: 30_000,
    });
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    await expect(
      window.getByTestId('mcp-browse-detail-skills-installed'),
    ).toHaveText('Linear skills are installed.');
    await expect(window.getByTestId('mcp-account-details')).toHaveCount(0);

    // The sign-in finishes in the browser; the detail reads signed in and
    // the card reads installed.
    cloud.complete('linear');
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const index = await window.mcpServers.loadIndex();
            return (
              index.servers.find(
                (row) => row.accountConnection?.serverKey === 'linear',
              )?.accountConnection?.status ?? null
            );
          }),
        { timeout: 30_000 },
      )
      .toBe('CONNECTED');
    await expect(accountConnection).toContainText(
      'Linear is connected to your account',
      {
        timeout: 30_000,
      },
    );
    // CAN-4261: the page has no Back; leave through the breadcrumb.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(card).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-add-mcp-catalog:linear'),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('Connect on a disconnected account connection reconnects it without a second click', async () => {
  // Review follow-up: the card's Add intent on an existing account binding
  // that is not connected used to only open the detail, and the user had to
  // press Connect again before the connection reconnected and the folded
  // skills installed. The desktop status reads a disconnected account row as
  // not connected, so the card needs attention and offers Connect from its
  // menu; it takes the same Add intent as the Add button.
  test.setTimeout(150_000);
  const connectionId = '11111111-2222-4333-8444-555555555555';
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    connections: [
      {
        id: connectionId,
        serverKey: 'linear',
        configId: 'default',
        displayName: 'Linear',
        kind: 'CURATED',
        status: 'DISCONNECTED',
        routeId: 'fixture-linear-default',
        enabledTools: null,
      },
    ],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3033-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedLinearCatalogs(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud);
    electronApp = launched.electronApp;
    const { window, app } = launched;
    await stubBuiltInInstall(
      electronApp,
      path.join(userDataDir, 'plugins-cache.json'),
    );
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Linear');

    // One Connect from the card starts the reconnect on that same connection,
    // with no second press inside the detail.
    const card = window.getByTestId('plugins-entry-mcp-catalog:linear');
    await expect(card).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-add-mcp-catalog:linear'),
    ).toHaveCount(0);
    await window.getByTestId('plugins-entry-menu-mcp-catalog:linear').click();
    await window.getByTestId('plugins-menu-connect-mcp-catalog:linear').click();
    await expect
      .poll(
        () =>
          cloud.calls.filter(
            (call) =>
              call.method === 'POST' && call.body?.serverKey === 'linear',
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const accountConnection = window.getByTestId('plugin-account-connection');
    await expect(accountConnection).toContainText('Waiting for sign-in', {
      timeout: 30_000,
    });
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__reg3033Installs.length),
      )
      .toBe(1);
    const rows = await window.evaluate(async () => {
      const index = await window.mcpServers.loadIndex();
      return index.servers
        .flatMap((row) => [row, ...(row.deviceCopies ?? [])])
        .filter((row) => row.curatedKey === 'linear')
        .map((row) => ({
          scope: row.scope,
          connectionId: row.accountConnection?.id ?? null,
          status: row.accountConnection?.status ?? null,
        }));
    });
    expect(rows).toEqual([
      { scope: 'account', connectionId, status: 'PENDING' },
    ]);

    cloud.complete('linear');
    await expect(accountConnection).toContainText(
      'Linear is connected to your account',
      {
        timeout: 30_000,
      },
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('the inventory lists a Personal and a Work connection to one provider as two named rows', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    connections: [
      {
        id: '11111111-2222-4333-8444-555555555555',
        serverKey: 'linear',
        configId: 'default',
        displayName: 'Linear',
        kind: 'CURATED',
        status: 'CONNECTED',
        routeId: 'fixture-linear-default',
        enabledTools: null,
      },
      {
        id: '66666666-7777-4888-8999-000000000000',
        serverKey: 'linear',
        configId: 'work',
        displayName: 'Linear',
        kind: 'CURATED',
        status: 'CONNECTED',
        routeId: 'fixture-linear-work',
        enabledTools: null,
      },
    ],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3033-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedLinearCatalogs(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud);
    electronApp = launched.electronApp;
    const { window, app } = launched;
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');
    const panel = window.getByTestId('plugins-management-section-mcp');
    const rows = panel.getByTestId('mcp-server-row-linear');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute(
      'data-mcp-connection-id',
      '11111111-2222-4333-8444-555555555555',
    );
    await expect(rows.nth(0).getByTestId('mcp-account-config')).toHaveCount(0);
    await expect(rows.nth(1)).toHaveAttribute(
      'data-mcp-connection-id',
      '66666666-7777-4888-8999-000000000000',
    );
    await expect(rows.nth(1).getByTestId('mcp-account-config')).toHaveText(
      'Work',
    );
    await expect(rows.getByTestId('mcp-account-status')).toHaveText([
      'Connected',
      'Connected',
    ]);

    // The marketplace still shows one Linear card, installed.
    // The management view stays mounted behind discovery; Back only closes it.
    await window.getByTestId('plugins-management-back').click();
    await expect(window.getByTestId('plugins-search')).toBeVisible();
    await window.getByTestId('plugins-search').fill('Linear');
    await expect(
      window
        .locator('[data-testid^="plugins-entry-"]')
        .filter({ hasText: 'Linear' }),
    ).toHaveCount(1);
    await expect(
      window.getByTestId('plugins-entry-add-mcp-catalog:linear'),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
