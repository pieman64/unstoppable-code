import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  buildPrStatusData,
  buildPrStatusEvent,
  injectGithubPrStatus,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TARGET_BRANCH = 'release/next';
const HIDDEN_TARGET_BRANCH = 'release/hidden';

function seedTargetBranch(worktreePath, branch) {
  execFileSync('git', ['branch', branch, 'HEAD'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
}

async function dispatchSetBaseBranch(electronApp, baseBranch = TARGET_BRANCH) {
  await electronApp.evaluate(
    ({ BrowserWindow }, target) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      mainWindow.webContents.send('app-advisor:tool-request', {
        kind: 'dispatch_action',
        requestId: `set-base-branch-confirmation-e2e-${target.baseBranch}`,
        originWorktreeId: target.worktreeId,
        action: {
          type: 'worktree.set_base_branch',
          projectId: target.workspaceId,
          worktreeId: target.worktreeId,
          baseBranch: target.baseBranch,
        },
      });
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      baseBranch,
    },
  );
}

async function dispatchCancelledSetBaseBranch(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, target) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      const requestId = 'set-base-branch-cancelled-e2e';
      mainWindow.webContents.send('app-advisor:tool-request', {
        kind: 'dispatch_action',
        requestId,
        originWorktreeId: target.worktreeId,
        action: {
          type: 'worktree.set_base_branch',
          projectId: target.workspaceId,
          worktreeId: target.worktreeId,
          baseBranch: target.baseBranch,
        },
      });
      mainWindow.webContents.send('app-advisor:tool-request-cancelled', {
        requestId,
      });
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      baseBranch: TARGET_BRANCH,
    },
  );
}

test('SetBaseBranch confirms an open PR before updating the tracked base', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-set-base-branch-confirmation-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedTargetBranch(seeded.workspaces[0].worktreePath, TARGET_BRANCH);
  seedTargetBranch(seeded.workspaces[0].worktreePath, HIDDEN_TARGET_BRANCH);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await window.evaluate(async () => {
      await window.api.github.setForegroundWorktree({
        projectId: null,
        worktreeId: null,
      });
    });
    // Selection can leave a refresh in flight after the foreground slot is
    // cleared. Pin this fixture before injection so that refresh cannot erase
    // the open PR between the visible status assertion and the tool action.
    await electronApp.evaluate(
      ({ ipcMain }, { projectId, worktreeId }) => {
        const invoked = ipcMain.emit(
          'github:e2e-suspend-pr-status-tracking',
          {},
          { projectId, worktreeId },
        );
        if (invoked !== true) {
          throw new Error('Failed to suspend PR-status tracking');
        }
      },
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    const statusEvent = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      repos: [
        {
          repoId: WORKSPACE_ID,
          repoName: 'TypeScript pnpm Vite',
          status: {
            ...buildPrStatusData({ prNumber: 2847 }),
            baseRefName: 'develop',
          },
        },
      ],
    });
    await expect
      .poll(async () => {
        await injectGithubPrStatus(electronApp, statusEvent);
        const text = await window.getByTestId('pr-status-bar').textContent();
        return text?.includes('#2847') ?? false;
      })
      .toBe(true);

    const dialog = window.getByTestId('base-branch-change-confirmation');
    await dispatchSetBaseBranch(electronApp);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'TypeScript pnpm Vite has open PR #2847',
    );
    await expect(dialog).toContainText(TARGET_BRANCH);

    await dialog.getByRole('button', { name: 'No, just locally' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      window
        .getByTestId('pr-status-bar')
        .getByRole('button', { name: TARGET_BRANCH, exact: true }),
    ).toBeVisible();

    await dispatchCancelledSetBaseBranch(electronApp);
    await window.waitForTimeout(500);
    await expect(dialog).toHaveCount(0);

    // Off screen, the change applies locally without asking or waiting.
    await app.openOverviewPage();
    await dispatchSetBaseBranch(electronApp, HIDDEN_TARGET_BRANCH);
    await window.waitForTimeout(500);
    await expect(dialog).toHaveCount(0);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window
        .getByTestId('pr-status-bar')
        .getByRole('button', { name: HIDDEN_TARGET_BRANCH, exact: true }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // The PR bar owns a separate confirmation. Leaving its surface must settle
    // it too, rather than hiding an unresolved request until it is replaced.
    await window.getByTestId('pr-status-bar-base-branch').click();
    await window
      .getByTestId('pr-status-base-branch-menu')
      .locator(`[data-branch-name="${TARGET_BRANCH}"]`)
      .click();
    await expect(
      window.getByRole('heading', { name: 'Update PR base branch?' }),
    ).toBeVisible();
    // An agent can navigate while the modal scrim blocks pointer input.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      mainWindow.webContents.send('app-advisor:tool-request', {
        kind: 'dispatch_action',
        requestId: 'hide-pr-bar-confirmation-e2e',
        action: { type: 'navigation.go_to_page', page: 'overview' },
      });
    });
    await expect(window.getByTestId('overview-page')).toBeVisible();
    await expect
      .poll(() => {
        const config = JSON.parse(
          readFileSync(
            path.join(
              userDataDir,
              'workspaces',
              WORKSPACE_ID,
              'worktrees.json',
            ),
            'utf8',
          ),
        );
        return config.worktrees.find((worktree) => worktree.id === WORKTREE_ID)
          ?.trackedBaseBranch;
      })
      .toBe(TARGET_BRANCH);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByRole('heading', { name: 'Update PR base branch?' }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
