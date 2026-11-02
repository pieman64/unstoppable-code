// CAN-3310: Collection authoring, import review, and one-action installation.
// The local Collection carries a deterministic skill package;
// no live account or network is used.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_TEAM,
  seedMcpServers,
} from './seeders/index.mjs';

const LOCAL_COLLECTION_ID = 'c3310000-0000-4000-8000-000000000001';
const LOCAL_SKILL_SOURCE_ID = 'local:release-fixture';
const LOCAL_ENTRY_ID = `collection:local:${LOCAL_COLLECTION_ID}`;

// CAN-4267: the Collections list table was deleted; a local collection is a
// row of the Collections tab's Added section, and Share is an item of that
// row's menu.
function localCollectionRow(window) {
  return window
    .getByTestId('customize-section-installed')
    .getByTestId(`customize-row-${LOCAL_ENTRY_ID}`);
}

async function openLocalShareItem(window) {
  const menu = window
    .getByTestId('customize-section-installed')
    .getByTestId(`customize-row-menu-${LOCAL_ENTRY_ID}`);
  await menu.click();
  const item = window.getByTestId(`customize-row-menu-${LOCAL_ENTRY_ID}-share`);
  await expect(item).toBeVisible();
  return item;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedAuthor(userDataDir, withMcp = false) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    LOCAL_SKILL_SOURCE_ID,
    'release-notes',
  );
  mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: release-notes',
      'description: Draft release notes from merged pull requests.',
      '---',
      '',
      '# Release notes',
      '',
      'Read references/style.md, then run scripts/collect.sh and post the',
      'summary.',
      '',
    ].join('\n'),
  );
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'slack-local',
          name: 'Slack',
          description: 'Slack authoring fixture.',
          type: 'http',
          url: 'http://127.0.0.1:9/mcp',
          curated: { key: 'slack' },
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
        configs: [
          {
            id: 'work',
            name: 'Work',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-09-23T00:00:00.000Z',
            updatedAt: '2026-09-23T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  writeFileSync(
    path.join(skillDir, 'references', 'style.md'),
    '# Style\n\nLead with the user-visible change.\n',
  );
  writeFileSync(
    path.join(skillDir, 'scripts', 'collect.sh'),
    '#!/bin/sh\ngit log --merges --oneline "$1"..HEAD\n',
  );
  writeJson(path.join(userDataDir, 'skills', 'skills-lock.json'), {
    version: 2,
    skills: {
      [`${LOCAL_SKILL_SOURCE_ID}/release-notes`]: {
        sourceId: LOCAL_SKILL_SOURCE_ID,
        source: '/fixtures/release-notes',
        sourceType: 'local',
        sourceUrl: 'file:///fixtures/release-notes',
        skillPath: '.',
        skillFolderHash: '',
        installedAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    },
  });
  const collection = {
    id: LOCAL_COLLECTION_ID,
    name: 'Release Readiness Collection',
    description: 'A packaged local skill.',
    skills: [{ sourceId: LOCAL_SKILL_SOURCE_ID, skillName: 'release-notes' }],
    plugins: [],
    mcpServers: withMcp ? [{ serverId: 'slack-local', configId: 'work' }] : [],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    remote: {
      remoteId: 'missing-can3310-package-collection',
      contentHash: 'stale-local-hash',
      shareScope: 'private',
      sharedAt: '2026-09-23T00:00:00.000Z',
      accountId: 'account-e2e',
    },
  };
  writeJson(path.join(userDataDir, 'collections', 'index.json'), {
    version: 2,
    collections: [
      {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        updatedAt: collection.updatedAt,
        skillCount: 1,
        pluginCount: 0,
        mcpServerCount: withMcp ? 1 : 0,
      },
    ],
  });
  writeJson(
    path.join(
      userDataDir,
      'collections',
      `collection-${LOCAL_COLLECTION_ID}.json`,
    ),
    { version: 2, collection },
  );
  return skillDir;
}

test('recreates, previews, and installs a packaged Collection in one action', async () => {
  test.setTimeout(180_000);
  // Collections are shared with a team or organization.
  await registerShareMembership('csk_can3310_collection_package_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3310-collection-'),
  );
  const authorSkillDir = seedAuthor(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_can3310_collection_package_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    const localRow = localCollectionRow(window);
    await expect(localRow).toBeVisible();
    await (await openLocalShareItem(window)).click();
    const share = window.getByTestId('share-collection-modal');
    const dependencies = share.getByTestId('share-collection-dependencies');
    await expect(dependencies).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    });
    // The packaged files are named in the tooltip of the summary's help icon.
    await share.getByTestId('share-collection-dependencies-help').hover();
    await expect(
      window.getByTestId('share-collection-dependencies-help-details'),
    ).toContainText('/release-notes');
    await expect(
      share.getByTestId('share-collection-scope-team'),
    ).toHaveAttribute('aria-checked', 'true');
    await share
      .getByTestId(
        `share-collection-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`,
      )
      .click();
    // No publication consent and no delete-local option: Share is ready as
    // soon as the audience is picked, and the local Collection is kept.
    await expect(share.getByTestId('share-collection-consent')).toHaveCount(0);
    await expect(
      share.getByTestId('share-collection-delete-local'),
    ).toHaveCount(0);
    await expect(share.getByTestId('share-collection-submit')).toHaveText(
      'Share',
    );
    await expect(share.getByTestId('share-collection-submit')).toBeEnabled();
    await share.getByTestId('share-collection-submit').click();
    // The dialog stays open on its success notice; no toast is raised.
    await expect(share.getByTestId('share-collection-success')).toContainText(
      'Collection shared',
      { timeout: 60_000 },
    );
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Collection shared' }),
    ).toHaveCount(0);
    await share.getByTestId('share-collection-done').click();
    await expect(share).toHaveCount(0);
    await expect(localRow).toBeVisible();
    rmSync(authorSkillDir, { recursive: true, force: true });
    rmSync(path.join(userDataDir, 'mcp-servers'), {
      recursive: true,
      force: true,
    });

    // CAN-4267: the Shared tab, its inline success flash and its Import
    // button were deleted. The viewer's share is a "Shared by me" row; its
    // detail's Add opens the same install review.
    await expect(window.getByTestId('page-plugins')).not.toContainText(
      'Collection shared successfully.',
    );
    const row = window
      .getByTestId('customize-section-shared-by-me')
      .locator('[data-testid^="customize-row-collection:shared:"]')
      .filter({ hasText: 'Release Readiness Collection' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await window.getByTestId('shared-collection-detail-add').click();

    // The shared install review (CAN-3710): one click installs and closes it.
    const review = window.getByTestId('deep-link-share-landing');
    await expect(review).toBeVisible();
    await expect(review).toContainText('Release Readiness Collection');
    await review.getByTestId('deep-link-share-install').click();
    await expect(review).toHaveCount(0, { timeout: 60_000 });

    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'collections', 'index.json'), 'utf8'),
    );
    expect(index.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Release Readiness Collection' }),
      ]),
    );
    // The shared source stays local, so pick the imported copy.
    const collectionEntry = index.collections.find(
      (entry) =>
        entry.name === 'Release Readiness Collection' &&
        entry.id !== LOCAL_COLLECTION_ID,
    );
    const config = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'collections',
          `collection-${collectionEntry.id}.json`,
        ),
        'utf8',
      ),
    );
    const packagedSkill = config.collection.skills.find(
      (skill) => skill.sourceId === 'custom:app',
    );
    expect(packagedSkill).toBeTruthy();
    const skillDir = path.join(
      userDataDir,
      'skills',
      'custom:app',
      packagedSkill.skillName,
    );
    expect(
      readFileSync(path.join(skillDir, 'references', 'style.md'), 'utf8'),
    ).toContain('Lead with the user-visible change.');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('MCP-backed collections show a disabled Share action and reject alternate modal entry', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3009-mcp-block-'));
  seedAuthor(userDataDir, true);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_can3310_collection_package_e2e',
      }),
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await expect(localCollectionRow(window)).toBeVisible();
    // The row menu's Share stays visible but unavailable, and names why.
    const share = await openLocalShareItem(window);
    await expect(share).toHaveAttribute('aria-disabled', 'true');
    await expect(share).toHaveAccessibleName(
      'Share…: Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
    );
    await share.click({ force: true });
    await expect(window.getByTestId('share-collection-modal')).toHaveCount(0);
    const result = await window.evaluate(async (id) => {
      // Share handlers resolve a `ShareOperationResult` envelope.
      const outcome = await window.collections.createShared({
        sourceCollectionId: id,
        rawCollection: '{}',
        shareScope: 'private',
      });
      return outcome.ok ? 'unexpectedly shared' : outcome.failure.message;
    }, LOCAL_COLLECTION_ID);
    expect(result).toContain(
      'Collections containing MCP servers cannot be shared.',
    );
    await expect(window.getByTestId('share-collection-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a failed public-link revoke preserves the collection audience', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3009_collection_revoke_e2e';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3009-revoke-'));
  seedAuthor(userDataDir);
  const file = path.join(
    userDataDir,
    'collections',
    `collection-${LOCAL_COLLECTION_ID}.json`,
  );
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.collection.skills = [];
  writeJson(file, stored);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      apiKey,
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await electronApp.evaluate(({ ipcMain }) => {
      const detail = {
        id: 'missing-can3310-package-collection',
        name: 'Release Readiness Collection',
        description: 'A packaged local skill.',
        contentHash: 'server-hash',
        shareScope: 'private',
        owner: { type: 'user', id: 'account-e2e' },
        createdBy: { id: 'account-e2e', name: 'E2E' },
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        rawCollection: JSON.stringify({
          version: 1,
          name: 'Release Readiness Collection',
          items: [],
        }),
        publicShare: {
          externalId: 'public-revoke-fixture',
          pinnedContentHash: 'server-hash',
          upToDate: true,
          sharePath: '/portal/plugins/collections/shared/public-revoke-fixture',
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      };
      globalThis.can3009AudienceUpdates = 0;
      ipcMain.removeHandler('collections:shared-get');
      ipcMain.handle('collections:shared-get', () => detail);
      ipcMain.removeHandler('collections:shared-update');
      ipcMain.handle('collections:shared-update', () => {
        globalThis.can3009AudienceUpdates += 1;
        // Share update resolves a ShareOperationResult envelope.
        return { ok: true, value: { ...detail, shareScope: 'team' } };
      });
      ipcMain.removeHandler('collections:shared-public-revoke');
      ipcMain.handle('collections:shared-public-revoke', () => {
        throw new Error('Public link revoke failed.');
      });
    });
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await expect(localCollectionRow(window)).toBeVisible();
    await (await openLocalShareItem(window)).click();
    const share = window.getByTestId('share-collection-modal');
    await expect(
      share.getByTestId('share-collection-dependencies'),
    ).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await share.getByTestId('share-collection-scope-team').click();
    await share
      .getByTestId(
        `share-collection-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`,
      )
      .click();
    await share.getByTestId('share-collection-submit').click();
    await expect(share).toContainText('Public link revoke failed.');
    await expect(share).toBeVisible();
    const updates = await electronApp.evaluate(
      () => globalThis.can3009AudienceUpdates,
    );
    expect(updates).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('offers Public collection sharing from the Personal list row and detail', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3009-personal-'));
  seedAuthor(userDataDir);
  const file = path.join(
    userDataDir,
    'collections',
    `collection-${LOCAL_COLLECTION_ID}.json`,
  );
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  delete stored.collection.remote;
  writeJson(file, stored);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_can3009_personal_collection',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    const context = await window.evaluate(() =>
      window.api.workspaceContext.get(),
    );
    expect(context.context).toEqual({ kind: 'personal' });
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await expect(localCollectionRow(window)).toBeVisible();
    const listShare = await openLocalShareItem(window);
    await listShare.click();
    const modal = window.getByTestId('share-collection-modal');
    await expect(modal).toBeVisible();
    await expect(
      modal.getByTestId('share-collection-scope-description'),
    ).toContainText('Anyone can view');
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    // A local collection has no Browse card (CAN-4261); its Added row above
    // opens the detail.
    await localCollectionRow(window).click();
    const detailShare = window.getByTestId('plugins-entry-detail-share');
    await expect(detailShare).toBeVisible();
    await detailShare.click();
    await expect(modal).toBeVisible();
    await expect(
      modal.getByTestId('share-collection-scope-description'),
    ).toContainText('Anyone can view');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
