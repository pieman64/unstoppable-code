// ECW-7984 — context-aware Cmd/Ctrl+T + browser-owned hotkeys.
//
// SCOPE. Covers the RENDERER halves of the hotkey routing:
//
//   1. ⌘/Ctrl+T resolves the focused window + active surface before choosing
//      an action: chat focus → new chat tab, browser surface active → exactly
//      one new browser tab with its address bar focused, terminal panel
//      active → new terminal tab, and non-tabbed pages (Audit) fall back to
//      the command palette seeded with "new" — never a silent chat tab or
//      navigation. Returning focus to chat restores chat behavior.
//   2. Browser-chrome history chords: with keyboard focus on the browser tab
//      strip, ⌘/Ctrl+← goes back and ⌘/Ctrl+→ goes forward using only the
//      active tab's own history (safe no-op when unavailable), and ⌘/Ctrl+L
//      focuses the address bar.
//
// The NATIVE-page half (chords pressed while the `WebContentsView` page owns
// keyboard focus) cannot be driven by Playwright — the native overlay is
// outside the renderer DOM (same carve-out as browser-chrome.spec.mjs). That
// path is covered by unit tests instead: `browser-shortcuts.test.ts` (chord
// resolution per platform) and `browser-service.test.ts` (before-input-event
// wiring, safe no-ops, and the forwarded `shortcut` browser events).
//
// History-chord DETERMINISM: real navigations are needed for real history, so
// the spec runs a loopback HTTP server and navigates the in-app browser to it
// (allowed by the default URL policy; the browser-chrome spec's local-only
// setting is not enabled here).

import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { DEFAULT_PANEL_IDS, seedPanelWorktree } from './panelHarness.mjs';

