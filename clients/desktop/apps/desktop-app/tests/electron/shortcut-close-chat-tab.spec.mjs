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

import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  chatPanelLocator,
  DEFAULT_PANEL_IDS,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
  spawnPanelTerminal,
} from './panelHarness.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const COWORK_WORKSPACE_ID = 'cowork-default';
const COWORK_ENTRY_ID = 'entry-close';

const BROWSER_OWNER = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};

/**
 * Seeds a sole Cowork workspace with one work entry holding two persisted
 * chat tabs, each with a user message so neither is the auto-provisioned
 * empty chat.
 */
function seedCoworkEntryWithTwoChats(userDataDir) {
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    COWORK_WORKSPACE_ID,
  );
  const createdAt = '2026-10-27T12:00:00.000Z';
  const cowork = { createdAt, archiveRetentionDays: null };

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_WORKSPACE_ID,
        name: 'Close Tab Project',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork,
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt }],
  });

  const userMessage = (id, text) => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: Date.parse(createdAt),
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: COWORK_WORKSPACE_ID,
    worktreeId: COWORK_ENTRY_ID,
    tabs: [
      {
        id: 'chat-keep',
        title: 'Keep',
        createdAt,
        messages: [userMessage('message-keep', 'Keep this chat open.')],
      },
      {
        id: 'chat-close',
        title: 'Close me',
        createdAt,
        messages: [userMessage('message-close', 'Close this chat.')],
      },
    ],
    activeTabId: 'chat-close',
  });
}

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
    await window.getByTestId('panel-add-tab-group-terminal').click();
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

test('ControlOrMeta+W closes the active Cowork chat tab, never the window', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-close-tab-'),
  );
  seedCoworkEntryWithTwoChats(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // A sole Cowork workspace has no toggle and is force-expanded (CAN-2672).
    const workEntry = window.getByTestId(
      `sidebar-work-entry-${COWORK_ENTRY_ID}`,
    );
    await expect(workEntry).toBeVisible({ timeout: 15_000 });
    await workEntry.click();
    const coworkTopBar = window.getByTestId('cowork-top-bar');
    await expect(coworkTopBar).toBeVisible({ timeout: 15_000 });

    const closingTab = window.getByTestId('panel-tab-panel-chat-chat-close');
    const keptTab = window.getByTestId('panel-tab-panel-chat-chat-keep');
    await expect(closingTab).toBeVisible();
    await expect(keptTab).toBeVisible();

    // Focus the chat group from grid chrome so the chord targets its active
    // panel, as in the browser-tab test above.
    await closingTab.click();
    await window.keyboard.press('ControlOrMeta+w');

    await expect(closingTab).toHaveCount(0);
    await expect(keptTab).toBeVisible();
    await expect(coworkTopBar).toBeVisible();
    expect(window.isClosed()).toBe(false);

    // Closing the last chat replaces it in place (as the tab's "X" does), so
    // the group keeps a chat tab and the window never closes.
    await window.keyboard.press('ControlOrMeta+w');
    await expect(keptTab).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="panel-tab-panel-chat-"]').first(),
    ).toBeVisible();
    await window.keyboard.press('ControlOrMeta+w');
    await window.waitForTimeout(250);
    expect(window.isClosed()).toBe(false);
    await expect(coworkTopBar).toBeVisible();
    await expect(
      window.locator('[data-testid^="panel-tab-panel-chat-"]').first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
