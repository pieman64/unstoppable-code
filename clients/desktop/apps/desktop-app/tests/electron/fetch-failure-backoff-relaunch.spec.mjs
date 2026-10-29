import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function originHash(originUrl) {
  return createHash('sha256').update(originUrl).digest('hex');
}

function configureOfflineOrigin(userDataDir, worktreePath) {
  const remotePath = path.join(userDataDir, 'offline-origin.git');
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  return remotePath;
}

function fetchCommands(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((command) => command.startsWith('fetch --prune origin'));
}

async function launchAndRequestRemoteStats({
  userDataDir,
  commandLogPath,
  shimPath,
}) {
  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: shimPath,
    },
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  const response = await window.evaluate(
    async ({ projectId, worktreeId }) =>
      window.api.getDiffStatsBatch({
        worktrees: [{ projectId, worktreeId }],
        skipFetch: false,
      }),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  expect(response[0]).toMatchObject({
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    hasOriginRemote: true,
  });
  await waitForGitLogToSettle(commandLogPath);
  return launched;
}

test('automatic failed-fetch backoff survives relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-fetch-backoff-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  const freshnessFilePath = path.join(userDataDir, 'git-fetch-freshness.json');
  const shimPath = writeLoggingGitShim({
    userDataDir,
    fileName: 'git-fetch-backoff-shim.sh',
  });
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
  const offlineOrigin = configureOfflineOrigin(userDataDir, worktreePath);

  let activeApp = null;
  try {
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
    });
    expect(fetchCommands(commandLogPath).length).toBeGreaterThan(0);
    const firstFailureFreshness = readFileSync(freshnessFilePath, 'utf8');
    expect(firstFailureFreshness).not.toContain(offlineOrigin);
    const firstFailureEntries = Object.values(
      JSON.parse(firstFailureFreshness).entries,
    );
    expect(firstFailureEntries).toEqual([
      expect.objectContaining({
        originHash: originHash(offlineOrigin),
        prune: true,
        consecutiveFailures: 1,
      }),
    ]);
    expect(Date.parse(firstFailureEntries[0].retryAfterAt)).toBeGreaterThan(
      Date.parse(firstFailureEntries[0].lastFailureAt),
    );
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = null;

    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
    });
    expect(fetchCommands(commandLogPath)).toEqual([]);
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = null;

    const expiredFile = JSON.parse(readFileSync(freshnessFilePath, 'utf8'));
    const [entryKey] = Object.keys(expiredFile.entries);
    expiredFile.entries[entryKey].retryAfterAt = new Date(0).toISOString();
    writeFileSync(
      freshnessFilePath,
      `${JSON.stringify(expiredFile, null, 2)}\n`,
    );
    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
    });
    expect(fetchCommands(commandLogPath).length).toBeGreaterThan(0);
    const secondFailureFreshness = readFileSync(freshnessFilePath, 'utf8');
    expect(secondFailureFreshness).not.toContain(offlineOrigin);
    expect(Object.values(JSON.parse(secondFailureFreshness).entries)).toEqual([
      expect.objectContaining({
        originHash: originHash(offlineOrigin),
        consecutiveFailures: 2,
      }),
    ]);
  } finally {
    if (activeApp) {
      await closeCanopy(activeApp.electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});
