// Early access App Advisor: opening it shows a chat panel inside the main
// Canopy window, in the bottom-right corner of its content: the open chat
// alone, with a quiet title and its controls. The panel is App Advisor's own
// page in a native view, so Open full window moves the same page (no reload)
// into the full App Advisor window; reopening from the sidebar brings it
// back into the main window, and Close or ⌘/Ctrl+W hides it in place,
// leaving the main window open. Minimize hides it too, leaving a bubble in
// the main window's corner that opens it again. Opening and reopening it never shows the full
// window's layout inside the panel. Its title switches between chats,
// including earlier ones in the same Work Entry, and dragging its top-left
// corner resizes it. Background browser opens keep it floating; a file opened
// while the chat has focus expands it. A reply that lands while the panel is
// not focused toasts once, in the main window, never inside the panel. With
// early access off, App Advisor is its full window as before.
//
// Run after building the implementation:
//   pnpm run test:electron:built app-advisor-floating.spec.mjs --reporter=line
//
// Set APP_ADVISOR_FLOATING_CAPTURE_DIR to an absolute directory to also save
// light and dark captures of the main window and the panel there.
//
// UI automation keeps windows hidden (still scriptable), so where the panel
// sits is read from the main process.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const CAPTURE_DIR = process.env.APP_ADVISOR_FLOATING_CAPTURE_DIR;
const PANEL_MARGIN = 16;

async function launch({ earlyAccess, seed }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-app-advisor-floating-'),
  );
  seed?.(userDataDir);
  if (earlyAccess) seedEarlyAccess({ userDataDir });
  // Packaged-install binary overrides would point a live turn at another
  // build's provider binary; the repository's staged binaries reach the mock.
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, userDataDir, window, app };
}

/**
 * App Advisor's page, once it has loaded. Under early access the full App
 * Advisor window keeps a page of its own as well, so this is the page that
 * renders App Advisor's surface.
 */
async function advisorPage(electronApp) {
  let found = null;
  await expect
    .poll(
      async () => {
        for (const page of electronApp.windows()) {
          if (!page.url().includes('app-advisor')) continue;
          const count = await page
            .getByTestId('app-advisor-workspace-surface')
            .count()
            .catch(() => 0);
          if (count > 0) {
            found = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(
    found.getByTestId('app-advisor-workspace-surface'),
  ).toBeVisible();
  return found;
}

/** Opens App Advisor from its default-layout row in the sidebar. */
async function openFromSidebar(app, electronApp) {
  await app.window.getByTestId('sidebar-nav-app-advisor').click();
  return advisorPage(electronApp);
}

/**
 * Where App Advisor's page is: the window hosting it (`main` or `full`),
 * its bounds in that window's content, and the content size.
 */
function readAdvisorPlacement(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const host = win.getTitle() === 'App Advisor' ? 'full' : 'main';
      for (const child of win.contentView.children) {
        const url = child.webContents?.getURL() ?? '';
        if (!url.includes('app-advisor')) continue;
        const content = win.getContentBounds();
        return {
          host,
          bounds: child.getBounds(),
          content: { width: content.width, height: content.height },
          visible: child.getVisible(),
          contentsId: child.webContents.id,
        };
      }
    }
    return null;
  });
}

/** Whether the main Canopy window is still open. */
function readMainWindowOpen(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.getTitle() !== 'App Advisor',
    ),
  );
}

/**
 * One App Advisor Work Entry holding one earlier chat with messages, so
 * "New chat" in the panel opens a second chat in the same entry.
 */
function seedEarlierAdvisorChat(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const timestamp = new Date(Date.now() - 60 * 60_000).toISOString();
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: 'entry-earlier', createdAt: timestamp }],
  });
  writeJson(path.join(workspaceDir, 'chats', 'entry-earlier.json'), {
    version: 1,
    activeTabId: 'chat-earlier',
    tabs: [
      {
        id: 'chat-earlier',
        title: 'Earlier chat',
        createdAt: timestamp,
        kind: 'chat',
        messages: [
          {
            id: 'chat-earlier-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Earlier chat question' }],
            timestamp: Date.parse(timestamp),
          },
          {
            id: 'chat-earlier-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Earlier chat answer' }],
            timestamp: Date.parse(timestamp) + 1_000,
          },
        ],
      },
    ],
  });
}

