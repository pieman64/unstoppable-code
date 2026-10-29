import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/index.mjs';

// The renderer uses its real preload/IPC and marketplace cache. Only the
// external clone is replaced with a controllable completion, avoiding network.
export async function openPendingPluginInstall({ leaveDetails = true } = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'plugin-install-'));
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const plugin = JSON.parse(
    readFileSync(cacheFilePath, 'utf8'),
  ).marketplaces[0].plugins.find((entry) => entry.name === 'alpha-tool');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ ipcMain }, entry) => {
      globalThis.__pluginInstallCompletionFixture = { calls: 0 };
      ipcMain.removeHandler('plugins:install-plugin');
      ipcMain.handle('plugins:install-plugin', () => {
        const state = globalThis.__pluginInstallCompletionFixture;
        state.calls += 1;
        return new Promise((resolve) => {
          state.complete = () =>
            resolve({
              success: true,
              data: {
                ...entry,
                cachePath: '/tmp/alpha-tool',
                details: {
                  skills: [],
                  agents: [],
                  commands: [],
                  hooks: [],
                  mcpServers: [],
                  lspServers: [],
                  hasReadme: false,
                },
              },
            });
        });
      });
    }, plugin);
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1280, height: 900 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('alpha-tool');
    await window
      .getByTestId('plugins-entry-add-mkt:demo/market/alpha-tool')
      .click();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-current'),
    ).toHaveText('Alpha Tool');
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__pluginInstallCompletionFixture.calls,
        ),
      )
      .toBe(1);
    if (leaveDetails) {
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(window.getByTestId('plugins-search')).toBeVisible();
    }
    return { electronApp, window, userDataDir };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}

export async function completePendingPluginInstall(electronApp) {
  await electronApp.evaluate(() => {
    const state = globalThis.__pluginInstallCompletionFixture;
    if (!state.complete) throw new Error('No pending installation');
    state.complete();
  });
}
