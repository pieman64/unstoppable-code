import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collections Delete asks for confirmation before deleting', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');

    // Create a local Collection through Add custom so there is one to delete.
    await window.getByTestId('plugins-add-custom-menu').click();
    await window.getByTestId('plugins-add-custom-collection').click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await window.getByPlaceholder('My collection').fill('Delete Demo');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden({
      timeout: 5000,
    });

    // CAN-4267 removed the Collections table and its per-row delete icon.
    // Deleting a local Collection now starts from its details, which saving
    // opens: Edit opens the collection editor, whose Delete asks for
    // confirmation in place.
    const row = window
      .getByTestId('customize-section-installed')
      .locator('[data-testid^="customize-row-collection:local:"]')
      .filter({ hasText: 'Delete Demo' });
    await app.expectCreatedCustomizeDetail('Delete Demo');
    await window.getByTestId('collection-read-action-edit').click();
    const editor = window
      .getByRole('dialog')
      .filter({ has: window.locator('#collection-modal-title') });
    await expect(editor).toBeVisible();

    // Clicking Delete must ask for confirmation, NOT delete.
    await editor.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmation = editor.getByText('Are you sure?', { exact: true });
    await expect(confirmation).toBeVisible();
    await expect(
      editor.getByRole('button', { name: 'Confirm', exact: true }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('delete-confirm-collection.png'),
      fullPage: true,
    });

    // Cancel the confirmation, then the editor — the collection remains.
    await confirmation
      .locator('..')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(row).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