async function capture(window, advisor, name) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const mode of ['light', 'dark']) {
    // App Advisor applies a saved color mode as it syncs; the main window
    // applies display changes from its own settings, so it is switched
    // directly.
    await advisor.evaluate(
      (colorMode) => window.api.savePreferences({ colorMode }),
      mode,
    );
    await window.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark);
    }, mode === 'dark');
    for (const page of [window, advisor]) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains('dark'),
          ),
        )
        .toBe(mode === 'dark');
      // Let the colors finish their transition (time-based, finite ones;
      // scroll-linked animations always report running).
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.playState === 'running' &&
                    animation.timeline === document.timeline &&
                    animation.effect?.getTiming().iterations !== Infinity,
                ).length,
          ),
        )
        .toBe(0);
    }
    await window.screenshot({
      path: path.join(CAPTURE_DIR, `${name}-window-desktop-${mode}.png`),
    });
    await advisor.screenshot({
      path: path.join(CAPTURE_DIR, `${name}-panel-desktop-${mode}.png`),
    });
  }
  await advisor.evaluate(() =>
    window.api.savePreferences({ colorMode: 'light' }),
  );
  await window.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
}

test('early access shows App Advisor as a panel inside the main window and expands it', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch({
    earlyAccess: true,
  });
  try {
    const advisor = await openFromSidebar(app, electronApp);
    const panel = advisor.getByTestId('app-advisor-floating');
    await expect(panel).toBeVisible();
    await expect(advisor.getByTestId('app-advisor-nav')).toHaveCount(0);
    await expect(advisor.getByTestId('app-advisor-floating-title')).toHaveText(
      'New chat',
    );
    await expect(panel.locator('[contenteditable="true"]')).toBeVisible();

    // Inside the main window, in the bottom-right corner of its content.
    const floating = await readAdvisorPlacement(electronApp);
    expect(floating).not.toBeNull();
    expect(floating.host).toBe('main');
    expect(floating.visible).toBe(true);
    expect(floating.bounds.width).toBe(400);
    expect(floating.bounds.x + floating.bounds.width).toBe(
      floating.content.width - PANEL_MARGIN,
    );
    expect(floating.bounds.y + floating.bounds.height).toBe(
      floating.content.height - PANEL_MARGIN,
    );

    // It follows the main window as that resizes.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (win) => win.getTitle() !== 'App Advisor',
      );
      main?.setContentSize(1200, 800);
    });
    await expect
      .poll(async () => {
        const moved = await readAdvisorPlacement(electronApp);
        return moved
          ? [
              moved.bounds.x + moved.bounds.width,
              moved.bounds.y + moved.bounds.height,
            ]
          : null;
      })
      .toEqual([1200 - PANEL_MARGIN, 800 - PANEL_MARGIN]);

    await capture(window, advisor, 'app-advisor-panel-after');

    // The title is a menu of every chat; the open one is checked.
    const title = advisor.getByTestId('app-advisor-floating-title');
    await title.click();
    const chats = advisor.getByTestId('app-advisor-floating-chats');
    await expect(chats).toBeVisible();
    await expect(
      chats.locator('[data-testid="app-advisor-floating-chat"]'),
    ).not.toHaveCount(0);
    await advisor.keyboard.press('Escape');
    await expect(chats).toHaveCount(0);

    // Dragging the top-left corner grows the panel toward the top-left; its
    // bottom-right corner stays put.
    const corner = advisor.getByTestId('app-advisor-floating-resize-top-left');
    const box = await corner.boundingBox();
    expect(box).not.toBeNull();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await advisor.mouse.move(startX, startY);
    await advisor.mouse.down();
    // One move: the panel moves as it grows, and Playwright's mouse is
    // placed relative to the page, so more steps would add up the move.
    await advisor.mouse.move(startX - 80, startY - 60);
    await advisor.mouse.up();
    await expect
      .poll(async () => {
        const resized = await readAdvisorPlacement(electronApp);
        return resized
          ? [
              resized.bounds.width,
              resized.bounds.height,
              resized.bounds.x + resized.bounds.width,
              resized.bounds.y + resized.bounds.height,
            ]
          : null;
      })
      .toEqual([480, 700, 1200 - PANEL_MARGIN, 800 - PANEL_MARGIN]);

    // Open full window: the same page moves into the full App Advisor
    // window, without reloading.
    await advisor.evaluate(() => {
      window.__panelMarker = 'kept';
    });
    await panel.getByRole('button', { name: 'Open full window' }).click();
    await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();
    await expect(panel).toHaveCount(0);
    const full = await readAdvisorPlacement(electronApp);
    expect(full.host).toBe('full');
    expect(full.contentsId).toBe(floating.contentsId);
    expect(await advisor.evaluate(() => window.__panelMarker)).toBe('kept');

    // Reopening from the sidebar brings it back into the main window.
    await openFromSidebar(app, electronApp);
    await expect(panel).toBeVisible();
    expect((await readAdvisorPlacement(electronApp)).host).toBe('main');

    // ⌘/Ctrl+W hides the panel: the main window stays open, and the page
    // (and its chat) stays alive, hidden in place in the main window.
    await advisor.keyboard.press('ControlOrMeta+w');
    await expect
      .poll(async () => {
        const placement = await readAdvisorPlacement(electronApp);
        return placement ? [placement.host, placement.visible] : null;
      })
      .toEqual(['main', false]);
    expect((await readAdvisorPlacement(electronApp)).contentsId).toBe(
      floating.contentsId,
    );
    expect(await readMainWindowOpen(electronApp)).toBe(true);
    expect(await advisor.evaluate(() => window.__panelMarker)).toBe('kept');
    // Closing leaves no bubble behind.
    const bubble = window.getByTestId('app-advisor-minimized-bubble');
    await expect(bubble).toHaveCount(0);
    await openFromSidebar(app, electronApp);
    await expect(panel).toBeVisible();
    expect((await readAdvisorPlacement(electronApp)).host).toBe('main');

    // Minimize folds the panel into a bubble in the main window's corner;
    // the page (and its chat) stays alive.
    await panel.getByRole('button', { name: 'Minimize' }).click();
    await expect
      .poll(async () => {
        const placement = await readAdvisorPlacement(electronApp);
        return placement ? [placement.host, placement.visible] : null;
      })
      .toEqual(['main', false]);
    expect(await advisor.evaluate(() => window.__panelMarker)).toBe('kept');
    await expect(bubble).toBeVisible();

    // The bubble opens the same panel again, and goes away.
    await bubble.click();
    await expect(panel).toBeVisible();
    expect((await readAdvisorPlacement(electronApp)).visible).toBe(true);
    expect(await advisor.evaluate(() => window.__panelMarker)).toBe('kept');
    await expect(bubble).toHaveCount(0);

    // Close hides the panel outright: no bubble.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect
      .poll(async () => (await readAdvisorPlacement(electronApp))?.visible)
      .toBe(false);
    await expect(bubble).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Records, in the main process, every change to where App Advisor's view is
 * (its window, whether it is visible, its bounds), with the time of each.
 * Native views are composited by the OS, so this is what decides what the
 * user sees of the page. Reset on each call.
 */
