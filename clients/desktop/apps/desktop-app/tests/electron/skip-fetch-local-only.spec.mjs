import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  timeoutMessage: 'Git command log did not settle before the scoped request',
};

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

test('skipFetch returns local stats without running network-capable git commands', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-skip-fetch-local-'),
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
      CANOPY_GIT_EXECUTABLE: writeLoggingGitShim({ userDataDir }),
    },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Let the initial full refresh finish before scoping the command log to
    // the local-only request. Otherwise its intentionally remote-capable
    // discovery can overlap this assertion on slower launches.
    await waitForGitCommand(commandLogPath, 'ls-remote ');
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    writeFileSync(commandLogPath, '');

    const response = await window.evaluate(
      async ({ projectId, worktreeId }) =>
        window.api.getDiffStatsBatch({
          worktrees: [{ projectId, worktreeId }],
          skipFetch: true,
        }),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );

    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      hasOriginRemote: true,
    });
    expect(response[0].defaultBranch).toEqual(expect.any(String));

    const commands = readFileSync(commandLogPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(commands.some((command) => command.startsWith('fetch '))).toBe(
      false,
    );
    expect(commands.some((command) => command.startsWith('ls-remote '))).toBe(
      false,
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
