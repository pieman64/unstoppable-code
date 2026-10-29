import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ACTIVE_CHAT_ID = 'active-chat';
const UNREAD_CHAT_ID = 'unread-chat';

test('unread chat indicators use the blue unread color', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unread-indicator-color-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: ACTIVE_CHAT_ID,
    tabs: [
      { id: ACTIVE_CHAT_ID, title: 'Active Chat' },
      { id: UNREAD_CHAT_ID, title: 'Unread Chat', unread: true },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const unreadTabIndicator = window.getByTestId(
      `panel-tab-unread-${UNREAD_CHAT_ID}`,
    );
    await expect(unreadTabIndicator).toBeVisible();
    await expect(unreadTabIndicator.locator('.fg-info')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
