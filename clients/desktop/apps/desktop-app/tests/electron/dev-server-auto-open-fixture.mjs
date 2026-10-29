import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';

export const PROJECT_ID = 'auto-open-project';
export const WORKTREE_ID = 'wt-1';
export const BACKGROUND_WORKTREE_ID = 'wt-2';
export const PROJECT_NAME = 'Auto open project';
export const PATTERN = 'https?://localhost:\\d+\\S*';

export function seedAutoOpenProject() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-auto-open-'));
  const fixtureDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-open-repo-'),
  );
  const repoPath = path.join(fixtureDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  const git = (args) =>
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  const configPath = path.join(repoPath, 'canopy.json');
  const writeJson = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson(configPath, {
    version: 1,
    scripts: { launch: { command: 'npm run dev', devServerPattern: PATTERN } },
  });
  git(['add', 'canopy.json']);
  git(['commit', '-m', 'Fixture']);
  const projectDir = path.join(userDataDir, 'workspaces', PROJECT_ID);
  const worktreePath = path.join(projectDir, 'worktrees', WORKTREE_ID);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', WORKTREE_ID, worktreePath]);
  const backgroundWorktreePath = path.join(
    projectDir,
    'worktrees',
    BACKGROUND_WORKTREE_ID,
  );
  git([
    'worktree',
    'add',
    '-b',
    BACKGROUND_WORKTREE_ID,
    backgroundWorktreePath,
  ]);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: PROJECT_ID,
        name: PROJECT_NAME,
        type: 'single-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(projectDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(projectDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: WORKTREE_ID,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: BACKGROUND_WORKTREE_ID,
        branchName: BACKGROUND_WORKTREE_ID,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });
  return {
    userDataDir,
    fixtureDir,
    configPath: path.join(worktreePath, 'canopy.json'),
  };
}

export async function openAutoOpenSettings(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await app.workspaceHeaderLabel(PROJECT_NAME).hover();
  await app.workspaceSettingsButton(PROJECT_NAME).click();
  const dialog = window.getByRole('dialog', { name: PROJECT_NAME });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'Scripts', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Source controlled', exact: true })
    .click();
  const defaultBranch = dialog.getByRole('button', { name: /Default branch/ });
  if (await defaultBranch.count()) {
    await defaultBranch.click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();
  }
  const command = dialog.locator('textarea').filter({ visible: true });
  await expect
    .poll(() =>
      command.evaluateAll((nodes) =>
        nodes.some((node) => node.value === 'npm run dev'),
      ),
    )
    .toBe(true);
  const index = await command.evaluateAll((nodes) =>
    nodes.findIndex((node) => node.value === 'npm run dev'),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const editor = command
    .nth(index)
    .locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]');
  return { app, dialog, editor };
}
