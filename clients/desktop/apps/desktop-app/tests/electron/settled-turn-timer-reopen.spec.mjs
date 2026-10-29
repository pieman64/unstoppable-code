// Settled turn timers stay settled (2026-09-30 transcript rewrite storm).
//
// A settled Claude chat's committed turn timer alternated between completed
// and `completedAt: null` for hours: admitted settled-turn follow-ups and
// background-wake revivals reopened it in place, and every flip rewrote the
// whole transcript. The fixture is local and deterministic: the spec opens the
// real worktree chat, settles a turn through main-owned state, then injects
// provider events through the commit-before-broadcast E2E ingress.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'settled-timer-chat';
const TURN_ID = 'settled-timer-turn';

async function openSettledTurn(launched) {
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
  );
  const inject = (event) =>
    injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      ...event,
    });
  await inject({
    turnUserMessageId: TURN_ID,
    data: {
      type: 'canopy_user_prompt',
      original_text: 'Continue',
      canopy_turn_user_message_id: TURN_ID,
    },
  });
  await inject({
    turnUserMessageId: TURN_ID,
    data: {
      type: 'assistant',
      canopy_turn_user_message_id: TURN_ID,
      message: {
        id: 'settled-answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Finished the resumed work.' }],
      },
    },
  });
  await inject({
    turnUserMessageId: TURN_ID,
    data: {
      type: 'result',
      is_error: false,
      result: 'Finished the resumed work.',
      canopy_turn_user_message_id: TURN_ID,
    },
  });
  const timer = panel.locator('[data-testid="turn-timer"]').last();
  await expect(timer).toHaveAttribute('data-state', 'completed', {
    timeout: 15_000,
  });
  await expect(
    panel.getByRole('button', { name: 'Send message' }),
  ).toBeVisible();
  return { window, panel, timer, inject };
}

function seed() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-settled-turn-timer-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Settled timer chat' }],
  });
  return userDataDir;
}

test('a settled-turn follow-up never restarts the completed turn timer', async () => {
  const userDataDir = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const { panel, timer, inject } = await openSettledTurn(launched);
    const completedLabel = await timer
      .locator('[data-testid="turn-timer-label"]')
      .textContent();

    // Admitted as a settled-turn follow-up; the runtime stays settled.
    await inject({
      turnUserMessageId: TURN_ID,
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'settled-session',
        canopy_turn_revival: true,
        canopy_turn_user_message_id: TURN_ID,
      },
    });

    await expect(timer).toHaveAttribute('data-state', 'completed');
    await expect(timer.locator('[data-testid="turn-timer-label"]')).toHaveText(
      completedLabel ?? '',
    );
    await expect(
      panel.getByRole('button', { name: 'Send message' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a background wake shows one live timer and settles it again', async () => {
  const userDataDir = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const { panel, inject } = await openSettledTurn(launched);
    const timers = panel.locator('[data-testid="turn-timer"]');
    await expect(timers).toHaveCount(1);

    // An untagged continuation revives the settled turn.
    await inject({
      data: {
        type: 'assistant',
        message: {
          id: 'background-wake',
          role: 'assistant',
          content: [{ type: 'text', text: 'A background task finished.' }],
        },
      },
    });
    await expect(panel.getByText('A background task finished.')).toBeVisible();
    await expect(timers).toHaveCount(1);
    await expect(timers.last()).not.toHaveAttribute('data-state', 'completed');

    await inject({
      data: {
        type: 'result',
        is_error: false,
        result: 'A background task finished.',
      },
    });
    await expect(timers).toHaveCount(1);
    await expect(timers.last()).toHaveAttribute('data-state', 'completed');
    await expect(
      panel.getByRole('button', { name: 'Send message' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
