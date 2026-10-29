// CAN-2309 — keyboard input must not leak into a terminal the user did not
// choose.
//
// SCOPE. Two independent defects, both driven here through the real app:
//
//   1. Terminals took the caret on their own. Any transition that made a
//      terminal panel the active, visible tab (workspace/task switch, panel
//      group expand/collapse/restore, session restart, cached pane remount)
//      called `term.focus()` unconditionally, and nothing ever released it.
//      A terminal may now claim the caret only for an explicit user gesture
//      (click, Start terminal, reveal), and releases it — restoring the
//      previous caret holder — when it stops being the selected pane or the
//      window blurs.
//
//   2. Esc pressed anywhere in the app cancelled a running chat turn. The
//      two-press Escape shortcut listened at the document level with no
//      terminal exclusion, so Esc-Esc typed inside a terminal (ordinary input
//      in vim, less, fzf, and Claude Code's own TUI) interrupted an agent
//      running in a different surface. Scoping rejects a DIFFERENT surface,
//      not the whole app: with nothing focused (body as the key target) the
//      chat the user is looking at still cancels.
//
// DETERMINISM. No live agents: the chat turn runs against the shared mock
// provider with a long `streamMs`, the same seam `chat-cancel-escape-confirm`
// uses, so the streaming frame is held open for the whole assertion window.
// Caret location is read via `document.activeElement` rather than a visual
// ring, so the assertion is exact.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS, spawnPanelTerminal } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const OTHER_WORKSPACE_ID = 'demo-ts-npm-next';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/
// (control-plane.mjs markerFromText) — the 'Canopy-C' prefix is mandatory.
const CONVERSATION_MARKER = 'Canopy-CTERMFOCUS';

function scrubBundledBinaryOverrides() {
  for (const key of Object.keys(process.env)) {
    if (/^CANOPY_[A-Z0-9]+_BINARY_PATH$/.test(key)) delete process.env[key];
  }
}

/** True when the caret currently sits inside an integrated terminal pane. */
function caretIsInsideTerminal(window) {
  return window.evaluate(
    () =>
      document.activeElement?.closest('.xterm, .canopy-terminal-host') !==
        null && document.activeElement !== null,
  );
}

