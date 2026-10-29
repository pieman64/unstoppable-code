/**
 * The account proxy over device-to-device remote access.
 *
 * The proxy routes the controlled computer's agents, so a window showing that
 * computer shows and changes its Account proxy settings, not the
 * controller's: running the proxy there, routing, and disconnecting all act
 * on the host and leave the controller's own settings alone.
 *
 * Adding an account from that window opens the provider page in the
 * controller's browser. The controller catches the browser's redirect on its
 * own loopback port and sends it to the host, whose proxy finishes the
 * sign-in; the host never opens a browser itself.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { accountProxyRuntimeFixture } from './fixtures/account-proxy-runtime.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const SIGNED_IN_ACCOUNT = 'account-proxy-account-b2c3d4e5b2c3d4e5';

function readPreferences(window) {
  return window.evaluate(() => window.api.loadPreferences());
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Records the pages a desktop hands to the system browser. */
async function externalOpenCapture() {
  const urls = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      urls.push(JSON.parse(body).url);
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    urls,
    url: `http://127.0.0.1:${server.address().port}/open`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test.describe('device-to-device remote access, account proxy', () => {
  test.setTimeout(300_000);

  test("the controller manages the host's proxy and adds an account to it", async () => {
    const relay = await startDeviceRelay();
    const runtime = await accountProxyRuntimeFixture();
    const hostOpens = await externalOpenCapture();
    const controllerOpens = await externalOpenCapture();
    const claudeCallbackPort = await freePort();
    const apiKey = `csk_remote_proxy_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-proxy-user',
        },
      },
    });

    const desktops = [];
    try {
      const host = await launchDesktop({
        label: 'proxy-host',
        apiKey,
        env: {
          ...runtime.env,
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: hostOpens.url,
        },
      });
      desktops.push(host);
      const controller = await launchDesktop({
        label: 'proxy-controller',
        apiKey,
        env: {
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: controllerOpens.url,
          CANOPY_E2E_ACCOUNT_PROXY_CALLBACK_PORTS: JSON.stringify({
            claude: claudeCallbackPort,
            codex: await freePort(),
          }),
        },
      });
      desktops.push(controller);
      await host.window.evaluate(() =>
        window.api.savePreferences({ accountProxyEnabled: true }),
      );

      await pairDevices(controller, host);
      const { window: remoteWindow } = await openRemoteWindow(controller, host);
      await expect(remoteWindow.getByTestId('app-sidebar')).toBeVisible({
        timeout: 60_000,
      });

      // The host opted in, so its window on the controller lists the page.
      const remoteDriver = new CanopyAppDriver(remoteWindow);
      await remoteDriver.openSettings();
      await remoteDriver.openSettingsSection('account-proxy');
      await expect(
        remoteWindow.getByTestId('settings-tab-account-proxy'),
      ).toBeVisible();

      // Run the proxy on the host from the controller.
      await remoteWindow.getByTestId('account-proxy-mode-local').click();
      await expect(
        remoteWindow.getByTestId('account-proxy-local-setup'),
      ).toContainText('Downloads CLIProxyAPI 8.0.28');
      await remoteWindow.getByTestId('account-proxy-local-start').click();
      const connection = remoteWindow.getByTestId(
        'account-proxy-local-connection',
      );
      await expect(connection).toContainText('Running · version 8.0.28', {
        timeout: 30_000,
      });
      expect(runtime.state.downloads).toBe(1);
      expect(
        (await readPreferences(host.window)).accountProxyConnection?.kind,
      ).toBe('local');
      await expect
        .poll(() =>
          host.window.evaluate(() =>
            window.api.accountProxy.status().then((status) => status.local),
          ),
        )
        .toMatchObject({ phase: 'running' });

      // Add an account: the provider page opens in the controller's browser.
      await remoteWindow.getByTestId('account-proxy-add-account').click();
      await remoteWindow
        .getByTestId('account-proxy-add-account-claude')
        .click();
      await expect(
        remoteWindow.getByTestId('account-proxy-sign-in'),
      ).toContainText('Finish signing in in your browser.');
      await expect.poll(() => controllerOpens.urls.length).toBe(1);
      const page = new URL(controllerOpens.urls[0]);
      expect(page.origin).toBe('https://claude.ai');
      const signInState = page.searchParams.get('state');
      expect(signInState).toBeTruthy();
      expect(hostOpens.urls).toEqual([]);

      // The browser's redirect lands on the controller. Only the expected
      // path and state are taken; the right one goes to the host's proxy.
      const callbackBase = `http://127.0.0.1:${claudeCallbackPort}`;
      expect(
        (await fetch(`${callbackBase}/callback?code=x&state=wrongstate0000`))
          .status,
      ).toBe(400);
      expect(
        (
          await fetch(
            `${callbackBase}/auth/callback?code=x&state=${signInState}`,
          )
        ).status,
      ).toBe(404);
      const redirect = await fetch(
        `${callbackBase}/callback?code=e2e-code&state=${signInState}`,
      );
      expect(redirect.status).toBe(200);
      await expect(remoteWindow.getByTestId(SIGNED_IN_ACCOUNT)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        remoteWindow.getByTestId('account-proxy-sign-in'),
      ).toHaveCount(0);
      // The controller stopped listening once the redirect went through.
      await expect
        .poll(() =>
          fetch(`${callbackBase}/callback`).then(
            () => 'listening',
            () => 'closed',
          ),
        )
        .toBe('closed');
      expect(hostOpens.urls).toEqual([]);

      // Routing changes save on the host.
      const routeClaude = remoteWindow.getByTestId(
        'account-proxy-route-claude-toggle',
      );
      await expect(routeClaude).toHaveAttribute('aria-checked', 'true');
      await routeClaude.click();
      await expect
        .poll(
          async () =>
            (await readPreferences(host.window)).accountProxyRouteClaude,
        )
        .toBe(false);
      await expect(routeClaude).toHaveAttribute('aria-checked', 'false');

      // None of it touched the controller's own settings or proxy.
      const own = await readPreferences(controller.window);
      expect(own.accountProxyEnabled).not.toBe(true);
      expect(own.accountProxyConnection ?? null).toBe(null);
      expect(own.accountProxyRouteClaude).not.toBe(false);
      expect(
        (
          await controller.window.evaluate(() =>
            window.api.accountProxy.status(),
          )
        ).available,
      ).toBe(false);
      const controllerDriver = new CanopyAppDriver(controller.window);
      await controllerDriver.openSettings();
      await expect(
        controller.window.getByTestId('settings-nav-account-proxy'),
      ).toHaveCount(0);

      // Disconnecting from the controller stops the host's proxy.
      await remoteWindow.getByTestId('account-proxy-disconnect').click();
      await expect(
        remoteWindow.getByTestId('account-proxy-mode'),
      ).toBeVisible();
      expect(
        (await readPreferences(host.window)).accountProxyConnection ?? null,
      ).toBe(null);
    } finally {
      for (const desktop of desktops.reverse()) {
        await closeCanopy(desktop.electronApp, desktop.userDataDir);
      }
      await runtime.close();
      await hostOpens.close();
      await controllerOpens.close();
      await relay.stop();
    }
  });
});
