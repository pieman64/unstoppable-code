import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { buildPrStatusData, injectGithubPrStatus } from './seeders/index.mjs';
import { writeLoggingGitShim } from './seeders/gitCommandLog.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const GIT_IDENTITY = [
  '-c',
  'user.name=E2E',
  '-c',
  'user.email=e2e@example.test',
];

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * A seeded worktree tracking a file-path origin. `prepare` runs while the
 * origin is still online; the origin then goes offline, so every fetch, pull
 * and push the app runs fails.
 */
function seedOfflineOrigin(userDataDir, prepare) {
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seed.workspaces.find((entry) => entry.id === WORKSPACE_ID);
  expect(workspace, 'seeded workspace').toBeTruthy();
  const { repoPath, worktreePath } = workspace;
  const branch = git(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const origin = path.join(userDataDir, 'origin.git');
  git(['init', '--bare', origin]);
  git(['-C', repoPath, 'remote', 'add', 'origin', origin]);
  git(['-C', worktreePath, 'push', '-u', 'origin', 'HEAD']);
  prepare?.({ origin, branch, worktreePath });
  renameSync(origin, path.join(userDataDir, 'origin-offline.git'));
  return { branch, worktreePath };
}

/**
 * Launches with a logging Git shim and selects the worktree, its header pinned
 * to an open PR so live PR polling cannot replace the branch-sync action.
 */
async function openWorktree({ userDataDir, branch, commandLogPath }) {
  const shimPath = writeLoggingGitShim({
    userDataDir,
    fileName: 'offline-origin-git.sh',
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: shimPath,
    },
  });
  await electronApp.evaluate(({ ipcMain }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    // Deterministic GitHub metadata, rather than treating any origin as GitHub.
    replace('github:get-repo-slug', () => ({ owner: 'acme', repo: 'app' }));
    // Commit straight away, without the commit-message review step.
    const load = ipcMain._invokeHandlers.get('preferences:load');
    replace('preferences:load', async (event, request) => ({
      ...(await load(event, request)),
      reviewCommitMessage: false,
    }));
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await electronApp.evaluate(
    ({ ipcMain }, target) => {
      if (
        ipcMain.emit('github:e2e-suspend-pr-status-tracking', {}, target) !==
        true
      )
        throw new Error('Failed to suspend PR-status tracking');
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  await injectGithubPrStatus(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    status: {
      lastCheckedAt: new Date().toISOString(),
      repos: [
        {
          repoId: '__single_repo__',
          repoName: 'app',
          prLookupAvailable: true,
          status: buildPrStatusData({ prNumber: 4108, headBranch: branch }),
        },
      ],
    },
  });
  return { electronApp, window };
}

function loggedCommands(commandLogPath) {
  return readFileSync(commandLogPath, 'utf8').split('\n');
}

/** Logged argv whose Git subcommand, after any `-c`/`-C` options, is one of `names`. */
function subcommands(commands, names) {
  const pattern = new RegExp(
    `^(?:-[cC] \\S+ )*(?:${names.join('|')})(?:\\s|$)`,
  );
  return commands.filter((command) => pattern.test(command));
}

/**
 * CAN-4108 PR0: Pull's preflight fetch must surface its failure. The worktree
 * is behind its origin, so the header offers Pull, and then the origin goes
 * offline. Before the fix the failed fetch was swallowed and Pull went on from
 * the stale origin/* refs (pulling, or reporting nothing to pull); now the
 * repository fails on the fetch and nothing is pulled from stale refs.
 */
test('Pull with an offline origin reports the failed fetch and pulls nothing', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pull-offline-origin-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  writeFileSync(commandLogPath, '');
  // An origin one commit ahead, already fetched: the stats show Pull.
  const { branch, worktreePath } = seedOfflineOrigin(
    userDataDir,
    ({ origin, branch: tracked, worktreePath: checkout }) => {
      const upstream = path.join(userDataDir, 'upstream-clone');
      git(['clone', '--branch', tracked, origin, upstream]);
      writeFileSync(path.join(upstream, 'UPSTREAM.md'), 'Landed upstream\n');
      git(['-C', upstream, 'add', 'UPSTREAM.md']);
      git(['-C', upstream, ...GIT_IDENTITY, 'commit', '-m', 'Upstream change']);
      git(['-C', upstream, 'push', 'origin', tracked]);
      git(['-C', checkout, 'fetch', 'origin']);
    },
  );
  const head = git(['-C', worktreePath, 'rev-parse', 'HEAD']);

  const { electronApp, window } = await openWorktree({
    userDataDir,
    branch,
    commandLogPath,
  });
  try {
    const pull = window
      .getByTestId('pr-status-bar-branch-sync')
      .filter({ hasText: /^Pull$/ });
    await expect(pull).toBeVisible({ timeout: 30_000 });
    writeFileSync(commandLogPath, '');
    await pull.click();

    await expect(
      window.getByText(/Pull failed for 1 repo/).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByText(/No repos needed to pull/)).toHaveCount(0);
    await expect(window.getByText(/branch is up to date/)).toHaveCount(0);
    const commands = loggedCommands(commandLogPath);
    expect(
      subcommands(commands, ['fetch']).some((command) =>
        command.includes('fetch --prune origin'),
      ),
      'the preflight fetch ran',
    ).toBe(true);
    expect(
      subcommands(commands, ['pull', 'merge', 'rebase']),
      'no pull ran from the stale origin refs',
    ).toEqual([]);
    expect(git(['-C', worktreePath, 'rev-parse', 'HEAD'])).toBe(head);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-4108 PR0: Commit & push fetches before committing. With the origin
 * offline the swallowed fetch let the commit land and only the push failed;
 * now the repository fails on the fetch and the changes stay uncommitted.
 */
test('Commit & push with an offline origin fails before committing', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-commit-push-offline-origin-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  writeFileSync(commandLogPath, '');
  const { branch, worktreePath } = seedOfflineOrigin(userDataDir);
  writeFileSync(path.join(worktreePath, 'can-4108.txt'), 'Pending work\n');
  const head = git(['-C', worktreePath, 'rev-parse', 'HEAD']);

  const { electronApp, window } = await openWorktree({
    userDataDir,
    branch,
    commandLogPath,
  });
  try {
    const commitAndPush = window
      .getByTestId('pr-status-bar-branch-sync')
      .filter({ hasText: /^Commit & push$/ });
    await expect(commitAndPush).toBeVisible({ timeout: 30_000 });
    writeFileSync(commandLogPath, '');
    await commitAndPush.click();
    const branchWarning = window.getByRole('button', {
      name: 'Continue anyway',
    });
    if (await branchWarning.isVisible()) await branchWarning.click();

    await expect(window.getByText(/failed for 1 repo/).first()).toBeVisible({
      timeout: 60_000,
    });
    const commands = loggedCommands(commandLogPath);
    expect(
      subcommands(commands, ['fetch']).some((command) =>
        command.includes('fetch origin'),
      ),
      'the pre-commit fetch ran',
    ).toBe(true);
    expect(
      subcommands(commands, ['commit', 'push']),
      'nothing was committed or pushed after the failed fetch',
    ).toEqual([]);
    expect(git(['-C', worktreePath, 'rev-parse', 'HEAD'])).toBe(head);
    expect(git(['-C', worktreePath, 'status', '--porcelain'])).toContain(
      'can-4108.txt',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