test.describe('context-aware new-tab + browser hotkeys (ECW-7984)', () => {
  test.setTimeout(180_000);

  test('Cmd/Ctrl+T creates the focused surface tab type and falls back to the palette', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      const chatPanels = window.locator('[data-testid="panel-content-chat"]');
      // Every open chat tab keeps its panel frame mounted; only the active
      // tab's frame is visible, so clicks must target the visible one.
      const visibleChatPanel = window.locator(
        '[data-testid="panel-content-chat"]:visible',
      );
      // Each in-app browser is its own panel post browser-panel-refactor, so
      // browser tabs are panel tabs (`panel-tab-panel-browser-<id>`).
      const browserTabs = window.locator(
        '[data-testid^="panel-tab-panel-browser-"]',
      );

      // --- Chat focus → a second chat tab -----------------------------------
      await expect(chatPanels).toHaveCount(1);
      // Focus the chat group deterministically before the chord.
      await visibleChatPanel.click();
      await window.keyboard.press('ControlOrMeta+t');
      await expect(chatPanels).toHaveCount(2);

      // --- Browser surface active → exactly one new browser tab -------------
      // Adding a Browser panel creates one browser directly (no separate
      // "new browser" affordance); activating its panel tab makes the browser
      // the active surface so ⌘/Ctrl+T routes to a new browser tab.
      await window.getByTestId('panel-add-panel-group-terminal').click();
      await expect(window.getByTestId('panel-add-menu')).toBeVisible();
      await window.getByTestId('panel-add-menu-item-browser').click();
      await expect(window.getByTestId('browser-panel-surface')).toBeVisible();
      await expect(browserTabs).toHaveCount(1);
      await browserTabs.first().click();

      await window.keyboard.press('ControlOrMeta+t');
      // Exactly one NEW browser tab (2 total), selected, address bar focused —
      // and no chat tab was created.
      await expect(browserTabs).toHaveCount(2);
      // Inactive browser panes stay mounted (each renders its own bar), so
      // assert exactly one FOCUSED address bar — the freshly created tab's.
      await expect(
        window.locator('[data-testid="browser-url-input"]:focus'),
      ).toHaveCount(1);
      await expect(chatPanels).toHaveCount(2);

      // --- Terminal panel active → a terminal spawns -------------------------
      // Revealing the terminal panel auto-starts its terminal (#3690), so the
      // chord adds a second terminal rather than spawning the first. Select
      // the terminal panel tab (grid chrome, not xterm DOM, so the chord
      // routes identically on macOS and Windows/Linux — a focused xterm keeps
      // Ctrl chords for the shell per CAN-338).
      const terminalTabs = window.locator(
        '[data-testid^="panel-tab-panel-terminal"]',
      );
      await window
        .getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`)
        .click();
      await expect(window.getByTestId('terminal-pane')).toHaveCount(1, {
        timeout: 20_000,
      });
      await expect(terminalTabs).toHaveCount(1);
      // Second click: re-select the terminal tab after the auto-start, as the
      // pre-#3690 flow did before its second terminal chord.
      await window
        .getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`)
        .click();
      await window.keyboard.press('ControlOrMeta+t');
      await expect(terminalTabs).toHaveCount(2, { timeout: 20_000 });
      await expect(window.getByTestId('terminal-pane').last()).toBeVisible({
        timeout: 20_000,
      });
      // No extra browser/chat tabs from the terminal chord.
      await expect(browserTabs).toHaveCount(2);
      await expect(chatPanels).toHaveCount(2);

      // The second terminal becomes the terminal group's active tab. Leaving
      // that group and pressing Ctrl+` must reveal that active terminal, not
      // the first terminal retained in layout insertion order.
      await expect(terminalTabs.last()).toHaveAttribute('data-active', 'true');
      await visibleChatPanel.click();
      await window.keyboard.press('Control+Backquote');
      await expect(terminalTabs.last()).toHaveAttribute('data-active', 'true');

      // --- Returning focus to chat restores chat behavior --------------------
      await visibleChatPanel.click();
      await window.keyboard.press('ControlOrMeta+t');
      await expect(chatPanels).toHaveCount(3);
      await expect(browserTabs).toHaveCount(2);

      // --- Non-tabbed page → documented palette fallback ---------------------
      await window.keyboard.press('ControlOrMeta+6');
      await expect(window.getByTestId('page-audit')).toBeVisible();
      await window.keyboard.press('ControlOrMeta+t');
      const palette = window.getByTestId('command-palette');
      await expect(palette).toBeVisible();
      await expect(window.getByTestId('command-palette-input')).toHaveValue(
        'new',
      );
      // No navigation away from the audit page, and no hidden chat tab.
      await expect(window.getByTestId('page-audit')).toBeVisible();
      await expect(chatPanels).toHaveCount(3);
      await window.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('browser chrome chords: history back/forward on the active tab and address-bar focus', async () => {
    // Loopback pages give the browser REAL history entries. Titles carry the
    // path so the spec can wait for a COMMITTED navigation (the URL input
    // reflects the optimistic pre-commit URL, but the tab label only shows
    // the title after the page actually loads — navigating again before the
    // first commit would supersede it and leave no back entry).
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>page ${req.url}</title><h1>${req.url}</h1>`,
      );
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const { port } = server.address();

    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      await window.getByTestId('panel-add-panel-group-terminal').click();
      await expect(window.getByTestId('panel-add-menu')).toBeVisible();
      await window.getByTestId('panel-add-menu-item-browser').click();
      await expect(window.getByTestId('browser-panel-surface')).toBeVisible();

      const urlInput = window.getByTestId('browser-url-input');
      await expect(urlInput).toBeVisible();
      // Browser tabs are panel tabs; the panel tab's label resolves to the live
      // page title, so it can gate on a COMMITTED navigation.
      const browserTab = window
        .locator('[data-testid^="panel-tab-panel-browser-"]')
        .first();
      // Browser CHROME focus for the arrow chords: a non-editable toolbar
      // button INSIDE the browser surface (`[data-browser-surface]`). `.focus()`
      // (not click) avoids triggering it, and it is re-focused before each chord
      // because the refresh button briefly unmounts (→ stop button) during a
      // load.
      const focusBrowserChrome = () =>
        window.getByTestId('browser-refresh').focus();

      // Two real, COMMITTED navigations → one back entry. Wait for each
      // page's title in the tab label before continuing so the second load
      // cannot supersede a still-pending first load.
      await urlInput.fill(`http://127.0.0.1:${port}/a`);
      await urlInput.press('Enter');
      await expect(browserTab).toContainText('page /a', { timeout: 20_000 });
      await urlInput.fill(`http://127.0.0.1:${port}/b`);
      await urlInput.press('Enter');
      await expect(browserTab).toContainText('page /b', { timeout: 20_000 });
      await expect(window.getByTestId('browser-back')).toBeEnabled();

      // Focus browser CHROME so the arrow chords are browser-owned.
      await focusBrowserChrome();
      await window.keyboard.press('ControlOrMeta+ArrowLeft');
      await expect(browserTab).toContainText('page /a', { timeout: 20_000 });
      // The address bar mirrors the committed back navigation.
      await expect
        .poll(() => urlInput.inputValue(), { timeout: 20_000 })
        .toContain('/a');
      await expect(window.getByTestId('browser-forward')).toBeEnabled();

      await focusBrowserChrome();
      await window.keyboard.press('ControlOrMeta+ArrowRight');
      await expect(browserTab).toContainText('page /b', { timeout: 20_000 });
      await expect
        .poll(() => urlInput.inputValue(), { timeout: 20_000 })
        .toContain('/b');

      // Forward again with no forward entry → safe no-op, URL unchanged.
      await focusBrowserChrome();
      await window.keyboard.press('ControlOrMeta+ArrowRight');
      await window.waitForTimeout(500);
      expect(await urlInput.inputValue()).toContain('/b');

      // ⌘/Ctrl+L from browser chrome focuses the address bar.
      await focusBrowserChrome();
      await window.keyboard.press('ControlOrMeta+l');
      await expect(urlInput).toBeFocused();

      // Exactly one browser tab throughout — history chords never create or
      // touch another tab.
      await expect(
        window.locator('[data-testid^="panel-tab-panel-browser-"]'),
      ).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      server.close();
    }
  });
});