function recordAdvisorPlacements(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, View, WebContentsView }) => {
    globalThis.__advisorPlacements = [];
    if (globalThis.__advisorPlacementHooked) return;
    globalThis.__advisorPlacementHooked = true;
    let last = null;
    const record = () => {
      let next = { host: null, visible: false, bounds: null };
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        for (const child of win.contentView.children) {
          const contents = child.webContents;
          if (!contents || contents.isDestroyed()) continue;
          if (!contents.getURL().includes('app-advisor')) continue;
          next = {
            host: win.getTitle() === 'App Advisor' ? 'full' : 'main',
            visible: child.getVisible(),
            bounds: child.getBounds(),
          };
        }
      }
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      globalThis.__advisorPlacements.push({ t: Date.now(), ...next });
    };
    for (const proto of [View.prototype, WebContentsView.prototype]) {
      for (const name of [
        'setVisible',
        'setBounds',
        'addChildView',
        'removeChildView',
      ]) {
        if (!Object.prototype.hasOwnProperty.call(proto, name)) continue;
        const original = proto[name];
        proto[name] = function (...args) {
          const result = original.apply(this, args);
          record();
          return result;
        };
      }
    }
  });
}

function readAdvisorPlacements(electronApp) {
  return electronApp.evaluate(() => globalThis.__advisorPlacements ?? []);
}

