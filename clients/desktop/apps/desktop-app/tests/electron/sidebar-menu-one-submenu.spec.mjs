/**
 * Menus show one submenu at a time. In the compact sidebar's worktree row
 * menu, moving from "Group ›" to "More ›" closes Group the moment More
 * opens: no frame shows both flyouts, and the old one gets no hover grace.
 *
 * Deterministic: worktrees are seeded on disk before launch, and the group
 * is created through the row menu. No live agents, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/seedChatsSectionFixture.mjs';

const NESTED_MENU = '[data-floating-menu-nested="true"]';

/** Records the most submenus on screen at once, from now on. */
async function startNestedMenuSampler(window) {
  await window.evaluate((selector) => {
    const state = { max: 0, stop: false };
    const sample = () => {
      state.max = Math.max(
        state.max,
        document.querySelectorAll(selector).length,
      );
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true });
    const tick = () => {
      sample();
      if (!state.stop) requestAnimationFrame(tick);
      else observer.disconnect();
    };
    requestAnimationFrame(tick);
    window.__nestedMenuSampler = state;
  }, NESTED_MENU);
}

async function stopNestedMenuSampler(window) {
  return window.evaluate(() => {
    const state = window.__nestedMenuSampler;
    state.stop = true;
    return state.max;
  });
}

test('compact worktree menu: moving between submenus shows one at a time', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-menu-one-submenu-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2, chatEntryCount: 1 });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: true,
      }),
    );
    const row = window
      .getByTestId('sidebar-shared-rail')
      .getByTestId('worktree-row')
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // A group gives the row menu a second submenu ("Group ›") beside More.
    await row.click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click();
    const editor = window.getByTestId('sidebar-item-group-editor');
    await expect(editor).toBeVisible();
    await editor.getByTestId('sidebar-item-group-editor-close').click();
    await expect(editor).toBeHidden();

    await row.click({ button: 'right' });
    const menu = window.getByTestId('worktree-actions-menu');
    await expect(menu).toBeVisible();
    const group = menu.getByRole('menuitem', { name: 'Group', exact: true });
    const more = menu.getByTestId('worktree-actions-menu-more');
    const groupMenu = window.getByTestId('sidebar-group-organize-menu');
    const moreMenu = window.getByTestId('worktree-actions-menu-more-menu');

    await group.hover();
    await expect(groupMenu).toBeVisible();

    await startNestedMenuSampler(window);
    await more.hover();
    await expect(moreMenu).toBeVisible();
    await expect(groupMenu).toHaveCount(0);
    // Past the old hover grace, so a late close would have been recorded.
    await window.waitForTimeout(400);
    expect(await stopNestedMenuSampler(window)).toBe(1);

    // And back again.
    await startNestedMenuSampler(window);
    await group.hover();
    await expect(groupMenu).toBeVisible();
    await expect(moreMenu).toHaveCount(0);
    await window.waitForTimeout(400);
    expect(await stopNestedMenuSampler(window)).toBe(1);

    // Group opened with the keyboard has no pointer to leave it; hovering
    // More still closes it, for good.
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await window.mouse.move(1, 1);
    for (let step = 0; step < 8; step += 1) {
      if (await group.evaluate((node) => node === document.activeElement))
        break;
      await window.keyboard.press('ArrowDown');
    }
    await expect(group).toBeFocused();
    await window.keyboard.press('ArrowRight');
    await expect(groupMenu).toBeVisible();
    await startNestedMenuSampler(window);
    await more.hover();
    await expect(moreMenu).toBeVisible();
    await expect(groupMenu).toHaveCount(0);
    await window.waitForTimeout(1_000);
    await expect(groupMenu).toHaveCount(0);
    expect(await stopNestedMenuSampler(window)).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
