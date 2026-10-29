import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'hook-started-chat';
const T = Date.parse('2026-10-07T15:04:00.000Z');

function buildHookChatMessages() {
  return [
    {
      id: 'hook-info',
      role: 'system',
      blocks: [{ type: 'hook_info', triggerName: 'pr:create', timestamp: T }],
      timestamp: T,
    },
    {
      id: 'hook-prompt',
      role: 'user',
      blocks: [{ type: 'text', text: 'Review the new pull request.' }],
      timestamp: T + 1,
    },
    {
      id: 'hook-reply',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The pull request looks ready.' }],
      timestamp: T + 2,
    },
  ];
}

test('the hook name in a hook-started chat opens a Hooks tab beside the chat', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-hook-link-'));
  let launched;
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: TAB_ID,
      tabs: [
        {
          id: TAB_ID,
          title: 'PR Created review',
          messages: buildHookChatMessages(),
        },
      ],
    });
    launched = await launchCanopy({ userDataDir });
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
  const { electronApp } = launched;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${TAB_ID}"]`,
    );
    const banner = chatPanel.getByTestId('chat-hook-info-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('Chat initiated by PR Created hook at');

    const hookName = banner.getByRole('button', { name: 'PR Created' });
    const hooksTab = window.getByTestId('panel-tab-panel-activity-card-hooks');
    const hooksCard = window.getByTestId('activity-card-section-hooks');
    await expect(hooksTab).toHaveCount(0);

    await hookName.click();

    await expect(hooksTab).toBeVisible();
    await expect(hooksCard).toBeVisible();
    const chatBox = await chatPanel.boundingBox();
    const cardBox = await hooksCard.boundingBox();
    expect(chatBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    // The Hooks tab opens in the panel to the right of the chat.
    expect(cardBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 1);

    await window.screenshot({
      path: testInfo.outputPath('hook-chat-banner-hooks-tab.png'),
    });

    // A second click shows the same Hooks tab instead of adding another.
    await hookName.click();
    await expect(hooksTab).toHaveCount(1);
    await expect(hooksCard).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
