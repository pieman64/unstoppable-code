import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// CAN-3039 — archiving/deleting a sidebar chat whose worktree was deleted
// outside the app (e.g. `rm -rf` or `git worktree remove` from a terminal).
//
// Reported symptom: both actions failed with
// "An incomplete archived Git capture requires recovery." — main had staged a
// Git capture for that worktree and the checkout it needed to finish the
// capture was gone.
//
// Desired behaviour, per action:
//   - Archive → succeeds and retains the container. The staged Git capture
//     stays pinned; it lives OUTSIDE the deleted folder and may be the last
//     copy of uncommitted work from that worktree.
//   - Delete  → succeeds and retains nothing, releasing the staged capture.
//     The user asked to delete, so that is what they meant.
// Neither action surfaces a message about the missing Git state.
//
// The renderer sends Delete intent down the archive IPC, and main verifies the
// path is still missing before selecting the non-retained path. This spec
// drives the real sidebar row menu and asserts the retained-container outcome
// on disk.
//
// Determinism: no live agents, no network, no PTY. The workspace is the plain
// `ts-pnpm-vite` demo fixture. It launches healthy so boot recovery leaves the
// row alone; the test then stages a real pinned `capturing` descriptor and
// removes the checkout while the app is running. The normal sidebar health
// poll detects that state before either action is invoked.
// ---------------------------------------------------------------------------

const WORKTREE_BRANCH = 'demo-main';
const STAGED_ERROR = 'An incomplete archived Git capture requires recovery.';

