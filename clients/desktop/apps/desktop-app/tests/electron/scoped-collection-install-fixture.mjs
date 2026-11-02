import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
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
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';
export const skill = {
  id: 'aaaaaaaa-2962-4000-8000-000000000016',
  name: 'Organization A review',
  description: 'An organization review skill',
  contentHash: 'a'.repeat(64),
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  createdBy: { id: 'user', name: 'Owner', email: 'owner@example.test' },
  rawSkill:
    '---\nname: Organization A review\ndescription: An organization review skill\n---\nReview this change.\n',
};
export const collection = {
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

export async function openScopedCollectionInstall({
  revokeBeforeCommit = false,
} = {}) {
  const key = 'csk_can3009_scoped_collection';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedCollections: [collection],
      sharedSkills: [skill],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'scoped-collection-import-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  const close = async () => {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  };
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    if (revokeBeforeCommit) {
      await electronApp.evaluate((_electron, id) => {
        const originalFetch = globalThis.fetch;
        let collectionReads = 0;
        globalThis.fetch = async (input, init) => {
          if (
            String(input).includes(`/collections/${id}`) &&
            ++collectionReads >= 3
          ) {
            return new Response(
              JSON.stringify({ error: 'Collection revoked' }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            );
          }
          return originalFetch(input, init);
        };
      }, collection.id);
    }
    await electronApp.evaluate(
      ({ app }, id) =>
        app.emit(
          'open-url',
          { preventDefault() {} },
          `canopy://share/collections/${id}?audience=ORGANIZATION`,
        ),
      collection.id,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText(collection.name);
    return { electronApp, window, landing, userDataDir, close };
  } catch (error) {
    await close();
    throw error;
  }
}
