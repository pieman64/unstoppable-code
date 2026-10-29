import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { accountProxyRuntimeFixture } from './fixtures/account-proxy-runtime.mjs';

/**
 * Account proxy on this device (CAN-4023).
 *
 * "This device" downloads a CLIProxyAPI release (a fixture served from
 * loopback), starts it, and makes it the connection. An account signed in
 * through it from Settings appears once the browser sign-in finishes. The
 * account order chosen in Settings outlasts a restart. The proxy stops,
 * starts, and restarts from Settings, and Disconnect stops it and returns to
 * setup.
 */

function readPreferences(window) {
  return window.evaluate(() => window.api.loadPreferences());
}

async function proxyAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

test('running the proxy on this device and adding an account', async () => {
  test.setTimeout(180_000);
  const runtime = await accountProxyRuntimeFixture();
  const launched = await launchCanopy({ env: runtime.env });
  let port = 0;
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );

    await app.openSettings();
    await app.openSettingsSection('account-proxy');
    await expect(
      window.getByTestId('settings-tab-account-proxy'),
    ).toBeVisible();

    // Choose This device: one button downloads and starts the proxy.
    await window.getByTestId('account-proxy-mode-local').click();
    await expect(window.getByTestId('account-proxy-local-setup')).toContainText(
      'Downloads CLIProxyAPI 8.0.28',
    );
    await window.getByTestId('account-proxy-local-start').click();
    const connection = window.getByTestId('account-proxy-local-connection');
    await expect(connection).toContainText('Running · version 8.0.28', {
      timeout: 30_000,
    });
    expect(runtime.state.downloads).toBe(1);
    const preferences = await readPreferences(window);
    expect(preferences.accountProxyConnection?.kind).toBe('local');
    port = Number(new URL(preferences.accountProxyConnection?.url ?? '').port);
    expect(await proxyAnswers(port)).toBe(true);
    await expect(connection).toContainText(`127.0.0.1:${port}`);

    // Add an account: the row waits for the browser, then the account lists.
    await window.getByTestId('account-proxy-add-account').click();
    await window.getByTestId('account-proxy-add-account-claude').click();
    await expect(window.getByTestId('account-proxy-sign-in')).toContainText(
      'Finish signing in in your browser.',
    );
    await expect(
      window.getByTestId('account-proxy-account-b2c3d4e5b2c3d4e5'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId('account-proxy-sign-in')).toHaveCount(0);

    // Change the account order on the running proxy.
    const strategy = window.getByTestId('account-proxy-strategy-select');
    await expect(strategy).toHaveValue('round-robin');
    await strategy.selectOption('fill-first');
    await expect
      .poll(
        async () =>
          (await readPreferences(window)).accountProxyLocalRoutingStrategy,
      )
      .toBe('fill-first');
    await expect(strategy).toHaveValue('fill-first');

    // Stop, start, and restart from Settings.
    await window.getByTestId('account-proxy-local-stop').click();
    await expect(connection).toContainText('Stopped.');
    expect(await proxyAnswers(port)).toBe(false);
    await expect(
      window.getByTestId('account-proxy-add-account'),
    ).toBeDisabled();
    await expect(strategy).toBeDisabled();
    await window.getByTestId('account-proxy-local-start').click();
    await expect(connection).toContainText('Running', { timeout: 30_000 });
    await window.getByTestId('account-proxy-local-restart').click();
    await expect(connection).toContainText('Running', { timeout: 30_000 });
    // Started from the installed copy: nothing downloaded again.
    expect(runtime.state.downloads).toBe(1);
    // The config written on each start keeps the chosen order.
    await expect(strategy).toBeEnabled();
    await expect(strategy).toHaveValue('fill-first');

    // Start with the app is on by default and saves when turned off.
    const startWithApp = window.getByTestId(
      'account-proxy-local-start-with-app',
    );
    await expect(startWithApp).toHaveAttribute('aria-checked', 'true');
    await startWithApp.click();
    await expect
      .poll(
        async () =>
          (await readPreferences(window)).accountProxyLocalStartWithApp,
      )
      .toBe(false);

    // Disconnect stops the proxy and returns to setup.
    await window.getByTestId('account-proxy-disconnect').click();
    await expect(window.getByTestId('account-proxy-mode')).toBeVisible();
    expect((await readPreferences(window)).accountProxyConnection ?? null).toBe(
      null,
    );
    await expect.poll(() => proxyAnswers(port)).toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await runtime.close();
  }
  // Quitting leaves no proxy behind.
  if (port) expect(await proxyAnswers(port)).toBe(false);
});
