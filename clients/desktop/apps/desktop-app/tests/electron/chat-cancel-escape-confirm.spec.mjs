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
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// ECW-8986 — cancelling a running turn with Escape requires TWO presses.
//
// A single Escape used to cancel the active turn immediately, which caused
// accidental cancellations (Escape is muscle memory for closing popovers and
// dismissing UI). The shortcut now uses a two-press confirmation, mirroring
// ChatGPT: the first Escape arms the cancellation and flips the composer's
// stop button into a highlighted "Press Esc again to stop" state; only a
// second Escape inside the confirmation window actually cancels. Letting the
// window lapse disarms and reverts the button.
//
// This spec drives a REAL Claude turn against the shared mock provider with a
// slow-paced stream (same seam as `chat-queue.spec.mjs`) so the renderer holds
// a genuine streaming frame, then verifies each stage of the confirmation.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/
// (control-plane.mjs markerFromText) — the 'Canopy-C' prefix is mandatory.
const CONVERSATION_MARKER = 'Canopy-CESCCONFIRM';

async function readStopButtonState(stopButton) {
  return stopButton.evaluate((button) => ({
    label: button.getAttribute('aria-label'),
    armed: button.getAttribute('data-cancel-armed'),
  }));
}

test.describe('Escape-to-cancel confirmation (ECW-8986)', () => {
  test('first Escape arms the stop button, second Escape cancels, lapse disarms', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-esc-confirm-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
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
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow cancellable turn', streamMs: 120_000 }],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const composer = window.getByRole('textbox').last();
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(stopButton).toHaveAccessibleName('Stop generation');
      await expect(stopButton).toHaveAttribute(
        'data-cancel-shortcut-ready',
        'true',
      );

      // An open overlay owns Escape even if focus drifts to the page behind it.
      // Dismissing the command palette must not arm or cancel the running turn.
      await window.keyboard.press(PALETTE_SHORTCUT);
      const palette = window.getByTestId('command-palette');
      const paletteInput = window.getByTestId('command-palette-input');
      await expect(palette).toBeVisible();
      await window.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
      });
      await expect(paletteInput).not.toBeFocused();
      await window.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({
          label: 'Stop generation',
          armed: null,
        });
      await expect(stopButton).toBeVisible();

      // First Escape: arms the confirmation instead of cancelling. The stop
      // button flips to the highlighted "Press Esc again to stop" state and
      // the turn keeps streaming.
      await window.keyboard.press('Escape');
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({
          label: 'Press Esc again to stop',
          armed: 'true',
        });

      // Letting the confirmation window lapse disarms: the button reverts to
      // its normal stop state while the turn is STILL streaming — proof a
      // lone Escape no longer cancels a turn.
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({
          label: 'Stop generation',
          armed: null,
        });
      await expect(stopButton).toBeVisible();

      // Two Escapes inside the window actually cancel the turn: the
      // streaming-only stop button goes away and the idle send control
      // returns.
      await window.keyboard.press('Escape');
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({
          label: 'Press Esc again to stop',
          armed: 'true',
        });
      await window.keyboard.press('Escape');

      await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
      await expect(composerIdleAction(window)).toBeVisible({ timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // The shared ComposerEditor owns an inline `/` flow for hosts that supply a
  // command catalog. Desktop does not: its composer menu owns `/`. A `/` left
  // in the draft after that menu closes must not leave a second, invisible
  // trigger tracker in the editor that swallows the Escape meant to arm
  // cancellation.
  test('a slash draft does not swallow the arming Escape', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-esc-slash-draft-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
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
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow cancellable turn', streamMs: 120_000 }],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const composer = window.getByRole('textbox').last();
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(stopButton).toHaveAttribute(
        'data-cancel-shortcut-ready',
        'true',
      );

      // A slash draft opens desktop's own composer menu; the first Escape
      // closes that menu and must not arm.
      await composer.fill('/rev');
      const menu = window.getByTestId('chat-input-plus-menu');
      await expect(menu).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(composer).toContainText('/rev');
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({ label: 'Stop generation', armed: null });

      // The draft still ends in `/rev`. The next Escape belongs to the
      // cancel shortcut, not to an editor typeahead that never rendered.
      await window.keyboard.press('Escape');
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({ label: 'Press Esc again to stop', armed: 'true' });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-5387 — a modal opened mid-turn owns Escape. The schedule modal is
  // hand-rolled `aria-modal` UI opened from the composer's `+` menu, which
  // leaves focus outside it. Escape must close it without arming the cancel
  // shortcut, whether focus sits on `<body>` or in the composer behind it.
  test('Escape closes a modal opened mid-turn without arming cancel', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-esc-modal-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
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
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow cancellable turn', streamMs: 120_000 }],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      // The modal's own fields are textboxes portaled after the composer, so
      // `getByRole('textbox').last()` would resolve into the modal once open.
      const composer = window.locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(stopButton).toHaveAttribute(
        'data-cancel-shortcut-ready',
        'true',
      );

      const modal = window.getByTestId('schedule-message-modal');
      const openScheduleModal = async () => {
        await window.getByTestId('chat-input-plus-button').click();
        await window.getByTestId('chat-input-schedule-button').click();
        await expect(modal).toBeVisible();
      };

      // Focus wherever the `+` menu left it.
      await openScheduleModal();
      await window.keyboard.press('Escape');
      await expect(modal).toBeHidden();
      // Arming happens synchronously in the keydown handler, so a single read
      // after the modal closed is conclusive; polling would pass vacuously.
      expect(await readStopButtonState(stopButton)).toEqual({
        label: 'Stop generation',
        armed: null,
      });
      await expect(stopButton).toBeVisible();

      // The reported path: focus back in the composer behind the modal. A
      // click would land on the scrim and close the modal, so focus directly.
      await openScheduleModal();
      await composer.focus();
      await expect(composer).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(modal).toBeHidden();
      expect(await readStopButtonState(stopButton)).toEqual({
        label: 'Stop generation',
        armed: null,
      });
      await expect(stopButton).toBeVisible();

      // With the modal gone, Escape-Escape still cancels the turn.
      await expect(stopButton).toHaveAttribute(
        'data-cancel-shortcut-ready',
        'true',
      );
      await window.keyboard.press('Escape');
      await expect
        .poll(() => readStopButtonState(stopButton))
        .toEqual({ label: 'Press Esc again to stop', armed: 'true' });
      await window.keyboard.press('Escape');

      await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
      await expect(composerIdleAction(window)).toBeVisible({ timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
