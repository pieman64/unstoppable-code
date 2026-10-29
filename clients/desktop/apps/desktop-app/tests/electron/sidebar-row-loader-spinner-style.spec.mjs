import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  seedChatsSectionFixture,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { evaluateWithSyntheticIpcEvent } from './syntheticIpcEvent.mjs';

/**
 * A running worktree row's loader follows Settings → Labs → Comet spinners in
 * both sidebar styles (see docs/sidebar-worktree-status.md): the dot grid by
 * default, the comet ring with the choice on. Compact rows used to draw the
 * comet whatever the choice.
 *
 * Determinism: no live agent. The seeded chat is marked streaming through a
 * synthetic `runtime.patched` chat state event, as in chat-queue.spec.mjs.
 */

const WORKTREE_ID = 'feature-01';
const CHAT_ID = 'sidebar-loader-chat';

async function markChatStreaming(electronApp) {
  await evaluateWithSyntheticIpcEvent(
    electronApp,
    async ({ ipcMain }, { event, args }) => {
      const state = await ipcMain._invokeHandlers.get('chat:get-state')(event, {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
      });
      event.sender.send('chat:state-changed', {
        projectId: state.projectId,
        worktreeId: state.worktreeId,
        schemaVersion: 1,
        eventId: 'sidebar-loader-streaming',
        occurredAt: new Date().toISOString(),
        baseRevision: state.revision,
        revision: state.revision + 1,
        changes: [
          {
            type: 'runtime.patched',
            chatId: args.chatId,
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
        ],
      });
    },
    {
      projectId: CHATS_SECTION_CODE_WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
    },
  );
}

test('a running worktree row draws its loader in the Labs spinner style', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-row-loader-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
  seedWorktreeChat({
    userDataDir,
    workspaceId: CHATS_SECTION_CODE_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Feed page redesign' }],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1000, height: 800 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const setChoice = (experimentId, enabled) =>
      window.evaluate((choice) => window.api.experiments.setChoice(choice), {
        experimentId,
        enabled,
      });
    await app.openMainPage();
    // Selecting the worktree hydrates its chats before the runtime patch.
    await app.selectWorktree(WORKTREE_ID);
    await markChatStreaming(electronApp);

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    const comet = row.locator('[data-spinner="comet"]');
    const dots = row.locator('.animate-thinking-dot');

    for (const compact of [true, false]) {
      await setChoice('sidebar', compact);
      for (const cometChoice of [false, true]) {
        await setChoice('comet-spinners', cometChoice);
        if (compact) {
          await expect(row.getByTestId('worktree-row-status')).toHaveAttribute(
            'data-row-status',
            'working',
            { timeout: 30_000 },
          );
        }
        if (cometChoice) {
          await expect(comet).toHaveCount(1);
          await expect(dots).toHaveCount(0);
        } else {
          await expect(comet).toHaveCount(0);
          await expect(dots.first()).toBeVisible();
        }
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