// Backend leg A: exercise the real preload/IPC transport, not the renderer's
// removal handler (its pre-IPC effects are separately owned by leg B).
for (const missingCheckout of [false, true]) {
  test(`CAN-5158: source refusal through IPC can retry (missing checkout: ${missingCheckout})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can5158-'));
    const { workspace, worktree, worktreesPath, containerManifestPath } =
      seedWorktree(userDataDir);
    const hiddenSource = `${workspace.repoPath}-unavailable`;
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      if (missingCheckout) rmSync(workspace.worktreePath, { recursive: true });
      const readRemovalState = () => {
        const file = JSON.parse(readFileSync(worktreesPath, 'utf8'));
        // Launch backfill/chat commits independently update badges. Compare
        // every other row and envelope field, including removal/recovery state.
        for (const row of file.worktrees) delete row.chatBadges;
        return file;
      };
      const before = readRemovalState();
      const journals = path.join(userDataDir, 'w5', 'destructive-lifecycles');
      const readJournals = () =>
        existsSync(journals)
          ? readdirSync(journals)
              .sort()
              .map((name) => [
                name,
                readFileSync(path.join(journals, name), 'utf8'),
              ])
          : [];
      const beforeJournals = readJournals();
      renameSync(workspace.repoPath, hiddenSource);
      const request = {
        projectId: workspace.id,
        worktreeId: worktree.id,
        repoPath: workspace.repoPath,
        expectedCreatedAt: worktree.createdAt,
        deleteBranch: false,
        deleteWithoutRetentionIfMissing: missingCheckout,
      };
      const refusal = await window.evaluate(async (request) => {
        try {
          await window.api.archiveWorktree(request);
          return null;
        } catch (error) {
          return String(error);
        }
      }, request);
      expect(refusal).toContain(
        "Couldn't verify the worktree's source repositories. Check repository access and retry.",
      );
      expect(readRemovalState()).toEqual(before);
      expect(readJournals()).toEqual(beforeJournals);
      expect(existsSync(containerManifestPath)).toBe(false);
      expect(existsSync(workspace.worktreePath)).toBe(!missingCheckout);

      renameSync(hiddenSource, workspace.repoPath);
      expect(
        await window.evaluate(
          (request) => window.api.archiveWorktree(request),
          request,
        ),
      ).toMatchObject({ success: true });
      expect(JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees).toEqual(
        [],
      );
      expect(existsSync(containerManifestPath)).toBe(!missingCheckout);
      expect(existsSync(workspace.worktreePath)).toBe(false);
      expect(
        gitRefExists(workspace.repoPath, `refs/heads/${worktree.branchName}`),
      ).toBe(true);
    } finally {
      if (existsSync(hiddenSource))
        renameSync(hiddenSource, workspace.repoPath);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

/** Seed a live worktree that the test will delete outside the running app. */
function seedWorktree(userDataDir) {
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = workspaces[0];
  expect(workspace?.worktreePath, 'seeded worktree path').toBeTruthy();

  const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);

  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  const worktreesFile = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  const worktree = worktreesFile.worktrees[0];

  return {
    workspace,
    worktree,
    worktreesPath,
    containerManifestPath: path.join(
      workspaceDir,
      'archived-containers',
      worktree.id,
      'container.json',
    ),
  };
}

function stageIncompleteGitCapture(userDataDir, workspace, worktree) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspace.worktreePath,
    encoding: 'utf8',
  }).trim();
  const snapshotRef = `refs/app/archived-containers/${workspace.id}/${worktree.id}/__single_repo__`;
  execFileSync('git', ['update-ref', snapshotRef, commit], {
    cwd: workspace.repoPath,
  });

  const archiveDir = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'archived-containers',
    worktree.id,
  );
  mkdirSync(archiveDir, { recursive: true });
  const stagedPath = path.join(archiveDir, 'git-state.staged.json');
  writeFileSync(
    stagedPath,
    JSON.stringify({
      version: 1,
      status: 'capturing',
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: path.basename(workspace.repoPath),
          relativePath: '.',
          referenceRepoPath: workspace.repoPath,
          comparisonBaseCommit: commit,
          headCommit: commit,
          indexSnapshotCommit: commit,
          worktreeSnapshotCommit: commit,
          snapshotRef,
        },
      ],
    }),
    'utf8',
  );

  return { snapshotRef, stagedPath };
}

function gitRefExists(repoPath, refName) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', refName], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

for (const removal of [
  {
    mode: 'archive',
    menuTestId: 'worktree-actions-menu-archive',
    dialogName: /^Archive worktree/,
    confirmLabel: 'Archive worktree',
    branchChoiceTestId: 'worktree-removal-preserve-branch',
    keepBranch: true,
    // Archive retains, so anything still pinned for this worktree survives.
    expectRetainedContainer: true,
  },
  {
    mode: 'delete',
    menuTestId: 'worktree-actions-menu-delete',
    dialogName: /^Delete worktree/,
    confirmLabel: 'Delete worktree',
    branchChoiceTestId: 'worktree-removal-delete-branch',
    keepBranch: false,
    // Nothing is restorable, so Delete retains nothing and main is authorized
    // to release the pinned capture along with the row.
    expectRetainedContainer: false,
  },
]) {
  test(`CAN-3039: ${removal.mode} succeeds for a worktree deleted outside the app`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-can3039-${removal.mode}-`),
    );
    const { workspace, worktree, worktreesPath, containerManifestPath } =
      seedWorktree(userDataDir);
    expect(existsSync(containerManifestPath)).toBe(false);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      const { snapshotRef, stagedPath } = stageIncompleteGitCapture(
        userDataDir,
        workspace,
        worktree,
      );
      expect(existsSync(stagedPath)).toBe(true);
      expect(gitRefExists(workspace.repoPath, snapshotRef)).toBe(true);

      // Delete the checkout outside the app, exactly as the reporter did, and
      // run the same health check the sidebar uses. Headless windows pause the
      // periodic poll while hidden, so deliver its authoritative row through
      // the existing main-to-renderer worktree-update seam.
      rmSync(workspace.worktreePath, { recursive: true, force: true });
      const health = await window.evaluate(
        async ({ projectId, worktreeId }) =>
          window.api.retryWorktreeHealthCheck({ projectId, worktreeId }),
        { projectId: workspace.id, worktreeId: worktree.id },
      );
      expect(health).toMatchObject({
        healthy: false,
        issue: { code: 'missing-worktree-path' },
      });
      await electronApp.evaluate(
        ({ BrowserWindow }, event) => {
          const mainWindow = BrowserWindow.getAllWindows()[0];
          if (!mainWindow) throw new Error('Missing main window');
          mainWindow.webContents.send('workspace:worktrees-updated', event);
        },
        { workspaceId: workspace.id, worktree: health.worktree },
      );
      await expect(
        row.getByLabel('Worktree issue - click for details'),
      ).toBeVisible();

      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      await window.getByTestId(removal.menuTestId).click();

      const dialog = window.getByRole('dialog', { name: removal.dialogName });
      await expect
        .poll(
          async () => (await dialog.isVisible()) || (await row.count()) === 0,
        )
        .toBe(true);

      // Delete may take the existing safe-delete bypass when the last clean
      // diff result is still cached. Archive always confirms. When a dialog is
      // present, its Keep the local branch switch picks the branch handling
      // and its one action commits the removal.
      if (await dialog.isVisible()) {
        if (!removal.keepBranch) {
          await dialog.getByTestId('worktree-removal-keep-branch').click();
        }
        await window.getByTestId(removal.branchChoiceTestId).click();
      }

      // The row goes away and the reported error never surfaces.
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect(window.getByText(STAGED_ERROR)).toHaveCount(0);

      await expect
        .poll(
          () =>
            JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.length,
          { timeout: 30_000 },
        )
        .toBe(0);

      // The load-bearing difference between the two actions. Asserted before
      // `closeCanopy` removes the data directory.
      await expect
        .poll(() => existsSync(containerManifestPath), { timeout: 30_000 })
        .toBe(removal.expectRetainedContainer);
      expect(existsSync(stagedPath)).toBe(removal.expectRetainedContainer);
      expect(gitRefExists(workspace.repoPath, snapshotRef)).toBe(
        removal.expectRetainedContainer,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
