import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

const MEMORY_CLOUD_API_KEY = 'csk_memory_feedback_e2e';

async function openOrgMemorySettings(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.openSettings();
  await expect(window.getByTestId('settings-nav-memory')).toBeVisible();
  await app.openSettingsSection('memory');
  return {
    window,
    toggle: window.getByTestId('org-memory-enabled-toggle'),
  };
}

test('organization memory defaults on and persists an opt-out across relaunch', async () => {
  const first = await launchCanopy();
  const { userDataDir } = first;

  try {
    const window = await first.electronApp.firstWindow();
    await connectMockCloudAccount(window, MEMORY_CLOUD_API_KEY, {
      expectedStatus: {
        capabilities: expect.arrayContaining(['memorySearch']),
      },
    });

    const { window: settingsWindow, toggle } = await openOrgMemorySettings(
      first.electronApp,
    );
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    // CAN-3457: memory is searched only in the org that owns a project, so
    // the copy names the account's memory-eligible org.
    await expect(
      settingsWindow.getByTestId('org-memory-organization-names'),
    ).toHaveText(
      "Add relevant knowledge from past sessions to chats in Acme Memory's projects",
    );

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => {
        const persisted = JSON.parse(
          readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
        );
        return persisted.preferences?.orgMemoryInjectionEnabled;
      })
      .toBe(false);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await launchCanopy({ userDataDir });
  try {
    const { toggle } = await openOrgMemorySettings(second.electronApp);
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
