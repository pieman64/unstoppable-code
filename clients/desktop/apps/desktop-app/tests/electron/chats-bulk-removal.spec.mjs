import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Bulk Work Entry selection and removal on the shared desktop rail, the
// follow-up to CAN-3975's worktree bulk: Chats-section rows select with the
// same gestures (the row menu's Select, Cmd/Ctrl-click, Shift-click, `x`),
// show the same tint, and end on Esc, a plain row click, or a click elsewhere.
// One rail holds one kind, so a chat selection and a worktree selection
// replace each other. Dragging a selected row carries the selection into a
// group. A selected row's right-click menu opens one confirm whose batch runs
// through the single row's deleteWorkEntry, one entry at a time: archive
// locks the retained container, delete applies the retention window.
//
// Deterministic: workspaces, worktrees, and chat transcripts are seeded on
// disk. No live agents, no network.
// ---------------------------------------------------------------------------

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const DAY_MS = 24 * 60 * 60 * 1000;
// DEFAULT_ARCHIVE_RETENTION_DAYS in @canopy/protocol/archive-retention; the
// seeded Chats project leaves its own window unset.
const DEFAULT_RETENTION_DAYS = 7;

function manifestPath(userDataDir, entryId) {
  return path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_DEFAULT_COWORK_ID,
    'archived-containers',
    entryId,
    'container.json',
  );
}

