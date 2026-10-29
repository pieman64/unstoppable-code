import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { CANOPY_ORG_PROJECTS_ENABLED_ENV } from './featureFlagEnv.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  publisherSkills,
  startPublisherSkillsFixture,
} from './publisherSkillsFixture.mjs';
import { writeJson } from './seeders/index.mjs';

// CAN-3710: every Marketplace install goes through the shared install review.
// Its one Install writes, then the review closes and lands on the installed
// skill with a short notice.
async function showMarketplaceSkill(window, app, skill) {
  // A finished install lands on the installed skill's page; its breadcrumb
  // leads back to the Marketplace.
  const root = window.getByTestId('plugins-entry-detail-breadcrumb-root');
  if (await root.isVisible()) await root.click();
  await app.openPluginsPage();
  await window.getByTestId('plugins-type-tab-skill').click();
  await window.getByTestId('plugins-search').fill(skill.name);
  const entry = window.getByTestId(
    `plugins-entry-public-share:skill:${skill.externalId}`,
  );
  await expect(entry).toBeVisible();
  return entry;
}

async function installThroughReview(window, skillDir) {
  const review = window.getByTestId('deep-link-share-landing');
  await expect(review).toBeVisible();
  // Opening the review writes nothing; its Install is the one click.
  expect(existsSync(skillDir)).toBe(false);
  await expect(review.getByTestId('share-install-type-label')).toHaveText(
    'Skill',
  );
  await review.getByTestId('deep-link-share-install').click();
  await expect(review).toHaveCount(0);
  // An earlier install's notice may still be showing.
  await expect(window.getByText('Skill installed.').last()).toBeVisible();
}

