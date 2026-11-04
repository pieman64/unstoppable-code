import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// REG-3035: a curated server the catalog marks desktop only.
//
// 1. Its sign-in refuses the cloud's return address, so setting it up never
//    starts a cloud account connection. Its detail's Advanced configuration
//    opens the device editor, which signs in on this device, with no "can't
//    connect" notice, and saves a device server.
// 2. A cloud connection made before the server was marked keeps Disconnect in
//    the account connections table (Settings > MCP servers), labelled Desktop
//    only, and offers no cloud Connect.
// 3. Home's sign-in strip, for a task that attaches such a connection, points
//    at adding the server on this device instead of starting a cloud sign-in.
// 4. On the Plugins page, that old cloud connection never drives the card:
//    the card offers Add (not a cloud Connect), Add creates the device server,
//    and the detail keeps only the old connection's Disconnect.
//
// Deterministic and offline: the account cloud is the `accountMcpCloud`
// fixture, and the curated catalog is seeded fresh on disk and answered by
// the fixture, so startup and refreshes agree. No live agents, no network.

// The catalog cache is honored for an hour; an older stamp triggers a refresh.
const NOW = new Date().toISOString();
const CANVA = {
  key: 'canva',
  name: 'Canva',
  shortDescription: 'Create and edit designs.',
  url: 'https://mcp.canva.example/mcp',
  transport: 'http',
  categories: ['design'],
  popular: true,
  sortOrder: 0,
  updatedAt: NOW,
  availability: 'desktop',
  oauthHints: { scopes: ['design:read'] },
};
const CANVA_CONNECTION_ID = '22222222-3333-4444-8555-666666666666';

function seedCatalog(userDataDir) {
  seedMcpServers({ userDataDir, servers: [] });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [CANVA],
  });
}

/**
 * `open` picks where the test starts: `customize` is Customize > MCP servers,
 * `account-panel` is Settings > MCP servers > Account connections (CAN-4267
 * removed the Plugins management table both used to share).
 */
async function launchWithAccountCloud(userDataDir, cloud, { open } = {}) {
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
  if (open === 'customize') {
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');
  } else if (open === 'account-panel') {
    await app.openSettings();
    await app.openSettingsSection('mcp');
  }
  return {
    electronApp,
    window,
    panel: window.getByTestId('settings-mcp-account-connections'),
  };
}

