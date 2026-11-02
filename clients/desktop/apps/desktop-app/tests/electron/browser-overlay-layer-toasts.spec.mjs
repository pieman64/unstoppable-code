import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const BROWSER_PAGE_TITLE = 'Browser overlay toast fixture';
const SEEDED_CHAT_TAB_ID = 'seed-chat';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

function seed({ earlyAccess = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-overlay-toasts-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  if (earlyAccess) seedEarlyAccess({ userDataDir });
  return { userDataDir };
}

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>${BROWSER_PAGE_TITLE}</title></head>
        <body style="margin:0;background:#d8f0f7;color:#123;min-height:100vh;font:24px sans-serif">
          <main style="padding:48px"><h1>${BROWSER_PAGE_TITLE}</h1><p>Native browser content remains live below app overlays.</p></main>
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

async function browserPanels(window) {
  return window.evaluate(() => {
    const layout = window.__canopyPanelTestApi?.getSerializedLayout();
    if (!layout) return [];
    const collectLeaves = (node) =>
      node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves);
    return collectLeaves(layout.root).flatMap((leaf) =>
      leaf.panels
        .filter((panel) => panel.kind === 'browser')
        .map((panel) => ({
          groupId: leaf.groupId,
          panelId: panel.panelId,
          browserId: panel.instance?.browserId,
        })),
    );
  });
}

async function firstGroupId(window) {
  return window.evaluate(() => {
    const layout = window.__canopyPanelTestApi?.getSerializedLayout();
    let node = layout?.root;
    while (node && node.type !== 'leaf') node = node.children[0];
    return node?.groupId;
  });
}

async function addBrowserPanel(window) {
  const before = await browserPanels(window);
  const beforeIds = new Set(before.map((panel) => panel.panelId));
  const groupId = await firstGroupId(window);
  expect(groupId).toBeTruthy();
  // Early access's `+` opens the add menu itself; otherwise the group has
  // its own add-panel button.
  const addPanel = window.getByTestId(`panel-add-panel-${groupId}`);
  await (
    (await addPanel.isVisible())
      ? addPanel
      : window.getByTestId(`panel-add-tab-${groupId}`)
  ).click();
  const addMenu = window.getByTestId('panel-add-menu');
  await expect(addMenu).toBeVisible();
  await expect(window.getByTestId('panel-add-menu-item-browser')).toBeVisible();
  await window.getByTestId('panel-add-menu-item-browser').click();
  await expect(addMenu).toBeHidden({ timeout: 15_000 });

  let added;
  await expect
    .poll(async () => {
      added = (await browserPanels(window)).find(
        (panel) => !beforeIds.has(panel.panelId),
      );
      return Boolean(added?.browserId);
    })
    .toBe(true);
  expect(added).toBeTruthy();
  await expect(
    window.getByTestId(`browser-pane-${added.browserId}`),
  ).toHaveAttribute('data-browser-state', 'live', { timeout: 30_000 });
  return added;
}

async function navigatePane(electronApp, window, browserId, url) {
  const pane = window.getByTestId(`browser-pane-${browserId}`);
  await expect(pane).toBeVisible();
  const urlInput = pane.getByTestId('browser-url-input');
  await urlInput.fill(url);
  await urlInput.press('Enter');
  await expect
    .poll(() => browserViewByTitle(electronApp, BROWSER_PAGE_TITLE))
    .toMatchObject({ visible: true });
}

/** Native WebContentsView geometry/visibility from the main process. */
async function nativeBrowserViews(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const found = [];
    // A Browser page sits inside its frame views, so its window bounds add
    // up its ancestors' offsets.
    const visit = (view, hostWindowId, offsetX = 0, offsetY = 0) => {
      for (const child of view?.children ?? []) {
        const own = child.getBounds();
        const bounds = { ...own, x: own.x + offsetX, y: own.y + offsetY };
        if (child.webContents) {
          found.push({
            webContentsId: child.webContents.id,
            title: child.webContents.getTitle(),
            bounds,
            visible: child.getVisible(),
            hostWindowId,
            ownerWindowId:
              BrowserWindow.fromWebContents(child.webContents)?.id ?? null,
          });
        }
        visit(child, hostWindowId, bounds.x, bounds.y);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView, browserWindow.id);
    }
    return found;
  });
}

