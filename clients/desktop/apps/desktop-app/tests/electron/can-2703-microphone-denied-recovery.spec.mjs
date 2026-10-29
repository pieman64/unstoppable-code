import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2703 — a denied microphone permission used to make the mic button a
// permanent silent no-op. macOS never re-prompts once denied, so every retry
// produced the byte-identical error message, and the composer's
// dismissed-for-this-message latch suppressed the recovery modal forever.
//
// `CANOPY_E2E_VOICE_ACCESS_FLOW=deny-microphone` substitutes a fixed `denied`
// answer for the real macOS TCC query (which cannot be driven from a test), so
// the renderer walks its true denial path.
//
// Voice dictation is macOS-only; the mic button is not rendered elsewhere.

const WORKTREE_ID = 'demo-main';

test.describe('CAN-2703 microphone denial recovery', () => {
  test.skip(process.platform !== 'darwin', 'Voice dictation is macOS-only');

  test('chat composer re-surfaces microphone guidance on every denied click', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'deny-microphone' },
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // Scope to the chat panel: MainPage stays mounted (hidden) behind other
      // pages, so an unscoped lookup would become a strict-mode violation the
      // moment a second composer is mounted.
      const chatPanel = window.getByTestId('panel-content-chat');
      const mic = chatPanel.getByTestId('voice-input-button');
      await expect(mic).toBeVisible();

      // DialogModal portals to document.body, so the modal is not a descendant
      // of the composer panel and must be looked up from the window root.
      const modal = window.getByTestId('voice-error-modal');

      // First denial explains the problem and offers the way out.
      await mic.click();
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Allow microphone access');
      await expect(
        modal.getByTestId('voice-error-modal-settings'),
      ).toBeVisible();

      await modal.getByTestId('voice-error-modal-close').click();
      await expect(modal).toBeHidden();

      // The regression: the second click produced no feedback at all.
      await mic.click();
      await expect(modal).toBeVisible();

      // And it keeps working — no attempt is ever silent.
      await modal.getByTestId('voice-error-modal-close').click();
      await expect(modal).toBeHidden();
      await mic.click();
      await expect(modal).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('home composer surfaces microphone guidance instead of failing silently', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'deny-microphone' },
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();
      await window.getByTestId('sidebar-create-task').click();

      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const mic = homePage.getByTestId('voice-input-button');
      await expect(mic).toBeVisible();

      // Portaled to document.body — see the chat spec above.
      const modal = window.getByTestId('voice-error-modal');
      await mic.click();
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Allow microphone access');

      await modal.getByTestId('voice-error-modal-close').click();
      await expect(modal).toBeHidden();

      await mic.click();
      await expect(modal).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
