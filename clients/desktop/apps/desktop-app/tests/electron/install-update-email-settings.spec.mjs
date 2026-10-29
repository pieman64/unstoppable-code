import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';

const API_KEY = 'csk_install_update_emails_e2e';

async function activityCount(name) {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    API_KEY,
  );
  return activity[name] ?? 0;
}

// CAN-2334: the shared "Updates to things I've installed" row in Settings →
// Account → Notifications loads the account value and saves it through the v1 route.
test('install update email setting loads and saves through the account route', async () => {
  await registerHostedSettingsScenario(API_KEY, 'hosted-settings-signed-in', {
    scenario: {
      cloud: {
        notificationPreferences: {
          pushEnabled: true,
          installUpdateEmailsEnabled: false,
        },
      },
    },
  });
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await connectMockCloudAccount(window, API_KEY);

    // With hosted account settings on (the E2E default), the local
    // Notifications page is gone; the row lives only on the shared hosted
    // Account → Notifications page.
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');
    await expect(window.getByTestId('settings-nav-notifications')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('account-notifications-page'),
    ).toBeVisible();

    const section = window.getByTestId('install-update-emails-setting');
    await expect(section).toBeVisible();
    await expect(section).toContainText("Updates to things I've installed");
    const toggle = window.getByTestId('install-update-emails-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() => activityCount('notificationPreferencesPatch'))
      .toBe(1);

    // Re-mount so the value is re-read from the server rather than shown
    // from the renderer's state.
    await app.closeSettings();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');
    await expect(
      window.getByTestId('install-update-emails-toggle'),
    ).toHaveAttribute('aria-checked', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, API_KEY);
  }
});
