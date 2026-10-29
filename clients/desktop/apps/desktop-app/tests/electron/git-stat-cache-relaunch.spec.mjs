import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_KEY = `${WORKSPACE_ID}/${WORKTREE_ID}`;
const CACHE_KEY = 'canopy.diffStatsCache.v1';

test('restores persisted Git stats then refreshes a selected worktree immediately', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-git-stat-cache-'),
  );
  const electronArgs = [
    `--user-data-dir=${path.join(userDataDir, 'electron-profile')}`,
  ];
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const firstLaunch = await launchCanopy({ userDataDir, electronArgs });
  try {
    const firstWindow = await firstLaunch.electronApp.firstWindow();
    const firstApp = new CanopyAppDriver(firstWindow);
    await firstApp.waitForShell({ timeout: 30_000 });

    // Use values that cannot come from the clean fixture. A future next-due
    // timestamp keeps the startup scheduler from replacing them, proving the
    // second renderer painted its row from persisted state.
    await firstWindow.evaluate(
      ({ cacheKey, worktreeKey }) => {
        const now = Date.now();
        const rawCache = JSON.stringify({
          version: 1,
          savedAtMs: now,
          state: {
            diffStats: {
              [worktreeKey]: { insertions: 137, deletions: 23 },
            },
            commitsAhead: {},
            baseBranches: {},
            defaultBranches: {},
            uncommittedChanges: { [worktreeKey]: true },
            hasRemoteTracking: {},
            hasOriginRemote: {},
            hasBranchBeenPushed: {},
            hasUnpushedCommits: {},
            hasUnpulledCommits: {},
            repoBranches: {},
            baseBranchExistsLocally: {},
            baseBranchExistsInRemote: {},
          },
          activityAtMs: { [worktreeKey]: now },
          pollStates: {
            [worktreeKey]: {
              intervalMs: 3_600_000,
              nextDueAtMs: now + 3_600_000,
              lastChangeSignature: 'persisted-e2e-snapshot',
            },
          },
        });
        localStorage.setItem(cacheKey, rawCache);
        // The production pagehide flush was registered during module startup.
        // Registering this fixture writer afterward makes the synthetic cache
        // the final snapshot persisted by the first renderer.
        addEventListener('pagehide', () => {
          localStorage.setItem(cacheKey, rawCache);
        });
      },
      { cacheKey: CACHE_KEY, worktreeKey: WORKTREE_KEY },
    );
  } finally {
    await closeCanopy(firstLaunch.electronApp, userDataDir, {
      keepUserData: true,
    });
  }

  const secondLaunch = await launchCanopy({ userDataDir, electronArgs });
  try {
    const secondWindow = await secondLaunch.electronApp.firstWindow();
    const secondApp = new CanopyAppDriver(secondWindow);
    await secondApp.waitForShell({ timeout: 30_000 });
    await secondApp.openMainPage();

    const row = secondWindow.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row).toContainText('+137');
    await expect(row).toContainText('-23');

    // The cache is useful for the initial paint, but selecting the worktree
    // must reconcile it immediately instead of leaving stale Git actions in
    // the status bar until the next global scheduler tick.
    await secondApp.selectWorktree(WORKTREE_ID);
    await expect(row).not.toContainText('+137', { timeout: 30_000 });
    await expect(row).not.toContainText('-23', { timeout: 30_000 });
  } finally {
    await closeCanopy(secondLaunch.electronApp, userDataDir);
  }
});
