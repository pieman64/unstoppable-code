import { selectProfileRoles } from './settingsProfileRoles.mjs';

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedWelcomeChecklist,
  setOnboardingRoleFromAssistant,
} from './seeders/seedWelcomeChecklist.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const CLOUD_API_KEY = 'csk_onboarding_profile_sync_e2e';
const SERIAL_ROLE_SAVE_API_KEY = 'csk_onboarding_serial_role_save_e2e';

test('assistant role changes replace earlier multi-role answers locally and in the cloud', async () => {
  const apiKey = 'csk_onboarding_assistant_role_change_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await window.getByTestId('sidebar-create-task').click();
    await selectProfileRoles(window, ['software-engineer', 'product-manager']);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            'onboardingProfileRoles:software-engineer,product-manager'
          ] ?? 0,
      )
      .toBe(1);
    // Deliver the assistant's real renderer action after the user has selected
    // multiple roles. The existing main-window bridge and preference IPC run.
    await setOnboardingRoleFromAssistant(launch.electronApp, 'designer');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .profileRole,
      )
      .toBe('designer');
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['designer']);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            'onboardingProfileRoles:designer'
          ] ?? 0,
      )
      .toBe(1);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-designer'),
    ).toBeVisible();
    await app.closeSettings();
    await window.reload();
    await app.waitForShell();
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['designer']);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('syncs selected Settings roles to the cloud and reconciles them after relaunch', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_onboarding_multi_role_sync_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  let firstClosed = false;
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await window.getByTestId('sidebar-create-task').click();
    await selectProfileRoles(window, ['software-engineer', 'designer']);
    const roleWrites = async () => {
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      return activity['onboardingProfileRoles:software-engineer,designer'] ?? 0;
    };
    await expect.poll(roleWrites, { timeout: 15_000 }).toBe(1);
    await closeCanopy(launch.electronApp, launch.userDataDir, {
      keepUserData: true,
    });
    firstClosed = true;
    const second = await launchCanopy({ userDataDir: launch.userDataDir });
    try {
      const window2 = await second.electronApp.firstWindow();
      await new CanopyAppDriver(window2).waitForShell();
      await expect.poll(roleWrites, { timeout: 15_000 }).toBe(2);
    } finally {
      await closeCanopy(second.electronApp, second.userDataDir);
    }
  } finally {
    if (!firstClosed) await closeCanopy(launch.electronApp, launch.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
