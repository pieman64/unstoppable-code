import { expect, test } from '@playwright/test';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { createLinuxUiActions } from './linuxUiActions.mjs';

// Cross-platform wiring coverage, NOT native Linux/package acceptance. Reuse
// update-banner-states' package ownership and release-fetch fixtures, with an
// emulated Linux main-process host and dpkg result only during the real check.
// The renderer, preload, IPC handler, updater and metadata verifier stay real.
// The standard stable E2E build supplies the update base URL; feed fetches below
// are intercepted in-process, with no release server or package download.
test('missing installed ARM64 package reports architecture unavailable without offering x64', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: null,
  });
  const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
  const message = `${brand.displayName} Linux updates are unavailable. Check your connection and try again. A verified .deb release for this architecture may not be published for this channel yet.`;
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const ui = createLinuxUiActions(driver);
    await driver.waitForShell();
    expect(
      await electronApp.evaluate(({ app }) =>
        app.commandLine.hasSwitch('no-sandbox'),
      ),
    ).toBe(false);
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
      }
    });
    await ui.openSettings();
    await ui.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-app-version')).toBeVisible();

    await electronApp.evaluate(({ app }, prefix) => {
      const fs = process.getBuiltinModule('fs/promises');
      const childProcess = process.getBuiltinModule('child_process');
      const originalRead = fs.readFile;
      const originalExecFile = childProcess.execFile;
      const originalFetch = globalThis.fetch;
      const originalVersion = app.getVersion;
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      const arch = Object.getOwnPropertyDescriptor(process, 'arch');
      const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged');
      const observations = { ownershipReads: 0, dpkgCalls: 0, feeds: [] };
      globalThis.__CANOPY_ARCHITECTURE_FIXTURE__ = {
        observations,
        restore() {
          Object.defineProperty(process, 'platform', platform);
          Object.defineProperty(process, 'arch', arch);
          if (packaged) Object.defineProperty(app, 'isPackaged', packaged);
          else delete app.isPackaged;
          app.getVersion = originalVersion;
          fs.readFile = originalRead;
          childProcess.execFile = originalExecFile;
          globalThis.fetch = originalFetch;
          delete globalThis.__CANOPY_ARCHITECTURE_FIXTURE__;
        },
      };
      fs.readFile = async function (file, ...args) {
        if (
          String(file).match(/\/var\/lib\/dpkg\/info\/[^/]+-desktop\.list$/)
        ) {
          observations.ownershipReads += 1;
          return `${process.execPath}\n`;
        }
        return originalRead.call(this, file, ...args);
      };
      childProcess.execFile = function (file, args, options, callback) {
        if (
          file === '/usr/bin/dpkg' &&
          args.join(' ') === '--print-architecture'
        ) {
          observations.dpkgCalls += 1;
          queueMicrotask(() => callback(null, 'arm64\n', ''));
          return;
        }
        return originalExecFile.apply(this, arguments);
      };
      globalThis.fetch = async (url, ...args) => {
        if (String(url).match(/-linux(?:-arm64)?\.yml$/)) {
          observations.feeds.push(String(url));
          // A valid newer release exists, but only for the wrong architecture.
          return new Response(
            `version: 99999.0.0\nfiles:\n - url: ${prefix}-99999.0.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
          );
        }
        return originalFetch(url, ...args);
      };
      Object.defineProperty(app, 'isPackaged', {
        configurable: true,
        value: true,
      });
      app.getVersion = () => '1.0.0';
      // Deliberately disagree with dpkg: package architecture must win.
      Object.defineProperty(process, 'arch', {
        configurable: true,
        value: 'x64',
      });
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'linux',
      });
    }, brand.release.artifactPrefix);

    try {
      await ui.clickVisibleControl(window.getByTestId('settings-update-check'));
      await expect(window.getByTestId('settings-update-status')).toHaveText(
        message,
      );
      const state = await window.evaluate(() => window.api.update.getState());
      expect(state.phase).toBe('error');
      expect(state.message).toBe(message);
      expect(state.info).toBeUndefined();
      const observations = await electronApp.evaluate(
        () => globalThis.__CANOPY_ARCHITECTURE_FIXTURE__.observations,
      );
      expect(observations.ownershipReads).toBe(1);
      expect(observations.dpkgCalls).toBe(1);
      expect(observations.feeds).toHaveLength(1);
      expect(observations.feeds[0]).toMatch(/-linux-arm64\.yml$/);
    } finally {
      // Restore before further navigation or native shutdown, also on failure.
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_ARCHITECTURE_FIXTURE__?.restore(),
      );
    }

    await expect(
      window.getByTestId('settings-linux-update-guidance'),
    ).toHaveCount(0);
    await expect(window.getByTestId('settings-update-install-now')).toHaveCount(
      0,
    );
    await expect(
      window.getByRole('link', { name: /Download.*update/i }),
    ).toHaveCount(0);
    await expect(
      window.getByRole('button', { name: /Download Linux update/i }),
    ).toHaveCount(0);
    await expect(window.locator('a[href*="linux-amd64.deb"]')).toHaveCount(0);
    await expect(window.getByTestId('settings-overlay')).not.toContainText(
      'amd64.deb',
    );
    await ui.closeSettings();
    const prompt = window.getByTestId('update-prompt');
    await expect(prompt).toHaveText('Update failed');
    await ui.hoverVisibleControl(prompt);
    await expect(window.getByRole('tooltip')).toHaveText(message);
    await expect(window.getByTestId('update-prompt-schedule')).toHaveCount(0);
  } finally {
    try {
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_ARCHITECTURE_FIXTURE__?.restore(),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});