/**
 * Records what App Advisor's page renders, with the time of each change:
 * whether its body is in the floating layout, whether the floating panel or
 * the full window's navigation is on it, and its size. Installed before the
 * page's own scripts on pages created after this call.
 */
async function recordAdvisorRenders(electronApp) {
  await electronApp.context().addInitScript(() => {
    if (!location.href.includes('app-advisor')) return;
    const renders = [];
    window.__advisorRenders = renders;
    const record = () => {
      const body = document.body;
      const next = {
        t: Date.now(),
        floating: body?.hasAttribute('data-app-advisor-floating') === true,
        panel:
          document.querySelector('[data-testid="app-advisor-floating"]') !==
          null,
        nav: document.querySelector('[data-testid="app-advisor-nav"]') !== null,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const last = renders[renders.length - 1];
      if (
        last &&
        last.floating === next.floating &&
        last.panel === next.panel &&
        last.nav === next.nav &&
        last.width === next.width &&
        last.height === next.height
      ) {
        return;
      }
      renders.push(next);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-app-advisor-floating', 'data-testid'],
    });
    window.addEventListener('resize', record);
    record();
  });
}

/** The page whose URL is App Advisor's, if one exists yet. */
function findAdvisorPageNow(electronApp) {
  return (
    electronApp
      .windows()
      .find((page) => page.url().includes('app-advisor.html')) ?? null
  );
}

/**
 * Opens App Advisor with `trigger` while screenshotting its page as fast as
 * possible, for `durationMs`. Returns the screenshots, the view's placement
 * changes, and the page's renders, each with their times.
 */
async function recordOpening(electronApp, trigger, durationMs = 1_800) {
  await recordAdvisorPlacements(electronApp);
  const started = Date.now();
  const triggered = trigger();
  const shots = [];
  while (Date.now() - started < durationMs) {
    const page = findAdvisorPageNow(electronApp);
    if (!page) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    const before = Date.now();
    const buffer = await page
      .screenshot({ scale: 'css', timeout: 1_000 })
      .catch(() => null);
    if (buffer)
      shots.push({ t: Math.round((before + Date.now()) / 2), buffer });
  }
  await triggered;
  const page = findAdvisorPageNow(electronApp);
  return {
    started,
    shots,
    placements: await readAdvisorPlacements(electronApp),
    renders: page
      ? await page.evaluate(() => window.__advisorRenders ?? [])
      : [],
  };
}

/**
 * The page renders while App Advisor's view is visible in the main window
 * (the render already on the page when it appears, and each one after, until
 * it is hidden or leaves). Each must be the floating layout: the full
 * window's layout cropped into the panel is what the user must never see.
 */
function rendersShownInMainWindow({ placements, renders }) {
  const shown = [];
  placements.forEach((placement, index) => {
    if (placement.host !== 'main' || !placement.visible) return;
    const until = placements[index + 1]?.t ?? Number.POSITIVE_INFINITY;
    const onPage = renders.filter((render) => render.t <= placement.t).at(-1);
    if (onPage) shown.push({ ...onPage, shownAt: placement.t });
    for (const render of renders) {
      if (render.t > placement.t && render.t < until) {
        shown.push({ ...render, shownAt: placement.t });
      }
    }
  });
  return shown;
}

function isFullLayout(render) {
  return render.nav || (!render.floating && render.panel);
}

/** Saves a recording's frames and timeline for the before/after page. */
function saveRecording(label, recording, mainShot) {
  const dir = process.env.APP_ADVISOR_OPEN_CAPTURE_DIR;
  if (!dir) return;
  const out = path.join(dir, label);
  mkdirSync(out, { recursive: true });
  if (mainShot) writeFileSync(path.join(out, 'main.png'), mainShot);
  const frames = recording.shots.map((shot, index) => {
    const file = `frame-${String(index).padStart(3, '0')}.png`;
    writeFileSync(path.join(out, file), shot.buffer);
    return { file, t: shot.t - recording.started };
  });
  writeFileSync(
    path.join(out, 'timeline.json'),
    JSON.stringify(
      {
        frames,
        placements: recording.placements.map((placement) => ({
          ...placement,
          t: placement.t - recording.started,
        })),
        clicked:
          recording.clickedAt === undefined
            ? null
            : recording.clickedAt - recording.started,
        renders: recording.renders.map((render) => ({
          ...render,
          t: render.t - recording.started,
        })),
      },
      null,
      2,
    ),
  );
}

