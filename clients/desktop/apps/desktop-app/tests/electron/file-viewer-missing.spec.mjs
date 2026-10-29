import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'missing-file-tab';
const MISSING_FILE = 'does-not-exist.md';

test('file tab shows a clean missing state for a non-existent file', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-missing-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  // Point the tab at a path that is never written to disk, so the
  // `file:read-content` IPC fails with ENOENT.
  const missingPath = path.join(worktreePath, MISSING_FILE);

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: MISSING_FILE,
        kind: 'file',
        filePath: missingPath,
        fileViewMode: 'raw',
        description: missingPath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // The seeded file tab renders as its own 'file-diff' panel.
    const filePanel = window.getByTestId('panel-content-file-diff');
    await expect(filePanel).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-panel-file-${TAB_ID}`),
    ).toBeVisible();

    // Clean empty state, not the raw IPC error.
    const missingState = window.getByTestId('file-viewer-missing');
    await expect(missingState).toBeVisible({ timeout: 15_000 });
    await expect(missingState).toContainText('File does not exist');
    await expect(missingState).toContainText(MISSING_FILE);

    // The raw ENOENT / remote-method error must never surface.
    await expect(filePanel).not.toContainText('ENOENT');
    await expect(filePanel).not.toContainText('file:read-content');

    // A persisted file panel can mount before its owning worktree's tabs
    // hydrate. It should show the neutral loading state during that gap, not
    // briefly claim that the binding was deleted.
    await window.evaluate(() => {
      window.__canopyPanelTestApi.simulateChatHydrationPending();
    });
    await expect(filePanel.getByTestId('panel-binding-loading')).toBeVisible();
    await expect(
      filePanel.getByText('This file is no longer open'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
