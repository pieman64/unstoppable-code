/** CAN-4908: real reconciliation with only upstream HTTP responses doubled. */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { require as tsxRequire } from 'tsx/cjs/api';
const {
  buildSharedContainerCoworkFixture,
  buildSharedContainerReplicaFixture,
} = tsxRequire(
  '../../src/main/__tests__/fixtures/shared-container-replica-fixture.ts',
  import.meta.url,
);
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { acceptSharedContainerInvitation } from './sharedContainerRecipientActions.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedChatsSectionFixture,
  seedOrgContextScoping,
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  ORG_CONTEXT_ENV,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID as CONTAINER,
} from './seeders/index.mjs';
import {
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID as ORGANIZATION,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

export { CONTAINER, ORGANIZATION };
export const PUBLICATION = '2026-09-02T10:30:00.000Z';
export const NOTE =
  '# Revision two follow-up\n\nCall the customer on Friday. Ada added a scheduling detail.\n';
export const MESSAGE = 'Publisher added a scheduling detail at revision two.';

export async function openRevisionJourney({ rootPath } = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4908-flow-'));
  const scenario = sharedContainerRecipientScenario({ includeRun: false });
  scenario.sharedContainersState.containers =
    scenario.sharedContainersState.containers.map((container) => ({
      ...container,
      organizationName: 'Share owner org',
    }));
  scenario.cloud = {
    ...scenario.cloud,
    organizations: [
      {
        id: ORGANIZATION,
        name: 'Share owner org',
        role: 'MEMBER',
        createdAt: PUBLICATION,
        updatedAt: PUBLICATION,
      },
    ],
    orgBillingStates: [
      {
        organizationId: ORGANIZATION,
        organizationName: 'Share owner org',
        teamsEntitled: true,
      },
    ],
  };
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    scenario,
  );
  const env = buildSharedContainerE2eEnv(userDataDir, {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS:
      ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
    CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
  });
  let electronApp;
  const cleanup = async () => {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      );
    }
  };
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env, rootPath }));
    await connectSharedContainersAccount(await electronApp.firstWindow());
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    seedOrgContextScoping(userDataDir);
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 1,
      chatEntryCount: 1,
    });
    ({ electronApp } = await launchCanopy({ userDataDir, env, rootPath }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await selectWorkspaceContext(window, ORGANIZATION);
    await app.openMainPage();
    await acceptSharedContainerInvitation(window, CONTAINER);
    await expect(window.getByTestId('shared-container-surface')).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-open-modal'),
    ).toBeVisible();
    // Join any initial open before replacing the upstream, so a forced sync
    // cannot coalesce with a still-running revision-one materialization.
    await window.evaluate(
      async ({ containerId, organizationId }) =>
        window.api.sharedContainers.open({ containerId, organizationId }),
      { containerId: CONTAINER, organizationId: ORGANIZATION },
    );
    return { electronApp, window, app, userDataDir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function promoteRevisionTwo({ electronApp, window }) {
  const { layout, blobs } = buildSharedContainerCoworkFixture();
  layout.title = 'Customer follow-up';
  layout.notes[0].title = 'Revision two follow-up';
  blobs.find((blob) => blob.artifactId === 'note-artifact').bytes =
    Buffer.from(NOTE);
  const chat = JSON.parse(
    blobs.find((blob) => blob.artifactId === 'chat-artifact').bytes.toString(),
  );
  chat.messages.push({
    messageId: 'revision-two',
    chatId: 'chat-1',
    role: 'assistant',
    status: 'complete',
    text: MESSAGE,
    createdAtMs: Date.parse(PUBLICATION),
  });
  blobs.find((blob) => blob.artifactId === 'chat-artifact').bytes = Buffer.from(
    JSON.stringify(chat),
  );
  const fixture = await buildSharedContainerReplicaFixture({
    revisionId: 'cowork-revision-2',
    revision: 2,
    layout,
    plaintextArtifacts: blobs,
  });
  fixture.revision.revision.createdAt = PUBLICATION;
  Object.assign(fixture.detail, {
    id: CONTAINER,
    organizationId: ORGANIZATION,
    access: 'organization',
    organizationName: 'Share owner org',
    ownerUserId: '11111111-1111-4111-8111-111111111111',
  });
  // data URLs are fetched/decrypted/hashed by the actual replica manager.
  // Only the upstream transport is replaced, never its store, guard or reader.
  for (const download of fixture.downloads.downloads) {
    download.target.url = `data:application/octet-stream;base64,${fixture.responses.get(download.target.url).toString('base64')}`;
  }
  await electronApp.evaluate(
    (_, payload) => {
      const original = globalThis.fetch;
      globalThis.__can4908Requests = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : (input.url ?? String(input)),
        );
        const prefix = `/api/v1/shared-containers/${payload.containerId}/revisions/`;
        if (url.pathname.startsWith(prefix)) {
          globalThis.__can4908Requests.push(url.pathname);
          const suffix = url.pathname.slice(prefix.length);
          if (suffix === 'latest') return Response.json(payload.detail);
          if (suffix === 'cowork-revision-2')
            return Response.json(payload.revision);
          if (suffix === 'cowork-revision-2/artifacts/download-urls') {
            const requested = JSON.parse(init.body).artifactIds;
            return Response.json({
              downloads: payload.downloads.downloads.filter((item) =>
                requested.includes(item.artifactId),
              ),
            });
          }
        }
        return original(input, init);
      };
    },
    {
      containerId: CONTAINER,
      detail: fixture.detail,
      revision: fixture.revision,
      downloads: fixture.downloads,
    },
  );
  const state = await window.evaluate(
    async ({ containerId, organizationId }) =>
      window.api.sharedContainers.retry({ containerId, organizationId }),
    { containerId: CONTAINER, organizationId: ORGANIZATION },
  );
  expect(
    state,
    JSON.stringify(
      await electronApp.evaluate(() => globalThis.__can4908Requests),
    ),
  ).toMatchObject({
    status: 'available',
    revisionId: 'cowork-revision-2',
    revisionCreatedAt: PUBLICATION,
  });
}

