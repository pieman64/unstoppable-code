import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-5338 (CAN-4995 leg F): a pending version-3 archive whose recovery
// journal names the project's configured source, which then goes away. Its
// permanent deletion can't finish; the desktop offers the shared discard from
// Archived and deleted, and project deletion lists it beside the worktrees.

const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const CONTAINER_ID = 'retained-pending';
const ARCHIVE_NAME = 'Retained archive';
const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seed(prefix, { createWorktrees }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const {
    workspaces: [workspace],
  } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees,
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  const containerDir = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'archived-containers',
    CONTAINER_ID,
  );
  const recovery = {
    kind: 'files-only',
    source: 'partial',
    digest: 'a'.repeat(64),
    payloadId: '11111111-1111-4111-8111-111111111111',
    gitCleanupPending: true,
  };
  writeJson(path.join(containerDir, 'container.json'), {
    version: 3,
    id: CONTAINER_ID,
    kind: 'worktree',
    projectId: workspace.id,
    name: ARCHIVE_NAME,
    createdAt: NOW,
    archivedAt: NOW,
    retentionDays: 7,
    expiresAt: EXPIRES,
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    branchName: 'feature/retained',
    workspaceType: 'single-repo',
    originalWorktree: {
      id: CONTAINER_ID,
      branchName: 'feature/retained',
      createdAt: NOW,
    },
    recovery,
  });
  // Phase `removed`: nothing left for the finish step but the Git cleanup in
  // the configured source, which a gone source keeps pending.
  writeJson(path.join(containerDir, 'recovery.staged.json'), {
    version: 1,
    createdAt: NOW,
    phase: 'removed',
    recovery,
    repositories: [
      {
        referenceRepoPath: workspace.repoPath,
        repositoryIdentity: null,
        relativePath: '',
        worktreePaths: [],
      },
    ],
  });
  return {
    userDataDir,
    workspace,
    containerDir,
    movedSource: `${workspace.repoPath}-moved`,
  };
}

function restoreSource({ workspace, movedSource }) {
  if (existsSync(movedSource) && !existsSync(workspace.repoPath))
    renameSync(movedSource, workspace.repoPath);
}

test('CAN-5338: a retained archive whose source is gone offers the discard from Archived and deleted, and is removed after it', async () => {
  test.setTimeout(120_000);
  const fixture = seed('canopy-can5338-archived-', { createWorktrees: false });
  const { userDataDir, workspace, containerDir, movedSource } = fixture;
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    renameSync(workspace.repoPath, movedSource);

    await window
      .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
      .click();
    await window.getByTestId(`archived-overview-open-${CONTAINER_ID}`).click();
    const viewer = window.getByTestId('archived-container-view');
    await expect(viewer).toBeVisible();
    await viewer.getByTestId('archived-delete-permanently').click();
    await viewer.getByRole('button', { name: 'Delete?' }).click();

    const dialog = window.getByTestId('worktree-discard-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('Archived worktree');
    await expect(dialog).toContainText(containerDir);
    await expect(dialog).toContainText(workspace.repoPath);
    await expect(
      window.getByTestId('worktree-discard-dialog-confirm'),
    ).toHaveText('Discard worktree (source missing)');

    await window.getByTestId('worktree-discard-dialog-confirm').click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect(viewer).toHaveCount(0, { timeout: 15_000 });
    await expect(
      window.getByTestId(`archived-overview-open-${CONTAINER_ID}`),
    ).toHaveCount(0);
    expect(existsSync(containerDir)).toBe(false);
    expect(existsSync(movedSource)).toBe(true);
  } finally {
    restoreSource(fixture);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-5338: removing the project from Settings lists the retained archive beside its worktree and deletes the project after the discards', async () => {
  test.setTimeout(150_000);
  const fixture = seed('canopy-can5338-project-', { createWorktrees: true });
  const { userDataDir, workspace, movedSource } = fixture;
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
    await expect(discard).toContainText(ARCHIVE_NAME);
    await expect(discard).toContainText('Archived worktree');
    await expect(discard).toContainText(workspace.worktreePath);

    await window.getByTestId('project-deletion-discard-dialog-confirm').click();
    await expect(discard).toHaveCount(0, { timeout: 60_000 });
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(existsSync(path.join(userDataDir, 'workspaces', workspace.id))).toBe(
      false,
    );
    expect(existsSync(movedSource)).toBe(true);
  } finally {
    restoreSource(fixture);
    await closeCanopy(electronApp, userDataDir);
  }
});
