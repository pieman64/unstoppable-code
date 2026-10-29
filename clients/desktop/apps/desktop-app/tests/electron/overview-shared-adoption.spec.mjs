import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'shared-overview-chat';

test('desktop shared Overview preserves notifications, unread state, and exact chat navigation', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-overview-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Shared Overview Target',
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
    await app.openOverviewPage();

    await expect(window.getByTestId('overview')).toBeVisible();
    await expect(window.getByTestId('overview-notifications')).toBeVisible();
    await expect(window.getByText('No notifications')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: { type: 'result', is_error: false, result: 'Done' },
    });

    const card = window.getByTestId('overview-unread-chat-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Shared Overview Target');
    await expect(
      window.getByTestId('overview-notification-card'),
    ).toBeVisible();
    await expect(window.getByTestId('worktree-row-unread')).toBeVisible();

    // Removing the notification is independent from the chat's unread marker.
    await window.getByTestId('overview-notification-dismiss').click();
    await expect(window.getByTestId('overview-notification-card')).toHaveCount(
      0,
    );
    await expect(card).toBeVisible();
    await expect(window.getByTestId('worktree-row-unread')).toBeVisible();

    // The synthetic shared row retains the original tab route, so selecting it
    // opens the exact desktop tab and marks the worktree read.
    await card.click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(window.getByTestId('overview-page')).toHaveCount(0);
    await expect(window.getByTestId('worktree-row-unread')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
