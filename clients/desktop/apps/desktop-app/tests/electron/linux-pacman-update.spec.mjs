import { expect, test } from '@playwright/test';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { createLinuxUiActions } from './linuxUiActions.mjs';

// CAN-5103 cross-platform wiring coverage, NOT native Arch acceptance. Like
// linux-update-architecture.spec.mjs, it emulates a Linux main-process host
// only during the real check and serves a pacman local database (including a
// prefix-collision package) through in-process fs fixtures, with dpkg absent.
// The renderer, preload, IPC handler, install detection, updater and metadata
// verifier stay real. Feed fetches are intercepted in-process.
test('pacman install offers the package manager command, never a .deb download', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: null,
  });
  const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
  const packageName = `${brand.cliName}-desktop`;
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const ui = createLinuxUiActions(driver);
    await driver.waitForShell();
    await ui.openSettings();
    await ui.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-app-version')).toBeVisible();

    await electronApp.evaluate(
      ({ app }, { prefix, packageName }) => {
        const fs = process.getBuiltinModule('fs/promises');
        const childProcess = process.getBuiltinModule('child_process');
        const originals = {
          readFile: fs.readFile,
          readdir: fs.readdir,
          realpath: fs.realpath,
          execFile: childProcess.execFile,
          fetch: globalThis.fetch,
          getVersion: app.getVersion,
        };
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        const arch = Object.getOwnPropertyDescriptor(process, 'arch');
        const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged');
        const localDb = '/var/lib/pacman/local';
        const installedPath = `/opt/${packageName}/${packageName}`;
        const observations = {
          dpkgOwnershipReads: 0,
          pacmanReads: [],
          dpkgCalls: 0,
          feeds: [],
        };
        const records = new Map([
          [
            `${localDb}/${packageName}-1.0.0-1/desc`,
            `%NAME%\n${packageName}\n\n%VERSION%\n1.0.0-1\n\n`,
          ],
          [
            `${localDb}/${packageName}-1.0.0-1/files`,
            `%FILES%\nopt/\nopt/${packageName}/\n${installedPath.slice(1)}\n\n`,
          ],
          [
            `${localDb}/${packageName}-bin-9.0.0-1/desc`,
            `%NAME%\n${packageName}-bin\n\n%VERSION%\n9.0.0-1\n\n`,
          ],
          [
            `${localDb}/${packageName}-bin-9.0.0-1/files`,
            `%FILES%\n${installedPath.slice(1)}\n\n`,
          ],
        ]);
        globalThis.__CANOPY_PACMAN_FIXTURE__ = {
          observations,
          restore() {
            Object.defineProperty(process, 'platform', platform);
            Object.defineProperty(process, 'arch', arch);
            if (packaged) Object.defineProperty(app, 'isPackaged', packaged);
            else delete app.isPackaged;
            app.getVersion = originals.getVersion;
            fs.readFile = originals.readFile;
            fs.readdir = originals.readdir;
            fs.realpath = originals.realpath;
            childProcess.execFile = originals.execFile;
            globalThis.fetch = originals.fetch;
            delete globalThis.__CANOPY_PACMAN_FIXTURE__;
          },
        };
        const missing = () =>
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        fs.readFile = async function (file, ...args) {
          const name = String(file);
          if (/\/var\/lib\/dpkg\/info\/[^/]+-desktop\.list$/.test(name)) {
            observations.dpkgOwnershipReads += 1;
            throw missing();
          }
          if (name.startsWith(`${localDb}/`)) {
            observations.pacmanReads.push(name);
            if (records.has(name)) return records.get(name);
            throw missing();
          }
          return originals.readFile.call(this, file, ...args);
        };
        fs.readdir = async function (directory, ...args) {
          if (String(directory) !== localDb)
            return originals.readdir.call(this, directory, ...args);
          return [
            'ALPM_DB_VERSION',
            `${packageName}-1.0.0-1`,
            `${packageName}-bin-9.0.0-1`,
          ].map((name) => ({
            name,
            isDirectory: () => name !== 'ALPM_DB_VERSION',
          }));
        };
        fs.realpath = async function (file, ...args) {
          if (String(file) === process.execPath) return installedPath;
          return originals.realpath.call(this, file, ...args);
        };
        childProcess.execFile = function (file, args, options, callback) {
          if (file === '/usr/bin/dpkg') {
            observations.dpkgCalls += 1;
            queueMicrotask(() => callback(missing(), '', ''));
            return;
          }
          return originals.execFile.apply(this, arguments);
        };
        globalThis.fetch = async (url, ...args) => {
          if (String(url).match(/-linux(?:-arm64)?\.yml$/)) {
            observations.feeds.push(String(url));
            return new Response(
              `version: 99999.0.0\nfiles:\n - url: ${prefix}-99999.0.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
            );
          }
          return originals.fetch(url, ...args);
        };
        Object.defineProperty(app, 'isPackaged', {
          configurable: true,
          value: true,
        });
        app.getVersion = () => '1.0.0';
        Object.defineProperty(process, 'arch', {
          configurable: true,
          value: 'x64',
        });
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'linux',
        });
      },
      { prefix: brand.release.artifactPrefix, packageName },
    );

    try {
      await ui.clickVisibleControl(window.getByTestId('settings-update-check'));
      await expect(window.getByTestId('settings-update-status')).toHaveText(
        'Version 99999.0.0 is available.',
      );
      const state = await window.evaluate(() => window.api.update.getState());
      expect(state.phase).toBe('available');
      expect(state.info).toEqual({
        version: '99999.0.0',
        packageManagerUpdate: {
          guidance: 'Update with your package manager:',
          command: 'sudo pacman -Syu',
        },
      });
      const observations = await electronApp.evaluate(
        () => globalThis.__CANOPY_PACMAN_FIXTURE__.observations,
      );
      expect(observations.dpkgOwnershipReads).toBe(1);
      expect(observations.dpkgCalls).toBe(1);
      expect(observations.feeds).toHaveLength(1);
      expect(observations.feeds[0]).toMatch(/-linux\.yml$/);
      expect(observations.pacmanReads).toEqual(
        expect.arrayContaining([
          `/var/lib/pacman/local/${packageName}-1.0.0-1/files`,
        ]),
      );
      expect(observations.pacmanReads).not.toContain(
        `/var/lib/pacman/local/${packageName}-bin-9.0.0-1/files`,
      );
    } finally {
      // Restore before further navigation or native shutdown, also on failure.
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_PACMAN_FIXTURE__?.restore(),
      );
    }

    await expect(window.locator('a[href*=".deb"]')).toHaveCount(0);
    await expect(window.getByTestId('settings-overlay')).not.toContainText(
      'amd64.deb',
    );
    await expect(window.getByTestId('settings-update-install-now')).toHaveCount(
      0,
    );
  } finally {
    try {
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_PACMAN_FIXTURE__?.restore(),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});
