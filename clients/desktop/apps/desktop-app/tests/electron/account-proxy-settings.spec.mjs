import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';

/**
 * Account proxy settings (CAN-4019).
 *
 * Opting in under Experiments adds Settings > Multi-account proxy. Connecting to a
 * fake CLIProxyAPI v8 server lists its signed-in and API-key accounts with
 * their status and limits, and the More menu turns a signed-in account off
 * and removes it on the server. Settings > Accounts lists the same accounts
 * under the proxy's provider row. A wrong key shows its error under the key
 * field and is not saved.
 */

function readPreferences(window) {
  return window.evaluate(() => window.api.loadPreferences());
}

test('opting in, connecting to a server, and managing its accounts', async () => {
  test.setTimeout(180_000);
  const proxy = await startFakeAccountProxy();
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // Opt in. The page is not in Settings until then.
    await app.openSettings();
    await expect(window.getByTestId('settings-nav-account-proxy')).toHaveCount(
      0,
    );
    await app.openSettingsSection('experiments');
    const optIn = window.getByTestId('account-proxy-opt-in-toggle');
    await expect(optIn).toHaveAttribute('aria-checked', 'false');
    await expect(
      window.getByTestId('settings-experiments-account-proxy'),
    ).toContainText("Check each provider's terms.");
    await optIn.click();
    await expect(optIn).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await readPreferences(window)).accountProxyEnabled)
      .toBe(true);

    // The page joins the nav directly under Providers, in Agents (CAN-4421:
    // with hosted account settings on, Providers and the proxy moved there).
    await expect(window.getByTestId('settings-nav-account-proxy')).toHaveText(
      'Multi-account proxy',
    );
    const agentRows = await window
      .getByTestId('settings-nav-group-agents')
      .locator('[data-testid^="settings-nav-"]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid));
    const providersIndex = agentRows.indexOf('settings-nav-account');
    expect(providersIndex).toBeGreaterThanOrEqual(0);
    expect(agentRows[providersIndex + 1]).toBe('settings-nav-account-proxy');

    await window.getByTestId('account-proxy-open-settings').click();
    const page = window.getByTestId('settings-tab-account-proxy');
    await expect(page).toBeVisible();

    // A wrong key: the error sits under the key and nothing is saved.
    await window.getByTestId('account-proxy-url-input').fill(proxy.url);
    await window.getByTestId('account-proxy-key-input').fill('mk-wrong');
    await window.getByTestId('account-proxy-connect').click();
    await expect(window.getByTestId('account-proxy-key-error')).toContainText(
      "That key didn't work",
    );
    expect((await readPreferences(window)).accountProxyConnection ?? null).toBe(
      null,
    );

    // The right key connects and lists every account.
    await window
      .getByTestId('account-proxy-key-input')
      .fill(FAKE_PROXY_MANAGEMENT_KEY);
    await window.getByTestId('account-proxy-connect').click();
    await expect(window.getByTestId('account-proxy-connection')).toContainText(
      'version 8.0.27',
    );
    const accounts = window.getByTestId('account-proxy-accounts');
    await accounts
      .getByTestId('account-proxy-account-a1f3c2d4a1f3c2d4')
      .locator('summary')
      .click();
    await expect(
      accounts.getByTestId('account-proxy-account-a1f3c2d4a1f3c2d4'),
    ).toContainText('5-hour window');
    await expect(
      accounts
        .getByTestId('account-proxy-account-a1f3c2d4a1f3c2d4')
        .getByRole('progressbar')
        .first(),
    ).toHaveAttribute('aria-valuenow', '64');
    await expect(
      accounts.getByTestId('account-proxy-account-9b07e1aa9b07e1aa'),
    ).toContainText('Usage limit reached. Back at');
    await expect(
      accounts.getByTestId('account-proxy-account-4c55d0194c55d019'),
    ).toContainText('ChatGPT Pro');
    await expect(
      accounts.getByTestId('account-proxy-account-e2a8f640e2a8f640'),
    ).toContainText('API key');
    // The upstream key in the server's config never reaches the page.
    await expect(page).not.toContainText('sk-must-never-appear');
    // Account order is the server's own setting, changed on the server.
    const strategy = window.getByTestId('account-proxy-strategy-select');
    await expect(strategy).toHaveValue('round-robin');
    await strategy.selectOption('fill-first');
    await expect
      .poll(() => proxy.state.config.routing.strategy)
      .toBe('fill-first');
    await expect(strategy).toBeEnabled();
    await expect(strategy).toHaveValue('fill-first');
    expect(
      proxy.requests.find(
        (request) =>
          request.method === 'PUT' &&
          request.path === '/v8/management/config/routing/strategy',
      )?.body,
    ).toBe('fill-first');
    await expect(
      window.getByTestId('account-proxy-strategy-select').locator('option'),
    ).toHaveText(['Round robin', 'Weighted round robin', 'Fill first']);
    await expect(
      window.getByTestId('account-proxy-keep-chat-toggle'),
    ).toHaveAttribute('aria-checked', 'true');
    // Routing: on for both harnesses by default, and each switch says which
    // work it sends through the proxy (CAN-4030).
    const routeClaude = window.getByTestId('account-proxy-route-claude-toggle');
    await expect(routeClaude).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('account-proxy-route-codex-toggle'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page).toContainText(
      "Claude chats, subagents, and pipeline steps on this device use this server's Claude accounts.",
    );
    await routeClaude.click();
    await expect
      .poll(async () => (await readPreferences(window)).accountProxyRouteClaude)
      .toBe(false);
    await routeClaude.click();
    await expect(routeClaude).toHaveAttribute('aria-checked', 'true');
    const saved = await readPreferences(window);
    expect(saved.accountProxyConnection?.url).toBe(proxy.url);
    expect(JSON.stringify(saved)).not.toContain(FAKE_PROXY_MANAGEMENT_KEY);

    // API-key accounts have no menu: the server's config owns them.
    await expect(
      window.getByTestId('account-proxy-account-menu-e2a8f640e2a8f640'),
    ).toHaveCount(0);

    // Turn a signed-in account off.
    await window
      .getByTestId('account-proxy-account-menu-a1f3c2d4a1f3c2d4')
      .click();
    await window.getByTestId('account-proxy-account-toggle').click();
    await expect(
      accounts.getByTestId('account-proxy-account-a1f3c2d4a1f3c2d4'),
    ).toContainText('Turned off');
    expect(
      proxy.requests.find(
        (request) =>
          request.method === 'PATCH' &&
          request.path === '/v8/management/credentials/status',
      )?.body,
    ).toEqual({
      name: 'claude-sam@example.com.json',
      auth_index: 'a1f3c2d4a1f3c2d4',
      disabled: true,
    });

    // Remove it, after confirming.
    await window
      .getByTestId('account-proxy-account-menu-a1f3c2d4a1f3c2d4')
      .click();
    await window.getByTestId('account-proxy-account-remove').click();
    await expect(
      window.getByTestId('account-proxy-remove-confirm'),
    ).toBeVisible();
    await window.getByTestId('account-proxy-remove-confirm-button').click();
    await expect(
      accounts.getByTestId('account-proxy-account-a1f3c2d4a1f3c2d4'),
    ).toHaveCount(0);
    expect(
      proxy.requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.path ===
            '/v8/management/credentials?name=claude-sam%40example.com.json',
      ),
    ).toBe(true);

    // Settings > Providers lists the same accounts under the proxy row.
    await app.openSettingsSection('account');
    const providerRow = window.getByTestId('settings-account-proxy-provider');
    await expect(providerRow).toContainText('3 accounts · 2 ready');
    await expect(
      providerRow.getByTestId('account-proxy-account-9b07e1aa9b07e1aa'),
    ).toBeVisible();

    // Disconnect forgets the server.
    await providerRow.getByTestId('settings-account-proxy-manage').click();
    await window.getByTestId('account-proxy-disconnect').click();
    await expect(
      window.getByTestId('account-proxy-connect-form'),
    ).toBeVisible();
    expect((await readPreferences(window)).accountProxyConnection ?? null).toBe(
      null,
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await proxy.close();
  }
});
