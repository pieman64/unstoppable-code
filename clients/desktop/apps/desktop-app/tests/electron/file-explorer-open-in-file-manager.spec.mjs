import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKTREE_BRANCH = 'demo-main';
const CHAT_TAB_ID = 'file-manager-action-chat';
const FILE_NAME = 'open-in-file-manager-e2e.txt';

test('file explorer reveals the native file-manager action on hover and focus', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-manager-action-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  writeFileSync(
    path.join(worktreePath, FILE_NAME),
    'file manager action e2e\n',
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: CHAT_TAB_ID, title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeVisible();

    const row = window.locator(
      `[data-testid="files-tree-row"][data-path="${FILE_NAME}"]`,
    );
    await expect(row).toBeVisible({ timeout: 20_000 });
    const action = row
      .locator('..')
      .getByTestId('files-tree-row-open-in-file-manager');
    const actionContainer = action.locator(
      'xpath=ancestor::*[contains(@class,"opacity-0")][1]',
    );

    await expect(actionContainer).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(actionContainer).toHaveCSS('opacity', '1');

    await row.focus();
    await expect(actionContainer).toHaveCSS('opacity', '1');
    await action.focus();
    await expect(action).toBeFocused();
    await expect(action).toHaveAttribute(
      'aria-label',
      /Open in (Finder|File Explorer)/,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
