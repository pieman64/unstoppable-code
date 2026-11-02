// CAN-3995: desktop file tabs play mp4 videos in-app.
//
// The fixture is a 2-second 320x180 H.264 mp4 recorded with Electron's own
// encoder, so this proves the packaged codec set plays it from a blob: URL.
import {
  copyFileSync,
  mkdtempSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const FIXTURE = fileURLToPath(
  new URL('./fixtures/can-3995-reel.mp4', import.meta.url),
);
const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

function activeFilePanel(window) {
  return window.locator('[data-testid="panel-content-file-diff"]:visible');
}

async function openFromPanelTree(window, name) {
  const panel = activeFilePanel(window);
  if (!(await panel.getByTestId('file-tab-tree').isVisible())) {
    await panel.getByTestId('file-tab-tree-toggle').click();
  }
  const row = panel
    .getByTestId('file-tab-tree')
    .locator(`[data-testid="files-tree-row"][data-path="${name}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    activeFilePanel(window).getByTestId('file-breadcrumb-segment-file'),
  ).toHaveText(name);
  return activeFilePanel(window);
}

test('plays an mp4 in its file tab and keeps undecodable and oversized videos actionable', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-3995-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const reelPath = path.join(worktreePath, 'reel.mp4');
  copyFileSync(FIXTURE, reelPath);
  // Over the document budget but under the video one: the bytes load, then
  // the browser rejects them as video.
  const undecodable = path.join(worktreePath, 'undecodable.mp4');
  writeFileSync(undecodable, '');
  truncateSync(undecodable, DOCUMENT_MAX_BYTES + 1);
  const oversized = path.join(worktreePath, 'oversized.mp4');
  writeFileSync(oversized, '');
  truncateSync(oversized, VIDEO_MAX_BYTES + 1);
  const notesPath = path.join(worktreePath, 'notes.txt');
  writeFileSync(notesPath, 'Neighbor tab for CAN-3995\n', 'utf8');
  const fileTab = (id, filePath) => ({
    id,
    title: path.basename(filePath),
    kind: 'file',
    filePath,
    fileViewMode: 'raw',
    description: filePath,
    messages: [],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'reel',
    tabs: [fileTab('reel', reelPath), fileTab('notes', notesPath)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    let panel = activeFilePanel(window);
    // Window-scoped: the hidden tab keeps its player mounted.
    const video = window.getByTestId('file-viewer-video');
    await expect(video).toBeVisible({ timeout: 30_000 });
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => video.evaluate((node) => node.readyState), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);
    expect(
      await video.evaluate((node) => [node.videoWidth, node.videoHeight]),
    ).toEqual([320, 180]);
    await video.evaluate((node) => {
      node.muted = true;
      return node.play();
    });
    await expect
      .poll(() => video.evaluate((node) => node.currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await expect(panel.getByTestId('file-viewer-document-error')).toHaveCount(
      0,
    );
    await expect(panel.getByTestId('file-viewer-unsupported')).toHaveCount(0);

    // Hiding the tab pauses it; returning keeps the same player and position
    // instead of re-reading the file.
    const src = await video.getAttribute('src');
    await window.getByTestId('panel-tab-panel-file-notes').click();
    await expect
      .poll(() => video.evaluate((node) => node.paused), { timeout: 10_000 })
      .toBe(true);
    await window.getByTestId('panel-tab-panel-file-reel').click();
    await expect(video).toBeVisible();
    expect(await video.getAttribute('src')).toBe(src);
    expect(await video.evaluate((node) => node.currentTime)).toBeGreaterThan(0);

    panel = await openFromPanelTree(window, 'undecodable.mp4');
    let error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'parse-failed', {
      timeout: 60_000,
    });
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();

    panel = await openFromPanelTree(window, 'oversized.mp4');
    error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'too-large');
    await expect(error).toContainText('100 MB');
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();

    panel = await openFromPanelTree(window, 'reel.mp4');
    await expect(panel.getByTestId('file-viewer-video')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Before the fix, ShowFiles rejected .mp4 as unsupported text, so agents
// improvised an HTML wrapper page in the in-app browser instead.
test('ShowFiles opens an agent-requested mp4 in the file tab player, not the browser', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-3995-show-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  copyFileSync(FIXTURE, path.join(worktreePath, 'reel.mp4'));
  const chatId = 'show-video-chat';
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Show the reel' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // The exact renderer-tool request ShowFiles sends, over the production
    // IPC channel; the response handler is replaced only in this process.
    const request = {
      kind: 'show_files',
      requestId: 'can-3995-show-video',
      payload: {
        target: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        origin: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatTabId: chatId,
        },
        files: [{ path: 'reel.mp4' }],
      },
    };
    const response = await electronApp.evaluate(
      async ({ BrowserWindow, ipcMain }, rendererRequest) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        if (!mainWindow) throw new Error('Main window not found');
        ipcMain.removeHandler('app-advisor:tool-response');
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 10_000);
          ipcMain.handle('app-advisor:tool-response', (_event, candidate) => {
            if (candidate?.requestId !== rendererRequest.requestId) return;
            clearTimeout(timer);
            resolve(candidate);
          });
          mainWindow.webContents.send(
            'app-advisor:tool-request',
            rendererRequest,
          );
        });
      },
      request,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: 'reel.mp4', ok: true }],
      },
    });
    expect(response.result.files[0].openedIn).toBeUndefined();
    const video = activeFilePanel(window).getByTestId('file-viewer-video');
    await expect(video).toBeVisible({ timeout: 30_000 });
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect(
      window.locator('[data-testid^="panel-tab-browser-"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
