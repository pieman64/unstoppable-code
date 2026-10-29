import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Cloud sync (CAN-402 follow-up), reworked for the account-menu UX cleanup.
//
// The account-row popover is no longer a catch-all: the old "Cloud Sync" status
// item was removed. Without hosted account settings the connect block lives in
// Settings › Privacy, alongside the telemetry sharing controls; with them
// (CAN-4421, the launcher default) it is the hosted Account page's "Signed in
// on this computer" card and Privacy keeps only Activity sharing.

async function expectNoCloudSyncMenuItem(window) {
  await window.getByTestId('sidebar-account-row').click();
  await expect(window.getByTestId('sidebar-account-menu')).toBeVisible();
  await expect(
    window.getByTestId('sidebar-account-menu-item-cloud-sync'),
  ).toHaveCount(0);
  await window.keyboard.press('Escape');
}

test('cloud sync connect block renders in Settings › Privacy without hosted account settings', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-hosted-settings': false,
      }),
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await expectNoCloudSyncMenuItem(window);

    await app.openSettings();
    await app.openSettingsSection('privacy');
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
    await expect(
      window.getByRole('heading', { name: 'Cloud Sync' }),
    ).toBeVisible();

    // The Privacy tab embeds the shared Canopy Cloud connect section.
    await expect(
      window.getByTestId('settings-account-canopy-cloud-section'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('privacy-cloud-sync-section.png'),
    });

    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cloud sync connect block is the hosted Account device card with hosted account settings', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await expectNoCloudSyncMenuItem(window);

    await app.openSettings();
    await app.openSettingsSection('privacy');
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
    await expect(
      window.getByRole('heading', { name: 'Cloud Sync' }),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('settings-account-canopy-cloud-section'),
    ).toHaveCount(0);

    await app.openAccountSettingsPage('account');
    await expect(
      window
        .getByTestId('account-device-card-cloud-account')
        .getByTestId('settings-account-canopy-cloud-section'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('account-cloud-sync-section.png'),
    });

    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
