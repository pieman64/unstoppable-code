// Empty file tabs + embedded per-file-tab workspace tree + path breadcrumb.
//
// Covers the file-tab UX additions:
// - The add-panel menu's "File" row creates an EMPTY "Open file" tab
//   (`filePath: ''`) whose panel shows the picker empty state (with the
//   quick-open shortcut hint) and the embedded workspace tree expanded.
// - Picking a file from the embedded tree assigns it INTO the same tab
//   (empty → non-empty) and auto-collapses the tree; the header toggle
//   (`file-tab-tree-toggle`) re-opens it.
// - With a file already shown, embedded-tree clicks route through the normal
//   open-or-activate funnel (a second file tab opens).
// - The header path renders as an interactive breadcrumb
//   (`file-breadcrumb`): parent segments open a dropdown listing the
//   segment's parent directory (segment folder pre-expanded); picking a file
//   opens a new tab, and picking an already-open file activates its existing
//   tab instead of duplicating it.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';

/**
 * Asserts both open file panels are SIBLINGS: one group holds exactly two
 * `file-diff` panels at adjacent positions (a file opened from within a
 * file tab lands right after its origin).
 */
async function expectFilePanelsAreAdjacentSiblings(window) {
  const layout = await getLayout(window);
  const leaves = collectLeaves(layout.root);
  const fileLeaves = leaves.filter((leaf) =>
    leaf.panels.some((panel) => panel.kind === 'file-diff'),
  );
  expect(fileLeaves).toHaveLength(1);
  const positions = fileLeaves[0].panels.flatMap((panel, index) =>
    panel.kind === 'file-diff' ? [index] : [],
  );
  expect(positions).toHaveLength(2);
  expect(positions[1] - positions[0]).toBe(1);
}

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