async function browserViewByTitle(electronApp, title) {
  return (await nativeBrowserViews(electronApp)).find(
    (view) => view.title === title,
  );
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * The main window's overlay layer: the about:blank child view the renderer
 * draws toasts into. Reports its geometry, visibility, text, and whether it
 * sits above the Browser view in the native z-order.
 */
async function overlayLayer(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }, browserTitle) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const children = win.contentView.children ?? [];
      const index = children.findIndex(
        (child) =>
          child.webContents &&
          !child.webContents.isDestroyed() &&
          child.webContents.getURL() === 'about:blank' &&
          // The notifications slot; the above-browser slot is another layer.
          child.webContents.getTitle() === 'Notifications',
      );
      if (index === -1) continue;
      const child = children[index];
      // The Browser page sits in its frame (a window child), two views down.
      const holdsBrowser = (view) =>
        view.webContents?.getTitle() === browserTitle ||
        (view.children ?? []).some(holdsBrowser);
      const browserIndex = children.findIndex(holdsBrowser);
      const text = await child.webContents.executeJavaScript(
        'document.body ? document.body.innerText : ""',
      );
      return {
        visible: child.getVisible(),
        bounds: child.getBounds(),
        text,
        aboveBrowser: browserIndex !== -1 && index > browserIndex,
      };
    }
    return null;
  }, BROWSER_PAGE_TITLE);
}

/** Destroys the overlay layer's page, as a renderer or guest crash would. */
async function closeOverlayLayer(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children ?? []) {
        if (
          child.webContents?.getURL() === 'about:blank' &&
          child.webContents.getTitle() === 'Notifications'
        ) {
          child.webContents.close();
          return;
        }
      }
    }
  });
}

/** Clicks the first element matching `selector` inside the overlay layer. */
async function clickInOverlayLayer(electronApp, selector) {
  const clicked = await electronApp.evaluate(
    async ({ BrowserWindow }, target) => {
      for (const win of BrowserWindow.getAllWindows()) {
        for (const child of win.contentView.children ?? []) {
          if (
            child.webContents?.getURL() !== 'about:blank' ||
            child.webContents.getTitle() !== 'Notifications'
          ) {
            continue;
          }
          return child.webContents.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return false; el.click(); return true; })()`,
          );
        }
      }
      return false;
    },
    selector,
  );
  expect(clicked, `overlay layer should contain ${selector}`).toBe(true);
}

function raiseToast(window, input) {
  return window.evaluate((toast) => {
    const api = window.__canopyToastTestApi;
    if (!api) throw new Error('toast test API is not installed');
    api.addToast(toast);
  }, input);
}

/**
 * Presses and releases the mouse, without moving, on the center of the first
 * element matching `selector` inside the overlay layer, as trusted input.
 */
async function pressInOverlayLayer(electronApp, selector) {
  const pressed = await electronApp.evaluate(
    async ({ BrowserWindow }, target) => {
      for (const win of BrowserWindow.getAllWindows()) {
        for (const child of win.contentView.children ?? []) {
          const contents = child.webContents;
          if (
            contents?.getURL() !== 'about:blank' ||
            contents.getTitle() !== 'Notifications'
          ) {
            continue;
          }
          const point = await contents.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
          );
          if (!point) return false;
          const base = { button: 'left', clickCount: 1 };
          const before = child.getBounds();
          contents.sendInputEvent({ ...base, ...point, type: 'mouseMove' });
          contents.sendInputEvent({ ...base, ...point, type: 'mouseDown' });
          await new Promise((resolve) => setTimeout(resolve, 150));
          // A real pointer stays put on screen. If the layer moved under it,
          // the release lands at a different view-relative point.
          const after = child.getBounds();
          contents.sendInputEvent({
            ...base,
            x: point.x + before.x - after.x,
            y: point.y + before.y - after.y,
            type: 'mouseUp',
          });
          return true;
        }
      }
      return false;
    },
    selector,
  );
  expect(pressed, `overlay layer should contain ${selector}`).toBe(true);
}

/**
 * Reads the leaving toast card inside the overlay layer: its left edge while
 * it plays its exit, or null once it is gone from the layer.
 */
async function leavingCardInOverlayLayer(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children ?? []) {
        if (
          child.webContents?.getURL() !== 'about:blank' ||
          child.webContents.getTitle() !== 'Notifications'
        ) {
          continue;
        }
        return child.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('[data-testid="toast-stack-card"][data-ending-style]'); return el ? el.getBoundingClientRect().left : null; })()`,
        );
      }
    }
    return null;
  });
}

