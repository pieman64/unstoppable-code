import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { createLinuxUiActions } from './linuxUiActions.mjs';

// The sidebar update prompt (UpdatePrompt.tsx) renders the full update
// lifecycle in the footer banner slot: available → downloading (live
// percent) → downloaded (restart action) / queued deferred install, plus a
// retryable error state. The renderer derives all of it from `update:event`
// IPC pushes, so the spec drives the state machine by emitting the same
// events the main-process updater would, without touching electron-updater.
async function emitUpdateEvent(electronApp, event) {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('update:event', payload);
    }
  }, event);
}

const UPDATE_INFO = { version: '0.99.0', releaseDate: '2026-07-30T00:00:00Z' };

if (
  process.env.CANOPY_REQUIRE_LINUX_DEB_UPDATE_SPEC === '1' &&
  (process.platform !== 'linux' || process.arch !== 'x64')
) {
  throw new Error(
    'CAN-3195 requires the real Linux update flow; a non-Linux skip is not evidence.',
  );
}

test('Linux .deb checks through Settings and opens only the official download page', async () => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Requires the Linux runtime; hosted proof PENDING PR CI.',
  );
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
  const { port } = capture.address();
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: null,
    env: {
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${port}/capture`,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const linuxUi = createLinuxUiActions(driver);
    await driver.waitForShell();
    expect(
      await electronApp.evaluate(({ app }) =>
        app.commandLine.hasSwitch('no-sandbox'),
      ),
    ).toBe(false);
    // Hidden Linux windows can suspend the frames Playwright needs for click
    // stability checks. Keep this fixture interactive without showing it.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
      }
    });
    const nativeWindow = await electronApp.browserWindow(window);
    const [nativeWidth, nativeHeight] = await nativeWindow.evaluate((owner) =>
      owner.getContentSize(),
    );
    await nativeWindow.dispose();
    // Footer controls must stay inside the native input area. CDP viewport
    // emulation can otherwise put them below a decorated Linux window's client.
    await expect
      .poll(() =>
        window.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      )
      .toEqual({ width: nativeWidth, height: nativeHeight });
    const fixtureBrand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
    const expectedUrl = await electronApp.evaluate(({ app }, prefix) => {
      Object.defineProperty(app, 'isPackaged', {
        configurable: true,
        value: true,
      });
      // Linux's unpackaged main-script runtime reports 0.0, not a stable app version.
      app.getVersion = () => '1.0.0';
      const fs = process.getBuiltinModule('fs/promises');
      const originalRead = fs.readFile;
      fs.readFile = async function (file, ...args) {
        if (String(file).match(/\/var\/lib\/dpkg\/info\/[^/]+-desktop\.list$/))
          return `${process.execPath}\n`;
        return originalRead.call(this, file, ...args);
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, ...args) => {
        if (String(url).endsWith('-linux.yml')) {
          return new Response(
            `version: 99999.0.0\nfiles:\n - url: ${prefix}-99999.0.0-linux-amd64.deb\n   sha512: ${'A'.repeat(86)}==\n`,
          );
        }
        return originalFetch(url, ...args);
      };
      return `https://releases.unstoppable.ai/desktop/${prefix}/99999.0.0/${prefix}-99999.0.0-linux-amd64.deb`;
    }, fixtureBrand.release.artifactPrefix);
    await linuxUi.openSettings();
    await linuxUi.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-app-version')).toBeVisible();
    await linuxUi.clickVisibleControl(
      window.getByTestId('settings-update-check'),
    );
    const prompt = window.getByTestId('update-prompt');
    await expect(prompt).toHaveText('Download Linux update');
    await expect(
      window.getByTestId('settings-linux-update-guidance'),
    ).toContainText(`SHA-512: ${'0'.repeat(128)}`);
    await expect(
      window.getByTestId('settings-auto-download-updates'),
    ).toHaveCount(0);
    await expect(window.getByTestId('settings-update-install-now')).toHaveCount(
      0,
    );
    await linuxUi.closeSettings();
    await linuxUi.hoverVisibleControl(prompt);
    await expect(window.getByRole('tooltip')).toContainText('Verify');
    await expect(window.getByRole('tooltip')).toContainText('checksum');
    await linuxUi.clickVisibleControl(prompt);
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
    await expect(prompt).not.toHaveText(/Restart|Updating/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => capture.close(resolve));
  }
});

function progressEvent(percent) {
  return {
    type: 'download-progress',
    progress: {
      percent,
      bytesPerSecond: 1_000_000,
      transferred: percent,
      total: 100,
    },
  };
}

