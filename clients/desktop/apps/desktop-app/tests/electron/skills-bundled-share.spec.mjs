import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Bundled skills are read-only, but sharing publishes the current SKILL.md as
// a snapshot copy under the sharer's account.
//
// Testids exercised:
//   - `customize-row-skill:builtin:*` -> bundled Customize Installed row
//   - `customize-row-menu-<id>-share` -> its ⋯ menu Share action (CAN-4267)
//   - `cloud-sync-modal`              -> disconnected sign-in gate
//   - `share-skill-modal`             -> Share Skill dialog
//   - `share-skill-scope-description` -> the selected audience's disclosure
//   - `share-skill-snapshot-note`     -> bundled snapshot explanation
test('bundled skill offers snapshot sharing', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    const bundledRow = window
      .getByTestId('customize-section-installed')
      .locator('[data-testid^="customize-row-skill:builtin:"]')
      .first();
    await expect(bundledRow).toBeVisible();
    const menuTestId = (await bundledRow.getAttribute('data-testid')).replace(
      /^customize-row-/,
      'customize-row-menu-',
    );
    const shareButton = window.getByTestId(`${menuTestId}-share`);
    await window.getByTestId(menuTestId).click();
    await expect(shareButton).toBeVisible();
    await shareButton.click();

    const cloudSyncModal = window.getByTestId('cloud-sync-modal');
    await expect(cloudSyncModal).toBeVisible();
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    await cloudSyncModal.getByRole('button', { name: 'Close' }).click();
    await expect(cloudSyncModal).toHaveCount(0);

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_skills_bundled_share_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Skill sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await window.getByTestId(menuTestId).click();
    await shareButton.click();
    const shareModal = window.getByTestId('share-skill-modal');
    await expect(shareModal).toBeVisible();
    // This account has no organization, so Public is the only usable
    // audience. The pills stay, Team and Organization disabled, with Public
    // preselected and its disclosure underneath.
    await expect(
      shareModal.getByTestId('share-skill-scope-description'),
    ).toBeVisible();
    await expect(
      shareModal.getByTestId('share-skill-scope-team'),
    ).toBeDisabled();
    await expect(
      shareModal.getByTestId('share-skill-scope-public'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(window.getByTestId('share-skill-snapshot-note')).toBeVisible();
    await window
      .getByTestId('share-skill-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