async function runOverlayCase({
  earlyAccess,
  pressToActivate = false,
  dismissExit = false,
}) {
  const fixture = await startLocalPage();
  let launched;
  try {
    const { userDataDir } = seed({ earlyAccess });
    launched = await launchCanopy({ userDataDir });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });

    const browser = await addBrowserPanel(window);
    await window.evaluate((groupId) => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.maximizeGroup(groupId, true);
    }, browser.groupId);
    await navigatePane(
      launched.electronApp,
      window,
      browser.browserId,
      fixture.url,
    );
    const browserPane = window.getByTestId(`browser-pane-${browser.browserId}`);
    await expect(browserPane).toBeVisible();
    await expect
      .poll(() => browserViewByTitle(launched.electronApp, BROWSER_PAGE_TITLE))
      .toMatchObject({ visible: true });

    // Several lines, so the card reaches past the Browser bar into the page
    // area even when the stack sits top-right below the header.
    const message = `${
      earlyAccess ? 'Early-access' : 'Default'
    } toast over Browser pane.\nSecond line.\nThird line.\nFourth line.`;
    // A clickable toast has a destination: activating its card opens it and
    // dismisses the toast.
    await raiseToast(window, {
      message,
      type: 'success',
      meta: { persistent: true },
      ...(pressToActivate ? { clickable: true } : {}),
    });
    const toastText = message.split('\n')[0];
    const pageBox = await browserPane
      .getByTestId('browser-page-area')
      .boundingBox();
    expect(
      pageBox,
      'Browser page area should have a screen rectangle',
    ).not.toBeNull();

    // The toast commits in the main document, then moves into the overlay
    // layer: a transparent native view above the Browser view.
    // A layering transition can leave the layer empty for one frame, so wait
    // for the visible layer and its content together.
    await expect
      .poll(
        async () => {
          const current = await overlayLayer(launched.electronApp);
          return current?.visible === true && current.text.includes(toastText);
        },
        {
          timeout: 10_000,
          message:
            'the overlay layer view shows the toast while it overlaps the page',
        },
      )
      .toBe(true);
    const layer = await overlayLayer(launched.electronApp);
    // Window DIPs equal renderer CSS px at the default 100% interface scale.
    expect(
      rectsOverlap(layer.bounds, pageBox),
      'the overlay layer must sit over the Browser page area',
    ).toBe(true);
    expect(
      layer.aboveBrowser,
      'the overlay layer is stacked above the Browser view',
    ).toBe(true);

    // The page must stay live for the whole time the toast overlaps it. The
    // freeze path hides the view up to 250ms after an overlay appears, so
    // every sample across a longer window must see a visible, unfrozen view.
    const samples = [];
    const observeUntil = Date.now() + 1_500;
    while (Date.now() < observeUntil) {
      const view = await browserViewByTitle(
        launched.electronApp,
        BROWSER_PAGE_TITLE,
      );
      samples.push({
        visible: view?.visible === true,
        frozen:
          (await window.getByTestId('browser-pane-freeze-frame').count()) > 0,
        layered: (await overlayLayer(launched.electronApp))?.visible === true,
      });
      await window.waitForTimeout(100);
    }
    expect(
      samples.filter(
        (sample) => !sample.visible || sample.frozen || !sample.layered,
      ),
      'native Browser view should stay visible and no freeze frame should appear while the toast overlaps it',
    ).toEqual([]);

    if (dismissExit) {
      // Closing the last toast slides it out to the stack's side from inside
      // the layer. It must not drop back into the page (under the Browser
      // view) the moment it starts to leave, which cut its exit short.
      await window.evaluate(() => {
        const seen = { inMain: false };
        window.__toastExitSeen = seen;
        new MutationObserver(() => {
          if (document.querySelector('[data-testid="toast-stack-card"]')) {
            seen.inMain = true;
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await clickInOverlayLayer(
        launched.electronApp,
        '[data-testid="toast-dismiss"]',
      );
      const lefts = [];
      const sampleUntil = Date.now() + 1_000;
      while (Date.now() < sampleUntil) {
        const left = await leavingCardInOverlayLayer(launched.electronApp);
        if (left === null) {
          if (lefts.length > 0) break;
        } else {
          lefts.push(left);
        }
      }
      expect(
        lefts.length,
        'the leaving card stays in the layer for its exit',
      ).toBeGreaterThan(1);
      expect(
        lefts.at(-1),
        'the leaving card slides toward the stack side',
      ).toBeGreaterThan(lefts[0]);
      await expect
        .poll(
          async () =>
            (await overlayLayer(launched.electronApp))?.visible ?? false,
        )
        .toBe(false);
      expect(
        await window.evaluate(() => window.__toastExitSeen.inMain),
        'the leaving card never moves back under the Browser view',
      ).toBe(false);
      await expect(window.getByText(toastText)).toHaveCount(0);
      return;
    }

    if (pressToActivate) {
      // A press without movement on a layered card is a click: it opens the
      // toast's destination and dismisses the persistent toast, even though
      // pressing starts a swipe that widens the layer.
      await pressInOverlayLayer(
        launched.electronApp,
        '[data-testid="toast-card"]',
      );
      await expect
        .poll(
          async () =>
            (await overlayLayer(launched.electronApp))?.text.includes(
              toastText,
            ) ?? false,
          { message: 'the pressed toast is dismissed by its activation' },
        )
        .toBe(false);
      await expect(window.getByText(toastText)).toHaveCount(0);
      return;
    }

    // Losing the layer never hides the toast under the Browser view: it
    // reopens a layer, or falls back to the freeze frame with the toast in
    // the main document.
    await closeOverlayLayer(launched.electronApp);
    await expect
      .poll(
        async () => {
          const reopened = await overlayLayer(launched.electronApp);
          if (reopened?.visible && reopened.text.includes(toastText)) {
            return 'layer';
          }
          const frozen =
            (await window.getByTestId('browser-pane-freeze-frame').count()) > 0;
          const inMain = (await window.getByText(toastText).count()) > 0;
          return frozen && inMain ? 'freeze-frame' : 'hidden';
        },
        { timeout: 10_000 },
      )
      .not.toBe('hidden');

    // Dismissing the toast from whichever document holds it hides the layer
    // and leaves the page live.
    if ((await overlayLayer(launched.electronApp))?.visible) {
      await clickInOverlayLayer(
        launched.electronApp,
        '[data-testid="toast-dismiss"], button[aria-label="Dismiss"]',
      );
    } else {
      await window
        .locator('[data-testid="toast-dismiss"], button[aria-label="Dismiss"]')
        .first()
        .click();
    }
    await expect
      .poll(
        async () =>
          (await overlayLayer(launched.electronApp))?.visible ?? false,
      )
      .toBe(false);
    await expect(window.getByText(toastText)).toHaveCount(0);
    await expect
      .poll(() => browserViewByTitle(launched.electronApp, BROWSER_PAGE_TITLE))
      .toMatchObject({ visible: true });
    await expect(window.getByTestId('browser-pane-freeze-frame')).toHaveCount(
      0,
    );
  } finally {
    try {
      if (launched) {
        await closeCanopy(launched.electronApp, launched.userDataDir);
      }
    } finally {
      await fixture.close();
    }
  }
}

test('toast stack does not freeze an overlapping Browser pane', async () => {
  test.setTimeout(120_000);
  await runOverlayCase({ earlyAccess: false });
});

test('early-access toast stack does not freeze an overlapping Browser pane', async () => {
  test.setTimeout(120_000);
  await runOverlayCase({ earlyAccess: true });
});

test('pressing a layered early-access toast opens its destination once', async () => {
  test.setTimeout(120_000);
  await runOverlayCase({ earlyAccess: true, pressToActivate: true });
});

test('closing the last layered toast plays its exit inside the layer', async () => {
  test.setTimeout(120_000);
  await runOverlayCase({ earlyAccess: true, dismissExit: true });
});

test('toast renders in the main document when there is no Browser pane underneath', async () => {
  const { userDataDir } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await raiseToast(window, {
      message: 'Toast without Browser pane',
      type: 'success',
      meta: { persistent: true },
    });
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Toast without Browser pane' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
