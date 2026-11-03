import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collections row offers Share in its menu', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    // Create a local Collection through Add custom so its Customize row
    // (CAN-4267: the former Collections table is gone) has a Share action.
    await window.getByTestId('plugins-add-custom-menu').click();
    await window.getByTestId('plugins-add-custom-collection').click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await window.getByPlaceholder('My collection').fill('Demo Collection');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden({
      timeout: 5000,
    });
    // Saving opens the new collection's detail; its row is on the list
    // behind it.
    await app.expectCreatedCustomizeDetail('Demo Collection');
    await app.closeMarketplaceEntryDetail();

    const row = window
      .getByTestId('customize-section-installed')
      .locator('[data-testid^="customize-row-collection:local:"]')
      .filter({ hasText: 'Demo Collection' });
    await expect(row).toBeVisible();

    const entryId = (await row.getAttribute('data-testid')).replace(
      'customize-row-',
      '',
    );
    await window.getByTestId(`customize-row-menu-${entryId}`).click();
    const share = window.getByTestId(`customize-row-menu-${entryId}-share`);
    await expect(share).toBeVisible();
    await expect(share).toHaveAccessibleName('Share…');
    await expect(share).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
