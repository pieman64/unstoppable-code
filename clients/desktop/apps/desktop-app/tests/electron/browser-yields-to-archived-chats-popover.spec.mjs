// The Browser panel is a native WebContentsView drawn above the page. When
// the worktree header's Archived chats popover drops over a Browser pane, the
// view must yield (freeze frame or hidden) so the whole card stays readable.
//
// Determinism: the worktree and its chats are seeded on disk; closing a chat
// with messages archives it through the real main-process IPC handlers. The
// Browser loads a local fixture page.

import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const WORKSPACE_ID = `demo-${APP}`;
const BRANCH = 'demo-main';
const KEEPER_TAB_ID = 'keeper';
// Like the reported case, enough archived chats for the card to reach past
// the Browser's toolbar into its page area.
const ARCHIVE_TAB_IDS = ['archive-1', 'archive-2', 'archive-3', 'archive-4'];
const BROWSER_PAGE_TITLE = 'Browser under archived chats popover fixture';
const T = Date.parse('2026-04-10T12:00:00.000Z');

function buildMessages(label) {
  return [
    {
      id: `${label}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Question for ${label}.` }],
      timestamp: T,
    },
    {
      id: `${label}-assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `Answer for ${label}.` }],
      timestamp: T + 10_000,
    },
  ];
}

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${BROWSER_PAGE_TITLE}</title></head>
        <body style="margin:0;background:#101010;min-height:100vh">
          <h1 style="color:#eee">${BROWSER_PAGE_TITLE}</h1>
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

async function launchWithArchivedChat() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-archive-popover-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  const nowIso = new Date().toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: BRANCH,
    providerType: 'claude',
    activeTabId: KEEPER_TAB_ID,
    tabs: [KEEPER_TAB_ID, ...ARCHIVE_TAB_IDS].map((id) => ({
      id,
      title: id === KEEPER_TAB_ID ? 'Keeper' : `Archived ${id}`,
      providerType: 'claude',
      createdAt: nowIso,
      messages: buildMessages(id),
    })),
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  const { window } = launched;
  // Closing a chat with messages archives it.
  for (const id of ARCHIVE_TAB_IDS) {
    await expect(window.getByTestId(`panel-tab-panel-chat-${id}`)).toBeVisible({
      timeout: 20_000,
    });
    await closePanelTab(window, `panel-chat-${id}`);
    await expect(window.getByTestId(`panel-tab-panel-chat-${id}`)).toHaveCount(
      0,
    );
  }
  await expect(
    window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(window.getByTestId('chat-tab-archive-count')).toHaveText(
    String(ARCHIVE_TAB_IDS.length),
    { timeout: 15_000 },
  );
  return { ...launched, userDataDir };
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

/** Adds a Browser tab to the group under the header's right edge. */
async function addBrowserPanelUnderArchiveControl(window) {
  const before = new Set(await browserPanelIds(window));
  const archive = await window
    .getByTestId('pr-status-bar')
    .getByTestId('chat-tab-archive')
    .boundingBox();
  expect(archive).not.toBeNull();
  // The topmost group whose title bar spans the control's x position.
  const groupId = await window.evaluate(
    ({ x }) => {
      const prefix = 'panel-group-title-';
      const titles = [
        ...document.querySelectorAll(`[data-testid^="${prefix}"]`),
      ]
        .map((title) => ({
          id: title.getAttribute('data-testid').slice(prefix.length),
          rect: title.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.left <= x && rect.right >= x)
        .sort((a, b) => a.rect.top - b.rect.top);
      return titles[0]?.id ?? null;
    },
    { x: archive.x + archive.width / 2 },
  );
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

// Both looks: the classic popover and the Labs Archived chats card, whose
// shared menu surface sits in the same dropdown layer.
for (const look of ['classic', 'card']) {
  test(`the native Browser view yields to the header Archived chats popover (${look})`, async () => {
    test.setTimeout(180_000);
    const fixture = await startLocalPage();
    const { electronApp, userDataDir, window } = await launchWithArchivedChat();
    try {
      if (look === 'card') {
        await window.evaluate(() =>
          window.api.experiments.setChoice({
            experimentId: 'archived-chats-card',
            enabled: true,
          }),
        );
      }
      const browserId = await addBrowserPanelUnderArchiveControl(window);
      const pane = window.getByTestId(`browser-pane-${browserId}`);
      const urlInput = pane.getByTestId('browser-url-input');
      await urlInput.fill(fixture.url);
      await urlInput.press('Enter');
      await expect
        .poll(() => fixtureViewVisible(electronApp), { timeout: 15_000 })
        .toBe(true);

      await window
        .getByTestId('pr-status-bar')
        .getByTestId('chat-tab-archive')
        .hover();
      const popover = window.getByTestId('chat-tab-archive-popover');
      await expect(popover).toBeVisible();
      await expect(
        popover.getByRole('group', { name: 'Archived chats' }),
      ).toHaveCount(look === 'card' ? 1 : 0);
      // Precondition: the card really drops over the page area, where the
      // native view is drawn (not just the Browser's toolbar).
      const [popoverBox, pageBox] = await Promise.all([
        popover.boundingBox(),
        pane.getByTestId('browser-page-area').boundingBox(),
      ]);
      expect(popoverBox).not.toBeNull();
      expect(pageBox).not.toBeNull();
      expect(popoverBox.y + popoverBox.height).toBeGreaterThan(pageBox.y + 20);
      expect(popoverBox.x).toBeLessThan(pageBox.x + pageBox.width);
      expect(popoverBox.x + popoverBox.width).toBeGreaterThan(pageBox.x);

      await expect
        .poll(() => fixtureViewVisible(electronApp), { timeout: 5_000 })
        .toBe(false);

      // Moving away closes the card and brings the live view back.
      await window.mouse.move(2, 2);
      await expect(popover).toHaveCount(0);
      await expect
        .poll(() => fixtureViewVisible(electronApp), { timeout: 15_000 })
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await fixture.close();
    }
  });
}
