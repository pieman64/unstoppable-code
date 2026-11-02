import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-5337 (CAN-4995 leg E): a project whose source repository stays gone.
// Its deletion refuses only because of a discardable worktree, so the
// project-level description lists it; after its discard the ordinary
// deletion finishes, and the moved source repository is left alone.

const WORKSPACE_NAME = 'TypeScript pnpm Vite';

function seed(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = workspaces[0];
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );
  const worktree = JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees[0];
  return {
    userDataDir,
    workspace,
    worktree,
    movedSource: `${workspace.repoPath}-moved`,
  };
}

test('CAN-5337: the description lists the blocked worktree, and the project deletes after its discard through IPC', async () => {
  test.setTimeout(120_000);
  const { userDataDir, workspace, worktree, movedSource } = seed(
    'canopy-can5337-ipc-',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    renameSync(workspace.repoPath, movedSource);

    await expect(
      window.evaluate((request) => window.api.deleteProject(request), {
        projectId: workspace.id,
      }),
    ).rejects.toThrow(/source repository/);
    const description = await window.evaluate(
      (request) => window.api.describeProjectDeletionDiscard(request),
      { workspaceId: workspace.id },
    );
    expect(description).toMatchObject({
      status: 'discardable',
      items: [
        { description: { worktreeId: worktree.id, status: 'discardable' } },
      ],
    });
    for (const item of description.items)
      expect(
        await window.evaluate(
          (request) => window.api.discardWorktree(request),
          {
            projectId: workspace.id,
            worktreeId: item.description.worktreeId,
            confirmation: item.description.confirmation,
          },
        ),
      ).toMatchObject({ status: 'discarded' });
    await window.evaluate((request) => window.api.deleteProject(request), {
      projectId: workspace.id,
    });
    expect(existsSync(path.join(userDataDir, 'workspaces', workspace.id))).toBe(
      false,
    );
    expect(existsSync(movedSource)).toBe(true);
  } finally {
    if (existsSync(movedSource) && !existsSync(workspace.repoPath))
      renameSync(movedSource, workspace.repoPath);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-5337: removing the project from Settings opens one confirmation and deletes it after the discard', async () => {
  test.setTimeout(150_000);
  const { userDataDir, workspace, worktree, movedSource } =
    seed('canopy-can5337-ui-');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    renameSync(workspace.repoPath, movedSource);

    await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
    await app.workspaceSettingsButton(WORKSPACE_NAME).click();
    const page = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(page).toBeVisible();
    const remove = page.getByTestId('project-settings-remove');
    await remove.scrollIntoViewIfNeeded();
    await remove.click();
    await window.getByTestId('project-settings-remove-confirm').click();

    const discard = window.getByTestId('project-deletion-discard-dialog');
    await expect(discard).toBeVisible({ timeout: 30_000 });
    await expect(discard).toContainText(`Delete project “${WORKSPACE_NAME}”?`);
    await expect(discard).toContainText(worktree.label ?? worktree.branchName);
    await expect(discard).toContainText(workspace.worktreePath);
    await expect(discard).not.toContainText('Branches');
    await expect(
      window.getByTestId('project-deletion-discard-dialog-confirm'),
    ).toHaveText(/^Discard worktrees? and delete project$/);

    await window.getByTestId('project-deletion-discard-dialog-confirm').click();
    await expect(discard).toHaveCount(0, { timeout: 60_000 });
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(existsSync(movedSource)).toBe(true);
  } finally {
    if (existsSync(movedSource) && !existsSync(workspace.repoPath))
      renameSync(movedSource, workspace.repoPath);
    await closeCanopy(electronApp, userDataDir);
  }
});
