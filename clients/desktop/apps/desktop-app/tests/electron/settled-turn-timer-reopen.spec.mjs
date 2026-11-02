// Settled turn timers stay settled (2026-09-30 transcript rewrite storm).
//
// A settled Claude chat's committed turn timer alternated between completed
// and `completedAt: null` for hours: admitted settled-turn follow-ups and
// background-wake revivals reopened it in place, and every flip rewrote the
// whole transcript. The fixture is local and deterministic: the spec opens the
// real worktree chat, settles a turn through main-owned state, then injects
// provider events through the commit-before-broadcast E2E ingress. Canonical
// root turns start and end only from a provider session's lifecycle receipts
// (turn-state phase 35c5d), so the spec publishes those for each turn and wake.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedWorktreeChat,
  turnEventInjector,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'settled-timer-chat';
const TURN_ID = 'settled-timer-turn';
const CHAT_SCOPE = {
  projectId: WORKSPACE_ID,
  worktreeId: WORKTREE_ID,
  chatId: CHAT_ID,
};

/** Publish a wake's own turn start or end, as a Claude session does. */
function publishWake(electronApp, wakeId, phase) {
  return publishTurnLifecycle(electronApp, {
    ...CHAT_SCOPE,
    turnUserMessageId: wakeId,
    phase,
  });
}

// An idle composer offers send, or the microphone in its place once voice
// support is detected and the draft is empty.
async function expectIdleComposer(panel) {
  await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0);
  await expect(
    panel
      .getByRole('button', { name: 'Send message' })
      .or(panel.getByTestId('voice-input-button'))
      .first(),
  ).toBeVisible();
}

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
    injectChatEvent(launched.electronApp, { ...CHAT_SCOPE, ...event });
  const turn = { ...CHAT_SCOPE, turnUserMessageId: TURN_ID };
  const injectTurn = turnEventInjector(launched.electronApp, turn);
  await injectTurn({ type: 'canopy_user_prompt', original_text: 'Continue' });
  await publishTurnLifecycle(launched.electronApp, { ...turn, phase: 'start' });
  await injectTurn({
    type: 'assistant',
    message: {
      id: 'settled-answer',
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished the resumed work.' }],
    },
  });
  await injectTurn({
    type: 'result',
    is_error: false,
    result: 'Finished the resumed work.',
  });
  const timer = panel.locator('[data-testid="turn-timer"]').last();
  await expect(timer).toHaveAttribute('data-state', 'completed', {
    timeout: 15_000,
  });
  await expectIdleComposer(panel);
  return { window, panel, timer, inject, electronApp: launched.electronApp };
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
    await expect(timer.getByTestId('turn-timer-relative')).toBeVisible();
    await expectIdleComposer(panel);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a background wake shows one live timer and settles it again', async () => {
  const userDataDir = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const { panel, inject, electronApp } = await openSettledTurn(launched);
    const timers = panel.locator('[data-testid="turn-timer"]');
    const completedTimers = panel.locator(
      '[data-testid="turn-timer"][data-state="completed"]',
    );
    await expect(timers).toHaveCount(1);

    // A wake is its own turn, closed by its own timer (turn-state phase 40,
    // 40d), so the settled turn's timer stays completed beside it. The
    // session opens the wake's turn before its untagged content arrives.
    // Display placement follows timer anchors, not arrival (phase 40b), so
    // the timers are told apart by state, not position.
    await publishWake(electronApp, 'background-wake-turn', 'start');
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
    await expect(timers).toHaveCount(2);
    await expect(completedTimers).toHaveCount(1);

    await publishWake(electronApp, 'background-wake-turn', 'end');
    await inject({
      data: {
        type: 'result',
        is_error: false,
        result: 'A background task finished.',
      },
    });
    await expect(timers).toHaveCount(2);
    await expect(completedTimers).toHaveCount(2);
    await expectIdleComposer(panel);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a background wake more than a page after the timer resumes and settles it', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-settled-turn-timer-window-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // The turn's prompt and its completed timer sit more than one transcript
  // page (500 rows) before the end, outside the newest-page read window.
  const startedAt = Date.now() - 600_000;
  const steps = Array.from({ length: 520 }, (_, index) => ({
    id: `long-turn-step-${index}`,
    role: 'assistant',
    timestamp: startedAt + 1_000 + index,
    blocks: [{ type: 'text', text: `Long turn step ${index}` }],
  }));
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Settled timer chat',
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: startedAt,
            blocks: [{ type: 'text', text: 'Work through the long task' }],
          },
          {
            id: `${CHAT_ID}:long-turn-timer`,
            role: 'system',
            timestamp: startedAt,
            blocks: [
              {
                type: 'turn_timer',
                startedAt,
                completedAt: startedAt + 2_000,
              },
            ],
          },
          ...steps,
        ],
      },
    ],
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel.getByText('Long turn step 519')).toBeVisible({
      timeout: 30_000,
    });
    const inject = (event) =>
      injectChatEvent(launched.electronApp, { ...CHAT_SCOPE, ...event });

    // A wake more than a page after the settled timer runs as its own turn
    // (turn-state phase 40, 40d): the newest timer, the wake's own, must show
    // live, then settle.
    await publishWake(launched.electronApp, 'window-wake-turn', 'start');
    await inject({
      data: {
        type: 'assistant',
        message: {
          id: 'window-background-wake',
          role: 'assistant',
          content: [{ type: 'text', text: 'A background task finished late.' }],
        },
      },
    });
    await expect(
      panel.getByText('A background task finished late.'),
    ).toBeVisible();
    const timer = panel.locator('[data-testid="turn-timer"]').last();
    await expect(timer).not.toHaveAttribute('data-state', 'completed', {
      timeout: 15_000,
    });

    await publishWake(launched.electronApp, 'window-wake-turn', 'end');
    await inject({
      data: {
        type: 'result',
        is_error: false,
        result: 'A background task finished late.',
      },
    });
    await expect(timer).toHaveAttribute('data-state', 'completed', {
      timeout: 15_000,
    });

    // The settled wake survives a reload.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const reloaded = window
      .locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
      )
      .locator('[data-testid="turn-timer"]')
      .last();
    await expect(reloaded).toHaveAttribute('data-state', 'completed', {
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
