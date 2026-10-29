/**
 * App Advisor through device-to-device remote access.
 *
 * The window that shows another computer opens App Advisor for that computer
 * in a second window on this one. App Advisor's renderer tools answer from
 * the windows the user is looking at: asking for the UI state from that App
 * Advisor window reads this computer's remote window, not the controlled
 * computer's own screen.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
} from './helpers/remoteAccess.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

function isAppAdvisorPage(page) {
  return page.url().includes('surface=app-advisor');
}

test.describe('App Advisor through remote access', () => {
  test.setTimeout(300_000);

  test('opens App Advisor for the other computer on this one and reads this window', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_app_advisor_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-app-advisor-user',
        },
      },
    });
    let host = null;
    let controller = null;
    try {
      host = await launchDesktop({
        label: 'advisor-host',
        demoApp: 'ts-pnpm-vite',
        apiKey,
      });
      controller = await launchDesktop({
        label: 'advisor-controller',
        apiKey,
      });
      await pairDevices(controller, host);
      const { window: remoteWindow } = await openRemoteWindow(controller, host);

      // Leave the remote window on a page the host's own window is not on.
      await new CanopyAppDriver(remoteWindow).openStatisticsPage();

      const advisorPromise = controller.electronApp.waitForEvent('window', {
        predicate: isAppAdvisorPage,
        timeout: 60_000,
      });
      const opened = await remoteWindow.evaluate(() =>
        window.api.appAdvisor.openWindow({ focus: true }),
      );
      expect(opened).toMatchObject({ layout: 'full' });
      const advisor = await advisorPromise;
      await advisor.waitForLoadState('domcontentloaded');
      expect(
        await advisor.evaluate(() => window.api.remoteControl.getContext()),
      ).toMatchObject({ mode: 'remote', deviceId: host.deviceId });
      await expect(
        advisor.getByTestId('app-advisor-workspace-surface').first(),
      ).toBeVisible({ timeout: 60_000 });

      // The controlled computer's own App Advisor did not open.
      expect(host.electronApp.windows().some(isAppAdvisorPage)).toBe(false);

      // The controlled computer asks this computer's remote window for the
      // UI state, so the answer describes the page shown here.
      const state = await advisor.evaluate(() =>
        window.api.appAdvisor.getState(),
      );
      expect(state.snapshot.activePage).toBe('statistics');
      const hostState = await host.window.evaluate(() =>
        window.api.appAdvisor.getState(),
      );
      expect(hostState.snapshot.activePage).not.toBe('statistics');

      // Closing hides the window here and keeps its page; opening again
      // reuses it. (Automation keeps windows hidden, so neither reports open.)
      await expect(
        remoteWindow.evaluate(() => window.api.appAdvisor.closeWindow()),
      ).resolves.toMatchObject({ open: false, layout: 'full' });
      expect(advisor.isClosed()).toBe(false);
      await remoteWindow.evaluate(() =>
        window.api.appAdvisor.openWindow({ focus: true }),
      );
      expect(
        controller.electronApp.windows().filter(isAppAdvisorPage),
      ).toHaveLength(1);
    } finally {
      if (controller)
        await closeCanopy(controller.electronApp, controller.userDataDir);
      if (host) await closeCanopy(host.electronApp, host.userDataDir);
      await relay.stop();
    }
  });
});
