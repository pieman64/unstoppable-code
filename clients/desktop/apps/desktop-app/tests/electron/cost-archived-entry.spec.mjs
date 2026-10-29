// Observed cost survives worktree archive, retained viewing, restore, and
// permanent deletion. Live totals are first built from seeded audit day files
// by the ordinary Cost panel refresh, then the archive lifecycle owns the
// sealed and restored data.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCostInsights } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

test('archived cost is sealed, restored unchanged, and removed on permanent delete', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cost-archive-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    earlyAccess: true,
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  try {
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await window.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu')
      .getByTestId('panel-add-menu-item-cost')
      .click();
    await expect(
      window.getByTestId('panel-content-cost').getByTestId('cost-total'),
    ).toContainText(cost.expected.scopeTotal);
    const liveRunRowText = await window
      .getByTestId('panel-content-cost')
      .getByTestId(`cost-run-row-${cost.ids.rootExecution}`)
      .textContent();

    const worktreeRow = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    await expect(worktreeRow).toBeVisible();
    // With Early access on, the row's full menu opens on right-click.
    await worktreeRow.click({ button: 'right' });
    await window.getByTestId('worktree-actions-menu-archive').click();
    const archiveDialog = window.getByRole('dialog', {
      name: 'Archive worktree?',
    });
    await expect(archiveDialog).toBeVisible();
    await archiveDialog.getByTestId('worktree-removal-preserve-branch').click();
    await expect(worktreeRow).toHaveCount(0, { timeout: 60_000 });

    const archivedLink = window.getByTestId(
      `sidebar-project-${WORKSPACE_ID}-archived-link`,
    );
    await expect(archivedLink).toBeVisible({ timeout: 60_000 });
    await archivedLink.click();
    const archivedRow = window.getByTestId(
      `archived-overview-row-${WORKTREE_ID}`,
    );
    await expect(archivedRow).toBeVisible({ timeout: 30_000 });
    await expect(
      archivedRow.getByTestId('archived-overview-row-cost'),
    ).toContainText(cost.expected.scopeTotal);
    await window.getByTestId(`archived-overview-open-${WORKTREE_ID}`).click();

    const viewer = window.getByTestId('archived-container-view');
    await expect(viewer).toBeVisible();
    const tabs = viewer.getByTestId(/^archived-container-tab-/);
    await expect(tabs.first()).toHaveAttribute(
      'data-testid',
      'archived-container-tab-cost',
    );
    const costTab = viewer.getByTestId('archived-container-tab-cost');
    await costTab.click();
    const retained = viewer.getByTestId('retained-cost-view');
    await expect(retained).toBeVisible();
    await expect(retained.getByTestId('cost-total')).toContainText(
      cost.expected.scopeTotal,
    );
    await expect(retained).toContainText('Final as of');
    await expect(retained.getByTestId('cost-refresh')).toHaveCount(0);
    // The sealed run keeps its start time and total.
    await expect(
      retained.getByTestId(`cost-run-row-${cost.ids.rootExecution}`),
    ).toHaveText(liveRunRowText ?? '');
    const archivedChatRow = retained.getByTestId(
      `cost-chat-row-${cost.ids.archivedChat}`,
    );
    await expect(archivedChatRow).toContainText(
      cost.expected.chats[cost.ids.archivedChat],
    );
    await archivedChatRow.click();
    const breakdown = retained.getByTestId('session-breakdown-view');
    await expect(breakdown).toBeVisible();
    await expect(breakdown).toContainText('Final as of');
    await expect(
      breakdown.getByTestId('session-breakdown-observed-total'),
    ).toContainText(cost.expected.chats[cost.ids.archivedChat]);

    await viewer.getByTestId('archived-restore').click();
    await expect(viewer).toHaveCount(0, { timeout: 90_000 });
    const restoredWorktrees = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'),
        'utf8',
      ),
    ).worktrees.filter((worktree) => worktree.id !== WORKTREE_ID);
    expect(restoredWorktrees).toHaveLength(1);
    const restoredWorktreeId = restoredWorktrees[0].id;
    await app.selectWorktree(restoredWorktreeId);
    if ((await window.getByTestId('panel-content-cost').count()) === 0) {
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window
        .getByTestId('panel-add-menu')
        .getByTestId('panel-add-menu-item-cost')
        .click();
    } else {
      await window.getByTestId('panel-tab-panel-cost').click();
    }
    await expect(
      window.getByTestId('panel-content-cost').getByTestId('cost-total'),
    ).toContainText(cost.expected.scopeTotal);

    const restoredRow = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${restoredWorktreeId}"]`,
    );
    await restoredRow.click({ button: 'right' });
    await window.getByTestId('worktree-actions-menu-delete').click();
    const deleteDialog = window.getByRole('dialog', {
      name: 'Delete worktree?',
    });
    const needsConfirmation = await deleteDialog
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (needsConfirmation) {
      await deleteDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
    }
    await expect(restoredRow).toHaveCount(0, { timeout: 60_000 });

    const restoredArchivedLink = window.getByTestId(
      `sidebar-project-${WORKSPACE_ID}-archived-link`,
    );
    await restoredArchivedLink.click();
    await window
      .getByTestId(`archived-overview-open-${restoredWorktreeId}`)
      .click();
    const deletedViewer = window.getByTestId('archived-container-view');
    await expect(deletedViewer).toBeVisible();
    await deletedViewer.getByTestId('archived-delete-permanently').click();
    await deletedViewer.getByRole('button', { name: 'Delete?' }).click();
    await expect(deletedViewer).toHaveCount(0, { timeout: 60_000 });

    const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    for (const costPath of [
      path.join(workspaceDir, 'cost', WORKTREE_ID),
      path.join(workspaceDir, 'archived-containers', WORKTREE_ID, 'cost'),
      path.join(workspaceDir, 'cost', restoredWorktreeId),
      path.join(
        workspaceDir,
        'archived-containers',
        restoredWorktreeId,
        'cost',
      ),
    ]) {
      expect(
        existsSync(costPath),
        `cost data directory should be removed: ${costPath}`,
      ).toBe(false);
    }
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
