import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('a Copilot chat keeps its GitHub identity in the sidebar preview', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'copilot-preview-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'copilot',
    tabs: [{ id: 'copilot-preview', title: 'Copilot review', unread: true }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    const row = window.locator(
      '[data-testid="worktree-row"][data-branch="demo-main"]',
    );
    await expect(row).toBeVisible();
    await row.getByTestId('worktree-row-unread').focus();
    // Home's Continue row also names the chat, so read the popover itself.
    const popover = window
      .getByText('Unread Chats', { exact: true })
      .locator('..');
    const title = popover.getByText('Copilot review', { exact: true });
    await expect(title).toBeVisible();
    // Identify the GitHub mark in the actual preview, so falling
    // through to another provider's logo cannot pass unnoticed.
    await expect(
      title
        .locator('..')
        .locator('svg[data-app-icon="true"][data-glyph="mark-github"]'),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
