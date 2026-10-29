import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('stable update Settings hides private GitHub auth and keeps a timeout actionable', async () => {
  test.skip(process.platform !== 'win32', 'Windows updater regression.');
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false);
      ipcMain.removeHandler('settings:github-cli-status');
      ipcMain.handle('settings:github-cli-status', () => ({
        authenticated: false,
        username: null,
        error: null,
        tokenSource: null,
        envOverride: false,
        envOverrideName: null,
        hasCredentialStoreLogin: false,
      }));
      ipcMain.removeHandler('settings:load-github-pat');
      ipcMain.handle('settings:load-github-pat', () => '');
    });
    await driver.openSettings();
    await driver.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-app-version')).toBeVisible();
    await expect(
      window.getByText('Private release checks need GitHub access.', {
        exact: false,
      }),
    ).toHaveCount(0);
    await electronApp.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const { autoUpdater } = require('electron-updater');
      Object.defineProperty(app, 'isPackaged', {
        configurable: true,
        value: true,
      });
      autoUpdater.checkForUpdates = async () => {
        throw Object.assign(new Error('controlled timeout'), {
          code: 'ERR_UPDATER_SIGNATURE_TIMEOUT',
        });
      };
    });
    // The real Settings action displays the updater's current failure.
    await window.getByTestId('settings-update-check').click();
    await expect(window.getByTestId('settings-update-status')).toContainText(
      'signature verification timed out',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
