import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

/**
 * Tool calls show one row each by default. "Group tool calls" (Settings →
 * Experiments → "Keep chats short while agents work") folds back-to-back
 * calls into one row ("Read 3 files") that opens to each call. It is off by
 * default and independent of "Show only recent steps", which stays off here.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'group-tool-calls-chat';
const TURN_ID = 'group-tool-calls-turn';
const TURN_STARTED_AT = Date.parse('2026-10-22T12:00:00.000Z');

function assistant(id, content) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

function result(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  };
}

test('tool calls show one row each until Group tool calls is on', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-group-tool-calls-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Group tool calls' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const saved = () =>
      window.evaluate(() =>
        window.api.loadPreferences().then((prefs) => ({
          group: prefs.chatGroupToolCallsEnabled,
          recent: prefs.chatLiveStepWindowEnabled,
        })),
      );
    expect(await saved()).toEqual({ group: false, recent: false });

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible();

    const inject = (data) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        providerType: 'claude',
        turnUserMessageId: TURN_ID,
        data: { ...data, canopy_turn_user_message_id: TURN_ID },
      });
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 2,
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Read the icon files' }],
          },
          {
            id: `${TURN_ID}-timer`,
            role: 'system',
            timestamp: TURN_STARTED_AT + 1_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: TURN_STARTED_AT,
                completedAt: null,
              },
            ],
          },
        ],
      },
    });
    await expect(panel.getByText('Read the icon files')).toBeVisible({
      timeout: 30_000,
    });
    for (const file of ['a.ts', 'b.ts', 'c.ts']) {
      const id = `read-${file}`;
      await inject(
        assistant(`${id}-msg`, [
          {
            type: 'tool_use',
            id,
            name: 'Read',
            input: { file_path: `/repo/${file}` },
          },
        ]),
      );
      await inject(result(id));
    }

    // Default: every tool call is its own row.
    const rows = panel.getByTestId('chat-tool-call');
    const groups = panel.getByTestId('chat-tool-step-group');
    await expect(rows).toHaveCount(3);
    await expect(groups).toHaveCount(0);

    // Turning the setting on folds the calls into one row, on its own.
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const toggle = window.getByTestId('chat-group-tool-calls-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(
      window.getByTestId('chat-live-step-window-toggle'),
    ).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(saved).toEqual({ group: true, recent: false });
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(panel).toBeVisible();
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText('Read 3 files');
    await expect(rows).toHaveCount(0);

    // Off again: one row per call.
    await window.evaluate(() =>
      window.api.savePreferences({ chatGroupToolCallsEnabled: false }),
    );
    await expect(groups).toHaveCount(0);
    await expect(rows).toHaveCount(3);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
