import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedRepo(repoPath, canopyJson) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeJson(path.join(repoPath, 'canopy.json'), canopyJson);
  git(repoPath, ['add', 'canopy.json']);
  git(repoPath, ['commit', '-m', 'initial']);
}

function addWorktree(repoPath, worktreePath, branchName) {
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
}

function seedDriftFixture(userDataDir) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-drift-'));
  const multiId = 'drift-workspace';
  const singleId = 'drift-project';
  const worktreeId = 'wt-drift';
  const multiSourcePath = path.join(fixtureDir, 'multi-source');
  const singleRepoPath = path.join(fixtureDir, 'single-source');
  const multiDir = path.join(userDataDir, 'workspaces', multiId);
  const singleDir = path.join(userDataDir, 'workspaces', singleId);
  const multiWorktreePath = path.join(multiDir, 'worktrees', worktreeId);
  const singleWorktreePath = path.join(singleDir, 'worktrees', worktreeId);

  seedRepo(multiSourcePath, {
    version: 1,
    scripts: {},
    repos: [
      {
        id: 'unbound-repo',
        name: 'Unbound Repo',
        url: 'https://example.test/unbound.git',
      },
    ],
  });
  seedRepo(singleRepoPath, {
    version: 1,
    scripts: {},
  });
  addWorktree(multiSourcePath, multiWorktreePath, 'multi-drift');
  addWorktree(singleRepoPath, singleWorktreePath, 'single-drift');

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: multiId,
        name: 'Drift Workspace',
        type: 'multi-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
      {
        id: singleId,
        name: 'Drift Project',
        type: 'single-repo',
        color: '#a78bfa',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(path.join(multiDir, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [],
    sourceRepoPath: multiSourcePath,
    alwaysShow: true,
  });
  writeJson(path.join(singleDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: singleRepoPath,
    repos: [],
    alwaysShow: true,
  });
  for (const workspaceDir of [multiDir, singleDir]) {
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [
        {
          id: worktreeId,
          branchName:
            workspaceDir === multiDir ? 'multi-drift' : 'single-drift',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
    });
  }

  return {
    fixtureDir,
    multiSourcePath,
    singleRepoPath,
    multiWorktreePath,
    singleWorktreePath,
  };
}

async function openSettings(app, window, workspaceName) {
  await app.workspaceHeaderLabel(workspaceName).hover();
  await app.workspaceSettingsButton(workspaceName).click();
  const dialog = window.getByRole('dialog', { name: workspaceName });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'General' }).click();
  return dialog;
}

/** Single-repo project settings is a page that opens on General. */
async function openProjectSettings(app, window, workspaceName) {
  await app.workspaceHeaderLabel(workspaceName).hover();
  await app.workspaceSettingsButton(workspaceName).click();
  const page = window.getByRole('dialog', { name: workspaceName });
  await expect(page).toBeVisible();
  await expect(page.getByTestId('project-settings-page-general')).toBeVisible();
  return page;
}

test('project health is checked on demand and reflects repaired or missing manifests', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const fixture = seedDriftFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const multiDialog = await openSettings(app, window, 'Drift Workspace');
    await expect(multiDialog.getByText('Project health')).toBeVisible();
    await expect(multiDialog.getByText('Blocking issue')).toBeVisible();
    await expect(
      multiDialog.getByText(/no tracked local binding/i),
    ).toBeVisible();
    await expect(
      multiDialog.getByText(path.join(fixture.multiSourcePath, 'canopy.json'), {
        exact: true,
      }),
    ).toBeVisible();

    writeJson(path.join(fixture.multiSourcePath, 'canopy.json'), {
      version: 1,
      scripts: {},
      repos: [],
    });
    await multiDialog.getByRole('button', { name: 'Close' }).click();
    const repairedMultiDialog = await openSettings(
      app,
      window,
      'Drift Workspace',
    );
    await expect(repairedMultiDialog.getByText('Project health')).toHaveCount(
      0,
    );
    await repairedMultiDialog.getByRole('button', { name: 'Close' }).click();

    rmSync(path.join(fixture.singleRepoPath, 'canopy.json'));
    const singleDialog = await openProjectSettings(
      app,
      window,
      'Drift Project',
    );
    await expect(singleDialog.getByText('Project health')).toBeVisible();
    await expect(singleDialog.getByText('Warning')).toBeVisible();
    await expect(
      singleDialog.getByText(/canopy\.json is not present/i),
    ).toBeVisible();
    await expect(
      singleDialog.getByText(path.join(fixture.singleRepoPath, 'canopy.json'), {
        exact: true,
      }),
    ).toBeVisible();

    await singleDialog.getByTestId('project-settings-back').click();
    const sidebar = window.getByTestId('app-sidebar');
    const lateWorktree = sidebar.locator(
      '[data-project-id="drift-project"][data-worktree-id="wt-drift"]',
    );
    await lateWorktree.click();
    await expandDefaultActivityRail(window);
    await expect(window.getByTestId('activity-summary-section')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
