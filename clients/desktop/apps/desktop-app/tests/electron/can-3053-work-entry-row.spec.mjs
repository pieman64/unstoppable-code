/**
 * CAN-3053 slice 2c — desktop Work Entry rows render the shared
 * `WorkEntryRow` from `@canopy/ui-shared`.
 *
 * The swap must be invisible, so this pins the row behaviour the Chats
 * section (and every cowork project) had before it: the hover ••• menu and
 * its commands, the right-click menu at the pointer, a menu that leaves focus
 * on its trigger, pin to top, opening a row by click and by keyboard, drag
 * reorder in Manual order, and no dragging in Last updated order. Written and
 * run green against the legacy row first, then kept green across the swap.
 *
 * Both rails render the same row: the legacy desktop rail (default) and the
 * shared rail behind `canopy.desktop.sharedSidebar`.
 *
 * Deterministic: workspaces, worktrees and chat transcripts are seeded on disk
 * before launch. No live agents, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_DEFAULT_COWORK_ID,
  seedChatsSectionFixture,
} from './seeders/index.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

async function launchSeeded({ sharedRail = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3053-entry-row-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 900, height: 700 },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  if (sharedRail) {
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
  }
  return { electronApp, window, userDataDir };
}

/** The in-flow Chats rows, in rendered order. */
function chatsRows(window) {
  return window
    .getByTestId('sidebar-section-chats-content')
    .locator('[data-standalone-chat-id]');
}

async function chatsRowIds(window) {
  return chatsRows(window).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-standalone-chat-id')),
  );
}

function entryRow(window, entryId) {
  return window
    .getByTestId('sidebar-section-chats-content')
    .locator(`[data-standalone-chat-id="${entryId}"]`);
}

