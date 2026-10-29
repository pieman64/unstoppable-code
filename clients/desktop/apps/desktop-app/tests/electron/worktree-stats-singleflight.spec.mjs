import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  waitForGitLogToSettle,
  writeLoggingGitShim,
} from './seeders/gitCommandLog.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

const GIT_LOG_SETTLE_OPTIONS = {
  timeoutMessage: 'Git command log did not settle before the scoped requests',
};

function rendererGlobalStatusCommands(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) =>
      line.startsWith('renderer-global-poll|status --porcelain'),
    );
}

async function waitForGitCommand(logPath, commandPrefix) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const commands = readFileSync(logPath, 'utf8').split('\n');
    if (commands.some((command) => command.startsWith(commandPrefix))) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for startup Git command: ${commandPrefix}`,
  );
}

function attachLocalOrigin(userDataDir, worktreePath) {
  const remotePath = path.join(userDataDir, 'origin.git');
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: remotePath,
  });
}

async function createFocusSink(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Missing main window');
    mainWindow.show();
    mainWindow.focus();

    const focusSink = new BrowserWindow({
      width: 240,
      height: 160,
      show: false,
    });
    await focusSink.loadURL('data:text/html,<title>Focus sink</title>');
    return { mainWindowId: mainWindow.id, focusSinkId: focusSink.id };
  });
}

async function focusWindow(electronApp, windowId, previousWindowId) {
  await electronApp.evaluate(
    ({ app, BrowserWindow }, ids) => {
      const target = BrowserWindow.fromId(ids.windowId);
      if (!target) throw new Error(`Missing BrowserWindow ${ids.windowId}`);
      app.focus({ steal: true });
      target.show();
      BrowserWindow.fromId(ids.previousWindowId)?.blur();
      target.focus();
    },
    { windowId, previousWindowId },
  );
}

test('full and diff-only requests reuse their single-flight Git stats', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-stats-singleflight-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  writeFileSync(commandLogPath, '');
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seed.workspaces.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) {
    throw new Error(`Missing seeded worktree for ${WORKSPACE_ID}`);
  }
  attachLocalOrigin(userDataDir, worktreePath);

  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: writeLoggingGitShim({
        userDataDir,
        fileName: 'git-singleflight-shim.sh',
        statusDelaySeconds: 1,
      }),
    },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await waitForGitCommand(commandLogPath, 'ls-remote ');
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    writeFileSync(commandLogPath, '');

    const responses = await window.evaluate(
      async ({ projectId, worktreeId }) => {
        const request = {
          worktrees: [{ projectId, worktreeId }],
          skipFetch: true,
        };
        return Promise.all([
          window.api.getDiffStatsBatch(request),
          window.api.getDiffStatsBatch(request),
        ]);
      },
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0][0]).toMatchObject({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      hasOriginRemote: true,
    });

    const commands = readFileSync(commandLogPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const statusCommands = commands.filter((command) =>
      command.startsWith('status --porcelain'),
    );
    expect(statusCommands).toHaveLength(1);

    writeFileSync(commandLogPath, '');
    const lightweightResponses = await window.evaluate(
      async ({ projectId, worktreeId }) => {
        const request = {
          worktrees: [{ projectId, worktreeId, mode: 'diff_only' }],
          source: 'renderer-global-poll',
        };
        return Promise.all([
          window.api.getDiffStatsBatch(request),
          window.api.getDiffStatsBatch(request),
        ]);
      },
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );

    expect(lightweightResponses[0]).toEqual(lightweightResponses[1]);
    expect(lightweightResponses[0][0]).toEqual({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      insertions: responses[0][0].insertions,
      deletions: responses[0][0].deletions,
      mode: 'diff_only',
    });
    expect(readFileSync(commandLogPath, 'utf8')).toBe('');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('sidebar polling pauses while visibly unfocused and refreshes once on focus', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-stats-focus-polling-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  writeFileSync(commandLogPath, '');
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seed.workspaces.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) {
    throw new Error(`Missing seeded worktree for ${WORKSPACE_ID}`);
  }
  attachLocalOrigin(userDataDir, worktreePath);

  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: writeLoggingGitShim({
        userDataDir,
        fileName: 'git-focus-polling-shim.sh',
        attribution: 'source',
      }),
    },
  });

  let focusSinkId;
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    const focusWindows = await createFocusSink(launched.electronApp);
    focusSinkId = focusWindows.focusSinkId;

    await app.waitForShell({ timeout: 30_000 });
    await app.selectWorktree(WORKTREE_ID);
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);

    // Make the selected worktree due on the next scheduler tick without
    // turning this into a 30-second cadence test. Browser timers still use
    // real elapsed time; only the scheduler's due-time comparison advances.
    await window.evaluate(() => {
      const realDateNow = Date.now.bind(Date);
      Date.now = () => realDateNow() + 31_000;
    });
    await focusWindow(
      launched.electronApp,
      focusSinkId,
      focusWindows.mainWindowId,
    );
    await expect
      .poll(() =>
        launched.electronApp.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
          focusWindows.mainWindowId,
        ),
      )
      .toBe(false);
    // Electron's offscreen E2E renderer does not propagate the native blur to
    // the DOM, so bridge that harness-only gap after proving native focus was
    // actually transferred. The production listener, timer, scheduler, IPC,
    // and Git path remain unmocked.
    await window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect
      .poll(() => window.evaluate(() => document.visibilityState))
      .toBe('visible');

    writeFileSync(commandLogPath, '');
    await delay(11_000);
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    expect(rendererGlobalStatusCommands(commandLogPath)).toEqual([]);

    writeFileSync(commandLogPath, '');
    await focusWindow(
      launched.electronApp,
      focusWindows.mainWindowId,
      focusSinkId,
    );
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect
      .poll(() => rendererGlobalStatusCommands(commandLogPath).length, {
        timeout: 15_000,
      })
      .toBe(1);
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    expect(rendererGlobalStatusCommands(commandLogPath)).toHaveLength(1);
  } finally {
    if (focusSinkId != null) {
      await launched.electronApp.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id)?.destroy();
      }, focusSinkId);
    }
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
