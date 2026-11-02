// The Browser page is a native WebContentsView drawn above the app, so no CSS
// z-index reaches above it. Two paths keep app overlays visible over it:
//
// - Overlays nobody clicks into (tooltips, hover cards, the panel resize
//   handle) carry `data-canopy-above-browser`. Wherever they overlap a page,
//   a copy is drawn in the transparent `above-browser` native layer raised
//   above every browser view, while the page stays live underneath.
// - Menus and popovers freeze the page to a snapshot. One opened on hover
//   (the header Archived chats popover) or by a right-click must cover the
//   page in the first frame it is on screen, not after a capture round trip.
//
// Determinism: the worktree and its chats are seeded on disk, closing a chat
// with messages archives it through the real IPC handlers, and the Browser
// loads a local fixture page with a striped background.

import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { movePanelViaApi, seedPanelWorktree } from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const WORKSPACE_ID = `demo-${APP}`;
const BRANCH = 'demo-main';
const KEEPER_TAB_ID = 'keeper';
const ARCHIVE_TAB_IDS = ['archive-1', 'archive-2', 'archive-3', 'archive-4'];
const PAGE_TITLE = 'Browser overlays above page fixture';
const LAYER_TITLE = 'Above browser';
// Past the freeze frame's one-second prefetch window, so the last frame is
// stale when the next overlay opens.
const STALE_FRAME_WAIT_MS = 1_500;
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
        <head><title>${PAGE_TITLE}</title></head>
        <body style="margin:0;min-height:100vh;background:repeating-linear-gradient(90deg,#f2b632 0 48px,#3aa6d8 48px 96px)">
          <h1>${PAGE_TITLE}</h1>
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

async function launch() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-above-page-'),
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
  for (const id of ARCHIVE_TAB_IDS) {
    await expect(window.getByTestId(`panel-tab-panel-chat-${id}`)).toBeVisible({
      timeout: 20_000,
    });
    await closePanelTab(window, `panel-chat-${id}`);
  }
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

/** Adds a Browser tab to the group under the header's Archived control. */
async function addBrowser(window, url) {
  const before = new Set(await browserPanelIds(window));
  const archive = await window
    .getByTestId('pr-status-bar')
    .getByTestId('chat-tab-archive')
    .boundingBox();
  const groupId = await window.evaluate(
    ({ x }) => {
      const prefix = 'panel-group-title-';
      return [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
        .map((title) => ({
          id: title.getAttribute('data-testid').slice(prefix.length),
          rect: title.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.left <= x && rect.right >= x)
        .sort((a, b) => a.rect.top - b.rect.top)[0]?.id;
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
  let browserId;
  await expect
    .poll(async () => {
      browserId = (await browserPanelIds(window)).find((id) => !before.has(id));
      return Boolean(browserId);
    })
    .toBe(true);
  const pane = window.getByTestId(`browser-pane-${browserId}`);
  await expect(pane).toHaveAttribute('data-browser-state', 'live', {
    timeout: 30_000,
  });
  const urlInput = pane.getByTestId('browser-url-input');
  await urlInput.fill(url);
  await urlInput.press('Enter');
  return { browserId, groupId, pane };
}

/**
 * Main-process state of the fixture page's view and the above-browser layer:
 * visibility and window-relative bounds (window DIPs).
 */
function nativeViews(electronApp) {
  return electronApp.evaluate(
    ({ BrowserWindow }, { pageTitle, layerTitle }) => {
      const found = {};
      const visit = (view, offsetX, offsetY, visible) => {
        for (const child of view?.children ?? []) {
          const own = child.getBounds();
          const rect = {
            x: own.x + offsetX,
            y: own.y + offsetY,
            width: own.width,
            height: own.height,
          };
          const shown = visible && child.getVisible();
          const title = child.webContents?.isDestroyed()
            ? null
            : child.webContents?.getTitle();
          if (title === pageTitle) found.page = { rect, visible: shown };
          if (title === layerTitle) found.layer = { rect, visible: shown };
          visit(child, rect.x, rect.y, shown);
        }
      };
      for (const win of BrowserWindow.getAllWindows()) {
        found.zoom = win.webContents.getZoomFactor();
        visit(win.contentView, 0, 0, true);
      }
      return found;
    },
    { pageTitle: PAGE_TITLE, layerTitle: LAYER_TITLE },
  );
}

/** Opaque pixels the layer paints, counted on its own capture. */
function layerPaintedPixels(electronApp) {
  return electronApp.evaluate(async ({ webContents }, title) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => !item.isDestroyed() && item.getTitle() === title);
    if (!contents) return 0;
    const bitmap = (await contents.capturePage()).toBitmap();
    let painted = 0;
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] > 200) painted += 1;
    }
    return painted;
  }, LAYER_TITLE);
}

