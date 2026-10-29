/**
 * "Archived and deleted" overview coverage (archive / deletion UX rework):
 *
 * - the left-nav "Archived and deleted" link, with its count as a separate
 *   trailing number, replaces the in-sidebar archived list and opens a
 *   full-page overview scoped to the workspace (the left nav stays visible);
 * - CAN-3549: that link sits on the task rows' grid, its icon and label
 *   starting at the same x-offsets as a task row's icon and title;
 * - the overview lists Deleted (unlocked) and Archived (locked) items with a
 *   left-aligned outlined state icon, rich tooltip, measured disk usage, and
 *   search;
 * - rows open the per-item viewer, whose Back returns to the overview and
 *   whose header shows the state chip, removal date, and disk usage;
 * - Empty trash previews exactly the Deleted items, their count, and a lower
 *   bound for reclaimable disk space, then removes only those items;
 * - the live worktree row's quick-access chip is Delete (trash), and the
 *   actions menu offers both Delete and Archive;
 * - a confirmed removal shows up in the overview (and in the nav-link count)
 *   immediately as a pending placeholder while main captures it, and the
 *   filter next to the search box narrows the list to Archived or Deleted;
 * - CAN-3054: with the sidebar collapsed the overview header clears the
 *   persistent titlebar corner instead of rendering underneath it.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
}

function chatTab(id, title, bodyBytes = 200) {
  return {
    id,
    title,
    kind: 'chat',
    providerType: 'claude',
    createdAt: NOW,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text: 'x'.repeat(bodyBytes) }],
        timestamp: Date.parse(NOW),
      },
    ],
  };
}

/**
 * Seed a version-1 worktree container. `locked` seeds an "Archived" item
 * (kept until deleted); otherwise it is a "Deleted" item that the sweep
 * would remove at `expiresAt`. No `diskUsage` is written so the app's
 * background measurement has to fill it in.
 */
function seedArchivedContainer({
  workspaceRoot,
  projectId,
  containerId,
  name,
  locked = false,
  bodyBytes = 200,
}) {
  const containerDir = path.join(
    workspaceRoot,
    'archived-containers',
    containerId,
  );
  const tab = chatTab(`${containerId}-chat`, `${name} chat`, bodyBytes);
  writeJson(path.join(containerDir, 'chats.json'), {
    version: 1,
    activeTabId: tab.id,
    tabs: [tab],
  });
  writeJson(path.join(containerDir, 'chat-archives.json'), {
    version: 1,
    archived: [],
  });
  writeJson(path.join(containerDir, 'container.json'), {
    version: 1,
    id: containerId,
    kind: 'worktree',
    projectId,
    name,
    createdAt: NOW,
    archivedAt: NOW,
    retentionDays: 7,
    expiresAt: EXPIRES,
    ...(locked ? { lockedAt: NOW } : {}),
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    branchName: name,
    workspaceType: 'single-repo',
  });
  return containerDir;
}

const SIZE_PATTERN = /^\d+(\.\d+)? (B|KB|MB|GB)$/;

/**
 * Where a sidebar row's two columns start, measured in the page: the
 * horizontal centre of its leading glyph column and the left edge of its
 * first rendered text. A task row marks that column with a leading-slot test
 * id; the "Archived and deleted" link is measured by the glyph it draws there.
 */
function measureSidebarRowGrid(element) {
  const slot = element.querySelector(
    '[data-testid^="worktree-row-leading-slot"]',
  );
  const glyph = slot ?? element.querySelector('svg');
  const glyphBox = glyph?.getBoundingClientRect();
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );
  let textLeft = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.trim().length === 0 || slot?.contains(node)) continue;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0) continue;
    textLeft = box.left;
    break;
  }
  return {
    iconCenter: glyphBox ? glyphBox.left + glyphBox.width / 2 : null,
    textLeft,
  };
}

