// CAN-4528 — the floating find bar's terminal mode.
//
// SCOPE. Cmd/Ctrl+F from a focused integrated terminal opens the shared find
// bar in terminal mode over that terminal's scrollback: exact placeholder,
// "n of m" counter, Enter / Shift+Enter stepping, Escape back into the shell
// with no `^F` sent to the PTY, a remembered query, the chat toggle beside
// it, and no stale highlights after the terminal group is hidden.
//
// PLATFORM. CI runs on macOS, so `ControlOrMeta+f` is Cmd+F here. The
// Windows/Linux Ctrl+F path (xterm declines the chord only while a find
// controller claims the terminal, and the CAN-338 guard lets just that chord
// through) is covered by the unit tests in terminal-instances.test.ts,
// useGlobalShortcuts.test.ts, and auxPanelFindShortcut.test.ts.
//
// DETERMINISM. An inner `bash --norc --noprofile` gives a stable prompt, and
// the needle is printed by a command whose typed text does not contain it
// (`can%sopy-find-hit`), so the scrollback holds exactly three matches.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  spawnPanelTerminal,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const NEEDLE = 'canopy-find-hit';

test.describe('find bar terminal mode (CAN-4528)', () => {
  test.setTimeout(120_000);

  test('searches the focused terminal and hands typing back to the shell', async ({}, testInfo) => {
    // A chat with a transcript registers a chat find surface beside the
    // terminal, so the bar offers its mode toggle.
    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      onBeforeLaunch: ({ userDataDir: dir, workspaceIds }) => {
        seedWorktreeChat({
          userDataDir: dir,
          workspaceId: workspaceIds[0],
          worktreeId: 'demo-main',
          providerType: 'claude',
          tabs: [
            {
              id: SEEDED_CHAT_TAB_ID,
              title: 'Chat',
              blocks: [{ type: 'text', text: 'A seeded chat line.' }],
            },
          ],
        });
      },
    });

    try {
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toContainText('A seeded chat line.', { timeout: 20_000 });

      const pane = await spawnPanelTerminal(window);
      await expect(pane).toHaveAttribute('data-find-surface', 'terminal');
      await pane.click();
      const paneText = () => pane.innerText();
      const helperTextarea = pane.locator('.xterm-helper-textarea');

      await window.keyboard.type('echo canopy-shell-ready');
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 20_000 })
        .toContain('canopy-shell-ready');
      await window.keyboard.type('bash --norc --noprofile');
      await window.keyboard.press('Enter');
      await window.keyboard.type("printf 'can%sopy-find-hit\\n' '' '' ''");
      await window.keyboard.press('Enter');
      await expect
        .poll(async () => (await paneText()).split(NEEDLE).length - 1, {
          timeout: 20_000,
        })
        .toBe(3);

      // --- Open from the focused terminal ------------------------------------
      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');
      await expect(helperTextarea).toBeFocused();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('data-find-mode', 'terminal');
      await expect(input).toHaveAttribute(
        'placeholder',
        'Search the terminal.',
      );
      await expect(input).toBeFocused();

      await input.fill(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 10_000 });
      await expect(pane.locator('.xterm-decoration').first()).toBeAttached();
      await window.keyboard.press('Enter');
      await expect(bar).toContainText('2 of 3');
      await window.keyboard.press('Shift+Enter');
      await expect(bar).toContainText('1 of 3');

      await window.screenshot({
        path: testInfo.outputPath('find-terminal-open.png'),
      });

      // --- Escape returns typing to the shell, with no ^F sent -------------
      await window.keyboard.press('Escape');
      await expect(bar).toBeHidden();
      await expect(helperTextarea).toBeFocused();
      await window.keyboard.type('echo canopy-after-find');
      await window.keyboard.press('Enter');
      await expect
        .poll(paneText, { timeout: 10_000 })
        .toContain('canopy-after-find');
      expect(await paneText()).not.toContain('^F');

      // --- Remembered query and the chat toggle beside it -------------------
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'terminal');
      await expect(input).toHaveValue(NEEDLE);
      const chatToggle = window.getByTestId('surface-find-mode-chat');
      await expect(chatToggle).toBeVisible();
      await chatToggle.click();
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await expect(input).toHaveValue(NEEDLE);
      await window.getByTestId('surface-find-mode-terminal').click();
      await expect(bar).toHaveAttribute('data-find-mode', 'terminal');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 10_000 });

      // --- Hiding the terminal closes the bar and leaves no highlights ------
      await window
        .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await expect(bar).toBeHidden();
      await window
        .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await expect(pane).toBeVisible({ timeout: 20_000 });
      await expect(pane.locator('.xterm-decoration')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
