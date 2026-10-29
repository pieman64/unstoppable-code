import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  collection,
  skill,
  openScopedCollectionInstall,
} from './scoped-collection-install-fixture.mjs';

test('an Organization collection handoff installs its custom skill with scoped provenance', async () => {
  test.setTimeout(120_000);
  const { window, landing, close } = await openScopedCollectionInstall();
  try {
    await landing.getByTestId('deep-link-share-install').click();
    // CAN-3710: the review closes and the notice says what landed.
    await expect(landing).toHaveCount(0, { timeout: 60_000 });
    const notice = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Collection installed' });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText('unavailable');
    const installed = await window.evaluate(async (name) => {
      const index = await window.collections.loadIndex();
      const entry = index.find((row) => row.name === name);
      return entry ? window.collections.loadCollection(entry.id) : null;
    }, collection.name);
    expect(installed.skills).toEqual([
      { sourceId: 'custom:app', skillName: 'organization-a-review' },
    ]);
    const raw = await window.evaluate(
      (name) => window.skills.readRawSkill(`custom:app/${name}`),
      installed.skills[0].skillName,
    );
    expect(raw).toBe(skill.rawSkill);
    await selectWorkspaceContext(window, 'personal');
    const result = await window.evaluate(async (name) => {
      try {
        await window.skills.readRawSkill(`custom:app/${name}`);
        return 'allowed';
      } catch (error) {
        return String(error);
      }
    }, installed.skills[0].skillName);
    expect(result).toContain('context-mismatch');
  } finally {
    await close();
  }
});

test('a revoked definition-only collection commits no member imports', async () => {
  const { window, landing, userDataDir, close } =
    await openScopedCollectionInstall({ revokeBeforeCommit: true });
  try {
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toContainText('HTTP 404');
    const skillRead = await window.evaluate(async () => {
      try {
        return await window.skills.readRawSkill(
          'custom:app/organization-a-review',
        );
      } catch {
        return null;
      }
    });
    expect(skillRead).toBeNull();
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'collections', 'index.json'), 'utf8'),
    );
    expect(index.collections).toEqual([]);
  } finally {
    await close();
  }
});
