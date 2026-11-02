// CAN-4616: next / previous tab in the active panel group. macOS binds
// ⌘⇧] / ⌘⇧[ (matched by physical key, since Shift turns `]` into `}`);
// Windows and Linux bind Ctrl+Tab / Ctrl+Shift+Tab with Ctrl+PageDown /
// Ctrl+PageUp as the alternate. The cycle wraps at both ends, runs from the
// composer (the chords never edit text), and selects like a tab click, so a
// browser or terminal tab it lands on does not trap the next press. That
// includes a focused terminal on Windows/Linux, where xterm would otherwise
// send Ctrl+Tab to the shell, and a focused native browser page, whose keys
// main forwards to the renderer.
//
// The dispatcher routing has unit coverage in `useGlobalShortcuts.test.ts`
// and the command in `panel-commands.test.ts`; this spec proves the chords
// end to end in the real window. Playwright cannot type into the native
// `WebContentsView`, so the native-page test focuses the page in main and
// synthesizes the chord with `sendInputEvent`, which runs through the same
// `before-input-event` interception as a real key press.

import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
  spawnPanelTerminal,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const MAC = process.platform === 'darwin';
const NEXT = MAC ? 'Meta+Shift+BracketRight' : 'Control+Tab';
const PREVIOUS = MAC ? 'Meta+Shift+BracketLeft' : 'Control+Shift+Tab';
// The harness waits for the seeded chat's panel, so it stays first.
const CHAT_IDS = [SEEDED_CHAT_TAB_ID, 'chat-two', 'chat-three'];

/** Seeds the demo worktree with three chat tabs, the first one active. */
function seedThreeChats() {
  return seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir, workspaceIds }) => {
      seedWorktreeChat({
        userDataDir,
        workspaceId: workspaceIds[0],
        worktreeId: 'demo-main',
        providerType: 'claude',
        tabs: CHAT_IDS.map((id, index) => ({
          id,
          title: `Chat ${index + 1}`,
        })),
        activeTabId: CHAT_IDS[0],
      });
    },
  });
}

/** Serves pages titled by their path so a native view can be located. */
async function startTitledPages() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><html><head><title>tab-cycle ${request.url}</title></head><body><h1>${request.url}</h1></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Loopback server has no port');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

/** Lists the titles of the native browser page views. */
function nativePageTitles(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const titles = [];
    const collect = (view) => {
      for (const child of view?.children ?? []) {
        const title = child.webContents?.getTitle();
        if (title?.startsWith('tab-cycle ')) titles.push(title);
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
 * How many times main has focused an app renderer since the last chord sent
 * by {@link pressNextTabInNativePage}. A headless window never holds OS
 * focus, so `isFocused()` reads false everywhere; the handoff main makes is
 * checked through its `focus()` calls instead.
 */
function rendererFocusCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__tabCycleRendererFocus ?? 0);
}

/**
 * Focuses the native page titled `title` and presses the next-tab chord
 * inside it, as a user would after clicking into the page.
 */
function pressNextTabInNativePage(electronApp, title) {
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
    for (const candidate of BrowserWindow.getAllWindows()) {
      const renderer = candidate.webContents;
      if (renderer.__tabCycleFocusCounted) continue;
      const focus = renderer.focus.bind(renderer);
      renderer.focus = () => {
        globalThis.__tabCycleRendererFocus =
          (globalThis.__tabCycleRendererFocus ?? 0) + 1;
        focus();
      };
      renderer.__tabCycleFocusCounted = true;
    }
    const mac = process.platform === 'darwin';
    const keyCode = mac ? ']' : 'Tab';
    const modifiers = mac ? ['meta', 'shift'] : ['control'];
    contents.focus();
    globalThis.__tabCycleRendererFocus = 0;
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, title);
}

function panelTab(window, panelId) {
  return window.getByTestId(`panel-tab-${panelId}`);
}

async function expectActiveChat(window, chatId) {
  await expect(panelTab(window, `panel-chat-${chatId}`)).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(
    window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    ),
  ).toBeVisible();
}

