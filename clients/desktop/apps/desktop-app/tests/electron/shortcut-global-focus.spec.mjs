// CAN-1963 (iteration 1): the OS-level focus shortcut.
//
// Covers the Settings → Shortcuts "Focus from anywhere" section (opt-in
// toggle, live registration status, the recorder with its validation and the
// registration-failure path) and the Getting started checklist entry that
// asks for the shortcut right after notifications.
//
// The E2E build never touches the real OS: `lifecycle/global-focus-shortcut.ts`
// swaps Electron's `globalShortcut` for an in-memory registrar driven by
// `CANOPY_E2E_GLOBAL_SHORTCUT_FLOW=in-use:<accelerator>` (those chords register
// as refused, every other chord registers), and specs fire the registered
// chord by emitting `e2e:global-focus-shortcut-trigger` on `ipcMain`. Claiming
// ⌘⇧O for real would steal it system-wide on the developer machine and
// collide with a running dev app. What this cannot prove is that macOS
// actually raises the window; that is `focusMainWindow`, verified by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+O';
const OTHER_ACCELERATOR = 'CommandOrControl+Shift+P';
const isMac = process.platform === 'darwin';
const DEFAULT_KEYS = isMac ? '⌘⇧O' : 'CtrlShiftO';
const OTHER_KEYS = isMac ? '⌘⇧P' : 'CtrlShiftP';

function readPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

async function fireShortcut(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.emit('e2e:global-focus-shortcut-trigger');
  });
}

async function openShortcutSettings(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openSettings();
  await app.openSettingsSection('shortcuts');
  await expect(
    window.getByTestId('settings-global-focus-shortcut'),
  ).toBeVisible();
  return app;
}

