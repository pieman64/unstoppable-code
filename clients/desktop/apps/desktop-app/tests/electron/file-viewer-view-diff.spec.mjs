import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { writeJson } from './seeders/index.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHANGED_TAB_ID = 'changed-file-tab';
const CLEAN_TAB_ID = 'clean-file-tab';
const IMAGE_TAB_ID = 'changed-image-tab';
const CHANGED_FILE = 'README.md';
const CLEAN_FILE = 'package.json';
const IMAGE_FILE = 'changed-image.png';
const ADDED_MARKER = 'CANOPY E2E file viewer View Diff marker';
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8WcWQAAAABJRU5ErkJggg==';

test('file view toggles survive a revision refresh already in progress', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-refresh-toggle-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const filePath = path.join(worktreePath, CHANGED_FILE);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHANGED_TAB_ID,
    tabs: [
      {
        id: CHANGED_TAB_ID,
        title: CHANGED_FILE,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
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

    const panel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${CHANGED_TAB_ID}"]`,
    );
    const toggle = panel.locator(
      '[data-testid="file-view-toggle-formatted"]:visible',
    );
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator('.monaco-editor')).toBeVisible();
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );

    // Deliver a revision gap and hold the recovery snapshot. The toggle lands
    // while the renderer scope is refreshing, exactly where command dispatch
    // reports transport_failed without submitting an IPC request.
    await electronApp.evaluate(
      ({ BrowserWindow, ipcMain }, fixture) => {
        const original = ipcMain._invokeHandlers.get('chat:get-state');
        globalThis.fileViewRefreshEntered = false;
        const gate = new Promise((resolve) => {
          globalThis.releaseFileViewRefresh = resolve;
        });
        ipcMain.removeHandler('chat:get-state');
        ipcMain.handle('chat:get-state', async (event, request) => {
          if (
            request.projectId === fixture.projectId &&
            request.worktreeId === fixture.worktreeId
          ) {
            globalThis.fileViewRefreshEntered = true;
            await gate;
          }
          return original(event, request);
        });
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        mainWindow.webContents.send('chat:state-changed', fixture.event);
      },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        event: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          schemaVersion: 1,
          eventId: 'file-view-refresh-gap',
          occurredAt: new Date().toISOString(),
          baseRevision: snapshot.revision + 1,
          revision: snapshot.revision + 2,
          changes: [],
        },
      },
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.fileViewRefreshEntered))
      .toBe(true);

    await toggle.click();
    await electronApp.evaluate(() => globalThis.releaseFileViewRefresh());

    await expect(panel.getByTestId('file-markdown-preview')).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => {
        const current = await window.evaluate(
          (scope) => window.api.chat.getState(scope),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return current.tabsFile.tabs.find((tab) => tab.id === CHANGED_TAB_ID)
          ?.fileViewMode;
      })
      .toBe('preview');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file viewer exposes View Diff for changed text and image files only', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-view-diff-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const changedPath = path.join(worktreePath, CHANGED_FILE);
  const cleanPath = path.join(worktreePath, CLEAN_FILE);
  const imagePath = path.join(worktreePath, IMAGE_FILE);
  const original = readFileSync(changedPath, 'utf8');
  writeFileSync(
    changedPath,
    `${original}${original.endsWith('\n') ? '' : '\n'}${ADDED_MARKER}\n`,
    'utf8',
  );
  writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHANGED_TAB_ID,
    tabs: [
      {
        id: CHANGED_TAB_ID,
        title: CHANGED_FILE,
        kind: 'file',
        filePath: changedPath,
        fileViewMode: 'raw',
        description: changedPath,
        messages: [],
      },
      {
        id: CLEAN_TAB_ID,
        title: CLEAN_FILE,
        kind: 'file',
        filePath: cleanPath,
        fileViewMode: 'raw',
        description: cleanPath,
        messages: [],
      },
      {
        id: IMAGE_TAB_ID,
        title: IMAGE_FILE,
        kind: 'file',
        filePath: imagePath,
        fileViewMode: 'raw',
        description: imagePath,
        messages: [],
      },
    ],
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      changedFilesHiddenLabelIds: ['documentation'],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const changedPanel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${CHANGED_TAB_ID}"]`,
    );
    const header = changedPanel.getByTestId('file-viewer-header');
    await expect(header).toBeVisible({ timeout: 20_000 });
    const viewDiff = changedPanel.locator(
      '[data-testid="file-viewer-view-diff"]:visible',
    );
    await expect(viewDiff).toBeVisible({ timeout: 20_000 });
    await expect(
      header.locator('[data-testid="file-viewer-view-diff"]:visible'),
    ).toBeVisible();
    // An append-only change shows no "-0"; its status dot stays.
    await expect(viewDiff).toHaveText(/^\+\d+$/);
    await expect(viewDiff.locator('[title="Modified"]')).toHaveCount(1);
    await expect(viewDiff).toHaveAttribute('aria-label', 'View diff');
    const viewToggle = changedPanel.locator(
      '[data-testid="file-view-toggle"]:visible',
    );
    await expect(viewToggle).toBeVisible();
    const [diffBox, toggleBox] = await Promise.all([
      viewDiff.boundingBox(),
      viewToggle.boundingBox(),
    ]);
    expect(diffBox, 'diff action bounding box').not.toBeNull();
    expect(toggleBox, 'view toggle bounding box').not.toBeNull();
    expect(Math.abs(diffBox.height - toggleBox.height)).toBeLessThanOrEqual(1);
    await expect(changedPanel.getByTestId('file-tab-tree')).toHaveCount(0);
    await changedPanel
      .locator('[data-testid="file-tab-tree-toggle"]:visible')
      .click();

    const editor = changedPanel.getByTestId('monaco-file-editor');
    await editor.click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+End' : 'Control+End',
    );
    await window.keyboard.type('\nUnsaved editor change');
    await expect(changedPanel.getByTestId('file-viewer-dirty')).toBeVisible();
    await expect(changedPanel.getByTestId('file-save')).toBeVisible();
    await expect(changedPanel.getByTestId('file-discard')).toBeVisible();

    const treeMode = changedPanel.getByRole('button', {
      name: 'Show changed files',
      exact: true,
    });
    await expect(treeMode).toHaveAttribute('aria-pressed', 'false');
    await viewDiff.click();
    await expect(treeMode).toHaveAttribute('aria-pressed', 'false');
    // The header re-lays out once the diff loads and keeps the toggle it
    // showed first mounted but hidden. A click waits on the element it
    // resolved, so resolve the visible toggle again on each try.
    await expect(async () => {
      await changedPanel
        .locator('[data-testid="file-tab-tree-toggle"]:visible')
        .click({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await expect(viewDiff).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('code-review-modal')).toHaveCount(0);
    const diff = changedPanel.getByTestId('file-panel-diff');
    await expect(diff).toBeVisible();
    await expect(changedPanel.getByTestId('file-viewer-dirty')).toBeVisible();
    await expect(changedPanel.getByTestId('file-save')).toBeVisible();
    await expect(changedPanel.getByTestId('file-discard')).toBeVisible();
    await expect(
      changedPanel.getByText('Diff shows saved content'),
    ).toBeVisible();
    await expect(diff).toContainText(ADDED_MARKER, { timeout: 15_000 });
    // The alternate header confirms the same draft and restores focus to
    // its surviving header when acceptance removes the Discard trigger.
    const discard = changedPanel.getByTestId('file-discard');
    const confirm = window.getByTestId('file-discard-confirm');
    const savedBeforeDiscard = readFileSync(changedPath, 'utf8');
    await discard.click();
    await expect(confirm).toBeVisible();
    await expect(
      window.getByTestId('file-discard-confirm-cancel'),
    ).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(changedPanel.getByTestId('file-viewer-dirty')).toBeVisible();
    await discard.click();
    await window.getByTestId('file-discard-confirm-accept').click();
    await expect(confirm).toHaveCount(0);
    await expect(changedPanel.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect(
      changedPanel.locator('[data-testid="file-viewer-header"]:visible'),
    ).toBeFocused();
    expect(readFileSync(changedPath, 'utf8')).toBe(savedBeforeDiscard);
    await expect(
      window.getByTestId(`panel-tab-panel-file-${CHANGED_TAB_ID}`),
    ).toHaveCount(1);
    await expect(viewToggle).toBeVisible();
    await viewToggle.click();
    await expect(diff).toBeHidden();
    await expect(viewDiff).toHaveAttribute('aria-pressed', 'false');
    await expect(
      changedPanel.getByTestId('file-markdown-preview'),
    ).toBeVisible();
    await viewDiff.click();
    await expect(diff).toBeVisible();
    await viewDiff.click();
    await expect(diff).toBeHidden();
    await expect(viewDiff).toHaveAttribute('aria-pressed', 'false');
    await expect(changedPanel.locator('.monaco-editor')).toBeVisible();

    await window.getByTestId(`panel-tab-panel-file-${CLEAN_TAB_ID}`).click();
    const cleanPanel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${CLEAN_TAB_ID}"]`,
    );
    await expect(cleanPanel).toBeVisible();
    await expect(
      cleanPanel.locator('[data-testid="file-viewer-view-diff"]:visible'),
    ).toHaveCount(0);

    await window.getByTestId(`panel-tab-panel-file-${IMAGE_TAB_ID}`).click();
    const imagePanel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${IMAGE_TAB_ID}"]`,
    );
    await expect(imagePanel).toBeVisible();
    await expect(
      imagePanel.getByTestId('file-viewer-image-header'),
    ).toBeVisible({ timeout: 20_000 });
    const imageViewDiff = imagePanel.locator(
      '[data-testid="file-viewer-view-diff"]:visible',
    );
    await expect(imageViewDiff).toBeVisible();
    await imageViewDiff.click();

    await expect(imageViewDiff).toHaveAttribute('aria-pressed', 'true');
    await expect(imagePanel.getByTestId('file-panel-diff')).toBeVisible();
    await expect(window.getByTestId('code-review-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('historical turn comparison uses a pill beside the layout toggle', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-turn-pill-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0].worktreePath;
  const filePath = path.join(worktreePath, CHANGED_FILE);
  const git = (...args) =>
    execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim();
  const startTree = git('rev-parse', 'HEAD^{tree}');
  writeFileSync(
    filePath,
    readFileSync(filePath, 'utf8') + '\nHistorical turn addition\n',
  );
  git('add', CHANGED_FILE);
  const endTree = git('write-tree');
  writeFileSync(
    filePath,
    readFileSync(filePath, 'utf8') + '\nLater workspace addition\n',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHANGED_TAB_ID,
    tabs: [
      {
        id: CHANGED_TAB_ID,
        title: CHANGED_FILE,
        kind: 'file',
        filePath,
        fileViewMode: 'diff',
        description: filePath,
        messages: [],
        fileDiffContext: {
          path: CHANGED_FILE,
          source: 'combined',
          startTree,
          endTree,
          turnDiff: {
            files: [
              {
                path: CHANGED_FILE,
                status: 'modified',
                insertions: 1,
                deletions: 0,
              },
            ],
            totalInsertions: 1,
            totalDeletions: 0,
            capturedAt: 1,
            treeRefs: [{ startTree, endTree }],
          },
        },
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
    const panel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${CHANGED_TAB_ID}"]`,
    );
    const diff = panel.getByTestId('file-panel-diff');
    await expect(diff).toContainText('Later workspace addition');
    const turn = panel.getByRole('button', {
      name: 'Turn changes',
      exact: true,
    });
    const all = panel.getByRole('button', { name: 'All changes', exact: true });
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    const comparison = panel.getByTestId('file-diff-comparison');
    const layout = panel.getByTestId('file-diff-layout');
    const [a, b] = await Promise.all([
      comparison.boundingBox(),
      layout.boundingBox(),
    ]);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    await turn.click();
    await expect(turn).toHaveAttribute('aria-pressed', 'true');
    await expect(diff).toContainText('Historical turn addition');
    await expect(diff).not.toContainText('Later workspace addition');
    await panel.getByTestId('file-diff-layout-split').click();
    await expect(turn).toHaveAttribute('aria-pressed', 'true');
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(diff).toContainText('Later workspace addition');
    await expect(panel.getByTestId('file-diff-layout-split')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await panel
      .getByRole('combobox', { name: 'Diff source' })
      .selectOption('uncommitted');
    await expect(all).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
