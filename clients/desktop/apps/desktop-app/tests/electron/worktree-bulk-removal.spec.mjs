import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  RETENTION_BULK_WORKTREE_IDS,
  RETENTION_DAYS,
  RETENTION_WORKSPACE_ID,
  seedWorktreeRetentionFixture,
} from './portal/worktreeRetentionFixture.mjs';

// ---------------------------------------------------------------------------
// Bulk worktree selection and removal (CAN-3975) on the shared desktop rail:
// the row menu's Select, Cmd/Ctrl-click, Shift-click, and `x` build a
// selection, shown as a highlight with no checkbox; Esc, the menu's Clear
// selection, a plain click on a row, and a click anywhere else end it.
// Dragging a selected row carries the whole selection into a group. A
// selected row's right-click menu opens one confirm, which closes at once:
// the batch runs in the background through the real archive path, one
// worktree at a time, with queued rows inert and a rail notice that shows
// progress and can stop what has not started. Archive keeps the branch
// (Preserve local) and locks the retained container; Delete applies the
// project's retention window and removes the local branch (Delete local).
//
// The worktrees are real disposable checkouts from the Portal retention
// fixture, so no provider or GitHub responses are needed.
// ---------------------------------------------------------------------------

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const DAY_MS = 24 * 60 * 60 * 1000;

function workspacePath(userDataDir, ...segments) {
  return path.join(
    userDataDir,
    'workspaces',
    RETENTION_WORKSPACE_ID,
    ...segments,
  );
}

function manifestPath(userDataDir, id) {
  return workspacePath(
    userDataDir,
    'archived-containers',
    id,
    'container.json',
  );
}

// Seeded worktrees' timestamps are fixed; without auto-delete, none is
// removed as inactive while the flow runs.
function disableAutoDelete(userDataDir) {
  const workspaceJson = workspacePath(userDataDir, 'workspace.json');
  const workspace = JSON.parse(readFileSync(workspaceJson, 'utf8'));
  delete workspace.autoArchiveDays;
  writeFileSync(workspaceJson, JSON.stringify(workspace, null, 2));
}