test('opening and reopening the floating panel never shows the full layout in it', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch({
    earlyAccess: true,
  });
  try {
    await recordAdvisorRenders(electronApp);
    const mainShot = process.env.APP_ADVISOR_OPEN_CAPTURE_DIR
      ? await window.screenshot({ scale: 'css' })
      : null;

    // First open: App Advisor's page is made and loaded on the click.
    await window.evaluate(() => {
      document.addEventListener(
        'click',
        () => {
          window.__advisorClickedAt = Date.now();
        },
        { capture: true, once: true },
      );
    });
    const coldOpen = await recordOpening(electronApp, () =>
      app.window.getByTestId('sidebar-nav-app-advisor').click(),
    );
    coldOpen.clickedAt = await window.evaluate(() => window.__advisorClickedAt);
    saveRecording('cold-open', coldOpen, mainShot);
    const advisor = await advisorPage(electronApp);
    const panel = advisor.getByTestId('app-advisor-floating');
    await expect(panel).toBeVisible();
    const coldShown = rendersShownInMainWindow(coldOpen);
    expect(coldShown.length).toBeGreaterThan(0);
    expect(coldShown.filter(isFullLayout)).toEqual([]);

    // Hidden, the page stays in the floating layout, in the main window at
    // the panel's place, so reopening shows what it showed last.
    const shownBounds = (await readAdvisorPlacement(electronApp)).bounds;
    const hiddenAt = Date.now();
    await advisor.keyboard.press('ControlOrMeta+w');
    await expect
      .poll(async () => {
        const placement = await readAdvisorPlacement(electronApp);
        return placement?.host === 'main' ? placement.visible : false;
      })
      .toBe(false);
    const parked = await readAdvisorPlacement(electronApp);
    expect(parked.host).toBe('main');
    expect(parked.bounds).toEqual(shownBounds);
    await expect(
      advisor.locator('body[data-app-advisor-floating]'),
    ).toHaveCount(1);
    await expect(advisor.getByTestId('app-advisor-nav')).toHaveCount(0);

    const reopen = await recordOpening(electronApp, () =>
      app.window.getByTestId('sidebar-nav-app-advisor').click(),
    );
    saveRecording('reopen', reopen, mainShot);
    await expect(panel).toBeVisible();
    const reopenShown = rendersShownInMainWindow(reopen);
    expect(reopenShown.length).toBeGreaterThan(0);
    expect(reopenShown.filter(isFullLayout)).toEqual([]);
    expect(
      reopen.renders.filter(
        (render) => render.t >= hiddenAt && isFullLayout(render),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the floating panel switches back to an earlier chat in the same Work Entry', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, app } = await launch({
    earlyAccess: true,
    seed: seedEarlierAdvisorChat,
  });
  try {
    const advisor = await openFromSidebar(app, electronApp);
    const panel = advisor.getByTestId('app-advisor-floating');
    await expect(panel).toBeVisible();
    const title = advisor.getByTestId('app-advisor-floating-title');
    const chats = advisor.getByTestId('app-advisor-floating-chats');
    const earlierItem = chats
      .getByTestId('app-advisor-floating-chat')
      .filter({ hasText: 'Earlier chat' });

    // Open the earlier chat.
    await title.click();
    await earlierItem.click();
    await expect(title).toHaveText('Earlier chat');
    await expect(panel.getByText('Earlier chat answer')).toBeVisible();

    // New chat opens a fresh chat, in the same Work Entry, titled as one.
    await panel.getByRole('button', { name: 'New chat' }).click();
    await expect(title).toHaveText(/^new chat$/i);
    await expect(panel.getByText('Earlier chat answer')).toHaveCount(0);

    // The title's menu goes back to the earlier chat.
    await title.click();
    await expect(earlierItem).toHaveAttribute('aria-checked', 'false');
    await earlierItem.click();
    await expect(title).toHaveText('Earlier chat');
    await expect(panel.getByText('Earlier chat answer')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Sends App Advisor's page a renderer tool request, as an agent's tool call
 * does, and resolves with its response.
 */
function sendAdvisorTool(electronApp, request) {
  return electronApp.evaluate(async ({ BrowserWindow }, rendererRequest) => {
    let advisorContents = null;
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (child.webContents?.getURL().includes('app-advisor')) {
          advisorContents = child.webContents;
        }
      }
    }
    if (!advisorContents) throw new Error('App Advisor page not found');
    // Answered on the page's own IPC, which takes precedence over the app's
    // handler for this page only, so the main window's tool responses (the
    // UI state App Advisor reads for its reply) still reach the app.
    const responseChannel = 'app-advisor:tool-response';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        advisorContents.ipc.removeHandler(responseChannel);
        reject(new Error('Timed out waiting for App Advisor'));
      }, 30_000);
      advisorContents.ipc.handle(responseChannel, (_event, candidate) => {
        if (candidate?.requestId !== rendererRequest.requestId) return;
        clearTimeout(timer);
        advisorContents.ipc.removeHandler(responseChannel);
        resolve(candidate);
      });
      advisorContents.send('app-advisor:tool-request', rendererRequest);
    });
  }, request);
}

