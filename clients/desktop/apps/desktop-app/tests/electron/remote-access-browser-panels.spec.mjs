/**
 * Browser panels in a window that shows another computer.
 *
 * The in-app browser is a native view on the computer the user sits at, so
 * every Browser channel is blocked while controlling another computer. Script
 * output still streams to that window, and a script whose dev-server pattern
 * auto-opens used to place a Browser tab there: the tab could never load, and
 * because panel layouts tunnel it was also saved into the other computer's
 * layout.
 *
 * Two real desktops pair through the real `apps/device-relay` service. The
 * host runs a project script that prints an auto-open URL. The host's own
 * window still opens the Browser tab; the controller's window for the host
 * gets none, and saves none into the host's layout file.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
} from './helpers/remoteAccess.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { getLayout, waitForPanelLayout } from './panelHarness.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const PROJECT_ID = 'remote-browser-project';
const PROJECT_NAME = 'Remote browser project';
const WORKTREE_ID = 'wt-mocks';
const DEV_SERVER_URL = 'http://localhost:5199/';
const PATTERN = 'https?://localhost:\\d+\\S*';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Seeds a project whose `launch` script prints a dev-server URL that its
 * pattern auto-opens in the in-app browser (like the repository's UI Mocks
 * script). The repository lives in `fixtureDir`, outside the data root.
 */
function seedAutoOpenProject(userDataDir, fixtureDir) {
  const repoPath = path.join(fixtureDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  const git = (args) =>
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeJson(path.join(repoPath, 'canopy.json'), {
    version: 1,
    scripts: {
      launch: {
        command: `echo "Mocks ready at ${DEV_SERVER_URL}"`,
        devServerPattern: { pattern: PATTERN, autoOpen: true },
      },
    },
  });
  git(['add', 'canopy.json']);
  git(['commit', '-m', 'Fixture']);
  const projectDir = path.join(userDataDir, 'workspaces', PROJECT_ID);
  const worktreePath = path.join(projectDir, 'worktrees', WORKTREE_ID);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', WORKTREE_ID, worktreePath]);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: PROJECT_ID,
        name: PROJECT_NAME,
        type: 'single-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(projectDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(projectDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: WORKTREE_ID,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });
}

/** Every Browser panel's bound browser id anywhere in a layout object. */
function browserIdsIn(value) {
  const ids = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (node.kind === 'browser') {
      ids.push(node.instance?.browserId ?? null);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return ids;
}

async function layoutBrowserIds(window) {
  return browserIdsIn(await getLayout(window));
}

function savedLayout(userDataDir) {
  const file = path.join(
    userDataDir,
    'workspaces',
    PROJECT_ID,
    'worktree-data',
    WORKTREE_ID,
    'panel-layout.json',
  );
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test.describe('Browser panels in a window that shows another computer', () => {
  test.setTimeout(300_000);

  test('an auto-opening dev server opens no Browser tab in the remote window', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_browser_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-browser-panels-e2e-user',
        },
      },
    });
    const fixtureDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-remote-browser-repo-'),
    );
    let host = null;
    let controller = null;
    try {
      host = await launchDesktop({
        label: 'browser-host',
        apiKey,
        seed: (userDataDir) => seedAutoOpenProject(userDataDir, fixtureDir),
      });
      controller = await launchDesktop({
        label: 'browser-controller',
        apiKey,
      });
      await pairDevices(controller, host);
      const { window: remoteWindow } = await openRemoteWindow(controller, host);
      expect(
        await remoteWindow.evaluate(() =>
          window.api.remoteControl.getContext(),
        ),
      ).toMatchObject({ mode: 'remote', deviceId: host.deviceId });
      await expect(remoteWindow.getByTestId('app-sidebar')).toContainText(
        PROJECT_NAME,
        { timeout: 60_000 },
      );

      // Both windows show the worktree, so each has its panel layout loaded.
      const hostDriver = new CanopyAppDriver(host.window);
      await hostDriver.openMainPage();
      await hostDriver.selectWorktree(WORKTREE_ID);
      await waitForPanelLayout(host.window);
      const remoteDriver = new CanopyAppDriver(remoteWindow);
      await remoteDriver.openMainPage();
      await remoteDriver.selectWorktree(WORKTREE_ID);
      await waitForPanelLayout(remoteWindow);
      expect(await layoutBrowserIds(host.window)).toEqual([]);
      expect(await layoutBrowserIds(remoteWindow)).toEqual([]);

      // Record the script output the remote window receives, to know the
      // auto-open had its chance there.
      await remoteWindow.evaluate((url) => {
        window.__remoteDevServerOutputSeen = false;
        window.api.onScriptOutput((event) => {
          if (event.lines.some((line) => line.includes(url))) {
            window.__remoteDevServerOutputSeen = true;
          }
        });
      }, DEV_SERVER_URL);

      // The host runs the script, as any worktree on it might.
      const result = await host.window.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.runScript({
            target: 'project',
            scriptName: 'launch',
            projectId,
            worktreeId,
          }),
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      );
      expect(result.success).toBe(true);

      // A window that shows its own computer still auto-opens the tab.
      await expect
        .poll(async () => (await layoutBrowserIds(host.window)).length, {
          timeout: 30_000,
        })
        .toBe(1);
      const hostBrowserIds = await layoutBrowserIds(host.window);

      await expect
        .poll(
          () => remoteWindow.evaluate(() => window.__remoteDevServerOutputSeen),
          { timeout: 30_000 },
        )
        .toBe(true);
      // Auto-open prepares the layout asynchronously; give a stray placement
      // the time it would take to land before asserting it never did.
      await remoteWindow.waitForTimeout(3_000);
      // Soft, so a stray tab is also checked against the host's saved layout.
      expect.soft(await layoutBrowserIds(remoteWindow)).toEqual([]);
      await expect
        .soft(remoteWindow.locator('[data-panel-kind="browser"]'))
        .toHaveCount(0);

      // A layout change in the remote window saves its layout into the host's
      // file; that save carries no Browser tab of its own.
      const remoteLayout = await getLayout(remoteWindow);
      const groupId = await remoteWindow.evaluate(
        () => window.__canopyPanelTestApi?.getActiveGroupId() ?? null,
      );
      expect(groupId).not.toBeNull();
      const newGroupId = await remoteWindow.evaluate(
        (id) => window.__canopyPanelTestApi.splitPanel(id, 'right'),
        groupId,
      );
      expect(JSON.stringify(remoteLayout)).not.toContain(newGroupId);
      let saved = null;
      await expect
        .poll(
          () => {
            saved = savedLayout(host.userDataDir);
            return JSON.stringify(saved ?? null).includes(newGroupId);
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const foreign = browserIdsIn(saved).filter(
        (id) => !hostBrowserIds.includes(id),
      );
      expect(foreign).toEqual([]);
    } finally {
      if (controller)
        await closeCanopy(controller.electronApp, controller.userDataDir);
      if (host) await closeCanopy(host.electronApp, host.userDataDir);
      await relay.stop();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
