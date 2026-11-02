// The Browser's page is a native WebContentsView painted above the renderer,
// so no CSS clip reaches it. In the inset window layout the page fills its
// card's body edge to edge: flush under the toolbar with square top corners,
// rounded only by the card's own bottom corners. Electron rounds a view's
// four corners alike, so main wraps the page in a frame and a rounded clip
// that reaches past its square corners. This spec checks the native views
// themselves (bounds and the radius each clips by, read in the main process)
// across the layout states that re-place the page: docked, after a window
// resize, after Settings, a tab switch or a worktree switch hides and
// reshows it, split, maximized and restored, under interface zoom, and with
// the inspector open.
//
// Run after building the implementation:
//   pnpm run test:electron:built browser-native-corners.spec.mjs --reporter=line
//
// Set BROWSER_CORNERS_CAPTURE_DIR to an absolute directory to also save
// device-pixel (2x on Retina) light and dark captures of each state there.
//
// Determinism: the worktree and chat are seeded on disk; the page is served
// from a local HTTP fixture and no provider request runs.

import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  getLayout,
  splitViaApi,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
} from './panelHarness.mjs';
import { setUiScale } from './uiScale.mjs';

const APP = 'ts-pnpm-vite';
// A second project, whose worktree the Browser's worktree switches away to.
const OTHER_APP = 'ts-yarn-cli';
const BRANCH = 'demo-main';
const CHAT_TAB_ID = 'corners-chat-1';
const PAGE_TITLE = 'Browser corners fixture';
const CAPTURE_DIR = process.env.BROWSER_CORNERS_CAPTURE_DIR;
// Device pixels: the window's own scale (2x on a Retina display).
const CAPTURE_SCALE = 1;

