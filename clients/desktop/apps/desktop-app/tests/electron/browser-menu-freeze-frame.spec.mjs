// The Browser page is a native WebContentsView drawn above the app. A menu
// that opens over it (the Browser tab's right-click menu, the ••• menu) has
// the page swapped for a freeze frame. The page must look the same the whole
// time the menu opens, stays open and closes: no empty, recoloured or
// swapped frame. Pointing at a control first captures the frame ahead, so the
// menu does not wait on a capture round trip.
//
// Frame check: capture the renderer immediately after the native view hides,
// then repeatedly while it stays hidden. Compare actual sampled pixels with
// the live page, cell by cell, away from the menu. A CDP screencast is sparse
// and buffered: carrying its previous sample forward to hide time invents
// stale frames. These captures do not prove absence of sub-capture flashes.
//
// Determinism: a local fixture page with a bright striped background, so an
// empty page area can never pass for it; main-process view calls are
// recorded by wrapping the view prototype methods.

import http from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
} from './panelHarness.mjs';

const PAGE_TITLE = 'Browser menu freeze frame fixture';
const CAPTURE_DELAY_MS = 1_500;
// Time for the page to settle after it has loaded, so a frame taken after
// the load (when the app takes one) is ready before the first menu.
const PAGE_SETTLE_MS = 1_500;
// Page-area comparison grid, and the per-cell mean difference (0-255) that
// counts as a different picture. Blank versus the striped page is ~100+.
const GRID_COLUMNS = 24;
const GRID_ROWS = 16;
const CELL_TOLERANCE = 24;
// Room around the menu for its shadow and open animation, in CSS px.
const MENU_MARGIN = 24;
// seedPanelWorktree's default demo worktree.
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${PAGE_TITLE}</title></head>
        <body style="margin:0;min-height:100vh;color:#111;background:repeating-linear-gradient(90deg,#f2b632 0 48px,#3aa6d8 48px 96px)">
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
  }, PAGE_TITLE);
}

/** Records the fixture view's visibility and capture calls in main. */
async function recordMainViewCalls(electronApp) {
  const hooked = await electronApp.evaluate(({ BrowserWindow }, title) => {
    const now = () => performance.timeOrigin + performance.now();
    globalThis.__menuFreezeLog = [];
    globalThis.__menuFreezeFrames = [];
    let found = null;
    let renderer = null;
    const visit = (view) => {
      for (const child of view?.children ?? []) {
        if (child.webContents?.getTitle() === title) found = child;
        visit(child);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView);
      if (found) {
        renderer = browserWindow.webContents;
        break;
      }
    }
    if (!found) return false;
    const owner = (object, name) => {
      let proto = object;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) {
        proto = Object.getPrototypeOf(proto);
      }
      return proto;
    };
    const isFixture = (contents) => {
      try {
        return contents?.getTitle?.() === title;
      } catch {
        return false;
      }
    };
    const viewProto = owner(found, 'setVisible');
    const setVisible = viewProto.setVisible;
    let shown = true;
    let generation = 0;
    const sampleHiddenRenderer = async (epoch, hideAt) => {
      if (shown || generation !== epoch) return;
      const t = now();
      try {
        // Capture the renderer that covers the native page, not the page
        // itself (which would always match the reference).
        const image = await renderer.capturePage();
        globalThis.__menuFreezeFrames.push({
          t,
          end: now(),
          hideAt,
          data: image.toPNG().toString('base64'),
        });
      } catch (error) {
        globalThis.__menuFreezeFrames.push({
          t,
          end: now(),
          error: String(error),
        });
      }
      if (!shown && generation === epoch) {
        setTimeout(() => void sampleHiddenRenderer(epoch, hideAt), 16);
      }
    };
    viewProto.setVisible = function (visible) {
      const result = setVisible.call(this, visible);
      if (isFixture(this.webContents)) {
        const t = now();
        globalThis.__menuFreezeLog.push({ k: 'visible', t, visible });
        shown = visible;
        generation += 1;
        if (!visible) void sampleHiddenRenderer(generation, t);
      }
      return result;
    };
    const contentsProto = owner(found.webContents, 'capturePage');
    const capturePage = contentsProto.capturePage;
    contentsProto.capturePage = async function (...args) {
      const start = now();
      // Set by a test to stand in for a busy main process.
      const delay = isFixture(this)
        ? (globalThis.__menuFreezeCaptureDelay ?? 0)
        : 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const image = await capturePage.apply(this, args);
      if (isFixture(this)) {
        globalThis.__menuFreezeLog.push({ k: 'capture', t: start, end: now() });
      }
      return image;
    };
    return true;
  }, PAGE_TITLE);
  expect(hooked).toBe(true);
}

