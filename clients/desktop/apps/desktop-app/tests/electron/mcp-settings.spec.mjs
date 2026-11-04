import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CUSTOM_ACCOUNT_MCP_ID,
  startAccountMcpCloud,
} from './fixtures/accountMcpCloud.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 3 — G10: Settings → MCP tab (auth mode + proxy port).
//
// Distinct from the Customize → MCP servers tab. Covers the deterministic
// config surface in `settings/McpTab.tsx`: switching the default HTTP auth
// handler (which swaps the description copy) and editing + applying the local
// proxy port (persisted via `savePreferences` + `applyProxyPort`). The real
// proxy bind is not asserted — only that the "saved" affordance appears and
// that the values survive a relaunch.
//
// Auth-mode and port copy come from `settings/mcp-tab-helpers.ts`:
//   provider description: "Claude and Codex handle MCP auth directly. ..."
//   canopy description:   "<brand> handles OAuth through its local 127.0.0.1 ..."
//   saved text:           "MCP proxy settings saved."

const PROVIDER_DESCRIPTION_FRAGMENT =
  'Claude and Codex handle MCP auth directly.';
const SAVED_TEXT = 'MCP proxy settings saved.';
const DEFAULT_PROXY_PORT = '37645';
// A high, almost-certainly-free port so `applyProxyPort`'s availability check
// passes deterministically in CI.
const NEW_PROXY_PORT = '38942';

/**
 * Reset applies the DEFAULT port, which gets no such protection — and it is
 * exactly the port a running Canopy occupies. On a developer machine with the
 * app open, `applyProxyPort` fails, `appliedPort` stays put, and the Reset
 * button never clears, so the assertion below fails for a reason that says
 * nothing about the code. CI has no Canopy running and still covers it.
 */
async function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(Number(port), '127.0.0.1');
  });
}

test('Settings → MCP tab switches auth mode and persists or resets proxy port', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await app.openSettings();
    await app.openSettingsSection('mcp');
    await expect(window.getByTestId('settings-tab-mcp')).toBeVisible();

    const description = window.getByTestId('settings-mcp-auth-description');
    const initialDescription = await description.textContent();

    // --- Switch auth mode → description copy changes ----------------------
    await window.getByTestId('settings-mcp-auth-provider').click();
    await expect(
      window.getByTestId('settings-mcp-auth-provider'),
    ).toBeChecked();
    await expect(description).toContainText(PROVIDER_DESCRIPTION_FRAGMENT);
    expect(await description.textContent()).not.toBe(initialDescription);

    // --- Edit + apply proxy port -----------------------------------------
    const portInput = window.getByTestId('settings-mcp-port-input');
    await portInput.fill(NEW_PROXY_PORT);
    await window.getByTestId('settings-mcp-save').click();

    const saved = window.getByTestId('settings-mcp-saved');
    await expect(saved).toBeVisible();
    await expect(saved).toHaveText(SAVED_TEXT);

    await window.screenshot({
      path: testInfo.outputPath('mcp-settings-saved.png'),
    });
  } finally {
    // Keep the data dir so the relaunch sees the persisted preferences.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // --- Relaunch → values persisted ---------------------------------------
  const relaunch = await launchCanopy({ userDataDir });
  try {
    const window = await relaunch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await app.openSettings();
    await app.openSettingsSection('mcp');
    await expect(window.getByTestId('settings-tab-mcp')).toBeVisible();

    // Auth mode persisted to "provider".
    await expect(
      window.getByTestId('settings-mcp-auth-provider'),
    ).toBeChecked();
    await expect(
      window.getByTestId('settings-mcp-auth-description'),
    ).toContainText(PROVIDER_DESCRIPTION_FRAGMENT);

    // Proxy port persisted.
    await expect(window.getByTestId('settings-mcp-port-input')).toHaveValue(
      NEW_PROXY_PORT,
    );
    await expect(window.getByTestId('settings-mcp-reset')).toBeVisible();

    // Reset restores and immediately applies the default proxy port.
    if (await isPortFree(DEFAULT_PROXY_PORT)) {
      await window.getByTestId('settings-mcp-reset').click();
      await expect(window.getByTestId('settings-mcp-port-input')).toHaveValue(
        DEFAULT_PROXY_PORT,
      );
      await expect(window.getByTestId('settings-mcp-reset')).toHaveCount(0);
      await expect(window.getByTestId('settings-mcp-saved')).toHaveText(
        SAVED_TEXT,
      );
      await expect(
        window.getByTestId('settings-mcp-auth-provider'),
      ).toBeChecked();
    } else {
      // Annotated rather than silently skipped, so a CI run that somehow lost
      // this coverage is visible in the report instead of passing quietly.
      testInfo.annotations.push({
        type: 'skipped-step',
        description: `Reset-to-default not asserted: port ${DEFAULT_PROXY_PORT} is in use, most likely by a running desktop app instance.`,
      });
    }
  } finally {
    await closeCanopy(relaunch.electronApp, relaunch.userDataDir);
  }
});

