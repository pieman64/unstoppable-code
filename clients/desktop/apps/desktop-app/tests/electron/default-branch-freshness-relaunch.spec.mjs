import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function writeGatedLoggingGitShim(userDataDir) {
  const shimPath = path.join(userDataDir, 'git-default-branch-gated-shim.sh');
  writeFileSync(
    shimPath,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CANOPY_E2E_GIT_COMMAND_LOG"\nif [ "$1 $2 $3 $4" = "ls-remote --symref origin HEAD" ] && [ ! -f "$CANOPY_E2E_REMOTE_HEAD_GATE" ]; then\n  exit 1\nfi\nexec /usr/bin/git "$@"\n',
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function createCustomDefaultOrigin(userDataDir, worktreePath) {
  const remotePath = path.join(userDataDir, 'custom-default-origin.git');
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:trunk'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/trunk'], {
    cwd: remotePath,
  });
  execFileSync(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'],
    { cwd: worktreePath },
  );
  execFileSync(
    'git',
    ['update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD'],
    { cwd: worktreePath },
  );
  return remotePath;
}

function changeDefaultBranch(worktreePath, remotePath) {
  execFileSync('git', ['push', 'origin', 'HEAD:release'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/release'], {
    cwd: remotePath,
  });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/release', 'HEAD'], {
    cwd: worktreePath,
  });
  execFileSync(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'],
    { cwd: worktreePath },
  );
}

function createDevelopDefaultOriginWithStaleLocalHead(
  userDataDir,
  worktreePath,
) {
  const remotePath = path.join(userDataDir, 'develop-default-origin.git');
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['push', 'origin', 'HEAD:develop'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/develop'], {
    cwd: remotePath,
  });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/develop', 'HEAD'], {
    cwd: worktreePath,
  });
  execFileSync(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'],
    { cwd: worktreePath },
  );
  return remotePath;
}

