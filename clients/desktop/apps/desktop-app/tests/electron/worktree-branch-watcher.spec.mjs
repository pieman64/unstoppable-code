import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const INITIAL_BRANCH = 'demo-main';
const RENAMED_BRANCH = 'feature/external-branch-change';

test('an external Git branch change updates the live row and persisted worktree', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-branch-watcher-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = seed.workspaces[0];
  expect(workspace?.worktreePath, 'seeded worktree path').toBeTruthy();
  const worktreesFilePath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const initialRow = window.locator(
      `[data-testid="worktree-row"][data-branch="${INITIAL_BRANCH}"]`,
    );
    await expect(initialRow).toBeVisible();
    await app.selectWorktree(INITIAL_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Simulate a branch rename performed outside the app. The main-process
    // HEAD watcher must reconcile both the visible row and durable metadata
    // without requiring a project reload or disturbing the selected surface.
    execFileSync('git', ['branch', '-m', RENAMED_BRANCH], {
      cwd: workspace.worktreePath,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const renamedRow = window.locator(
      `[data-testid="worktree-row"][data-branch="${RENAMED_BRANCH}"]`,
    );
    await expect(renamedRow).toBeVisible({ timeout: 30_000 });
    await expect(initialRow).toHaveCount(0);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await expect
      .poll(
        () => {
          const persisted = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
          return persisted.worktrees[0]?.branchName;
        },
        {
          timeout: 30_000,
          message: 'external branch rename persisted to worktrees.json',
        },
      )
      .toBe(RENAMED_BRANCH);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a branch renamed while unwatched is recorded when the watcher starts', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-branch-catch-up-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = seed.workspaces[0];
  expect(workspace?.worktreePath, 'seeded worktree path').toBeTruthy();
  const worktreesFilePath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );

  // Reproduce a rename the watcher never saw: git stays on demo-main while
  // the persisted row still holds a generated default branch name.
  const seeded = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
  const seededRow = seeded.worktrees[0];
  expect(seededRow?.id, 'seeded worktree id').toBeTruthy();
  const staleBranch = `${seededRow.id}-1792088684150`;
  // The sidebar label reads `branchName`. The replica's per-repository branch
  // is a `{ state, value }` observation minted at creation; it is not the
  // label and a branch observation does not move it, so leave it untouched.
  seededRow.branchName = staleBranch;
  writeFileSync(worktreesFilePath, JSON.stringify(seeded, null, 2));

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const repairedRow = window.locator(
      `[data-testid="worktree-row"][data-branch="${INITIAL_BRANCH}"]`,
    );
    await expect(repairedRow).toBeVisible({ timeout: 30_000 });
    // The seeded chat's title can still label the row, so check the branch
    // text the row shows rather than the title.
    await expect(repairedRow).toContainText(INITIAL_BRANCH);
    await expect(repairedRow).not.toContainText(staleBranch);
    await expect(
      window.locator(
        `[data-testid="worktree-row"][data-branch="${staleBranch}"]`,
      ),
    ).toHaveCount(0);

    await expect
      .poll(
        () => {
          const persisted = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
          const row = persisted.worktrees.find(
            (worktree) => worktree.id === seededRow.id,
          );
          return row?.branchName;
        },
        {
          timeout: 30_000,
          message: 'live branch recorded to worktrees.json on watcher start',
        },
      )
      .toBe(INITIAL_BRANCH);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('restored multi-repo watchers reconcile an external child-repo branch change', async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-multi-repo-branch-watcher-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
  });
  const workspace = seed.workspaces[0];
  expect(
    workspace?.worktreePath,
    'seeded multi-repo worktree path',
  ).toBeTruthy();
  const webRepoPath = path.join(workspace.worktreePath, 'repos', 'web');
  expect(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: webRepoPath,
      encoding: 'utf8',
    }).trim(),
  ).toBe(INITIAL_BRANCH);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window.getByTestId('worktree-row').hover();
    await window.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-info').click();
    const dialog = window.getByRole('dialog', { name: 'Repo branches' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Web app')).toBeVisible();
    await expect(dialog.getByText('API Service')).toBeVisible();

    execFileSync('git', ['branch', '-m', RENAMED_BRANCH], {
      cwd: webRepoPath,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    await expect(dialog.getByText(RENAMED_BRANCH, { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
