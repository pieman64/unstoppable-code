import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// "Add project" → Existing Worktrees: join an existing worktree from
// another workspace into an adhoc multi-repo worktree.
//
// Seed: two distinct single-repo demo workspaces (`ts-pnpm-vite` and
// `go-cli` — both "plain-repo" fixtures with no setup/launch scripts, so the
// seeded worktrees stay idle). Each gets the default `demo-main` worktree
// (demo-apps/seed-canopy-data.mjs); in the seeder the worktree id and branch
// share the same name, so both are derived from the seed summary's
// `worktreePath` basename rather than hardcoded.
//
// Flow under test:
//   1. Open the source worktree's actions menu → "Add workspace"
//      (worktree-actions-menu-add-repo) → AddRepoToWorktreeModal.
//   2. Switch to the "Existing worktrees" pill. The picker lazy-loads
//      joinable candidates from the main process (git dirty/branch checks per
//      candidate), so the list assertion uses a generous timeout.
//   3. The other workspace's worktree is listed as a candidate; the source
//      workspace is excluded (a worktree cannot join itself).
//   4. Selecting the candidate enables the "Join worktree" submit. The two
//      repos are distinct, so no overlap warnings render.
//   5. Submitting consumes both originals into a new temporary multi-repo
//      destination worktree: the modal closes, the destination is selected
//      (ChatPanel mounts), and exactly one `demo-main` row remains — the
//      combined worktree under the new temporary workspace section (both
//      original rows are removed; their paths live on as symlinks).
//   6. The temporary project's settings default "Always show project" off so
//      it can leave the sidebar when it no longer has an active worktree.
//
// Determinism: no live agents, no network. The join itself is real git work
// (worktree moves + symlinks) in the per-test CANOPY_DATA_DIR, which is why
// the modal-close wait gets a 60s timeout.

const SOURCE_APP_ID = 'ts-pnpm-vite';
const JOIN_APP_ID = 'go-cli';

test.describe('add project — join existing worktree', () => {
  test('joins another project’s worktree into an adhoc multi-repo worktree', async () => {
    // Launch + two-workspace seed + real git join comfortably exceed the 60s
    // suite default.
    test.setTimeout(180_000);

    const { electronApp, userDataDir, demoSeed } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [SOURCE_APP_ID, JOIN_APP_ID],
    });

    try {
      const sourceWorkspace = demoSeed.workspaces.find(
        (workspace) => workspace.id === `demo-${SOURCE_APP_ID}`,
      );
      const joinWorkspace = demoSeed.workspaces.find(
        (workspace) => workspace.id === `demo-${JOIN_APP_ID}`,
      );
      expect(sourceWorkspace, 'seeded source project').toBeTruthy();
      expect(joinWorkspace, 'seeded join project').toBeTruthy();

      // The seeder names the default worktree directory after its id, which
      // also doubles as the branch name (`demo-main`).
      const sourceBranch = path.basename(sourceWorkspace.worktreePath);
      const joinWorktreeId = path.basename(joinWorkspace.worktreePath);

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await expect(
        app.workspaceHeaderLabel(sourceWorkspace.name),
      ).toBeVisible();
      await expect(app.workspaceHeaderLabel(joinWorkspace.name)).toBeVisible();

      // Both seeded worktrees share the `demo-main` branch, so scope the row
      // to the source workspace's <section> (ProjectSection.tsx renders one
      // section per workspace with the workspace name in its header).
      const sourceSection = window
        .locator('section')
        .filter({ has: window.getByText(sourceWorkspace.name) });
      const sourceRow = sourceSection.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await expect(sourceRow).toBeVisible();

      // The actions trigger lives inside the row's hover-revealed cluster.
      await sourceRow.hover();
      const actionsButton = sourceSection.getByTestId(
        'worktree-actions-menu-button',
      );
      await expect(actionsButton).toBeVisible();
      await actionsButton.click();

      // The menu is portalled to document.body (createPortal in
      // WorktreeItem.tsx), so locate it window-wide.
      await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      await window.getByTestId('worktree-actions-menu-add-repo').click();

      const modal = window.getByTestId('add-repo-to-worktree-modal');
      await expect(modal).toBeVisible();

      // Switch to the Existing Worktrees mode. The candidate list is loaded
      // lazily on first switch and the backend runs per-candidate git checks,
      // so allow extra time for the picker to replace the loading card.
      await modal
        .getByTestId('add-repo-to-worktree-modal-pill-existing')
        .click();
      const pickerList = window.getByTestId('existing-worktree-picker-list');
      await expect(pickerList).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId('add-repo-to-worktree-modal-existing-empty'),
      ).toHaveCount(0);

      // The other workspace's group + candidate are offered; the source
      // workspace is excluded from its own join picker.
      await expect(
        pickerList.getByTestId(
          `existing-worktree-picker-group-${joinWorkspace.id}`,
        ),
      ).toBeVisible();
      const candidateOption = pickerList.getByTestId(
        `existing-worktree-picker-option-${joinWorkspace.id}-${joinWorktreeId}`,
      );
      await expect(candidateOption).toBeVisible();
      await expect(candidateOption).toBeEnabled();
      await expect(
        pickerList.locator(
          `[data-testid^="existing-worktree-picker-group-${sourceWorkspace.id}"]`,
        ),
      ).toHaveCount(0);
      await expect(
        pickerList.locator(
          `[data-testid^="existing-worktree-picker-option-${sourceWorkspace.id}-"]`,
        ),
      ).toHaveCount(0);

      // Select the candidate. The two workspaces hold distinct repos, so no
      // repo-overlap warnings should render for this selection.
      await candidateOption.click();
      await expect(candidateOption).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId('add-repo-to-worktree-modal-overlap-warnings'),
      ).toHaveCount(0);

      const submitButton = window.getByTestId(
        'add-repo-to-worktree-modal-submit',
      );
      await expect(submitButton).toBeEnabled();
      await expect(submitButton).toHaveText('Join worktree');
      await submitButton.click();

      // The join does real git work (moves both worktrees into the new
      // destination and creates compatibility symlinks) before the modal
      // closes on success — allow up to 60s.
      await expect(modal).toHaveCount(0, { timeout: 60_000 });
      await expect(
        window.getByTestId('add-repo-to-worktree-modal-error'),
      ).toHaveCount(0);

      // On success the modal selects the destination worktree, which mounts
      // the combined worktree's chat panels (one per merged chat tab — hidden
      // siblings stay mounted, so assert the VISIBLE active-tab panel).
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({
        timeout: 30_000,
      });

      // Both original `demo-main` rows are consumed; the only remaining row
      // with that branch is the combined destination worktree in the new
      // temporary multi-repo workspace section. (The original source section
      // can't be re-asserted by name here: the temporary project's derived
      // display name is built from the joined repo names, so a name-scoped
      // section filter would now match both sections.)
      const branchRows = window.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await expect(branchRows).toHaveCount(1, { timeout: 30_000 });

      const temporarySection = branchRows.locator('xpath=ancestor::section[1]');
      const temporaryHeader = temporarySection.locator(
        '[data-testid^="sidebar-project-header-"]',
      );
      await temporaryHeader.hover();
      await temporarySection
        .getByRole('button', { name: /^Settings for / })
        .click();

      const settingsDialog = window
        .locator('[role="dialog"]')
        .filter({ has: window.locator('#workspace-settings-title') });
      await expect(settingsDialog).toBeVisible();
      await settingsDialog.getByRole('tab', { name: 'General' }).click();
      await expect(
        settingsDialog.getByRole('switch', { name: 'Always show project' }),
      ).not.toBeChecked();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
