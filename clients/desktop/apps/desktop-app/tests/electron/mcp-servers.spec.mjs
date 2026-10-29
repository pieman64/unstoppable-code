import {
  ACCOUNT_MCP_FIXTURE_SIGN_IN_PATH,
  CUSTOM_ACCOUNT_MCP_ID,
  startAccountMcpCloud,
} from './fixtures/accountMcpCloud.mjs';
import { mkdtempSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  getAvailablePort,
  seedVendorOAuthCatalog,
  startOAuthFixtureServer,
} from './mcpOauthCallbackFixture.mjs';

// Doc 3 — G7: Plugins → MCP Servers add / edit / remove.
//
// Exercises the standalone MCP server CRUD surface (`McpServersTab.tsx`) end to
// end through the real local-file IPC handlers in
// `apps/desktop-app/src/main/ipc/mcp-servers.ts`. The create flow uses a
// `command` server with `npx` (which is in the main-process command allowlist),
// then verifies custom HTTP OAuth callback-port persistence. Saving never
// spawns either server process. The test never clicks Health Check / Test
// Connection. Mount reads cached status without contacting either server.

const SERVER_NAME = 'E2E Postgres MCP';
const RENAMED_SERVER_NAME = 'E2E Renamed MCP';
const OAUTH_SERVER_NAME = 'E2E OAuth MCP';

