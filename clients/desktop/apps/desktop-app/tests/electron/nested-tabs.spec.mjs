import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('Collections page exposes Local/Shared nested tabs', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');

    await expect(
      window.locator('[data-testid="collections-view-tab-local"]'),
    ).toBeVisible();
    await expect(
      window.locator('[data-testid="collections-view-tab-shared"]'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('collections-tab-local.png'),
      fullPage: true,
    });

    // Switch to Shared — Add button must disappear.
    await window.locator('[data-testid="collections-view-tab-shared"]').click();
    await expect(
      window.getByRole('button', { name: 'Add', exact: true }),
    ).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('collections-tab-shared.png'),
      fullPage: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Skills page exposes Local/Shared nested tabs', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');

    await expect(
      window.locator('[data-testid="skills-view-tab-local"]'),
    ).toBeVisible();
    await expect(
      window.locator('[data-testid="skills-view-tab-shared"]'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('skills-tab-local.png'),
      fullPage: true,
    });

    await window.locator('[data-testid="skills-view-tab-shared"]').click();
    // Create Skill / Add Skills toolbar buttons must be hidden on Shared.
    await expect(
      window.getByRole('button', { name: 'Create skill' }),
    ).toBeHidden();
    await expect(
      window.getByRole('button', { name: 'Add skills' }),
    ).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('skills-tab-shared.png'),
      fullPage: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
