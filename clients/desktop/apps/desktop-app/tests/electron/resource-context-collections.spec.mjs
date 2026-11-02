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
  id: 'aaaaaaaa-2962-4000-8000-000000000016',
  name: 'Organization A review',
  description: 'An organization review skill',
  contentHash: 'a'.repeat(64),
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  rawSkill:
    '---\nname: Organization A review\ndescription: An organization review skill\n---\nReview this change.\n',
};
const collection = {
  id: 'aaaaaaaa-2962-4000-8000-000000000006',
  name: 'Organization A skills',
  description: 'Organization A collection of skills',
  contentHash: 'org-a-collection',
  itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  createdBy: { id: 'user', name: 'Owner', email: 'owner@example.test' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  collection: {
    version: 1,
    name: 'Organization A skills',
    description: '',
    items: [
      {
        type: 'custom_skill',
        skillId: skill.id,
        skill_name: skill.name,
        contentHash: skill.contentHash,
      },
    ],
  },
  rawCollection:
    '{"version":1,"name":"Organization A skills","description":"","items":[]}',
  customSkills: [skill],
};
collection.rawCollection = JSON.stringify(collection.collection);

test('collection skills follow only its owning organization context', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can2962_collections';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedCollections: [collection],
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
    await app.openPluginsTab('collections');
    // CAN-4267: another organization's shared collection is a Browse row of
    // the Collections tab; the Shared tab and its list were deleted.
    const row = window.getByTestId(
      `plugins-entry-collection:shared:${collection.id}`,
    );
    await expect(row).toBeVisible();
    await row.click();
    const detail = window.getByTestId('plugins-entry-detail-page');
    // Customize title-cases display names; the stored names are lowercase.
    await expect(detail).toContainText(new RegExp(collection.name, 'i'));
    await expect(detail).toContainText(new RegExp(skill.name, 'i'));
    // The detail is a page, not a dialog: its breadcrumb leads back.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(detail).toHaveCount(0);
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await selectWorkspaceContext(window, context);
      await app.openPluginsPage();
      await app.openPluginsTab('collections');
      // Customize re-reads shares when the context changes and has no manual
      // Refresh, so the row's absence and the denied read carry this check.
      await expect(row).toHaveCount(0);
      const result = await window.evaluate(async (id) => {
        try {
          await window.collections.getShared(id);
          return 'allowed';
        } catch (error) {
          return String(error);
        }
      }, collection.id);
      expect(result).toContain('context-mismatch');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