export async function openCopyDialog(window, entry = 'viewer') {
  if (entry === 'viewer') {
    await window.getByTestId('shared-container-fork-open-modal').click();
  } else {
    const row = `shared-container-row-${CONTAINER}`;
    await window.getByTestId(row).hover();
    await window.getByTestId(`${row}-actions`).click();
    await window.getByTestId(`${row}-fork`).click();
  }
  await expect(
    window.getByTestId('shared-container-fork-destination-context'),
  ).toHaveText('Belongs to Share owner org');
  await window.getByTestId('shared-container-fork-continue').click();
  await expect(
    window.getByTestId('shared-container-fork-disclosures-destination'),
  ).toHaveText('Your copy will be made in Share owner org.');
}

export async function assertRevisionTwoCopy({ window, userDataDir }) {
  await expect(
    window.getByTestId('shared-container-fork-revision'),
  ).toHaveAttribute('data-revision-id', 'cowork-revision-2');
  await expect(
    window.getByTestId('shared-container-fork-revision').locator('time'),
  ).toHaveAttribute('datetime', PUBLICATION);
  await window.getByTestId('shared-container-fork-confirm').click();
  await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
    0,
    { timeout: 60_000 },
  );
  const notice = window.getByTestId('shared-container-fork-provenance');
  await expect(notice).toContainText('version of');
  await expect(notice.locator('time')).toHaveAttribute('datetime', PUBLICATION);
  await window
    .getByTestId('page-chat')
    .getByTestId('panel-tab-panel-chat-chat-1')
    .click();
  await expect(window.getByTestId('page-chat')).toContainText(MESSAGE);
  const index = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces/index.json'), 'utf8'),
  );
  const copy = index.workspaces.find(
    (item) => item.name === 'Customer follow-up',
  );
  expect(copy).toBeTruthy();
  const root = path.join(userDataDir, 'workspaces', copy.id);
  expect(
    JSON.parse(readFileSync(path.join(root, 'workspace.json'), 'utf8')).owner,
  ).toMatchObject({ type: 'organization', organizationId: ORGANIZATION });
  const entries = JSON.parse(
    readFileSync(path.join(root, 'work-entries.json'), 'utf8'),
  ).entries;
  expect(entries).toHaveLength(1);
  const provenance = await window.evaluate(
    async ({ projectId, worktreeId }) =>
      window.api.sharedContainers.readForkProvenance({ projectId, worktreeId }),
    { projectId: copy.id, worktreeId: entries[0].id },
  );
  expect(provenance).toMatchObject({
    sourceRevisionId: 'cowork-revision-2',
    sourceRevisionCreatedAt: PUBLICATION,
    organizationId: ORGANIZATION,
  });
  expect(provenance.forkedAt).not.toBe(PUBLICATION);
  // The destination note uses its body to derive the title, independent of the viewer layout.
  const noteDir = path.join(root, 'home', '.canopy', 'notes');
  const note = readdirSync(noteDir).find((name) => name.endsWith('.md'));
  expect(readFileSync(path.join(noteDir, note), 'utf8')).toBe(NOTE);
  await expect(
    window
      .getByTestId('workspace-notes-item')
      .filter({ hasText: 'Revision two follow-up' }),
  ).toHaveCount(1);
}
