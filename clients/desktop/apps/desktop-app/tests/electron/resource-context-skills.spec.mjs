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
  createdBy: { id: 'user', name: 'User' },
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
    await window.getByTestId('skills-view-tab-shared').click();
    const row = window.getByTestId(`shared-skill-row-${skill.id}`);
    await expect(row).toBeVisible();
    await row.locator('button').first().click();
    await expect(
      window.getByRole('dialog').getByRole('heading', { name: skill.name }),
    ).toBeVisible();
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
      await window.getByTestId('plugins-management-back').click();
      await selectWorkspaceContext(window, context);
      await app.openPluginsPage();
      await app.openPluginsTab('skills');
      await window.getByTestId('skills-view-tab-shared').click();
      await expect(
        window.getByTestId('shared-skills-empty-state'),
      ).toBeVisible();
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

// A complete Add used to leave the Marketplace page as it was: the same Add
// button and no message, so an installed skill looked like a click that did
// nothing, and reopening the page offered Add again.
test('Marketplace Add on an organization skill shows the installed skill', async () => {
  test.setTimeout(150_000);
  const key = 'csk_shared_skill_add_outcome';
  const rawSkill =
    '---\nname: org-release-notes\ndescription: Drafts release notes for the organization\n---\n\n# Release notes\n';
  const orgSkill = {
    ...skill,
    id: 'aaaaaaaa-2962-4000-8000-000000000003',
    name: 'org-release-notes',
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
    // Signed in without the skill, the shared detail primary is Install.
    const add = window.getByTestId('detail-primary-cta');
    const status = window.getByTestId('shared-skill-detail-installed-status');
    const open = window.getByTestId('shared-skill-detail-open');

    await window.getByTestId('plugins-search').fill(orgSkill.name);
    await sharedEntry.click();
    await expect(window.getByTestId('plugins-entry-detail')).toBeVisible();
    await expect(add).toHaveAttribute('data-state', 'install');
    await expect(add).toHaveText('Install');
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

    // Back on the shared page, Install is spent: the outcome replaces it and
    // the primary is Try it. The installed skill's breadcrumb leads back to
    // the Marketplace.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await window.getByTestId('plugins-search').fill(orgSkill.name);
    await sharedEntry.click();
    await expect(status).toHaveText(`Added as “${orgSkill.name}”`);
    await expect(add).toHaveAttribute('data-state', 'try');
    await expect(add).toHaveText('Try it');

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
    await sharedEntry.click();
    await expect(status).toHaveText(`Added as “${orgSkill.name}”`);
    await expect(add).toHaveAttribute('data-state', 'try');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
