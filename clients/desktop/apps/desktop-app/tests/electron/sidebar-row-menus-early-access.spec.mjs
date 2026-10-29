/**
 * Early access: sidebar worktree row menus read "Rename" with a pencil, and
 * the shared rail folds its rare rows (Branch info, Hide, Split PR, …) into
 * one "More" submenu. With early access off, both rails keep develop's menu:
 * "Set label" and every row at the top level.
 *
 * Deterministic: workspaces and worktrees are seeded on disk before launch.
 * No live agents, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

async function launchSeeded({ sharedRail }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-row-menus-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 800 },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // The shared rail is on unless the flag reads '0'; pin it either way.
  await window.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [SHARED_SIDEBAR_STORAGE_KEY, sharedRail ? '1' : '0'],
  );
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, window, userDataDir };
}

async function setEarlyAccess(window, enabled) {
  await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: value,
      }),
    enabled,
  );
}

async function closeMenu(window) {
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);
  await window.mouse.move(1, 1);
}

for (const sharedRail of [false, true]) {
  const railName = sharedRail ? 'shared rail' : 'legacy rail';

  test(`${railName}: early access renames Set label and, on the shared rail, folds rare rows into More`, async () => {
    test.setTimeout(180_000);
    const { electronApp, window, userDataDir } = await launchSeeded({
      sharedRail,
    });
    try {
      const row = window.getByTestId('worktree-row').first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const menu = window.getByTestId('worktree-actions-menu');
      const setLabel = menu.getByTestId('worktree-actions-menu-set-label');
      const branchInfo = window.getByTestId('worktree-actions-menu-info');
      const more = menu.getByTestId('worktree-actions-menu-more');

      // Early access off: develop's menu.
      await setEarlyAccess(window, false);
      await row.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await expect(setLabel).toHaveText('Set label');
      await expect(branchInfo).toBeVisible();
      await expect(more).toHaveCount(0);
      await closeMenu(window);

      // Early access on: "Rename"; the shared rail moves Branch info into
      // More, and the legacy rail keeps it at the top level.
      await setEarlyAccess(window, true);
      await row.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await expect(setLabel).toHaveText('Rename');
      if (sharedRail) {
        await expect(branchInfo).toHaveCount(0);
        await expect(more).toBeVisible();
        await more.click();
        const moreMenu = window.getByTestId('worktree-actions-menu-more-menu');
        await expect(moreMenu).toBeVisible();
        await expect(
          moreMenu.getByTestId('worktree-actions-menu-info'),
        ).toBeVisible();
      } else {
        await expect(branchInfo).toBeVisible();
        await expect(more).toHaveCount(0);
      }
      await closeMenu(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