for (const sharedRail of [false, true]) {
  const railName = sharedRail ? 'shared rail' : 'legacy rail';

  test(`${railName}: a Chats row opens its menu from ••• and at a right-click`, async () => {
    test.setTimeout(120_000);
    const { electronApp, window, userDataDir } = await launchSeeded({
      sharedRail,
    });
    try {
      const id = 'entry-chat-002';
      const row = entryRow(window, id);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await waitForStableLocator(window, row);
      await expect(row).toHaveAttribute('role', 'button');
      await expect(row).toHaveAttribute('data-entry-status', 'active');
      await expect(row).toHaveAttribute(
        'data-testid',
        `sidebar-work-entry-${id}`,
      );

      // Hover reveals Delete and •••.
      await row.hover();
      const menuButton = row.getByTestId(`sidebar-work-entry-${id}-menu`);
      await expect(
        row.getByTestId(`sidebar-work-entry-${id}-delete-button`),
      ).toHaveAttribute('aria-label', 'Delete');
      await expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
      await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

      // ••• opens the menu under the button, with the full command list in
      // the standard order, and leaves focus on the trigger.
      await menuButton.click();
      const popover = window.getByTestId(
        `sidebar-work-entry-${id}-menu-popover`,
      );
      await expect(popover).toBeVisible();
      await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      const items = await popover
        .locator('[data-testid]')
        .evaluateAll((nodes) =>
          nodes
            .map((node) => node.getAttribute('data-testid'))
            .filter((testId) =>
              /-(toggle-pin|rename|toggle-done|invite|archive|delete)$/.test(
                testId,
              ),
            ),
        );
      expect(items).toEqual([
        `sidebar-work-entry-${id}-toggle-pin`,
        `sidebar-work-entry-${id}-rename`,
        `sidebar-work-entry-${id}-toggle-done`,
        `sidebar-work-entry-${id}-archive`,
        `sidebar-work-entry-${id}-delete`,
      ]);
      await expect(popover).toContainText('Pin to top');
      await expect(popover).toContainText('Mark done');
      const focusedTestId = await window.evaluate(() =>
        document.activeElement?.getAttribute('data-testid'),
      );
      expect(focusedTestId).toBe(`sidebar-work-entry-${id}-menu`);
      const buttonAnchored = await popover.boundingBox();
      expect(buttonAnchored).not.toBeNull();
      await window.keyboard.press('Escape');
      await expect(popover).toBeHidden();

      // Right-click opens the same menu at the pointer.
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      const point = { x: box.x + 30, y: box.y + box.height / 2 };
      await window.mouse.click(point.x, point.y, { button: 'right' });
      await expect(popover).toBeVisible();
      const pointAnchored = await popover.boundingBox();
      expect(pointAnchored).not.toBeNull();
      expect(Math.abs(pointAnchored.x - point.x)).toBeLessThan(8);
      expect(Math.abs(pointAnchored.y - point.y)).toBeLessThan(12);
      expect(Math.abs(pointAnchored.x - buttonAnchored.x)).toBeGreaterThan(20);
      // An outside click closes it without opening the row.
      await window.mouse.click(600, 650);
      await expect(popover).toBeHidden();
      await expect(row).not.toHaveAttribute('data-sidebar-selected-item', '');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test(`${railName}: a Chats row opens on click and on Enter, and pins to the top`, async () => {
    test.setTimeout(120_000);
    const { electronApp, window, userDataDir } = await launchSeeded({
      sharedRail,
    });
    try {
      const first = entryRow(window, 'entry-chat-001');
      await expect(first).toBeVisible({ timeout: 30_000 });
      await waitForStableLocator(window, first);
      expect(await chatsRowIds(window)).toEqual([
        'entry-chat-001',
        'entry-chat-002',
        'entry-chat-003',
        'entry-chat-004',
        'entry-chat-005',
      ]);

      // Click opens the entry: the row takes the selected surface and mark.
      await first.click();
      await expect(first).toHaveAttribute('data-sidebar-selected-item', '');
      await expect(first).toHaveClass(/\bbg-muted\b/);

      // Enter on the focused row opens it too.
      const second = entryRow(window, 'entry-chat-002');
      await second.focus();
      await window.keyboard.press('Enter');
      await expect(second).toHaveAttribute('data-sidebar-selected-item', '');
      await expect(first).not.toHaveAttribute('data-sidebar-selected-item', '');

      // Pin to top from the menu moves the row to the head of the list.
      const fourth = entryRow(window, 'entry-chat-004');
      await fourth.hover();
      await fourth
        .getByTestId('sidebar-work-entry-entry-chat-004-menu')
        .click();
      await window
        .getByTestId('sidebar-work-entry-entry-chat-004-toggle-pin')
        .click();
      await expect
        .poll(() => chatsRowIds(window))
        .toEqual([
          'entry-chat-004',
          'entry-chat-001',
          'entry-chat-002',
          'entry-chat-003',
          'entry-chat-005',
        ]);
      // …and the menu now offers Unpin.
      await fourth.hover();
      await fourth
        .getByTestId('sidebar-work-entry-entry-chat-004-menu')
        .click();
      await expect(
        window.getByTestId('sidebar-work-entry-entry-chat-004-toggle-pin'),
      ).toContainText('Unpin');
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('legacy rail: Chats rows drag to reorder in Manual order, and stay put in Last updated order', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded();
  try {
    const source = entryRow(window, 'entry-chat-003');
    const target = entryRow(window, 'entry-chat-001');
    await expect(source).toBeVisible({ timeout: 30_000 });
    await waitForStableLocator(window, source);
    // Manual order is the default: rows are sortable drag sources.
    await expect(source).toHaveAttribute('aria-roledescription', 'sortable');
    await expect(source).toHaveClass(/\btouch-none\b/);

    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    const startX = sourceBox.x + 40;
    const startY = sourceBox.y + sourceBox.height / 2;
    await window.mouse.move(startX, startY);
    await window.mouse.down();
    await window.mouse.move(startX, startY - 8, { steps: 4 });
    await window.mouse.move(startX, targetBox.y + 4, { steps: 12 });
    await window.mouse.up();

    await expect
      .poll(() => chatsRowIds(window))
      .toEqual([
        'entry-chat-003',
        'entry-chat-001',
        'entry-chat-002',
        'entry-chat-004',
        'entry-chat-005',
      ]);
    // The drop does not open the dragged entry.
    await expect(source).not.toHaveAttribute('data-sidebar-selected-item', '');

    // Last updated order: most recent first, and rows are no longer dragged.
    // dnd-kit's pointer sensor swallows clicks for 50ms after a drop (it
    // removes its drag-time click guard on a timer), so let that lapse
    // before clicking elsewhere, as any real pointer would.
    await window.waitForTimeout(150);
    await window.getByTestId('sidebar-section-chats-toggle').hover();
    await window.getByTestId('sidebar-section-chats-more').click();
    await window.getByTestId('workspace-item-sort-last-updated').click();
    await expect
      .poll(() => chatsRowIds(window))
      .toEqual([
        'entry-chat-010',
        'entry-chat-009',
        'entry-chat-008',
        'entry-chat-007',
        'entry-chat-006',
      ]);
    const recent = entryRow(window, 'entry-chat-010');
    await expect(recent).not.toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
    await expect(recent).not.toHaveClass(/\btouch-none\b/);
    await expect(
      window.getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
      ),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
