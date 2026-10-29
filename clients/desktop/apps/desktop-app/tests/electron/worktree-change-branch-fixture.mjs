import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

export const WORKSPACE_ID = 'demo-ts-pnpm-vite';
export async function launchWorktreeChangeBranch() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'worktree-change-branch-'),
  );
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // Keep this branch-selection fixture clean: the demo's dependency-install setup
  // creates a lockfile, which correctly blocks subsequent branch checkouts.
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.scripts.setup;
  writeFileSync(configPath, JSON.stringify(config));
  const repoPath = summary.workspaces[0].worktreePath;
  for (const name of ['source-branch', 'base-target', 'pr-source'])
    execFileSync('git', ['branch', name], { cwd: repoPath });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const pr = {
        number: 42,
        title: 'Fixture pull request',
        headRefName: 'pr-source',
        baseRefName: 'source-branch',
        url: 'https://github.com/example/repo/pull/42',
        authorLogin: 'fixture',
        isDraft: false,
        isCrossRepo: false,
      };
      const responses = {
        'settings:load-linear-token': 'fixture-only-token',
        'settings:validate-linear-token': {
          authenticated: true,
          displayName: 'Fixture',
          error: null,
        },
        'settings:search-linear-issues': [
          {
            id: 'fixture',
            identifier: 'CAN-123',
            title: 'Fixture issue',
            description: null,
            url: 'https://linear.app/example/issue/CAN-123',
            priority: 3,
            priorityLabel: 'Normal',
            branchName: 'fixture/linear',
          },
        ],
        'github:list-pull-requests': { pullRequests: [pr] },
        'github:resolve-pull-request': pr,
      };
      for (const [channel, response] of Object.entries(responses)) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => response);
      }
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('TypeScript pnpm Vite').hover();
    await window
      .getByRole('button', { name: /Create .* for TypeScript pnpm Vite/ })
      .click();
    const row = window.locator(
      `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"]:not([data-worktree-id="demo-main"])`,
    );
    await expect(row).toHaveCount(1);
    const worktreeId = await row.getAttribute('data-worktree-id');
    await expect(window.getByTestId('pr-status-bar')).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(
          async (target) => {
            try {
              return await window.api.getWorktreePath(target);
            } catch {
              return null;
            }
          },
          { projectId: WORKSPACE_ID, worktreeId },
        ),
      )
      .not.toBeNull();
    const worktreePath = await window.evaluate(
      (target) => window.api.getWorktreePath(target),
      { projectId: WORKSPACE_ID, worktreeId },
    );
    return {
      electronApp,
      userDataDir,
      window,
      app,
      row,
      worktreeId,
      worktreePath,
    };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}