test('Plugins → MCP Servers supports add, edit, and remove', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // Navigate to Plugins → MCP tab.
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');

    const panel = window.getByTestId('plugins-management-section-mcp');

    // Empty state on a fresh data dir.
    await expect(panel.getByText('No MCP servers registered')).toBeVisible();

    // --- Add a new server -------------------------------------------------
    // The e2e runs unauthenticated → the curated catalog is empty, so the
    // toolbar renders the plain "Add custom" button (the dropdown only appears
    // when the catalog is non-empty).
    await panel
      .getByRole('button', { name: 'Add custom', exact: true })
      .click();

    const dialog = window.getByRole('dialog', { name: 'New MCP server' });
    await expect(
      dialog.getByRole('heading', { name: 'New MCP server' }),
    ).toBeVisible();

    // HTTP is the default; command servers remain available explicitly.
    await dialog.getByRole('button', { name: 'Command', exact: true }).click();
    await dialog.getByPlaceholder('My MCP server').fill(SERVER_NAME);
    await dialog.getByPlaceholder('npx').fill('npx');
    await dialog
      .getByPlaceholder('-y @modelcontextprotocol/server-postgres')
      .fill('-y @modelcontextprotocol/server-postgres');

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Dialog closes and the new row renders in the table.
    await expect(
      window.getByRole('dialog', { name: 'New MCP server' }),
    ).toBeHidden();
    const serverRow = panel.locator('tr', { hasText: SERVER_NAME });
    await expect(serverRow).toBeVisible();
    await expect(panel.getByText('1 server', { exact: true })).toBeVisible();

    // --- Edit the server name (via the Actions column edit button) --------
    await serverRow.getByTestId('mcp-server-edit-button').click();
    const editDialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(
      editDialog.getByRole('heading', { name: 'Edit MCP server' }),
    ).toBeVisible();

    const nameInput = editDialog.getByPlaceholder('My MCP server');
    await expect(nameInput).toHaveValue(SERVER_NAME);
    await nameInput.fill(RENAMED_SERVER_NAME);
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(
      window.getByRole('dialog', { name: 'Edit MCP server' }),
    ).toBeHidden();
    await expect(
      panel.locator('tr', { hasText: RENAMED_SERVER_NAME }),
    ).toBeVisible();
    await expect(panel.getByText(SERVER_NAME, { exact: true })).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('mcp-servers-after-edit.png'),
    });

    // --- Delete the server -----------------------------------------------
    await panel.locator('tr', { hasText: RENAMED_SERVER_NAME }).click();
    const deleteDialog = window.getByRole('dialog', {
      name: 'Edit MCP server',
    });
    await deleteDialog
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    // Inline confirm appears in the footer.
    await expect(deleteDialog.getByText('Are you sure?')).toBeVisible();
    await deleteDialog
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();

    await expect(deleteDialog).toBeHidden();

    // Back to the empty state.
    await expect(panel.getByText('No MCP servers registered')).toBeVisible();
    await expect(
      panel.locator('tr', { hasText: RENAMED_SERVER_NAME }),
    ).toHaveCount(0);

    // --- Persist a dedicated OAuth callback port -------------------------
    await panel
      .getByRole('button', { name: 'Add custom', exact: true })
      .click();
    const oauthDialog = window.getByRole('dialog', { name: 'New MCP server' });
    await oauthDialog
      .getByRole('button', { name: 'HTTP', exact: true })
      .click();
    await oauthDialog.getByPlaceholder('My MCP server').fill(OAUTH_SERVER_NAME);
    await oauthDialog
      .getByPlaceholder('https://mcp.example.com/sse')
      .fill('http://127.0.0.1:1/mcp');
    await oauthDialog.getByTestId('mcp-server-use-oauth').check();
    await oauthDialog
      .getByRole('button', { name: 'Show advanced OAuth overrides' })
      .click();
    await oauthDialog
      .getByTestId('mcp-server-oauth-callback-port')
      .fill('3118');
    await oauthDialog
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(oauthDialog).toBeHidden();

    const oauthRow = panel.locator('tr', { hasText: OAUTH_SERVER_NAME });
    await expect(oauthRow).toBeVisible();
    await oauthRow.getByTestId('mcp-server-edit-button').click();
    const oauthEditDialog = window.getByRole('dialog', {
      name: 'Edit MCP server',
    });
    await expect(
      oauthEditDialog.getByTestId('mcp-server-oauth-callback-port'),
    ).toHaveValue('3118');

    await oauthEditDialog
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(oauthEditDialog.getByText('Are you sure?')).toBeVisible();
    await oauthEditDialog
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(oauthEditDialog).toBeHidden();
    await expect(panel.getByText('No MCP servers registered')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('vendor-registered MCP OAuth callback serves the branded completion page', async () => {
  test.setTimeout(120_000);

  const fixture = await startOAuthFixtureServer({
    failFirstTokenRequest: true,
  });
  const callbackPort = await getAvailablePort();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mcp-oauth-callback-'),
  );
  seedVendorOAuthCatalog(userDataDir, callbackPort, fixture.baseUrl);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');

    const panel = window.getByTestId('plugins-management-section-mcp');
    await panel.getByTestId('mcp-add-menu-trigger').click();
    await window.getByTestId('mcp-add-browse').click();
    await window
      .getByTestId('mcp-browse-card')
      .filter({ hasText: 'Vendor OAuth Callback' })
      .click();
    await window.getByTestId('mcp-browse-detail-add').click();

    const addDialog = window.getByRole('dialog', { name: 'New MCP server' });
    await expect(addDialog.getByTestId('mcp-server-use-oauth')).toBeChecked();
    await addDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(addDialog).toBeHidden();

    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'mcp-servers', 'index.json'), 'utf8'),
    );
    const oauthEntry = index.servers.find(
      (entry) => entry.name === 'Vendor OAuth Callback',
    );
    expect(oauthEntry).toBeTruthy();
    const serverId = oauthEntry.id;
    const configId = oauthEntry.configs[0].id;
    const encrypted = await electronApp.evaluate(({ safeStorage }) => ({
      access: safeStorage
        .encryptString('stale-access-token')
        .toString('base64'),
      refresh: safeStorage
        .encryptString('rejected-or-foreign-refresh-token')
        .toString('base64'),
    }));
    writeJson(path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json'), {
      version: 1,
      records: {
        [`${serverId}:${configId}`]: {
          serverId,
          configId,
          encryptedAccessTokenBase64: encrypted.access,
          encryptedRefreshTokenBase64: encrypted.refresh,
          upstreamUrl: 'https://mcp.vendor.test/mcp',
          clientId: 'vendor-client',
          tokenUrl: `${fixture.baseUrl}/token`,
          tokenType: 'Bearer',
          expiresAt: '2000-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const row = panel.locator('tr', { hasText: 'Vendor OAuth Callback' });
    await row.getByTestId('mcp-server-edit-button').click();
    const editDialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    await editDialog.getByTestId('mcp-server-connect').click();
    const authorizationUrl = await expect
      .poll(() =>
        electronApp.evaluate(() =>
          String(globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__ ?? ''),
        ),
      )
      .toMatch(/\/authorize\?/)
      .then(() =>
        electronApp.evaluate(() =>
          String(globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__ ?? ''),
        ),
      );

    const launchedAuthorizationUrl = new URL(authorizationUrl);
    const callbackUrl = new URL(
      launchedAuthorizationUrl.searchParams.get('redirect_uri') ?? '',
    );
    expect(callbackUrl.hostname).toBe('localhost');
    expect(callbackUrl.pathname).toBe('/callback');
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set(
      'state',
      launchedAuthorizationUrl.searchParams.get('state') ?? '',
    );
    callbackUrl.searchParams.set('code', 'e2e-auth-code');

    const response = await fetch(callbackUrl);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('<h1>Connected</h1>');
    expect(html).toContain('can now use this server.');
    expect(html).toContain('<p class="detail">OAuth sign-in completed.</p>');
    expect(html).toContain("history.replaceState({}, '', location.pathname)");

    const stored = JSON.parse(
      readFileSync(
        path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json'),
        'utf8',
      ),
    ).records[`${serverId}:${configId}`];
    expect(stored.encryptedRefreshTokenBase64).toBeUndefined();
    const savedAccessToken = await electronApp.evaluate(
      ({ safeStorage }, encryptedAccessTokenBase64) =>
        safeStorage.decryptString(
          Buffer.from(encryptedAccessTokenBase64, 'base64'),
        ),
      stored.encryptedAccessTokenBase64,
    );
    expect(savedAccessToken).toBe('e2e-access-token');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    fixture.server.closeAllConnections?.();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

// Computed at run time: the curated-catalog loader rejects cached data older
// than one hour, so a frozen timestamp would silently expire the fixture.
const NOW = new Date().toISOString();

function curatedCatalogEntry(key, name, sortOrder) {
  return {
    key,
    name,
    shortDescription: `${name} integration`,
    longDescription: `Connect to ${name}.`,
    url: `https://${key}.example.test/mcp`,
    transport: 'http',
    categories: ['development'],
    popular: sortOrder === 0,
    sortOrder,
    updatedAt: NOW,
  };
}

function installedCuratedServer(id, entry) {
  return {
    definition: {
      id,
      name: entry.name,
      description: entry.shortDescription,
      type: 'http',
      url: entry.url,
      curated: { key: entry.key },
      httpAuthHandler: 'provider',
      createdAt: NOW,
      updatedAt: NOW,
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
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function toolsSourceFingerprint(server) {
  const { definition, configs } = server;
  const config = configs[0];
  return createHash('sha256')
    .update(
      JSON.stringify({
        definition: {
          type: definition.type,
          command: definition.command,
          args: definition.args,
          url: definition.url,
          headers: definition.headers,
          oauth: definition.oauth,
          httpAuthHandler: definition.httpAuthHandler,
        },
        config: {
          enabled: config.enabled,
          envVars: config.envVars,
          extraArgs: config.extraArgs,
          extraHeaders: config.extraHeaders,
          authToken: config.authToken,
        },
        oauthRevision: 'missing',
        handler: definition.httpAuthHandler,
      }),
    )
    .digest('hex');
}

test('curated MCP details render host-fed tools and getTools failures', async () => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-curated-mcp-tools-'),
  );
  const resolvedEntry = curatedCatalogEntry('github-tools', 'GitHub Tools', 0);
  const failingEntry = curatedCatalogEntry('broken-tools', 'Broken Tools', 1);
  const resolvedServer = installedCuratedServer(
    'github-tools-server',
    resolvedEntry,
  );
  const failingServer = installedCuratedServer(
    'broken-tools-server',
    failingEntry,
  );
  const seeded = seedMcpServers({
    userDataDir,
    servers: [resolvedServer, failingServer],
  });

  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [resolvedEntry, failingEntry],
  });
  writeJson(path.join(userDataDir, 'mcp-servers', 'tools-cache.json'), {
    version: 1,
    entries: {
      'github-tools-server:default': {
        tools: ['search_issues', 'create_pull_request'],
        discoveredAt: NOW,
        sourceFingerprint: toolsSourceFingerprint(resolvedServer),
      },
    },
  });

  // Preserve the installed index row while making the real getTools IPC fail
  // deterministically when it tries to read this server's detail file.
  unlinkSync(seeded.serverFilePaths['broken-tools-server']);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');

    const panel = window.getByTestId('plugins-management-section-mcp');
    await panel.getByTestId('mcp-add-menu-trigger').click();
    await window.getByTestId('mcp-add-browse').click();

    const dialog = window.getByTestId('mcp-browse-dialog');
    await dialog
      .getByTestId('mcp-browse-card')
      .filter({ hasText: 'GitHub Tools' })
      .click();

    const resolvedDetail = window.getByTestId('mcp-browse-detail');
    await expect(resolvedDetail.getByTestId('mcp-browse-tool-chip')).toHaveText(
      ['search_issues', 'create_pull_request'],
    );

    // The browse dialog has no back-to-catalog control — drilling in is
    // one-way and the only exit is closing the dialog. Close and reopen to
    // reach the failing entry.
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await panel.getByTestId('mcp-add-menu-trigger').click();
    await window.getByTestId('mcp-add-browse').click();
    await window
      .getByTestId('mcp-browse-dialog')
      .getByTestId('mcp-browse-card')
      .filter({ hasText: 'Broken Tools' })
      .click();

    const failingDetail = window.getByTestId('mcp-browse-detail');
    await expect(
      failingDetail.getByTestId('mcp-browse-tools-error'),
    ).toHaveText('Unable to load tools.');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('refreshable OAuth access does not show an expired account in activity or details', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, window, section } =
    await launchMcpAuthStatusFixture();
  try {
    await expect(
      section.getByText('Renews automatically', { exact: true }),
    ).toBeVisible();
    await expect(section.getByText('Expired', { exact: true })).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: /^(Refresh|Reconnect|Connect)$/ }),
    ).toHaveCount(0);
    await section.getByRole('button', { name: 'Refreshable Account' }).click();
    const dialog = window.getByRole('dialog');
    await expect(
      dialog.getByText('Renews automatically', { exact: true }),
    ).toBeVisible();
    // A credential change can originate in another surface while this dialog is open.
    await window.evaluate(() =>
      window.mcpServers.clearOAuthToken({
        serverId: 'aabbcc',
        configId: 'ddeeff',
      }),
    );
    await expect(dialog.getByText('Needs auth', { exact: true })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(
      section.getByText('Needs auth', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an open MCP activity card updates when renewable access expires', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, section } =
    await launchMcpAuthStatusFixture({ expiresInMs: 10_000 });
  try {
    await expect(section.getByText('Connected', { exact: true })).toBeVisible();
    await expect(
      section.getByRole('button', { name: /^(Refresh|Reconnect|Connect)$/ }),
    ).toHaveCount(0);
    await expect(
      section.getByText('Renews automatically', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      section.getByRole('button', { name: /^(Refresh|Reconnect|Connect)$/ }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('plain HTTP MCP stays no-auth when secure storage is unavailable', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, section } =
    await launchMcpAuthStatusFixture({
      plainHttp: true,
      secureStorageUnavailable: true,
    });
  try {
    await expect(
      section.getByText('Not checked', { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Reconnect', exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const state of [{ lastError: 'invalid_grant' }, { canRefresh: false }]) {
  test(`MCP offers Reconnect only when silent renewal needs authorization: ${JSON.stringify(state)}`, async () => {
    test.setTimeout(120_000);
    const { launchMcpAuthStatusFixture } =
      await import('./mcpAuthStatusFixture.mjs');
    const { electronApp, userDataDir, window, section } =
      await launchMcpAuthStatusFixture(state);
    try {
      await expect(
        section.getByRole('button', { name: 'Reconnect', exact: true }),
      ).toBeVisible();
      await expect(
        section.getByRole('button', { name: 'Refresh', exact: true }),
      ).toHaveCount(0);
      await section
        .getByRole('button', { name: 'Refreshable Account' })
        .click();
      await expect(
        window.getByTestId('mcp-server-details-auth-badge'),
      ).toHaveText(state.lastError ?? 'Expired');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Reconnect keeps polling past the error that preceded the new login attempt', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, section } =
    await launchMcpAuthStatusFixture({ lastError: 'invalid_grant' });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__mcpReconnectFixtureConnected = false;
      const detectedServer = () => ({
        key: 'standalone:aabbcc:ddeeff',
        source: 'standalone',
        serverName: 'aabbcc',
        displayName: 'Refreshable Account',
        description: 'Account with renewable access',
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        serverId: 'aabbcc',
        configId: 'ddeeff',
        configName: 'Default',
        enabled: true,
        authStatus: globalThis.__mcpReconnectFixtureConnected
          ? 'connected'
          : 'error',
        authStatusLabel: globalThis.__mcpReconnectFixtureConnected
          ? 'Connected'
          : 'Error',
        canConnect: !globalThis.__mcpReconnectFixtureConnected,
        connectLabel: globalThis.__mcpReconnectFixtureConnected
          ? undefined
          : 'Reconnect',
        lastError: globalThis.__mcpReconnectFixtureConnected
          ? undefined
          : 'stale-error-fixture',
        authErrorRevision: globalThis.__mcpReconnectFixtureConnected
          ? undefined
          : 'stale-error-revision',
      });
      ipcMain.removeHandler('mcp-servers:list-detected');
      ipcMain.handle('mcp-servers:list-detected', () => ({
        servers: [detectedServer()],
        warnings: [],
      }));
      ipcMain.removeHandler('mcp-servers:start-oauth-login');
      ipcMain.handle('mcp-servers:start-oauth-login', () => ({
        status: 'started',
        authorizationUrl: 'https://example.test/authorize',
      }));
    });

    await section.getByLabel('Refresh MCP servers').click();
    await expect(
      section.getByText('stale-error-fixture', { exact: true }),
    ).toBeVisible();
    const reconnect = section.getByTestId('mcp-servers-card-connect');
    await expect(reconnect).toHaveText('Reconnect');
    await reconnect.click();
    await expect(reconnect).toHaveText('Connecting…');
    await expect(reconnect).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await expect(reconnect).toHaveText('Connecting…');
    await expect(reconnect).toBeDisabled();

    await electronApp.evaluate(() => {
      globalThis.__mcpReconnectFixtureConnected = true;
    });
    await expect(section.getByText('Connected', { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('MCP details credit an official plugin server to its product vendor', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, window, section } =
    await launchMcpAuthStatusFixture({});
  try {
    // A server contributed by OpenAI's official GitHub listing. The feed names
    // OpenAI as the listing's author, on the Codex facet as well as the row,
    // while every plugin surface credits GitHub.
    await electronApp.evaluate(({ ipcMain }) => {
      const iso = '2026-08-27T00:00:00.000Z';
      ipcMain.removeHandler('mcp-servers:list-detected');
      ipcMain.handle('mcp-servers:list-detected', () => ({
        servers: [
          {
            key: 'plugin:openai-curated:github:github',
            source: 'plugin',
            serverName: 'github',
            displayName: 'GitHub',
            description: 'GitHub tools from the official listing',
            type: 'http',
            url: 'https://mcp.example.test/github',
            marketplaceId: 'openai-curated',
            pluginName: 'github',
            pluginServerName: 'github',
            pluginProvider: 'codex',
            enabled: true,
            authStatus: 'connected',
            authStatusLabel: 'Connected',
            canConnect: false,
          },
        ],
        warnings: [],
      }));
      ipcMain.removeHandler('plugins:load');
      ipcMain.handle('plugins:load', () => ({
        success: true,
        data: {
          version: 2,
          lastRefreshed: iso,
          marketplaces: [
            {
              id: 'openai-curated',
              name: 'Codex official',
              sourceType: 'github',
              sourceUrl: 'https://github.invalid/openai/curated',
              installLocation: '/tmp/openai-curated',
              lastUpdated: iso,
              pluginCount: 1,
              plugins: [
                {
                  name: 'github',
                  displayName: 'GitHub',
                  version: '0.1.4',
                  author: 'OpenAI',
                  category: 'Developer Tools',
                  sourcePath: '',
                  marketplaceId: 'openai-curated',
                  providerSupport: { claude: 'none', codex: 'native' },
                  facets: {
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'github',
                      author: 'OpenAI',
                      installLocation: '/tmp/openai-curated/plugins/github',
                      sourcePath: '/tmp/openai-curated/plugins/github',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: iso,
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: iso,
                },
              },
              validProviders: ['codex'],
            },
          ],
        },
      }));
    });

    await section.getByLabel('Refresh MCP servers').click();
    await section.getByRole('button', { name: 'GitHub' }).click();

    const pluginSection = window.getByTestId(
      'mcp-server-details-plugin-section',
    );
    await expect(pluginSection).toBeVisible();
    const author = pluginSection
      .locator('dt', { hasText: 'Author:' })
      .locator('xpath=following-sibling::dd[1]');
    await expect(author).toHaveText('GitHub');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opening MCP management reads status without probing accounts; Health Check stays explicit', async () => {
  test.setTimeout(120_000);
  const { launchMcpAuthStatusFixture } =
    await import('./mcpAuthStatusFixture.mjs');
  const { electronApp, userDataDir, window, app } =
    await launchMcpAuthStatusFixture();
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__mcpPassiveHealthCalls = 0;
      ipcMain.removeHandler('mcp-servers:check-health');
      ipcMain.handle(
        'mcp-servers:check-health',
        (_event, serverId, configId) => {
          globalThis.__mcpPassiveHealthCalls += 1;
          return {
            serverId,
            configId,
            status: 'healthy',
            message: 'Explicit fixture check completed',
            checkedAt: new Date().toISOString(),
          };
        },
      );
    });
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    const row = window
      .getByTestId('plugins-management-section-mcp')
      .locator('tr', { hasText: 'Refreshable Account' });
    await expect(row).toBeVisible();
    await row.getByTestId('mcp-server-edit-button').click();
    const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(
      dialog.getByRole('button', { name: 'Health check', exact: true }),
    ).toBeVisible();
    expect(
      await electronApp.evaluate(() => globalThis.__mcpPassiveHealthCalls),
    ).toBe(0);
    await dialog
      .getByRole('button', { name: 'Health check', exact: true })
      .click();
    await expect(
      dialog.getByText('Explicit fixture check completed'),
    ).toBeVisible();
    expect(
      await electronApp.evaluate(() => globalThis.__mcpPassiveHealthCalls),
    ).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Test Connection contains a broken MCP stdin pipe', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-mcp-pipe-'));
  const now = new Date().toISOString();
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: '28180000-0000-4000-8000-000000000001',
          name: 'Pipe Failure Fixture',
          description: '',
          type: 'command',
          command: 'npx',
          args: ['can-2818-pipe-fixture'],
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: '28180000-0000-4000-8000-000000000002',
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
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await electronApp.evaluate((_, faultPath) => {
      const fs = process.getBuiltinModule('fs');
      process.on('uncaughtExceptionMonitor', (error) => {
        fs.appendFileSync(faultPath, `${error.stack}\n`);
      });
      const cp = process.getBuiltinModule('child_process');
      const spawn = cp.spawn;
      cp.spawn = function (...args) {
        if (!args[1]?.includes('can-2818-pipe-fixture')) return spawn(...args);
        const child = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => {}, 15000)'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        );
        child.stdin.write = () => {
          if (!globalThis.__can2818McpArmed) return true;
          fs.appendFileSync(faultPath, 'Injected MCP stdin EOF\n');
          setImmediate(() =>
            child.stdin.destroy(
              Object.assign(new Error('write EOF'), {
                code: 'EOF',
                syscall: 'write',
              }),
            ),
          );
          return true;
        };
        return child;
      };
    }, testInfo.outputPath('pipe-fault.log'));
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    const panel = window.getByTestId('plugins-management-section-mcp');
    await panel
      .locator('tr', { hasText: 'Pipe Failure Fixture' })
      .getByTestId('mcp-server-edit-button')
      .click();
    const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(
      dialog.getByRole('button', { name: 'Test connection', exact: true }),
    ).toBeEnabled();
    await electronApp.evaluate(() => {
      globalThis.__can2818McpArmed = true;
    });
    await dialog
      .getByRole('button', { name: 'Test connection', exact: true })
      .click();
    await expect(dialog.getByText('write EOF', { exact: false })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Test connection', exact: true }),
    ).toBeEnabled();
    expect(readFileSync(testInfo.outputPath('pipe-fault.log'), 'utf8')).toBe(
      'Injected MCP stdin EOF\n',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const choice of ['', 'provider', 'canopy']) {
  test(`index-owned account routing can be cleared with ${choice || 'Use default'}`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-mcp-index-auth-'),
    );
    const server = installedCuratedServer(
      '30670000-0000-4000-8000-000000000001',
      curatedCatalogEntry('index-account', 'Index account server', 0),
    );
    delete server.definition.curated;
    delete server.definition.httpAuthHandler;
    const seeded = seedMcpServers({ userDataDir, servers: [server] });
    writeJson(seeded.indexFilePath, {
      ...seeded.index,
      servers: seeded.index.servers.map((entry) => ({
        ...entry,
        scope: 'account',
        authHandler: 'account',
        accountConnectionId: 'account-1',
      })),
    });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { mcpHttpAuthDefaultHandler: 'canopy' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      expect(
        await window.evaluate(
          (id) => window.mcpServers.loadServer(id),
          server.definition.id,
        ),
      ).toMatchObject({ server });
      await app.openPluginsPage();
      await app.openPluginsTab('mcp');
      const row = window
        .getByTestId('plugins-management-section-mcp')
        .locator('tr', { hasText: server.definition.name });
      await row.getByTestId('mcp-server-edit-button').click();
      const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
      await expect(
        dialog.getByTestId('mcp-server-scope-cloud'),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByTestId('mcp-server-auth-handler')).toHaveCount(
        0,
      );
      await dialog.getByTestId('mcp-server-scope-device').click();
      await dialog.getByTestId('mcp-server-auth-handler').selectOption(choice);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const entry = JSON.parse(
        readFileSync(seeded.indexFilePath, 'utf8'),
      ).servers.find((candidate) => candidate.id === server.definition.id);
      expect(entry).toBeDefined();
      expect(entry.scope).not.toBe('account');
      expect(entry.authHandler).not.toBe('account');
      expect(entry.accountConnectionId).toBeUndefined();
      await row.getByTestId('mcp-server-edit-button').click();
      await expect(window.getByTestId('mcp-server-auth-handler')).toHaveValue(
        choice,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

async function requestAccountAdvisorTool(electronApp, request) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }, request) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Main window missing');
    ipcMain.removeHandler('app-advisor:tool-response');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Advisor response timed out')),
        5000,
      );
      ipcMain.handle('app-advisor:tool-response', (_event, response) => {
        if (response?.requestId !== request.requestId) return;
        clearTimeout(timeout);
        resolve(response);
      });
      mainWindow.webContents.send('app-advisor:tool-request', request);
    });
  }, request);
}

/**
 * The row text can update while Account connections is still refreshing, and
 * the advisor refuses row actions until that refresh settles. Wait for the
 * advisor-visible state, not the DOM, before dispatching the next action.
 */
async function waitForAdvisorAccountConnectionsIdle(electronApp, label) {
  let attempt = 0;
  await expect
    .poll(async () => {
      attempt += 1;
      const state = await requestAccountAdvisorTool(electronApp, {
        kind: 'get_current_ui_state',
        requestId: `${label}-idle-${attempt}`,
      });
      return state.uiState.snapshot.mcpAccountConnections?.loading;
    })
    .toBe(false);
}

const FIXTURE_CLIENT_SETUP = {
  redirectUri:
    'https://app.example.test/api/mcp-connections/callback/fixture-issuer-key',
  issuer: 'https://accounts.example.test',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};

for (const scenario of [
  'advisor',
  'connect',
  'browser-sign-in',
  'make-cloud',
  'client-setup',
  'endpoint-required',
  'setup',
  'reconnect-setup',
  'secret-only',
  'provider',
  'offline',
  '401',
  '503',
  'flag-off',
]) {
  test(`Account MCP catalog: ${scenario}`, async () => {
    test.setTimeout(120_000);
    const cloud = await startAccountMcpCloud({
      ...(scenario === 'client-setup'
        ? { clientSetup: FIXTURE_CLIENT_SETUP }
        : {}),
      ...(scenario === 'browser-sign-in' ? { signInPage: true } : {}),
      // The cached catalog predates the server's endpoints; the live one
      // lists them.
      ...(scenario === 'endpoint-required'
        ? {
            endpointRequired: true,
            curatedServers: [
              {
                ...curatedCatalogEntry('github', 'GitHub', 0),
                urlOptions: [
                  { label: 'US', url: 'https://us.example.test/mcp' },
                  { label: 'Europe', url: 'https://eu.example.test/mcp' },
                ],
              },
            ],
          }
        : {}),
      includeConnection:
        scenario === 'connect' ||
        scenario === 'browser-sign-in' ||
        scenario === 'reconnect-setup',
      listFailure:
        scenario === 'offline'
          ? 'offline'
          : ['401', '503'].includes(scenario)
            ? Number(scenario)
            : undefined,
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-account-mcp-'),
    );
    const now = '2026-09-16T12:00:00.000Z';
    const seeded = seedMcpServers({
      userDataDir,
      servers: [
        {
          definition: {
            id: 'aabbcc',
            name: 'Device GitHub',
            description: 'Device credentials stay local',
            type: 'http',
            url: 'https://mcp.example.test',
            curated: { key: 'github' },
            createdAt: now,
            updatedAt: now,
          },
          configs: [
            {
              id: 'ddeeff',
              name: 'Default',
              description: '',
              enabled: true,
              authToken: 'fixture-device-token',
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
    const catalogEntry = curatedCatalogEntry('github', 'GitHub', 0);
    if (scenario === 'provider')
      catalogEntry.providerConnector = { providers: ['claude', 'codex'] };
    if (
      scenario === 'setup' ||
      scenario === 'reconnect-setup' ||
      scenario === 'secret-only'
    ) {
      catalogEntry.requiredConfigFields =
        scenario === 'secret-only'
          ? [{ kind: 'oauth-client-secret' }]
          : [{ kind: 'oauth-client-id' }, { kind: 'oauth-client-secret' }];
      catalogEntry.urlOptions = [
        { label: 'US', url: 'https://us.example.test/mcp' },
        { label: 'Europe', url: 'https://eu.example.test/mcp' },
      ];
    }
    writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
      version: 1,
      fetchedAt: NOW,
      servers: [catalogEntry],
    });
    const before = readFileSync(seeded.serverFilePaths.aabbcc, 'utf8');
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
          CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
          ...(scenario === 'browser-sign-in'
            ? { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: cloud.externalOpenUrl }
            : {}),
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-shared-mcp-account-connections': scenario !== 'flag-off',
            // The auth link that signs the browser in is gated by the portal
            // flag, which is off under E2E unless pinned.
            ...(scenario === 'browser-sign-in'
              ? { 'canopy-portal-enabled': true }
              : {}),
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
      expect(signIn.status.missingCapabilities).toEqual([]);
      if (scenario === 'advisor') {
        await requestAccountAdvisorTool(electronApp, {
          kind: 'dispatch_action',
          requestId: 'account-nav',
          originWorktreeId: 'e2e-advisor',
          action: {
            type: 'navigation.go_to_page',
            page: 'mcp-account-connections',
          },
        });
        const panel = window.getByTestId('settings-mcp-account-connections');
        await expect(
          panel.getByText('Device GitHub', { exact: true }),
        ).toBeVisible();
        const state = await requestAccountAdvisorTool(electronApp, {
          kind: 'get_current_ui_state',
          requestId: 'account-state',
        });
        expect(state.uiState.snapshot.mcpAccountConnections).toMatchObject({
          available: true,
          loading: false,
          rows: [{ id: 'aabbcc', serverKey: 'github' }],
        });
        await requestAccountAdvisorTool(electronApp, {
          kind: 'dispatch_action',
          requestId: 'account-promote',
          originWorktreeId: 'e2e-advisor',
          action: { type: 'mcp.account_promote', serverId: 'aabbcc' },
        });
        await expect(panel.getByTestId('mcp-account-pending')).toBeVisible();
        cloud.complete();
        await expect(panel.getByTestId('mcp-account-status')).toHaveText(
          'Connected',
          { timeout: 15_000 },
        );
        await waitForAdvisorAccountConnectionsIdle(electronApp, 'promoted');
        const disconnect = await requestAccountAdvisorTool(electronApp, {
          kind: 'dispatch_action',
          requestId: 'account-disconnect',
          originWorktreeId: 'e2e-advisor',
          action: {
            type: 'mcp.account_disconnect',
            serverId: 'github',
          },
        });
        expect(disconnect.error).toBeUndefined();
        await expect(panel.getByTestId('mcp-account-status')).toHaveText(
          'Not connected',
        );
        await waitForAdvisorAccountConnectionsIdle(electronApp, 'disconnected');
        const connect = await requestAccountAdvisorTool(electronApp, {
          kind: 'dispatch_action',
          requestId: 'account-connect',
          originWorktreeId: 'e2e-advisor',
          action: {
            type: 'mcp.account_connect',
            serverId: 'github',
          },
        });
        expect(connect.error).toBeUndefined();
        await expect(panel.getByTestId('mcp-account-pending')).toBeVisible();
        cloud.complete();
        await expect(panel.getByTestId('mcp-account-status')).toHaveText(
          'Connected',
          { timeout: 15_000 },
        );
        return;
      }
      await app.openPluginsPage();
      await app.openPluginsTab('mcp');
      const panel = window.getByTestId('plugins-management-section-mcp');
      if (scenario === 'flag-off') {
        await expect(
          panel.getByText('Device GitHub', { exact: true }),
        ).toBeVisible();
        await expect(panel.getByTestId('mcp-tier-badge')).toHaveCount(0);
        await expect(panel.getByTestId('mcp-account-connect')).toHaveCount(0);
        expect(cloud.calls).toHaveLength(0);
        return;
      }
      if (['provider', 'offline', '401', '503'].includes(scenario)) {
        await expect(
          panel.getByText('Device GitHub', { exact: true }),
        ).toBeVisible();
        await expect(panel.getByTestId('mcp-account-connect')).toHaveCount(0);
        await panel.getByTestId('mcp-server-edit-button').click();
        await expect(
          window.getByRole('dialog', { name: 'Edit MCP server' }),
        ).toBeVisible();
        return;
      }
      if (
        scenario === 'connect' ||
        scenario === 'browser-sign-in' ||
        scenario === 'reconnect-setup'
      ) {
        await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
          'Cloud + desktop',
        );
        await expect(panel.locator('tbody tr')).toHaveCount(1);
        await panel
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
      } else {
        await panel
          .getByRole('button', { name: 'Make available in cloud', exact: true })
          .click();
      }
      if (
        scenario === 'setup' ||
        scenario === 'reconnect-setup' ||
        scenario === 'secret-only'
      ) {
        const setup = window.getByTestId('mcp-account-setup');
        await expect(setup).toBeVisible();
        expect(cloud.calls.some((call) => call.method === 'POST')).toBe(false);
        await setup
          .getByTestId('mcp-curated-url-option')
          .selectOption('https://eu.example.test/mcp');
        await setup
          .getByTestId('mcp-account-oauth-client-id')
          .fill('fresh-client');
        await setup
          .getByTestId('mcp-account-oauth-client-secret')
          .fill('fresh-secret');
        await setup
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
      }
      if (scenario === 'endpoint-required') {
        // The cloud refuses the start for want of an endpoint: the catalog is
        // read again and setup asks which endpoint instead of an error.
        const setup = window.getByTestId('mcp-account-setup');
        await expect(setup).toBeVisible();
        await expect(panel.getByRole('alert')).toHaveCount(0);
        await setup
          .getByTestId('mcp-curated-url-option')
          .selectOption('https://eu.example.test/mcp');
        await setup
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
      }
      if (scenario === 'client-setup') {
        // GitHub registers no OAuth clients in this scenario: the refused
        // start opens setup for the user's own app instead of an error.
        const setup = window.getByTestId('mcp-account-setup');
        await expect(setup).toBeVisible();
        await expect(setup.getByTestId('mcp-client-setup-intro')).toHaveText(
          'GitHub doesn’t let apps register themselves. Create an app in GitHub’s developer dashboard with this redirect URI, then paste its client ID.',
        );
        await expect(
          setup.getByTestId('mcp-client-setup-redirect-uri'),
        ).toHaveText(FIXTURE_CLIENT_SETUP.redirectUri);
        await expect(
          setup.getByTestId('mcp-client-setup-copy-redirect-uri'),
        ).toBeVisible();
        await expect(
          setup.getByTestId('mcp-account-oauth-client-secret'),
        ).toHaveCount(0);
        await expect(panel.getByRole('alert')).toHaveCount(0);
        await setup
          .getByTestId('mcp-account-oauth-client-id')
          .fill('own-client');
        await setup
          .getByRole('button', { name: 'Connect', exact: true })
          .click();
      }
      await expect(panel.getByTestId('mcp-account-pending')).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeVisible();
      const providerLaunch = await electronApp.evaluate(
        () => globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__,
      );
      if (scenario === 'browser-sign-in') {
        // The cloud names its sign-in page, so the browser opens it through
        // an auth link for this desktop's account instead of going straight
        // to the provider: the callback then sees that account's session.
        await expect
          .poll(() => cloud.externalOpens)
          .toEqual([
            expect.stringMatching(
              new RegExp(
                `^${cloud.baseUrl.replace(/[.]/g, '[.]')}/api/v1/[a-z-]+/auth-link/consume[?]code=fixture$`,
              ),
            ),
          ]);
        expect(cloud.authLinks).toEqual([ACCOUNT_MCP_FIXTURE_SIGN_IN_PATH]);
        expect(providerLaunch).toBeUndefined();
      } else {
        // An older cloud names no sign-in page: the provider opens directly.
        expect(providerLaunch).toBe('https://auth.example.test/authorize');
        expect(cloud.authLinks).toEqual([]);
      }
      cloud.complete();
      await expect(panel.getByTestId('mcp-account-status')).toHaveText(
        'Connected',
        { timeout: 15_000 },
      );
      await expect(panel.locator('tbody tr')).toHaveCount(1);
      await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
        'Cloud + desktop',
      );
      if (scenario === 'connect') {
        await panel.getByTestId('mcp-add-menu-trigger').click();
        await window.getByTestId('mcp-add-browse').click();
        await window
          .getByTestId('mcp-browse-card')
          .filter({ hasText: 'GitHub' })
          .click();
        await expect(window.getByTestId('mcp-browse-tool-chip')).toHaveText([
          'account_search',
        ]);
        await window.keyboard.press('Escape');
      }
      await panel
        .getByRole('button', { name: 'Device copy', exact: true })
        .click();
      await expect(
        window.getByRole('dialog', { name: 'Edit MCP server' }),
      ).toBeVisible();
      expect(readFileSync(seeded.serverFilePaths.aabbcc, 'utf8')).toBe(before);
      if (scenario === 'endpoint-required') {
        expect(
          cloud.calls
            .filter((call) => call.method === 'POST')
            .map((call) => call.body),
        ).toEqual([
          { serverKey: 'github', configId: 'default' },
          {
            serverKey: 'github',
            endpointUrl: 'https://eu.example.test/mcp',
            configId: 'default',
          },
        ]);
        return;
      }
      if (scenario === 'client-setup') {
        expect(
          cloud.calls
            .filter((call) => call.method === 'POST')
            .map((call) => call.body),
        ).toEqual([
          { serverKey: 'github', configId: 'default' },
          {
            serverKey: 'github',
            configId: 'default',
            oauthClient: { clientId: 'own-client' },
          },
        ]);
        return;
      }
      expect(cloud.calls.find((call) => call.method === 'POST')?.body).toEqual({
        ...(['setup', 'reconnect-setup', 'secret-only'].includes(scenario)
          ? {
              serverKey: 'github',
              endpointUrl: 'https://eu.example.test/mcp',
              configId: 'default',
              oauthClient: {
                clientId: 'fresh-client',
                clientSecret: 'fresh-secret',
              },
            }
          : { serverKey: 'github', configId: 'default' }),
      });
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await cloud.close();
    }
  });
}

for (const scenario of ['create', 'promote']) {
  const title =
    scenario === 'create'
      ? 'custom HTTP server defaults to account and appears as Cloud + desktop'
      : 'promote existing custom row';
  test(`Account MCP custom: ${title}`, async () => {
    test.setTimeout(120_000);
    const cloud = await startAccountMcpCloud({ includeConnection: false });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-account-mcp-custom-'),
    );
    const now = '2026-09-16T12:00:00.000Z';
    // The promoted row has no device token, so the cloud answers with a
    // browser sign-in and the row is bound before it settles.
    const seeded = seedMcpServers({
      userDataDir,
      servers:
        scenario === 'promote'
          ? [
              {
                definition: {
                  // LOAD_SERVER accepts only UUID-shaped ids, like the ones the app mints.
                  id: 'c0ffee00-0000-4000-8000-000000000001',
                  name: 'Internal tools',
                  description: '',
                  type: 'http',
                  url: 'https://internal.example.test/mcp',
                  headers: { 'X-Team': 'core' },
                  createdAt: now,
                  updatedAt: now,
                },
                configs: [
                  {
                    id: 'cfg1',
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
            ]
          : [],
    });
    writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
      version: 1,
      fetchedAt: NOW,
      servers: [curatedCatalogEntry('github', 'GitHub', 0)],
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
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
      await app.openPluginsPage();
      await app.openPluginsTab('mcp');
      const panel = window.getByTestId('plugins-management-section-mcp');
      if (scenario === 'create') {
        await panel.getByTestId('mcp-add-menu-trigger').click();
        await window.getByTestId('mcp-add-custom').click();
        const dialog = window.getByRole('dialog', { name: 'New MCP server' });
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole('button', { name: 'Command', exact: true })
          .click();
        await expect(dialog.getByTestId('mcp-cloud-local-reason')).toHaveText(
          'Desktop only. Command servers run on this device.',
        );
        await dialog.getByRole('button', { name: 'HTTP', exact: true }).click();
        await dialog.getByPlaceholder('My MCP server').fill('Internal tools');
        await dialog
          .getByPlaceholder('https://mcp.example.com/sse')
          .fill('http://127.0.0.1:4100/mcp');
        await expect(dialog.getByTestId('mcp-cloud-local-reason')).toHaveText(
          "Desktop only. Local addresses can't be reached from the cloud.",
        );
        await expect(
          dialog.getByTestId('mcp-server-scope-cloud'),
        ).toBeDisabled();
        await dialog
          .getByPlaceholder('https://mcp.example.com/sse')
          .fill('https://internal.example.test/mcp');
        await expect(
          dialog.getByTestId('mcp-server-scope-cloud'),
        ).toHaveAttribute('aria-checked', 'true');
        await expect(dialog.getByTestId('mcp-cloud-placement')).toContainText(
          'Will be added to your cloud account',
        );
        const addHeader = async (name, value) => {
          await dialog.getByPlaceholder('Header-Name').first().fill(name);
          await dialog.getByPlaceholder('header-value').first().fill(value);
          await dialog
            .getByRole('button', { name: 'Add', exact: true })
            .first()
            .click();
        };
        await addHeader('Authorization', 'Bearer local');
        await expect(dialog.getByTestId('mcp-cloud-local-reason')).toHaveText(
          'The cloud sets Authorization itself, so this server stays on this device.',
        );
        await expect(
          dialog.getByTestId('mcp-server-scope-device'),
        ).toHaveAttribute('aria-checked', 'true');
        await dialog
          .getByRole('button', { name: 'Remove Authorization', exact: true })
          .click();
        await addHeader('X-Api-Key', 'fixture-upstream-key');
        await expect(
          dialog.getByTestId('mcp-server-scope-cloud'),
        ).toHaveAttribute('aria-checked', 'true');
        await expect(
          dialog.getByTestId('mcp-cloud-headers-consent'),
        ).toHaveText('Its headers are stored in your cloud account too.');
        await dialog
          .getByTestId('mcp-cloud-access-token')
          .fill('fixture-custom-token');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      } else {
        const row = panel.getByTestId(
          'mcp-server-row-c0ffee00-0000-4000-8000-000000000001',
        );
        await expect(row.getByTestId('mcp-tier-badge')).toHaveText(
          'Desktop only',
        );
        await row
          .getByRole('button', { name: 'Make available in cloud', exact: true })
          .click();
        const promote = window.getByTestId('mcp-promote-dialog');
        await expect(promote).toContainText(
          'Move Internal tools to your cloud account',
        );
        // The row has no device token, so none moves with it.
        await expect(
          promote.getByTestId('mcp-promote-access-token'),
        ).toHaveValue('');
        await expect(promote.getByTestId('mcp-move-carries')).toHaveText(
          'Its URL and headers move to your cloud account. No access token goes with it.',
        );
        expect(cloud.calls.some((call) => call.method === 'POST')).toBe(false);
        await promote.getByTestId('mcp-promote-confirm').click();
        await expect(panel.getByTestId('mcp-account-pending')).toBeVisible();
        expect(
          await electronApp.evaluate(
            () => globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__,
          ),
        ).toBe('https://auth.example.test/authorize');
        cloud.complete();
      }
      await expect(panel.getByTestId('mcp-account-status')).toHaveText(
        'Connected',
        { timeout: 15_000 },
      );
      await expect(panel.locator('tbody tr')).toHaveCount(1);
      await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
        'Cloud + desktop',
      );
      // The bound copy opens through Edit rather than its own button.
      await expect(panel.getByTestId('mcp-device-copy')).toHaveCount(0);
      await expect(panel.getByTestId('mcp-account-edit-button')).toHaveCount(1);
      expect(cloud.calls.find((call) => call.method === 'POST')?.body).toEqual(
        scenario === 'create'
          ? {
              customUrl: 'https://internal.example.test/mcp',
              displayName: 'Internal tools',
              headers: { 'X-Api-Key': 'fixture-upstream-key' },
              bearerToken: 'fixture-custom-token',
              configId: 'default',
            }
          : {
              customUrl: 'https://internal.example.test/mcp',
              displayName: 'Internal tools',
              headers: { 'X-Team': 'core' },
              configId: 'default',
            },
      );
      const index = JSON.parse(readFileSync(seeded.indexFilePath, 'utf8'));
      expect(index.servers).toEqual([
        expect.objectContaining({
          name: 'Internal tools',
          urlHost: 'internal.example.test',
          urlScheme: 'https',
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: CUSTOM_ACCOUNT_MCP_ID,
        }),
      ]);
      // The access token lives in the cloud account, not the device copy.
      expect(
        readFileSync(
          path.join(
            userDataDir,
            'mcp-servers',
            `server-${index.servers[0].id}.json`,
          ),
          'utf8',
        ),
      ).not.toContain('fixture-custom-token');
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await cloud.close();
    }
  });
}

async function launchSignedInAccountMcp(userDataDir, cloud) {
  const { electronApp } = await launchCanopy({
    userDataDir,
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

test('Settings summary counts account and device MCP servers', async () => {
  test.setTimeout(120_000);
  const cloud = await startAccountMcpCloud({ includeConnection: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-mcp-picker-'),
  );
  const now = '2026-09-16T12:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aaa-bbb-111',
          name: 'Local files',
          description: '',
          type: 'command',
          command: 'npx',
          args: ['-y', 'local-files-mcp'],
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'cfg1',
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
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [curatedCatalogEntry('github', 'GitHub', 0)],
  });
  let electronApp;
  try {
    let window;
    let app;
    ({ electronApp, window, app } = await launchSignedInAccountMcp(
      userDataDir,
      cloud,
    ));
    await app.openSettings();
    await app.openSettingsSection('plugins');
    const refs = await window.evaluate(async () => {
      const index = await window.mcpServers.loadIndex();
      return index.servers.flatMap((server) =>
        server.configs
          .filter((config) => config.enabled)
          .map((config) => ({ serverId: server.id, configId: config.id })),
      );
    });
    await window.evaluate(
      (mcpServerRefs) =>
        window.api.savePreferences({
          globalPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs,
          },
        }),
      refs,
    );
    await expect(
      window.getByTestId('active-items-summary-counts'),
    ).toContainText('2 MCP servers');
    await window.getByTestId('active-items-summary-manage').click();
    await expect(
      window.getByTestId('plugins-installed-status-filter'),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('custom HTTP MCP server moves between this device and the cloud account', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-mcp-scope-'),
  );
  const seeded = seedMcpServers({ userDataDir, servers: [] });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [curatedCatalogEntry('github', 'GitHub', 0)],
  });
  let electronApp;
  try {
    let window;
    let app;
    ({ electronApp, window, app } = await launchSignedInAccountMcp(
      userDataDir,
      cloud,
    ));
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    const panel = window.getByTestId('plugins-management-section-mcp');
    const globalMcpRefs = () =>
      window.evaluate(
        async () =>
          (await window.api.loadPreferences()).globalPluginSelections
            ?.mcpServerRefs ?? [],
      );

    // Create it on this device.
    await panel.getByTestId('mcp-add-menu-trigger').click();
    await window.getByTestId('mcp-add-custom').click();
    const create = window.getByRole('dialog', { name: 'New MCP server' });
    await create.getByRole('button', { name: 'HTTP', exact: true }).click();
    await create.getByPlaceholder('My MCP server').fill('Scope tools');
    await create
      .getByPlaceholder('https://mcp.example.com/sse')
      .fill('https://scope.example.test/mcp');
    await expect(create.getByTestId('mcp-server-scope-cloud')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(
      create.getByTestId('mcp-server-dialog-workspace-default'),
    ).toHaveCount(0);
    await create.getByTestId('mcp-server-scope-device').click();
    await expect(create.getByTestId('mcp-cloud-placement')).toHaveCount(0);
    await create.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(create).toHaveCount(0);
    await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
      'Desktop only',
    );
    expect(cloud.calls.some((call) => call.method === 'POST')).toBe(false);
    const device = JSON.parse(readFileSync(seeded.indexFilePath, 'utf8'))
      .servers[0];
    const deviceRef = {
      serverId: device.id,
      configId: device.configs[0].id,
    };
    await window.evaluate(async (ref) => {
      await window.api.savePreferences({
        globalPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [ref],
        },
      });
    }, deviceRef);

    // Move it to the cloud account; the default follows it.
    await panel.getByTestId('mcp-server-edit-button').click();
    const toCloud = window.getByRole('dialog', { name: 'Edit MCP server' });
    await toCloud.getByTestId('mcp-server-scope-cloud').click();
    await expect(toCloud.getByTestId('mcp-cloud-move-carries')).toHaveText(
      "Its URL, headers, and access token move to your cloud account. OAuth sign-ins don't move, so sign in again after you save if it uses OAuth.",
    );
    await toCloud
      .getByTestId('mcp-cloud-access-token')
      .fill('fixture-scope-token');
    await toCloud.getByRole('button', { name: 'Save', exact: true }).click();
    // Nothing reaches the cloud until the move is confirmed.
    const moveToCloud = window.getByTestId('mcp-move-to-cloud-dialog');
    await expect(moveToCloud.getByTestId('mcp-move-carries')).toHaveText(
      'Its URL, headers, and access token move to your cloud account.',
    );
    expect(cloud.calls.some((call) => call.method === 'POST')).toBe(false);
    await moveToCloud.getByTestId('mcp-move-to-cloud-confirm').click();
    await expect(toCloud).toHaveCount(0);
    await expect(panel.getByTestId('mcp-account-status')).toHaveText(
      'Connected',
      { timeout: 15_000 },
    );
    await expect(panel.locator('tbody tr')).toHaveCount(1);
    await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
      'Cloud + desktop',
    );
    expect(cloud.calls.find((call) => call.method === 'POST')?.body).toEqual({
      customUrl: 'https://scope.example.test/mcp',
      displayName: 'Scope tools',
      bearerToken: 'fixture-scope-token',
      configId: 'default',
    });
    await expect
      .poll(globalMcpRefs)
      .toEqual([{ serverId: 'custom:fixture-0', configId: 'default' }]);
    expect(
      readFileSync(
        path.join(userDataDir, 'mcp-servers', `server-${device.id}.json`),
        'utf8',
      ),
    ).not.toContain('fixture-scope-token');

    // Edit its URL in the cloud account; the cloud asks to sign in again.
    await panel.getByTestId('mcp-account-edit-button').click();
    const edit = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(edit.getByTestId('mcp-server-scope-cloud')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await edit
      .getByTestId('mcp-server-url')
      .fill('https://scope2.example.test/mcp');
    await expect(edit.getByTestId('mcp-cloud-url-warning')).toHaveText(
      'Changing the URL signs you out. Sign in again after you save.',
    );
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect(
      cloud.calls.find(
        (call) =>
          call.method === 'PATCH' &&
          call.path.endsWith(`/mcp-connections/${CUSTOM_ACCOUNT_MCP_ID}`),
      )?.body,
    ).toEqual({ customUrl: 'https://scope2.example.test/mcp' });
    await expect(panel.getByTestId('mcp-account-status')).toHaveText(
      'Reconnect',
    );

    // Move it back to this device; the cloud connection goes away.
    await panel.getByTestId('mcp-account-edit-button').click();
    const toDevice = window.getByRole('dialog', { name: 'Edit MCP server' });
    await toDevice.getByTestId('mcp-server-scope-device').click();
    await expect(toDevice.getByTestId('mcp-device-placement')).toBeVisible();
    await toDevice.getByRole('button', { name: 'Save', exact: true }).click();
    const confirm = window.getByTestId('mcp-move-to-device-dialog');
    await expect(confirm).toContainText(
      "Cloud chats, cloud project defaults, and your other desktops lose Scope tools, because they can't use a server on this device.",
    );
    await confirm.getByTestId('mcp-move-to-device-confirm').click();
    await expect(toDevice).toHaveCount(0);
    await expect(panel.locator('tbody tr')).toHaveCount(1);
    await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
      'Desktop only',
    );
    await expect(panel.getByTestId('mcp-account-status')).toHaveCount(0);
    expect(
      cloud.calls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.path.endsWith(`/mcp-connections/${CUSTOM_ACCOUNT_MCP_ID}`) &&
          call.query === '?remove=1',
      ),
    ).toBe(true);
    await expect.poll(globalMcpRefs).toEqual([deviceRef]);
    const moved = JSON.parse(
      readFileSync(seeded.indexFilePath, 'utf8'),
    ).servers;
    expect(moved).toEqual([
      expect.objectContaining({
        id: device.id,
        urlHost: 'scope2.example.test',
      }),
    ]);
    expect(moved[0].accountConnectionId).toBeUndefined();
    expect(moved[0].scope).not.toBe('account');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('moving a cloud MCP server to this device on an older cloud says it was only signed out', async () => {
  test.setTimeout(120_000);
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    edits: false,
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-mcp-old-cloud-'),
  );
  seedMcpServers({ userDataDir, servers: [] });
  let electronApp;
  try {
    let window;
    let app;
    ({ electronApp, window, app } = await launchSignedInAccountMcp(
      userDataDir,
      cloud,
    ));
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    const panel = window.getByTestId('plugins-management-section-mcp');

    // No curated catalog is seeded, so the toolbar shows the plain Add Custom
    // button rather than the Add menu.
    await panel.getByTestId('mcp-add-custom').click();
    const create = window.getByRole('dialog', { name: 'New MCP server' });
    await create.getByRole('button', { name: 'HTTP', exact: true }).click();
    await create.getByPlaceholder('My MCP server').fill('Old cloud tools');
    await create
      .getByPlaceholder('https://mcp.example.com/sse')
      .fill('https://old-cloud.example.test/mcp');
    await expect(create.getByTestId('mcp-server-scope-cloud')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await create.getByTestId('mcp-cloud-access-token').fill('fixture-token');
    await create.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(create).toHaveCount(0);
    await expect(panel.getByTestId('mcp-account-status')).toHaveText(
      'Connected',
      { timeout: 15_000 },
    );

    await panel.getByTestId('mcp-account-edit-button').click();
    const toDevice = window.getByRole('dialog', { name: 'Edit MCP server' });
    await toDevice.getByTestId('mcp-server-scope-device').click();
    await toDevice.getByRole('button', { name: 'Save', exact: true }).click();
    await window
      .getByTestId('mcp-move-to-device-dialog')
      .getByTestId('mcp-move-to-device-confirm')
      .click();
    await expect(toDevice).toHaveCount(0);
    await expect(
      window.getByTestId('toast-card').filter({
        hasText:
          "Moved to this device, but your cloud account can't remove servers yet. Delete it from the list after it updates.",
      }),
    ).toBeVisible();
    const deletes = cloud.calls.filter(
      (call) =>
        call.method === 'DELETE' &&
        call.path.endsWith(`/mcp-connections/${CUSTOM_ACCOUNT_MCP_ID}`),
    );
    expect(deletes.map((call) => call.query)).toEqual(['']);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('moving a cloud-only MCP server with stored headers asks before leaving them behind', async () => {
  test.setTimeout(120_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  cloud.customs.push({
    id: CUSTOM_ACCOUNT_MCP_ID,
    serverKey: 'custom:fixture-0',
    configId: 'default',
    displayName: 'Header tools',
    kind: 'CUSTOM',
    authMode: 'BEARER',
    status: 'CONNECTED',
    routeId: 'fixture-custom-route-0',
    enabledTools: null,
    upstreamHost: 'headers.example.test',
    hasExtraHeaders: true,
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-mcp-stored-headers-'),
  );
  const seeded = seedMcpServers({ userDataDir, servers: [] });
  let electronApp;
  try {
    let window;
    let app;
    ({ electronApp, window, app } = await launchSignedInAccountMcp(
      userDataDir,
      cloud,
    ));
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    const panel = window.getByTestId('plugins-management-section-mcp');
    await expect(panel.getByTestId('mcp-account-status')).toHaveText(
      'Connected',
      { timeout: 15_000 },
    );

    await panel.getByTestId('mcp-account-edit-button').click();
    const editor = window.getByRole('dialog', { name: 'Edit MCP server' });
    const notice = editor.getByTestId('mcp-cloud-stored-headers');
    await expect(notice).toContainText(
      'Custom headers are stored in your cloud account.',
    );
    await editor.getByTestId('mcp-server-scope-device').click();
    await expect(notice).toHaveText(
      "Its stored headers can't be copied to this device. Enter them again here to keep them.",
    );
    await editor
      .getByTestId('mcp-server-url')
      .fill('https://headers.example.test/mcp');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const confirm = window.getByTestId('mcp-move-to-device-dialog');
    await expect(confirm).toContainText(
      "This server has stored headers that can't be copied to this device. Enter them again in the editor, or move it without them.",
    );
    const move = confirm.getByTestId('mcp-move-to-device-confirm');
    await expect(move).toBeDisabled();
    await confirm.getByTestId('mcp-move-drop-stored-headers').check();
    await expect(move).toBeEnabled();
    await move.click();
    await expect(editor).toHaveCount(0);
    await expect(panel.getByTestId('mcp-tier-badge')).toHaveText(
      'Desktop only',
    );
    expect(
      cloud.calls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.path.endsWith(`/mcp-connections/${CUSTOM_ACCOUNT_MCP_ID}`) &&
          call.query === '?remove=1',
      ),
    ).toBe(true);
    const moved = JSON.parse(
      readFileSync(seeded.indexFilePath, 'utf8'),
    ).servers;
    expect(moved).toEqual([
      expect.objectContaining({
        name: 'Header tools',
        urlHost: 'headers.example.test',
      }),
    ]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