for (const enabled of [false, true]) {
  test(`account auth choices follow the desktop feature flag (${enabled})`, async () => {
    // With the flag on, a new custom HTTPS server defaults to the signed-in
    // cloud account: the dialog creates the connection and binds the row.
    const cloud = enabled
      ? await startAccountMcpCloud({ includeConnection: false })
      : undefined;
    let launched;
    try {
      launched = await launchCanopy({
        env: {
          ...(cloud
            ? {
                CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
                CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
              }
            : {}),
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-shared-mcp-account-connections': enabled,
          }),
        },
      });
      const { electronApp, userDataDir } = launched;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (enabled) {
        const signIn = await window.evaluate(async () =>
          window.api.saveCanopyCloudApiKey({
            apiKey: 'csk_account_mcp_fixture',
          }),
        );
        expect(signIn.status.authenticated, JSON.stringify(signIn.status)).toBe(
          true,
        );
      }
      await app.openSettings();
      await app.openSettingsSection('mcp');
      const choice = window.getByTestId('settings-mcp-auth-account');
      await expect(choice).toHaveCount(enabled ? 1 : 0);
      if (enabled) {
        await choice.click();
        await expect(choice).toBeChecked();
        await window.getByTestId('settings-mcp-save').click();
        await expect(window.getByTestId('settings-mcp-saved')).toBeVisible();
      }
      await window.keyboard.press('Escape');
      // CAN-4267: a custom server is added from the Customize header's Add
      // custom menu, which opens the same server editor.
      await app.openPluginsPage();
      await app.openPluginsTab('mcp');
      await window.getByTestId('plugins-add-custom-menu').click();
      await window.getByTestId('plugins-add-custom-mcp').click();
      const dialog = window.getByRole('dialog', { name: 'New MCP server' });
      await dialog.getByRole('button', { name: 'HTTP', exact: true }).click();
      const cloudScope = dialog.getByTestId('mcp-server-scope-cloud');
      await expect(cloudScope).toHaveCount(enabled ? 1 : 0);
      await dialog.getByPlaceholder('My MCP server').fill('Account MCP');
      await dialog
        .getByPlaceholder('https://mcp.example.com/sse')
        .fill('https://mcp.example.test/mcp');
      if (!enabled) {
        await expect(dialog.getByTestId('mcp-server-scope')).toHaveCount(0);
        await expect(dialog.getByTestId('mcp-cloud-placement')).toHaveCount(0);
        await expect(dialog.getByTestId('mcp-cloud-local-reason')).toHaveCount(
          0,
        );
        return;
      }
      await expect(cloudScope).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByTestId('mcp-cloud-placement')).toContainText(
        'Will be added to your cloud account',
      );
      // Choosing this device leaves the account default for an explicit proxy
      // choice; choosing the cloud account again returns it there.
      await dialog.getByTestId('mcp-server-scope-device').click();
      await expect(
        dialog.getByTestId('mcp-server-auth-handler'),
      ).toHaveAttribute('data-value', 'canopy');
      await expect(dialog.getByTestId('mcp-cloud-placement')).toHaveCount(0);
      await cloudScope.click();
      await expect(cloudScope).toHaveAttribute('aria-checked', 'true');
      await dialog
        .getByTestId('mcp-cloud-access-token')
        .fill('fixture-custom-token');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // Saving opens the new server's detail (#6140). An account-bound
      // server's detail is a dialog over the list; close it to move on.
      const created = window
        .getByRole('dialog')
        .filter({ hasText: 'Account MCP' });
      await expect(created).toBeVisible();
      await created.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(created).toHaveCount(0);
      // The account binding and its status are read from the account
      // connections table, which Settings keeps.
      await app.openSettings();
      await app.openSettingsSection('mcp');
      const panel = window.getByTestId('settings-mcp-account-connections');
      await expect(panel.getByTestId('mcp-account-status')).toHaveText(
        'Connected',
        { timeout: 15_000 },
      );
      expect(cloud?.calls.find((call) => call.method === 'POST')?.body).toEqual(
        {
          customUrl: 'https://mcp.example.test/mcp',
          displayName: 'Account MCP',
          bearerToken: 'fixture-custom-token',
          configId: 'default',
        },
      );
      const indexFilePath = path.join(userDataDir, 'mcp-servers', 'index.json');
      const bound = JSON.parse(readFileSync(indexFilePath, 'utf8'));
      expect(
        bound.servers.find((server) => server.name === 'Account MCP'),
      ).toMatchObject({
        scope: 'account',
        authHandler: 'account',
        accountConnectionId: CUSTOM_ACCOUNT_MCP_ID,
      });
      // Moving the server to this device under the agent provider clears the
      // binding and removes the cloud connection.
      await panel.getByTestId('mcp-account-edit-button').click();
      const edit = window.getByRole('dialog', { name: 'Edit MCP server' });
      await expect(edit.getByTestId('mcp-server-scope-cloud')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(edit.getByTestId('mcp-server-auth-handler')).toHaveCount(0);
      await edit.getByTestId('mcp-server-scope-device').click();
      await chooseSettingsOption(edit.getByTestId('mcp-server-auth-handler'), {
        value: 'provider',
      });
      await expect(edit.getByTestId('mcp-device-placement')).toBeVisible();
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      await window.getByTestId('mcp-move-to-device-confirm').click();
      await expect(edit).toHaveCount(0);
      await expect
        .poll(() =>
          cloud?.calls.some(
            (call) =>
              call.method === 'DELETE' &&
              call.path.endsWith(CUSTOM_ACCOUNT_MCP_ID) &&
              call.query === '?remove=1',
          ),
        )
        .toBe(true);
      const cleared = JSON.parse(readFileSync(indexFilePath, 'utf8'));
      const clearedEntry = cleared.servers.find(
        (server) => server.name === 'Account MCP',
      );
      expect(clearedEntry).toBeDefined();
      for (const key of ['scope', 'authHandler', 'accountConnectionId']) {
        expect(clearedEntry).not.toHaveProperty(key);
      }
    } finally {
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await cloud?.close();
    }
  });
}