test('the floating panel keeps background browsers and expands for a focused file open', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, app } = await launch({
    earlyAccess: true,
    seed: seedEarlierAdvisorChat,
  });
  try {
    const advisor = await openFromSidebar(app, electronApp);
    const panel = advisor.getByTestId('app-advisor-floating');
    await expect(panel).toBeVisible();
    const title = advisor.getByTestId('app-advisor-floating-title');
    await title.click();
    await advisor
      .getByTestId('app-advisor-floating-chats')
      .getByTestId('app-advisor-floating-chat')
      .filter({ hasText: 'Earlier chat' })
      .click();
    await expect(title).toHaveText('Earlier chat');
    const origin = {
      projectId: 'app-advisor',
      worktreeId: 'entry-earlier',
      chatTabId: 'chat-earlier',
    };

    // Agent browser.open requests background placement, so the chat stays
    // floating until the person explicitly opens the full window.
    const opened = await sendAdvisorTool(electronApp, {
      kind: 'dispatch_action',
      requestId: 'floating-browser-open',
      action: { type: 'browser.open' },
      originWorktreeId: origin.worktreeId,
      originChatTabId: origin.chatTabId,
    });
    expect(opened.ok).toBe(true);
    await expect(panel).toBeVisible();
    await expect(advisor.getByTestId('app-advisor-nav')).toHaveCount(0);
    expect((await readAdvisorPlacement(electronApp)).host).toBe('main');
    await panel.getByRole('button', { name: 'Open full window' }).click();
    await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect((await readAdvisorPlacement(electronApp)).host).toBe('full');
    expect(opened.result.browser.id).toEqual(expect.any(String));
    await expect(
      advisor.getByTestId(`browser-pane-${opened.result.browser.id}`),
    ).toBeAttached();

    // A file opened while the person interacts with the floating chat expands
    // to the full layout. Focus the actual composer to establish that state.
    await openFromSidebar(app, electronApp);
    await expect(panel).toBeVisible();
    const composer = panel.locator(
      '[data-chat-composer-root] [contenteditable="true"]',
    );
    await composer.click();
    await composer.focus();
    await expect
      .poll(() => advisor.evaluate(() => document.hasFocus()))
      .toBe(true);
    const { roots } = await advisor.evaluate(
      (target) => window.api.getFileTreeRoots(target),
      { projectId: origin.projectId, worktreeId: origin.worktreeId },
    );
    writeFileSync(
      path.join(roots[0].absolutePath, 'floating-notes.md'),
      '# Floating notes\n',
    );
    const shown = await sendAdvisorTool(electronApp, {
      kind: 'show_files',
      requestId: 'floating-show-files',
      payload: {
        target: { projectId: origin.projectId, worktreeId: origin.worktreeId },
        origin,
        files: [{ path: 'floating-notes.md' }],
      },
    });
    expect(shown.ok).toBe(true);
    expect(shown.result).toMatchObject({ opened: 1, failed: 0 });
    await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect((await readAdvisorPlacement(electronApp)).host).toBe('full');
    const fileTabId = shown.result.files[0].tabId;
    expect(fileTabId).toEqual(expect.any(String));
    await advisor.getByTestId(`panel-tab-panel-file-${fileTabId}`).click();
    await expect(
      advisor.getByText('Floating notes', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** Onboarding done, and App Advisor on a Claude model the mock answers. */
function seedClaudeAdvisor(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'], appAdvisorModel: 'opus[1m]' },
  });
}

/**
 * The toasts each page shows, read from the main process: the main window's
 * own page, its overlay layer (the page toasts move into while they overlap a
 * native view), and App Advisor's page.
 */
function readToasts(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const script = `[...document.querySelectorAll('[data-toast-id]')].map((el) => ({ id: el.getAttribute('data-toast-id'), text: el.innerText }))`;
    const read = async (contents) =>
      contents && !contents.isDestroyed()
        ? contents.executeJavaScript(script).catch(() => [])
        : [];
    const toasts = { main: [], overlay: [], advisor: [] };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (win.getTitle() !== 'App Advisor') {
        toasts.main.push(...(await read(win.webContents)));
      }
      for (const child of win.contentView.children ?? []) {
        const url = child.webContents?.getURL() ?? '';
        if (url === 'about:blank') {
          toasts.overlay.push(...(await read(child.webContents)));
        } else if (url.includes('app-advisor')) {
          toasts.advisor.push(...(await read(child.webContents)));
        }
      }
    }
    return toasts;
  });
}