test('restart to update finishes when a network server never acknowledges shutdown', async () => {
  test.skip(
    process.platform === 'linux',
    'Linux never installs updates in-app.',
  );
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-restart-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'restart-chat',
        title: 'Restart durability',
        blocks: [
          { type: 'text', text: 'Saved work survives an update restart.' },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  let reopened;
  let closed = false;
  electronApp.on('close', () => {
    closed = true;
  });
  try {
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    await expect(
      window.getByText('Saved work survives an update restart.', {
        exact: true,
      }),
    ).toBeVisible();
    const nativePid = await electronApp.evaluate(async () => {
      // Reuse the existing synthetic authenticated-route fixture to start the
      // real desktop integration server, without an external provider.
      await globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({ kind: 'create' });
      return process.pid;
    });
    await electronApp.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const { autoUpdater } = require('electron-updater');
      // Replace only native installation; retain updater IPC and real cleanup.
      autoUpdater.quitAndInstall = () => app.quit();
      autoUpdater.emit('update-downloaded', {
        version: '0.99.0',
        releaseDate: '2026-07-30T00:00:00Z',
      });
      const { Server } = process.getBuiltinModule('http');
      const originalClose = Server.prototype.close;
      const held = [];
      Server.prototype.close = function (callback) {
        if (callback) held.push(callback);
        // Native server really closes; its completion acknowledgement is held.
        return originalClose.call(this);
      };
      globalThis.__CANOPY_RELEASE_HELD_SERVER_CLOSES__ = () => {
        Server.prototype.close = originalClose;
        held.splice(0).forEach((callback) => callback());
      };
    });
    const prompt = window.getByTestId('update-prompt');
    await expect(prompt).toHaveText('Restart to update');
    const finished = electronApp.waitForEvent('close', { timeout: 25_000 });
    // A click may lose its acknowledgement when the native app exits.
    await prompt.click().catch(() => undefined);
    await finished;
    await expect
      .poll(() => {
        try {
          process.kill(nativePid, 0);
          return false;
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          return true;
        }
      })
      .toBe(true);
    const log = readFileSync(
      path.join(userDataDir, 'logs', 'main.log'),
      'utf8',
    );
    expect(log).toContain('runtime_cleanup_stage');
    expect(log).toContain('timed_out');
    expect(log).toContain('chat-state');
    expect(log).toContain('complete');
    const diagnosticDir = path.join(
      userDataDir,
      'agent-observability/diagnostics/app-events',
    );
    const events = readdirSync(diagnosticDir)
      .flatMap((file) =>
        readFileSync(path.join(diagnosticDir, file), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .filter((event) => event.kind === 'runtime_cleanup_stage');
    const drained = events.findIndex(
      (event) =>
        event.cleanupStage === 'chat-state' &&
        event.cleanupStatus === 'completed',
    );
    const timedOut = events.findIndex(
      (event) =>
        event.cleanupStage === 'mcp-proxy' &&
        event.cleanupStatus === 'timed_out',
    );
    expect(drained).toBeGreaterThanOrEqual(0);
    expect(timedOut).toBeGreaterThan(drained);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    reopened = (await launchCanopy({ userDataDir })).electronApp;
    const restoredWindow = await reopened.firstWindow();
    const restoredDriver = new CanopyAppDriver(restoredWindow);
    await restoredDriver.waitForShell();
    await restoredDriver.openMainPage();
    await restoredDriver.selectWorktree('demo-main');
    await expect(
      restoredWindow.getByText('Saved work survives an update restart.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    if (!closed) {
      await electronApp
        .evaluate(() => globalThis.__CANOPY_RELEASE_HELD_SERVER_CLOSES__?.())
        .catch(() => undefined);
    }
    await closeCanopy(reopened ?? electronApp, userDataDir);
  }
});

test('sidebar update prompt walks every updater phase', async ({}, testInfo) => {
  test.skip(
    process.platform === 'linux',
    'Installer lifecycle is macOS/Windows only; Linux has the real manual flow above.',
  );
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const prompt = window.getByTestId('update-prompt');
    const screenshot = async (name) => {
      await window.screenshot({
        path: testInfo.outputPath(`update-banner-${name}.png`),
      });
    };

    // Idle baseline: no updater activity, no banner.
    await expect(prompt).toHaveCount(0);

    // Available: actionable accent-tinted button.
    await emitUpdateEvent(electronApp, {
      type: 'available',
      info: UPDATE_INFO,
    });
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveText('Update available');
    await expect(prompt).toHaveRole('button');
    await expect(prompt).toHaveAccessibleName(
      'Update available (v0.99.0): start download',
    );
    await screenshot('available');

    // Downloading: non-interactive live status with the streamed percent.
    await emitUpdateEvent(electronApp, progressEvent(12));
    await expect(prompt).toContainText('Updating…');
    await expect(window.getByTestId('update-prompt-percent')).toHaveText('12%');
    await screenshot('downloading-12');

    await emitUpdateEvent(electronApp, progressEvent(87));
    await expect(window.getByTestId('update-prompt-percent')).toHaveText('87%');
    await screenshot('downloading-87');

    // Downloaded: actionable restart button plus the trailing
    // install-when-idle action (CAN-2278) as a sibling button.
    await emitUpdateEvent(electronApp, {
      type: 'downloaded',
      info: UPDATE_INFO,
    });
    await expect(prompt).toHaveText('Restart to update');
    await expect(prompt).toHaveRole('button');
    const scheduleAction = window.getByTestId('update-prompt-schedule');
    await expect(scheduleAction).toBeVisible();
    await expect(scheduleAction).toHaveRole('button');
    await expect(scheduleAction).toHaveAccessibleName(
      'Install v0.99.0 when all agents are idle',
    );
    await scheduleAction.hover();
    await expect(window.getByRole('tooltip')).toHaveText('Install when idle');
    await screenshot('downloaded');

    // Real click coverage for the schedule/cancel round trip. The production
    // `update:schedule` / `update:cancel-scheduled` handlers guard on the
    // MAIN-process updater holding a genuinely downloaded artifact, which an
    // unpackaged test build can never have, so replace them with stubs that
    // broadcast the exact `install-pending` events the packaged updater
    // emits. The renderer → preload IPC → main handler → `update:event` →
    // renderer round trip stays real.
    await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
      const broadcast = (pending) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('update:event', {
            type: 'install-pending',
            pending,
          });
        }
      };
      ipcMain.removeHandler('update:schedule');
      ipcMain.handle('update:schedule', () => broadcast(true));
      ipcMain.removeHandler('update:cancel-scheduled');
      ipcMain.handle('update:cancel-scheduled', () => broadcast(false));
    });

    // Clicking the trailing clock queues the deferred install: the schedule
    // action is replaced by a cancel action; the banner itself restarts
    // immediately.
    await scheduleAction.click();
    await expect(prompt).toHaveText('Update queued');
    await expect(scheduleAction).toHaveCount(0);
    const cancelAction = window.getByTestId('update-prompt-cancel-schedule');
    await expect(cancelAction).toBeVisible();
    await expect(cancelAction).toHaveRole('button');
    await expect(cancelAction).toHaveAccessibleName(
      'Cancel the scheduled install of v0.99.0',
    );
    await screenshot('queued');

    // Clicking the trailing cancel un-queues it and restores the schedule
    // action.
    await cancelAction.click();
    await expect(prompt).toHaveText('Restart to update');
    await expect(scheduleAction).toBeVisible();
    await expect(cancelAction).toHaveCount(0);

    // Re-queue (clicked, not injected) so the error transition below also
    // covers leaving the queued state.
    await scheduleAction.click();
    await expect(prompt).toHaveText('Update queued');

    // Error: the message is exposed via the tooltip and the banner offers a
    // retry action instead of disappearing silently.
    await emitUpdateEvent(electronApp, {
      type: 'error',
      message: 'GitHub release request failed with HTTP 403.',
    });
    await expect(prompt).toHaveText('Update failed');
    await expect(prompt).toHaveRole('button');
    // CAN-2799: the message is a rich hover tooltip, not a native title.
    await prompt.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'GitHub release request failed with HTTP 403.',
    );
    await window.mouse.move(0, 0);
    // Leaving the downloaded phase drops the schedule/cancel actions.
    await expect(scheduleAction).toHaveCount(0);
    await expect(cancelAction).toHaveCount(0);
    await screenshot('error');

    // A fresh check clears the transient error banner entirely.
    await emitUpdateEvent(electronApp, { type: 'checking' });
    await expect(prompt).toHaveCount(0);

    // The removed bottom-bar status pill must never come back — the sidebar
    // banner is the only update surface, including while downloading.
    await emitUpdateEvent(electronApp, {
      type: 'available',
      info: UPDATE_INFO,
    });
    await expect(prompt).toBeVisible();
    await emitUpdateEvent(electronApp, progressEvent(50));
    await expect(prompt).toContainText('Updating…');
    await expect(window.getByTestId('update-status-pill')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