test('account binding matches curated keys and recovers from connection list failures', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-mcp-account-connections': true,
      }),
    },
  });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      let attempts = 0;
      ipcMain.removeHandler('mcp-servers:list-account-connections');
      ipcMain.handle('mcp-servers:list-account-connections', () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Cloud unavailable');
        if (attempts === 2) return [];
        return [
          {
            id: 'a1111111-1111-4111-8111-111111111111',
            serverKey: 'github',
            configId: 'default',
            displayName: 'GitHub work connection',
            status: 'CONNECTED',
            kind: 'CURATED',
          },
          {
            id: 'b1111111-1111-4111-8111-111111111111',
            serverKey: 'unrelated',
            configId: 'default',
            displayName: 'GitHub',
            status: 'CONNECTED',
            kind: 'CUSTOM',
          },
        ];
      });
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async () => {
      const now = new Date().toISOString();
      await window.mcpServers.saveServer({
        definition: {
          id: '',
          name: 'Curated GitHub',
          description: '',
          type: 'http',
          url: 'https://mcp.example.test',
          httpAuthHandler: 'provider',
          curated: { key: 'github', requiresProviderAuth: false },
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
      });
    });
    await app.openPluginsPage();
    await app.openPluginsTab('mcp');
    // CAN-4267: the installed server's detail page opens the server editor
    // from Advanced configuration. With no catalog loaded the server keeps its
    // own row; a loaded catalog would fold it into the GitHub card instead.
    await window
      .getByTestId('customize-section-installed')
      .locator('[data-testid^="customize-row-mcp-"]', { hasText: 'GitHub' })
      .click();
    await expect(window.getByTestId('mcp-browse-detail')).toBeVisible();
    await window.getByTestId('plugin-advanced-configuration').click();
    const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
    const cloudScope = dialog.getByTestId('mcp-server-scope-cloud');
    const reason = dialog.getByTestId('mcp-cloud-local-reason');
    // The cloud account scope waits for a matching connection; a failed or
    // empty read keeps the server on this device and offers a retry.
    await expect(reason).toHaveText(
      'Could not load account connections. Check your cloud sign-in and try again.',
    );
    await expect(cloudScope).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(reason).toHaveText(
      'Sign in to add this server to your cloud account. It stays on this device for now.',
    );
    await expect(cloudScope).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(cloudScope).toBeEnabled();
    await cloudScope.click();
    await expect(dialog.getByTestId('mcp-account-match')).toHaveText(
      'Account connection: GitHub work connection',
    );
    // A catalog server binds to its existing connection; it never creates one.
    await expect(dialog.getByTestId('mcp-cloud-placement')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    const index = await window.evaluate(() => window.mcpServers.loadIndex());
    expect(
      index.servers.find((server) => server.name === 'Curated GitHub'),
    ).toMatchObject({
      scope: 'account',
      authHandler: 'account',
      curatedKey: 'github',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const authStatus of ['not_connected', 'error']) {
  test(`account ${authStatus} recovery opens account settings without local OAuth`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    });
    try {
      await electronApp.evaluate(({ ipcMain }, authStatus) => {
        ipcMain.removeHandler('mcp-servers:load-index');
        ipcMain.handle('mcp-servers:load-index', () => ({
          version: 1,
          servers: [
            {
              id: 'account-server',
              name: 'Account recovery',
              type: 'http',
              description: '',
              configs: [{ id: 'default', name: 'Default', enabled: true }],
              updatedAt: '2026-09-17T00:00:00.000Z',
            },
          ],
        }));
        ipcMain.removeHandler('mcp-servers:list-status');
        ipcMain.handle('mcp-servers:list-status', () => [
          {
            serverId: 'account-server',
            transport: 'http',
            handler: 'account',
            connectionStatus: 'auth_required',
            reachability: 'unknown',
            configs: [{ configId: 'default', authStatus }],
          },
        ]);
        ipcMain.removeHandler('mcp-servers:start-oauth-login');
        ipcMain.handle('mcp-servers:start-oauth-login', () => {
          throw new Error('Local OAuth must not run');
        });
      }, authStatus);
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // CAN-4267: the table's "Connect in cloud" recovery is kept by the
      // account connections table in Settings.
      await app.openSettings();
      await app.openSettingsSection('mcp');
      const row = window
        .getByTestId('settings-mcp-account-connections')
        .locator('tr', { hasText: 'Account recovery' });
      await row
        .getByRole('button', {
          name:
            authStatus === 'error' ? 'Reconnect in cloud' : 'Connect in cloud',
          exact: true,
        })
        .click();
      await expect(
        window.getByTestId('settings-account-canopy-cloud-section'),
      ).toBeVisible();
      await expect(
        window.getByText('Local OAuth must not run', { exact: true }),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Settings → MCP tab keeps its labels while values load, then fills them in place', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // Hold the page's preferences read until the test lets it go.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'preferences:load';
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      const held = new Promise((resolve) => {
        globalThis.releasePreferences = resolve;
      });
      ipcMain.handle(channel, async (...args) => {
        await held;
        return original(...args);
      });
    });

    await app.openSettings();
    await app.openSettingsSection('mcp');
    const page = window.getByTestId('settings-tab-mcp');
    await expect(page).toBeVisible();
    // Real headings and labels from the first frame; no centered "Loading…".
    await expect(page).toContainText('Local HTTP proxy');
    await expect(page).toContainText('Default auth path');
    await expect(page).toContainText('Proxy port');
    await expect(page.getByTestId('settings-skeleton-form')).toHaveCount(0);
    await expect(page.getByTestId('settings-mcp-port-input')).toHaveCount(0);
    // Only the values pulse, once the shared delay has passed.
    const values = page.getByTestId('settings-mcp-loading-value');
    await expect(values.first()).toBeVisible();
    await expect(values.first().locator('[skullet-bar]').first()).toBeVisible();
    await expect(page.getByTestId('slow-load-note')).toHaveText('');

    await electronApp.evaluate(() => globalThis.releasePreferences());
    await expect(page.getByTestId('settings-mcp-port-input')).toBeVisible();
    await expect(values).toHaveCount(0);
    await expect(page.getByTestId('slow-load-note')).toHaveCount(0);
    // Apply is a capsule that can be busy: it reserves its busy label.
    const apply = page.getByTestId('settings-mcp-save');
    await expect(apply).toHaveAttribute('aria-busy', 'false');
    await expect(
      apply.locator('[data-busy-layer="busy"] [data-reserved-label]'),
    ).toHaveAttribute('data-reserved-label', 'Applying…');
    await expect(apply).toHaveText('Apply');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-4267 Settings MCP Manage opens Customize Installed MCP servers', async () => {
  const launch = await launchCanopy();
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('mcp');
    await window.getByTestId('settings-mcp-manage').click();
    await expect(window.getByTestId('settings-tab-mcp')).toBeHidden();
    await expect(window.getByTestId('plugins-type-tab-app')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      window.getByTestId('customize-section-installed'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
