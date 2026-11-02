// CAN-3449: open the app when the user signs in to their computer.
//
// Covers the Settings → General "Startup" section (the toggle, the macOS
// approval notice, refusals, the Windows Startup apps recovery), the Getting
// started checklist entry, and App Advisor turning it on while Settings is
// open.
//
// The E2E build never touches the real OS registration. With
// `CANOPY_E2E_LAUNCH_AT_LOGIN_STATE=<file>` set, `lifecycle/launch-at-login.ts`
// swaps Electron's `app.get/setLoginItemSettings` for a registrar backed by
// that JSON file: `{ platform, openAtLogin, status?,
// executableWillLaunchAtLogin?, refuseWrites? }`. The file survives a
// relaunch, a spec rewrites it to simulate a change made in System Settings
// or Task Manager, and `platform: 'win32'` exercises the Windows copy and
// recovery on macOS CI. Without the variable the unpackaged E2E build reports
// launch at sign-in as unavailable, which is what every other spec sees.
// External opens go to a local capture endpoint, never the real System
// Settings. What this cannot prove is a real sign-in launch; that is manual
// QA on packaged builds (docs/desktop-launch-at-login.md).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

const APP_NAME = '(?:Canopy|Unstoppable)';
const MAC_LOGIN_ITEMS =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';
const WINDOWS_STARTUP_APPS = 'ms-settings:startupapps';

function createStateFile(initial) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-launch-at-login-'));
  const file = path.join(dir, 'state.json');
  if (initial !== undefined) writeState(file, initial);
  return { dir, file };
}

function writeState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function readState(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function openGeneralSettings(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openSettings();
  await app.openSettingsSection('canopy');
  const section = window.getByTestId('settings-canopy-launch-at-login');
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  return app;
}

/** Dispatches an App Advisor action and resolves with its response. */
async function dispatchAdvisorAction(electronApp, action) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          10_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId: `launch-at-login-${Date.now()}`,
      action,
    },
  );
}

