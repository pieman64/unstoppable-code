import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

/**
 * Smooth streaming: a streaming reply types in whole
 * words on a steady beat and each new stretch fades in, then settles into
 * plain text. Claude text reaches desktop as whole blocks, so this is how a
 * block appears without an opt-in.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'smooth-streaming-chat';
const STARTED_AT = Date.parse('2026-10-23T12:00:00.000Z');

const REPLY =
  'That message means another process is already listening on the port ' +
  'your dev server wants, usually 3000 or 5173. Most of the time it is an ' +
  'older copy of the same server that never shut down, for example one left ' +
  'running in another terminal tab.';

test('Smooth streaming types a reply in without an opt-in', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-smooth-streaming-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Smooth streaming' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );

    // One running turn; each reply below arrives in it as a whole block.
    const TURN_ID = 'smooth-turn';
    const PROMPT = 'Why is the port busy?';
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(panel).toBeVisible();
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
            timestamp: STARTED_AT,
            blocks: [{ type: 'text', text: PROMPT }],
          },
          {
            id: `${TURN_ID}-timer`,
            role: 'system',
            timestamp: STARTED_AT + 1_000,
            blocks: [
              { type: 'turn_timer', startedAt: STARTED_AT, completedAt: null },
            ],
          },
        ],
      },
    });
    await expect(panel.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

    /** Sends `text` as one assistant block and reports how it appeared. */
    const sendBlock = async (id, text) => {
      // Watch the block arrive: whether its first words were on screen
      // before its last, and the most fading spans at once.
      await window.evaluate(
        ({ selector, first, last }) => {
          const target = document.querySelector(selector);
          const seen = { partial: false, spans: 0 };
          const observer = new MutationObserver(() => {
            const shown = target?.textContent ?? '';
            if (shown.includes(first) && !shown.includes(last)) {
              seen.partial = true;
            }
            seen.spans = Math.max(
              seen.spans,
              target?.querySelectorAll('.stream-word-fade').length ?? 0,
            );
          });
          if (target) {
            observer.observe(target, {
              subtree: true,
              childList: true,
              characterData: true,
            });
          }
          Object.assign(window, { __smoothStreaming: seen });
        },
        {
          selector: `[data-panel-id="panel-chat-${CHAT_ID}"]`,
          first: text.split(' ').slice(0, 3).join(' '),
          last: text.split(' ').slice(-3).join(' '),
        },
      );
      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        providerType: 'claude',
        turnUserMessageId: TURN_ID,
        data: {
          type: 'assistant',
          message: { id, role: 'assistant', content: [{ type: 'text', text }] },
          canopy_turn_user_message_id: TURN_ID,
        },
      });
      await expect(panel.getByText(text)).toBeVisible({ timeout: 30_000 });
      return window.evaluate(() => Reflect.get(window, '__smoothStreaming'));
    };

    const smooth = await sendBlock('smooth-on', REPLY);
    // The block typed in: its first words showed before its last, through
    // fading spans...
    expect(smooth.partial).toBe(true);
    expect(smooth.spans).toBeGreaterThan(0);
    // ...that settle into plain text once the last stretch has faded.
    await expect(panel.locator('.stream-word-fade')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
