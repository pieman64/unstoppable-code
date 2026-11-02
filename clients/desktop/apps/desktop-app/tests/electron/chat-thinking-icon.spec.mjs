import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

/**
 * Thinking reads as the lightbulb in the shipped Clean chat look, with
 * Detailed selected so the individual thinking row can be inspected. The brain glyph stays for the
 * composer's thinking-effort control only.
 *
 * Determinism: a seeded transcript, no live agent, no network.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'chat-thinking-icon';
const T = Date.parse('2026-10-23T12:00:00.000Z');

test('the default chat look marks thinking with the lightbulb', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-thinking-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Thinking icon',
        messages: [
          {
            id: 'user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Add the robot glyph' }],
            timestamp: T,
          },
          {
            id: 'think',
            role: 'assistant',
            blocks: [
              { type: 'thinking', text: 'The manifest needs a custom entry.' },
            ],
            timestamp: T + 1_000,
          },
          {
            id: 'answer',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Added the robot glyph.' }],
            timestamp: T + 2_000,
          },
          {
            id: 'timer',
            role: 'system',
            blocks: [
              { type: 'turn_timer', startedAt: T, completedAt: T + 3_000 },
            ],
            timestamp: T + 3_000,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Inspect individual steps without changing the product's Recent default.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel.getByText('Added the robot glyph.')).toBeVisible();
    const opener = panel.getByRole('button', { name: /^Agent steps:/ });
    if ((await opener.getAttribute('aria-expanded')) !== 'true') {
      await opener.click();
    }
    const row = panel.getByRole('button', { name: /^Thought/ });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-glyph="lightbulb"]')).toHaveCount(1);
    await expect(panel.locator('[data-glyph="brain-circuit"]')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