test.describe('switch panel tab shortcut (CAN-4616)', () => {
  test.setTimeout(180_000);

  test('cycles the active group, wraps, works from the composer, and is listed', async () => {
    const { electronApp, userDataDir, window } = await seedThreeChats();

    try {
      // Make the chat group active from grid chrome.
      await panelTab(window, `panel-chat-${CHAT_IDS[0]}`).click();
      await expectActiveChat(window, CHAT_IDS[0]);

      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[1]);
      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[2]);
      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[0]);
      await window.keyboard.press(PREVIOUS);
      await expectActiveChat(window, CHAT_IDS[2]);

      if (!MAC) {
        await window.keyboard.press('Control+PageDown');
        await expectActiveChat(window, CHAT_IDS[0]);
        await window.keyboard.press('Control+PageUp');
        await expectActiveChat(window, CHAT_IDS[2]);
      }

      // From the composer: the chord switches tabs and leaves the typed text
      // alone, and a second press still reaches the app after the composer
      // that held focus was hidden.
      const composer = window
        .locator(
          `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_IDS[2]}"]`,
        )
        .locator('[data-chat-textarea]')
        .first();
      await composer.click();
      await window.keyboard.type('cycle marker');
      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[0]);
      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[1]);
      await window.keyboard.press(NEXT);
      await expectActiveChat(window, CHAT_IDS[2]);
      await expect(composer).toHaveText('cycle marker');

      // Settings › Keyboard shortcuts lists both commands.
      await window.keyboard.press('ControlOrMeta+Shift+k');
      const shortcuts = window.getByTestId('settings-tab-shortcuts');
      await expect(shortcuts).toBeVisible();
      await expect(
        shortcuts
          .getByTestId('shortcut-row-panel-select-next-tab')
          .locator('kbd'),
      ).toHaveText(MAC ? ['⌘', '⇧', ']'] : ['Ctrl', 'Tab']);
      await expect(
        shortcuts
          .getByTestId('shortcut-row-panel-select-previous-tab')
          .locator('kbd'),
      ).toHaveText(MAC ? ['⌘', '⇧', '['] : ['Ctrl', 'Shift', 'Tab']);

      // The settings overlay owns the keyboard: the chord changes nothing.
      await window.keyboard.press(NEXT);
      await window.keyboard.press('Escape');
      await expectActiveChat(window, CHAT_IDS[2]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // Selecting the terminal tab focuses the terminal, so on Windows/Linux the
  // next Ctrl+Tab arrives from inside xterm.
  test('keeps cycling across terminal and browser tabs', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      await spawnPanelTerminal(window);
      const { browser, panelId: browserPanelId } =
        await seedVisibleBrowserPanel(
          window,
          { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
          { moveToGroupId: DEFAULT_GROUP_IDS.terminal },
        );
      const terminalTab = panelTab(window, DEFAULT_PANEL_IDS.terminal);
      const browserTab = panelTab(window, browserPanelId);

      await terminalTab.click();
      await expect(terminalTab).toHaveAttribute('data-active', 'true');

      // Onto the browser: it attaches as a click would.
      await window.keyboard.press(NEXT);
      await expect(browserTab).toHaveAttribute('data-active', 'true');
      await expect(
        window.getByTestId(`browser-pane-${browser.id}`),
      ).toBeVisible();

      // The next press still reaches the app (no trap in the native view).
      await window.keyboard.press(NEXT);
      await expect(terminalTab).toHaveAttribute('data-active', 'true');
      await expect(window.getByTestId('terminal-pane')).toBeVisible();

      // ...and out of the terminal again.
      await window.keyboard.press(PREVIOUS);
      await expect(browserTab).toHaveAttribute('data-active', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cycles out of a focused native browser page', async () => {
    const { origin, server } = await startTitledPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      await spawnPanelTerminal(window);
      const { browser, panelId: browserPanelId } =
        await seedVisibleBrowserPanel(
          window,
          {
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
            url: `${origin}/page`,
          },
          { moveToGroupId: DEFAULT_GROUP_IDS.terminal },
        );
      const terminalTab = panelTab(window, DEFAULT_PANEL_IDS.terminal);
      const browserTab = panelTab(window, browserPanelId);

      // Show the browser so its native page is attached and live.
      await browserTab.click();
      await expect(
        window.getByTestId(`browser-pane-${browser.id}`),
      ).toHaveAttribute('data-browser-state', 'live');
      await expect
        .poll(() => nativePageTitles(electronApp))
        .toContain('tab-cycle /page');

      // The chord pressed inside the page moves to the next tab, wrapping
      // from the browser (last) to the terminal (first).
      await pressNextTabInNativePage(electronApp, 'tab-cycle /page');
      await expect(terminalTab).toHaveAttribute('data-active', 'true');
      await expect(window.getByTestId('terminal-pane')).toBeVisible();

      // Hiding the page handed keyboard focus to the window.
      await expect.poll(() => rendererFocusCalls(electronApp)).toBe(1);
      await window.keyboard.press(NEXT);
      await expect(browserTab).toHaveAttribute('data-active', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('leaves focus in a native page whose group has nothing to cycle to', async () => {
    const { origin, server } = await startTitledPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      // The browser gets its own group, so it is that group's only tab.
      const { browser, panelId: browserPanelId } =
        await seedVisibleBrowserPanel(
          window,
          {
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
            url: `${origin}/alone`,
          },
          { moveToGroupId: DEFAULT_GROUP_IDS.chat, moveEdge: 'right' },
        );
      const browserTab = panelTab(window, browserPanelId);
      await browserTab.click();
      await expect(
        window.getByTestId(`browser-pane-${browser.id}`),
      ).toHaveAttribute('data-browser-state', 'live');
      await expect
        .poll(() => nativePageTitles(electronApp))
        .toContain('tab-cycle /alone');
      await expect(
        window.locator(
          `[data-testid^="panel-tab-"][data-group-id="${await browserTab.getAttribute('data-group-id')}"]`,
        ),
      ).toHaveCount(1);

      await pressNextTabInNativePage(electronApp, 'tab-cycle /alone');

      // Nothing else to select: the tab stays, and main never takes focus
      // from the page, so typing still reaches it.
      await expect(browserTab).toHaveAttribute('data-active', 'true');
      await expect(
        window.getByTestId(`browser-pane-${browser.id}`),
      ).toHaveAttribute('data-browser-state', 'live');
      // A no-op leaves nothing to wait for, so give main time to have acted.
      await window.waitForTimeout(1_000);
      expect(await rendererFocusCalls(electronApp)).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
