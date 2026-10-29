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
    await window.getByTestId('collections-view-tab-shared').click();
    const row = window
      .getByTestId('shared-collections-section')
      .getByText(collection.name, { exact: true });
    await expect(row).toBeVisible();
    await row.click();
    await expect(
      window.getByRole('dialog', { name: collection.name, exact: true }),
    ).toContainText(skill.name);
    await window.keyboard.press('Escape');
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await window.getByTestId('plugins-management-back').click();
      await selectWorkspaceContext(window, context);
      await app.openPluginsPage();
      await app.openPluginsTab('collections');
      await window.getByTestId('collections-view-tab-shared').click();
      const refresh = window
        .getByTestId('shared-collections-section')
        .getByRole('button', { name: 'Refresh', exact: true });
      await refresh.click();
      await expect(refresh).toBeEnabled();
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
