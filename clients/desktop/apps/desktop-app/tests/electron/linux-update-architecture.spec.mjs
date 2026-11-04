import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { finalizedLinuxUpdateFixture } from '../../../../scripts/release/linux-publication-test-fixture.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { createLinuxUiActions } from './linuxUiActions.mjs';

// Cross-platform wiring coverage, NOT native Linux/package acceptance. Reuse
// update-banner-states' package ownership and release-fetch fixtures, with an
// emulated Linux main-process host and dpkg result only during the real check.
// The renderer, preload, IPC handler, updater and metadata verifier stay real.
// The standard stable E2E build supplies the update base URL; feed fetches below
// are intercepted in-process from actual staged + finalized publication output,
// with no release server or package download.
test('unpublished installed ARM64 channel reports architecture unavailable without offering x64', async () => {
  const cleanups = [];
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: null,
    env: { CANOPY_E2E_PLATFORM: 'linux' },
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

    const publication = await finalizedLinuxUpdateFixture(
      { after: (cleanup) => cleanups.push(cleanup) },
      brand.id,
      { arm64: false },
    );
    expect(Object.keys(publication.packages)).toEqual(['amd64']);
    await electronApp.evaluate(({ app }, feeds) => {
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
          // Only finalized channels exist; the optional ARM64 channel is absent.
          return Object.hasOwn(feeds, String(url))
            ? new Response(feeds[String(url)])
            : new Response('Not found', { status: 404 });
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
    }, publication.feeds);

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
    await expect(prompt).toHaveText('Check Linux updates');
    await ui.hoverVisibleControl(prompt);
    await expect(window.getByRole('tooltip')).toHaveText(message);
    await expect(window.getByTestId('update-prompt-schedule')).toHaveCount(0);
  } finally {
    try {
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_ARCHITECTURE_FIXTURE__?.restore(),
      );
    } finally {
      try {
        await closeCanopy(electronApp, userDataDir);
      } finally {
        for (const cleanup of cleanups) cleanup();
      }
    }
  }
});

// Run with a stable E2E build for each brand. Private-channel policy is pinned
// by helper/component/main tests; changing flavor requires a separate build.
for (const architecture of ['amd64', 'arm64']) {
  test(`installed ${architecture} shows terminal guidance and a verified architecture-matched fallback`, async () => {
    const opened = [];
    const capture = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        opened.push(JSON.parse(body).url);
        response.end('{}');
      });
    });
    await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
    const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
    const offersApt = brand.id === 'unstoppable-code';
    const label = offersApt
      ? 'Reinstall Linux package'
      : 'Download Linux update';
    let launched;
    const cleanups = [];
    try {
      const publication = await finalizedLinuxUpdateFixture(
        { after: (cleanup) => cleanups.push(cleanup) },
        brand.id,
      );
      const expectedPackage = publication.packages[architecture];
      expect(expectedPackage).toBeDefined();
      launched = await launchCanopy({
        viewportSize: null,
        env: {
          CANOPY_E2E_PLATFORM: 'linux',
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${capture.address().port}/capture`,
        },
      });
      const { electronApp } = launched;
      const window = await electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      const ui = createLinuxUiActions(driver);
      await driver.waitForShell();
      await ui.openSettings();
      await ui.openSettingsSection('canopy');
      await installPackageFixture(electronApp, {
        architecture,
        feeds: publication.feeds,
      });
      try {
        await ui.clickVisibleControl(
          window.getByTestId('settings-update-check'),
        );
        const guidance = window.getByTestId('settings-linux-update-guidance');
        await expect(guidance).toContainText(
          `SHA-512: ${expectedPackage.sha512}`,
        );
        if (offersApt) {
          await expect(guidance).toContainText(
            'sudo apt update && sudo apt upgrade',
          );
          await expect(guidance).toContainText(
            'install the current official .deb once more',
          );
          await expect(guidance).toContainText('reinstall fallback');
          await expect
            .soft(guidance.locator('code').first())
            .toHaveClass(/ph-no-capture/);
          await expect(guidance).not.toHaveClass(/ph-no-capture/);
          await expect(guidance.locator('p').first()).not.toHaveClass(
            /ph-no-capture/,
          );
        } else {
          await expect(guidance).not.toContainText('apt update');
          await expect(guidance).not.toContainText('once more');
        }
        const expectedUrl = expectedPackage.url;
        expect(expectedUrl).toBe(
          `https://releases.unstoppable.ai/desktop/${brand.release.artifactPrefix}/1.2.3/${brand.release.artifactPrefix}-1.2.3-linux-${architecture === 'amd64' ? 'x64' : 'arm64'}.deb`,
        );
        const fallback = window.getByTestId('settings-linux-update-download');
        await expect(fallback).toHaveText(label);
        await ui.clickVisibleControl(fallback);
        await expect.poll(() => opened).toEqual([expectedUrl]);
        for (const action of [
          'downloadUpdate',
          'installUpdate',
          'scheduleUpdate',
        ]) {
          expect(
            await window.evaluate(async (method) => {
              try {
                await window.api.update[method]();
                return 'allowed';
              } catch {
                return 'refused';
              }
            }, action),
          ).toBe('refused');
        }
      } finally {
        await electronApp.evaluate(() =>
          globalThis.__CANOPY_APT_FIXTURE__?.restore(),
        );
      }
      await ui.closeSettings();
      const prompt = window.getByTestId('update-prompt');
      await expect(prompt).toHaveText(label);
      if (offersApt) {
        await expect(
          window.getByTestId('update-prompt-linux-guidance'),
        ).toContainText('sudo apt update && sudo apt upgrade');
        await expect(
          window.getByTestId('update-prompt-linux-guidance'),
        ).toContainText('install the current official .deb once more');
        const sidebarGuidance = window.getByTestId(
          'update-prompt-linux-guidance',
        );
        await expect
          .soft(sidebarGuidance.locator('code'))
          .toHaveClass(/ph-no-capture/);
        await expect(sidebarGuidance).not.toHaveClass(/ph-no-capture/);
        await expect(sidebarGuidance.locator('p').first()).not.toHaveClass(
          /ph-no-capture/,
        );
        await expect(prompt).not.toHaveClass(/ph-no-capture/);
      } else {
        await expect(
          window.getByTestId('update-prompt-linux-guidance'),
        ).toHaveCount(0);
      }
      await ui.clickVisibleControl(prompt);
      await expect.poll(() => opened).toHaveLength(2);
      expect(opened).toEqual([opened[0], opened[0]]);
      await expect(window.getByTestId('update-prompt-schedule')).toHaveCount(0);
    } finally {
      try {
        if (launched) {
          try {
            await launched.electronApp.evaluate(() =>
              globalThis.__CANOPY_APT_FIXTURE__?.restore(),
            );
          } finally {
            await closeCanopy(launched.electronApp, launched.userDataDir);
          }
        }
      } finally {
        for (const cleanup of cleanups) cleanup();
        await new Promise((resolve) => capture.close(resolve));
      }
    }
  });
}

