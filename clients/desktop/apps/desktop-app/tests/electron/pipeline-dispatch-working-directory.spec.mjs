import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const PIPELINE_NAME = 'Working Directory Picker Pipeline';
const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  verify:',
  '    steps:',
  '      - run: echo picker',
  '',
].join('\n');

const WORKSPACE_CASES = [
  {
    id: 'persistent-multi-repo',
    name: 'Persistent Multi Repo',
    worktreeId: 'persistent-worktree',
    branchName: 'persistent-branch',
    temporary: false,
    repos: [
      { id: 'persistent-web', name: 'Persistent Web' },
      { id: 'persistent-api', name: 'Persistent API' },
    ],
  },
  {
    id: 'temporary-multi-repo',
    name: 'Temporary Multi Repo',
    worktreeId: 'temporary-worktree',
    branchName: 'temporary-branch',
    temporary: true,
    repos: [
      { id: 'temporary-web', name: 'Temporary Web' },
      { id: 'temporary-api', name: 'Temporary API' },
    ],
  },
];

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedSourceRepo(repoPath, name) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeFileSync(path.join(repoPath, 'README.md'), `${name}\n`, 'utf8');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial']);
}

function seedLocalOnlyMultiRepoWorkspaces(userDataDir) {
  const fixtureDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-dispatch-working-directory-'),
  );

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: WORKSPACE_CASES.map((workspace, order) => ({
      id: workspace.id,
      name: workspace.name,
      type: 'multi-repo',
      color: order === 0 ? '#38bdf8' : '#a78bfa',
      collapsed: false,
      order,
    })),
  });

  for (const workspace of WORKSPACE_CASES) {
    const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
    const worktreePath = path.join(
      workspaceDir,
      'worktrees',
      workspace.worktreeId,
    );
    const repoConfigs = [];

    mkdirSync(path.join(worktreePath, 'repos'), { recursive: true });
    for (const repo of workspace.repos) {
      const sourceRepoPath = path.join(fixtureDir, workspace.id, repo.id);
      const childWorktreePath = path.join(worktreePath, 'repos', repo.id);
      seedSourceRepo(sourceRepoPath, repo.name);
      git(sourceRepoPath, [
        'worktree',
        'add',
        '-b',
        workspace.branchName,
        childWorktreePath,
      ]);
      repoConfigs.push({
        id: repo.id,
        name: repo.name,
        repoPath: sourceRepoPath,
      });
    }

    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: repoConfigs,
      alwaysShow: true,
      ...(workspace.temporary ? { temporary: true } : {}),
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [
        {
          id: workspace.worktreeId,
          branchName: workspace.branchName,
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ],
    });
  }

  return fixtureDir;
}

test('dispatch working-directory picker includes the root and every child repo for temporary and persistent multi-repo projects', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-working-directory-'),
  );
  const fixtureDir = seedLocalOnlyMultiRepoWorkspaces(userDataDir);
  seedStoredPipeline({
    userDataDir,
    id: 'working-directory-picker',
    name: PIPELINE_NAME,
    yaml: PIPELINE_YAML,
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    for (const workspace of WORKSPACE_CASES) {
      const worktreeRow = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${workspace.worktreeId}"]`,
      );
      await expect(worktreeRow).toBeVisible();
      await worktreeRow.hover();
      await worktreeRow.getByTestId('worktree-actions-menu-button').click();
      await window
        .getByTestId('worktree-actions-menu-dispatch-pipeline')
        .click();

      const dialog = window.getByRole('dialog', {
        name: 'Dispatch pipeline',
      });
      await expect(dialog).toBeVisible();
      const workingDirectory = dialog.getByLabel('Working directory', {
        exact: true,
      });
      await expect(workingDirectory).toBeVisible();

      const expectedRepoOptions = workspace.repos
        .map((repo) => repo.name)
        .sort();
      await expect(workingDirectory.locator('option')).toHaveCount(
        expectedRepoOptions.length + 1,
      );
      const actualOptions = (
        await workingDirectory.locator('option').allTextContents()
      ).map((label) => label.trim());
      expect(actualOptions[0]).toBe('Project root');
      expect(actualOptions.slice(1).sort()).toEqual(expectedRepoOptions);
      await expect(workingDirectory.locator('option:checked')).toHaveText(
        'Project root',
      );

      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
