import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { CANOPY_ORG_PROJECTS_ENABLED_ENV } from './featureFlagEnv.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { registerShareMembership } from './seeders/index.mjs';

export const PUBLIC_COLLECTION_ID = 'fa300900-0000-4000-8000-000000000012';
/** Pinned inside the collection snapshot only; it has no standalone share. */
const PINNED_SKILL = {
  id: 'fa300900-0000-4000-8000-000000000013',
  name: 'release-notes',
  rawSkill:
    '---\nname: release-notes\ndescription: Draft release notes.\n---\n\nDraft release notes.\n',
  contentHash: 'e'.repeat(64),
};
export async function openPublicCollectionInstall({
  packageFailure = false,
  customSkill = false,
  signedIn = true,
} = {}) {
  const apiKey = 'csk_can3009_public_collection_recipient';
  if (signedIn) await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'public-collection-recipient-'),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: CANOPY_ORG_PROJECTS_ENABLED_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    if (signedIn) {
      await window.evaluate(
        (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        apiKey,
      );
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
    }
    await electronApp.evaluate(
      (_electron, { externalId, packageFailure, pinnedSkill }) => {
        const originalFetch = globalThis.fetch;
        globalThis.__publicCollectionRequests = [];
        let revoked = false;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (pinnedSkill && url.includes(`/skills/${pinnedSkill.id}`)) {
            globalThis.__publicCollectionRequests.push('standalone-skill');
            return new Response(JSON.stringify({ error: 'Skill not found' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (
            packageFailure &&
            url.includes(`/public-shares/collections/${externalId}/package`)
          ) {
            revoked = true;
            return new Response(
              JSON.stringify({ error: 'Package unavailable' }),
              { status: 404 },
            );
          }
          if (url.includes(`/public-shares/collections/${externalId}`)) {
            if (revoked)
              return new Response(JSON.stringify({ error: 'Share revoked' }), {
                status: 404,
              });
            globalThis.__publicCollectionRequests.push('public');
            return new Response(
              JSON.stringify({
                entity: 'collection',
                externalId,
                contentHash:
                  globalThis.__publicCollectionContentHash ?? 'c'.repeat(64),
                collection: {
                  version: 1,
                  name: 'Public Release Kit',
                  description: 'Shared by another person.',
                  items: pinnedSkill
                    ? [
                        {
                          type: 'custom_skill',
                          skillId: pinnedSkill.id,
                          skill_name: pinnedSkill.name,
                          contentHash: pinnedSkill.contentHash,
                        },
                      ]
                    : [],
                },
                itemCounts: {
                  skills: 0,
                  plugins: 0,
                  customSkills: pinnedSkill ? 1 : 0,
                },
                customSkills: pinnedSkill ? [pinnedSkill] : [],
                distributionMode: packageFailure
                  ? 'package'
                  : 'definition_only',
                ...(packageFailure
                  ? {
                      package: {
                        version: 1,
                        digest: `pp:v1:${'A'.repeat(43)}`,
                        resources: [],
                        environmentRequirements: [],
                        totalFiles: 0,
                        totalBytes: 0,
                      },
                    }
                  : {}),
                authorUsername: 'other-author',
                updatedAt: '2026-10-02T00:00:00Z',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.includes(`/collections/${externalId}`)) {
            globalThis.__publicCollectionRequests.push('scoped-denied');
            return new Response(
              JSON.stringify({ error: 'Collection not found' }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            );
          }
          return originalFetch(input, init);
        };
      },
      {
        externalId: PUBLIC_COLLECTION_ID,
        packageFailure,
        pinnedSkill: customSkill ? PINNED_SKILL : null,
      },
    );
    await electronApp.evaluate(
      ({ app }, id) =>
        app.emit(
          'open-url',
          { preventDefault() {} },
          `canopy://share/collections/${id}`,
        ),
      PUBLIC_COLLECTION_ID,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('Public Release Kit');
    return { electronApp, window, landing, userDataDir };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}
