import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

// ---------------------------------------------------------------------------
// CAN-2307 — a completed turn must never show only its completion timer.
//
// Durable regression spec. Before this change a provider could report a turn
// complete having produced nothing, and the chat rendered that as an ordinary
// success: a "Completed in M:SS" row and no other trace. Main now marks that
// turn `empty_completion` with an `emptyCompletionRecovery` record, and the
// composer renders the recovery state instead.
//
// What this drives, end to end through the real canonical ingress:
//
//   (a) user prompt opens the turn, terminal event closes it with no assistant
//       output -> the recovery notice appears with Resume, Try again, and
//       Report bug.
//   (b) Report bug opens the feedback form already set to Bug, so the user is
//       not re-classifying the failure they just hit.
//   (c) late assistant output for the SAME turn reconciles it: the notice
//       retires on its own, with no user action, and the turn reads as the
//       success it actually was.
//   (d) Resume dispatches the continuation nudge into the same chat without
//       the user retyping anything.
//   (e) a turn that started a command before ending empty keeps Resume but
//       blocks Try again, so re-sending cannot repeat the side effect. The
//       command must be ingested after the prompt event (see openEmptyTurn).
//
// Determinism: no live agents, no network. Every event goes through the
// E2E chat-event ingress (`__CANOPY_E2E_INGEST_CHAT_EVENT__`), which commits
// through `ChatStateService` exactly as a real provider session does, so the
// empty-completion verdict here is main's real one.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'can-2307-empty-completion';
const TURN_ID = 'can-2307-turn-user';
const PROMPT_TEXT = 'Summarize the parser changes.';
const LATE_OUTPUT = 'Here is the summary that arrived late.';

function seedEmptyTurnChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Empty completion',
        providerType: 'codex',
        model: 'gpt-6-sol',
        // The turn's own user message, and nothing after it: exactly the shape
        // main classifies as a completed turn with no visible output.
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: Date.parse('2026-09-17T12:00:00.000Z'),
            blocks: [{ type: 'text', text: PROMPT_TEXT }],
          },
        ],
      },
    ],
  });
}

async function openEmptyTurn(electronApp, window, { ranTool = false } = {}) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();

  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    providerType: 'codex',
    turnUserMessageId: TURN_ID,
    data: {
      type: 'canopy_user_prompt',
      canopy_turn_user_message_id: TURN_ID,
    },
  });
  if (ranTool) {
    // The command starts inside the turn the prompt just opened and never
    // reports back: a bare tool call with no result, which is not visible
    // output, so main still settles the turn as empty. It must be ingested
    // after the prompt event, as a real provider emits it. A tool row seeded
    // ahead of that event sits before the turn, because the event moves an
    // already-persisted prompt to the transcript tail.
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      providerType: 'codex',
      turnUserMessageId: TURN_ID,
      data: {
        type: 'codex',
        canopy_turn_user_message_id: TURN_ID,
        event: {
          type: 'item.started',
          item: {
            id: 'can-2307-side-effect',
            type: 'command_execution',
            command: 'deploy',
            status: 'inProgress',
          },
        },
      },
    });
  }
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    providerType: 'codex',
    turnUserMessageId: TURN_ID,
    data: {
      type: 'codex',
      canopy_turn_user_message_id: TURN_ID,
      event: { type: 'turn.completed' },
    },
  });
}

test('a completed turn with no output shows the recovery state, not a success', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2307-empty-'),
  );
  seedEmptyTurnChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openEmptyTurn(electronApp, window);

    const notice = window.getByTestId('empty-completion-recovery');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('No response for this turn');

    // All three recovery actions the ticket names.
    await expect(
      window.getByTestId('empty-completion-recovery-resume'),
    ).toBeVisible();
    await expect(
      window.getByTestId('empty-completion-recovery-retry'),
    ).toBeVisible();
    await expect(
      window.getByTestId('empty-completion-recovery-report'),
    ).toBeVisible();

    // Report bug lands on the bug form rather than the default Idea form.
    await window.getByTestId('empty-completion-recovery-report').click();
    await expect(window.getByTestId('feedback-modal')).toBeVisible();
    await expect(window.getByTestId('feedback-modal-type-bug')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await window.getByTestId('feedback-modal-cancel').click();
    await expect(window.getByTestId('feedback-modal')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Try again is blocked when the empty turn may already have run a side effect', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2307-tool-safety-'),
  );
  seedEmptyTurnChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openEmptyTurn(electronApp, window, { ranTool: true });

    const notice = window.getByTestId('empty-completion-recovery');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('may repeat what it already did');
    await expect(
      window.getByTestId('empty-completion-recovery-retry'),
    ).toBeDisabled();
    await expect(
      window.getByTestId('empty-completion-recovery-resume'),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('late output for the same turn reconciles it and retires the recovery state', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2307-late-'),
  );
  seedEmptyTurnChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openEmptyTurn(electronApp, window);

    const notice = window.getByTestId('empty-completion-recovery');
    await expect(notice).toBeVisible({ timeout: 15_000 });

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      providerType: 'codex',
      turnUserMessageId: TURN_ID,
      data: {
        type: 'codex',
        canopy_turn_user_message_id: TURN_ID,
        event: {
          type: 'item.started',
          item: { id: 'can-2307-late-command', type: 'command_execution' },
        },
      },
    });

    // Lifecycle metadata alone is not recovered output. Keep the notice until
    // the late event actually adds something visible to this turn.
    await expect(notice).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      providerType: 'codex',
      turnUserMessageId: TURN_ID,
      data: {
        type: 'assistant',
        canopy_turn_user_message_id: TURN_ID,
        message: {
          id: 'can-2307-late-message',
          role: 'assistant',
          content: [{ type: 'text', text: LATE_OUTPUT }],
        },
      },
    });

    await expect(notice).toBeHidden({ timeout: 15_000 });
    await expect(
      window.getByTestId('panel-content-chat').getByText(LATE_OUTPUT),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Resume sends the continuation nudge without the user retyping anything', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2307-resume-'),
  );
  seedEmptyTurnChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openEmptyTurn(electronApp, window);

    const notice = window.getByTestId('empty-completion-recovery');
    await expect(notice).toBeVisible({ timeout: 15_000 });

    await window.getByTestId('empty-completion-recovery-resume').click();

    // The nudge is dispatched as a real user turn, so it lands in the
    // transcript; the recovery state retires because a new turn has started.
    await expect(
      window.getByTestId('panel-content-chat').getByText('Continue').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(notice).toBeHidden({ timeout: 20_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Try again re-sends the original prompt without the user retyping it', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2307-retry-'),
  );
  seedEmptyTurnChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openEmptyTurn(electronApp, window);

    const notice = window.getByTestId('empty-completion-recovery');
    await expect(notice).toBeVisible({ timeout: 15_000 });

    await window.getByTestId('empty-completion-recovery-retry').click();

    // The original seeded row remains and the explicit retry creates a second
    // user row with the exact same prompt, without touching the composer.
    await expect(
      window.getByTestId('panel-content-chat').getByText(PROMPT_TEXT),
    ).toHaveCount(2, { timeout: 20_000 });
    await expect(notice).toBeHidden({ timeout: 20_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
