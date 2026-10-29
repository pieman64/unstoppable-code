import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  openPublicCollectionInstall,
  PUBLIC_COLLECTION_ID,
} from './public-collection-install-fixture.mjs';

// CAN-3710: one click installs; the review closes and the collection's detail
// opens with a short notice.
async function expectInstalledAndLanded(window, landing) {
  await expect(landing).toHaveCount(0, { timeout: 15_000 });
  await expect(
    window
      .getByTestId('toast-card')
      .filter({ hasText: 'Collection installed' })
      .last(),
  ).toBeVisible();
  await expect(window.getByTestId('plugins-entry-detail')).toBeVisible();
}

test('a non-owner installs and reopens a Public collection with resource context enabled', async () => {
  const { electronApp, window, landing, userDataDir } =
    await openPublicCollectionInstall();
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expectInstalledAndLanded(window, landing);
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'collections', 'index.json'), 'utf8'),
    );
    const entry = index.collections.find(
      (row) => row.name === 'Public Release Kit',
    );
    expect(entry).toBeTruthy();
    const file = await window.evaluate(
      (id) => window.collections.loadCollection(id),
      entry.id,
    );
    expect(file.sharedSource).toMatchObject({
      remoteId: PUBLIC_COLLECTION_ID,
      fromPublicShare: true,
      contentHash: 'c'.repeat(64),
    });
    await window.evaluate(
      (collection) =>
        window.collections.saveCollection({
          ...collection,
          name: 'Edited Public Release Kit',
        }),
      file,
    );
    expect(
      (
        await window.evaluate(
          (id) => window.collections.loadCollection(id),
          entry.id,
        )
      ).name,
    ).toBe('Edited Public Release Kit');
    const requests = await electronApp.evaluate(
      () => globalThis.__publicCollectionRequests,
    );
    expect(requests).toContain('public');
    expect(requests).not.toContain('scoped-denied');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('reopening a republished Public collection link installs the new snapshot', async () => {
  const { electronApp, window, landing, userDataDir } =
    await openPublicCollectionInstall();
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expectInstalledAndLanded(window, landing);
    await electronApp.evaluate(({ app }, id) => {
      globalThis.__publicCollectionContentHash = 'd'.repeat(64);
      app.emit(
        'open-url',
        { preventDefault() {} },
        `canopy://share/collections/${id}`,
      );
    }, PUBLIC_COLLECTION_ID);
    // Wait out detection: the stale copy must not flip this action to Manage.
    await expect(landing.getByTestId('deep-link-share-install')).toBeEnabled({
      timeout: 15_000,
    });
    await landing.getByTestId('deep-link-share-install').click();
    await expectInstalledAndLanded(window, landing);
    const hashes = await window.evaluate(async () => {
      const index = await window.collections.loadIndex();
      const collections = await Promise.all(
        index.map((row) => window.collections.loadCollection(row.id)),
      );
      return collections.map(
        (collection) => collection?.sharedSource?.contentHash,
      );
    });
    expect(hashes.sort()).toEqual(['c'.repeat(64), 'd'.repeat(64)]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a Public collection installs the custom skill pinned in its snapshot', async () => {
  const { electronApp, window, landing, userDataDir } =
    await openPublicCollectionInstall({ customSkill: true });
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expectInstalledAndLanded(window, landing);
    const skills = await window.evaluate(async () => {
      const [row] = await window.collections.loadIndex();
      return (await window.collections.loadCollection(row.id))?.skills;
    });
    expect(skills).toEqual([
      { sourceId: 'custom:app', skillName: 'release-notes' },
    ]);
    // The pinned skill is never looked up as a standalone share.
    expect(
      await electronApp.evaluate(() => globalThis.__publicCollectionRequests),
    ).not.toContain('standalone-skill');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a signed-out recipient installs and reopens a Public collection with resource context enabled', async () => {
  const { electronApp, window, landing, userDataDir } =
    await openPublicCollectionInstall({ signedIn: false });
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expectInstalledAndLanded(window, landing);
    const names = await window.evaluate(async () => {
      const index = await window.collections.loadIndex();
      const collections = await Promise.all(
        index.map((row) => window.collections.loadCollection(row.id)),
      );
      return collections.map((collection) => collection?.name);
    });
    expect(names).toEqual(['Public Release Kit']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a revoked package leaves no new local collection behind', async () => {
  const { electronApp, landing, userDataDir } =
    await openPublicCollectionInstall({ packageFailure: true });
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toContainText('HTTP');
    let collections = [];
    try {
      collections = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'collections', 'index.json'),
          'utf8',
        ),
      ).collections;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    expect(collections).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