// The repository every checkout shares, so branches can be read after any
// one checkout is gone.
function gitCommonDir(userDataDir) {
  const main = workspacePath(userDataDir, 'worktrees', 'demo-main');
  return path.resolve(
    main,
    execFileSync('git', ['-C', main, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim(),
  );
}

function localBranches(gitDir) {
  return execFileSync(
    'git',
    ['--git-dir', gitDir, 'branch', '--format=%(refname:short)'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

test.describe('bulk worktree removal (CAN-3975)', () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp;
  let userDataDir;
  let gitDir;
  let window;

  // The row's own frame: it carries the row's clicks and keyboard handling.
  const rowFrame = (id) =>
    window
      .locator(`[data-worktree-id="${id}"]:not([data-testid$="-sticky-slot"])`)
      .first()
      .locator('xpath=ancestor-or-self::*[@data-sidebar-variant="bare"][1]');
  const rowElement = (id) => rowFrame(id).locator(`[data-worktree-id="${id}"]`);
  const expectSelected = (id, selected) =>
    selected
      ? expect(rowElement(id)).toHaveAttribute('data-multiselected', 'true')
      : expect(rowElement(id)).not.toHaveAttribute('data-multiselected');
  const selectedRows = () =>
    window.locator(
      '[data-multiselected="true"]:not([data-testid$="-sticky-slot"])',
    );
  const dialog = () => window.getByTestId('worktree-batch-removal-dialog');
  const menuItem = (name) =>
    window.getByTestId(`portal-worktree-actions-${name}`);
  // A selected row's right-click menu is the selection's.
  const bulkAction = async (id, action) => {
    await rowFrame(id).click({ button: 'right' });
    await menuItem(`bulk-${action}`).click();
  };
  const notice = () => window.getByTestId('worktree-batch-removal-notice');
  const [bulkOne, bulkTwo] = RETENTION_BULK_WORKTREE_IDS;
  // A click in the main content, away from the rail and its menus.
  const clickOutsideRail = async () => {
    const { width, height } = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await window.mouse.click(width - 40, height / 2);
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-bulk-removal-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeRetentionFixture(userDataDir);
    disableAutoDelete(userDataDir);
    gitDir = gitCommonDir(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(rowFrame('retain-archive')).toBeVisible({ timeout: 60_000 });
  });

  test.afterAll(async () => {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  });

  test('builds and clears a selection from the row menu, modifier clicks, x, Esc, and clicks elsewhere', async () => {
    await expect(selectedRows()).toHaveCount(0);
    // No checkbox and no bulk bar: rows keep their original inset and
    // select by highlight.
    await expect(window.locator('[role="checkbox"]')).toHaveCount(0);

    // The row menu's Select is the path that needs no shortcut, and it names
    // the shortcut so people can learn it.
    await rowFrame('retain-archive').click({ button: 'right' });
    const select = menuItem('toggle-selection');
    await expect(select).toContainText('Select');
    await expect(select.getByTestId('worktree-menu-item-shortcut')).toHaveText(
      process.platform === 'darwin' ? '⌘ Click' : 'Ctrl Click',
    );
    await select.click();
    await expectSelected('retain-archive', true);
    await expect(selectedRows()).toHaveCount(1);
    // A selected row is tinted apart from the open row's neutral highlight.
    await expect(rowElement('retain-archive')).toHaveClass(/bg-accent-subtle/);
    await expect(window.getByTestId('worktree-selection-bar')).toHaveCount(0);

    // Cmd/Ctrl-click toggles without navigating; Shift-click selects a range.
    await rowFrame('retain-delete').click({ modifiers: [MODIFIER] });
    await expectSelected('retain-delete', true);
    await rowFrame('retain-hover').click({ modifiers: ['Shift'] });
    await expectSelected('retain-hover', true);

    // `x` toggles the focused row; Esc on a row clears the selection.
    await rowFrame('retain-hover').focus();
    await window.keyboard.press('x');
    await expectSelected('retain-hover', false);
    await window.keyboard.press('Escape');
    await expect(selectedRows()).toHaveCount(0);

    // A selection of two or more puts its actions in its rows' menu,
    // Clear selection among them.
    await rowFrame('retain-archive').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-delete').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-delete').click({ button: 'right' });
    await expect(menuItem('bulk-archive')).toHaveText(/Archive 2 worktrees/);
    await expect(menuItem('bulk-delete')).toHaveText(/Delete 2 worktrees/);
    await menuItem('clear-selection').click();
    await expect(selectedRows()).toHaveCount(0);

    // A click anywhere outside the rows ends it: here, the main content.
    await rowFrame('retain-archive').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-delete').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);

    // A plain click opens a worktree and leaves bulk mode.
    await rowFrame('retain-archive').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-delete').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    // The main checkout, so no row the later tests drive is left open.
    await rowFrame('demo-main').click();
    await expect(selectedRows()).toHaveCount(0);
  });

  test('drags a selection into a group together', async () => {
    // A group to drop into, made from a row outside the selection.
    await rowFrame('retain-delete').click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click();
    const editor = window.getByTestId('sidebar-item-group-editor');
    await expect(editor).toBeVisible();
    await editor.getByTestId('sidebar-item-group-editor-close').click();
    const group = window.locator('[data-sidebar-item-group-id]').filter({
      has: window.locator(
        '[data-sidebar-group-drag-source="item:retain-delete"]',
      ),
    });
    await expect(group).toHaveCount(1);

    await rowFrame('retain-archive').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-hover').click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    const source = await window
      .locator(
        '[data-sidebar-group-drag-source="item:retain-archive"] [data-testid="worktree-row"]',
      )
      .boundingBox();
    const target = await window
      .locator(
        '[data-sidebar-group-drag-source="item:retain-delete"] [data-testid="worktree-row"]',
      )
      .boundingBox();
    if (!source || !target) throw new Error('Missing drag geometry');
    await window.mouse.move(source.x + 24, source.y + source.height / 2);
    await window.mouse.down();
    await window.mouse.move(source.x + 36, source.y + source.height / 2, {
      steps: 4,
    });
    const overlay = window.getByTestId('sidebar-item-group-drag-overlay');
    await expect(overlay).toBeVisible();
    // The preview carries both rows; the other selected row dims in place.
    await expect(overlay).toContainText('retain-hover');
    await expect(
      window.locator('[data-sidebar-group-drag-source="item:retain-hover"]'),
    ).toHaveAttribute('data-drag-carried', 'true');
    await window.mouse.move(target.x + 24, target.y + target.height * 0.8, {
      steps: 12,
    });
    await window.mouse.up();
    await expect(overlay).toHaveCount(0);

    for (const id of ['retain-archive', 'retain-hover']) {
      await expect(
        group.locator(`[data-sidebar-group-drag-source="item:${id}"]`),
      ).toBeVisible({ timeout: 30_000 });
    }
    // The drop keeps the selection for what comes next.
    await expect(selectedRows()).toHaveCount(2);
    await clickOutsideRail();
    await expect(selectedRows()).toHaveCount(0);
  });

  test('pins, unpins, and hides a selection from its menu', async () => {
    await rowFrame(bulkOne).click({ modifiers: [MODIFIER] });
    await rowFrame(bulkTwo).click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);

    await rowFrame(bulkTwo).click({ button: 'right' });
    await expect(menuItem('bulk-pin')).toHaveText(/Pin 2 worktrees/);
    await menuItem('bulk-pin').click();
    await expect(selectedRows()).toHaveCount(2);
    await rowFrame(bulkTwo).click({ button: 'right' });
    await expect(menuItem('bulk-pin')).toHaveText(/Unpin 2 worktrees/);
    await menuItem('bulk-pin').click();
    await expect(selectedRows()).toHaveCount(2);

    // Hide both: they leave the list and the selection for the Hidden section.
    await rowFrame(bulkTwo).click({ button: 'right' });
    await expect(menuItem('bulk-hide')).toHaveText(/Hide 2 worktrees/);
    await menuItem('bulk-hide').click();
    await expect(selectedRows()).toHaveCount(0);
    const hiddenSection = window.getByTestId('hidden-worktrees-section');
    await expect(hiddenSection).toBeVisible();

    // Show them again so the removal flows below find them. Pinning and
    // showing reorder rows, so this uses the rows whose later removals don't
    // depend on order.
    await window
      .getByTestId(`hidden-worktrees-toggle-${RETENTION_WORKSPACE_ID}`)
      .click();
    for (const id of [bulkOne, bulkTwo]) {
      await rowFrame(id).hover();
      await rowFrame(id).getByTestId('worktree-show-button').click();
    }
    await expect(hiddenSection).toHaveCount(0);
    await expect(rowFrame(bulkOne)).toBeVisible();
    await expect(rowFrame(bulkTwo)).toBeVisible();
  });

  test('confirm closes the dialog and the user keeps working while the batch runs', async () => {
    await window.evaluate(() =>
      window.__canopyArchivedContainersTestApi?.holdNextPendingRemoval(),
    );
    await rowFrame('retain-archive').click({ modifiers: [MODIFIER] });
    await rowFrame('retain-hover').click({ modifiers: [MODIFIER] });
    await bulkAction('retain-hover', 'archive');
    await dialog()
      .getByTestId('worktree-batch-removal-dialog-preserve-branch')
      .click();
    // The dialog is gone at once; the selection is cleared.
    await expect(dialog()).toHaveCount(0);
    await expect(selectedRows()).toHaveCount(0);
    await window.evaluate(() =>
      window.__canopyArchivedContainersTestApi?.waitForHeldPendingRemoval(),
    );
    await expect(notice()).toContainText('Archiving worktrees');
    await expect(notice()).toContainText('0 of 2 done');
    // Pinned with the rail's footer, not scrolled away with the rows.
    await expect(
      window
        .getByTestId('sidebar-scroll-container')
        .getByTestId('worktree-batch-removal-notice'),
    ).toHaveCount(0);
    await expect(notice()).toBeInViewport({ ratio: 1 });
    // Queued rows are inert; the rest of the rail still works.
    await expect(rowFrame('retain-archive')).toHaveAttribute('inert', '');
    await expect(rowFrame('retain-hover')).toHaveAttribute('inert', '');
    // The row still waiting names its removal; the one in flight does not.
    await expect(rowFrame('retain-hover')).toContainText(
      'Queued for archiving',
    );
    await expect(rowFrame('retain-archive')).not.toContainText('Queued');
    await rowFrame('retain-delete').click();
    // The row frame marks the open worktree with data-selected.
    await expect(rowFrame('retain-delete')).toHaveAttribute(
      'data-selected',
      'true',
    );
    // Stop after the in-flight one, then let it finish.
    await notice().getByTestId('worktree-batch-removal-notice-stop').click();
    await expect(notice()).toContainText('Stopping…');
    await window.evaluate(() =>
      window.__canopyArchivedContainersTestApi?.releaseHeldPendingRemoval(),
    );
    await expect(rowFrame('retain-archive')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(notice()).toContainText('Archived 1 of 2 worktrees', {
      timeout: 60_000,
    });
    await expect(notice()).toContainText('1 not started');
    await expect(rowFrame('retain-hover')).toBeVisible();
    await expect(rowFrame('retain-hover')).not.toHaveAttribute('inert');
    await expect(rowFrame('retain-hover')).not.toContainText('Queued');
    // Details shows the dropped row as not started; Done clears the notice.
    await notice().getByTestId('worktree-batch-removal-notice-details').click();
    await expect(dialog().locator('[data-phase="results"]')).toBeVisible();
    await expect(dialog()).toContainText('1 archived, 1 not started');
    await dialog().getByTestId('worktree-batch-removal-dialog-done').click();
    await expect(dialog()).toHaveCount(0);
    await expect(notice()).toHaveCount(0);
    // The archive itself completed like a single Preserve local archive.
    await expect
      .poll(() => existsSync(manifestPath(userDataDir, 'retain-archive')), {
        timeout: 60_000,
      })
      .toBe(true);
    // The main checkout, so no row the later tests drive is left open.
    await rowFrame('demo-main').click();
  });

  test('archives a batch with Preserve local, keeping each branch', async () => {
    await rowFrame('retain-hover').click({ modifiers: [MODIFIER] });
    await rowFrame(bulkTwo).click({ modifiers: [MODIFIER] });
    await expect(selectedRows()).toHaveCount(2);
    await bulkAction('retain-hover', 'archive');
    await expect(dialog()).toContainText('Archive 2 worktrees?');
    await expect(dialog()).toContainText('Kept until you delete the archive.');
    await dialog()
      .getByTestId('worktree-batch-removal-dialog-preserve-branch')
      .click();

    // The confirm closes the dialog and clears the selection; full success
    // leaves no notice behind once the batch is done.
    await expect(dialog()).toHaveCount(0, { timeout: 120_000 });
    await expect(selectedRows()).toHaveCount(0);
    await expect(notice()).toHaveCount(0, { timeout: 120_000 });
    for (const id of ['retain-hover', bulkTwo]) {
      await expect(rowFrame(id)).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(() => existsSync(workspacePath(userDataDir, 'worktrees', id)), {
          timeout: 60_000,
        })
        .toBe(false);
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
    expect(localBranches(gitDir)).toEqual(
      expect.arrayContaining(['retain-hover', bulkTwo]),
    );
    // The untouched worktree stays.
    await expect(rowFrame('retain-delete')).toBeVisible();
  });

  test("deletes with the project's retention window and Delete local", async () => {
    await rowFrame('retain-delete').click({ modifiers: [MODIFIER] });
    await rowFrame(bulkOne).click({ modifiers: [MODIFIER] });
    await bulkAction('retain-delete', 'delete');
    await expect(dialog()).toContainText('Delete 2 worktrees?');
    await expect(dialog()).toContainText(
      `Restorable for ${RETENTION_DAYS} days`,
    );
    await dialog()
      .getByTestId('worktree-batch-removal-dialog-delete-branch')
      .click();

    await expect(dialog()).toHaveCount(0, { timeout: 120_000 });
    await expect(notice()).toHaveCount(0, { timeout: 120_000 });
    for (const id of ['retain-delete', bulkOne]) {
      await expect(rowFrame(id)).toHaveCount(0, { timeout: 60_000 });
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
      ).toBe(RETENTION_DAYS * DAY_MS);
      await expect
        .poll(() => localBranches(gitDir), { timeout: 60_000 })
        .not.toContain(id);
    }
  });
});
