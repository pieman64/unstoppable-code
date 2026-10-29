// Auto-start the terminal when the bottom drawer is expanded.
//
// SCOPE. The bottom-row terminal drawer seeds COLLAPSED and UNBOUND, so the
// first use of a terminal used to cost two clicks: expand the drawer, then
// click "Start terminal" in the unbound empty state. That second click
// carried no information — if the user expanded the terminal, they want a
// terminal. An explicit reveal gesture on an unbound terminal placeholder is
// now itself the spawn request.
//
// Three gestures are covered here, because they are wired through different
// seams and can regress independently:
//   1. Expanding the collapsed drawer (the host `onExpandGroup` seam, the
//      only reveal gesture that names no tab).
//   2. The caret landing in the auto-started pane — auto-start takes focus
//      exactly as clicking "Start terminal" does, so it is not a silent
//      spawn the user has to click into.
//   3. Selecting an unbound terminal TAB beside a chat tab (the existing
//      `onSelectPanel` seam). Same intent, different gesture.
//   4. The same tab selection inside a POPPED-OUT window. An auxiliary
//      window routes none of its gestures through the shared surface's host
//      seams, so it wires reveal auto-start itself and can regress
//      independently of every case above. The same test also pins the
//      negative half for that surface: popping a group out is a move, not a
//      reveal, so it must not start anything on its own.
//
// The negative half of the contract — a PASSIVE expand (layout repair,
// restore, hydration) must never spawn or take the caret (CAN-2309) — is
// covered by `can-2309-terminal-keyboard-focus.spec.mjs` and by the
// `onExpandGroup` unit tests in
// `packages/ui-app/src/code/panels/__tests__/PanelGridSurface.reveal-seams.test.tsx`.
//
// DETERMINISM. No live agents and no network: the terminal is a real local
// PTY spawned by the app itself, and every assertion polls the rendered pane
// rather than a timing window.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import {
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  movePanelViaApi,
  seedPanelWorktree,
} from './panelHarness.mjs';

/** True when the caret currently sits inside an integrated terminal pane. */
function caretIsInsideTerminal(window) {
  return window.evaluate(
    () =>
      document.activeElement?.closest('.xterm, .canopy-terminal-host') !==
        null && document.activeElement !== null,
  );
}

/**
 * Clicks whichever expand affordance the collapsed terminal group is
 * currently rendering. A collapsed group in its own branch shows the branch
 * bar's expand button; a collapsed group sharing a branch shows the panel
 * chrome's. Both dispatch the same `onCollapseGroup(groupId, false)` reveal.
 */