test.describe('Launch at sign-in (CAN-3449)', () => {
  test.setTimeout(180_000);

  test('is off by default, turns on through the OS, and stays on after a relaunch', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: false,
      status: 'not-registered',
    });
    const env = { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file };
    const first = await launchCanopy({ env });
    const { userDataDir } = first;
    try {
      const window = await first.electronApp.firstWindow();
      await openGeneralSettings(window);
      await expect(
        window.getByTestId('settings-canopy-launch-at-login'),
      ).toContainText(
        new RegExp(`Open ${APP_NAME} when you sign in to your Mac`),
      );
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect
        .poll(() => readState(state.file))
        .toMatchObject({ openAtLogin: true, status: 'enabled' });
      await expect(window.getByTestId('launch-at-login-error')).toHaveCount(0);
    } finally {
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const second = await launchCanopy({ userDataDir, env });
    try {
      const window = await second.electronApp.firstWindow();
      await openGeneralSettings(window);
      await expect(
        window.getByTestId('launch-at-login-toggle'),
      ).toHaveAttribute('aria-checked', 'true');
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('follows a change made outside the app when the window regains focus', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: true,
      status: 'enabled',
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      // Removed under System Settings → General while the app was behind.
      writeState(state.file, {
        platform: 'darwin',
        openAtLogin: false,
        status: 'not-registered',
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));

      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('asks for approval while macOS waits on System Settings', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: true,
      status: 'requires-approval',
    });
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir } = await launchCanopy({
      env: {
        CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file,
        ...capture.env,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      await expect(
        window.getByTestId('launch-at-login-toggle'),
      ).toHaveAttribute('aria-checked', 'true');
      const notice = window.getByTestId('launch-at-login-needs-approval');
      await expect(notice).toContainText(
        new RegExp(
          `Allow ${APP_NAME} in System Settings to finish turning this on\\.`,
        ),
      );

      await window.getByTestId('launch-at-login-open-system-settings').click();
      await expect.poll(() => capture.opened).toEqual([MAC_LOGIN_ITEMS]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('keeps the OS state and explains a refused change', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: false,
      status: 'not-registered',
      refuseWrites: true,
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');

      await toggle.click();

      const error = window.getByTestId('launch-at-login-error');
      await expect(error).toHaveText(/Could not turn this on\. Try again\./);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        window.getByTestId('launch-at-login-open-startup-apps'),
      ).toHaveCount(0);
      expect(readState(state.file)).toMatchObject({ openAtLogin: false });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('explains a refused turn-off while macOS approval is pending', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: true,
      status: 'requires-approval',
      refuseWrites: true,
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      await toggle.click();

      await expect(window.getByTestId('launch-at-login-error')).toHaveText(
        /Could not turn this off\. Try again\./,
      );
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(readState(state.file)).toMatchObject({
        openAtLogin: true,
        status: 'requires-approval',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('uses Windows copy and points a refusal at Startup apps', async () => {
    const state = createStateFile({
      platform: 'win32',
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
      refuseWrites: true,
    });
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir } = await launchCanopy({
      env: {
        CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file,
        ...capture.env,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const section = window.getByTestId('settings-canopy-launch-at-login');
      await expect(section).toContainText(
        new RegExp(`Open ${APP_NAME} when you sign in to Windows`),
      );
      // Disabled in Task Manager: the run key is there, but it will not open.
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await toggle.click();

      await expect(window.getByTestId('launch-at-login-error')).toHaveText(
        /Could not turn this on\. Try again\./,
      );
      await expect(
        window.getByTestId('launch-at-login-needs-approval'),
      ).toHaveCount(0);
      const startupApps = window.getByTestId(
        'launch-at-login-open-startup-apps',
      );
      await expect(startupApps).toHaveText('Open Startup apps');
      await startupApps.click();
      await expect.poll(() => capture.opened).toEqual([WINDOWS_STARTUP_APPS]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('App Advisor turns it on and an open Settings window follows', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: false,
      status: 'not-registered',
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      const response = await dispatchAdvisorAction(electronApp, {
        type: 'settings.set_launch_at_login',
        enabled: true,
      });

      expect(response).toMatchObject({
        ok: true,
        result: { launchAtLogin: { enabled: true, pendingApproval: false } },
      });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect
        .poll(() => readState(state.file))
        .toMatchObject({ openAtLogin: true, status: 'enabled' });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('App Advisor reports a refused turn-off as still on while macOS approval is pending', async () => {
    const state = createStateFile({
      platform: 'darwin',
      openAtLogin: true,
      status: 'requires-approval',
      refuseWrites: true,
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: state.file },
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      const response = await dispatchAdvisorAction(electronApp, {
        type: 'settings.set_launch_at_login',
        enabled: false,
      });

      // App Advisor and the Settings toggle describe the same state.
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'The system kept launch at sign-in on while it waits for approval in System Settings.',
        },
      });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(window.getByTestId('launch-at-login-error')).toHaveText(
        /Could not turn this off\. Try again\./,
      );
      expect(readState(state.file)).toMatchObject({
        openAtLogin: true,
        status: 'requires-approval',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(state.dir, { recursive: true, force: true });
    }
  });

  test('is unavailable in a build that is not installed', async () => {
    // Launch at sign-in is the only step left, so a finished checklist
    // proves the unsupported entry was skipped rather than shown.
    const userDataDir = seedWelcomeChecklist({
      pendingEntries: ['launch-at-login'],
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      // Guard against a developer shell that exports the variable.
      env: { CANOPY_E2E_LAUNCH_AT_LOGIN_STATE: '' },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = await openGeneralSettings(window);
      const toggle = window.getByTestId('launch-at-login-toggle');
      await expect(toggle).toBeDisabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        window.getByTestId('launch-at-login-unavailable'),
      ).toHaveText('Available in the installed app.');

      await app.closeSettings();
      await expect(
        window.getByTestId('home-onboarding-suggestion-launch-at-login'),
      ).toHaveCount(0);
      // Back on Home, the composer shows and Getting started has nothing left.
      await expect(
        window.getByTestId('home-composer-editor').locator('visible=true'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId('home-onboarding-checklist-progress'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