test('an App Advisor reply that lands while the floating panel is unfocused toasts once, in the main window', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CADVISORFLOATINGTOAST';
  const reply = 'Floating panel reply for the toast check';
  // Streamed slowly, so focus can move to the main window before the turn
  // completes, as when the person goes back to their work after asking.
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: reply, stopReason: 'end_turn', streamMs: 6_000 }],
    },
  });
  const { electronApp, userDataDir, app } = await launch({
    earlyAccess: true,
    seed: seedClaudeAdvisor,
  });
  try {
    const advisor = await openFromSidebar(app, electronApp);
    const panel = advisor.getByTestId('app-advisor-floating');
    await expect(panel).toBeVisible();
    const composer = panel.locator(
      '[data-chat-composer-root] [contenteditable="true"]',
    );
    await composer.click();
    await composer.fill(`[${marker}] Answer while I keep working`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    // The person returns to the main window; the panel stays open.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (win) => win.getTitle() !== 'App Advisor',
      );
      main?.webContents.focus();
    });
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => {
          for (const win of BrowserWindow.getAllWindows()) {
            for (const child of win.contentView.children ?? []) {
              if (child.webContents?.getURL().includes('app-advisor')) {
                return child.webContents.isFocused();
              }
            }
          }
          return null;
        }),
      )
      .toBe(false);
    expect((await readAdvisorPlacement(electronApp)).visible).toBe(true);

    await expect(panel.getByText(reply).first()).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);

    // One toast, in the main window, which mirrors App Advisor's chats.
    await expect
      .poll(async () => {
        const toasts = await readToasts(electronApp);
        return new Set(
          [...toasts.main, ...toasts.overlay]
            .filter((toast) => toast.text.includes('App Advisor'))
            .map((toast) => toast.id),
        ).size;
      })
      .toBe(1);
    // Both renderers handle the completed turn at the same moment; give App
    // Advisor's page the same time to raise a toast of its own.
    await advisor.waitForTimeout(1_500);
    const toasts = await readToasts(electronApp);
    expect(toasts.advisor).toEqual([]);
    expect(
      new Set([...toasts.main, ...toasts.overlay].map((toast) => toast.id))
        .size,
    ).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('without early access App Advisor opens as the full window', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, app } = await launch({
    earlyAccess: false,
  });
  try {
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();
    await expect(advisor.getByTestId('app-advisor-floating')).toHaveCount(0);
    // Its page is the full window's own, not a view in the main window.
    expect(await readAdvisorPlacement(electronApp)).toBeNull();

    if (CAPTURE_DIR) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      for (const mode of ['light', 'dark']) {
        await advisor.evaluate(
          (colorMode) => window.api.savePreferences({ colorMode }),
          mode,
        );
        await expect
          .poll(() =>
            advisor.evaluate(() =>
              document.documentElement.classList.contains('dark'),
            ),
          )
          .toBe(mode === 'dark');
        await advisor.waitForTimeout(400);
        await advisor.screenshot({
          path: path.join(
            CAPTURE_DIR,
            `app-advisor-panel-before-desktop-${mode}.png`,
          ),
        });
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
