import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

// CAN-4267: the Local/Shared tab strips were deleted with the management
// overlay. Customize separates the same two lists into sections of one tab:
// Added/Installed holds local items, "Shared by me" the viewer's own shares.
// The default mock account owns `marketplace-review-collection` and
// `marketplace-review-skill`, so both tabs have one shared row.

test('Collections tab separates added collections from shared ones', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_nested_tabs_collections');
    await app.openPluginsPage();
    await app.openPluginsTab('collections');

    const sharedRowId =
      'customize-row-collection:shared:marketplace-review-collection';
    const added = window.getByTestId('customize-section-installed');
    const sharedByMe = window.getByTestId('customize-section-shared-by-me');
    await expect(added.getByRole('heading', { name: /^Added/ })).toBeVisible();
    await expect(sharedByMe).toBeVisible({ timeout: 20_000 });
    await expect(sharedByMe.getByTestId(sharedRowId)).toBeVisible();
    await expect(added.getByTestId(sharedRowId)).toHaveCount(0);

    // Creation lives in the page-level Add custom menu, outside every section,
    // so the shared list carries no creation control.
    await expect(sharedByMe.getByRole('button', { name: /^Add/ })).toHaveCount(
      0,
    );

    await window.screenshot({
      path: testInfo.outputPath('collections-tab-sections.png'),
      fullPage: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Skills tab separates installed skills from shared ones', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_nested_tabs_skills');
    await app.openPluginsPage();
    await app.openPluginsTab('skills');

    const sharedRowId = 'customize-row-skill:shared:marketplace-review-skill';
    const installed = window.getByTestId('customize-section-installed');
    const sharedByMe = window.getByTestId('customize-section-shared-by-me');
    await expect(
      installed.getByRole('heading', { name: /^Installed/ }),
    ).toBeVisible();
    await expect(sharedByMe).toBeVisible({ timeout: 20_000 });
    await expect(sharedByMe.getByTestId(sharedRowId)).toBeVisible();
    await expect(installed.getByTestId(sharedRowId)).toHaveCount(0);

    // Create skill and Add skills live in the page-level Add custom menu,
    // outside every section, so the shared list carries neither control.
    await expect(
      sharedByMe.getByRole('button', { name: /Create (custom )?skill/i }),
    ).toHaveCount(0);
    await expect(
      sharedByMe.getByRole('button', { name: /(Add|Install) skills/i }),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('skills-tab-sections.png'),
      fullPage: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