async function expandTerminalGroup(window) {
  const branchExpand = window.locator(
    `[data-testid="panel-branch-expand-${DEFAULT_GROUP_IDS.terminal}"]:visible`,
  );
  const chromeExpand = window.locator(
    `[data-testid="panel-group-expand-${DEFAULT_GROUP_IDS.terminal}"]:visible`,
  );
  await expect
    .poll(
      async () => (await branchExpand.count()) + (await chromeExpand.count()),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  if ((await branchExpand.count()) > 0) {
    await branchExpand.first().click();
    return;
  }
  await chromeExpand.first().click();
}

test.describe('terminal drawer auto-start', () => {
  test.setTimeout(240_000);

  test('expanding the collapsed drawer starts a terminal with no Start click, and takes the caret', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    try {
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The drawer seeds collapsed, so its pane is not rendered yet.
      const pane = window.getByTestId('terminal-pane');
      expect(await pane.count()).toBe(0);

      const startButton = window.getByTestId('terminal-start-button');
      await expandTerminalGroup(window);

      // The reveal gesture alone must produce a live pane. Deliberately
      // nothing clicks Start terminal.
      await expect(pane).toBeVisible({ timeout: 30_000 });

      // ...and the empty state must never have been what the user landed
      // on. Checked after the pane resolves so this reads the settled UI,
      // not a frame mid-spawn.
      expect(await startButton.count()).toBe(0);

      // Auto-start is an explicit gesture, so it takes the caret exactly as
      // clicking Start terminal does — the user types straight into it.
      await expect
        .poll(() => caretIsInsideTerminal(window), { timeout: 15_000 })
        .toBe(true);

      // A real shell, not just a mounted pane.
      await window.keyboard.type('echo terminal-autostart-alive');
      await window.keyboard.press('Enter');
      await expect
        .poll(() => pane.innerText(), { timeout: 30_000 })
        .toContain('terminal-autostart-alive');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('re-expanding a bound drawer reuses the session instead of spawning a second one', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    try {
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const pane = window.getByTestId('terminal-pane');
      await expandTerminalGroup(window);
      await expect(pane).toBeVisible({ timeout: 30_000 });

      await window.keyboard.type('echo terminal-autostart-first');
      await window.keyboard.press('Enter');
      await expect
        .poll(() => pane.innerText(), { timeout: 30_000 })
        .toContain('terminal-autostart-first');

      // Collapse, then reveal again. The panel is BOUND now, so the reveal
      // must be a no-op for spawning: same session, same scrollback.
      await window
        .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await expandTerminalGroup(window);

      await expect(pane).toBeVisible({ timeout: 30_000 });
      await expect(pane).toContainText('terminal-autostart-first');
      expect(await window.getByTestId('terminal-pane').count()).toBe(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('signing out replaces terminal feeds and keeps the local shell usable', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      env: { CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL },
    });
    try {
      // Seed the signed-in identity through real credential IPC; sign-out
      // below goes through the user's sidebar action and confirmation.
      await connectMockCloudAccount(window, 'csk_terminal_lifecycle_e2e');
      await window.getByTestId('sidebar-account-row').click();
      await expect(
        window.getByTestId('sidebar-account-menu-item-sign-in-out'),
      ).toHaveText('Sign out', { timeout: 30_000 });
      await window.keyboard.press('Escape');

      await expandTerminalGroup(window);
      const pane = window.getByTestId('terminal-pane');
      await expect(pane).toBeVisible({ timeout: 30_000 });
      await pane.click();
      await window.keyboard.type('echo terminal-before-signout');
      await window.keyboard.press('Enter');
      await expect(pane).toContainText('terminal-before-signout');

      // Count real feed reacquisitions without replacing terminal behavior.
      // Rebinding has to request fresh running snapshots; the import-owned
      // binding never releases/reacquires its feed after sign-out.
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('terminal:list');
        if (!original) throw new Error('terminal:list handler is missing');
        globalThis.__terminalLifecycleListCalls = 0;
        ipcMain.removeHandler('terminal:list');
        ipcMain.handle('terminal:list', (...args) => {
          globalThis.__terminalLifecycleListCalls += 1;
          return original(...args);
        });
      });
      await window.getByTestId('sidebar-account-row').click();
      await window.getByTestId('sidebar-account-menu-item-sign-in-out').click();
      await window
        .getByRole('button', { name: 'Sign out', exact: true })
        .click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__terminalLifecycleListCalls),
        )
        .toBeGreaterThan(0);

      await expect(pane).toBeVisible({ timeout: 30_000 });
      await pane.click();
      await window.keyboard.type('echo terminal-after-signout');
      await window.keyboard.press('Enter');
      await expect(pane).toContainText('terminal-after-signout');
      await expect(pane).toContainText('terminal-before-signout');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('selecting an unbound terminal tab beside a chat tab starts it', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    try {
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // Move the still-unbound terminal panel into the chat group. This is a
      // programmatic store mutation, NOT a user gesture, so it must not
      // auto-start anything on its own — including through the forced
      // expand the topology edit performs.
      await movePanelViaApi(
        window,
        DEFAULT_PANEL_IDS.terminal,
        DEFAULT_GROUP_IDS.chat,
        'center',
      );

      const terminalTab = window.getByTestId(
        `panel-tab-${DEFAULT_PANEL_IDS.terminal}`,
      );
      const chatTab = window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`);
      await expect(terminalTab).toBeVisible({ timeout: 15_000 });

      // Park the selection on the chat tab so the terminal tab click below
      // is a genuine selection change.
      await chatTab.click();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      expect(await window.getByTestId('terminal-pane').count()).toBe(0);

      // The tab-select gesture carries the same intent as expanding.
      await terminalTab.click();

      const pane = window.getByTestId('terminal-pane');
      await expect(pane).toBeVisible({ timeout: 30_000 });
      expect(await window.getByTestId('terminal-start-button').count()).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('selecting an unbound terminal tab inside a popped-out window starts it', async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    try {
      // Pop the still-UNBOUND, still-collapsed terminal group into its own
      // OS window. A collapsed group renders the same chrome overflow, so
      // this never expands it — and pop-out is a move, so nothing may start.
      const auxWindowPromise = electronApp.waitForEvent('window');
      await window
        .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      await window
        .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`)
        .click();
      const aux = await auxWindowPromise;

      await expect(aux.getByTestId('terminal-panel-surface')).toBeVisible({
        timeout: 30_000,
      });
      // Assert the POSITIVE state rather than the absence of a pane. Both
      // `toHaveCount(0)` and `expect.poll(...).toBe(0)` resolve on their
      // first evaluation when the count is already 0 — `poll` stops at the
      // first success and its `intervals` are the on-failure cadence — so
      // neither can distinguish "pop-out started nothing" from "the spawn
      // has not landed yet". The empty state's Start button is rendered iff
      // the panel is still unbound, which is the thing that must be true.
      await expect(aux.getByTestId('terminal-start-button')).toBeVisible({
        timeout: 15_000,
      });
      await expect(aux.getByTestId('terminal-pane')).toHaveCount(0);

      // An explicit tab selection IS a reveal gesture, and the aux window
      // dispatches it through its own wiring rather than the shared host
      // seam the main-window cases above exercise.
      await aux.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`).click();

      await expect(aux.getByTestId('terminal-pane')).toBeVisible({
        timeout: 30_000,
      });
      // The spawn stayed in the window that produced the gesture.
      await expect(window.getByTestId('terminal-pane')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
