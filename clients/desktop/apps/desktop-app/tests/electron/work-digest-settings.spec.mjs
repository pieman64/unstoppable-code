import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const DIGEST_API_KEY = 'csk_digest_preferences_e2e';

// The Settings work-digest panel exists only without hosted account settings
// (CAN-4421: with them, the shared Notifications / Digests pages replace it,
// covered by their web suites), so this spec runs with that rollout flag off.
const HOSTED_SETTINGS_OFF_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-hosted-settings': false,
  }),
};

test('connected cloud Work Digest settings load and save through the server mirror', async () => {
  await registerScenario(DEFAULT_MOCK_BASE_URL, DIGEST_API_KEY, {
    cloud: {
      digestPreferences: {
        daily: false,
        weekly: true,
        monthly: false,
        weeklyAnchorDay: 1,
        monthlyAnchorDay: 1,
      },
    },
  });
  const { electronApp, userDataDir } = await launchCanopy({
    env: HOSTED_SETTINGS_OFF_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await connectMockCloudAccount(window, DIGEST_API_KEY);

    await app.openSettings();
    await app.openSettingsSection('notifications');
    await app.expectSettingsSection('notifications');

    const section = window.getByTestId('settings-cloud-digests');
    await expect(section).toBeVisible();
    await expect(
      window.getByTestId('cloud-digest-toggle-weekly'),
    ).toBeChecked();
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          DIGEST_API_KEY,
        );
        return activity.digestPreferencesRead ?? 0;
      })
      .toBe(1);
    const monthly = window.getByTestId('cloud-digest-toggle-monthly');
    await expect(monthly).not.toBeChecked();

    await monthly.check();
    await expect(monthly).toBeChecked();
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          DIGEST_API_KEY,
        );
        return activity.digestPreferencesPatch ?? 0;
      })
      .toBe(1);

    // The weekly anchor: the cadence copy must be derived from it, not the
    // hardcoded "Every Monday" this surface used to carry.
    const weeklyAnchor = window.getByTestId('cloud-digest-anchor-weekly');
    await expect(weeklyAnchor).toHaveValue('1');
    await expect(section).toContainText(
      'Every Monday, covering the previous week.',
    );

    await weeklyAnchor.selectOption('5');
    await expect(section).toContainText(
      'Every Friday, covering the previous week.',
    );
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          DIGEST_API_KEY,
        );
        return activity.digestPreferencesPatch ?? 0;
      })
      .toBe(2);

    // Re-mount the settings surface so the anchor is re-read from the server
    // rather than shown from the renderer's optimistic state.
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('notifications');
    await app.expectSettingsSection('notifications');

    await expect(window.getByTestId('cloud-digest-anchor-weekly')).toHaveValue(
      '5',
    );
    await expect(window.getByTestId('settings-cloud-digests')).toContainText(
      'Every Friday, covering the previous week.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, DIGEST_API_KEY);
  }
});
