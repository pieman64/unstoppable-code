// CAN-338 — terminal key chords must retain their modifiers in the integrated
// terminal.
//
// SCOPE. Verifies that control-key combos typed into a focused integrated
// terminal reach the shell instead of being stolen by app-level key handling
// (renderer global shortcuts, the application menu's reload accelerator, or
// the main-process before-input-event guard). The two probes:
//
//   1. Ctrl+R — reverse history search. After running a command, pressing
//      Ctrl+R must surface bash's `(reverse-i-search)` prompt, and typing a
//      fragment must recall the earlier command.
//   2. Ctrl+U — kill-line. Typed-but-not-submitted text must be cleared so a
//      subsequent command runs clean.
//   3. Shift+Enter — emits the Esc+CR sequence expected by terminal TUIs for
//      a modified Enter, rather than collapsing to plain CR and submitting.
//   4. Cursor movement (CAN-4528) — Left, Ctrl+B (readline backward-char,
//      the mirror of the Ctrl+F the find bar claims on Windows/Linux), and
//      Right (forward-char's replacement there) still edit the shell line.
//
// DETERMINISM. The user's login shell varies (zsh on macOS shows
// `bck-i-search`, bash shows `(reverse-i-search)`), so the spec starts an
// inner `bash --norc --noprofile` session inside the spawned terminal and
// asserts against bash's stable prompt strings. Terminal output is read from
// the xterm DOM rows under the `terminal-pane` test id (xterm's DOM renderer
// keeps viewport rows in the document).
//
// FLOW. Seed a demo workspace, select the `demo-main` worktree so the panel
// grid mounts (Phase 3 cutover: the terminal is an always-expanded grid group,
// not a collapsed drawer, and nothing auto-spawns), spawn the first terminal
// from the surface's empty state via `spawnPanelTerminal`, then drive
// keystrokes through the focused xterm instance.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';

const WORKTREE_BRANCH = 'demo-main';

test.describe('integrated terminal modified-key support (CAN-338)', () => {
  test.setTimeout(120_000);

  test('Ctrl+R opens reverse-i-search and Ctrl+U clears the pending line', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-terminal-keys-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      // Selecting the worktree mounts the panel grid; the terminal group is
      // always expanded but starts with no terminals (no drawer auto-spawn
      // anymore), so spawn the first one from the surface's empty state.
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const pane = await spawnPanelTerminal(window);

      // Focus the terminal and wait for the spawned shell's prompt by probing
      // with a sentinel echo (prompt strings vary per user shell).
      await pane.click();
      const paneText = () => pane.innerText();

      await window.keyboard.type('echo canopy-shell-ready');
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 20_000 })
        .toContain('canopy-shell-ready');

      // Enter a deterministic inner bash so reverse-i-search prompt copy is
      // stable regardless of the user's login shell.
      await window.keyboard.type('bash --norc --noprofile');
      await window.keyboard.press('Enter');
      await window.keyboard.type('echo canopy-history-probe');
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 20_000 })
        .toContain('canopy-history-probe');

      // --- Ctrl+R: reverse-i-search prompt appears and recalls history -----
      await window.keyboard.press('Control+r');
      await expect
        .poll(paneText, { timeout: 10_000 })
        .toContain('reverse-i-search');

      await window.keyboard.type('history-probe');
      // The matched command is echoed inside the search prompt line.
      await expect
        .poll(paneText, { timeout: 10_000 })
        .toContain('echo canopy-history-probe');

      // Execute the recalled command — proves the search round trip.
      await window.keyboard.press('Enter');
      await expect
        .poll(
          async () => {
            const text = await paneText();
            return text.split('canopy-history-probe').length - 1;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(2);

      // --- Ctrl+U: kill-line clears typed-but-unsubmitted input ------------
      await window.keyboard.type('echo CANOPY-SHOULD-NOT-RUN');
      await expect.poll(paneText).toContain('CANOPY-SHOULD-NOT-RUN');
      await window.keyboard.press('Control+u');
      await expect
        .poll(paneText, { timeout: 10_000 })
        .not.toContain('CANOPY-SHOULD-NOT-RUN');

      await window.keyboard.type('echo canopy-ctrl-u-ok');
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 10_000 })
        .toContain('canopy-ctrl-u-ok');

      // --- Cursor movement reaches the shell (CAN-4528) ----------------------
      // Each probe inserts a letter mid-word; the echoed result proves where
      // the cursor was. The typed command line itself never contains it.
      const editLine = async (keys, letter, expected) => {
        await window.keyboard.type('echo abc');
        for (const key of keys) await window.keyboard.press(key);
        await window.keyboard.type(letter);
        await window.keyboard.press('Enter');
        await expect
          .poll(
            async () =>
              (await paneText())
                .split('\n')
                .some((line) => line.trim() === expected),
            { timeout: 10_000 },
          )
          .toBe(true);
      };
      await editLine(['ArrowLeft', 'ArrowLeft'], 'X', 'aXbc');
      await editLine(['Control+b', 'Control+b'], 'Y', 'aYbc');
      await editLine(['ArrowLeft', 'ArrowLeft', 'ArrowRight'], 'Z', 'abZc');

      await window.screenshot({
        path: testInfo.outputPath('terminal-keys.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Shift+Enter preserves keyup handling and emits modified Enter', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-terminal-shift-enter-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const pane = await spawnPanelTerminal(window);
      await pane.click();
      const paneText = () => pane.innerText();

      const keyupWasNotCanceled = await pane
        .locator('.xterm-helper-textarea')
        .evaluate((textarea) =>
          textarea.dispatchEvent(
            new KeyboardEvent('keyup', {
              key: 'Enter',
              code: 'Enter',
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      expect(keyupWasNotCanceled).toBe(true);

      // Read exactly two raw bytes so the shell does not interpret them.
      // Claude Code and other TUIs recognize Esc+CR as modified Enter; plain
      // xterm.js collapses Shift+Enter to a single CR and leaves this blocked.
      await window.keyboard.type(
        "stty raw -echo; printf '\\r\\nSHIFT_ENTER_RAW_%s\\r\\n' READY; dd bs=1 count=2 2>/dev/null | od -An -t x1; stty sane",
      );
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 10_000 })
        .toContain('SHIFT_ENTER_RAW_READY');
      await window.keyboard.press('Shift+Enter');
      await expect.poll(paneText, { timeout: 10_000 }).toMatch(/1b\s+0d/);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
