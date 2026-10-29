// ShowFiles opens HTML pages rendered in the in-app browser.
//
// The sandboxed HTML preview blocks linked stylesheets and scripts, so a
// normal multi-file page (index.html + styles.css + app.js) rendered unstyled
// with its script-filled content empty. ShowFiles now opens the page in the
// browser beside the chat, where both load, while other files in the same
// call still open as source. Asking for `view: "raw"` keeps the file viewer,
// whose Open in browser action still loads the page.
//
// Determinism: the worktree, page files and chat are seeded from fixtures,
// and the ShowFiles request is sent over the production renderer-tool IPC
// channel. No live agent or network is involved.
//
//   pnpm run test:electron:built show-files-html-browser.spec.mjs --reporter=line

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'show-files-html-chat';
const PAGE_TITLE = 'ShowFiles styled page';
const PAGE_COLOR = 'rgb(12, 110, 74)';

/** Sends one ShowFiles renderer request and resolves its acknowledgement. */
async function sendShowFiles(electronApp, requestId, files) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 20_000);
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId === rendererRequest.requestId) {
            clearTimeout(timer);
            resolve(candidate);
          }
        });
        mainWindow.webContents.send(
          'app-advisor:tool-request',
          rendererRequest,
        );
      });
    },
    {
      kind: 'show_files',
      requestId,
      payload: {
        target: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        origin: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatTabId: CHAT_ID,
        },
        files,
      },
    },
  );
}

/** Reads the rendered page's stylesheet color and script-filled text. */
function readRenderedPage(electronApp) {
  return electronApp.evaluate(async ({ webContents }, title) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getTitle() === title);
    if (!contents) return null;
    return contents.executeJavaScript(
      `({
        color: getComputedStyle(document.querySelector('h1')).color,
        stat: document.querySelector('#stat').textContent,
      })`,
    );
  }, PAGE_TITLE);
}

test('ShowFiles opens a multi-file page rendered in the browser beside the chat', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-show-files-html-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const siteDir = path.join(worktreePath, 'site');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(
    path.join(siteDir, 'index.html'),
    [
      '<!doctype html>',
      `<html><head><title>${PAGE_TITLE}</title>`,
      '<link rel="stylesheet" href="styles.css"></head>',
      '<body><h1>Food truck</h1><p id="stat">0</p>',
      '<script src="app.js"></script></body></html>',
    ].join('\n'),
  );
  writeFileSync(
    path.join(siteDir, 'styles.css'),
    `h1 { color: ${PAGE_COLOR}; }\n`,
  );
  writeFileSync(
    path.join(siteDir, 'app.js'),
    "document.querySelector('#stat').textContent = '42';\n",
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Build the page' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 30_000 });

    const response = await sendShowFiles(electronApp, 'show-files-html-page', [
      { path: 'site/index.html' },
      { path: 'site/app.js' },
    ]);
    expect(response).toMatchObject({
      ok: true,
      result: {
        opened: 2,
        failed: 0,
        files: [
          { path: 'site/index.html', ok: true, openedIn: 'browser' },
          { path: 'site/app.js', ok: true },
        ],
      },
    });

    // The page opens first and active, in the browser beside the chat, with
    // its linked stylesheet and script both loaded.
    const browser = window.locator(
      '[data-testid="panel-content-browser"]:visible',
    );
    await expect(browser).toHaveCount(1, { timeout: 30_000 });
    await expect(browser.getByTestId('browser-url-input')).toHaveValue(
      /^file:\/\/.*\/site\/index\.html$/,
      { timeout: 30_000 },
    );
    await expect(chatPanel).toBeVisible();
    await expect
      .poll(() => readRenderedPage(electronApp), { timeout: 30_000 })
      .toEqual({ color: PAGE_COLOR, stat: '42' });

    // The script still opens as source in a file tab.
    await expect(
      window
        .locator('[data-testid^="panel-tab-panel-file-"]')
        .filter({ hasText: 'app.js' }),
    ).toHaveCount(1);

    // Asking for the page source keeps the file viewer, and its Open in
    // browser action still loads the page rendered.
    const rawResponse = await sendShowFiles(
      electronApp,
      'show-files-html-source',
      [{ path: 'site/index.html', view: 'raw' }],
    );
    expect(rawResponse).toMatchObject({
      ok: true,
      result: { opened: 1, files: [{ ok: true }] },
    });
    expect(rawResponse.result.files[0]).not.toHaveProperty('openedIn');
    const sourceViewer = window
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .filter({ hasText: 'index.html' });
    await expect(sourceViewer).toContainText('rel="stylesheet"', {
      timeout: 30_000,
    });
    const browserTabs = window.locator(
      '[role="tab"][data-panel-kind="browser"]',
    );
    await expect(browserTabs).toHaveCount(1);
    await sourceViewer.getByTestId('file-viewer-open-in-browser').click();
    await expect(browserTabs).toHaveCount(2, { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
