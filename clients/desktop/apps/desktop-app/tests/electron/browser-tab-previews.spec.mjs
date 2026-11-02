// Standard browser tab previews. Resting on a background browser tab
// opens the shared browser preview card
// in the chat card's layout: the page title in the chip, the last capture of
// the page, and its host and path. The capture comes from the frame the
// visible pane took after the page loaded; no extra capture is requested.
//
// Run after building the implementation:
//   pnpm run test:electron:built browser-tab-previews.spec.mjs --reporter=line
//
// Determinism: a local fixture page with a fixed title; no network.

import http from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
} from './panelHarness.mjs';

const PAGE_TITLE = 'Browser tab preview fixture';
// seedPanelWorktree's default demo worktree.
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
// Long enough for the pane's after-load frame (500ms) to land.
const PAGE_SETTLE_MS = 1_500;
// The native layer the above-browser mirror draws marked overlays into.
const LAYER_TITLE = 'Above browser';

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${PAGE_TITLE}</title></head>
        <body style="margin:0;min-height:100vh;background:#3aa6d8">
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
    host: `127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function openBackgroundBrowserTab(window, fixture) {
  const { browser, panelId } = await seedVisibleBrowserPanel(
    window,
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, url: fixture.url },
    { moveToGroupId: DEFAULT_GROUP_IDS.chat },
  );
  const tab = window.getByTestId(`panel-tab-${panelId}`);
  await expect(tab).toBeVisible();
  await expect(tab).toContainText(PAGE_TITLE, { timeout: 20_000 });
  await window.waitForTimeout(PAGE_SETTLE_MS);
  // Back to the chat: the browser tab is now in the background.
  const chatTab = window.getByTestId(
    `panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`,
  );
  await chatTab.click();
  await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  return { browser, panelId, tab };
}

/**
 * Whether the page's and the above-browser layer's native views show, by
 * title, with the shown ones' window rectangles.
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
          if (title === pageTitle && (shown || found.page === undefined)) {
            found.page = shown;
            if (shown) found.pageRect = rect;
          }
          if (title === layerTitle) {
            found.layer = shown;
            if (shown) found.layerRect = rect;
          }
          visit(child, rect.x, rect.y, shown);
        }
      };
      for (const win of BrowserWindow.getAllWindows()) {
        visit(win.contentView, 0, 0, true);
      }
      return found;
    },
    { pageTitle: PAGE_TITLE, layerTitle: LAYER_TITLE },
  );
}

/** Opaque pixels the above-browser layer paints. */
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

async function rest(window, tab) {
  // Park the pointer elsewhere first so each rest is a fresh hover, then
  // move onto the label in steps, as a hand does: a single jump can arrive
  // without the enter event a real pointer gives the card's trigger.
  await window.mouse.move(5, 400);
  const box = await tab.locator('.canopy-panel-tab-title').boundingBox();
  if (!box) throw new Error('The tab label has no box');
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 8,
  });
}

test('a background browser tab previews its page while Tab previews is on', async () => {
  test.setTimeout(180_000);
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const { panelId, tab } = await openBackgroundBrowserTab(window, fixture);

    await rest(window, tab);
    const card = window.getByTestId(`panel-tab-hover-card-${panelId}`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('browser-tab-preview-title')).toHaveText(
      PAGE_TITLE,
    );
    await expect(card.getByTestId('browser-tab-preview-url')).toHaveText(
      fixture.host,
    );
    const image = card.getByTestId('browser-tab-preview-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    // The capture is scaled to the card, not kept at the pane's size.
    expect(
      await image.evaluate((element) => [
        element.naturalWidth,
        element.naturalHeight,
      ]),
    ).toEqual([544, 306]);

    // Same surface and width as the chat tab card.
    const box = await card.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(280);

    // Moving from the title onto close keeps the same page preview open.
    await window.getByTestId(`panel-tab-close-${panelId}`).hover();
    await window.waitForTimeout(1_000);
    await expect(card).toBeVisible();

    // Leaving the tab closes it.
    await window.mouse.move(5, 400);
    await expect(card).toBeHidden();

    await tab.hover();
    await window.getByTestId(`panel-tab-close-${panelId}`).click();
    await expect(tab).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

test('a tab card over the live Browser page draws above it without freezing it', async () => {
  test.setTimeout(180_000);
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const { tab } = await openBackgroundBrowserTab(window, fixture);
    // Show the Browser, so the chat tab is the background one and its card
    // hangs over the live page.
    await tab.click();
    await expect
      .poll(async () => (await nativeViews(electronApp)).page, {
        timeout: 20_000,
      })
      .toBe(true);
    const chatTab = window.getByTestId(
      `panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`,
    );
    await rest(window, chatTab);
    await expect(
      window.getByTestId(
        `panel-tab-hover-card-panel-chat-${SEEDED_CHAT_TAB_ID}`,
      ),
    ).toBeVisible();
    // Drawn in the layer above the page; the page itself stays live.
    await expect
      .poll(async () => (await nativeViews(electronApp)).layer, {
        timeout: 5_000,
      })
      .toBe(true);
    await expect.poll(() => layerPaintedPixels(electronApp)).toBeGreaterThan(0);
    expect((await nativeViews(electronApp)).page).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

test('moving between tabs over the live Browser page slides the visible copy', async () => {
  test.setTimeout(180_000);
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // Two browser tabs beside the chat; show the first, so the chat and the
    // second browser are the background tabs and their cards hang over the
    // live page.
    const first = await openBackgroundBrowserTab(window, fixture);
    const second = await openBackgroundBrowserTab(window, fixture);
    await first.tab.click();
    await expect
      .poll(async () => (await nativeViews(electronApp)).page, {
        timeout: 20_000,
      })
      .toBe(true);
    const chatTab = window.getByTestId(
      `panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`,
    );
    await rest(window, chatTab);
    await expect(
      window.getByTestId(
        `panel-tab-hover-card-panel-chat-${SEEDED_CHAT_TAB_ID}`,
      ),
    ).toBeVisible();
    await expect
      .poll(async () => (await nativeViews(electronApp)).layer, {
        timeout: 5_000,
      })
      .toBe(true);
    // Count animations started on copies in the above-browser layer from
    // here on. A copy is cloned in the app window and moved into the layer's
    // document, so it keeps the app window's prototype: count there, for
    // elements that are not in the app's own document.
    await window.evaluate(() => {
      window.__copySlides = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.ownerDocument !== document) window.__copySlides += 1;
        return animate.apply(this, args);
      };
    });
    // Straight across to the neighbouring browser tab, as a hand moves.
    const box = await second.tab
      .locator('.canopy-panel-tab-title')
      .boundingBox();
    if (!box) throw new Error('The tab label has no box');
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 6,
    });
    await expect(
      window.getByTestId(`panel-tab-hover-card-${second.panelId}`),
    ).toBeVisible();
    // The copy the user sees slides over too, not only the hidden original.
    await expect
      .poll(() => window.evaluate(() => window.__copySlides))
      .toBeGreaterThan(0);
    // And it stays whole: wherever the card overlaps the page, the layer
    // covers it, during the slide and where it lands.
    const card = window.getByTestId(`panel-tab-hover-card-${second.panelId}`);
    const covered = async () => {
      const views = await nativeViews(electronApp);
      const box = await card.boundingBox();
      const page = views.pageRect;
      const layer = views.layerRect;
      if (!box || !page || !layer) return false;
      const left = Math.max(box.x, page.x);
      const right = Math.min(box.x + box.width, page.x + page.width);
      const top = Math.max(box.y, page.y);
      const bottom = Math.min(box.y + box.height, page.y + page.height);
      if (right <= left || bottom <= top) return true;
      return (
        layer.x <= left + 1 &&
        layer.x + layer.width >= right - 1 &&
        layer.y <= top + 1 &&
        layer.y + layer.height >= bottom - 1
      );
    };
    await expect.poll(covered, { intervals: [20], timeout: 2_000 }).toBe(true);
    await window.waitForTimeout(400);
    await expect.poll(covered).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
