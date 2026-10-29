import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Bundled skills are read-only, but sharing publishes the current SKILL.md as
// a snapshot copy under the sharer's account.
//
// Testids exercised:
//   - `skill-share-builtin:*`         -> bundled row Share action
//   - `cloud-sync-modal`              -> disconnected sign-in gate
//   - `share-skill-modal`             -> Share Skill dialog
//   - `share-skill-scope-description` -> single usable audience disclosure
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

    const shareButton = window
      .locator('[data-testid^="skill-share-builtin"]')
      .first();
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

    await shareButton.click();
    const shareModal = window.getByTestId('share-skill-modal');
    await expect(shareModal).toBeVisible();
    // This account has no organization, so Public is the only usable
    // audience. A single usable audience is not a choice: the pills hide and
    // only that audience's disclosure remains.
    await expect(
      shareModal.getByTestId('share-skill-scope-description'),
    ).toBeVisible();
    await expect(shareModal.getByTestId('share-skill-scope')).toHaveCount(0);
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
