// ⌘W / Ctrl+W ownership (hotkeys rework): the application menu deliberately
// binds NO accelerator to Close Window (main/menu.ts), so the chord reaches
// the renderer, which owns it unconditionally (useGlobalShortcuts). Pressing
// it closes the active chat tab when one is open and is a swallowed no-op
// otherwise — the WINDOW must never close. Previously the menu's `close` role
// accelerator fired before the renderer saw the keydown and closed the whole
// BrowserWindow.
//
// ECW-7984 also made the chord CONTEXT-AWARE: it closes a tab of the FOCUSED
// surface, so with keyboard focus on a browser tab it closes that browser tab
// (not a chat tab). The renderer-half routing has unit coverage in
// `closeTabShortcut.test.ts`; this spec proves the browser-chrome path
// end-to-end.
//
// CAN-4649: the chord also closes the tab while the NATIVE browser page owns
// keyboard focus. Playwright cannot type into the `WebContentsView` (it is
// outside the renderer DOM), so that test focuses the page's webContents in
// main and synthesizes the keydown with `sendInputEvent`, which runs through
// the same `before-input-event` interception as a real key press.

import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  chatPanelLocator,
  DEFAULT_PANEL_IDS,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
  spawnPanelTerminal,
} from './panelHarness.mjs';

const BROWSER_OWNER = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};

/** Serves pages titled by their path so each native view can be located. */
async function startTitledPages() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><html><head><title>close-tab ${request.url}</title></head><body><h1>${request.url}</h1></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Loopback server has no port');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

/** Lists the titles of the native browser page views in the main window. */
function nativePageTitles(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const titles = [];
    const collect = (view) => {
      for (const child of view?.children ?? []) {
        const title = child.webContents?.getTitle();
        if (title?.startsWith('close-tab ')) titles.push(title);
        collect(child);
      }
    };
    for (const candidate of BrowserWindow.getAllWindows()) {
      collect(candidate.contentView);
    }
    return titles;
  });
}

/**
 * Focuses the native page titled `title` and presses Cmd+W (macOS) or Ctrl+W
 * inside it, as a user would after clicking into the page.
 */
function pressCloseTabInNativePage(electronApp, title) {
  return electronApp.evaluate(({ BrowserWindow }, pageTitle) => {
    const find = (view) => {
      for (const child of view?.children ?? []) {
        if (child.webContents?.getTitle() === pageTitle) {
          return child.webContents;
        }
        const nested = find(child);
        if (nested) return nested;
      }
      return undefined;
    };
    let contents;
    for (const candidate of BrowserWindow.getAllWindows()) {
      contents = find(candidate.contentView);
      if (contents) break;
    }
    if (!contents) throw new Error(`Native page not found: ${pageTitle}`);
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'w', modifiers });
  }, title);
}