function clearTrackedBaseBranch(userDataDir) {
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const config = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  config.worktrees = config.worktrees.map((worktree) => {
    if (worktree.id !== WORKTREE_ID) return worktree;
    const { trackedBaseBranch: _trackedBaseBranch, ...withoutTrackedBase } =
      worktree;
    return withoutTrackedBase;
  });
  writeFileSync(worktreesPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writePersistedDefaultBranch({
  freshnessFilePath,
  worktreePath,
  originUrl,
  defaultBranch,
}) {
  const commonDir = realpathSync(
    path.resolve(
      worktreePath,
      execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim(),
    ),
  );
  const key = createHash('sha256').update(commonDir).digest('hex');
  writeFileSync(
    freshnessFilePath,
    `${JSON.stringify(
      {
        version: 2,
        entries: {
          [key]: {
            commonDir,
            originHash: originHash(originUrl),
            defaultBranch,
            // Deliberately stale: local-only reads must still prefer this
            // remote-verified knowledge, while the later remote refresh must
            // revalidate and repair the local symbolic ref.
            resolvedAt: new Date(0).toISOString(),
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function refocusMainWindow(electronApp) {
  await electronApp.evaluate(async ({ app, BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Missing main window');
    const focusSink = new BrowserWindow({ show: false });
    await focusSink.loadURL('data:text/html,<title>Focus sink</title>');
    focusSink.showInactive();
    mainWindow.blur();
    app.focus({ steal: true });
    mainWindow.show();
    mainWindow.focus();
    focusSink.destroy();
  });
}

function expirePersistedFreshness(freshnessFilePath) {
  const freshness = JSON.parse(readFileSync(freshnessFilePath, 'utf8'));
  for (const entry of Object.values(freshness.entries)) {
    entry.resolvedAt = new Date(0).toISOString();
  }
  writeFileSync(
    freshnessFilePath,
    `${JSON.stringify(freshness, null, 2)}\n`,
    'utf8',
  );
}

function remoteHeadCommands(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((command) => command === 'ls-remote --symref origin HEAD');
}

async function launchAndRequestRemoteStats({
  userDataDir,
  commandLogPath,
  shimPath,
  expectedDefaultBranch,
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
    baseBranch: 'main',
    defaultBranch: expectedDefaultBranch,
  });
  await waitForGitLogToSettle(commandLogPath);
  return launched;
}

test('default-branch freshness survives relaunch, revalidates stale local HEAD, and recovers from corruption', async () => {
  // Four full launches; each still bounds its own shell wait at 30 s.
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-default-branch-freshness-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  const freshnessFilePath = path.join(
    userDataDir,
    'git-default-branch-freshness.json',
  );
  const shimPath = writeLoggingGitShim({
    userDataDir,
    fileName: 'git-default-branch-shim.sh',
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
  const remotePath = createCustomDefaultOrigin(userDataDir, worktreePath);

  let activeApp = null;
  try {
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
      expectedDefaultBranch: 'trunk',
    });
    expect(remoteHeadCommands(commandLogPath).length).toBeGreaterThan(0);
    const firstPersistedFreshness = readFileSync(freshnessFilePath, 'utf8');
    expect(firstPersistedFreshness).not.toContain(remotePath);
    const firstFreshnessEntries = Object.values(
      JSON.parse(firstPersistedFreshness).entries,
    );
    expect(firstFreshnessEntries).toEqual([
      expect.objectContaining({
        originHash: originHash(remotePath),
        defaultBranch: 'trunk',
      }),
    ]);
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = null;

    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
      expectedDefaultBranch: 'trunk',
    });
    expect(remoteHeadCommands(commandLogPath)).toEqual([]);
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = null;

    changeDefaultBranch(worktreePath, remotePath);
    expirePersistedFreshness(freshnessFilePath);
    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
      expectedDefaultBranch: 'release',
    });
    expect(remoteHeadCommands(commandLogPath).length).toBeGreaterThan(0);
    const changedPersistedFreshness = readFileSync(freshnessFilePath, 'utf8');
    expect(changedPersistedFreshness).not.toContain(remotePath);
    expect(
      Object.values(JSON.parse(changedPersistedFreshness).entries),
    ).toEqual([
      expect.objectContaining({
        originHash: originHash(remotePath),
        defaultBranch: 'release',
      }),
    ]);
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = null;

    execFileSync(
      'git',
      ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'],
      { cwd: worktreePath },
    );
    writeFileSync(freshnessFilePath, '{not-json', 'utf8');
    writeFileSync(commandLogPath, '');
    activeApp = await launchAndRequestRemoteStats({
      userDataDir,
      commandLogPath,
      shimPath,
      expectedDefaultBranch: 'release',
    });
    expect(remoteHeadCommands(commandLogPath).length).toBeGreaterThan(0);
    const repairedPersistedFreshness = readFileSync(freshnessFilePath, 'utf8');
    expect(repairedPersistedFreshness).not.toContain(remotePath);
    expect(
      Object.values(JSON.parse(repairedPersistedFreshness).entries),
    ).toEqual([
      expect.objectContaining({
        originHash: originHash(remotePath),
        defaultBranch: 'release',
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

test('stored develop stays visible across local-only and remote refreshes with stale origin HEAD', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-stale-origin-head-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  const remoteHeadGatePath = path.join(userDataDir, 'allow-remote-head');
  const freshnessFilePath = path.join(
    userDataDir,
    'git-default-branch-freshness.json',
  );
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
  const remotePath = createDevelopDefaultOriginWithStaleLocalHead(
    userDataDir,
    worktreePath,
  );
  clearTrackedBaseBranch(userDataDir);
  writePersistedDefaultBranch({
    freshnessFilePath,
    worktreePath,
    originUrl: remotePath,
    defaultBranch: 'develop',
  });

  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_E2E_REMOTE_HEAD_GATE: remoteHeadGatePath,
      CANOPY_GIT_EXECUTABLE: writeGatedLoggingGitShim(userDataDir),
    },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const prBar = window.getByTestId('pr-status-bar');
    await expect(prBar).toBeVisible();
    await expect(
      prBar.getByRole('button', { name: 'develop', exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    expect(
      execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim(),
    ).toBe('refs/remotes/origin/main');

    // Allow the verified remote lookup and trigger the same foreground global
    // refresh the renderer performs when its window regains focus.
    writeFileSync(remoteHeadGatePath, 'allow');
    writeFileSync(commandLogPath, '');
    await refocusMainWindow(launched.electronApp);
    await expect
      .poll(() => remoteHeadCommands(commandLogPath).length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await expect(
      prBar.getByRole('button', { name: 'develop', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
          cwd: worktreePath,
          encoding: 'utf8',
        }).trim(),
      )
      .toBe('refs/remotes/origin/develop');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
