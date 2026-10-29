import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collection modal renders UnifiedTable picker', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    await window.screenshot({
      path: testInfo.outputPath('collections-tab.png'),
      fullPage: true,
    });

    // Open the New Collection modal so we can compare its UX with the shared one.
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await expect(window.getByPlaceholder('My collection')).toBeVisible();
    await expect(window.getByPlaceholder('Optional description')).toBeVisible();
    // UnifiedTable filter bar
    await expect(window.getByPlaceholder('Search by name…')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('local-collection-modal.png'),
      fullPage: true,
    });

    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a local Collection description shows the Markdown hint and a plain-text row', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();

    const hint = window.getByTestId('collection-description-hint');
    await expect(hint).toHaveText('Markdown works here.');
    const descriptionField = window.getByPlaceholder('Optional description');
    await expect(descriptionField).toHaveAttribute(
      'aria-describedby',
      (await hint.getAttribute('id')) ?? '',
    );

    await window.getByPlaceholder('My collection').fill('Release kit');
    await descriptionField.fill(
      'Ships a **release**.\n\n1. Tags main\n2. Posts notes',
    );
    await window
      .getByRole('button', { name: /^(Create|Save)$/ })
      .last()
      .click();
    await expect(window.locator('#collection-modal-title')).toBeHidden();

    const row = window.getByRole('row').filter({ hasText: 'Release kit' });
    await expect(row).toContainText('Ships a release. Tags main. Posts notes');
    await expect(row).not.toContainText('**');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
