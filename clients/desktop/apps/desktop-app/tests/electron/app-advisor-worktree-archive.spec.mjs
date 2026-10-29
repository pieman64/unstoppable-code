/**
 * CAN-3053 QA: asking App Advisor to archive a worktree opened "Delete
 * worktree?" and nothing in the dialog reflected the requested branch choice,
 * while Advisor told the user to "Choose Archive mode" (the dialog has no mode
 * switch). `worktree.archive` now opens the confirmation in the requested
 * mode and marks the requested item in the confirm button's branch menu; the
 * user still makes the final choice.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function dispatchAdvisorAction(electronApp, requestId, action) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          10_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId,
      originWorktreeId: 'e2e-advisor-entry',
      action,
    },
  );
}

test('App Advisor opens the requested removal mode with the requested branch choice marked', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-worktree-archive-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    await expect(row).toBeVisible();

    // Default mode: the Delete confirmation, with Delete local marked.
    const deleteResponse = await dispatchAdvisorAction(
      electronApp,
      'advisor-worktree-delete-e2e',
      {
        type: 'worktree.archive',
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        deleteBranch: true,
      },
    );
    expect(deleteResponse).toMatchObject({
      ok: true,
      result: { confirmationOpened: true, mode: 'delete' },
    });
    const deleteDialog = window.getByRole('dialog', {
      name: 'Delete worktree?',
    });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText('Advisor suggested Delete local.');
    await expect(
      window.getByTestId('worktree-removal-delete-branch'),
    ).toHaveAttribute('data-requested', 'true');
    await expect(
      window.getByTestId('worktree-removal-preserve-branch'),
    ).not.toHaveAttribute('data-requested', 'true');
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleteDialog).toHaveCount(0);
    await expect(row).toBeVisible();

    // Archive mode: the Archive confirmation, with Preserve local marked. Choosing it archives the worktree.
    const archiveResponse = await dispatchAdvisorAction(
      electronApp,
      'advisor-worktree-archive-e2e',
      {
        type: 'worktree.archive',
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        deleteBranch: false,
        mode: 'archive',
      },
    );
    expect(archiveResponse).toMatchObject({
      ok: true,
      result: { confirmationOpened: true, mode: 'archive' },
    });
    const archiveDialog = window.getByRole('dialog', {
      name: 'Archive worktree?',
    });
    await expect(archiveDialog).toBeVisible();
    await expect(archiveDialog).toContainText(
      'Advisor suggested Preserve local.',
    );
    const preserve = window.getByTestId('worktree-removal-preserve-branch');
    await expect(preserve).toHaveAttribute('data-requested', 'true');
    await expect(
      window.getByTestId('worktree-removal-delete-branch'),
    ).not.toHaveAttribute('data-requested', 'true');
    await preserve.click();
    await expect(archiveDialog).toHaveCount(0);
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