test('Add puts a desktop-only server on this device instead of the cloud account', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    curatedServers: [CANVA],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3035-'));
  seedCatalog(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud, {
      open: 'customize',
    });
    electronApp = launched.electronApp;
    const { window } = launched;

    // CAN-4267: Browse is the catalog card on Customize. Its detail's
    // Advanced configuration opens the same pre-filled device editor the old
    // Browse dialog's Add did; the card's own Add is covered below.
    await window.getByTestId('plugins-search').fill('Canva');
    await window.getByTestId('plugins-entry-mcp-catalog:canva').click();
    const detail = window.getByTestId('mcp-browse-detail');
    await expect(detail).toBeVisible();
    await window.getByTestId('plugin-advanced-configuration').click();

    // The device editor opens with nothing saying it can't connect.
    const dialog = window.getByRole('dialog', { name: 'New MCP server' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByTestId('mcp-server-provider-connector-notice'),
    ).toHaveCount(0);
    await expect(
      detail.getByTestId('mcp-browse-detail-provider-guidance'),
    ).toHaveCount(0);
    await expect(detail).not.toContainText(/Couldn.t connect/);
    await expect(dialog.getByTestId('mcp-cloud-local-reason')).toHaveText(
      'Desktop only. This server signs in on this device.',
    );
    await expect(
      dialog.getByRole('button', { name: 'Try again', exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Nothing was started in the cloud account; the server is on this device.
    expect(cloud.calls.filter((call) => call.method === 'POST')).toEqual([]);
    const rows = await window.evaluate(async () => {
      const index = await window.mcpServers.loadIndex();
      return index.servers
        .filter((row) => row.curatedKey === 'canva')
        .map((row) => ({
          scope: row.scope ?? 'device',
          authHandler: row.authHandler ?? null,
          accountConnectionId: row.accountConnectionId ?? null,
        }));
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).not.toBe('account');
    expect(rows[0].authHandler).not.toBe('account');
    expect(rows[0].accountConnectionId).toBeNull();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('a cloud connection made before the server was marked desktop only keeps Disconnect', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    curatedServers: [CANVA],
    connections: [
      {
        id: CANVA_CONNECTION_ID,
        serverKey: 'canva',
        configId: 'default',
        displayName: 'Canva',
        kind: 'CURATED',
        status: 'CONNECTED',
        routeId: 'fixture-canva-default',
        enabledTools: null,
      },
    ],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3035-'));
  seedCatalog(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud, {
      open: 'account-panel',
    });
    electronApp = launched.electronApp;
    const { panel } = launched;

    const row = panel.getByTestId('mcp-server-row-canva');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId('mcp-tier-badge')).toHaveText('Desktop only');
    await expect(row.getByTestId('mcp-account-connect')).toHaveCount(0);
    await row.getByTestId('mcp-account-disconnect').click();

    await expect
      .poll(() =>
        cloud.calls.filter(
          (call) =>
            call.method === 'DELETE' && call.path.includes(CANVA_CONNECTION_ID),
        ),
      )
      .toHaveLength(1);
    // Once nothing is connected, the row keeps no cloud controls at all.
    await expect(row.getByTestId('mcp-account-disconnect')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(row.getByTestId('mcp-account-connect')).toHaveCount(0);
    expect(cloud.calls.filter((call) => call.method === 'POST')).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('Home points a desktop-only server at this device instead of a cloud sign-in', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    curatedServers: [CANVA],
    connections: [
      {
        id: CANVA_CONNECTION_ID,
        serverKey: 'canva',
        configId: 'default',
        displayName: 'Canva',
        kind: 'CURATED',
        status: 'REAUTH_REQUIRED',
        routeId: 'fixture-canva-default',
        enabledTools: null,
      },
    ],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3035-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedCatalog(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud);
    electronApp = launched.electronApp;
    const { window } = launched;
    const app = new CanopyAppDriver(window);
    const home = await app.openHomeForProject('demo-ts-pnpm-vite');
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    await picker
      .locator('tr')
      .filter({ hasText: 'Canva' })
      .getByRole('checkbox')
      .check();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const strip = home.getByTestId('mcp-sign-in-strip');
    const row = strip
      .getByTestId('mcp-servers-card-row')
      .filter({ hasText: 'Canva' });
    await row.getByTestId('mcp-servers-card-connect').click();
    await expect(strip.getByTestId('mcp-sign-in-strip-error')).toContainText(
      'Add Canva as a server on this device to connect it.',
    );
    expect(cloud.calls.filter((call) => call.method === 'POST')).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('the Plugins card adds the device server and keeps only Disconnect for an old cloud connection', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    curatedServers: [CANVA],
    connections: [
      {
        id: CANVA_CONNECTION_ID,
        serverKey: 'canva',
        configId: 'default',
        displayName: 'Canva',
        kind: 'CURATED',
        status: 'REAUTH_REQUIRED',
        routeId: 'fixture-canva-default',
        enabledTools: null,
      },
    ],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3035-'));
  seedCatalog(userDataDir);
  let electronApp;
  try {
    const launched = await launchWithAccountCloud(userDataDir, cloud);
    electronApp = launched.electronApp;
    const { window } = launched;
    const app = new CanopyAppDriver(window);
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Canva');

    // The lapsed cloud connection neither marks the card as needing a cloud
    // Connect nor hides Add.
    const card = window.getByTestId('plugins-entry-mcp-catalog:canva');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('plugins-surface-mcp-catalog:canva'),
    ).toHaveText('Desktop only');
    await expect(
      window.getByTestId('plugins-entry-menu-mcp-catalog:canva'),
    ).toBeVisible();
    await window.getByTestId('plugins-entry-menu-mcp-catalog:canva').click();
    await expect(
      window.getByTestId('plugins-entry-menu-mcp-catalog:canva-details'),
    ).toHaveText('Open details');
    await expect(
      window.getByTestId('plugins-entry-menu-mcp-catalog:canva-connect'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.getByTestId('plugins-entry-add-mcp-catalog:canva').click();

    // Add creates the server on this device, never a cloud connection.
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const index = await window.mcpServers.loadIndex();
            // A device file can be listed at the top level and nested under
            // the account row it shadows; count each one once.
            const devices = new Map(
              index.servers
                .flatMap((row) => [row, ...(row.deviceCopies ?? [])])
                .filter(
                  (row) =>
                    row.curatedKey === 'canva' && row.scope !== 'account',
                )
                .map((row) => [row.id, row]),
            );
            return [...devices.values()].map((row) => ({
              accountHandled: row.authHandler === 'account',
            }));
          }),
        { timeout: 30_000 },
      )
      .toEqual([{ accountHandled: false }]);
    expect(cloud.calls.filter((call) => call.method === 'POST')).toEqual([]);

    // The old cloud connection keeps only its Disconnect.
    const leftover = window.getByTestId('mcp-browse-detail-cloud-connection');
    await expect(leftover).toContainText(
      'Cloud chats can’t use this server anymore.',
    );
    await leftover.getByTestId('mcp-browse-detail-cloud-disconnect').click();
    await expect
      .poll(() =>
        cloud.calls.filter(
          (call) =>
            call.method === 'DELETE' && call.path.includes(CANVA_CONNECTION_ID),
        ),
      )
      .toHaveLength(1);
    await expect(leftover).toHaveCount(0, { timeout: 30_000 });
    expect(cloud.calls.filter((call) => call.method === 'POST')).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
