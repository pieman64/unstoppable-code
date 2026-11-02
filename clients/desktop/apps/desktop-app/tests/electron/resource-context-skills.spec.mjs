import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

const skill = {
  id: 'aaaaaaaa-2962-4000-8000-000000000002',
  name: 'Organization A release',
  description: 'Organization-only release',
  contentHash: 'a'.repeat(64),
  publicShare: null,
  createdBy: { id: 'user-lena', name: 'Lena Park' },
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  rawSkill:
    '---\nname: Organization A release\ndescription: Organization-only release\n---\nSkill body\n',
};

/** CAN-5016: the shared skill header names its author, owner and audience. */
async function expectSkillProvenance(window, audience = 'Organization') {
  await expect(
    window.getByTestId('shared-skill-detail-audience-author'),
  ).toHaveText('By Lena Park');
  await expect(
    window.getByTestId('shared-skill-detail-audience-organization'),
  ).toHaveText('Acme');
  await expect(window.getByTestId('shared-skill-detail-audience')).toHaveText(
    audience,
  );
  await expect(
    window.getByTestId('shared-skill-detail-audience-author'),
  ).toHaveCount(1);
}

async function setContextFromAnotherSurface(window, context) {
  await window.evaluate(async (next) => {
    const current = await window.api.workspaceContext.get();
    await window.api.workspaceContext.set({
      context: next,
      expectedRevision: current.revision,
    });
  }, context);
}