/** Makes captures that start from now on slow (0 restores). */
async function setCaptureDelay(electronApp, delay) {
  await electronApp.evaluate((_electron, value) => {
    globalThis.__menuFreezeCaptureDelay = value;
  }, delay);
}

async function takeMainViewCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__menuFreezeLog.splice(0));
}

/** Records pointer presses and freeze-frame mount/paint/unmount times. */
async function recordRendererEvents(window) {
  await window.evaluate(() => {
    const now = () => performance.timeOrigin + performance.now();
    const events = [];
    window.__menuFreezeEvents = events;
    window.addEventListener(
      'pointerdown',
      () => events.push({ k: 'pointerdown', t: now() }),
      true,
    );
    const selector = '[data-testid^="browser-pane-freeze-frame"]';
    const matches = (node) =>
      node instanceof Element &&
      (node.matches(selector) || node.querySelector(selector) !== null);
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!matches(node)) return;
          const image = node.matches(selector)
            ? node
            : node.querySelector(selector);
          void image
            .decode()
            .catch(() => undefined)
            .then(() => events.push({ k: 'frame-decoded', t: now() }));
        });
        record.removedNodes.forEach((node) => {
          if (matches(node)) events.push({ k: 'frame-removed', t: now() });
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function takeRendererEvents(window) {
  return window.evaluate(() => window.__menuFreezeEvents.splice(0));
}

async function takeRendererFrames(electronApp) {
  return electronApp.evaluate(() => globalThis.__menuFreezeFrames.splice(0));
}

/** The fixture page as the native view draws it, as a base64 PNG. */
/** Changes what the fixture page shows, as scrolling or typing would. */
async function changeFixturePage(electronApp) {
  await electronApp.evaluate(async ({ BrowserWindow }, title) => {
    let found = null;
    const visit = (view) => {
      for (const child of view?.children ?? []) {
        if (child.webContents?.getTitle() === title) found = child;
        visit(child);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView);
    }
    await found.webContents.executeJavaScript(
      "document.body.style.background = 'repeating-linear-gradient(0deg,#1d7a3a 0 40px,#c23a6b 40px 80px)'",
    );
  }, PAGE_TITLE);
}

async function capturePageReference(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }, title) => {
    let found = null;
    const visit = (view) => {
      for (const child of view?.children ?? []) {
        if (child.webContents?.getTitle() === title) found = child;
        visit(child);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView);
    }
    const image = await found.webContents.capturePage();
    return image.toPNG().toString('base64');
  }, PAGE_TITLE);
}

/**
 * Average RGB per grid cell of each image's crop (device px), computed with
 * Electron's image scaler in main.
 */
async function cellColors(electronApp, items) {
  return electronApp.evaluate(
    ({ nativeImage }, { list, columns, rows }) =>
      list.map(({ png, crop }) => {
        let image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
        if (crop) image = image.crop(crop);
        const bitmap = image
          .resize({ width: columns, height: rows, quality: 'better' })
          .toBitmap();
        const cells = [];
        for (let i = 0; i < columns * rows; i += 1) {
          // BGRA
          cells.push([bitmap[i * 4 + 2], bitmap[i * 4 + 1], bitmap[i * 4]]);
        }
        return cells;
      }),
    { list: items, columns: GRID_COLUMNS, rows: GRID_ROWS },
  );
}

/**
 * Opens a menu over the page and closes it again. The page area must show
 * the page, unchanged, in sampled frames until the live page is
 * back; the menu opens on the frame taken while pointing at the control.
 */