test('ControlOrMeta+W closes the active chat tab, never the window', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const seededChat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(seededChat).toBeVisible();

    await window.keyboard.press('ControlOrMeta+w');

    // The seeded tab is gone (a fallback chat tab may take its place; the
    // assertion targets the seeded id so either behavior passes)...
    await expect(seededChat).toHaveCount(0);
    // ...and the window survived the chord.
    expect(window.isClosed()).toBe(false);

    // Repeat presses must also never fall through to a window close, even
    // when there is nothing left to close in the current posture.
    await window.keyboard.press('ControlOrMeta+w');
    await window.keyboard.press('ControlOrMeta+w');
    await window.waitForTimeout(250);
    expect(window.isClosed()).toBe(false);
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('ControlOrMeta+W closes the focused browser tab, not a chat tab (ECW-7984)', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const seededChat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(seededChat).toBeVisible();

    // Open a Browser panel in the terminal group (each browser is its own
    // panel post browser-panel-refactor).
    await window.getByTestId('panel-add-panel-group-terminal').click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await window.getByTestId('panel-add-menu-item-browser').click();
    await expect(window.getByTestId('browser-panel-surface')).toBeVisible();

    // The browser panel tab (grid chrome, `panel-tab-panel-browser-<id>`).
    const browserTab = window.locator(
      '[data-testid^="panel-tab-panel-browser-"]',
    );
    await expect(browserTab).toHaveCount(1);

    // Focus the browser panel via its tab (grid chrome — NOT the xterm DOM and
    // NOT the native page), so the browser group is active with the browser as
    // its active panel: the exact repro of "focused on a browser tab". Using
    // grid chrome also keeps the chord platform-agnostic (a focused xterm would
    // keep Ctrl+W for the shell per CAN-338).
    await browserTab.click();

    await window.keyboard.press('ControlOrMeta+w');

    // The focused browser tab is closed (its surface unmounts); the chat tab is
    // untouched, and the window survives.
    await expect(browserTab).toHaveCount(0);
    await expect(window.getByTestId('browser-panel-surface')).toHaveCount(0);
    await expect(seededChat).toBeVisible();
    expect(window.isClosed()).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('ControlOrMeta+W closes one terminal tab, not all of them (ECW-7984)', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const seededChat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(seededChat).toBeVisible();

    // Each terminal session is its own repeatable outer workspace panel tab.
    const terminalTabs = window.locator(
      '[data-testid^="panel-tab-panel-terminal"]',
    );
    const terminalPanelTab = window.getByTestId(
      `panel-tab-${DEFAULT_PANEL_IDS.terminal}`,
    );

    // Spawn and bind the default terminal panel...
    await spawnPanelTerminal(window);
    await expect(terminalTabs).toHaveCount(1);

    // ...then a second via ⌘/Ctrl+T. Drive from the panel tab (grid chrome):
    // a focused xterm keeps Ctrl chords for the shell (CAN-338), so the chord
    // must not be pressed while the terminal DOM owns focus.
    await terminalPanelTab.click();
    await window.keyboard.press('ControlOrMeta+t');
    await expect(terminalTabs).toHaveCount(2);

    // Close the active terminal from grid chrome (⌘/Ctrl+T just focused the
    // new terminal's xterm, so focus its outer panel tab first).
    await terminalTabs.last().click();
    await window.keyboard.press('ControlOrMeta+w');

    // Exactly ONE terminal panel closed — the other terminal, the chat, and
    // the window all survive.
    await expect(terminalTabs).toHaveCount(1);
    await expect(window.getByTestId('terminal-panel-surface')).toBeVisible();
    await expect(seededChat).toBeVisible();
    expect(window.isClosed()).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('ControlOrMeta+W inside the native browser page closes exactly that tab (CAN-4649)', async () => {
  test.setTimeout(180_000);
  const { origin, server } = await startTitledPages();
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const seededChat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
    await expect(seededChat).toBeVisible();

    const { browser: closing, panelId: closingPanelId } =
      await seedVisibleBrowserPanel(window, {
        ...BROWSER_OWNER,
        url: `${origin}/closing`,
      });
    const { panelId: survivingPanelId } = await seedVisibleBrowserPanel(
      window,
      {
        ...BROWSER_OWNER,
        url: `${origin}/surviving`,
      },
    );
    const browserTabs = window.locator(
      '[data-testid^="panel-tab-panel-browser-"]',
    );
    await expect(browserTabs).toHaveCount(2);

    // Show the closing tab so its native page is attached and live.
    await window.getByTestId(`panel-tab-${closingPanelId}`).click();
    await expect(
      window.getByTestId(`browser-pane-${closing.id}`),
    ).toHaveAttribute('data-browser-state', 'live');
    await expect
      .poll(() => nativePageTitles(electronApp))
      .toContain('close-tab /closing');

    await pressCloseTabInNativePage(electronApp, 'close-tab /closing');

    // Exactly the pressed tab closes: main hands focus back to the host
    // before forwarding the chord, and the host must not close a second tab.
    await expect(window.getByTestId(`panel-tab-${closingPanelId}`)).toHaveCount(
      0,
    );
    await expect(browserTabs).toHaveCount(1);
    await expect(
      window.getByTestId(`panel-tab-${survivingPanelId}`),
    ).toBeVisible();
    await expect(seededChat).toBeVisible();
    expect(window.isClosed()).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => server.close(resolve));
  }
});