function overlaps(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Watches for `selector` to enter the DOM and counts the frames, from the
 * first one it is on screen, until it shows over the Browser page: the pane
 * shows its freeze frame in place of the live view, or the above-browser
 * mirror draws the overlay over the live page while that frame is captured.
 * `null` if that takes more than a second.
 */
async function watchCoverFrames(window, selector) {
  await window.evaluate((watched) => {
    window.__overlayCoverFrames = undefined;
    const covered = () =>
      document.querySelector('[data-testid="browser-pane-freeze-frame"]') !==
        null ||
      document
        .querySelector(watched)
        ?.closest('[data-above-browser-copied="true"]') != null ||
      document.querySelector(
        `${watched} [data-above-browser-copied="true"], [data-above-browser-copied="true"] ${watched}`,
      ) !== null;
    const count = (frames) => {
      if (covered()) {
        window.__overlayCoverFrames = frames;
      } else if (frames >= 60) {
        window.__overlayCoverFrames = null;
      } else {
        requestAnimationFrame(() => count(frames + 1));
      }
    };
    const observer = new MutationObserver(() => {
      if (!document.querySelector(watched)) return;
      observer.disconnect();
      requestAnimationFrame(() => count(0));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, selector);
}

function coverFrames(window) {
  return window.evaluate(() => window.__overlayCoverFrames);
}

test('overlays over the Browser draw above the page from their first frame', async () => {
  test.setTimeout(240_000);
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await launch();
  try {
    const { browserId, groupId, pane } = await addBrowser(window, fixture.url);
    await expect
      .poll(async () => (await nativeViews(electronApp)).page?.visible, {
        timeout: 20_000,
      })
      .toBe(true);
    // A first frame is taken once the page has settled after loading.
    await expect(
      pane.getByTestId('browser-pane-freeze-frame-ready'),
    ).toHaveCount(1, { timeout: 10_000 });

    // The header Archived chats popover opens on hover, with no press, once
    // the last frame is too old to count as current: a newer one is taken.
    await window.mouse.move(2, 400);
    await window.waitForTimeout(STALE_FRAME_WAIT_MS);
    await watchCoverFrames(window, '[data-testid="chat-tab-archive-popover"]');
    await window
      .getByTestId('pr-status-bar')
      .getByTestId('chat-tab-archive')
      .hover();
    await expect(window.getByTestId('chat-tab-archive-popover')).toBeVisible();
    await expect.poll(() => coverFrames(window)).not.toBeUndefined();
    console.log(`[above-page] cover frames: ${await coverFrames(window)}`);
    // Shown over the page within the frames detection takes, not after the
    // newer frame's capture round trip.
    expect(await coverFrames(window)).toBeLessThanOrEqual(2);
    await expect
      .poll(async () => (await nativeViews(electronApp)).page?.visible)
      .toBe(false);
    await window.mouse.move(2, 400);
    await expect(window.getByTestId('chat-tab-archive-popover')).toHaveCount(0);
    await expect
      .poll(async () => (await nativeViews(electronApp)).page?.visible, {
        timeout: 15_000,
      })
      .toBe(true);

    // The Browser tab's right-click menu, again over a stale frame.
    const tab = window.getByTestId(`panel-tab-panel-browser-${browserId}`);
    await window.waitForTimeout(STALE_FRAME_WAIT_MS);
    await watchCoverFrames(window, '[role="menu"]');
    await tab.click({ button: 'right' });
    await expect(window.getByRole('menu')).toBeVisible();
    await expect.poll(() => coverFrames(window)).not.toBeUndefined();
    console.log(`[above-page] cover frames: ${await coverFrames(window)}`);
    // Shown over the page within the frames detection takes, not after the
    // newer frame's capture round trip.
    expect(await coverFrames(window)).toBeLessThanOrEqual(2);
    // Every item, the top ones over the Browser toolbar included, is the
    // menu's own at its center: nothing in the app paints over it.
    const hiddenItems = await window.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .filter((item) => {
          const rect = item.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return !(hit && item.contains(hit));
        })
        .map((item) => item.textContent?.trim()),
    );
    expect(hiddenItems).toEqual([]);
    await window.keyboard.press('Escape');
    await expect
      .poll(async () => (await nativeViews(electronApp)).page?.visible, {
        timeout: 15_000,
      })
      .toBe(true);

    // The Browser in its own card, right of the chat card.
    await movePanelViaApi(
      window,
      `panel-browser-${browserId}`,
      groupId,
      'right',
    );
    const pageArea = pane.getByTestId('browser-page-area');
    await expect
      .poll(async () => (await pageArea.boundingBox())?.x ?? 0)
      .toBeGreaterThan(500);
    await expect
      .poll(async () => (await nativeViews(electronApp)).page?.visible, {
        timeout: 15_000,
      })
      .toBe(true);
    const pageBox = await pageArea.boundingBox();

    // A tooltip-like overlay marked to draw above the page, half over it.
    await window.evaluate(
      ({ x, y }) => {
        const tip = document.createElement('div');
        tip.dataset.testid = 'above-page-probe';
        tip.setAttribute('data-canopy-above-browser', 'true');
        tip.className = 'fixed z-tooltip rounded-md bg-quaternary px-2 py-1';
        tip.style.left = `${x - 40}px`;
        tip.style.top = `${y + 60}px`;
        tip.style.width = '160px';
        tip.style.height = '40px';
        tip.style.background = '#ffffff';
        document.body.appendChild(tip);
      },
      { x: pageBox.x, y: pageBox.y },
    );
    await expect
      .poll(async () => {
        const views = await nativeViews(electronApp);
        return {
          pageLive: views.page?.visible === true,
          layerShown: views.layer?.visible === true,
          layerOverPage:
            views.layer !== undefined &&
            views.page !== undefined &&
            overlaps(views.layer.rect, views.page.rect),
        };
      })
      .toEqual({ pageLive: true, layerShown: true, layerOverPage: true });
    await expect.poll(() => layerPaintedPixels(electronApp)).toBeGreaterThan(0);
    // No freeze frame: the page under it stays live.
    await expect(pane.getByTestId('browser-pane-freeze-frame')).toHaveCount(0);
    await window.evaluate(() =>
      document.querySelector('[data-testid="above-page-probe"]')?.remove(),
    );
    await expect
      .poll(async () => (await nativeViews(electronApp)).layer?.visible)
      .toBe(false);

    // The resize handle between the cards: its thumb overhangs the page.
    const sash = await window.evaluate((page) => {
      const rect = [...document.querySelectorAll('.canopy-sash.vertical')]
        .map((element) => element.getBoundingClientRect())
        .find(
          (candidate) =>
            candidate.height > 0 &&
            Math.abs(candidate.left + candidate.width / 2 - page.x) < 16,
        );
      return rect
        ? { x: rect.x + rect.width / 2, y: page.y + page.height / 2 }
        : null;
    }, pageBox);
    expect(sash).not.toBeNull();
    await window.mouse.move(sash.x - 40, sash.y);
    await window.mouse.move(sash.x, sash.y, { steps: 5 });
    await expect
      .poll(async () => {
        const views = await nativeViews(electronApp);
        return {
          pageLive: views.page?.visible === true,
          layerShown: views.layer?.visible === true,
        };
      })
      .toEqual({ pageLive: true, layerShown: true });
    await expect.poll(() => layerPaintedPixels(electronApp)).toBeGreaterThan(0);
    // The layer stays over the page: it starts at the page's left edge, so
    // the handle's other half (over the chat card) is the app's own.
    const hovered = await nativeViews(electronApp);
    expect(
      Math.abs(hovered.layer.rect.x - hovered.page.rect.x),
    ).toBeLessThanOrEqual(1);

    // Drag the divider: the page stays exactly inside its card.
    await window.mouse.down();
    await window.mouse.move(sash.x - 120, sash.y, { steps: 12 });
    await window.mouse.up();
    await window.mouse.move(sash.x - 300, sash.y);
    await expect
      .poll(async () => (await nativeViews(electronApp)).layer?.visible)
      .toBe(false);
    await expect
      .poll(
        async () => {
          const [area, views] = await Promise.all([
            pageArea.boundingBox(),
            nativeViews(electronApp),
          ]);
          if (!area || !views.page?.visible) return 'page hidden';
          const zoom = views.zoom ?? 1;
          const page = views.page.rect;
          const near = (a, b) => Math.abs(a - b) <= 1.5;
          return near(page.x, area.x * zoom) &&
            near(page.y, area.y * zoom) &&
            near(page.width, area.width * zoom) &&
            near(page.height, area.height * zoom)
            ? 'aligned'
            : JSON.stringify({ page, area, zoom });
        },
        { timeout: 10_000 },
      )
      .toBe('aligned');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
