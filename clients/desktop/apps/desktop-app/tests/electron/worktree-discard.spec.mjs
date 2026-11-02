import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-5334 backend leg C: the user-only worktree discard over the real
// preload/IPC transport. No UI is exercised (leg D owns it). A source
// repository that is gone blocks the ordinary removal; the archive's opt-in
// typed refusal carries the discard description, a stale confirmation is
// refused as changed, and a fresh one discards the worktree permanently while
// keeping its branch.

test('CAN-5334: describe, a changed confirmation, discard and a typed archive refusal through IPC', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can5334-'));
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = workspaces[0];
  expect(workspace?.worktreePath, 'seeded worktree path').toBeTruthy();
  const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  const worktree = JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees[0];
  const movedSource = `${workspace.repoPath}-moved`;
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    renameSync(workspace.repoPath, movedSource);

    const refused = await window.evaluate(
      (request) => window.api.archiveWorktree(request),
      {
        projectId: workspace.id,
        worktreeId: worktree.id,
        repoPath: workspace.repoPath,
        expectedCreatedAt: worktree.createdAt,
        deleteBranch: false,
        typedRefusal: true,
      },
    );
    expect(refused).toMatchObject({
      success: false,
      refusal: {
        reason: 'source-unavailable',
        discard: {
          status: 'discardable',
          causes: ['source-gone'],
          targets: [
            {
              kind: 'live-checkout',
              reason: 'source-gone',
              identityVerified: false,
            },
          ],
        },
      },
    });
    expect(existsSync(workspace.worktreePath)).toBe(true);

    const request = { projectId: workspace.id, worktreeId: worktree.id };
    const stale = await window.evaluate(
      (request) => window.api.describeWorktreeDiscard(request),
      request,
    );
    // A different directory now occupies the checkout path.
    const replaced = `${workspace.worktreePath}-replaced`;
    renameSync(workspace.worktreePath, replaced);
    mkdirSync(workspace.worktreePath);
    expect(
      await window.evaluate((request) => window.api.discardWorktree(request), {
        ...request,
        confirmation: stale.confirmation,
      }),
    ).toMatchObject({ status: 'refused', reason: 'changed' });
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(
      JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees,
    ).toHaveLength(1);

    const fresh = await window.evaluate(
      (request) => window.api.describeWorktreeDiscard(request),
      request,
    );
    expect(fresh).toMatchObject({ status: 'discardable' });
    expect(
      await window.evaluate((request) => window.api.discardWorktree(request), {
        ...request,
        confirmation: fresh.confirmation,
      }),
    ).toMatchObject({ status: 'discarded', removed: ['live-checkout'] });
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees).toEqual(
      [],
    );
    renameSync(movedSource, workspace.repoPath);
    execFileSync(
      'git',
      ['rev-parse', '--verify', `refs/heads/${worktree.branchName}`],
      { cwd: workspace.repoPath },
    );
  } finally {
    if (existsSync(movedSource)) renameSync(movedSource, workspace.repoPath);
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-5336 (leg D): the same discard through the sidebar row. A delete the
// source pre-check refuses opens the shared confirmation instead of the retry
// toast; Cancel and Retry keep the worktree, Discard removes it for good.
for (const checkout of ['present', 'missing']) {
  test(`CAN-5336: the row's delete offers the discard for a gone source (checkout ${checkout})`, async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-can5336-${checkout}-`),
    );
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
    const worktree = JSON.parse(readFileSync(worktreesPath, 'utf8'))
      .worktrees[0];
    const movedSource = `${workspace.repoPath}-moved`;
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${worktree.branchName}"]`,
      );
      await expect(row).toBeVisible();
      if (checkout === 'missing')
        rmSync(workspace.worktreePath, { recursive: true, force: true });
      renameSync(workspace.repoPath, movedSource);

      const discard = window.getByTestId('worktree-discard-dialog');
      const requestDelete = async () => {
        await row.hover();
        await row.getByTestId('worktree-actions-menu-button').click();
        await window.getByTestId('worktree-actions-menu-delete').click();
        const confirm = window.getByRole('dialog', {
          name: /^Delete worktree/,
        });
        await expect
          .poll(
            async () =>
              (await confirm.isVisible()) || (await discard.isVisible()),
          )
          .toBe(true);
        if (await confirm.isVisible())
          await window
            .locator(
              '[data-testid="worktree-removal-preserve-branch"], [data-testid="worktree-removal-delete-branch"]',
            )
            .first()
            .click();
      };

      await requestDelete();
      await expect(discard).toBeVisible({ timeout: 30_000 });
      await expect(discard).toContainText(
        `Discard worktree “${worktree.label ?? worktree.branchName}”?`,
      );
      await expect(
        window.getByTestId('worktree-discard-dialog-confirm'),
      ).toHaveText('Discard worktree (source missing)');
      await expect(discard).toContainText(
        'If the repository is on a disconnected drive or share, reconnect it and retry instead.',
      );
      await expect(
        window.getByTestId('worktree-discard-dialog-sources'),
      ).toContainText(workspace.repoPath);
      if (checkout === 'present') {
        await expect(
          window.getByTestId('worktree-discard-dialog-targets'),
        ).toContainText(workspace.worktreePath);
      } else {
        await expect(discard).toContainText('Its folders are already gone.');
        await expect(
          window.getByTestId('worktree-discard-dialog-targets'),
        ).toHaveCount(0);
      }
      // The retry-only toast is replaced, not shown beside the dialog.
      await expect(
        window.getByText(
          "Couldn't verify the worktree's source repositories. Check repository access and retry.",
        ),
      ).toHaveCount(0);

      await window.getByTestId('worktree-discard-dialog-cancel').click();
      await expect(discard).toHaveCount(0);
      await expect(row).toBeVisible();

      // Retry runs the ordinary removal again; the source is still gone.
      await requestDelete();
      await expect(discard).toBeVisible({ timeout: 30_000 });
      await window.getByTestId('worktree-discard-dialog-retry').click();
      await expect(discard).toBeVisible({ timeout: 30_000 });
      await expect(row).toBeVisible();
      expect(
        JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees,
      ).toHaveLength(1);

      await window.getByTestId('worktree-discard-dialog-confirm').click();
      await expect(discard).toHaveCount(0, { timeout: 60_000 });
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      expect(existsSync(workspace.worktreePath)).toBe(false);
      expect(JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees).toEqual(
        [],
      );
      renameSync(movedSource, workspace.repoPath);
      execFileSync(
        'git',
        ['rev-parse', '--verify', `refs/heads/${worktree.branchName}`],
        { cwd: workspace.repoPath },
      );
    } finally {
      if (existsSync(movedSource)) renameSync(movedSource, workspace.repoPath);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