test.describe('terminal keyboard focus containment (CAN-2309)', () => {
  test.setTimeout(240_000);

  test('a terminal does not steal or keep the caret, and Escape inside it never cancels a turn', async () => {
    scrubBundledBinaryOverrides();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-can2309-terminal-focus-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite', 'ts-npm-next'],
    });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: OTHER_WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't2', title: 'Other chat' }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow cancellable turn', streamMs: 180_000 }],
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // --- Starting a terminal IS a user gesture: it may take the caret ----
      const pane = await spawnPanelTerminal(window);
      await expect
        .poll(() => caretIsInsideTerminal(window), {
          timeout: 15_000,
        })
        .toBe(true);

      // Seed observable shell output. Every hide/remount/move below must
      // retain this exact cached scrollback and the same live process.
      await window.keyboard.type('echo can2309-terminal-one-alive');
      await window.keyboard.press('Enter');
      await expect
        .poll(() => pane.innerText(), { timeout: 20_000 })
        .toContain('can2309-terminal-one-alive');

      // --- The caret comes back when the user moves to the composer -------
      const composer = window
        .getByTestId('panel-content-chat')
        .getByRole('textbox')
        .first();
      await composer.click();
      await expect
        .poll(() => caretIsInsideTerminal(window), {
          timeout: 10_000,
        })
        .toBe(false);

      // --- Collapsing and re-expanding the terminal group must NOT take
      //     the caret back off the composer. This is the panel-group
      //     expand/restore transition from the report.
      const collapse = window.getByTestId(
        `panel-group-collapse-${DEFAULT_GROUP_IDS.terminal}`,
      );
      if ((await collapse.count()) > 0 && (await collapse.isVisible())) {
        await collapse.click();
        await window
          .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.terminal}`)
          .click();
        await expect(pane).toBeVisible({ timeout: 20_000 });
      }
      expect(await caretIsInsideTerminal(window)).toBe(false);
      await expect(pane).toContainText('can2309-terminal-one-alive');

      // Maximizing/restoring makes the terminal active and visible but is
      // not permission to take the caret from the composer.
      await window
        .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await window
        .getByTestId(`panel-group-maximize-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await expect(
        window.getByTestId(`panel-group-restore-${DEFAULT_GROUP_IDS.terminal}`),
      ).toBeVisible();
      expect(await caretIsInsideTerminal(window)).toBe(false);
      await window
        .getByTestId(`panel-group-restore-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      expect(await caretIsInsideTerminal(window)).toBe(false);
      await expect(pane).toContainText('can2309-terminal-one-alive');

      // --- A real workspace/task switch and cached remount leave the caret
      //     out of the terminal, while its process and output survive.
      await window
        .locator(
          `[data-testid="worktree-row"][data-project-id="${OTHER_WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
        )
        .click();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      expect(await caretIsInsideTerminal(window)).toBe(false);
      await window
        .locator(
          `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
        )
        .click();
      await expect(pane).toBeVisible({ timeout: 20_000 });
      expect(await caretIsInsideTerminal(window)).toBe(false);
      await expect(pane).toContainText('can2309-terminal-one-alive');

      // --- Split panes route input only to the pane the user selected. ----
      // Create a second terminal tab, then use the real tab context action to
      // move it into a new split group so both xterms are visible at once.
      const terminalTabs = window.locator(
        '[data-testid^="panel-tab-panel-terminal"]',
      );
      await terminalTabs.first().click();
      await window.keyboard.press('ControlOrMeta+t');
      await expect(terminalTabs).toHaveCount(2, { timeout: 20_000 });
      const secondTerminalTab = terminalTabs.last();
      await secondTerminalTab.click({ button: 'right' });
      await window.getByTestId('panel-tab-context-split-right').click();

      const visiblePanes = window.locator(
        '[data-testid="terminal-pane"]:visible',
      );
      await expect(visiblePanes).toHaveCount(2, { timeout: 20_000 });
      await expect
        .poll(async () => (await visiblePanes.allInnerTexts()).join('\n'), {
          timeout: 20_000,
        })
        .toContain('can2309-terminal-one-alive');

      // Opening an existing terminal through its panel tab is an explicit
      // user action and should put the caret in that terminal.
      await terminalTabs.first().click();
      await expect
        .poll(() => caretIsInsideTerminal(window), { timeout: 10_000 })
        .toBe(true);

      const firstVisiblePane = visiblePanes.first();
      const secondVisiblePane = visiblePanes.last();
      await firstVisiblePane.click();
      await window.keyboard.type('echo can2309-first-pane-only');
      await window.keyboard.press('Enter');
      await expect
        .poll(() => firstVisiblePane.innerText(), { timeout: 20_000 })
        .toContain('can2309-first-pane-only');
      await expect(secondVisiblePane).not.toContainText(
        'can2309-first-pane-only',
      );

      await secondVisiblePane.click();
      await window.keyboard.type('echo can2309-second-pane-only');
      await window.keyboard.press('Enter');
      await expect
        .poll(() => secondVisiblePane.innerText(), { timeout: 20_000 })
        .toContain('can2309-second-pane-only');
      await expect(firstVisiblePane).not.toContainText(
        'can2309-second-pane-only',
      );

      // A still-selected terminal can lose DOM focus to app chrome and then
      // be clicked again. That second click starts a fresh ownership interval,
      // so window blur must restore the latest predecessor, not stale state
      // from the terminal's first visit.
      await window.evaluate(() => {
        const probe = document.createElement('button');
        probe.dataset.testid = 'can-2309-latest-predecessor';
        document.body.append(probe);
        probe.focus();
      });
      await secondVisiblePane.click();
      await window.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect
        .poll(() =>
          window.evaluate(
            () =>
              document.activeElement?.getAttribute('data-testid') ===
              'can-2309-latest-predecessor',
          ),
        )
        .toBe(true);
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));

      // Terminal B must not remember terminal A's hidden xterm textarea as
      // its predecessor. Blurring and refocusing the window releases B's
      // caret without redirecting subsequent input into either terminal.
      await window.evaluate(() => window.dispatchEvent(new Event('blur')));
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await firstVisiblePane.locator('.xterm-helper-textarea').focus();
      await secondVisiblePane.click();
      await window.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect
        .poll(() => caretIsInsideTerminal(window), { timeout: 10_000 })
        .toBe(false);
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await window.keyboard.type('echo can2309-after-refocus-no-terminal');
      await window.keyboard.press('Enter');
      await expect(firstVisiblePane).not.toContainText(
        'can2309-after-refocus-no-terminal',
      );
      await expect(secondVisiblePane).not.toContainText(
        'can2309-after-refocus-no-terminal',
      );

      // Sending a terminal command is another explicit terminal-launch
      // gesture. It must reveal the bound terminal and put the caret there.
      await composer.fill('!echo can2309-terminal-command-focus');
      await window
        .getByRole('button', { name: 'Run terminal command', exact: true })
        .click();
      await expect
        .poll(() => caretIsInsideTerminal(window), { timeout: 15_000 })
        .toBe(true);

      // --- Escape inside a terminal must never cancel a running turn ------
      await composer.click();
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(stopButton).toHaveAccessibleName('Stop generation');

      // Click into the terminal (a legitimate gesture) and press Escape
      // repeatedly, the way Esc-Esc behaves inside vim / Claude Code. The
      // turn must keep streaming and the stop button must never arm.
      await firstVisiblePane.click();
      await expect
        .poll(() => caretIsInsideTerminal(window), {
          timeout: 10_000,
        })
        .toBe(true);

      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');

      await expect(stopButton).toBeVisible();
      await expect(stopButton).toHaveAccessibleName('Stop generation');
      await expect(stopButton).not.toHaveAttribute('data-cancel-armed', 'true');

      // --- A popped-out chat listens only in its own document -------------
      // Each layout has a locally active panel. Moving this running chat to
      // an aux window must move its document-level Escape listener too: keys
      // in the main window cannot cancel it, while Esc-Esc in the aux
      // composer still can.
      const auxWindowPromise = electronApp.waitForEvent('window');
      await window
        .getByTestId('panel-tab-panel-chat-t1')
        .click({ button: 'right' });
      await window.getByTestId('panel-tab-context-new-window').click();
      const aux = await auxWindowPromise;

      const auxStopButton = aux.getByTestId('chat-stop-generation');
      await expect(auxStopButton).toBeVisible({ timeout: 20_000 });
      await expect(auxStopButton).toHaveAccessibleName('Stop generation');

      await window.evaluate(() => {
        const focusProbe = document.createElement('button');
        focusProbe.dataset.testid = 'can-2309-main-window-focus-probe';
        document.body.append(focusProbe);
        focusProbe.focus();
      });
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');

      await expect(auxStopButton).toBeVisible();
      await expect(auxStopButton).toHaveAccessibleName('Stop generation');
      await expect(auxStopButton).not.toHaveAttribute(
        'data-cancel-armed',
        'true',
      );

      const auxComposer = aux
        .getByTestId('panel-content-chat')
        .getByRole('textbox')
        .first();
      await aux.evaluate(() => {
        const focusProbe = document.createElement('button');
        focusProbe.dataset.testid = 'can-2309-aux-window-focus-probe';
        document.body.append(focusProbe);
        focusProbe.focus();
      });
      await aux.keyboard.press('Escape');
      await aux.keyboard.press('Escape');
      await aux.waitForTimeout(500);
      await expect(auxStopButton).toBeVisible();
      await expect(auxStopButton).toHaveAccessibleName('Stop generation');
      await expect(auxStopButton).not.toHaveAttribute(
        'data-cancel-armed',
        'true',
      );

      // Panel scoping rejects a SIBLING surface, not the whole app. With
      // nothing focused — the state left behind by a window refocus, a modal
      // close, or a terminal releasing the caret with no predecessor — the
      // browser reports the body as the key target, and the chat the user is
      // looking at must still respond to Esc-Esc.
      await aux.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await expect
        .poll(
          () => aux.evaluate(() => document.activeElement === document.body),
          { timeout: 5_000 },
        )
        .toBe(true);
      await aux.keyboard.press('Escape');
      await expect(auxStopButton).toHaveAccessibleName(
        'Press Esc again to stop',
      );

      // Let the confirmation lapse so the composer path below starts disarmed.
      await expect(auxStopButton).toHaveAccessibleName('Stop generation', {
        timeout: 10_000,
      });

      await auxComposer.click();
      await aux.keyboard.press('Escape');
      await expect(auxStopButton).toHaveAccessibleName(
        'Press Esc again to stop',
      );
      await aux.keyboard.press('Escape');
      await expect(auxStopButton).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