test.describe('bulk chat removal', () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp;
  let userDataDir;
  let window;

  const chatsContent = () =>
    window.getByTestId('sidebar-section-chats-content');
  const entryRow = (id) =>
    chatsContent().locator(`[data-standalone-chat-id="${id}"]`);
  const expectEntrySelected = (id, selected) =>
    selected
      ? expect(entryRow(id)).toHaveAttribute('data-multiselected', 'true')
      : expect(entryRow(id)).not.toHaveAttribute('data-multiselected');
  const worktreeFrame = (id) =>
    window
      .locator(`[data-worktree-id="${id}"]:not([data-testid$="-sticky-slot"])`)
      .first()
      .locator('xpath=ancestor-or-self::*[@data-sidebar-variant="bare"][1]');
  const worktreeRow = (id) =>
    worktreeFrame(id).locator(`[data-worktree-id="${id}"]`);
  const selectedRows = () =>
    window.locator(
      '[data-multiselected="true"]:not([data-testid$="-sticky-slot"])',
    );
  const menuItem = (id, name) =>
    window.getByTestId(`sidebar-work-entry-${id}-${name}`);
  const dialog = () => window.getByTestId('work-entry-batch-removal-dialog');
  const clickOutsideRail = async () => {
    const { width, height } = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await window.mouse.click(width - 40, height / 2);
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-chats-bulk-'));
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 2,
      chatEntryCount: 4,
    });
    ({ electronApp } = await launchCanopyWithLabsPagesOffered({
      userDataDir,
      viewportSize: { width: 1100, height: 900 },
    }));
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await expect(entryRow('entry-chat-001')).toBeVisible({ timeout: 60_000 });
    await waitForStableLocator(window, entryRow('entry-chat-001'));
  });

  test.afterAll(async () => {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  });

  test('builds and clears a selection from the row menu, modifier clicks, x, Esc, and a click elsewhere', async () => {
    await expect(selectedRows()).toHaveCount(0);

    // The row menu's Select names the shortcut; a click inside the menu
    // does not end the selection it builds.
    await entryRow('entry-chat-001').click({ button: 'right' });
    const select = menuItem('entry-chat-001', 'toggle-selection');
    await expect(select).toContainText('Select');
    await expect(select).toContainText(
      process.platform === 'darwin' ? '⌘ Click' : 'Ctrl Click',
    );
    await select.click();
    await expectEntrySelected('entry-chat-001', true);
    await expect(entryRow('entry-chat-001')).toHaveClass(/bg-accent-subtle/);

    // Cmd/Ctrl-click toggles without opening; Shift-click selects a range.
    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await expectEntrySelected('entry-chat-002', true);
    await entryRow('entry-chat-004').click({ modifiers: ['Shift'] });
    await expectEntrySelected('entry-chat-003', true);
    await expectEntrySelected('entry-chat-004', true);
    await expect(entryRow('entry-chat-002')).not.toHaveAttribute(
      'data-sidebar-selected-item',
      '',
    );

    // `x` toggles the focused row; Esc clears.
    await entryRow('entry-chat-004').focus();
    await window.keyboard.press('x');
    await expectEntrySelected('entry-chat-004', false);
    await window.keyboard.press('Escape');
    await expect(selectedRows()).toHaveCount(0);

    // Two or more selected: the row's menu is the selection's.
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-002').click({ button: 'right' });
    await expect(menuItem('entry-chat-002', 'bulk-archive')).toHaveText(
      /Archive 2 chats/,
    );
    await expect(menuItem('entry-chat-002', 'bulk-delete')).toHaveText(
      /Delete 2 chats/,
    );
    await expect(menuItem('entry-chat-002', 'rename')).toHaveCount(0);
    await menuItem('entry-chat-002', 'clear-selection').click();
    await expect(selectedRows()).toHaveCount(0);

    // A click anywhere outside the rows ends it.
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);

    // A plain click opens the entry and ends the selection.
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-003').click();
    await expect(selectedRows()).toHaveCount(0);
    await expect(entryRow('entry-chat-003')).toHaveAttribute(
      'data-sidebar-selected-item',
      '',
    );
  });

  test('a chat selection replaces a worktree selection and the reverse', async () => {
    await expect(worktreeFrame('feature-01')).toBeVisible({ timeout: 30_000 });
    await worktreeFrame('feature-01').click({ modifiers: [MODIFIER] });
    await expect(worktreeRow('feature-01')).toHaveAttribute(
      'data-multiselected',
      'true',
    );
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await expectEntrySelected('entry-chat-001', true);
    await expect(worktreeRow('feature-01')).not.toHaveAttribute(
      'data-multiselected',
    );
    await expect(selectedRows()).toHaveCount(1);

    await worktreeFrame('feature-02').click({ modifiers: [MODIFIER] });
    await expect(worktreeRow('feature-02')).toHaveAttribute(
      'data-multiselected',
      'true',
    );
    await expectEntrySelected('entry-chat-001', false);
    await expect(selectedRows()).toHaveCount(1);
    await window.keyboard.press('Escape');
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);
  });

  test('dragging a selected entry carries the selection into a group', async () => {
    await entryRow('entry-chat-001').click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click();
    const name = window.getByTestId('sidebar-item-group-name');
    await expect(name).toBeVisible();
    await name.press('Enter');
    await expect(window.getByTestId('sidebar-item-group-editor')).toHaveCount(
      0,
    );
    const group = window.locator('[data-sidebar-item-group-id]').filter({
      has: window.locator(
        '[data-sidebar-group-drag-source="item:entry-chat-001"]',
      ),
    });
    await expect(group).toHaveCount(1);

    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-003').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    const source = await entryRow('entry-chat-002').boundingBox();
    const target = await entryRow('entry-chat-001').boundingBox();
    if (!source || !target) throw new Error('Missing drag geometry');
    await window.mouse.move(source.x + 40, source.y + source.height / 2);
    await window.mouse.down();
    await window.mouse.move(source.x + 52, source.y + source.height / 2, {
      steps: 4,
    });
    const overlay = window.getByTestId('sidebar-item-group-drag-overlay');
    await expect(overlay).toBeVisible();
    await expect(
      window.locator('[data-sidebar-group-drag-source="item:entry-chat-003"]'),
    ).toHaveAttribute('data-drag-carried', 'true');
    await window.mouse.move(target.x + 40, target.y + target.height * 0.8, {
      steps: 12,
    });
    await window.mouse.up();
    await expect(overlay).toHaveCount(0);

    for (const id of ['entry-chat-002', 'entry-chat-003']) {
      await expect(
        group.locator(`[data-sidebar-group-drag-source="item:${id}"]`),
      ).toBeVisible({ timeout: 30_000 });
    }
    await expect
      .poll(async () => {
        const groups = await window.evaluate(
          (workspaceLocalId) =>
            window.api.sidebarItemGroups.list({ workspaceLocalId }),
          CHATS_SECTION_DEFAULT_COWORK_ID,
        );
        return [...(groups[0]?.memberIds ?? [])].sort();
      })
      .toEqual(['entry-chat-001', 'entry-chat-002', 'entry-chat-003']);
    // The drop keeps the selection; a click elsewhere ends it.
    await expect(selectedRows()).toHaveCount(2);
    // dnd-kit swallows clicks for 50ms after a drop.
    await window.waitForTimeout(150);
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);
  });

  test('moves, marks, and pins a selection from its menu', async () => {
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-004').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);

    // Remove from group takes the grouped row out; the other was never in.
    await entryRow('entry-chat-004').click({ button: 'right' });
    await window.getByTestId('sidebar-group-organize').hover();
    await window
      .getByTestId('sidebar-group-organize-menu')
      .getByRole('menuitem', { name: 'Remove from group', exact: true })
      .click();
    await expect
      .poll(async () => {
        const groups = await window.evaluate(
          (workspaceLocalId) =>
            window.api.sidebarItemGroups.list({ workspaceLocalId }),
          CHATS_SECTION_DEFAULT_COWORK_ID,
        );
        return [...(groups[0]?.memberIds ?? [])].sort();
      })
      .toEqual(['entry-chat-002', 'entry-chat-003']);
    await expect(selectedRows()).toHaveCount(2);

    // Mark done, then the same menu offers Mark active.
    await entryRow('entry-chat-004').click({ button: 'right' });
    await expect(menuItem('entry-chat-004', 'bulk-done')).toHaveText(
      /Mark 2 chats done/,
    );
    await menuItem('entry-chat-004', 'bulk-done').click();
    for (const id of ['entry-chat-001', 'entry-chat-004']) {
      await expect(entryRow(id)).toHaveAttribute('data-entry-status', 'done');
    }
    await expect(selectedRows()).toHaveCount(2);
    await entryRow('entry-chat-004').click({ button: 'right' });
    await expect(menuItem('entry-chat-004', 'bulk-done')).toHaveText(
      /Mark 2 chats active/,
    );
    await menuItem('entry-chat-004', 'bulk-done').click();
    for (const id of ['entry-chat-001', 'entry-chat-004']) {
      await expect(entryRow(id)).toHaveAttribute('data-entry-status', 'active');
    }

    // Pin, then the same menu offers Unpin; unpin to leave the rows as found.
    await entryRow('entry-chat-004').click({ button: 'right' });
    await expect(menuItem('entry-chat-004', 'bulk-pin')).toHaveText(
      /Pin 2 chats/,
    );
    await menuItem('entry-chat-004', 'bulk-pin').click();
    await entryRow('entry-chat-004').click({ button: 'right' });
    await expect(menuItem('entry-chat-004', 'bulk-pin')).toHaveText(
      /Unpin 2 chats/,
    );
    await menuItem('entry-chat-004', 'bulk-pin').click();
    await expect(selectedRows()).toHaveCount(2);
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);
  });

  test('a two-entry archive batch locks the retained containers', async () => {
    await entryRow('entry-chat-002').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-003').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-003').click({ button: 'right' });
    await menuItem('entry-chat-003', 'bulk-archive').click();
    await expect(dialog()).toContainText('Archive 2 chats?');
    await expect(dialog()).toContainText(
      'Archived chats are kept until you delete them.',
    );
    await dialog()
      .getByTestId('work-entry-batch-removal-dialog-confirm')
      .click();

    await expect(dialog()).toHaveCount(0, { timeout: 120_000 });
    await expect(selectedRows()).toHaveCount(0);
    for (const id of ['entry-chat-002', 'entry-chat-003']) {
      await expect(entryRow(id)).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(() => existsSync(manifestPath(userDataDir, id)), {
          timeout: 60_000,
        })
        .toBe(true);
      const manifest = JSON.parse(
        readFileSync(manifestPath(userDataDir, id), 'utf8'),
      );
      expect(typeof manifest.lockedAt).toBe('string');
    }
    await expect(entryRow('entry-chat-001')).toBeVisible();
    await expect(entryRow('entry-chat-004')).toBeVisible();
  });

  test('a two-entry delete batch applies the retention window', async () => {
    await entryRow('entry-chat-001').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-004').click({ modifiers: [MODIFIER] });
    await entryRow('entry-chat-004').click({ button: 'right' });
    await menuItem('entry-chat-004', 'bulk-delete').click();
    await expect(dialog()).toContainText('Delete 2 chats?');
    await expect(dialog()).toContainText(
      `Deleted chats are kept for ${DEFAULT_RETENTION_DAYS} days, then removed.`,
    );
    await dialog()
      .getByTestId('work-entry-batch-removal-dialog-confirm')
      .click();

    await expect(dialog()).toHaveCount(0, { timeout: 120_000 });
    for (const id of ['entry-chat-001', 'entry-chat-004']) {
      await expect(entryRow(id)).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(() => existsSync(manifestPath(userDataDir, id)), {
          timeout: 60_000,
        })
        .toBe(true);
      const manifest = JSON.parse(
        readFileSync(manifestPath(userDataDir, id), 'utf8'),
      );
      expect(manifest).not.toHaveProperty('lockedAt');
      expect(
        Date.parse(manifest.expiresAt) - Date.parse(manifest.archivedAt),
      ).toBe(DEFAULT_RETENTION_DAYS * DAY_MS);
    }
  });
});
