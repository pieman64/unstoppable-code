import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-3512: on Sep 27 telemetry uploads stopped with no attempts, errors or
// diagnostics, and nothing in the app said sync had stopped. A queue that stops
// draining now shows Sync paused in Settings › Privacy.

// Any `csk_` key outside the mock fixtures signs in with no organization.
const NO_ORG_KEY = 'csk_can3512_no_org';

/** Shares activity privately and skips the one-time sharing prompt. */
async function optIntoPrivateSharing(window) {
  await window.evaluate(async () => {
    await window.api.savePreferences({
      telemetrySharingPromptSeen: true,
      telemetrySharing: {
        transcripts: 'private',
        plans: 'private',
        metadata: 'private',
        summaries: 'private',
      },
    });
  });
}

test('CAN-3512: Privacy shows Sync paused for a stalled queue', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await optIntoPrivateSharing(window);
    // Signed out, `Sign in to sync` names the fix and outranks a stall.
    await connectMockCloudAccount(window, NO_ORG_KEY);
    await app.openSettings();
    await app.openSettingsSection('privacy');
    const status = window.getByTestId('settings-cloud-sync-status');
    await expect(status).toBeVisible();

    // Stand in for the main-process monitor's broadcast: a queue whose oldest
    // item passed the six-hour threshold with no upload since. It crosses the
    // real preload guard, so an unknown reason would never render.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const browserWindow of BrowserWindow.getAllWindows()) {
        browserWindow.webContents.send('telemetry-sync:status-event', {
          isSyncing: false,
          pendingCount: 12,
          sharingActive: true,
          lastSyncedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
          lastErrorAt: null,
          lastError: null,
          pausedReason: 'queue-stalled',
        });
      }
    });

    await expect(
      window.getByTestId('settings-cloud-sync-status-paused'),
    ).toBeVisible();
    await expect(status).toHaveText('Sync paused · 12 pending');
    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
