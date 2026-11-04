import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

function seedGitWorkspace(userDataDir) {
  const {
    workspaces: [workspace],
  } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  // Give deferred Git setup a real local default branch, not a network remote
  // or a source-only fixture whose missing origin breaks repo-shadow setup.
  const origin = path.join(userDataDir, 'origin.git');
  execFileSync('git', ['clone', '--bare', workspace.repoPath, origin]);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: workspace.repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const branch = git(['branch', '--show-current']);
  git(['remote', 'add', 'origin', origin]);
  git(['fetch', 'origin']);
  git(['remote', 'set-head', 'origin', branch]);
  return workspace;
}

test('Sidebar creation failures remain visible on Overview', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-off-page-failure-'),
  );
  const workspace = seedGitWorkspace(userDataDir);
  const message = 'Selected Git executable cannot be used.';
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openOverviewPage();
    await electronApp.evaluate(({ ipcMain }, error) => {
      ipcMain.removeHandler('worktree:create');
      ipcMain.handle('worktree:create', async () => {
        throw new Error(error);
      });
    }, message);
    const header = app.workspaceHeader(workspace.name);
    await header.hover();
    const create = header.getByRole('button', {
      name: `Create worktree for ${workspace.name}`,
      exact: true,
    });
    await create.click();
    await expect(window.getByTestId('page-main')).toBeHidden();
    const toast = window
      .locator('[data-notice-shape="toast"]')
      .filter({ hasText: message });
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(message);
    await expect(
      window.getByTestId('sidebar-worktree-creating-placeholder'),
    ).toHaveCount(0);
    await expect(create).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-5422: the shared Sidebar has its own pending row, separate from the
// projects store's creating Set. Its desktop adapter must settle BOTH when
// Git rejects creation, not return an unconditionally pending receipt.
test('Sidebar header settles a Git failure and creates one worktree on retry', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-git-retry-'),
  );
  const workspace = seedGitWorkspace(userDataDir);
  const creationError =
    'Selected Git executable cannot be used. Git executable does not exist: /home/canopy-desktop/.cache/can5422-filtered-path-candidate-v3/git';
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() => {
      localStorage.setItem('canopy.desktop.sharedSidebar', '1');
    });
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    // Inject the exact native Linux rejection at the main IPC boundary so
    // this cross-platform renderer regression does not depend on host Git
    // discovery. Retry calls the original handler and creates a real checkout.
    await electronApp.evaluate(({ ipcMain }, message) => {
      const original = ipcMain._invokeHandlers.get('worktree:create');
      if (!original) throw new Error('Missing worktree:create handler');
      const state = { original, calls: 0 };
      globalThis.__can5422SidebarRetry = state;
      ipcMain.removeHandler('worktree:create');
      ipcMain.handle('worktree:create', async (event, request) => {
        state.calls += 1;
        if (state.calls === 1) {
          await new Promise((resolve) => {
            state.releaseFailure = resolve;
          });
          throw new Error(message);
        }
        return original(event, request);
      });
    }, creationError);

    const add = app.workspaceHeader(workspace.name).getByRole('button', {
      name: `Create worktree for ${workspace.name}`,
      exact: true,
    });
    const pending = window.getByTestId('sidebar-worktree-creating-placeholder');
    const rows = window.getByTestId('worktree-row');
    await expect(rows).toHaveCount(0);
    // Header actions are revealed on hover in the shared Sidebar.
    await app.workspaceHeader(workspace.name).hover();
    await add.click();
    await expect(pending).toBeVisible();
    await expect(add).toBeDisabled();
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => typeof globalThis.__can5422SidebarRetry.releaseFailure,
        ),
      )
      .toBe('function');
    await electronApp.evaluate(() =>
      globalThis.__can5422SidebarRetry.releaseFailure(),
    );

    await expect(pending).toHaveCount(0);
    // The page retains the full actionable error; compact toasts shorten it.
    await expect(
      window.getByText(creationError, { exact: true }),
    ).toBeVisible();
    await expect(add).toBeEnabled();
    await expect(rows).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.__can5422SidebarRetry.calls),
    ).toBe(1);

    await add.click();
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(add).toBeEnabled();
    expect(
      await electronApp.evaluate(() => globalThis.__can5422SidebarRetry.calls),
    ).toBe(2);
    const worktrees = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', workspace.id, 'worktrees.json'),
        'utf8',
      ),
    ).worktrees;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].id).toBe(await rows.getAttribute('data-worktree-id'));
    await expect
      .poll(
        () =>
          existsSync(
            path.join(
              userDataDir,
              'workspaces',
              workspace.id,
              'worktrees',
              worktrees[0].id,
              '.git',
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await electronApp
      .evaluate(({ ipcMain }) => {
        const state = globalThis.__can5422SidebarRetry;
        if (!state) return;
        state.releaseFailure?.();
        ipcMain.removeHandler('worktree:create');
        ipcMain.handle('worktree:create', state.original);
        delete globalThis.__can5422SidebarRetry;
      })
      .catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Sidebar creation completion preserves navigation away during persistence', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-selection-'),
  );
  const workspace = seedGitWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      localStorage.setItem('canopy.desktop.sharedSidebar', '1'),
    );
    await window.reload();
    await app.waitForShell();
    await electronApp.evaluate(({ ipcMain }, workspaceId) => {
      const original = ipcMain._invokeHandlers.get('projects:save');
      if (!original) throw new Error('Missing projects:save handler');
      const state = { original, released: false, entered: false };
      state.hold = new Promise((resolve) => {
        state.release = () => {
          state.released = true;
          resolve();
        };
      });
      globalThis.__can5422DeferredSave = state;
      ipcMain.removeHandler('projects:save');
      ipcMain.handle('projects:save', async (event, items, options) => {
        const result = await original(event, items, options);
        if (
          !state.released &&
          items.some(
            (item) => item.id === workspaceId && item.worktrees?.length > 0,
          )
        ) {
          state.entered = true;
          await state.hold;
        }
        return result;
      });
    }, workspace.id);
    const header = app.workspaceHeader(workspace.name);
    await header.hover();
    await header
      .getByRole('button', {
        name: `Create worktree for ${workspace.name}`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__can5422DeferredSave.entered),
      )
      .toBe(true);
    // Local registration has selected the row while persistence is held.
    await expect(window.getByTestId('page-main')).toBeVisible();
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    await electronApp.evaluate(() =>
      globalThis.__can5422DeferredSave.release(),
    );
    // Cross the IPC reply boundary, then let the resulting renderer promises
    // and selection commits finish without an arbitrary wall-clock delay.
    await window.evaluate(async () => {
      await window.api.loadProjects();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await expect(
      window.getByTestId('sidebar-worktree-creating-placeholder'),
    ).toHaveCount(0);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(window.getByTestId('page-main')).toBeHidden();
  } finally {
    await electronApp
      .evaluate(({ ipcMain }) => {
        const state = globalThis.__can5422DeferredSave;
        if (!state) return;
        state.release();
        ipcMain.removeHandler('projects:save');
        ipcMain.handle('projects:save', state.original);
        delete globalThis.__can5422DeferredSave;
      })
      .catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
  }
});
