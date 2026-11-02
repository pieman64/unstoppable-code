import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// "Add workspace" must be refused while a script runs in the source worktree.
//
// Regression: adding a project while the source worktree's setup script was
// still running moved the checkout out from under the script. The script kept
// writing to the old absolute path, the compatibility symlink could not
// replace it, and rollback then deleted the destination holding the only copy
// of the checkout.
//
// Flow: seed two single-repo demo projects, add a slow background script to
// the source project, run it from the Scripts section, then open "Add
// workspace" on the source worktree, pick the other project, and submit. The
// modal must show the running-scripts error and the source row must remain.
// A manually started script uses the same tracked-script registry as the
// automatic setup script.
//
// Determinism: all state is seeded locally, the script uses only the platform
// shell, and no agents or network are involved.

const SOURCE_APP_ID = 'ts-pnpm-vite';
const JOIN_APP_ID = 'go-cli';
const SOURCE_WORKSPACE_ID = `demo-${SOURCE_APP_ID}`;
const JOIN_WORKSPACE_ID = `demo-${JOIN_APP_ID}`;

function seedWithSlowScript(userDataDir) {
  const summary = seedDemoWorkspaces({
    userDataDir,
    apps: [SOURCE_APP_ID, JOIN_APP_ID],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    SOURCE_WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts.slow = {
    command: "printf 'slow-started\\n'; sleep 120",
    timeoutSeconds: 180,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return summary;
}

async function scriptsSection(window) {
  const title = window.getByRole('heading', { name: 'Scripts', exact: true });
  await expect(title).toBeVisible({ timeout: 45_000 });
  const section = title.locator('xpath=ancestor::section[1]');
  const expand = section.locator('[aria-label="Expand section"]');
  if (await expand.count()) await expand.first().click();
  return section;
}

test('refuses to add a project while a source worktree script is running', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-add-repo-running-script-'),
  );
  const summary = seedWithSlowScript(userDataDir);
  const sourceWorkspace = summary.workspaces.find(
    (workspace) => workspace.id === SOURCE_WORKSPACE_ID,
  );
  expect(sourceWorkspace, 'seeded source project').toBeTruthy();
  const sourceWorktreeId = path.basename(sourceWorkspace.worktreePath);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Both seeded worktrees share a branch name; scope to the source section.
    const sourceSection = window
      .locator('section')
      .filter({ has: window.getByText(sourceWorkspace.name) });
    const sourceRow = sourceSection.locator(
      `[data-testid="worktree-row"][data-branch="${sourceWorktreeId}"]`,
    );
    await expect(sourceRow).toBeVisible();
    await sourceRow.click();

    await expandDefaultActivityRail(window);
    const scripts = await scriptsSection(window);
    const slowEntry = scripts
      .getByTestId('activity-scripts-entry')
      .filter({ hasText: 'Slow' });
    await slowEntry.getByTestId('activity-scripts-run').click();
    const confirm = scripts.getByRole('button', { name: 'Confirm' });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(
      scripts
        .getByTestId('activity-scripts-entry')
        .filter({ hasText: 'Slow' })
        .getByTestId('activity-scripts-stop'),
    ).toBeVisible({ timeout: 20_000 });

    await sourceRow.hover();
    await sourceSection.getByTestId('worktree-actions-menu-button').click();
    await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
    await window.getByTestId('worktree-actions-menu-add-repo').click();

    const modal = window.getByTestId('add-repo-to-worktree-modal');
    await expect(modal).toBeVisible();
    const joinOption = modal.getByTestId(
      `add-repo-to-worktree-modal-option-${JOIN_WORKSPACE_ID}`,
    );
    await expect(joinOption).toBeVisible({ timeout: 30_000 });
    await joinOption.click();
    const submit = modal.getByTestId('add-repo-to-worktree-modal-submit');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(
      modal.getByTestId('add-repo-to-worktree-modal-error'),
    ).toContainText(
      'Wait for running scripts, such as setup, to finish before adding a repo to this worktree.',
      { timeout: 30_000 },
    );
    await expect(modal).toBeVisible();
    await expect(sourceRow).toBeVisible();
    expect(
      readFileSync(path.join(sourceWorkspace.worktreePath, '.git'), 'utf8'),
    ).toContain('gitdir:');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
