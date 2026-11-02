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
import {
  getAvailablePort,
  startOAuthFixtureServer,
} from './mcpOauthCallbackFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedCuratedPlugins } from './seeders/seedCuratedPlugins.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

// REG-3029: Home prompts sign-in for the MCP servers a new task attaches,
// before a chat exists. The account connections come from the
// `accountMcpCloud` fixture, which also finishes each browser sign-in on
// request, so the whole flow runs without a live MCP server or browser.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const NOW = new Date().toISOString();

async function completeLocalFixture(reopen) {
  const url = await reopen.getAttribute('href');
  expect(url).toBeTruthy();
  const consent = await (await fetch(url)).text();
  const callback = consent
    .match(/id="authorize" href="([^"]+)"/)?.[1]
    ?.replaceAll('&amp;', '&');
  expect(callback).toBeTruthy();
  await fetch(callback);
}

test('Activity navigates to the exact plugin member and retries sign-in after the canonical route save', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-mcp-save-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({ userDataDir, servers: [] });
  const seeded = seedCuratedPlugins({ userDataDir });
  const fixture = await startOAuthFixtureServer();
  const callbackPort = await getAvailablePort();
  writeJson(path.join(seeded.marketplaceDir, 'repo-search', '.mcp.json'), {
    mcpServers: {
      'repo-search': {
        type: 'http',
        url: 'https://mcp.vendor.test/mcp',
        oauth: {
          clientId: 'fixture',
          callbackPort,
          authorizationUrl: `${fixture.baseUrl}/authorize`,
          tokenUrl: `${fixture.baseUrl}/token`,
          usePkce: true,
        },
      },
    },
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { mcpHttpAuthDefaultHandler: 'account' },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'mcp-sign-in',
        title: 'MCP sign-in',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'curated/cloud', pluginName: 'repo-search' },
          ],
        },
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
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const signIn = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
    );
    expect(signIn.status.authenticated).toBe(true);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const card = window.getByTestId('activity-section-mcp-servers');
    const row = card
      .getByTestId('mcp-servers-card-row')
      .filter({ hasText: 'repo-search' })
      .first();
    await row.getByTestId('mcp-servers-card-name').click();
    await expect(
      window
        .getByTestId('plugin-detail-host')
        .getByRole('heading', { name: 'Repo Search', exact: true }),
    ).toBeVisible();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await row.getByTestId('mcp-servers-card-settings').click();
    await expect(
      window.locator('[data-mcp-member="repo-search"]'),
    ).toBeFocused();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await row.getByTestId('mcp-servers-card-connect').click();
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Sign in', exact: true })
      .click();
    // The real chat writer publishes tab.metadata_patched before its reply.
    // That publication must count as acceptance so OAuth can start.
    await expect(
      card.getByTestId('mcp-servers-card-sign-in-reopen'),
    ).toBeVisible();
    await expect(window.getByTestId('mcp-sign-in-strip-error')).toHaveCount(0);
    const tabs = await window.evaluate(
      (projectId) =>
        window.api.chat.loadTabs({
          projectId,
          worktreeId: 'demo-main',
        }),
      WORKSPACE_ID,
    );
    expect(
      tabs.tabs.find((tab) => tab.id === 'mcp-sign-in')?.pluginSelections
        ?.mcpHttpAuthPreferences,
    ).toContainEqual({
      target: {
        kind: 'plugin',
        marketplaceId: 'curated/cloud',
        pluginName: 'repo-search',
        serverName: 'repo-search',
      },
      handler: 'canopy',
    });
    await card.getByTestId('mcp-servers-card-sign-in-cancel').click();
    await expect(row.getByTestId('mcp-servers-card-connect')).toBeEnabled();
    await row.getByTestId('mcp-servers-card-connect').click();
    // Retry retains the accepted task route: no second routing confirmation.
    await expect(
      window.getByRole('dialog').filter({ hasText: 'Sign in on this desktop' }),
    ).toHaveCount(0);
    const reopen = card.getByTestId('mcp-servers-card-sign-in-reopen');
    await expect(reopen).toBeVisible();
    await completeLocalFixture(reopen);
    await expect(row.getByTestId('mcp-servers-card-connect')).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(fixture.tokenRequests.length).toBeGreaterThan(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
    await new Promise((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const homeAccountSignIn = (removeDuringRead) => async () => {
  test.setTimeout(150_000);
  const deviceNavigation = removeDuringRead === 'device-navigation';
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
  seedMcpServers({
    userDataDir,
    servers: deviceNavigation
      ? [
          {
            definition: {
              id: 'notes-fixture',
              name: 'Notes',
              description: '',
              type: 'http',
              url: 'https://notes.example.test/mcp',
              oauth: {},
              httpAuthHandler: 'canopy',
              createdAt: NOW,
              updatedAt: NOW,
            },
            configs: [
              {
                id: 'notes-work',
                name: 'Work',
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
        ]
      : [],
  });
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
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_account_mcp_fixture',
      }),
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
    for (const name of deviceNavigation
      ? ['Notes']
      : ['Account GitHub', 'Team Tools']) {
      const row = picker.locator('tr').filter({ hasText: name });
      await expect(row).toHaveCount(1);
      await row.getByRole('checkbox').check();
    }
    await expect(strip).toHaveCount(0);
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    if (deviceNavigation) {
      for (const control of [
        'mcp-servers-card-name',
        'mcp-servers-card-settings',
      ]) {
        const notes = strip
          .getByTestId('mcp-servers-card-row')
          .filter({ hasText: 'Notes' });
        await notes.getByTestId(control).click();
        await expect(window.locator('#plugins-entry-detail-title')).toHaveText(
          'Notes',
        );
        await app.openHomeForProject(WORKSPACE_ID);
      }
      expect(cloud.calls.filter((call) => call.method === 'POST')).toHaveLength(
        0,
      );
      return;
    }

    await expect(strip.getByTestId('mcp-sign-in-strip-summary')).toHaveText(
      'Sign in to use Account GitHub and Team Tools',
    );
    const rows = strip.getByTestId('mcp-servers-card-row');
    const github = rows.filter({ hasText: 'Account GitHub' });
    const tools = rows.filter({ hasText: 'Team Tools' });
    await expect(github.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Sign-in needed',
    );
    await expect(tools.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Sign-in needed',
    );
    // Sending stays available while servers still need sign-in.
    await home.getByTestId('home-composer-editor').fill('Summarize my issues');
    await expect(home.getByTestId('home-send-button')).toBeEnabled();

    if (removeDuringRead) {
      const connections = await window.evaluate(() =>
        window.mcpServers.listAccountConnections(),
      );
      await electronApp.evaluate(({ ipcMain }, saved) => {
        let held = false;
        ipcMain.removeHandler('mcp-servers:list-account-connections');
        ipcMain.handle('mcp-servers:list-account-connections', () => {
          if (held) return saved;
          held = true;
          globalThis.__CAN4760_ACCOUNT_READ_PENDING__ = true;
          return new Promise((resolve) => {
            globalThis.__CAN4760_RELEASE_ACCOUNT_READ__ = () => resolve(saved);
          });
        });
      }, connections);
      await github.getByTestId('mcp-servers-card-connect').click();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__CAN4760_ACCOUNT_READ_PENDING__,
          ),
        )
        .toBe(true);
      await home.getByTestId('home-composer-plus-button').click();
      await window.getByTestId('home-plugins-button').click();
      await picker
        .locator('tr')
        .filter({ hasText: 'Account GitHub' })
        .getByRole('checkbox')
        .uncheck();
      await picker.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(github).toHaveCount(0);
      await electronApp.evaluate(() =>
        globalThis.__CAN4760_RELEASE_ACCOUNT_READ__(),
      );
      await expect(home.getByTestId('mcp-sign-in-strip-error')).toContainText(
        'plugins changed',
      );
      expect(cloud.calls.filter((call) => call.method === 'POST')).toHaveLength(
        0,
      );
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        'Summarize my issues',
      );
      return;
    }
    await github.getByTestId('mcp-servers-card-connect').click();
    await expect(github.getByTestId('mcp-sign-in-strip-waiting')).toContainText(
      'Waiting for sign-in',
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
      'Connected',
      { timeout: 20_000 },
    );
    await expect(github.getByTestId('mcp-servers-card-connect')).toHaveCount(0);
    await expect(strip.getByTestId('mcp-sign-in-strip-summary')).toHaveText(
      'Sign in to use Team Tools',
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
};

test(
  'Home prompts sign-in for attached account MCP servers until they connect',
  homeAccountSignIn(false),
);
test(
  'Home does not start account sign-in after deselection during its account read',
  homeAccountSignIn(true),
);
test(
  'Home opens a device MCP server from its name and settings',
  homeAccountSignIn('device-navigation'),
);

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
      'Waiting for sign-in',
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

// An unbound plugin uses the existing desktop route only after explicit consent.
test('Home confirms the desktop route and signs an unbound plugin in without losing its draft', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-mcp-sign-in-plugin-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({ userDataDir, servers: [] });
  const fixture = await startOAuthFixtureServer();
  const callbackPort = await getAvailablePort();
  const seeded = seedCuratedPlugins({
    userDataDir,
    pluginDefs: [
      {
        key: 'repo-search',
        displayName: 'Repo Search',
        shortDescription: 'Search a repository',
        version: '1.0.0',
        authorName: 'Fixture',
        category: 'developer-tools',
        docsUrl: 'https://example.test/repo-search',
        skill: null,
        mcpServer: { key: 'repo-search', url: 'https://mcp.vendor.test/mcp' },
      },
    ],
  });
  writeJson(path.join(seeded.marketplaceDir, 'repo-search', '.mcp.json'), {
    mcpServers: {
      'repo-search': {
        type: 'http',
        url: 'https://mcp.vendor.test/mcp',
        oauth: {
          clientId: 'fixture',
          callbackPort,
          authorizationUrl: `${fixture.baseUrl}/authorize`,
          tokenUrl: `${fixture.baseUrl}/token`,
          usePkce: true,
        },
      },
    },
  });
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
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const signIn = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
    );
    expect(signIn.status.authenticated).toBe(true);

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
    const row = strip
      .getByTestId('mcp-servers-card-row')
      .filter({
        has: window
          .getByTestId('mcp-servers-card-name')
          .filter({ hasText: /^repo-search/ }),
      })
      .first();
    const service = await row
      .getByTestId('mcp-servers-card-name')
      .textContent();
    await expect(row.getByTestId('mcp-servers-card-badge')).toHaveText(
      'Sign-in needed',
    );
    await home
      .getByTestId('home-composer-editor')
      .fill('Search without losing this draft');
    await row.getByTestId('mcp-servers-card-name').click();
    await expect(
      window
        .getByTestId('plugin-detail-host')
        .getByRole('heading', { name: 'Repo Search', exact: true }),
    ).toBeVisible();
    await app.openHomeForProject(WORKSPACE_ID);
    await expect(home.getByTestId('home-composer-editor')).toContainText(
      'Search without losing this draft',
    );
    await row.getByTestId('mcp-servers-card-settings').click();
    await expect(
      window.locator('[data-mcp-member="repo-search"]'),
    ).toBeFocused();
    await app.openHomeForProject(WORKSPACE_ID);
    await row.getByTestId('mcp-servers-card-connect').click();
    const confirmation = window
      .getByRole('dialog')
      .filter({ hasText: 'Sign in on this desktop' });
    await expect(confirmation).toContainText('web chats aren’t affected');
    await confirmation
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    expect(
      await electronApp.evaluate(
        () => globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__ ?? null,
      ),
    ).toBeNull();
    await row.getByTestId('mcp-servers-card-connect').click();
    await confirmation
      .getByRole('button', { name: 'Sign in', exact: true })
      .click();
    await expect(
      row.getByTestId('mcp-servers-card-sign-in-reopen'),
    ).toBeVisible();
    const authUrl = await row
      .getByTestId('mcp-servers-card-sign-in-reopen')
      .getAttribute('href');
    const consent = await (await fetch(authUrl)).text();
    const callback = consent
      .match(/id="authorize" href="([^"]+)"/)?.[1]
      ?.replaceAll('&amp;', '&');
    expect(callback).toBeTruthy();
    await fetch(callback);
    // A distinct provider declaration may keep a separate credential namespace.
    await expect
      .poll(async () => strip.getByTestId('mcp-servers-card-connect').count())
      .toBeLessThan(2);
    if (await strip.getByTestId('mcp-servers-card-connect').count()) {
      await strip.getByTestId('mcp-servers-card-connect').first().click();
      const reopen = strip.getByTestId('mcp-servers-card-sign-in-reopen');
      await expect(reopen).toBeVisible();
      const providerConsent = await (
        await fetch(await reopen.getAttribute('href'))
      ).text();
      const providerCallback = providerConsent
        .match(/id="authorize" href="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&');
      expect(providerCallback).toBeTruthy();
      await fetch(providerCallback);
    }
    await expect(strip).toHaveCount(0, { timeout: 20_000 });
    expect(fixture.tokenRequests.length).toBeGreaterThan(0);
    await expect(home.getByTestId('home-composer-editor')).toContainText(
      'Search without losing this draft',
    );
    const exchanges = fixture.tokenRequests.length;
    for (const selected of [false, true]) {
      await home.getByTestId('home-composer-plus-button').click();
      await window.getByTestId('home-plugins-button').click();
      await pluginRow.getByRole('checkbox').setChecked(selected);
      await picker.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(picker).toHaveCount(0);
      await expect(strip).toHaveCount(0);
    }
    expect(fixture.tokenRequests).toHaveLength(exchanges);
    await expect(home.getByTestId('home-composer-editor')).toContainText(
      'Search without losing this draft',
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
    await new Promise((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
