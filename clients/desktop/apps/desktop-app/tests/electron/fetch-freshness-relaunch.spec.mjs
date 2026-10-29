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

function hashOriginUrl(originUrl) {
  return createHash('sha256').update(originUrl).digest('hex');
}

function createOrigin(userDataDir, worktreePath, name) {
  const remotePath = path.join(userDataDir, `${name}.git`);
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  const hasOrigin = execFileSync('git', ['remote'], {
    cwd: worktreePath,
    encoding: 'utf8',
  })
    .split('\n')
    .includes('origin');
  execFileSync(
    'git',
    ['remote', hasOrigin ? 'set-url' : 'add', 'origin', remotePath],
    { cwd: worktreePath },
  );
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: remotePath,
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

test('automatic fetch freshness survives relaunch and invalidates when origin changes', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-fetch-freshness-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  const freshnessFilePath = path.join(userDataDir, 'git-fetch-freshness.json');
  const shimPath = writeLoggingGitShim({
    userDataDir,
    fileName: 'git-fetch-freshness-shim.sh',
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
  const originOne = createOrigin(userDataDir, worktreePath, 'origin-one');

  let activeApp = null;
  try {
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
    });
    expect(fetchCommands(commandLogPath).length).toBeGreaterThan(0);
    const firstEntries = JSON.parse(
      readFileSync(freshnessFilePath, 'utf8'),
    ).entries;
    expect(Object.values(firstEntries)).toEqual([
      expect.objectContaining({
        originHash: hashOriginUrl(originOne),
        prune: true,
      }),
    ]);
    expect(JSON.stringify(firstEntries)).not.toContain(originOne);
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

    const originTwo = createOrigin(userDataDir, worktreePath, 'origin-two');
    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
    });
    expect(fetchCommands(commandLogPath).length).toBeGreaterThan(0);
    const secondEntries = JSON.parse(
      readFileSync(freshnessFilePath, 'utf8'),
    ).entries;
    expect(Object.values(secondEntries)).toEqual([
      expect.objectContaining({
        originHash: hashOriginUrl(originTwo),
        prune: true,
      }),
    ]);
    expect(JSON.stringify(secondEntries)).not.toContain(originTwo);
  } finally {
    if (activeApp) {
      await closeCanopy(activeApp.electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});
