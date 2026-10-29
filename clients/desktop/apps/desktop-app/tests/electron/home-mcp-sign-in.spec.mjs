import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  CUSTOM_ACCOUNT_MCP_ID,
  startAccountMcpCloud,
} from './fixtures/accountMcpCloud.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedCuratedPlugins } from './seeders/seedCuratedPlugins.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// REG-3029: Home prompts sign-in for the MCP servers a new task attaches,
// before a chat exists. The account connections come from the
// `accountMcpCloud` fixture, which also finishes each browser sign-in on
// request, so the whole flow runs without a live MCP server or browser.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const NOW = new Date().toISOString();

test('Home prompts sign-in for attached account MCP servers until they connect', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: true });
  cloud.customs.push({
    id: CUSTOM_ACCOUNT_MCP_ID,
    serverKey: 'custom:fixture-tools',
    configId: 'default',
    displayName: 'Team Tools',
    kind: 'CUSTOM',
    authMode: 'OAUTH',
    status: 'DISCONNECTED',
    routeId: 'fixture-custom-route',
    enabledTools: null,
    upstreamHost: 'tools.example.test',
    hasExtraHeaders: false,
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-mcp-sign-in-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({ userDataDir, servers: [] });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [
      {
        key: 'github',
        name: 'GitHub',
        shortDescription: 'GitHub integration',
        url: 'https://github.example.test/mcp',
        transport: 'http',
        categories: ['development'],
        popular: true,
        sortOrder: 0,
        updatedAt: NOW,
      },
    ],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const signIn = await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
    );
    expect(signIn.status.authenticated, JSON.stringify(signIn.status)).toBe(
      true,
    );

    const home = await app.openHomeForProject(WORKSPACE_ID);
    const strip = home.getByTestId('mcp-sign-in-strip');
    await expect(strip).toHaveCount(0);

    // The picker only attaches: nothing prompts until the draft has them.
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    for (const name of ['Account GitHub', 'Team Tools']) {
      const row = picker.locator('tr').filter({ hasText: name });
      await expect(row).toHaveCount(1);
      await row.getByRole('checkbox').check();
    }
    await expect(strip).toHaveCount(0);
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    await expect(strip.getByTestId('mcp-sign-in-strip-summary')).toHaveText(
      'Account GitHub and Team Tools need sign-in',
    );
    const rows = strip.getByTestId('mcp-servers-card-row');
    const github = rows.filter({ hasText: 'Account GitHub' });
    const tools = rows.filter({ hasText: 'Team Tools' });
    await expect(github.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Not signed in',
    );
    await expect(tools.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Not signed in',
    );
    // Sending stays available while servers still need sign-in.
    await home.getByTestId('home-composer-editor').fill('Summarize my issues');
    await expect(home.getByTestId('home-send-button')).toBeEnabled();

    await github.getByTestId('mcp-servers-card-connect').click();
    await expect(github.getByTestId('mcp-sign-in-strip-waiting')).toContainText(
      'Waiting for browser',
    );
    expect(
      await electronApp.evaluate(
        () => globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__,
      ),
    ).toBe('https://auth.example.test/authorize');
    expect(
      cloud.calls.find((call) => call.method === 'POST')?.body,
    ).toMatchObject({ serverKey: 'github', configId: 'default' });
    cloud.complete('github');
    await expect(github.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Signed in',
      { timeout: 20_000 },
    );
    await expect(github.getByTestId('mcp-servers-card-connect')).toHaveCount(0);
    await expect(strip.getByTestId('mcp-sign-in-strip-summary')).toHaveText(
      'Team Tools needs sign-in',
    );

    await tools.getByTestId('mcp-servers-card-connect').click();
    await expect(tools.getByTestId('mcp-sign-in-strip-waiting')).toBeVisible();
    cloud.complete('custom:fixture-tools');
    await expect(strip).toHaveCount(0, { timeout: 20_000 });
    await expect(home.getByTestId('home-composer-editor')).toContainText(
      'Summarize my issues',
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

// A cached catalog entry that predates the server's endpoints reconnects
// without one; the cloud refuses with `endpoint_required`, and Home re-reads
// the catalog and opens the endpoint choice in place (CAN-3574).
test('Home asks for an endpoint when the cloud refuses a start without one', async () => {
  test.setTimeout(150_000);
  const endpoints = [
    { label: 'US1', url: 'https://us1.github.example.test/mcp' },
    { label: 'EU', url: 'https://eu.github.example.test/mcp' },
  ];
  const github = {
    key: 'github',
    name: 'GitHub',
    shortDescription: 'GitHub integration',
    url: endpoints[0].url,
    transport: 'http',
    categories: ['development'],
    popular: true,
    sortOrder: 0,
    updatedAt: NOW,
  };
  const cloud = await startAccountMcpCloud({
    includeConnection: true,
    endpointRequired: true,
    curatedServers: [{ ...github, urlOptions: endpoints }],
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-mcp-endpoint-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({ userDataDir, servers: [] });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [github],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const signIn = await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
    );
    expect(signIn.status.authenticated, JSON.stringify(signIn.status)).toBe(
      true,
    );

    const home = await app.openHomeForProject(WORKSPACE_ID);
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    await picker
      .locator('tr')
      .filter({ hasText: 'Account GitHub' })
      .getByRole('checkbox')
      .check();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const strip = home.getByTestId('mcp-sign-in-strip');
    const row = strip
      .getByTestId('mcp-servers-card-row')
      .filter({ hasText: 'Account GitHub' });
    const readsBefore = cloud.curatedReads;
    await row.getByTestId('mcp-servers-card-connect').click();

    const setup = window.getByTestId('mcp-account-setup');
    await expect(setup).toBeVisible();
    expect(cloud.curatedReads).toBeGreaterThan(readsBefore);
    // The choice opens over Home, from the strip, not in MCP settings.
    await expect(home).toBeVisible();
    await expect(
      window.getByTestId('settings-mcp-account-connections'),
    ).toHaveCount(0);
    await expect(window.getByTestId('mcp-sign-in-strip-error')).toHaveCount(0);
    const endpoint = setup.getByTestId('mcp-curated-url-option');
    await expect(endpoint.locator('option')).toHaveText(['US1', 'EU']);
    await endpoint.selectOption(endpoints[1].url);
    await setup.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(setup).toHaveCount(0);

    await expect(row.getByTestId('mcp-sign-in-strip-waiting')).toContainText(
      'Waiting for browser',
    );
    expect(
      cloud.calls
        .filter((call) => call.method === 'POST')
        .map((call) => call.body),
    ).toEqual([
      { serverKey: 'github', configId: 'default' },
      {
        serverKey: 'github',
        endpointUrl: endpoints[1].url,
        configId: 'default',
      },
    ]);
    // Its only server signed in, the strip steps aside.
    cloud.complete('github');
    await expect(strip).toHaveCount(0, { timeout: 20_000 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

// A plugin's own HTTP server with no catalog key has nothing an account
// connection could be matched by, so its row points at MCP settings instead
// of offering a Connect that could never land.
test('Home sends a plugin account server with no catalog entry to MCP settings', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-mcp-sign-in-plugin-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({ userDataDir, servers: [] });
  seedCuratedPlugins({ userDataDir });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { mcpHttpAuthDefaultHandler: 'account' },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const home = await app.openHomeForProject(WORKSPACE_ID);
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    const pluginRow = picker.locator('tr').filter({ hasText: 'repo-search' });
    await expect(pluginRow).toHaveCount(1);
    await pluginRow.getByRole('checkbox').check();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const strip = home.getByTestId('mcp-sign-in-strip');
    await expect(strip.getByTestId('mcp-sign-in-strip-summary')).toContainText(
      'repo-search',
    );
    const row = strip.getByTestId('mcp-servers-card-row').filter({
      has: window
        .getByTestId('mcp-servers-card-name')
        .filter({ hasText: /^repo-search$/ }),
    });
    await expect(row.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Not signed in',
    );
    await expect(row.getByTestId('mcp-servers-card-connect')).toHaveCount(0);
    await row.getByTestId('mcp-sign-in-strip-open-settings').click();
    await expect(window.getByTestId('settings-tab-mcp')).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