test.describe('archived and deleted overview', () => {
  test('lists Deleted and Archived items with sizes, searches, empties the trash, and round-trips the viewer', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-overview-'),
    );
    seedPreferences(userDataDir);
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = seeded.workspaces[0];
    expect(workspace, 'seeded demo project').toBeTruthy();
    const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'trashed-one',
      name: 'feature/trashed-one',
      bodyBytes: 4_000,
    });
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'trashed-two',
      name: 'feature/trashed-two',
      bodyBytes: 2_000,
    });
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'kept-one',
      name: 'feature/kept-one',
      locked: true,
      bodyBytes: 1_000,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      // --- Live row: the quick-access chip is Delete; the menu has both ----
      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="demo-main"]`,
      );
      await expect(row).toBeVisible();
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      const menu = window.getByTestId('worktree-actions-menu');
      await expect(menu).toBeVisible();
      const deleteItem = window.getByTestId('worktree-actions-menu-delete');
      const archiveItem = window.getByTestId('worktree-actions-menu-archive');
      await expect(deleteItem).toHaveText('Delete');
      // Recoverable removal reads neutral, like Archive.
      await expect(deleteItem).not.toHaveClass(/fg-destructive/);
      await expect(deleteItem).toHaveAttribute(
        'title',
        'Kept for 7 days, then removed',
      );
      await expect(archiveItem).toHaveText('Archive');
      await expect(archiveItem).toHaveAttribute(
        'title',
        'Kept until you delete it',
      );
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const chip = row.getByTestId('worktree-archive-button');
      await expect(chip).toHaveAttribute('aria-label', /^Delete /, {
        timeout: 15_000,
      });

      // --- Sidebar link → overview page (left nav stays visible) ----------
      const link = window.getByTestId(
        `sidebar-project-${workspace.id}-archived-link`,
      );
      await expect(link).toHaveText('Archived and deleted 3', {
        timeout: 15_000,
      });
      // CAN-3549: the count is its own element, not part of the title.
      await expect(
        link.getByTestId(`sidebar-project-${workspace.id}-archived-link-count`),
      ).toHaveText('3');
      // CAN-3549: the link shares the task rows' grid. jsdom cannot lay out,
      // so this is the only place the alignment itself is checked.
      const taskGrid = await row.evaluate(measureSidebarRowGrid);
      const linkGrid = await link.evaluate(measureSidebarRowGrid);
      expect(taskGrid.iconCenter, 'task row icon column').not.toBeNull();
      expect(taskGrid.textLeft, 'task row title').not.toBeNull();
      expect(
        Math.abs(linkGrid.iconCenter - taskGrid.iconCenter),
        `link icon centre ${linkGrid.iconCenter} vs task icon centre ${taskGrid.iconCenter}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(linkGrid.textLeft - taskGrid.textLeft),
        `link label left ${linkGrid.textLeft} vs task title left ${taskGrid.textLeft}`,
      ).toBeLessThanOrEqual(0.5);
      await expect(link).toHaveAttribute('data-selected', 'false');
      await link.click();
      const page = window.getByTestId('archived-overview-page');
      await expect(page).toBeVisible();
      await expect(page).toHaveAttribute('data-workspace-id', workspace.id);
      await expect(link).toHaveAttribute('data-selected', 'true');
      await expect(window.getByTestId('app-sidebar')).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-workspace-name'),
      ).toHaveText(/\S/);
      await expect(window.getByTestId('archived-overview-count')).toHaveText(
        '3 items',
      );
      const header = page.locator(':scope > div').first();
      const searchSeparator = window
        .getByTestId('archived-overview-search')
        .locator('..');
      await expect
        .poll(() =>
          header.evaluate((node) => getComputedStyle(node).borderBottomStyle),
        )
        .toBe('solid');
      await expect
        .poll(() =>
          searchSeparator.evaluate(
            (node) => getComputedStyle(node).borderBottomStyle,
          ),
        )
        .toBe('solid');

      // --- Rows: state icon + tooltip, size once measured -----------------
      const deletedState = window.getByTestId(
        'archived-overview-state-trashed-one',
      );
      const archivedState = window.getByTestId(
        'archived-overview-state-kept-one',
      );
      await expect(deletedState).toHaveAttribute('data-state', 'deleted');
      await expect(deletedState).toHaveAttribute('aria-label', 'Deleted');
      await expect(archivedState).toHaveAttribute('data-state', 'archived');
      await expect(archivedState).toHaveAttribute('aria-label', 'Archived');
      await expect(deletedState.locator('svg')).toHaveClass(/fg-destructive/);
      await expect(archivedState.locator('svg')).toHaveClass(/fg-secondary/);
      await deletedState.hover();
      const deletedTooltip = window.getByTestId(
        'archived-overview-state-tooltip-trashed-one',
      );
      await expect(deletedTooltip).toBeVisible();
      await expect(deletedTooltip).toContainText('Deleted');
      await expect(deletedTooltip).toContainText('Removed on');
      await archivedState.hover();
      const archivedTooltip = window.getByTestId(
        'archived-overview-state-tooltip-kept-one',
      );
      await expect(archivedTooltip).toBeVisible();
      await expect(archivedTooltip).toContainText('Kept until you delete it');

      // Seeded manifests carry no diskUsage: the background measurement
      // fills the sizes in after the first list.
      const deletedSize = window.getByTestId(
        'archived-overview-size-trashed-one',
      );
      const archivedSize = window.getByTestId(
        'archived-overview-size-kept-one',
      );
      await expect(deletedSize).toHaveText(SIZE_PATTERN, { timeout: 30_000 });
      await expect(archivedSize).toHaveText(SIZE_PATTERN, { timeout: 30_000 });
      await expect(deletedSize).not.toHaveText('0 B');
      const measuredManifest = JSON.parse(
        readFileSync(
          path.join(
            workspaceRoot,
            'archived-containers',
            'trashed-one',
            'container.json',
          ),
          'utf8',
        ),
      );
      expect(measuredManifest.diskUsage.totalBytes).toBeGreaterThan(4_000);
      expect(measuredManifest.diskUsage.gitBytes).toBe(0);
      expect(measuredManifest.diskUsage.gitBytesComplete).toBe(true);

      // --- Search ----------------------------------------------------------
      const search = window.getByTestId('archived-overview-search');
      await search.fill('kept');
      await expect(
        window.getByTestId('archived-overview-row-kept-one'),
      ).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-row-trashed-one'),
      ).toHaveCount(0);
      await search.fill('nothing-matches');
      await expect(
        window.getByTestId('archived-overview-no-matches'),
      ).toBeVisible();
      await search.fill('');

      // --- Viewer round trip: Back lands on the overview ------------------
      await window.getByTestId('archived-overview-open-kept-one').click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await expect(page).toHaveCount(0);
      const stateBadge = viewer.getByTestId('archived-state-badge');
      await expect(stateBadge).toHaveAttribute('data-state', 'archived');
      await expect(stateBadge).toContainText('Archived');
      await expect(stateBadge).toHaveClass(/ring-sky-500\/30/);
      await expect(stateBadge).not.toHaveClass(/border-sky/);
      await expect(viewer.getByTestId('archived-disk-usage')).toContainText(
        'on disk',
      );
      await expect(viewer.getByTestId('archived-state-toggle')).toHaveText(
        'Delete',
      );
      await expect(viewer).not.toContainText('Lock');
      await viewer.getByTestId('archived-container-view-close').click();
      await expect(viewer).toHaveCount(0);
      await expect(page).toBeVisible();

      // --- Empty trash: preview only the Deleted items ----------------------
      const emptyTrash = window.getByTestId('archived-overview-empty-trash');
      const emptyTrashGroup = window.getByTestId(
        'archived-overview-empty-trash-group',
      );
      await expect(emptyTrash).toBeEnabled();
      await emptyTrash.click();
      const dialog = window.getByTestId('archived-overview-empty-trash-dialog');
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText('feature/trashed-one', { exact: true }),
      ).toHaveClass(/ph-mask/);
      await expect
        .poll(() =>
          dialog
            .getByTestId('archived-overview-empty-trash-list')
            .evaluate((node) => getComputedStyle(node).boxShadow),
        )
        .not.toBe('none');
      await expect(dialog).toContainText('2 deleted items');
      await expect(
        dialog.getByTestId('archived-overview-empty-trash-item-trashed-one'),
      ).toBeVisible();
      await expect(
        dialog
          .getByTestId('archived-overview-empty-trash-item-trashed-one')
          .locator('svg'),
      ).toHaveClass(/fg-destructive/);
      await expect(
        dialog.getByTestId('archived-overview-empty-trash-item-trashed-two'),
      ).toBeVisible();
      await expect(
        dialog.getByTestId('archived-overview-empty-trash-item-kept-one'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('archived-overview-size-trashed-two'),
      ).toHaveText(SIZE_PATTERN, { timeout: 30_000 });
      await expect(
        dialog.getByTestId('archived-overview-empty-trash-summary'),
      ).toContainText(/Frees at least \d+(\.\d+)? (B|KB|MB)/);
      const confirm = dialog.getByTestId(
        'archived-overview-empty-trash-confirm',
      );
      await expect(confirm).toHaveText('Delete 2 items permanently');

      // --- Confirm closes the preview at once; the button becomes the
      // cancel control; cancel is honored only between items -----------------
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.holdNextEmptyTrashBetweenItems(),
      );
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.waitForHeldEmptyTrash(),
      );
      // First item done, run paused right at the between-items checkpoint.
      await expect(emptyTrashGroup).toHaveAttribute('data-running', 'true');
      await expect(emptyTrash).toBeEnabled();
      await expect(emptyTrash).toHaveAttribute(
        'aria-label',
        'Cancel Empty trash',
      );
      await expect(emptyTrash).toContainText('Empty trash');
      await expect(
        window.getByTestId('archived-overview-empty-trash-progress'),
      ).toHaveText('2 of 2');
      await emptyTrash.hover();
      await expect(
        emptyTrashGroup.getByTestId('pr-status-bar-cancel-git-action'),
      ).toBeVisible();
      // Clicking the running button cancels; the ✕ withdraws while the
      // cancel is pending and nothing else can be clicked.
      await emptyTrash.click();
      await expect(emptyTrashGroup).toHaveAttribute(
        'data-cancel-requested',
        'true',
      );
      await expect(emptyTrash).toBeDisabled();
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.releaseHeldEmptyTrash(),
      );
      await expect(emptyTrashGroup).toHaveAttribute('data-running', 'false', {
        timeout: 15_000,
      });
      // The item that was in flight is gone; the next one never started.
      await expect(
        window.getByTestId('archived-overview-row-trashed-one'),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        window.getByTestId('archived-overview-row-trashed-two'),
      ).toBeVisible();
      await expect(window.getByTestId('archived-overview-count')).toHaveText(
        '2 items',
      );
      await expect(emptyTrash).toBeEnabled();

      // --- Run it again to completion --------------------------------------
      // Hold a pre-deletion archive-summary read after main has returned it.
      // Empty trash must wait for that stale request and then issue a strict
      // trailing read before publishing its final result.
      await window.evaluate((workspaceId) => {
        window.__canopyArchivedContainersTestApi.holdNextLoadAfterRead();
        window.__canopyArchivedContainersTestApi.loadForWorkspace(workspaceId);
      }, workspace.id);
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.waitForHeldLoad(),
      );
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.disableChangedRefresh(),
      );
      const staleReadCount = await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.getListReadCount(),
      );
      const trailingLoadRequestCount = await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
      );

      await emptyTrash.click();
      await dialog.getByTestId('archived-overview-empty-trash-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
            ),
          { timeout: 15_000 },
        )
        .toBe(trailingLoadRequestCount + 1);
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.releaseHeldLoad(),
      );
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              window.__canopyArchivedContainersTestApi.getListReadCount(),
            ),
          { timeout: 15_000 },
        )
        .toBe(staleReadCount + 1);
      await expect(
        window.getByTestId('archived-overview-row-trashed-two'),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        window.getByTestId('archived-overview-row-kept-one'),
      ).toBeVisible();
      await expect(window.getByTestId('archived-overview-count')).toHaveText(
        '1 item',
      );
      await expect(emptyTrashGroup).toHaveAttribute('data-running', 'false');
      await expect(emptyTrash).toBeDisabled();
      await expect(link).toHaveText('Archived and deleted 1', {
        timeout: 15_000,
      });

      // --- Overview Back returns to the live surface ----------------------
      await window.getByTestId('archived-overview-back').click();
      await expect(page).toHaveCount(0);
      await expect(link).toHaveAttribute('data-selected', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps an item that becomes Archived while Empty trash is running', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-overview-race-'),
    );
    seedPreferences(userDataDir);
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = seeded.workspaces[0];
    expect(workspace, 'seeded demo project').toBeTruthy();
    const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'race-first',
      name: 'feature/race-first',
    });
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'race-second',
      name: 'feature/race-second',
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await window
        .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
        .click();
      const emptyTrash = window.getByTestId('archived-overview-empty-trash');
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.holdNextEmptyTrashBetweenItems(),
      );
      await emptyTrash.click();
      await window.getByTestId('archived-overview-empty-trash-confirm').click();
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.waitForHeldEmptyTrash(),
      );

      await window.evaluate(
        ({ projectId }) =>
          window.api.archivedContainers.setLocked({
            projectId,
            containerId: 'race-second',
            locked: true,
          }),
        { projectId: workspace.id },
      );
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.releaseHeldEmptyTrash(),
      );

      const secondRow = window.getByTestId('archived-overview-row-race-second');
      await expect(secondRow).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByTestId('archived-overview-state-race-second'),
      ).toHaveAttribute('data-state', 'archived');
      await expect(
        window.getByText('1 item became Archived and was kept.'),
      ).toBeVisible();
      await expect(emptyTrash).toBeDisabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('shows a removal instantly as a pending row, counts it, and filters by state', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-overview-pending-'),
    );
    seedPreferences(userDataDir);
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = seeded.workspaces[0];
    expect(workspace, 'seeded demo project').toBeTruthy();
    const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'trashed-one',
      name: 'feature/trashed-one',
    });
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'kept-one',
      name: 'feature/kept-one',
      locked: true,
    });
    const worktreesFile = JSON.parse(
      readFileSync(path.join(workspaceRoot, 'worktrees.json'), 'utf8'),
    );
    const liveWorktree =
      worktreesFile.worktrees.find(
        (entry) => entry.branchName === 'demo-main',
      ) ?? worktreesFile.worktrees[0];
    expect(liveWorktree, 'seeded live worktree').toBeTruthy();
    // An uncommitted change routes Delete through the confirmation dialog
    // deterministically (a clean worktree may bypass it once stats load).
    writeFileSync(
      path.join(workspace.worktreePath, 'pending-placeholder.txt'),
      'uncommitted change to force the delete confirmation dialog\n',
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const link = window.getByTestId(
        `sidebar-project-${workspace.id}-archived-link`,
      );
      await expect(link).toHaveText('Archived and deleted 2', {
        timeout: 15_000,
      });

      // Hold the removal right after its placeholder is registered so the
      // instant feedback can be observed before main captures anything.
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.holdNextPendingRemoval(),
      );
      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="demo-main"]`,
      );
      await expect(row).toBeVisible();
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-delete').click();
      const deleteDialog = window.getByRole('dialog', {
        name: 'Delete worktree?',
      });
      await expect(deleteDialog).toBeVisible();
      // The confirm control is a split button: pick the branch handling.
      await deleteDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.waitForHeldPendingRemoval(),
      );

      // --- Instant: the count and the placeholder row ----------------------
      await expect(link).toHaveText('Archived and deleted 3', {
        timeout: 5_000,
      });
      await link.click();
      const page = window.getByTestId('archived-overview-page');
      await expect(page).toBeVisible();
      await expect(window.getByTestId('archived-overview-count')).toHaveText(
        '3 items',
      );
      const pendingRow = window.getByTestId(
        `archived-overview-pending-${liveWorktree.id}`,
      );
      await expect(pendingRow).toBeVisible();
      await expect(pendingRow).toHaveAttribute('data-state', 'deleted');
      await expect(pendingRow).toContainText('Deleting…');
      // The placeholder carries the row's display name (label over branch).
      await expect(pendingRow).toContainText('New Task');
      // Placeholders lead the list and have nothing to open yet.
      await expect(
        window.getByTestId('archived-overview-list').locator('> *').first(),
      ).toHaveAttribute(
        'data-testid',
        `archived-overview-pending-${liveWorktree.id}`,
      );
      await expect(
        window.getByTestId(`archived-overview-open-${liveWorktree.id}`),
      ).toHaveCount(0);

      // --- Release: the real row replaces the placeholder, count holds ----
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.releaseHeldPendingRemoval(),
      );
      const realRow = window.getByTestId(
        `archived-overview-row-${liveWorktree.id}`,
      );
      await expect(realRow).toBeVisible({ timeout: 60_000 });
      await expect(pendingRow).toHaveCount(0);
      await expect(
        window.getByTestId(`archived-overview-state-${liveWorktree.id}`),
      ).toHaveAttribute('data-state', 'deleted');
      await expect(window.getByTestId('archived-overview-count')).toHaveText(
        '3 items',
      );
      await expect(link).toHaveText('Archived and deleted 3');

      // --- Filter: Archived / Deleted next to the search box ---------------
      const filterTrigger = window.getByTestId(
        'archived-overview-filter-trigger',
      );
      await expect(filterTrigger).toHaveAttribute('data-active', 'false');
      await filterTrigger.click();
      const filterMenu = window.getByTestId(
        'archived-overview-filter-dropdown',
      );
      await expect(filterMenu).toBeVisible();
      const deletedOption = window.getByTestId(
        'archived-overview-filter-option-deleted',
      );
      const archivedOption = window.getByTestId(
        'archived-overview-filter-option-archived',
      );
      await expect(deletedOption).toHaveAttribute('aria-checked', 'true');
      await expect(archivedOption).toHaveAttribute('aria-checked', 'true');

      await deletedOption.click();
      // The menu stays open for multi-select and the trigger shows activity.
      await expect(filterMenu).toBeVisible();
      await expect(deletedOption).toHaveAttribute('aria-checked', 'false');
      await expect(filterTrigger).toHaveAttribute('data-active', 'true');
      await expect(
        window.getByTestId('archived-overview-filter-active-dot'),
      ).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-row-trashed-one'),
      ).toHaveCount(0);
      await expect(realRow).toHaveCount(0);
      await expect(
        window.getByTestId('archived-overview-row-kept-one'),
      ).toBeVisible();

      await archivedOption.click();
      await expect(
        window.getByTestId('archived-overview-no-matches'),
      ).toHaveText('No items match the current filter');

      // Restore both states; everything is back.
      await deletedOption.click();
      await archivedOption.click();
      await expect(filterTrigger).toHaveAttribute('data-active', 'false');
      await expect(
        window.getByTestId('archived-overview-row-trashed-one'),
      ).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-row-kept-one'),
      ).toBeVisible();
      await expect(realRow).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(filterMenu).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-3054 regression. The overview is an `absolute inset-0` overlay that
  // owns the window's top row, so once the sidebar is hidden its header shares
  // an origin with the persistent titlebar corner overlay (the app-wide sidebar
  // toggle plus, on macOS, the traffic-light reserve — an absolute `left-0
  // z-40` element rendered by App.tsx). The page header used to be a plain flex
  // row with no reservation, so "Archived and deleted" and Back painted
  // underneath that overlay. Routing the header through `PageTitlebar` adds the
  // same animated spacer every other page uses; this pins it by geometry.
  test('collapsed sidebar does not cover the overview header', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-overview-collapsed-'),
    );
    seedPreferences(userDataDir);
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = seeded.workspaces[0];
    expect(workspace, 'seeded demo project').toBeTruthy();
    const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
    seedArchivedContainer({
      workspaceRoot,
      projectId: workspace.id,
      containerId: 'trashed-one',
      name: 'feature/trashed-one',
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const link = window.getByTestId(
        `sidebar-project-${workspace.id}-archived-link`,
      );
      await expect(link).toHaveText('Archived and deleted 1', {
        timeout: 15_000,
      });
      await link.click();
      const page = window.getByTestId('archived-overview-page');
      await expect(page).toBeVisible();

      const corner = window.getByTestId('app-titlebar-corner');
      await expect(corner).toBeVisible();

      const title = window.getByTestId('archived-overview-title');
      const back = window.getByTestId('archived-overview-back');
      await expect(title).toBeVisible();
      await expect(back).toBeVisible();

      // Collapse via the single app-wide toggle. The overlay widens to the
      // window origin, so the header now shares its origin with the corner.
      await window.getByTestId('sidebar-toggle').click();
      await expect(window.getByTestId('app-sidebar')).toBeHidden();

      // Measure the corner against its COLLAPSED width: it gains the
      // collapsed-only New Task control, so the docked reading is ~32px short
      // of what the header actually has to clear. Both the corner and the
      // reservation animate (~200ms), so poll the live gap rather than a
      // stale edge. This is the assertion the unfixed header fails: Back and
      // the title both sat under the overlay.
      const leadingGap = async (locator) => {
        const [cornerBox, contentBox] = await Promise.all([
          corner.boundingBox(),
          locator.boundingBox(),
        ]);
        if (cornerBox === null || contentBox === null) return null;
        return contentBox.x - (cornerBox.x + cornerBox.width);
      };
      await expect
        .poll(async () => (await leadingGap(back)) ?? -1, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(-1);
      const titleGap = await leadingGap(title);
      expect(titleGap, 'overview title vs titlebar corner').not.toBeNull();
      expect(titleGap).toBeGreaterThanOrEqual(-1);

      // The clearance comes from the shared PageTitlebar spacer, not from ad
      // hoc padding, so pin the mechanism too.
      const spacer = page.getByTestId('page-titlebar-spacer');
      await expect(spacer).toHaveCount(1);
      const spacerBox = await spacer.boundingBox();
      expect(spacerBox, 'titlebar spacer bounding box').not.toBeNull();
      expect(spacerBox.width).toBeGreaterThan(0);

      // Re-docking collapses the reservation back to zero width, so the docked
      // layout this page already had is unchanged.
      await window.getByTestId('sidebar-toggle').click();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();
      await expect
        .poll(async () => (await spacer.boundingBox())?.width ?? -1, {
          timeout: 5_000,
        })
        .toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