test('desktop Marketplace Skills discovers and explicitly installs both publishers', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    for (const skill of publisherSkills) {
      const entry = await showMarketplaceSkill(window, app, skill);
      await expect(entry).toContainText(skill.publisher);
      const skillDir = path.join(
        userDataDir,
        'skills',
        'custom:app',
        skill.name,
      );
      expect(existsSync(skillDir)).toBe(false);
      await entry.click();
      const detail = window.getByTestId('plugins-entry-detail');
      // One title, owned by the content, showing the same display name as
      // the row rather than the raw skill identifier.
      await expect(detail.locator('#plugin-detail-title')).toHaveCount(1);
      await expect(detail).toHaveAttribute(
        'aria-labelledby',
        'plugin-detail-title',
      );
      await expect(detail.locator('#plugin-detail-title')).toHaveText(
        skill.displayName,
      );
      await expect(
        window.getByTestId('publisher-skill-provenance'),
      ).toContainText('MIT');
      await expect(
        window.getByRole('link', { name: 'View source' }),
      ).toHaveAttribute('href', skill.snapshot.publisher.sourceUrl);
      await expect(
        window.getByTestId('deep-link-share-package-summary'),
      ).toBeVisible();
      expect(existsSync(skillDir)).toBe(false);
      // The page's Install opens the review rather than writing.
      await detail.getByTestId('deep-link-share-install').click();
      await installThroughReview(window, skillDir);
      for (const file of skill.files)
        expect(readFileSync(path.join(skillDir, file.path), 'utf8')).toBe(
          file.body,
        );
      // Back on the Marketplace, the page knows the skill is installed.
      const again = await showMarketplaceSkill(window, app, skill);
      await again.click();
      await expect(
        window
          .getByTestId('plugins-entry-detail')
          .getByTestId('deep-link-share-installed-status'),
      ).toContainText(`Installed as “${skill.name}”`);
      expect(existsSync(`${skillDir}-2`)).toBe(false);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

// Organization projects put skills under context enforcement. A Marketplace
// skill is a public share with no owning team or organization to receipt, so
// main re-reads the share to verify its origin before writing; the install
// must not be refused for lacking a shared source. The row's Add opens the
// install review straight from the card, and its Install is the only step
// that writes.
test('desktop Marketplace Skills installs a publisher skill with context enforcement on', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl,
      ...CANOPY_ORG_PROJECTS_ENABLED_ENV,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    const skill = publisherSkills[0];
    await app.waitForShell();
    await showMarketplaceSkill(window, app, skill);
    const skillDir = path.join(userDataDir, 'skills', 'custom:app', skill.name);
    expect(existsSync(skillDir)).toBe(false);
    const snapshotReads = () =>
      fixture.state.requests.filter((pathname) =>
        pathname.endsWith(`/public-shares/skills/${skill.externalId}`),
      ).length;
    await window
      .getByTestId(`plugins-entry-add-public-share:skill:${skill.externalId}`)
      .click();
    // The detail page is not visited first.
    await expect(window.getByTestId('plugins-entry-detail')).toHaveCount(0);
    const review = window.getByTestId('deep-link-share-landing');
    await expect(review).toBeVisible();
    await expect(review.getByTestId('deep-link-share-install')).toBeEnabled();
    const readsBeforeInstall = snapshotReads();
    await installThroughReview(window, skillDir);
    for (const file of skill.files)
      expect(readFileSync(path.join(skillDir, file.path), 'utf8')).toBe(
        file.body,
      );
    // Main verified the share itself rather than trusting the reviewed bytes.
    expect(snapshotReads()).toBeGreaterThan(readsBeforeInstall);
    expect(existsSync(`${skillDir}-2`)).toBe(false);

    // The Marketplace page for the installed skill keeps its actions on the
    // title's row: the page scrolls as a whole and a publisher README can run
    // to many screens.
    const entry = await showMarketplaceSkill(window, app, skill);
    await entry.click();
    const detail = window.getByTestId('plugins-entry-detail');
    await expect(detail.locator('#plugin-detail-title')).toHaveText(
      skill.displayName,
    );
    const installedStatus = detail.getByTestId(
      'deep-link-share-installed-status',
    );
    await expect(installedStatus).toContainText(`Installed as “${skill.name}”`);
    await expect(installedStatus).toBeInViewport({ ratio: 1 });
    // Under the title the menu drops below its control; rising, as it does
    // from the modal's footer, would cover the page chrome above it.
    const kebab = detail.getByTestId('deep-link-share-kebab');
    await kebab.click();
    const menu = window.getByTestId('deep-link-share-menu');
    await expect(menu).toBeInViewport({ ratio: 1 });
    const [kebabBox, menuBox] = await Promise.all([
      kebab.boundingBox(),
      menu.boundingBox(),
    ]);
    expect(menuBox.y).toBeGreaterThanOrEqual(kebabBox.y + kebabBox.height);
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // In a narrow window the actions wrap under the title rather than
    // running off the page's edge.
    await window.setViewportSize({ width: 820, height: 900 });
    await expect(installedStatus).toBeInViewport({ ratio: 1 });
    await expect(kebab).toBeInViewport({ ratio: 1 });
    expect(
      await detail.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    // The menu's items work from under the title: uninstalling there, after
    // its confirmation, brings Install back to the same row.
    await kebab.click();
    await window.getByTestId('deep-link-share-uninstall').click();
    await window.getByTestId('deep-link-share-uninstall-confirm').click();
    const install = detail.getByTestId('deep-link-share-install');
    await expect(install).toBeInViewport({ ratio: 1 });
    await expect(installedStatus).toHaveCount(0);
    await expect.poll(() => existsSync(skillDir)).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

// The narrowest supported layout: an 800px window with the sidebar dragged to
// its widest leaves the detail a couple of hundred pixels. The installed
// status, Try now, and the menu wrap inside it rather than running off the
// page's edge.
test('desktop Marketplace Skills keeps the skill actions on the page beside the widest sidebar', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-actions-narrow-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { sidebarWidth: 480 },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
    viewportSize: { width: 800, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    const skill = publisherSkills[0];
    await app.waitForShell();
    await showMarketplaceSkill(window, app, skill);
    await window
      .getByTestId(`plugins-entry-add-public-share:skill:${skill.externalId}`)
      .click();
    await installThroughReview(
      window,
      path.join(userDataDir, 'skills', 'custom:app', skill.name),
    );
    const entry = await showMarketplaceSkill(window, app, skill);
    await entry.click();
    const detail = window.getByTestId('plugins-entry-detail');
    const installedStatus = detail.getByTestId(
      'deep-link-share-installed-status',
    );
    await expect(installedStatus).toContainText(`Installed as “${skill.name}”`);
    const detailBox = await detail.boundingBox();
    // The layout under test: the detail is far narrower than the one-line row.
    expect(detailBox.width).toBeLessThan(320);
    for (const control of [
      installedStatus,
      detail.getByTestId('deep-link-share-try'),
      detail.getByTestId('deep-link-share-kebab'),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(detailBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        detailBox.x + detailBox.width,
      );
    }
    // Try now stays one line, no taller than the control beside it; only the
    // status text gives way.
    const [tryNowBox, kebabBox] = await Promise.all([
      detail.getByTestId('deep-link-share-try').boundingBox(),
      detail.getByTestId('deep-link-share-kebab').boundingBox(),
    ]);
    expect(tryNowBox.height).toBeLessThanOrEqual(kebabBox.height);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

// The recipient half of packaged skill sharing. A public skill link used to
// deliver SKILL.md alone; it now brings the skill's supporting files and
// scripts, and like every share link it waits for an explicit Install.
//
// The share, its package manifest, and its blobs come from the E2E mock
// cloud (`SKILL_PACKAGE_*` in `mock-server/routes/cloud.mjs`), built so the
// digest is the real canonical one. The desktop verifies every file against
// it before writing, so a passing run proves the bytes on disk are the
// published ones.
//
// Testids exercised:
//   - `deep-link-share-landing`                    -> install review
//   - `deep-link-share-install`                    -> explicit Install
//   - `deep-link-share-installed-status`           -> installed confirmation

const SHARE_ID = '7c4e2a91-3b5d-4f6e-8a1c-9d0b2e4f6a83';
const SKILL_NAME = 'release-notes';

test('publisher catalog failure can be retried without hiding installed skills', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  fixture.state.listFailure = true;
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-skill').click();
    await expect(
      window.getByTestId('customize-section-installed'),
    ).toBeVisible();
    const error = window.getByTestId('publisher-skills-error');
    await expect(error).toBeVisible({ timeout: 45_000 });
    fixture.state.listFailure = false;
    await error.getByRole('button', { name: 'Try again' }).click();
    await expect(error).toHaveCount(0);
    await window.getByTestId('plugins-search').fill(publisherSkills[0].name);
    await expect(
      window.getByTestId(
        `plugins-entry-public-share:skill:${publisherSkills[0].externalId}`,
      ),
    ).toBeVisible();
    expect(
      fixture.state.requests.some((url) =>
        url.includes('/public-shares/skills/'),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

test('a failed publisher package remains retryable after reopening its native preview', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  fixture.state.packageFailure = true;
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    const skill = publisherSkills[0];
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-skill').click();
    await window.getByTestId('plugins-search').fill(skill.name);
    const entry = window.getByTestId(
      `plugins-entry-public-share:skill:${skill.externalId}`,
    );
    await entry.click();
    await window
      .getByTestId('plugins-entry-detail')
      .getByTestId('deep-link-share-install')
      .click();
    const review = window.getByTestId('deep-link-share-landing');
    await review.getByTestId('deep-link-share-install').click();
    const installFailure = review.getByText(
      /supporting files could not be installed/,
    );
    await expect(installFailure).toBeVisible({ timeout: 45_000 });
    // A failure keeps the review open on its error.
    await expect(
      review.getByTestId('deep-link-share-installed-status'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    await window
      .getByTestId('plugins-entry-detail')
      .getByTestId('deep-link-share-install')
      .click();
    await expect(review.getByTestId('deep-link-share-install')).toBeEnabled();
    await expect(
      review.getByTestId('deep-link-share-installed-status'),
    ).toHaveCount(0);
    fixture.state.packageFailure = false;
    await review.getByTestId('deep-link-share-install').click();
    await expect(review).toHaveCount(0);
    await expect(window.getByText('Skill installed.')).toBeVisible();
    for (const file of skill.files)
      expect(
        readFileSync(
          path.join(userDataDir, 'skills', 'custom:app', skill.name, file.path),
          'utf8',
        ),
      ).toBe(file.body);
    expect(
      existsSync(
        path.join(userDataDir, 'skills', 'custom:app', `${skill.name}-2`),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

test('a packaged skill link reviews, then installs its files', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // The default link intent is install. Nothing installs on arrival: the
    // review waits for its one click (CAN-3710).
    await emitOpenUrl(electronApp, `canopy://share/skills/${SHARE_ID}`);
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toBeVisible({ timeout: 30_000 });
    // The review stays light: no package list or readiness checks in it.
    await expect(
      landing.getByTestId('deep-link-share-package-summary'),
    ).toHaveCount(0);
    await expect(
      landing.getByTestId('deep-link-share-skill-readiness'),
    ).toHaveCount(0);

    const install = landing.getByTestId('deep-link-share-install');
    await expect(install).toBeEnabled();
    await expect(
      landing.getByTestId('deep-link-share-installed-status'),
    ).toHaveCount(0);
    expect(() =>
      statSync(path.join(userDataDir, 'skills', 'custom:app', SKILL_NAME)),
    ).toThrow();
    await install.click();

    // The review closes and lands on the installed skill.
    await expect(landing).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByText('Skill installed.')).toBeVisible();

    // Everything the publisher shared is on disk, byte for byte, and the
    // script kept its execute bit.
    const skillDir = path.join(userDataDir, 'skills', 'custom:app', SKILL_NAME);
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain(
      'run scripts/collect.sh',
    );
    expect(
      readFileSync(path.join(skillDir, 'references', 'style.md'), 'utf8'),
    ).toBe('# Style\n\nLead with the user-visible change.\n');
    const script = path.join(skillDir, 'scripts', 'collect.sh');
    expect(readFileSync(script, 'utf8')).toBe(
      '#!/bin/sh\ngit log --merges --oneline "$1"..HEAD\n',
    );
    expect(statSync(script).mode & 0o100).toBe(0o100);

    // A second arrival recognizes the installed copy instead of installing a
    // duplicate beside it.
    await emitOpenUrl(electronApp, `canopy://share/skills/${SHARE_ID}`);
    await expect(
      window
        .getByTestId('deep-link-share-landing')
        .getByTestId('deep-link-share-installed-status'),
    ).toBeVisible({ timeout: 30_000 });
    expect(() =>
      statSync(
        path.join(userDataDir, 'skills', 'custom:app', `${SKILL_NAME}-2`),
      ),
    ).toThrow();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
