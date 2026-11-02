import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  cliName,
  linuxCliEnv,
  seedLinuxCliPackage,
} from './fixtures/linux-cli-install.mjs';

// CAN-3247: real filesystem + IPC + Settings actions. Both POSIX hosts run
// Linux's installer; Linux hosted CI additionally runs the native Linux shell.
test('Linux CLI status and actions survive GUI restart and package upgrade', async () => {
  test.skip(
    process.platform === 'win32',
    'Linux installer uses POSIX symlinks',
  );
  test.setTimeout(120_000);
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'canopy-cli-status-')),
  );
  let electronApp;
  let userDataDir;
  async function open() {
    ({ electronApp, userDataDir } = await launchCanopy({
      userDataDir,
      env: linuxCliEnv(root),
    }));
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('canopy');
    const row = window.getByTestId('settings-shell-integration');
    await row.scrollIntoViewIfNeeded();
    return {
      window,
      row,
      action: window.getByTestId('settings-shell-integration-action'),
    };
  }
  async function quit() {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
  }
  try {
    await seedLinuxCliPackage(root, 'v1');
    let { window, row, action } = await open();
    await expect(row).toContainText('not currently installed');
    await expect(action).toBeEnabled();
    await action.click();
    await expect(action).toHaveText('Remove CLI');
    expect(
      (await window.evaluate(() => window.api.cli.getStatus())).state,
    ).toBe('correct-symlink');
    await quit();
    // A fresh GUI process must derive status from the managed install on disk.
    expect(
      execFileSync(path.join(root, 'bin', cliName), { encoding: 'utf8' }),
    ).toBe('v1\n');
    ({ window, row, action } = await open());
    await expect(action).toHaveText('Remove CLI');
    await quit();
    // Replace the .deb's GUI tree, leaving its per-user CLI untouched.
    await rm(path.join(root, 'package'), { recursive: true });
    await seedLinuxCliPackage(root, 'v2');
    ({ window, row, action } = await open());
    await expect(row).toContainText('outdated');
    await expect(action).toHaveText('Update CLI');
    expect(
      execFileSync(path.join(root, 'bin', cliName), { encoding: 'utf8' }),
    ).toBe('v1\n');
    await action.click();
    await expect(action).toHaveText('Remove CLI');
    expect(
      execFileSync(path.join(root, 'bin', cliName), { encoding: 'utf8' }),
    ).toBe('v2\n');
    // A package manager may replace the GUI while Settings stays open.
    await seedLinuxCliPackage(root, 'v3');
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(action).toHaveText('Update CLI');
    await action.click();
    await expect(action).toHaveText('Remove CLI');
    expect(
      execFileSync(path.join(root, 'bin', cliName), { encoding: 'utf8' }),
    ).toBe('v3\n');
    await quit();
    ({ window, row, action } = await open());
    await expect(action).toHaveText('Remove CLI');
    // An incomplete GUI package must preserve the installed CLI's remove action.
    await truncate(path.join(root, 'package/resources/bin/rg'), 0);
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(
      (await window.evaluate(() => window.api.cli.getStatus())).state,
    ).toBe('correct-symlink');
    await expect(action).toHaveText('Remove CLI');
    await action.click();
    await expect(row).toContainText('not currently installed');
    await expect(action).toHaveText('Install CLI');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else if (userDataDir)
      await rm(userDataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
