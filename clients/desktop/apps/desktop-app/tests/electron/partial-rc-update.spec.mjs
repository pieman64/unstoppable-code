import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';

// Settings -> real IPC/updater/electron-updater -> production provider -> UI.
// Replace only provider construction and its HTTP executor, so the normal
// stable E2E build can exercise RC discovery without credentials or a download.
// Bundle the source with its own exports because the app bundle keeps it private.
test('Settings finds the previous platform RC when the newest RC omits it', async () => {
  test.skip(
    process.platform === 'linux',
    'Linux uses a separate update reader.',
  );
  const bundleDir = mkdtempSync(path.resolve('.cache/partial-rc-provider-'));
  const providerBundle = path.join(bundleDir, 'provider.cjs');
  buildSync({
    entryPoints: ['apps/desktop-app/src/main/updater/brand-github-provider.ts'],
    outfile: providerBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: 'tsconfig.base.json',
    external: [
      'electron',
      'electron-updater',
      'electron-updater/*',
      'builder-util-runtime',
    ],
    logLevel: 'silent',
  });
  let launched;
  try {
    launched = await launchCanopy();
    const { electronApp, userDataDir } = launched;
    mergeSeedPreferences(userDataDir, { autoDownloadUpdates: false });
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-update-check')).toBeVisible();
    await electronApp.evaluate(({ app, BrowserWindow }, bundlePath) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
      }
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const { autoUpdater } = require('electron-updater');
      const { BrandedPrivateGitHubProvider } = require(bundlePath);
      Object.defineProperty(app, 'isPackaged', {
        configurable: true,
        value: true,
      });
      const channelFile =
        process.platform === 'darwin' ? 'fixture-mac.yml' : 'fixture.yml';
      const otherChannel =
        process.platform === 'darwin' ? 'fixture.yml' : 'fixture-mac.yml';
      const executor = {
        request: async (options) => {
          const requestPath = String(options.path);
          if (requestPath.endsWith('/releases')) {
            return JSON.stringify([
              {
                tag_name: 'v9999.0.0-rc.2',
                prerelease: true,
                assets: [
                  {
                    name: otherChannel,
                    url: 'https://api.github.com/releases/assets/other',
                  },
                ],
              },
              {
                tag_name: 'v9999.0.0-rc.1',
                prerelease: true,
                assets: [
                  {
                    name: channelFile,
                    url: 'https://api.github.com/releases/assets/selected',
                  },
                ],
              },
            ]);
          }
          if (requestPath.endsWith('/releases/assets/selected')) {
            return 'version: 9999.0.0-rc.1\nfiles:\n  - url: Fixture.zip\n    sha512: test-checksum\npath: Fixture.zip\nsha512: test-checksum';
          }
          throw new Error(`Unexpected update request: ${requestPath}`);
        },
      };
      autoUpdater.setFeedURL = () => {
        autoUpdater.allowPrerelease = true;
        autoUpdater.clientPromise = Promise.resolve(
          new BrandedPrivateGitHubProvider(
            {
              provider: 'custom',
              owner: 'example',
              repo: 'example',
              token: 'fixture-token',
              channel: 'fixture',
              releaseFlavor: 'rc',
            },
            autoUpdater,
            {
              platform: process.platform,
              isUseMultipleRangeRequest: true,
              executor,
            },
          ),
        );
      };
    }, providerBundle);
    await window.getByTestId('settings-update-check').click();
    await expect(window.getByTestId('settings-update-status')).toContainText(
      '9999.0.0-rc.1',
    );
    const state = await window.evaluate(() => window.api.update.getState());
    expect(state.phase).toBe('available');
    expect(state.info.version).toBe('9999.0.0-rc.1');
  } finally {
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