test('unsupported Linux package offers no APT command or reinstall action', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: null,
    env: { CANOPY_E2E_PLATFORM: 'linux' },
  });
  const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const ui = createLinuxUiActions(driver);
    await driver.waitForShell();
    await ui.openSettings();
    await ui.openSettingsSection('canopy');
    await installPackageFixture(electronApp, { installed: false });
    try {
      await ui.clickVisibleControl(window.getByTestId('settings-update-check'));
      await expect(window.getByTestId('settings-update-status')).toContainText(
        `Linux update checks need ${brand.displayName} installed from its official .deb or pacman package on x64 or arm64. Other installs and architectures are not supported.`,
      );
      await expect(
        window.getByTestId('settings-linux-update-guidance'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('settings-linux-update-download'),
      ).toHaveCount(0);
      await expect(window.getByTestId('settings-overlay')).not.toContainText(
        'sudo apt',
      );
    } finally {
      await electronApp.evaluate(() =>
        globalThis.__CANOPY_APT_FIXTURE__?.restore(),
      );
    }
    await ui.closeSettings();
    await expect(window.getByTestId('update-prompt')).toHaveText(
      'Check Linux updates',
    );
    await expect(
      window.getByTestId('update-prompt-linux-guidance'),
    ).toHaveCount(0);
  } finally {
    await electronApp.evaluate(() =>
      globalThis.__CANOPY_APT_FIXTURE__?.restore(),
    );
    await closeCanopy(electronApp, userDataDir);
  }
});

async function installPackageFixture(
  electronApp,
  { architecture = 'amd64', feeds = {}, installed = true } = {},
) {
  await electronApp.evaluate(
    ({ app, BrowserWindow }, { architecture, feeds, installed }) => {
      const fs = process.getBuiltinModule('fs/promises');
      const cp = process.getBuiltinModule('child_process');
      const originalRead = fs.readFile;
      const originalExec = cp.execFile;
      const originalFetch = globalThis.fetch;
      const originalVersion = app.getVersion;
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged');
      globalThis.__CANOPY_APT_FIXTURE__ = {
        restore() {
          Object.defineProperty(process, 'platform', platform);
          if (packaged) Object.defineProperty(app, 'isPackaged', packaged);
          else delete app.isPackaged;
          app.getVersion = originalVersion;
          fs.readFile = originalRead;
          cp.execFile = originalExec;
          globalThis.fetch = originalFetch;
          delete globalThis.__CANOPY_APT_FIXTURE__;
        },
      };
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false);
      fs.readFile = async function (file, ...args) {
        if (String(file).match(/\/var\/lib\/dpkg\/info\/[^/]+-desktop\.list$/))
          return installed ? `${process.execPath}\n` : '';
        return originalRead.call(this, file, ...args);
      };
      cp.execFile = function (file, args, options, callback) {
        if (
          file === '/usr/bin/dpkg' &&
          args.join(' ') === '--print-architecture'
        ) {
          queueMicrotask(() => callback(null, `${architecture}\n`, ''));
          return;
        }
        return originalExec.apply(this, arguments);
      };
      globalThis.fetch = async (url, ...args) => {
        if (String(url).match(/-linux(?:-arm64)?\.yml$/))
          return Object.hasOwn(feeds, String(url))
            ? new Response(feeds[String(url)])
            : new Response('Not found', { status: 404 });
        return originalFetch(url, ...args);
      };
      app.getVersion = () => '1.0.0';
      Object.defineProperty(app, 'isPackaged', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'linux',
      });
    },
    { architecture, feeds, installed },
  );
}
