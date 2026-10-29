import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Settings → Chat exposes the "Automatically retry transient errors" section
// with the Chats / Pipelines checkboxes. Both default to enabled; toggling them
// runs through the shared preferences save path (persistence round-trip is
// validated jointly with the backend preferences store — see plan-backend.md).
test('Chat settings expose auto-retry transient error checkboxes that toggle', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    await app.openSettings();
    await app.openSettingsSection('chat');

    const chats = window.getByTestId('settings-auto-retry-transient-chats');
    const pipelines = window.getByTestId(
      'settings-auto-retry-transient-pipelines',
    );

    await expect(chats).toBeVisible();
    await expect(pipelines).toBeVisible();

    // Both default to enabled.
    await expect(chats).toBeChecked();
    await expect(pipelines).toBeChecked();

    // Toggling flips the control (fed by the saved preference on re-render).
    await chats.click();
    await expect(chats).not.toBeChecked();

    await pipelines.click();
    await expect(pipelines).not.toBeChecked();

    await window.screenshot({
      path: testInfo.outputPath('settings-auto-retry-transient.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