async function samplePageDifferences(
  { electronApp, window },
  target,
  press,
  { pointFirst = true, captureDelay = CAPTURE_DELAY_MS } = {},
) {
  await window.mouse.move(2, 300);
  await expect.poll(() => fixtureViewVisible(electronApp)).toBe(true);
  const reference = await capturePageReference(electronApp);
  const pageArea = await window
    .getByTestId('browser-page-area')
    .first()
    .boundingBox();
  const cssWidth = await window.evaluate(() => window.innerWidth);
  await takeMainViewCalls(electronApp);
  await takeRendererEvents(window);
  await takeRendererFrames(electronApp);

  if (pointFirst) {
    // Pointing at the control captures the page ahead of time.
    await target.hover();
    await window.waitForTimeout(400);
  }
  // Delay new page captures: the menu must cover the page before that delay
  // expires, using the frame already captured before the press.
  await setCaptureDelay(electronApp, captureDelay);
  await press(target);
  const menu = window.getByRole('menu').first();
  await expect(menu).toBeVisible();
  await expect.poll(() => fixtureViewVisible(electronApp)).toBe(false);
  // Keep the menu open until the sampler has completed its required frames.
  // A fixed 300 ms window can yield only one capture on a loaded CI runner.
  await expect
    .poll(
      () =>
        electronApp.evaluate(() => {
          const hidden = globalThis.__menuFreezeLog.find(
            (event) => event.k === 'visible' && !event.visible,
          );
          return globalThis.__menuFreezeFrames.filter(
            (frame) => frame.hideAt === hidden?.t && !frame.error,
          ).length;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(2);
  const menuBox = await menu.boundingBox();
  await window.keyboard.press('Escape');
  await expect(window.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => fixtureViewVisible(electronApp)).toBe(true);
  await window.waitForTimeout(300);
  const frames = await takeRendererFrames(electronApp);
  await setCaptureDelay(electronApp, 0);

  const main = await takeMainViewCalls(electronApp);
  const events = await takeRendererEvents(window);
  const pressed = events.find((event) => event.k === 'pointerdown');
  const visibility = main.filter((event) => event.k === 'visible');
  const hidden = visibility.find((event) => !event.visible);
  expect(pressed).toBeDefined();
  expect(hidden).toBeDefined();
  // The page was covered without waiting on a slow capture: with one, by
  // the frame taken while pointing.
  expect(hidden.t - pressed.t).toBeLessThan(CAPTURE_DELAY_MS);
  expect(frames.length).toBeGreaterThan(0);

  expect(frames.filter((frame) => frame.error)).toEqual([]);
  // Only compare captures requested and completed in one hidden interval.
  // Never extrapolate a prior sample over a visibility transition.
  const lastShown = visibility.at(-1);
  expect(lastShown?.visible).toBe(true);
  const visibleAt = (t) => {
    let visible = true;
    for (const event of visibility) if (event.t <= t) visible = event.visible;
    return visible;
  };
  const used = frames.filter(
    (frame) =>
      frame.t >= pressed.t &&
      !visibleAt(frame.t) &&
      !visibility.some(
        (event) => event.visible && event.t > frame.t && event.t <= frame.end,
      ),
  );
  expect(used.length).toBeGreaterThan(2);
  // The immediate post-hide capture must be present, not only later samples.
  expect(used[0]).toBe(frames.find((frame) => frame.hideAt === hidden.t));

  const scale =
    Buffer.from(frames[0].data, 'base64').readUInt32BE(16) / cssWidth;
  const crop = {
    x: Math.round(pageArea.x * scale),
    y: Math.round(pageArea.y * scale),
    width: Math.round(pageArea.width * scale),
    height: Math.round(pageArea.height * scale),
  };
  const [referenceCells, ...frameCells] = await cellColors(electronApp, [
    { png: reference },
    ...used.map((frame) => ({ png: frame.data, crop })),
  ]);
  // Cells clear of the menu (and of the rounded outer edge).
  const cellWidth = pageArea.width / GRID_COLUMNS;
  const cellHeight = pageArea.height / GRID_ROWS;
  const compared = [];
  for (let row = 1; row < GRID_ROWS - 1; row += 1) {
    for (let column = 1; column < GRID_COLUMNS - 1; column += 1) {
      const left = pageArea.x + column * cellWidth;
      const top = pageArea.y + row * cellHeight;
      const clearOfMenu =
        left + cellWidth < menuBox.x - MENU_MARGIN ||
        left > menuBox.x + menuBox.width + MENU_MARGIN ||
        top + cellHeight < menuBox.y - MENU_MARGIN ||
        top > menuBox.y + menuBox.height + MENU_MARGIN;
      if (clearOfMenu) compared.push(row * GRID_COLUMNS + column);
    }
  }
  expect(compared.length).toBeGreaterThan(20);
  const flashes = used
    .map((frame, frameIndex) => {
      const cells = frameCells[frameIndex];
      const worst = Math.max(
        ...compared.map((index) => {
          const [r, g, b] = cells[index];
          const [rr, rg, rb] = referenceCells[index];
          return (Math.abs(r - rr) + Math.abs(g - rg) + Math.abs(b - rb)) / 3;
        }),
      );
      return {
        at: `${Math.round(frame.t - pressed.t)} ms`,
        worst: Math.round(worst),
      };
    })
    .filter((step) => step.worst > CELL_TOLERANCE);
  if (flashes.length > 0) {
    await test.info().attach(`freeze-${Math.round(pressed.t)}`, {
      body: JSON.stringify({ main, events, frames, reference, crop, flashes }),
      contentType: 'application/json',
    });
  }
  return flashes;
}

async function expectSteadyPage(...args) {
  // No blank, recoloured or swapped image in any sampled hidden-view frame.
  expect(await samplePageDifferences(...args)).toEqual([]);
}

test('menus over the Browser keep the page steady in sampled hidden-view frames', async () => {
  test.setTimeout(180_000);
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const { browser, panelId } = await seedVisibleBrowserPanel(
      window,
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, url: fixture.url },
      { moveToGroupId: DEFAULT_GROUP_IDS.chat },
    );
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    await expect
      .poll(() => fixtureViewVisible(electronApp), { timeout: 20_000 })
      .toBe(true);
    await recordMainViewCalls(electronApp);
    await recordRendererEvents(window);
    // The page has loaded; let it settle. No app state is awaited here, so
    // the same steps reach the frame check on any version of the app.
    await window.waitForTimeout(PAGE_SETTLE_MS);

    // The first menu after the page loads, pressed without pointing first:
    // the frame taken after the load covers the page.
    await expectSteadyPage(
      { electronApp, window },
      window.getByTestId(`panel-tab-${panelId}`),
      (tab) => tab.click({ button: 'right' }),
      { pointFirst: false },
    );
    await window.waitForTimeout(CAPTURE_DELAY_MS);

    // The Browser tab's right-click menu.
    await expectSteadyPage(
      { electronApp, window },
      window.getByTestId(`panel-tab-${panelId}`),
      (tab) => tab.click({ button: 'right' }),
    );

    // The Browser's ••• menu.
    await window.waitForTimeout(CAPTURE_DELAY_MS);
    await expectSteadyPage(
      { electronApp, window },
      window
        .getByTestId(`browser-pane-${browser.id}`)
        .getByTestId('browser-more'),
      (more) => more.click(),
    );

    // The page changes on its own while the pointer is elsewhere; pressing
    // ••• later must not cover it with the older frame.
    await window.mouse.move(2, 300);
    await window.waitForTimeout(CAPTURE_DELAY_MS + 500);
    await changeFixturePage(electronApp);
    await window.waitForTimeout(1_200);
    await expectSteadyPage(
      { electronApp, window },
      window
        .getByTestId(`browser-pane-${browser.id}`)
        .getByTestId('browser-more'),
      (more) => more.click(),
      { pointFirst: false, captureDelay: 0 },
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

test('the frame sampler detects a deliberately stale covering image', async () => {
  const fixture = await startLocalPage();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const { browser } = await seedVisibleBrowserPanel(
      window,
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, url: fixture.url },
      { moveToGroupId: DEFAULT_GROUP_IDS.chat },
    );
    await expect.poll(() => fixtureViewVisible(electronApp)).toBe(true);
    await recordMainViewCalls(electronApp);
    await recordRendererEvents(window);
    await window.waitForTimeout(PAGE_SETTLE_MS);
    const stale = await capturePageReference(electronApp);
    await changeFixturePage(electronApp);
    await window.waitForTimeout(1_200);
    // Replace only the renderer's covering image. The live native page and
    // reference remain current, so accidentally sampling that page instead
    // of the renderer would make this negative control fail.
    await window.addStyleTag({
      content: `[data-testid^="browser-pane-freeze-frame"] {
        content: url("data:image/png;base64,${stale}") !important;
      }`,
    });
    const differences = await samplePageDifferences(
      { electronApp, window },
      window
        .getByTestId(`browser-pane-${browser.id}`)
        .getByTestId('browser-more'),
      (more) => more.click(),
      { pointFirst: false, captureDelay: 0 },
    );
    expect(differences.length).toBeGreaterThan(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
