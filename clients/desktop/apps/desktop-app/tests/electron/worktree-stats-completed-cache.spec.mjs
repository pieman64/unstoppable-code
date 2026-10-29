import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const BRANCH_CHANGED_FILE = 'branch-refresh-marker.txt';

const GIT_LOG_SETTLE_OPTIONS = {
  maxAttempts: 60,
  timeoutMessage: 'Git command log did not settle before the scoped requests',
};

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

function readCommands(logPath) {
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
}

function statusCommands(logPath) {
  return readCommands(logPath).filter((command) =>
    command.startsWith('status --porcelain'),
  );
}

async function waitForStatusCommandCount(logPath, expectedCount) {
  await expect
    .poll(() => statusCommands(logPath), { timeout: 15_000 })
    .toHaveLength(expectedCount);
  await waitForGitLogToSettle(logPath, GIT_LOG_SETTLE_OPTIONS);
}

test('completed stats can be shared across surfaces without crossing freshness modes or branch changes', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-stats-completed-cache-'),
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
  execFileSync('git', ['switch', '-c', 'perf-cache-invalidation'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  writeFileSync(
    path.join(worktreePath, BRANCH_CHANGED_FILE),
    'visible only after the branch switch\n',
  );
  execFileSync('git', ['add', BRANCH_CHANGED_FILE], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'Add branch refresh marker'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['switch', 'demo-main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });

  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: writeLoggingGitShim({
        userDataDir,
        fileName: 'git-completed-cache-shim.sh',
      }),
    },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    writeFileSync(commandLogPath, '');

    const localResults = await window.evaluate(
      async ({ workspaceId, worktreeId }) => {
        const batch = await window.api.getDiffStatsBatch({
          worktrees: [{ projectId: workspaceId, worktreeId }],
          skipFetch: true,
        });
        const snapshot = await window.api.getDesktopSessionSnapshot({
          workspaceLocalId: workspaceId,
          worktreeLocalId: worktreeId,
        });
        return { batch: batch[0], snapshot: snapshot.worktrees[0] };
      },
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );

    expect(localResults.batch).toMatchObject({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      branchName: 'demo-main',
    });
    expect(localResults.snapshot).toMatchObject({
      localId: WORKTREE_ID,
      branch: 'demo-main',
    });
    // The targeted renderer refresh populates the main-owned result and the
    // immediately following session projection reuses it.
    expect(statusCommands(commandLogPath)).toHaveLength(1);

    // Select the worktree so its changed-files list is loaded into the
    // renderer activity cache. A later branch change must prioritize both
    // this visible list and the sidebar/session stats.
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    await expect
      .poll(() => statusCommands(commandLogPath).length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);

    writeFileSync(commandLogPath, '');
    await window.evaluate(() => {
      window.__canopyStatsBranchChanged = new Promise((resolve) => {
        const unsubscribe = window.api.onWorktreeBranchChanged((event) => {
          if (
            event.projectId === 'demo-ts-pnpm-vite' &&
            event.worktreeId === 'demo-main'
          ) {
            unsubscribe();
            resolve(event);
          }
        });
      });
    });
    execFileSync('git', ['switch', 'perf-cache-invalidation'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    await window.evaluate(() => window.__canopyStatsBranchChanged);

    const afterBranchChange = await window.evaluate(
      ({ workspaceId, worktreeId }) =>
        window.api.getDesktopSessionSnapshot({
          workspaceLocalId: workspaceId,
          worktreeLocalId: worktreeId,
        }),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(afterBranchChange.worktrees[0]).toMatchObject({
      localId: WORKTREE_ID,
      branch: 'perf-cache-invalidation',
    });
    // Branch invalidation schedules one targeted stats refresh plus one
    // changed-files refresh because the selected worktree's list is loaded.
    // The main process can share their completed status result, so validate
    // the visible comparison itself instead of expecting duplicate Git work.
    await expect
      .poll(
        async () => window.getByTestId('changed-files-section').innerText(),
        { timeout: 15_000 },
      )
      .toContain(BRANCH_CHANGED_FILE);
    await waitForStatusCommandCount(commandLogPath, 1);
    expect(statusCommands(commandLogPath)).toHaveLength(1);

    writeFileSync(commandLogPath, '');
    await window.evaluate(
      ({ workspaceId, worktreeId }) =>
        window.api.getDiffStatsBatch({
          worktrees: [{ projectId: workspaceId, worktreeId }],
        }),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    // A prior local-only/session result must not satisfy a remote-capable
    // request, even while that completed value is recent.
    expect(statusCommands(commandLogPath)).toHaveLength(1);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
