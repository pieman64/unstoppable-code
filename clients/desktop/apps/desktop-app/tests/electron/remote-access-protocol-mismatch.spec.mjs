/**
 * Device-to-device remote access refuses to control a computer on another
 * remote-control protocol version. The window showing another computer runs
 * this computer's renderer against the other computer's handlers, so the two
 * must agree on the contract between them.
 *
 * Two desktops on one machine, one account, the real `apps/device-relay`.
 * The host reports protocol version 1, as releases before the check do,
 * through the E2E-only `CANOPY_E2E_REMOTE_PROTOCOL_VERSION` override. Pairing
 * still works; opening the host says to update the host, retries nothing on
 * its own, and the host never starts a bridge for the controller.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  pairDevices,
  remoteState,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const MISMATCH_TEXT =
  /runs version .+, which this computer \(version .+\) can't control\. Update .+ to connect\./;

/** Titles of the host's bridge windows, one per controller it serves. */
function bridgeWindowCount(electronApp) {
  return electronApp.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        (win) => win.getTitle() === 'Remote control bridge',
      ).length,
  );
}

test.describe('device-to-device remote access across protocol versions', () => {
  test.setTimeout(300_000);

  test('pairs, then refuses to control a computer on an older protocol', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_protocol_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-protocol-user',
        },
      },
    });

    let host = null;
    let controller = null;
    try {
      host = await launchDesktop({
        label: 'host',
        demoApp: 'ts-pnpm-vite',
        apiKey,
        env: { CANOPY_E2E_REMOTE_PROTOCOL_VERSION: '1' },
      });
      controller = await launchDesktop({ label: 'controller', apiKey });
      const hostDeviceId = await pairDevices(controller, host);

      const windowPromise = controller.electronApp.waitForEvent('window');
      await controller.window.evaluate(
        (deviceId) => window.api.remoteControl.openMachine(deviceId),
        hostDeviceId,
      );
      const remoteWindow = await windowPromise;
      await remoteWindow.waitForLoadState('domcontentloaded');

      const notice = remoteWindow.getByTestId(
        'remote-access-connection-notice',
      );
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice).toHaveAttribute('data-state', 'ended');
      await expect(notice).toContainText(MISMATCH_TEXT);
      // The host is the older one, so it is the one to update.
      await expect(notice).not.toContainText('Update this computer');

      const hostEntry = (await remoteState(controller.window)).hosts.find(
        (entry) => entry.deviceId === hostDeviceId,
      );
      expect(hostEntry).toMatchObject({ connection: 'error', ended: true });
      expect(hostEntry?.error).toMatch(MISMATCH_TEXT);

      // Reconnecting tries once more and is refused the same way.
      await remoteWindow
        .getByTestId('remote-access-connection-notice-reconnect')
        .click();
      await expect(notice).toHaveAttribute('data-state', 'ended', {
        timeout: 30_000,
      });
      await expect(notice).toContainText(MISMATCH_TEXT);

      // The host served nothing: no bridge ever ran the controller's calls.
      expect(await bridgeWindowCount(host.electronApp)).toBe(0);
    } finally {
      if (controller)
        await closeCanopy(controller.electronApp, controller.userDataDir);
      if (host) await closeCanopy(host.electronApp, host.userDataDir);
      await relay.stop();
    }
  });
});