test.describe('OS focus shortcut (CAN-1963)', () => {
  test.setTimeout(180_000);

  test('is off by default, turns on from Settings, and reports the chord working once it fires', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      await openShortcutSettings(window);

      const toggle = window.getByTestId('global-focus-shortcut-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        window.getByTestId('global-focus-shortcut-chord'),
      ).toHaveText(DEFAULT_KEYS);
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/off/i);
      expect(readPreferences(userDataDir).globalFocusShortcutEnabled).toBe(
        false,
      );

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      // Registration succeeded, but that is not proof another app does not
      // own the chord — the status says so until the OS delivers it.
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active.*press it now/i);
      await expect
        .poll(() => readPreferences(userDataDir).globalFocusShortcutEnabled)
        .toBe(true);

      await fireShortcut(electronApp);
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/working/i);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('records a new chord in Settings and persists it', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      await openShortcutSettings(window);
      await window.getByTestId('global-focus-shortcut-toggle').click();
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active/i);

      await window.getByTestId('global-focus-shortcut-change').click();
      const recorder = window.getByTestId('global-focus-shortcut-recorder');
      await expect(recorder).toBeFocused();
      const save = window.getByTestId('global-focus-shortcut-save');
      await expect(save).toBeDisabled();

      await recorder.press('ControlOrMeta+Shift+P');
      await expect(
        window.getByTestId('global-focus-shortcut-preview'),
      ).toHaveText(OTHER_KEYS);
      await expect(save).toBeEnabled();
      await save.click();

      await expect(recorder).toHaveCount(0);
      await expect(
        window.getByTestId('global-focus-shortcut-chord'),
      ).toHaveText(OTHER_KEYS);
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active/i);
      await expect
        .poll(() => readPreferences(userDataDir).globalFocusShortcut)
        .toBe(OTHER_ACCELERATOR);

      // Reset returns to the default and persists that too.
      await window.getByTestId('global-focus-shortcut-reset').click();
      await expect(
        window.getByTestId('global-focus-shortcut-chord'),
      ).toHaveText(DEFAULT_KEYS);
      await expect
        .poll(() => readPreferences(userDataDir).globalFocusShortcut)
        .toBe(DEFAULT_ACCELERATOR);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('refuses a View-menu zoom chord as already used', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      await openShortcutSettings(window);
      await window.getByTestId('global-focus-shortcut-toggle').click();
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active/i);

      await window.getByTestId('global-focus-shortcut-change').click();
      const recorder = window.getByTestId('global-focus-shortcut-recorder');
      await expect(recorder).toBeFocused();

      // Cmd/Ctrl+0 is the View menu's Actual Size accelerator, which is
      // always bound. The recorder must refuse to save it -- the OS hands a
      // global shortcut the keydown before the renderer ever sees it.
      await recorder.press('ControlOrMeta+0');
      const validation = window.getByTestId('global-focus-shortcut-validation');
      await expect(validation).toHaveText(/already used by actual size/i);
      await expect(validation).not.toHaveText(/keyboard resizing/i);
      await expect(
        window.getByTestId('global-focus-shortcut-save'),
      ).toBeDisabled();

      // The chord the user already had is untouched.
      await window.getByTestId('global-focus-shortcut-cancel').click();
      await expect(
        window.getByTestId('global-focus-shortcut-chord'),
      ).toHaveText(DEFAULT_KEYS);
      await expect
        .poll(() => readPreferences(userDataDir).globalFocusShortcut)
        .toBe(DEFAULT_ACCELERATOR);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the working chord when the OS refuses the new one', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_GLOBAL_SHORTCUT_FLOW: `in-use:${OTHER_ACCELERATOR}` },
    });
    try {
      const window = await electronApp.firstWindow();
      await openShortcutSettings(window);
      await window.getByTestId('global-focus-shortcut-toggle').click();
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active/i);

      await window.getByTestId('global-focus-shortcut-change').click();
      const recorder = window.getByTestId('global-focus-shortcut-recorder');
      await recorder.press('ControlOrMeta+Shift+P');
      await window.getByTestId('global-focus-shortcut-save').click();

      const error = window.getByTestId('global-focus-shortcut-error');
      await expect(error).toHaveText(/couldn't use/i);
      await expect(error).toHaveText(/another app is using it/i);
      // The recorder stays open with the refused chord; the saved chord and
      // its registration are untouched.
      await expect(
        window.getByTestId('global-focus-shortcut-preview'),
      ).toHaveText(OTHER_KEYS);
      await expect(
        window.getByTestId('global-focus-shortcut-chord'),
      ).toHaveText(DEFAULT_KEYS);
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/active/i);
      expect(readPreferences(userDataDir).globalFocusShortcut).toBe(
        DEFAULT_ACCELERATOR,
      );

      await fireShortcut(electronApp);
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/working/i);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the recorder refuses in-app and modifier-less chords without running them', async () => {
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      await openShortcutSettings(window);
      await window.getByTestId('global-focus-shortcut-change').click();
      const recorder = window.getByTestId('global-focus-shortcut-recorder');
      const save = window.getByTestId('global-focus-shortcut-save');

      // ⌘K belongs to the command palette while the app is focused; a global
      // chord would intercept it before the renderer ever saw it.
      await recorder.press('ControlOrMeta+k');
      await expect(
        window.getByTestId('global-focus-shortcut-validation'),
      ).toHaveText(/already used by open command palette/i);
      await expect(save).toBeDisabled();
      await expect(window.getByTestId('command-palette-result')).toHaveCount(0);

      await recorder.press('o');
      await expect(
        window.getByTestId('global-focus-shortcut-validation'),
      ).toHaveText(/modifier/i);
      await expect(save).toBeDisabled();

      // Escape closes the recorder without saving anything.
      await recorder.press('Escape');
      await expect(recorder).toHaveCount(0);
      expect(readPreferences(userDataDir).globalFocusShortcut).toBe(
        DEFAULT_ACCELERATOR,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the Getting started checklist asks for the shortcut and Turn on completes it', async () => {
    const userDataDir = seedWelcomeChecklist({
      pendingEntry: 'focus-shortcut',
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const row = window.getByTestId(
        'home-onboarding-suggestion-focus-shortcut',
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toHaveAttribute('data-step', 'enable-focus-shortcut');
      // #3519 (CAN-2666) rewrote every checklist row as a heading plus a
      // one-line benefit, and this row stopped printing the chord: it names
      // the hotkey and says what turning it on gives you, while the chord
      // itself belongs to Settings → Shortcuts (asserted by the first test
      // in this file). The blocked row below still names it, because there
      // the chord is the problem being reported. The row's exact copy is
      // pinned by `onboarding-tools-polish.spec.mjs`; this spec asserts the
      // row's identity and the Turn on flow, so it checks only the heading,
      // in that spec's brand-alternation form — the app name is injected.
      await expect(row.getByRole('heading')).toHaveText(
        /^Global hotkey for the (?:Canopy|Unstoppable) app$/,
      );
      // Home is active, so the sidebar card is not mounted; the Home card's
      // first row is the queue's current entry.
      await expect
        .poll(() => app.currentHomeChecklistEntry())
        .toBe('focus-shortcut');

      await window
        .getByTestId('home-onboarding-suggestion-cta-enable-focus-shortcut')
        .click();

      await expect(row).toHaveCount(0);
      await expect
        .poll(() => readPreferences(userDataDir).globalFocusShortcutEnabled)
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a checklist row blocked by another app opens the Settings recorder', async () => {
    const userDataDir = seedWelcomeChecklist({
      pendingEntry: 'focus-shortcut',
    });
    const file = path.join(userDataDir, 'preferences.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.preferences.globalFocusShortcutEnabled = true;
    writeFileSync(file, JSON.stringify(saved, null, 2));
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_GLOBAL_SHORTCUT_FLOW: `in-use:${DEFAULT_ACCELERATOR}` },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const row = window.getByTestId(
        'home-onboarding-suggestion-focus-shortcut',
      );
      await expect(row).toHaveAttribute('data-step', 'focus-shortcut-blocked', {
        timeout: 30_000,
      });
      await window
        .getByTestId('home-onboarding-suggestion-cta-focus-shortcut-blocked')
        .click();

      await expect(window.getByTestId('settings-overlay')).toBeVisible();
      await expect(
        window.getByTestId('settings-global-focus-shortcut'),
      ).toBeVisible();
      await expect(
        window.getByTestId('global-focus-shortcut-status'),
      ).toHaveText(/another app is using/i);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
