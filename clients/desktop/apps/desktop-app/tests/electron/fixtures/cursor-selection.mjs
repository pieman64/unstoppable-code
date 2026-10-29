import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';
import { launchCanopy, closeCanopy } from '../launchCanopy.mjs';
import { cursorRuntimeFixture } from './cursor-runtime.mjs';
import { expectCursorConnected } from './cursor-tile.mjs';

export async function launchCursorSelectionFixture({
  billing = false,
  opaqueModel = false,
  notices = false,
  sharedModel = false,
  sharedClaudeModel = false,
  gatewayModel = false,
  rawModelLabels = false,
  abruptClose = false,
  approvalMode,
  planMode,
  runtimeEnv = {},
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-selection-'));
  if (gatewayModel) {
    const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, 'ai-gateway-v1.json'),
      JSON.stringify({
        cacheVersion: 8,
        serverOrigin: 'http://127.0.0.1:4011',
        brandApiNamespace: 'desktop-app',
        fetchedAt: new Date().toISOString(),
        catalog: {
          version: 8,
          models: [
            {
              id: 'e2e-kimi',
              gatewayId: 'moonshotai/kimi-k3',
              cursorModelId: 'kimi-k3',
              label: 'Kimi K3',
              family: 'moonshot',
              familyLabel: 'Moonshot AI',
              recommendedHarness: 'codex',
              contextWindow: 200_000,
              supportsPromptCaching: false,
              requiresLocalHarnessSupport: false,
              showMoreOnly: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      }),
    );
  }
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const target = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'cursor-selection',
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    providerType: notices ? 'cursor' : 'claude',
    tabs: [
      {
        id: target.chatId,
        title: 'Cursor selection boundary',
        model: notices ? 'cursor-default' : 'sonnet',
        ...(approvalMode ? { approvalMode } : {}),
        ...(planMode !== undefined ? { planMode } : {}),
        ...(notices ? { sdkSessionId: 'missing-fixture-session' } : {}),
        ...(billing
          ? {
              aiCreditsRouting: {
                active: true,
                scope: 'persistent',
                activatedAt: 1789000000000,
              },
              subscriptionBillingOverride: true,
              billingExplicitlyChosen: true,
            }
          : {}),
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const discoveryResultFile = path.join(userDataDir, 'cursor-discovery-result');
  const launchOptions = {
    userDataDir,
    env: {
      ...managed.env,
      ...runtimeEnv,
      CANOPY_E2E_CURSOR_DISCOVERY_RESULT_FILE: discoveryResultFile,
      ...(notices ? { CANOPY_E2E_CURSOR_NO_HTTP: '1' } : {}),
      ...(opaqueModel ? { CANOPY_E2E_CURSOR_OPAQUE_MODEL: '1' } : {}),
      ...(sharedModel ? { CANOPY_E2E_CURSOR_SHARED_MODEL: '1' } : {}),
      ...(sharedClaudeModel
        ? { CANOPY_E2E_CURSOR_SHARED_CLAUDE_MODEL: '1' }
        : {}),
      ...(gatewayModel ? { CANOPY_E2E_CURSOR_GATEWAY_MODEL: '1' } : {}),
      ...(rawModelLabels ? { CANOPY_E2E_CURSOR_RAW_MODEL_LABELS: '1' } : {}),
    },
  };
  let launched = await launchCanopy(launchOptions);
  let window = await launched.electronApp.firstWindow();
  let driver = new CanopyAppDriver(window);
  const closeApplication = async (keepUserData = false) => {
    // Persistence tests can explicitly simulate a process exit without relying
    // on the unrelated graceful-shutdown lifecycle of the seeded app.
    if (abruptClose) await launched.killAbruptly();
    await closeCanopy(launched.electronApp, userDataDir, { keepUserData });
  };
  const close = async () => {
    await closeApplication();
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  };
  try {
    await driver.waitForShell();
  } catch (error) {
    await close();
    throw error;
  }
  const connection = async (enabled) => {
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    if (enabled) {
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
    } else {
      // The tile offers no Disconnect; disconnecting is an App Advisor
      // operation. Send it the way App Advisor does so it runs through the
      // mounted panel's own disconnect handler and IPC. Callers must be
      // connected: the panel registers that handler once its status loads and
      // disconnects only an idle, connected runtime, which the settled tile
      // proves. The main process keeps its own response handler, so a refused
      // request surfaces as the "Connect Cursor" timeout below.
      await expectCursorConnected(window);
      await launched.electronApp.evaluate(
        ({ BrowserWindow }, payload) => {
          const owner = BrowserWindow.getAllWindows().find(
            (w) => !w.webContents.getURL().includes('surface=app-advisor'),
          );
          if (!owner) throw new Error('Main window missing');
          owner.webContents.send('app-advisor:tool-request', payload);
        },
        {
          kind: 'dispatch_action',
          requestId: `cursor-selection-disconnect-${Date.now()}`,
          action: { type: 'cursor.connection', operation: 'disconnect' },
        },
      );
      await expect(window.getByTestId('cursor-connect')).toHaveText(
        'Connect Cursor',
      );
    }
    await driver.closeSettings();
  };
  const openChat = async () => {
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
  };
  const tab = async () =>
    (
      await window.evaluate(
        (target) => window.api.chat.loadTabs(target),
        target,
      )
    ).tabs.find((tab) => tab.id === target.chatId);
  return {
    get electronApp() {
      return launched.electronApp;
    },
    get window() {
      return window;
    },
    get driver() {
      return driver;
    },
    async restart(env = {}) {
      await closeApplication(true);
      launched = await launchCanopy({
        ...launchOptions,
        env: { ...launchOptions.env, ...env },
      });
      window = await launched.electronApp.firstWindow();
      driver = new CanopyAppDriver(window);
      await driver.waitForShell();
    },
    target,
    userDataDir,
    worktreePath: seeded.workspaces[0].worktreePath,
    async setDiscoveryResult(result) {
      if (result === 'empty') {
        await launched.electronApp.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler('cursor-connection:models');
          ipcMain.handle('cursor-connection:models', () => []);
        });
        return;
      }
      writeFileSync(discoveryResultFile, result);
    },
    connection,
    openChat,
    tab,
    close,
  };
}

/** Warm Home's catalog, then hold the next discovery in a newly mounted chat. */
export async function openCursorPickerDuringRefresh(f) {
  await f.connection(true);
  await f.window.getByTestId('sidebar-create-task').click();
  const home = f.window.getByTestId('page-home');
  await home.getByTestId('home-branch-picker-button').click();
  await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
  await home.getByTestId('chat-model-picker').click();
  const group = f.window.getByRole('group', { name: 'Cursor', exact: true });
  // Third-party models retain their maker's section; Default is Cursor's own.
  await expect(group.getByRole('menuitemradio')).toHaveCount(1);
  await f.window.keyboard.press('Escape');
  // Hold only catalog refreshes; connection setup and the seeded runtime stay real.
  await f.electronApp.evaluate(({ ipcMain }) => {
    globalThis.cursorCacheRefreshes = 0;
    ipcMain.removeHandler('cursor-connection:models');
    ipcMain.handle('cursor-connection:models', async () => {
      globalThis.cursorCacheRefreshes += 1;
      await new Promise((resolve) =>
        ipcMain.once('cursor-cache:release', resolve),
      );
      throw new Error('Fixture catalog refresh unavailable');
    });
  });
  await f.openChat();
  await expect(home).toHaveCount(0);
  await f.window
    .getByTestId('panel-content-chat')
    .getByTestId('chat-model-picker')
    .click();
  await expect
    .poll(() => f.electronApp.evaluate(() => globalThis.cursorCacheRefreshes))
    .toBe(1);
  return {
    group,
    release: () =>
      f.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.emit('cursor-cache:release');
      }),
  };
}
