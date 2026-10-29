import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The Browser panel is a native WebContentsView drawn above all renderer
// content, so it must be hidden whenever its panel grid is not on screen:
// on other pages, under Settings, and under full-surface overlays such as the
// "Archived and deleted" overview.

const BROWSER_PAGE_TITLE = 'Browser hidden behind full-page surfaces fixture';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ARCHIVED_ID = 'browser-hidden-archived';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function seed() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-hidden-surfaces-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  writeJson(
    path.join(
      workspaceDir,
      'worktree-data',
      WORKTREE_ID,
      'panel-layout-mode.json',
    ),
    { version: 1, mode: 'advanced' },
  );
  // One archived worktree so the sidebar shows the "Archived and deleted"
  // link a user clicks.
  const now = new Date().toISOString();
  writeJson(
    path.join(
      workspaceDir,
      'archived-containers',
      ARCHIVED_ID,
      'container.json',
    ),
    {
      version: 1,
      id: ARCHIVED_ID,
      kind: 'worktree',
      projectId: WORKSPACE_ID,
      name: 'Archived fixture worktree',
      createdAt: now,
      archivedAt: now,
      retentionDays: 7,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      branchName: 'feature/archived-fixture',
    },
  );
  return { userDataDir };
}

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${BROWSER_PAGE_TITLE}</title></head>
        <body style="margin:0;background:#d8f0f7;min-height:100vh">
          <h1>${BROWSER_PAGE_TITLE}</h1>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Local browser fixture did not receive a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function browserPanelIds(window) {
  return window.evaluate(() => {
    const layout = window.__canopyPanelTestApi?.getSerializedLayout();
    if (!layout) return [];
    const collectLeaves = (node) =>
      node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves);
    return collectLeaves(layout.root).flatMap((leaf) =>
      leaf.panels
        .filter((panel) => panel.kind === 'browser')
        .map((panel) => panel.instance?.browserId)
        .filter(Boolean),
    );
  });
}

async function addBrowserPanel(window) {
  const before = new Set(await browserPanelIds(window));
  const groupId = await window.evaluate(() => {
    let node = window.__canopyPanelTestApi?.getSerializedLayout()?.root;
    while (node && node.type !== 'leaf') node = node.children[0];
    return node?.groupId;
  });
  expect(groupId).toBeTruthy();
  const addPanel = window.getByTestId(`panel-add-panel-${groupId}`);
  await (
    (await addPanel.isVisible())
      ? addPanel
      : window.getByTestId(`panel-add-tab-${groupId}`)
  ).click();
  await window.getByTestId('panel-add-menu-item-browser').click();
  await expect(window.getByTestId('panel-add-menu')).toBeHidden({
    timeout: 15_000,
  });
  let browserId;
  await expect
    .poll(async () => {
      browserId = (await browserPanelIds(window)).find((id) => !before.has(id));
      return Boolean(browserId);
    })
    .toBe(true);
  await expect(window.getByTestId(`browser-pane-${browserId}`)).toHaveAttribute(
    'data-browser-state',
    'live',
    { timeout: 30_000 },
  );
  return browserId;
}

/** Main-process visibility of the fixture page's native view. */
async function fixtureViewVisible(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }, title) => {
    let visible = false;
    const visit = (view) => {
      for (const child of view?.children ?? []) {
        if (child.webContents?.getTitle() === title && child.getVisible()) {
          visible = true;
        }
        visit(child);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView);
    }
    return visible;
  }, BROWSER_PAGE_TITLE);
}

async function expectBrowserShown(electronApp) {
  await expect
    .poll(() => fixtureViewVisible(electronApp), { timeout: 15_000 })
    .toBe(true);
}

async function expectBrowserHidden(electronApp) {
  await expect
    .poll(() => fixtureViewVisible(electronApp), { timeout: 15_000 })
    .toBe(false);
}

test.describe('Browser panel behind full-page surfaces', () => {
  test.setTimeout(180_000);

  test('hides the native Browser view under Archived and deleted, Settings and other pages', async () => {
    const { userDataDir } = seed();
    const fixture = await startLocalPage();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID, {
        expandDefaultActivityRail: false,
      });

      const browserId = await addBrowserPanel(window);
      const urlInput = window
        .getByTestId(`browser-pane-${browserId}`)
        .getByTestId('browser-url-input');
      await urlInput.fill(fixture.url);
      await urlInput.press('Enter');
      await expectBrowserShown(electronApp);

      // The "Archived and deleted" overview covers the panel grid as an
      // overlay on the main page; the Browser must not draw over its list.
      const archivedLink = window.getByTestId(
        `sidebar-project-${WORKSPACE_ID}-archived-link`,
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      await expect(window.getByTestId('archived-overview-page')).toBeVisible({
        timeout: 15_000,
      });
      await expectBrowserHidden(electronApp);

      // Opening an archived item stacks its viewer on the same overlay slot.
      await window.getByTestId(`archived-overview-open-${ARCHIVED_ID}`).click();
      await expect(window.getByTestId('archived-container-view')).toBeVisible({
        timeout: 15_000,
      });
      await expectBrowserHidden(electronApp);
      await window.getByTestId('archived-container-view-close').click();
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await expectBrowserHidden(electronApp);

      // Leaving the overview brings the Browser back.
      await window.getByTestId('archived-overview-back').click();
      await expect(window.getByTestId('archived-overview-page')).toHaveCount(0);
      await expectBrowserShown(electronApp);

      await app.openSettings();
      await expectBrowserHidden(electronApp);
      await app.closeSettings();
      await expectBrowserShown(electronApp);

      await app.openPluginsPage();
      await expectBrowserHidden(electronApp);
      await app.openMainPage();
      await expectBrowserShown(electronApp);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await fixture.close();
    }
  });
});
