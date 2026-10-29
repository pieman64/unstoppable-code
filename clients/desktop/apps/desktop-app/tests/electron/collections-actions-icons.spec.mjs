import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collections table renders a share icon for each row', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    // Create a local Collection so we can see the Share icon in its row.
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await window.getByPlaceholder('My collection').fill('Demo Collection');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden({
      timeout: 5000,
    });

    await window.screenshot({
      path: testInfo.outputPath('collections-table-with-share-icon.png'),
      fullPage: true,
    });

    // The share icon is exposed via its accessible name "Share collection"
    // (CAN-2799: a rich tooltip, not a native title, explains it on hover).
    await expect(
      window.getByRole('button', { name: 'Share collection' }).first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