async function launch() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-corners-'));
  seedDemoWorkspaces({ userDataDir, apps: [APP, OTHER_APP] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${APP}`,
    worktreeId: BRANCH,
    providerType: 'claude',
    tabs: [{ id: CHAT_TAB_ID, title: 'Browser corners' }],
    activeTabId: CHAT_TAB_ID,
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    `demo-${APP}`,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'minimal' }),
  );
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  await expect(launched.window.getByTestId('worktree-top-bar')).toBeVisible({
    timeout: 20_000,
  });
  return { ...launched, userDataDir };
}

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${PAGE_TITLE}</title></head>
        <body style="margin:0;background:#f4f4f4;color:#123;min-height:100vh;font:20px sans-serif">
          <main style="padding:40px"><h1>${PAGE_TITLE}</h1></main>
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Records every corner radius main gives a native view (a plain View or a
 * WebContentsView). Electron exposes no getter for a view's radius.
 */
function recordNativeCornerRadii(electronApp) {
  return electronApp.evaluate(({ View, WebContentsView }) => {
    if (globalThis.__browserCornersProbe) return;
    const radii = new WeakMap();
    globalThis.__browserCornersProbe = radii;
    for (const type of [View, WebContentsView]) {
      const original = type.prototype.setBorderRadius;
      type.prototype.setBorderRadius = function setBorderRadius(radius) {
        radii.set(this, radius);
        return original.call(this, radius);
      };
    }
  });
}

/**
 * The fixture page's native view as main last placed it, with every view
 * that clips it: window bounds (DIPs) and the corner radius each rounds by.
 */
function nativePageView(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }, title) => {
    const radii = globalThis.__browserCornersProbe ?? new WeakMap();
    for (const win of BrowserWindow.getAllWindows()) {
      const visit = (view, offsetX, offsetY, ancestors) => {
        for (const child of view?.children ?? []) {
          const own = child.getBounds();
          const rect = {
            x: own.x + offsetX,
            y: own.y + offsetY,
            width: own.width,
            height: own.height,
          };
          const shape = {
            rect,
            radius: radii.get(child) ?? 0,
            visible: child.getVisible(),
          };
          const contents = child.webContents;
          if (
            contents &&
            !contents.isDestroyed() &&
            contents.getTitle() === title
          ) {
            return {
              page: shape,
              ancestors,
              visible: [...ancestors, shape].every((item) => item.visible),
              zoom: win.webContents.getZoomFactor(),
            };
          }
          const nested = visit(child, rect.x, rect.y, [...ancestors, shape]);
          if (nested) return nested;
        }
        return null;
      };
      const found = visit(win.contentView, 0, 0, []);
      if (found) return found;
    }
    return null;
  }, PAGE_TITLE);
}

/**
 * The radius each page corner shows: the largest radius of any clipping view
 * (or the page itself) whose own corner falls on that page corner. A view
 * whose corner lies beyond the page doesn't round it.
 */
function visibleCornerRadii(native) {
  const { rect } = native.page;
  const corners = {
    topLeft: [rect.x, rect.y],
    topRight: [rect.x + rect.width, rect.y],
    bottomRight: [rect.x + rect.width, rect.y + rect.height],
    bottomLeft: [rect.x, rect.y + rect.height],
  };
  const shapes = [...native.ancestors, native.page];
  const result = {};
  for (const [name, [px, py]] of Object.entries(corners)) {
    let radius = 0;
    for (const { rect: r, radius: shapeRadius } of shapes) {
      if (!shapeRadius) continue;
      const own = [
        [r.x, r.y],
        [r.x + r.width, r.y],
        [r.x + r.width, r.y + r.height],
        [r.x, r.y + r.height],
      ];
      // Native bounds are whole DIPs: a corner 1px past the page's leaves it
      // square (a radius-1 arc never reaches in that far).
      if (
        own.some(([x, y]) => Math.abs(x - px) < 0.5 && Math.abs(y - py) < 0.5)
      )
        radius = Math.max(radius, shapeRadius);
    }
    result[name] = radius;
  }
  return result;
}

/** Whether every clipping view contains the whole page. */
function ancestorsContainPage(native) {
  const { rect } = native.page;
  return native.ancestors.every(
    ({ rect: r }) =>
      r.x <= rect.x + 1 &&
      r.y <= rect.y + 1 &&
      r.x + r.width >= rect.x + rect.width - 1 &&
      r.y + r.height >= rect.y + rect.height - 1,
  );
}

/** The page area in its card, in CSS px. */
function readPageArea(window) {
  return window.getByTestId('browser-page-area').evaluate((element) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const published = Number.parseFloat(
      rootStyle.getPropertyValue('--window-corner-radius'),
    );
    const zoom =
      Number.parseFloat(rootStyle.getPropertyValue('--ui-zoom')) || 1;
    const windowRadius = Number.isFinite(published) ? published : 16;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const card = element
      .closest('.canopy-panel-group')
      ?.getBoundingClientRect();
    // The toolbar row above the page's row.
    const toolbar = element.parentElement?.previousElementSibling;
    const radius = (value) => Number.parseFloat(value) || 0;
    return {
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      left: card ? rect.left - card.left : null,
      right: card ? card.right - rect.right : null,
      bottom: card ? card.bottom - rect.bottom : null,
      gapUnderToolbar: toolbar
        ? rect.top - toolbar.getBoundingClientRect().bottom
        : null,
      inspectorOpen: element.nextElementSibling !== null,
      radii: {
        topLeft: radius(style.borderTopLeftRadius),
        topRight: radius(style.borderTopRightRadius),
        bottomRight: radius(style.borderBottomRightRadius),
        bottomLeft: radius(style.borderBottomLeftRadius),
      },
      // #6167 made the card inset 6px; its corners stay concentric with
      // the window after interface zoom.
      cardRadius: Math.max(windowRadius / zoom - 6, 6),
    };
  });
}

/**
 * The page fills its card's body edge to edge, square under the toolbar,
 * rounded only at the card's bottom corners (bottom-left alone while the
 * inspector takes the bottom-right). The native page sits exactly over the
 * page area and shows those same corners. Records a failed state instead of
 * stopping, so one run reports and captures every state.
 */
async function checkNativePageInCard(window, electronApp, state, failures) {
  try {
    await expect
      .poll(
        async () => {
          const area = await readPageArea(window);
          const native = await nativePageView(electronApp);
          if (!native?.visible) return { state, native: 'hidden' };
          const z = native.zoom;
          const near = (a, b) => Math.abs(a - b) <= 1.5;
          const page = native.page.rect;
          const card = area.cardRadius;
          const expectedCss = {
            topLeft: 0,
            topRight: 0,
            bottomRight: area.inspectorOpen ? 0 : card,
            bottomLeft: card,
          };
          return {
            state,
            // An open inspector sits between the page and the card's right.
            flushInCard: [
              area.left,
              area.bottom,
              ...(area.inspectorOpen ? [] : [area.right]),
            ].every((gap) => near(gap, 0)),
            flushUnderToolbar: near(area.gapUnderToolbar, 0),
            cssCorners: Object.entries(expectedCss).every(([corner, value]) =>
              near(area.radii[corner], value),
            ),
            pageOverArea:
              near(page.x, area.rect.x * z) &&
              near(page.y, area.rect.y * z) &&
              near(page.width, area.rect.width * z) &&
              near(page.height, area.rect.height * z),
            clipsHoldPage: ancestorsContainPage(native),
            nativeCorners: visibleCornerRadii(native),
          };
        },
        { message: `native Browser page frame (${state})`, timeout: 10_000 },
      )
      .toEqual({
        state,
        flushInCard: true,
        flushUnderToolbar: true,
        cssCorners: true,
        pageOverArea: true,
        clipsHoldPage: true,
        nativeCorners: await expectedNativeCorners(window, electronApp),
      });
  } catch (error) {
    console.log(`[browser-corners] ${state} failed`);
    failures.push(`${state}: ${String(error.message).slice(0, 900)}`);
  }
  await capture(window, electronApp, state);
}

/** The page area's CSS corners in window DIPs, as main rounds them. */
async function expectedNativeCorners(window, electronApp) {
  const area = await readPageArea(window);
  const zoom = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  );
  return Object.fromEntries(
    Object.entries(area.radii).map(([corner, radius]) => [
      corner,
      Math.round(radius * zoom),
    ]),
  );
}

/**
 * Light and dark 2x window captures with the native page drawn in where main
 * placed it, clipped by every view main clips it with. Test windows are
 * hidden, and hidden windows don't composite native child views, so the page
 * is captured from its own contents.
 */
async function capture(window, electronApp, state) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const native = await nativePageView(electronApp);
  for (const mode of ['light', 'dark']) {
    await window.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark);
    }, mode === 'dark');
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    const shell = await screenshotShell(window);
    const pageShot = await screenshotNativePage(electronApp);
    await writeComposite({
      window,
      shell,
      pageShot,
      native,
      file: path.join(CAPTURE_DIR, `${state}-desktop-${mode}.png`),
    });
  }
  await window.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
}

/** The app window in device pixels. */
async function screenshotShell(window) {
  const cdp = await window.context().newCDPSession(window);
  try {
    const { width, height } = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: CAPTURE_SCALE },
    });
    return Buffer.from(data, 'base64');
  } finally {
    await cdp.detach();
  }
}

/** The native page's own contents in device pixels. */
function screenshotNativePage(electronApp) {
  return electronApp.evaluate(
    async ({ webContents }, { title, scale }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => !item.isDestroyed() && item.getTitle() === title);
      if (!contents) return null;
      const cdp = contents.debugger;
      const attached = cdp.isAttached();
      if (!attached) cdp.attach('1.3');
      try {
        const { cssVisualViewport: viewport } = await cdp.sendCommand(
          'Page.getLayoutMetrics',
        );
        const { data } = await cdp.sendCommand('Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: viewport.pageX,
            y: viewport.pageY,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
            scale,
          },
        });
        return data;
      } finally {
        if (!attached) cdp.detach();
      }
    },
    { title: PAGE_TITLE, scale: CAPTURE_SCALE },
  );
}

async function writeComposite({ window, shell, pageShot, native, file }) {
  const composite = await window.evaluate(
    async ({ shellPng, pagePng, view }) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const base = await load(`data:image/png;base64,${shellPng}`);
      const canvas = document.createElement('canvas');
      canvas.width = base.width;
      canvas.height = base.height;
      const context = canvas.getContext('2d');
      context.drawImage(base, 0, 0);
      if (pagePng && view?.visible) {
        const page = await load(`data:image/png;base64,${pagePng}`);
        // Screenshot px per window DIP.
        const scale = base.width / (window.innerWidth * view.zoom);
        context.save();
        for (const { rect, radius } of [...view.ancestors, view.page]) {
          context.beginPath();
          context.roundRect(
            rect.x * scale,
            rect.y * scale,
            rect.width * scale,
            rect.height * scale,
            radius * scale,
          );
          context.clip();
        }
        const { x, y, width, height } = view.page.rect;
        context.drawImage(
          page,
          x * scale,
          y * scale,
          width * scale,
          height * scale,
        );
        context.restore();
      }
      return canvas.toDataURL('image/png').split(',')[1];
    },
    {
      shellPng: shell.toString('base64'),
      pagePng: pageShot,
      view: native,
    },
  );
  writeFileSync(file, Buffer.from(composite, 'base64'));
}

/** Selects the sidebar's other (unselected) worktree. */
async function selectOtherWorktree(window) {
  await window.evaluate(() => {
    const row = Array.from(
      document.querySelectorAll('[data-testid="worktree-row"]'),
    ).find((element) => !element.closest('[data-sidebar-selected-item]'));
    if (!(row instanceof HTMLElement)) {
      throw new Error('No other worktree row to select');
    }
    row.click();
  });
}

async function nativePageHidden(electronApp) {
  await expect
    .poll(async () => (await nativePageView(electronApp))?.visible)
    .toBe(false);
}

async function browserGroupId(window, panelId) {
  const layout = await getLayout(window);
  const leaf = collectLeaves(layout?.root).find((item) =>
    item.panels.some((panel) => panel.panelId === panelId),
  );
  return leaf?.groupId ?? null;
}

test('the native Browser page fills its card and rounds only the card corners in every layout state', async () => {
  test.setTimeout(240_000);
  const page = await startLocalPage();
  const { electronApp, userDataDir, window } = await launch();
  const failures = [];
  try {
    await recordNativeCornerRadii(electronApp);
    const { panelId } = await seedVisibleBrowserPanel(
      window,
      { projectId: `demo-${APP}`, worktreeId: BRANCH, url: page.url },
      { originChatTabId: CHAT_TAB_ID },
    );
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    await expect.poll(() => nativePageView(electronApp)).not.toBeNull();

    await checkNativePageInCard(window, electronApp, 'docked', failures);

    // A window resize re-places the view.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      const [width, height] = win.getSize();
      win.setSize(width - 160, height - 80);
    });
    await checkNativePageInCard(window, electronApp, 'resized', failures);

    // Settings hides the page; closing it shows the page again.
    const app = new CanopyAppDriver(window);
    await app.openSettings();
    await nativePageHidden(electronApp);
    await app.closeSettings();
    await checkNativePageInCard(
      window,
      electronApp,
      'after-settings',
      failures,
    );

    // Another tab in the Browser's group hides the page; back shows it.
    const dockedGroupId = await browserGroupId(window, panelId);
    const focusTab = (id) =>
      window.evaluate(
        ([group, panel]) =>
          window.__canopyPanelTestApi.focusPanel(group, panel),
        [dockedGroupId, id],
      );
    // Minimal no longer seeds Activity; open a real neighboring New tab.
    await window.getByTestId(`panel-add-tab-${dockedGroupId}`).click();
    await nativePageHidden(electronApp);
    await focusTab(panelId);
    await checkNativePageInCard(
      window,
      electronApp,
      'after-tab-switch',
      failures,
    );

    // Another worktree hides the page (its view stays warm); back shows it.
    await selectOtherWorktree(window);
    await nativePageHidden(electronApp);
    await selectOtherWorktree(window);
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    await checkNativePageInCard(
      window,
      electronApp,
      'after-worktree-switch',
      failures,
    );

    // Split the Browser's group in two: one card now ends at a gap between
    // cards instead of the window edge.
    // Minimal layout pins its topology; unpin it the way a full layout is.
    await window.evaluate(() =>
      window.__canopyPanelTestApi.setFixedTopology(false),
    );
    const leavesBefore = await countLeaves(window);
    await splitViaApi(window, dockedGroupId, 'down');
    await expect.poll(() => countLeaves(window)).toBe(leavesBefore + 1);
    await focusTab(panelId).catch(() => undefined);
    await checkNativePageInCard(window, electronApp, 'split', failures);

    // Maximized and restored.
    const splitGroupId = await browserGroupId(window, panelId);
    const maximize = (maximized) =>
      window.evaluate(
        ([id, value]) => window.__canopyPanelTestApi.maximizeGroup(id, value),
        [splitGroupId, maximized],
      );
    await maximize(true);
    await checkNativePageInCard(window, electronApp, 'maximized', failures);
    await maximize(false);
    await checkNativePageInCard(window, electronApp, 'restored', failures);

    // Interface zoom scales the radius into window DIPs.
    await setUiScale(window, 125);
    await checkNativePageInCard(window, electronApp, 'zoom-125', failures);
    await setUiScale(window, 100);
    await checkNativePageInCard(window, electronApp, 'zoom-100', failures);

    // The inspector takes the card's bottom-right corner from the page.
    await window.getByTestId('browser-more').click();
    await window.getByTestId('browser-more-details').click();
    await expect(window.getByTestId('browser-inspector-close')).toBeVisible();
    await checkNativePageInCard(
      window,
      electronApp,
      'inspector-open',
      failures,
    );

    expect(failures, 'layout states with a misplaced native page').toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await page.close();
  }
});
