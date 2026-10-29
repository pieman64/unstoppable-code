// CAN-3710 — one install review for every shared resource, then land on the
// result.
//
// A skill link from the web opens the shared install review and nothing is
// written until its one Install. The close button, Escape and the backdrop
// dismiss it without writing. Install closes the review and lands on the
// installed skill with a short notice. The same link for an installed skill
// opens the review with `Open skill`, and Uninstall in its ⋯ menu asks in a
// confirmation first.
//
// Deterministic: a local fixture serves the pinned public skill share and its
// package; no network, no live agents.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  publisherSkills,
  startPublisherSkillsFixture,
} from './publisherSkillsFixture.mjs';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

function readPendingShareInstall(window) {
  return window.evaluate(
    () => window.__canopyNavigationTestApi?.getPendingShareInstall() ?? null,
  );
}

test('CAN-3710: a skill link installs only on its one click, then lands on the skill', async () => {
  test.setTimeout(180_000);
  const skill = publisherSkills[0];
  const fixture = await startPublisherSkillsFixture();
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
  });
  const skillDir = path.join(userDataDir, 'skills', 'custom:app', skill.name);
  const link = `canopy://share/skills/${skill.externalId}`;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const review = window.getByTestId('deep-link-share-landing');

    const openReview = async () => {
      await emitOpenUrl(electronApp, link);
      await expect(review).toBeVisible();
      await expect(review.getByTestId('share-install-type-label')).toHaveText(
        'Skill',
      );
    };
    const expectDismissedWithoutWriting = async () => {
      await expect(review).toHaveCount(0);
      expect(await readPendingShareInstall(window)).toBeNull();
      expect(existsSync(skillDir)).toBe(false);
    };

    // The review names the item and offers one primary, with no Cancel.
    await openReview();
    await expect(review.locator('#deep-link-share-landing-title')).toHaveText(
      skill.name,
    );
    await expect(review.getByTestId('share-install-description')).toHaveText(
      `${skill.publisher} guidance for a reviewed publisher skill.`,
    );
    await expect(review.getByTestId('deep-link-share-install')).toHaveText(
      'Install',
    );
    await expect(review.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    // Arriving from a link wrote nothing.
    await window.waitForTimeout(500);
    expect(existsSync(skillDir)).toBe(false);

    // Every way of closing it writes nothing.
    await window.keyboard.press('Escape');
    await expectDismissedWithoutWriting();
    await openReview();
    await review.getByRole('button', { name: 'Close' }).click();
    await expectDismissedWithoutWriting();
    await openReview();
    await window.mouse.click(4, 4);
    await expectDismissedWithoutWriting();

    // One click installs, closes the review, and lands on the skill.
    await openReview();
    await review.getByTestId('deep-link-share-install').click();
    await expect(review).toHaveCount(0);
    await expect(window.getByText('Skill installed.')).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-root'),
    ).toBeVisible();
    for (const file of skill.files) {
      expect(readFileSync(path.join(skillDir, file.path), 'utf8')).toBe(
        file.body,
      );
    }

    // The same link for an installed skill offers to open it.
    await openReview();
    await expect(
      review.getByTestId('deep-link-share-installed-status'),
    ).toContainText(`Installed as “${skill.name}”`);
    await expect(review.getByTestId('deep-link-share-install')).toHaveCount(0);
    const open = review.getByTestId('deep-link-share-open');
    await expect(open).toHaveText('Open skill');
    await open.click();
    await expect(review).toHaveCount(0);
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-root'),
    ).toBeVisible();
    expect(existsSync(`${skillDir}-2`)).toBe(false);

    // Uninstall asks first, in a confirmation named for the outcome.
    await openReview();
    await review.getByTestId('deep-link-share-kebab').click();
    await window.getByTestId('deep-link-share-uninstall').click();
    const confirm = window.getByTestId('deep-link-share-uninstall-dialog');
    await expect(confirm).toContainText('Uninstall this skill?');
    expect(existsSync(skillDir)).toBe(true);
    await confirm.getByTestId('deep-link-share-uninstall-confirm').click();
    await expect.poll(() => existsSync(skillDir)).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