function seedFixtureFiles(worktreePath) {
  writeFileSync(
    path.join(worktreePath, 'empty-tab-pick.md'),
    '# Picked from the embedded tree\n',
    'utf8',
  );
  const nestedDir = path.join(worktreePath, 'breadcrumb-fixture', 'nested');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(
    path.join(nestedDir, 'target-note.md'),
    '# Breadcrumb target\n',
    'utf8',
  );
  writeFileSync(
    path.join(worktreePath, 'breadcrumb-fixture', 'sibling-note.md'),
    '# Breadcrumb sibling\n',
    'utf8',
  );
  const duplicateDir = path.join(worktreePath, 'duplicate-fixture');
  mkdirSync(duplicateDir, { recursive: true });
  writeFileSync(
    path.join(duplicateDir, 'empty-tab-pick.md'),
    '# Duplicate basename\n',
    'utf8',
  );
  writeFileSync(
    path.join(worktreePath, 'unsupported.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x03]),
  );
  const evaluationsDir = path.join(worktreePath, 'evaluations');
  mkdirSync(evaluationsDir, { recursive: true });
  writeFileSync(
    path.join(evaluationsDir, 'scorecard.md'),
    '# Evaluation scorecard\n',
    'utf8',
  );
  writeFileSync(
    path.join(worktreePath, 'directory-link.md'),
    '# Directory link\n\n[Open evaluations](./evaluations)\n',
    'utf8',
  );
}

test('markdown directory links open an empty tab with the target folder expanded', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-markdown-directory-link-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedFixtureFiles(worktreePath);
  const markdownPath = path.join(worktreePath, 'directory-link.md');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'directory-link-file',
    tabs: [
      {
        id: 'directory-link-file',
        title: 'directory-link.md',
        kind: 'file',
        filePath: markdownPath,
        description: markdownPath,
        fileViewMode: 'preview',
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const markdownPanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await markdownPanel
      .getByRole('button', { name: 'Open evaluations' })
      .click();

    const emptyState = window.getByTestId('file-tab-empty-state');
    await expect(emptyState).toBeVisible();
    const tree = window.getByTestId('file-tab-tree');
    await expect(tree).toBeVisible();
    const evaluations = tree.locator(
      '[data-testid="files-tree-folder"][data-path="evaluations"]',
    );
    await expect(evaluations).toHaveAttribute('aria-expanded', 'true');
    await expect(
      tree.locator(
        '[data-testid="files-tree-row"][data-path="evaluations/scorecard.md"]',
      ),
    ).toBeVisible();
    await expect(window.getByText(/EISDIR/)).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('File creates a closable Open file tab; the embedded tree fills it and stays toggleable', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-tab-empty-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedFixtureFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // Add-panel menu → File (the resulting empty tab is "Open file").
    await window.getByTestId('panel-add-panel-group-chat').click();
    const addMenu = window.getByTestId('panel-add-menu');
    await expect(addMenu).toBeVisible();
    const fileMenuItem = window.getByTestId('panel-add-menu-item-new-file');
    await expect(fileMenuItem).toHaveText('File');
    await fileMenuItem.click();

    // Empty state with the quick-open hint, and the embedded tree expanded.
    const emptyState = window.getByTestId('file-tab-empty-state');
    await expect(emptyState).toBeVisible();
    const activeEmptyTab = window.locator(
      '[data-testid^="panel-tab-panel-file-"][data-active="true"]',
    );
    await expect(activeEmptyTab).toContainText('Open file');
    await expect(
      emptyState.locator('..').locator(':scope > div').first(),
    ).toContainText('Open file');
    await expect(emptyState).toContainText('Select a file from the project');
    await expect(emptyState).toContainText('to quickly open a file');
    const tree = window.getByTestId('file-tab-tree');
    await expect(tree).toBeVisible();

    // Picking a file assigns it into THIS tab and collapses the tree.
    await tree
      .locator('[data-testid="files-tree-row"][data-path="empty-tab-pick.md"]')
      .click();
    await expect(emptyState).toHaveCount(0);
    await expect(tree).toHaveCount(0);
    const filePanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(filePanel).toContainText('Picked from the embedded tree', {
      timeout: 15_000,
    });
    await expect(
      filePanel.getByTestId('file-breadcrumb-segment-file'),
    ).toHaveText('empty-tab-pick.md');
    // Exactly one file panel: the empty tab was reused, not duplicated.
    await expect(
      window.locator('[data-testid="panel-content-file-diff"]'),
    ).toHaveCount(1);

    // The panel was created while the tab path was empty. Its context menu
    // must resolve the newly assigned live path rather than suppressing the
    // path-dependent actions because of that stale empty instance value.
    await activeEmptyTab.click({ button: 'right' });
    const assignedTabMenu = window.getByTestId('panel-tab-context-menu');
    await expect(
      assignedTabMenu.getByRole('menuitem', { name: 'Copy path', exact: true }),
    ).toBeVisible();
    await expect(
      assignedTabMenu.getByRole('menuitem', {
        name: 'Copy relative path',
        exact: true,
      }),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    // The header toggle re-opens the tree; a click now opens a SECOND tab.
    await filePanel.getByTestId('file-tab-tree-toggle').click();
    const reopenedTree = window.getByTestId('file-tab-tree');
    await expect(reopenedTree).toBeVisible();
    await reopenedTree
      .locator(
        '[data-testid="files-tree-folder"][data-path="breadcrumb-fixture"]',
      )
      .click();
    await reopenedTree
      .locator(
        '[data-testid="files-tree-row"][data-path="breadcrumb-fixture/sibling-note.md"]',
      )
      .click();
    await expect(
      window.locator('[data-testid="panel-content-file-diff"]'),
    ).toHaveCount(2);
    await expect(
      window
        .locator('[data-testid="panel-content-file-diff"]:visible')
        .getByTestId('file-breadcrumb-segment-file'),
    ).toHaveText('sibling-note.md');
    // Tree-opened files land as SIBLINGS of the origin file tab's panel.
    await expectFilePanelsAreAdjacentSiblings(window);

    // Closing a file tab removes it instead of letting the synchronizer
    // recreate it at the end of the group.
    const activeFileTab = window.locator(
      '[data-testid^="panel-tab-panel-file-"][data-active="true"]',
    );
    const activeFileTabTestId = await activeFileTab.getAttribute('data-testid');
    expect(activeFileTabTestId).toBeTruthy();
    await activeFileTab.hover();
    await activeFileTab.getByRole('button', { name: /^Close / }).click();
    await expect(
      window.locator('[data-testid="panel-content-file-diff"]'),
    ).toHaveCount(1);
    await expect(window.getByTestId(activeFileTabTestId)).toHaveCount(0);

    // Assigning a duplicate basename into another empty tab remains
    // disambiguated after the canonical metadata patch is committed.
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();
    const duplicateTree = window
      .getByTestId('panel-group-body-group-chat')
      .locator('[data-testid="file-tab-tree"]:visible');
    await duplicateTree
      .locator(
        '[data-testid="files-tree-folder"][data-path="duplicate-fixture"]',
      )
      .click();
    await duplicateTree
      .locator(
        '[data-testid="files-tree-row"][data-path="duplicate-fixture/empty-tab-pick.md"]',
      )
      .click();
    await window.waitForTimeout(500);
    const fileTabStrip = window.getByTestId('panel-tab-strip-group-chat');
    await expect(fileTabStrip).toContainText(
      'duplicate-fixture/empty-tab-pick.md',
    );
    await expect(
      fileTabStrip.getByText('empty-tab-pick.md', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('unsupported files keep the breadcrumb and embedded-tree controls around the file body', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-unsupported-wrapper-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedFixtureFiles(worktreePath);
  const unsupportedPath = path.join(worktreePath, 'unsupported.bin');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'unsupported-file',
    tabs: [
      {
        id: 'unsupported-file',
        title: 'unsupported.bin',
        kind: 'file',
        filePath: unsupportedPath,
        description: unsupportedPath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const filePanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(filePanel).toContainText('Unsupported file type', {
      timeout: 15_000,
    });
    await expect(
      filePanel.getByTestId('file-breadcrumb-segment-file'),
    ).toHaveText('unsupported.bin');

    await filePanel.getByTestId('file-tab-tree-toggle').click();
    await expect(window.getByTestId('file-tab-tree')).toBeVisible();
    await expect(filePanel).toContainText('Unsupported file type');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('embedded tree reveals and highlights the current file once, then jumps back on demand', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-tree-current-file-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedFixtureFiles(worktreePath);
  const targetRelativePath =
    process.platform === 'win32'
      ? 'Breadcrumb-Fixture/Nested/Target-Note.md'
      : 'breadcrumb-fixture/nested/target-note.md';
  const targetTreeParent = targetRelativePath.split('/')[0];
  const targetTitle = path.posix.basename(targetRelativePath);
  const canonicalTargetPath = path.join(
    worktreePath,
    ...targetRelativePath.split('/'),
  );
  if (process.platform === 'win32') {
    mkdirSync(path.dirname(canonicalTargetPath), { recursive: true });
    writeFileSync(canonicalTargetPath, '# Mixed-case target\n', 'utf8');
  }
  const targetPath =
    process.platform === 'win32'
      ? canonicalTargetPath.toLowerCase()
      : canonicalTargetPath;
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'current-file',
    tabs: [
      {
        id: 'current-file',
        title: targetTitle,
        kind: 'file',
        filePath: targetPath,
        description: targetPath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const filePanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(filePanel.getByTestId('file-viewer')).toBeVisible({
      timeout: 15_000,
    });
    await filePanel.getByTestId('file-tab-tree-toggle').click();

    const tree = filePanel.getByTestId('file-tab-tree');
    const currentFile = tree.locator(
      `[data-testid="files-tree-row"][data-path="${targetRelativePath}"]`,
    );
    await expect(tree.getByTestId('files-tree-jump-to-file')).toBeVisible();
    await expect(currentFile).toBeVisible({ timeout: 15_000 });
    await expect(currentFile).toHaveAttribute('data-current-file', 'true');

    // Opening a row must not add a second persistent highlight beside the
    // owning panel's current-file marker.
    await currentFile.click();
    await expect(currentFile).toHaveAttribute('aria-selected', 'false');

    const revealAction = currentFile
      .locator('..')
      .getByTestId('files-tree-row-open-in-file-manager');
    const revealActionContainer = revealAction.locator(
      'xpath=ancestor::*[contains(@class,"opacity-0")][1]',
    );
    await filePanel.getByTestId('file-viewer').hover();
    await tree.getByTestId('files-tree-jump-to-file').focus();
    await expect(revealActionContainer).toHaveCSS('opacity', '0');
    await currentFile.hover();
    await expect(revealActionContainer).toHaveCSS('opacity', '1');

    const topParent = tree.locator(
      `[data-testid="files-tree-folder"][data-path="${targetTreeParent}"]`,
    );
    await topParent.click();
    await expect(topParent).toHaveAttribute('aria-expanded', 'false');
    await expect(currentFile).toHaveCount(0);

    // Hiding and re-opening the tree must not repeat the initial reveal and
    // undo the user's collapse state for this tab/file pair.
    await filePanel.getByTestId('file-tab-tree-toggle').click();
    await expect(tree).toHaveCount(0);
    await filePanel.getByTestId('file-tab-tree-toggle').click();
    const reopenedTree = filePanel.getByTestId('file-tab-tree');
    const reopenedParent = reopenedTree.locator(
      `[data-testid="files-tree-folder"][data-path="${targetTreeParent}"]`,
    );
    await expect(reopenedParent).toHaveAttribute('aria-expanded', 'false');
    await expect(
      reopenedTree.locator(
        `[data-testid="files-tree-row"][data-path="${targetRelativePath}"]`,
      ),
    ).toHaveCount(0);

    await reopenedTree.getByTestId('files-tree-jump-to-file').click();
    const jumpedFile = reopenedTree.locator(
      `[data-testid="files-tree-row"][data-path="${targetRelativePath}"]`,
    );
    await expect(jumpedFile).toBeVisible({ timeout: 15_000 });
    await expect(jumpedFile).toHaveAttribute('data-current-file', 'true');

    // Once the target is visible, Jump to file is a true no-op.
    const scroll = reopenedTree.getByTestId('files-tree-scroll');
    const scrollTop = await scroll.evaluate((element) => element.scrollTop);
    await reopenedTree.getByTestId('files-tree-jump-to-file').click();
    await expect
      .poll(async () => scroll.evaluate((element) => element.scrollTop))
      .toBe(scrollTop);

    const originalFileTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: targetTitle });
    await expect(originalFileTab).toHaveCount(1);

    // The standalone explorer starts from its own expansion state instead of
    // inheriting the parent chain revealed by this embedded tree.
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    const standalonePanel = window.getByTestId('panel-content-file-explorer');
    const standaloneTree = standalonePanel.getByTestId('files-tree-tab');
    await expect(standaloneTree).toBeVisible();
    await expect(
      standaloneTree.locator(
        `[data-testid="files-tree-folder"][data-path="${targetTreeParent}"]`,
      ),
    ).toHaveAttribute('aria-expanded', 'false');

    const layout = await getLayout(window);
    const explorerPanelId = collectLeaves(layout.root)
      .flatMap((leaf) => leaf.panels)
      .find((panel) => panel.kind === 'file-explorer')?.panelId;
    expect(explorerPanelId, 'standalone explorer panel id').toBeTruthy();
    const explorerTab = window.getByTestId(`panel-tab-${explorerPanelId}`);
    const standaloneOpenedFile = standaloneTree.locator(
      '[data-testid="files-tree-row"][data-path="empty-tab-pick.md"]',
    );
    await standaloneOpenedFile.click();
    await expect(standalonePanel).toBeHidden();
    await explorerTab.click();
    await expect(standalonePanel).toBeVisible();
    await expect(standaloneOpenedFile).toHaveAttribute(
      'aria-selected',
      'false',
    );

    // The file opened from standalone gets a third, independent tree state.
    const openedFileTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: 'empty-tab-pick.md' });
    await openedFileTab.click();
    const openedFilePanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await openedFilePanel.getByTestId('file-tab-tree-toggle').click();
    const openedFileTree = openedFilePanel.getByTestId('file-tab-tree');
    await expect(
      openedFileTree.locator(
        '[data-testid="files-tree-folder"][data-path="breadcrumb-fixture"]',
      ),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(
      openedFileTree.locator(
        '[data-testid="files-tree-row"][data-path="empty-tab-pick.md"]',
      ),
    ).toHaveAttribute('data-current-file', 'true');

    await originalFileTab.click();
    const restoredOriginalTree = window
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .getByTestId('file-tab-tree');
    await expect(
      restoredOriginalTree.locator(
        '[data-testid="files-tree-row"][data-path="breadcrumb-fixture/nested/target-note.md"]',
      ),
    ).toHaveAttribute('data-current-file', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('breadcrumb segments open a parent-directory menu that opens or activates file tabs', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-breadcrumb-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedFixtureFiles(worktreePath);
  const targetPath = path.join(
    worktreePath,
    'breadcrumb-fixture',
    'nested',
    'target-note.md',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'breadcrumb-file',
    tabs: [
      {
        id: 'breadcrumb-file',
        title: 'target-note.md',
        kind: 'file',
        filePath: targetPath,
        description: targetPath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const filePanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    const breadcrumb = filePanel.getByTestId('file-breadcrumb');
    await expect(breadcrumb).toBeVisible({ timeout: 15_000 });
    // A tab opened directly with a file (not via the add-panel menu) starts with the
    // embedded tree HIDDEN by default.
    await expect(window.getByTestId('file-tab-tree')).toHaveCount(0);
    await expect(
      breadcrumb.getByTestId('file-breadcrumb-segment-0'),
    ).toHaveText('breadcrumb-fixture');
    await expect(
      breadcrumb.getByTestId('file-breadcrumb-segment-1'),
    ).toHaveText('nested');
    await expect(
      breadcrumb.getByTestId('file-breadcrumb-segment-file'),
    ).toHaveText('target-note.md');
    const breadcrumbSizing = await breadcrumb.evaluate((element) => {
      const folder = element.querySelector(
        '[data-testid="file-breadcrumb-segment-0"]',
      );
      const file = element.querySelector(
        '[data-testid="file-breadcrumb-segment-file"]',
      );
      if (!(folder instanceof HTMLElement) || !(file instanceof HTMLElement)) {
        throw new Error('Expected folder and file breadcrumb segments.');
      }
      return {
        breadcrumbMaxWidth: getComputedStyle(element).maxWidth,
        folderShrink: Number.parseFloat(getComputedStyle(folder).flexShrink),
        fileMaxWidth: getComputedStyle(file).maxWidth,
        fileShrink: Number.parseFloat(getComputedStyle(file).flexShrink),
      };
    });
    expect(breadcrumbSizing.breadcrumbMaxWidth).not.toBe('none');
    expect(breadcrumbSizing.fileMaxWidth).not.toBe('none');
    expect(breadcrumbSizing.fileShrink).toBeLessThan(
      breadcrumbSizing.folderShrink,
    );

    // Clicking the 'nested' segment lists its PARENT ('breadcrumb-fixture')
    // with 'nested' pre-expanded: the sibling file and the nested child are
    // both reachable.
    await breadcrumb.getByTestId('file-breadcrumb-segment-1').click();
    const menu = window.getByTestId('file-breadcrumb-menu');
    await expect(menu).toBeVisible();
    const nestedDirRow = menu.locator(
      '[data-entry-kind="directory"][data-relative-path="breadcrumb-fixture/nested"]',
    );
    await expect(nestedDirRow).toHaveAttribute('aria-expanded', 'true');
    await expect(
      menu.locator(
        '[data-entry-kind="file"][data-relative-path="breadcrumb-fixture/nested/target-note.md"]',
      ),
    ).toBeVisible();

    // Picking a not-yet-open file opens a NEW file tab.
    await menu
      .locator(
        '[data-entry-kind="file"][data-relative-path="breadcrumb-fixture/sibling-note.md"]',
      )
      .click();
    await expect(menu).toHaveCount(0);
    await expect(
      window.locator('[data-testid="panel-content-file-diff"]'),
    ).toHaveCount(2);
    const visibleCrumbFile = window
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .getByTestId('file-breadcrumb-segment-file');
    await expect(visibleCrumbFile).toHaveText('sibling-note.md');
    // Breadcrumb-opened files land as SIBLINGS of the origin file tab.
    await expectFilePanelsAreAdjacentSiblings(window);

    // From the sibling's breadcrumb, picking the ALREADY-OPEN target file
    // activates its existing tab — still exactly two file panels.
    await window
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .getByTestId('file-breadcrumb-segment-0')
      .click();
    const reopenedMenu = window.getByTestId('file-breadcrumb-menu');
    await expect(reopenedMenu).toBeVisible();
    await reopenedMenu
      .locator(
        '[data-entry-kind="directory"][data-relative-path="breadcrumb-fixture/nested"]',
      )
      .click();
    await reopenedMenu
      .locator(
        '[data-entry-kind="file"][data-relative-path="breadcrumb-fixture/nested/target-note.md"]',
      )
      .click();
    await expect(
      window.locator('[data-testid="panel-content-file-diff"]'),
    ).toHaveCount(2);
    await expect(visibleCrumbFile).toHaveText('target-note.md');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
