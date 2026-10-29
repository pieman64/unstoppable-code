/**
 * Device-to-device remote access, end to end.
 *
 * Two real desktop instances (separate data roots) sign in to the same mock
 * account and connect to the real `apps/device-relay` service. The host
 * computer allows incoming control, the controller pairs with it (both show
 * the same code, the host approves), then opens the host in its own window.
 * That window must show the host's projects, run work on the host, and stream
 * the host's pushes back, all through the end-to-end encrypted relay.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  pairDevices,
  openRemoteWindow,
} from './helpers/remoteAccess.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';
import { setAllLabsFeatures as setEarlyAccess } from './helpers/earlyAccess.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const HOST_WORKSPACE_ID = 'demo-ts-pnpm-vite';
// Cloud sign-in needs OS secure storage. Electron cannot detect the Secret
// Service under every Linux desktop, so point it there explicitly; macOS and
// Windows ignore the switch.
const ELECTRON_ARGS =
  process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];
const HOST_WORKTREE_ID = 'demo-main';

function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
      },
    }),
    'utf8',
  );
}

function workspaceName(userDataDir, workspaceId) {
  const index = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces/index.json'), 'utf8'),
  );
  const items = Array.isArray(index.workspaces) ? index.workspaces : [];
  const entry = items.find((item) => item.id === workspaceId);
  if (!entry?.name) throw new Error(`Seeded workspace ${workspaceId} missing`);
  return entry.name;
}

async function openShell(electronApp) {
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.getByTestId('app-sidebar')).toBeVisible({
    timeout: 60_000,
  });
  return window;
}

async function remoteState(window, request = {}) {
  return window.evaluate(
    (options) => window.api.remoteControl.getState(options),
    request,
  );
}

test.describe('device-to-device remote access', () => {
  test.setTimeout(300_000);

  test('pairs two computers and controls one from the other', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_access_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-e2e-user',
        },
      },
    });

    const hostDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-remote-host-'));
    const controllerDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-remote-controller-'),
    );
    seedDemoWorkspaces({ userDataDir: hostDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(hostDir);
    seedPreferences(controllerDir);
    const hostProjectName = workspaceName(hostDir, HOST_WORKSPACE_ID);

    let host = null;
    let controller = null;
    try {
      host = await launchCanopy({
        userDataDir: hostDir,
        electronArgs: ELECTRON_ARGS,
      });
      controller = await launchCanopy({
        userDataDir: controllerDir,
        electronArgs: ELECTRON_ARGS,
      });
      const hostWindow = await openShell(host.electronApp);
      const controllerWindow = await openShell(controller.electronApp);
      await connectMockCloudAccount(hostWindow, apiKey);
      await connectMockCloudAccount(controllerWindow, apiKey);
      // Remote control is an early-access feature; signed in, the choice is
      // saved to the account.
      await setEarlyAccess(hostWindow, true);
      await setEarlyAccess(controllerWindow, true);

      // The controller does not have the host's project.
      await expect(
        controllerWindow.getByTestId('app-sidebar'),
      ).not.toContainText(hostProjectName);

      // Host: turn on incoming control in Settings → Remote access.
      const hostDriver = new CanopyAppDriver(hostWindow);
      await hostDriver.openSettings();
      await hostDriver.openSettingsSection('remote-access');
      await hostWindow
        .getByTestId('settings-remote-access-allow-incoming')
        .click();
      await expect
        .poll(async () => (await remoteState(hostWindow)).allowIncoming)
        .toBe(true);
      const hostDeviceId = (await remoteState(hostWindow)).thisDevice.deviceId;
      await hostWindow.keyboard.press('Escape');

      // A computer's own windows carry no machine picker, even with remote
      // access ready; it belongs to windows that show another computer.
      await expect(
        hostWindow.getByTestId('sidebar-account-footer'),
      ).toBeVisible();
      await expect(
        hostWindow.getByTestId('sidebar-machine-picker'),
      ).toHaveCount(0);
      await expect(
        controllerWindow.getByTestId('sidebar-machine-picker'),
      ).toHaveCount(0);

      // Controller: account menu → Computers → Add a computer → pick the host.
      await controllerWindow.getByTestId('sidebar-account-row').click();
      await expect(
        controllerWindow.getByTestId(
          'sidebar-account-menu-computer-option-local',
        ),
      ).toHaveAttribute('aria-checked', 'true');
      await controllerWindow
        .getByTestId('sidebar-account-menu-computer-add')
        .click();
      const pairDialog = controllerWindow.getByTestId(
        'remote-access-pair-dialog',
      );
      await expect(pairDialog).toBeVisible();
      const hostOption = controllerWindow.getByTestId(
        `remote-access-pair-option-${hostDeviceId}`,
      );
      await expect(hostOption).toBeVisible({ timeout: 30_000 });
      await hostOption.click();

      // Both computers show the same six-digit code; the host allows it.
      const controllerCode = controllerWindow.getByTestId(
        'remote-access-pair-code',
      );
      await expect(controllerCode).toBeVisible({ timeout: 30_000 });
      const hostPrompt = hostWindow.getByTestId(
        'remote-access-incoming-pairing',
      );
      await expect(hostPrompt).toBeVisible({ timeout: 30_000 });
      const digits = (text) => (text ?? '').replace(/\D/g, '');
      const shownCode = digits(await controllerCode.textContent());
      expect(shownCode).toMatch(/^\d{6}$/);
      expect(
        digits(
          await hostWindow
            .getByTestId('remote-access-incoming-pairing-code')
            .textContent(),
        ),
      ).toBe(shownCode);
      await hostWindow
        .getByTestId('remote-access-incoming-pairing-allow')
        .click();
      await expect(hostPrompt).toBeHidden();
      await expect(
        controllerWindow.getByTestId('remote-access-pair-approved'),
      ).toBeVisible({ timeout: 30_000 });
      const controllerState = await remoteState(controllerWindow);
      expect(controllerState.hosts.map((entry) => entry.deviceId)).toEqual([
        hostDeviceId,
      ]);
      await expect
        .poll(async () => (await remoteState(hostWindow)).controllers.length)
        .toBe(1);

      // Open the host straight from the pairing dialog: a new window.
      const remoteWindowPromise = controller.electronApp.waitForEvent('window');
      await controllerWindow.getByTestId('remote-access-pair-open').click();
      const remoteWindow = await remoteWindowPromise;
      await remoteWindow.waitForLoadState('domcontentloaded');
      expect(
        await remoteWindow.evaluate(() =>
          window.api.remoteControl.getContext(),
        ),
      ).toMatchObject({ mode: 'remote', deviceId: hostDeviceId });

      // The remote window renders the host's projects.
      await expect(remoteWindow.getByTestId('app-sidebar')).toBeVisible({
        timeout: 60_000,
      });
      await expect(remoteWindow.getByTestId('app-sidebar')).toContainText(
        hostProjectName,
        { timeout: 60_000 },
      );
      await expect
        .poll(
          async () =>
            (await remoteState(controllerWindow)).hosts[0]?.connection,
        )
        .toBe('connected');
      // The remote window's machine picker names the host, and the host shows
      // who is controlling it.
      await expect(
        remoteWindow.getByTestId('sidebar-machine-picker'),
      ).toContainText((await remoteState(hostWindow)).thisDevice.name);
      await expect(
        hostWindow.getByTestId('remote-access-controlled-notice'),
      ).toBeVisible({ timeout: 30_000 });
      // The host knows it is being controlled.
      await expect
        .poll(
          async () => (await remoteState(hostWindow)).controllers[0]?.connected,
        )
        .toBe(true);

      // Run work on the host from the remote window: a terminal command writes
      // a file in the host's worktree and its output streams back.
      const worktreePath = await hostWindow.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.getWorktreePath({ projectId, worktreeId }),
        { projectId: HOST_WORKSPACE_ID, worktreeId: HOST_WORKTREE_ID },
      );
      const proofFile = path.join(worktreePath, 'remote-access-proof.txt');
      const output = await remoteWindow.evaluate(
        async ({ projectId, worktreeId }) => {
          const decoder = new TextDecoder();
          let text = '';
          let terminalId = null;
          const done = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`No terminal output: ${text}`)),
              60_000,
            );
            window.api.terminal.onOutput((event) => {
              if (terminalId !== null && event.terminalId !== terminalId)
                return;
              text += decoder.decode(event.data);
              if (text.includes('REMOTE-ACCESS-DONE')) {
                clearTimeout(timer);
                resolve(text);
              }
            });
          });
          const spawned = await window.api.terminal.spawn({
            projectId,
            worktreeId,
            cols: 100,
            rows: 24,
            initialCommand:
              'echo remote-ok > remote-access-proof.txt && echo REMOTE-ACCESS-DONE',
          });
          terminalId = spawned.id;
          return done;
        },
        { projectId: HOST_WORKSPACE_ID, worktreeId: HOST_WORKTREE_ID },
      );
      expect(output).toContain('REMOTE-ACCESS-DONE');
      expect(existsSync(proofFile)).toBe(true);
      expect(readFileSync(proofFile, 'utf8').trim()).toBe('remote-ok');

      // Blocked surfaces fail closed instead of acting on the host's screen.
      await expect(
        remoteWindow.evaluate(() =>
          window.api.canopyPortal.start().then(
            () => 'resolved',
            (error) => String(error),
          ),
        ),
      ).resolves.toContain('not available while controlling another computer');

      // Revoking on the host (Settings → Remote access → Remove) cuts the
      // controller off.
      const controllerDeviceId = controllerState.thisDevice.deviceId;
      await hostDriver.openSettings();
      await hostDriver.openSettingsSection('remote-access');
      await hostWindow
        .getByTestId(
          `settings-remote-access-controller-remove-${controllerDeviceId}`,
        )
        .click();
      await hostWindow
        .getByTestId('settings-remote-access-remove-confirm')
        .click();
      await expect
        .poll(async () => (await remoteState(hostWindow)).controllers.length)
        .toBe(0);
      await expect
        .poll(
          async () =>
            (await remoteState(controllerWindow)).hosts[0]?.connection,
          { timeout: 30_000 },
        )
        .not.toBe('connected');
    } finally {
      if (controller) await closeCanopy(controller.electronApp, controllerDir);
      if (host) await closeCanopy(host.electronApp, hostDir);
      await relay.stop();
    }
  });
  for (const legacy of [false, true])
    test(
      legacy
        ? 'preserves a legacy remote layout without rewriting the host file'
        : 'creates a remote worktree without Browser recovery',
      async () => {
        const relay = await startDeviceRelay();
        const apiKey = `csk_remote_worktree_${randomUUID()}`;
        await registerScenario(undefined, apiKey, {
          cloud: {
            deviceRelay: {
              url: relay.url,
              secret: relay.secret,
              userId: 'remote-worktree-browser-user',
            },
          },
        });
        let host = null;
        let controller = null;
        try {
          // Pair through the existing helper; the preceding test covers pairing UI.
          host = await launchDesktop({
            label: 'worktree-host',
            demoApp: 'ts-pnpm-vite',
            apiKey,
            ...(legacy
              ? {
                  seed: (userDataDir) => {
                    const directory = path.join(
                      userDataDir,
                      'workspaces',
                      HOST_WORKSPACE_ID,
                      'worktree-data',
                      HOST_WORKTREE_ID,
                    );
                    mkdirSync(directory, { recursive: true });
                    writeFileSync(
                      path.join(directory, 'panel-layout-mode.json'),
                      JSON.stringify({ version: 1, mode: 'advanced' }),
                    );
                    writeFileSync(
                      path.join(directory, 'panel-layout.json'),
                      JSON.stringify({
                        version: 1,
                        grid: {
                          orientation: 0,
                          width: 1200,
                          height: 800,
                          root: {
                            type: 'leaf',
                            groupId: 'group-legacy-arrangement',
                            size: 800,
                            panels: [
                              {
                                panelId: 'panel-legacy-files',
                                kind: 'file-explorer',
                              },
                              {
                                panelId: 'panel-legacy-browser',
                                kind: 'browser',
                              },
                            ],
                            activePanelId: 'panel-legacy-files',
                          },
                        },
                        activeGroupId: 'group-legacy-arrangement',
                        mostRecentActiveGroupIds: ['group-legacy-arrangement'],
                      }),
                    );
                  },
                }
              : {}),
          });
          controller = await launchDesktop({
            label: 'worktree-controller',
            apiKey,
          });
          await pairDevices(controller, host);
          const { window: remoteWindow } = await openRemoteWindow(
            controller,
            host,
          );
          const hostProjectName = workspaceName(
            host.userDataDir,
            HOST_WORKSPACE_ID,
          );
          const remoteDriver = new CanopyAppDriver(remoteWindow);
          if (legacy) {
            const layoutPath = path.join(
              host.userDataDir,
              'workspaces',
              HOST_WORKSPACE_ID,
              'worktree-data',
              HOST_WORKTREE_ID,
              'panel-layout.json',
            );
            const original = readFileSync(layoutPath, 'utf8');
            await remoteDriver.selectWorktree(HOST_WORKTREE_ID);
            await expect(
              remoteWindow.getByTestId('panel-tab-panel-legacy-files'),
            ).toBeVisible();
            await expect(
              remoteWindow.getByTestId('panel-tab-panel-legacy-browser'),
            ).toHaveCount(0);
            await remoteWindow
              .getByTestId('panel-tab-panel-legacy-files')
              .click();
            await remoteWindow.reload();
            await remoteDriver.selectWorktree(HOST_WORKTREE_ID);
            await expect(
              remoteWindow.getByTestId('panel-tab-panel-legacy-files'),
            ).toBeVisible();
            expect(readFileSync(layoutPath, 'utf8')).toBe(original);
            return;
          }
          await remoteDriver.workspaceHeaderLabel(hostProjectName).hover();
          await remoteWindow
            .getByRole('button', {
              name: `Create worktree for ${hostProjectName}`,
            })
            .click();
          const newWorktree = remoteWindow.locator(
            `[data-testid="worktree-row"][data-project-id="${HOST_WORKSPACE_ID}"]:not([data-worktree-id="${HOST_WORKTREE_ID}"])`,
          );
          await expect(newWorktree).toBeVisible({ timeout: 30_000 });
          await expect(
            remoteWindow
              .locator('[data-testid="panel-content-chat"]:visible')
              .first(),
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            remoteWindow.getByTestId('panel-content-browser'),
          ).toHaveCount(0);
          await expect(
            remoteWindow.locator(
              '[data-testid^="panel-tab-"][data-panel-kind="browser"]',
            ),
          ).toHaveCount(0);
        } finally {
          if (controller)
            await closeCanopy(controller.electronApp, controller.userDataDir);
          if (host) await closeCanopy(host.electronApp, host.userDataDir);
          await relay.stop();
        }
      },
    );
});
