// ShowFiles existing-tab renderer bridge timeout regression coverage.
//
// The file is opened through the real command-palette flow before the exact
// renderer-tool request used by ShowFiles asks to open it again. Animation
// frames are suppressed when that request arrives, deterministically modeling
// Electron background throttling. Before the fix, the renderer never
// acknowledges the request promptly and reuses the existing file tab.
//
// Determinism: the git worktree and chat are seeded from committed fixtures,
// and the bridge request is injected over the production IPC channel. No live
// agent or network is involved.

import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const CHAT_ID = 'show-files-chat';
const FILE_NAME = 'README.md';
const REQUEST_ID = 'show-files-existing-tab-request';
const PALETTE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

test('ShowFiles acknowledges an already-open file when animation frames are throttled', async () => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-show-files-existing-tab-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Show existing file' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
    await app.selectWorktree(WORKTREE_ID);

    // Navigate through the real file UI first, then return to the chat while
    // leaving the file tab alive. The renderer-tool request must reuse it.
    await window.keyboard.press(`${PALETTE_MODIFIER}+p`);
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill(FILE_NAME);
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FILE_NAME })
      .first()
      .click();
    await expect(window.getByTestId('file-viewer')).toBeVisible({
      timeout: 20_000,
    });
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();

    const fileTabs = window.locator('[data-testid^="panel-tab-panel-file-"]');
    await expect(fileTabs).toHaveCount(1);

    // Suppress frames only when ShowFiles arrives. The production bridge's
    // listener begins its async file reads in the same event turn; this second
    // listener runs before those reads reach the former paint wait.
    await window.evaluate(() => {
      window.api.appAdvisor.onToolRequest((request) => {
        if (request.kind === 'show_files') {
          window.requestAnimationFrame = () => 1;
        }
      });
    });

    const request = {
      kind: 'show_files',
      requestId: REQUEST_ID,
      payload: {
        target: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        origin: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatTabId: CHAT_ID,
        },
        files: [{ path: FILE_NAME, view: 'rich' }],
      },
    };

    // Replace the response handler only inside this ephemeral Electron process
    // so the test can observe the renderer acknowledgement directly. The app
    // is closed immediately afterward, so no production state survives.
    const response = await electronApp.evaluate(
      async ({ BrowserWindow, ipcMain }, rendererRequest) => {
        const responseChannel = 'app-advisor:tool-response';
        const requestChannel = 'app-advisor:tool-request';
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        if (!mainWindow) throw new Error('Main window not found');

        ipcMain.removeHandler(responseChannel);
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          };
          const timer = setTimeout(() => finish(null), 2_000);
          ipcMain.handle(responseChannel, (_event, candidate) => {
            if (candidate?.requestId === rendererRequest.requestId) {
              finish(candidate);
            }
          });
          mainWindow.webContents.send(requestChannel, rendererRequest);
        });
      },
      request,
    );

    expect(response).toMatchObject({
      requestId: REQUEST_ID,
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: FILE_NAME, ok: true }],
      },
    });

    await expect(fileTabs).toHaveCount(1);
    await expect(window.getByTestId('file-viewer')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