test('shared skill follows only its owning organization context', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can2962_skills';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedSkills: [skill],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2962-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    // CAN-4267: another organization's shared skill is a Browse row of the
    // Skills tab; the Shared tab and its list were deleted.
    const row = window.getByTestId(`plugins-entry-skill:shared:${skill.id}`);
    await expect(row).toBeVisible();
    await row.click();
    const detail = window.getByTestId('plugins-entry-detail-page');
    await expect(detail).toBeVisible();
    await expect(
      detail.getByRole('heading', { name: skill.name }),
    ).toBeVisible();
    await expectSkillProvenance(window);
    await setContextFromAnotherSurface(window, { kind: 'personal' });
    await expect(window.getByRole('heading', { name: skill.name })).toHaveCount(
      0,
    );
    await setContextFromAnotherSurface(window, {
      kind: 'organization',
      organizationId: ORG_CONTEXT_A,
    });
    await expect(row).toBeVisible();
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await selectWorkspaceContext(window, context);
      await app.openPluginsPage();
      await app.openPluginsTab('skills');
      // Customize omits an empty Browse section, so there is no shared-skills
      // empty state; the row's absence and the denied read carry this check.
      await expect(row).toHaveCount(0);
      const denied = await window.evaluate(async () => {
        try {
          await window.skills.getShared('aaaaaaaa-2962-4000-8000-000000000002');
          return false;
        } catch {
          return true;
        }
      });
      expect(denied).toBe(true);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

test('long shared skill provenance wraps without hiding Install or the menu', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can5016_long_provenance';
  const longSkill = {
    ...skill,
    canUpdate: true,
    createdBy: { id: 'user-lena', name: 'Lena'.repeat(90) },
    owner: { ...skill.owner, name: 'Acme'.repeat(90) },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedSkills: [longSkill],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can5016-long-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 960, height: 800 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await window.getByTestId(`plugins-entry-skill:shared:${skill.id}`).click();
    const header = window.getByTestId('plugins-entry-detail-header');
    await expect(header).toBeVisible();
    await expect(
      header.getByTestId('shared-skill-detail-audience-author'),
    ).toHaveText(`By ${longSkill.createdBy.name}`);
    await expect(
      header.getByTestId('shared-skill-detail-audience-organization'),
    ).toHaveText(longSkill.owner.name);
    for (const id of [
      'shared-skill-detail-audience-author',
      'shared-skill-detail-audience-organization',
    ]) {
      const fits = await header.getByTestId(id).evaluate((fact) => {
        const bounds = fact.getBoundingClientRect();
        const headerBounds = fact.closest('header').getBoundingClientRect();
        return (
          bounds.left >= headerBounds.left - 1 &&
          bounds.right <= headerBounds.right + 1
        );
      });
      expect(fits, `${id} must stay within the header`).toBe(true);
    }
    await expect(window.getByTestId('detail-primary-cta')).toBeVisible();
    await expect(window.getByTestId('detail-primary-cta')).toHaveText(
      'Install',
    );
    await window.getByTestId('plugins-entry-detail-more').click();
    await expect(window.getByTestId('plugins-entry-detail-menu')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

// A complete Add used to leave the Marketplace page as it was: the same Add
// button and no message, so an installed skill looked like a click that did
// nothing, and reopening the page offered Add again.
for (const shareScope of ['organization', 'team']) {
  test(`CAN-5018: Marketplace Add on a ${shareScope} skill shows installed provenance`, async () => {
    test.setTimeout(150_000);
    const key = `csk_shared_skill_add_outcome_${shareScope}`;
    const rawSkill =
      '---\nname: org-release-notes\ndescription: Drafts release notes for the organization\n---\n\n# Release notes\n';
    const orgSkill = {
      ...skill,
      id: 'aaaaaaaa-2962-4000-8000-000000000003',
      name: 'org-release-notes',
      shareScope,
      createdBy: { id: 'lena', name: 'Lena Park', email: null },
      owner:
        shareScope === 'team'
          ? {
              type: 'team',
              id: '7c1e5b0d-3f4a-4a8e-9c2d-1e6f7a8b9c0d',
              name: 'Platform',
              organization: { id: ORG_CONTEXT_A, name: 'Acme' },
            }
          : skill.owner,
      description: 'Drafts release notes for the organization',
      // The real server hash, so the page can recognize the installed copy.
      contentHash: createHash('sha256').update(rawSkill).digest('hex'),
      rawSkill,
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        sharedSkills: [orgSkill],
      },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-shared-skill-add-'),
    );
    seedOrgContextScoping(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, key);
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await app.openPluginsPage();

      const sharedEntry = window.getByTestId(
        `plugins-entry-skill:shared:${orgSkill.id}`,
      );
      const sharedInstall = window.getByTestId(
        `plugins-entry-add-skill:shared:${orgSkill.id}`,
      );
      const installedRow = window.getByTestId(
        `customize-row-skill:custom:app:${orgSkill.name}`,
      );
      // Signed in without the skill, the shared detail primary is Install.
      const add = window.getByTestId('detail-primary-cta');
      const status = window.getByTestId('shared-skill-detail-installed-status');
      const open = window.getByTestId('shared-skill-detail-open');

      await window.getByTestId('plugins-search').fill(orgSkill.name);
      // CAN-5223: a shared card installs a copy, so its action says Install.
      await expect(sharedInstall).toHaveText('Install');
      await expect(sharedInstall).toHaveAccessibleName(
        'Install Org Release Notes',
      );
      const shareAction = window.getByTestId(
        `plugins-entry-share-skill:shared:${orgSkill.id}`,
      );
      await expect(shareAction).toHaveAccessibleName('Share Org Release Notes');
      await window.keyboard.press('Tab');
      await shareAction.focus();
      await expect(shareAction).toBeFocused();
      // The recipient can install but cannot re-share another author's skill.
      // The same focusable Share action explains that restriction.
      await expect(shareAction).toHaveAttribute('aria-disabled', 'true');
      await expect(window.getByRole('tooltip')).toHaveText(
        'Only the owner can share this skill.',
      );
      await window.keyboard.press('Escape');
      await sharedEntry.click();
      await expect(window.getByTestId('plugins-entry-detail')).toBeVisible();
      await expect(add).toHaveAttribute('data-state', 'install');
      await expect(add).toHaveText('Install');
      await expectSkillProvenance(
        window,
        shareScope === 'team' ? 'Team: Platform' : 'Organization',
      );
      await expect(
        window.getByTestId('plugins-entry-detail-header-meta'),
      ).not.toContainText('Public link');
      await add.click();

      // CAN-3710: the page's Install opens the shared install review. Its one
      // Install writes, then the review closes and lands on the installed
      // skill, which a local skill can edit.
      const review = window.getByTestId('deep-link-share-landing');
      await expect(review).toBeVisible();
      await review.getByTestId('deep-link-share-install').click();
      await expect(review).toHaveCount(0, { timeout: 60_000 });
      // An earlier notice may still be showing.
      await expect(window.getByText('Skill installed.').last()).toBeVisible();
      await expect(window.getByTestId('skill-read-detail-edit')).toBeVisible();
      await expect(window.getByRole('alert')).toHaveCount(0);
      const installed = await window.evaluate(async (name) => {
        const result = await window.skills.loadSkills();
        return (result.data ?? []).some(
          (installedSkill) =>
            installedSkill.sourceId === 'custom:app' &&
            installedSkill.name === name,
        );
      }, orgSkill.name);
      expect(installed).toBe(true);

      const meta = window.getByTestId('skill-read-detail-header-meta');
      await expect(meta).toContainText('From Acme');
      await expect(meta).toContainText('Shared by Lena Park');
      await expect(meta).toContainText('One-time copy');
      await expect(meta).not.toContainText('Custom');
      await expect(
        window.getByTestId('installed-share-update-available'),
      ).toHaveCount(0);
      if (shareScope === 'team')
        await expect(meta).toContainText('Team: Platform');
      await expect(
        window.getByTestId('installed-share-sharer').locator('.ph-no-capture'),
      ).toHaveText('Lena Park');
      // Follow the installed page's source, then the visible Open by keyboard.
      await window.getByTestId('installed-share-source-link').click();
      await expect(status).toHaveText(
        `Installed on this device as “${orgSkill.name}”`,
      );
      const visibleOpen = window.getByTestId(
        'shared-skill-detail-open-installed',
      );
      await visibleOpen.focus();
      await window.keyboard.press('Enter');
      await expect(meta).toContainText('One-time copy');

      // CAN-5223: Customize folds the share into its installed copy: one
      // Installed row named for the share, and no Browse card to install it
      // again. The installed skill's breadcrumb leads back to Customize.
      const expectFolded = async () => {
        await window.getByTestId('plugins-search').fill(orgSkill.name);
        await expect(installedRow).toHaveCount(1);
        await expect(
          window.getByTestId(
            `customize-row-subtitle-skill:custom:app:${orgSkill.name}`,
          ),
        ).toHaveText('Shared by Lena Park · Acme');
        await expect(
          window.locator(
            `[data-testid="customize-row-subtitle-skill:custom:app:${orgSkill.name}"].ph-no-capture`,
          ),
        ).toHaveCount(1);
        await expect(sharedEntry).toHaveCount(0);
        await expect(sharedInstall).toHaveCount(0);
      };
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expectFolded();
      // Re-entering Customize keeps the fold.
      await app.openMainPage();
      await app.openPluginsPage();
      await expectFolded();

      // Back on the shared page through the installed copy, Install is
      // spent: the outcome replaces it and the primary is Try it.
      await installedRow.click();
      await window.getByTestId('installed-share-source-link').click();
      await expect(status).toHaveText(
        `Installed on this device as “${orgSkill.name}”`,
      );
      await expect(add).toHaveAttribute('data-state', 'try');
      await expect(add).toHaveText('Try it');
      await expectSkillProvenance(
        window,
        shareScope === 'team' ? 'Team: Platform' : 'Organization',
      );

      // Open installed skill, in the header ⋯ (CAN-4261), shows the copy.
      await window.getByTestId('plugins-entry-detail-more').click();
      await open.click();
      await expect(window.getByTestId('skill-read-detail-edit')).toBeVisible();
      await expect(status).toHaveCount(0);

      // Back on the shared page, it still knows the skill is installed.
      // CAN-4261: the installed page has no Back to pop to the shared page;
      // its breadcrumb leads to the list, which keeps the search.
      await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
        0,
      );
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await installedRow.click();
      await window.getByTestId('installed-share-source-link').click();
      await expect(status).toHaveText(
        `Installed on this device as “${orgSkill.name}”`,
      );
      await expect(add).toHaveAttribute('data-state', 'try');

      // The authenticated source changes; installed bytes do not. Reopening
      // reads a new snapshot instead of polling or comparing local edits.
      const changedRaw = `${rawSkill}Updated upstream.\n`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        cloud: {
          organizations: ORG_CONTEXT_ORGANIZATIONS,
          sharedSkills: [
            {
              ...orgSkill,
              rawSkill: changedRaw,
              contentHash: createHash('sha256')
                .update(changedRaw)
                .digest('hex'),
            },
          ],
        },
      });
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await installedRow.click();
      await expect(meta).toContainText('One-time copy');
      await expect(
        window.getByTestId('installed-share-update-available'),
      ).toBeVisible();
      expect(
        await window.evaluate(
          (name) => window.skills.readRawSkill(`custom:app/${name}`),
          orgSkill.name,
        ),
      ).toBe(rawSkill);

      // Fail only the optional detail read. Inventory/read authorization stays
      // real; metadata never grants access or bypasses the main policy.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('skills:shared-get');
        ipcMain.handle('skills:shared-get', () => {
          throw new Error('Source unavailable (403)');
        });
      });
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await installedRow.click();
      await expect(meta).toContainText('From Acme');
      await expect(meta).toContainText('Shared by Lena Park');
      await expect(meta).toContainText('One-time copy');
      await expect(
        window.getByTestId('installed-share-update-available'),
      ).toHaveCount(0);
      await window.getByTestId('installed-share-source-link').click();
      await expect(
        window.getByText('You do not have permission to perform this action.', {
          exact: true,
        }),
      ).toBeVisible();

      // CAN-5223: the failed read stays on Customize, where deleting the
      // last copy offers Install again.
      await window.getByTestId('plugins-search').fill(orgSkill.name);
      const menu = `customize-row-menu-skill:custom:app:${orgSkill.name}`;
      await window
        .getByTestId('customize-section-installed')
        .getByTestId(menu)
        .click();
      await window.getByTestId(`${menu}-remove`).click();
      await window.getByTestId('customize-row-remove-confirm').click();
      await expect(installedRow).toHaveCount(0);
      await expect(sharedInstall).toHaveText('Install');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    }
  });
}
