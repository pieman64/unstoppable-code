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
const LANDING_CHAT_ID = 'landing-chat';

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
      {
        id: UNREAD_CHAT_ID,
        title: 'Unread Chat',
        unread: true,
        createdAt: '2026-04-10T12:00:00.000Z',
      },
      // Attention landing (CAN-4957) opens the newest unread chat on entry
      // and marks it read, so this newer one absorbs the landing and the
      // older chat keeps its unread indicator.
      {
        id: LANDING_CHAT_ID,
        title: 'Landing Chat',
        unread: true,
        createdAt: '2026-04-11T12:00:00.000Z',
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
    await expect(
      window.getByTestId(`panel-tab-unread-${LANDING_CHAT_ID}`),
    ).toHaveCount(0);

    const unreadTabIndicator = window.getByTestId(
      `panel-tab-unread-${UNREAD_CHAT_ID}`,
    );
    await expect(unreadTabIndicator).toBeVisible();
    // Fill tabs draw unread as a trailing dot in the unread color.
    const unreadDot = window.getByTestId(
      `panel-tab-unread-dot-${UNREAD_CHAT_ID}`,
    );
    await expect(unreadDot).toBeVisible();
    await expect(unreadDot).toHaveClass(/(^|\s)bg-fg-info(\s|$)/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
