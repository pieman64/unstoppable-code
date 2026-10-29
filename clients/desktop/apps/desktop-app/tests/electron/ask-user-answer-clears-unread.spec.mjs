import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Unread raised by an ask-user question settles once the question is answered.
//
// Walks the reachable desktop flow end to end: a persisted pending question on
// a background tab hydrates into the orange question dot on the worktree row
// (the question outranks the blue unread dot in the row cluster, so a sibling
// tab's completed-turn unread is hidden behind it); the user opens the tab and
// answers the real `AskUserQuestionCard`; the question dot is gone and the
// row now shows the sibling's blue unread dot, which the answer must not have
// cleared. A relaunch on the same user data then proves the read state was
// relayed to main (`chat.mark_read`) rather than living only in the renderer,
// which is how a "sticking" dot would resurrect.
//
// Determinism: seeded persisted state only. The restore path keeps the open
// ask-user `tool_use` alive because the chat carries an unanswered
// `pendingQuestions` entry (see `injectApprovalRequestEvent.mjs`), and main
// registers that persisted question's scope on load, so the card's Submit
// runs the real `mcp:answer-user` IPC and the real chat-state command. No live
// agent, no network.
//
// Not covered here, by design: an answer that arrives while the tab stays in
// the background (the Portal/mobile path). The desktop UI has no way to answer
// a question without opening its tab, which marks the tab read on its own; the
// store-level ordering rules for that path (`clears the unread the live
// question raised on a background tab once it is answered`, sibling and
// dismissal cases) live in `chatStore.unread-after-answer.test.ts`.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

const ACTIVE_TAB = 'chat-active';
const QUESTION_TAB = 'chat-question';
const TURN_TAB = 'chat-turn';

const REQUEST_ID = 'seeded-unread-question';
const TOOL_USE_ID = 'ask-ship-1';
const QUESTION = 'Ship the change now?';
const CHOSEN_OPTION = 'Yes';

function seedChats(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: ACTIVE_TAB,
    tabs: [
      {
        id: ACTIVE_TAB,
        title: 'Active chat',
        messages: [
          {
            id: 'active-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep going here.' }],
            timestamp: Date.parse('2026-09-07T12:00:00.000Z'),
          },
        ],
      },
      {
        id: QUESTION_TAB,
        title: 'Asked chat',
        messages: [
          {
            id: 'question-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Prepare the release.' }],
            timestamp: Date.parse('2026-09-07T12:01:00.000Z'),
          },
          {
            id: 'question-assistant-1',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: TOOL_USE_ID,
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({
                  questions: [{ question: QUESTION, options: ['Yes', 'No'] }],
                }),
              },
            ],
            timestamp: Date.parse('2026-09-07T12:02:00.000Z'),
          },
        ],
      },
      {
        id: TURN_TAB,
        title: 'Finished chat',
        unread: true,
        messages: [
          {
            id: 'turn-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Summarize the diff.' }],
            timestamp: Date.parse('2026-09-07T12:03:00.000Z'),
          },
          {
            id: 'turn-assistant-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Two files changed.' }],
            timestamp: Date.parse('2026-09-07T12:04:00.000Z'),
          },
        ],
      },
    ],
    pendingQuestions: [
      {
        requestId: REQUEST_ID,
        chatId: QUESTION_TAB,
        toolUseId: TOOL_USE_ID,
        questions: [
          {
            id: 'ship',
            question: QUESTION,
            options: ['Yes', 'No'],
            multiSelect: false,
          },
        ],
      },
    ],
  });
}

async function openSeededWorktree(electronApp, activeTabId) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
  await app.selectWorktree(WORKTREE_BRANCH);
  // Every chat tab mounts its own panel content; the active one is visible.
  await expect(
    window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${activeTabId}"]`,
    ),
  ).toBeVisible();
  const row = window.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
  );
  await expect(row).toBeVisible();
  return { window, row };
}

test("answering a background question through its card clears the question dot and that tab's unread, keeps a completed-turn unread, and stays cleared after a relaunch", async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ask-user-answer-unread-'),
  );
  seedChats(userDataDir);

  const first = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openSeededWorktree(
      first.electronApp,
      ACTIVE_TAB,
    );

    // Hydration raises the question: the orange dot owns the row cluster and
    // hides the blue dot the sibling's completed-turn unread would show. That
    // sibling still carries its own tab badge.
    await expect(row.getByTestId('worktree-row-question')).toBeVisible({
      timeout: 10_000,
    });
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${TURN_TAB}`),
    ).toBeVisible();

    // Open the asked tab and answer in the composer's question prompt: a
    // choice answers as soon as it is clicked.
    await window.getByTestId(`panel-tab-panel-chat-${QUESTION_TAB}`).click();
    const card = window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card
      .getByRole('button', { name: CHOSEN_OPTION, exact: true })
      .click();

    // The question is settled: no card, no orange dot, no unread on that tab.
    await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(row.getByTestId('worktree-row-question')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${QUESTION_TAB}`),
    ).toHaveCount(0);
    // A completed turn's unread is never an answer's to clear: with the
    // question gone, the sibling's blue dot surfaces on the row.
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-unread-${TURN_TAB}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // Durable read state: the relaunch must not resurrect the question dot or
  // the answered tab's unread, while the completed-turn unread persists.
  const second = await launchCanopy({ userDataDir });
  try {
    // The answered tab stayed active when the first launch closed.
    const { window, row } = await openSeededWorktree(
      second.electronApp,
      QUESTION_TAB,
    );
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      window.getByTestId(`panel-tab-unread-${TURN_TAB}`),
    ).toBeVisible();
    await expect(row.getByTestId('worktree-row-question')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${QUESTION_TAB}`),
    ).toHaveCount(0);
    await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
