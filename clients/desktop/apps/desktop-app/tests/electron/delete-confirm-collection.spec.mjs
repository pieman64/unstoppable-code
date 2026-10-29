import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collections delete icon opens a confirmation modal', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');

    // Create a local Collection so the row has a delete icon.
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await window.getByPlaceholder('My collection').fill('Delete Demo');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden({
      timeout: 5000,
    });

    // Clicking the delete icon must open the confirmation modal, NOT delete.
    await window
      .getByRole('button', { name: 'Delete collection' })
      .first()
      .click();
    await expect(
      window.getByRole('dialog').filter({ hasText: 'Delete collection' }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('delete-confirm-collection.png'),
      fullPage: true,
    });

    // Cancel — row should still be present.
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      window.getByRole('cell', { name: 'Delete Demo' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
