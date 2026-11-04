// Opening a new terminal tab is an explicit user gesture: the new terminal
// must take the caret so the user can start typing straight away, whichever
// entry point opened it.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS, spawnPanelTerminal } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

function scrubBundledBinaryOverrides() {
  for (const key of Object.keys(process.env)) {
    if (/^CANOPY_[A-Z0-9]+_BINARY_PATH$/.test(key)) delete process.env[key];
  }
}

/** The panel id of the terminal holding the caret, or null. */
function caretTerminalId(window) {
  return window.evaluate(() => {
    const pane = document.activeElement?.closest(
      '[data-testid="terminal-panel-surface"]',
    );
    return pane?.querySelector('[data-testid="terminal-pane"]')
      ? (pane.getAttribute('data-panel-id') ?? 'unknown')
      : null;
  });
}

test.describe('new terminal tab focus', () => {
  test.setTimeout(180_000);

  test('a newly opened terminal tab takes the caret', async () => {
    scrubBundledBinaryOverrides();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-terminal-new-tab-focus-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await spawnPanelTerminal(window);
      const terminalTabs = window.locator(
        '[data-testid^="panel-tab-panel-terminal"]',
      );
      await expect(terminalTabs).toHaveCount(1);
      const composer = window
        .getByTestId('panel-content-chat')
        .getByRole('textbox')
        .first();

      const expectCaretInNewestTerminal = async (label) => {
        const newestPanelId = await terminalTabs
          .last()
          .getAttribute('data-testid')
          .then((id) => id?.replace(/^panel-tab-/, ''));
        await expect
          .poll(() => caretTerminalId(window), {
            timeout: 10_000,
            message: `${label}: caret should be in ${newestPanelId}`,
          })
          .toBe(newestPanelId);
        // Typing must reach the new shell without another click.
        const marker = `new-tab-focus-${label}`;
        await window.keyboard.type(`echo ${marker}`);
        await window.keyboard.press('Enter');
        await expect(
          window
            .locator(
              `[data-testid="terminal-panel-surface"][data-panel-id="${newestPanelId}"]`,
            )
            .getByTestId('terminal-pane'),
        ).toContainText(marker, { timeout: 20_000 });
      };

      // --- `+` → Terminal → default shell ---------------------------------
      await composer.click();
      await window
        .getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await window.getByTestId('panel-add-menu-terminal-submenu').click();
      await window
        .getByTestId('panel-add-menu-terminal-group')
        .getByTestId('panel-add-menu-item-terminal')
        .click();
      await expect(terminalTabs).toHaveCount(2, { timeout: 20_000 });
      await expectCaretInNewestTerminal('menu');

      // --- The terminal group's quick-add button --------------------------
      await composer.click();
      await window
        .getByTestId(`panel-quick-add-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await expect(terminalTabs).toHaveCount(3, { timeout: 20_000 });
      await expectCaretInNewestTerminal('quickadd');

      // --- Cmd/Ctrl+T while a terminal is selected ------------------------
      await window.keyboard.press('ControlOrMeta+t');
      await expect(terminalTabs).toHaveCount(4, { timeout: 20_000 });
      await expectCaretInNewestTerminal('shortcut');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
