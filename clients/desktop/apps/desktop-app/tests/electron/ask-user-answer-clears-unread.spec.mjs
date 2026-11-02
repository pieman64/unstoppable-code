import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/registerScenario.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  ATTENTION_AWAY,
  seedAttentionAwayWorktree,
} from './seeders/seedWorktreeAttention.mjs';

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
// provider auth or billable calls. The follow-up uses the suite mock.
//
// The same flow covers the restored question (CAN-4959): no provider turn is
// waiting for the answer, so the asking message never gets a `tool_result`.
// It must show the chosen answer as soon as the answer is accepted, without a
// "Preparing question" or pending spinner, and keep it after the relaunch,
// where restore gives the orphan block a synthetic `Cancelled` result. A
// deterministic follow-up proves the old message stays settled while another turn runs.
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
  seedAttentionAwayWorktree(userDataDir);
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
        model: 'claude-haiku-4-5-20251001',
        approvalMode: 'full-access',
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

function askingMessage(window) {
  return window.locator('[data-chat-message-id="question-assistant-1"]');
}

// The original asking message settles on the chosen answer, with no spinner.
async function expectSettledAnswer(window) {
  // Normal completed-turn folding can hide the asking step after a new
  // turn or relaunch. Reveal it using the existing summary control.
  const summary = window
    .locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${QUESTION_TAB}"]`,
    )
    .getByTestId('turn-work-header')
    .getByRole('button', { name: /^Agent steps/ })
    .first();
  if (
    (await summary.count()) &&
    (await summary.getAttribute('aria-expanded')) === 'false'
  )
    await summary.click();
  const panel = askingMessage(window);
  // Clean shows the settled answer directly, without a duplicate tool row.
  await expect(
    panel.locator(`[data-tool-use-id="${TOOL_USE_ID}"]`),
  ).toHaveCount(0);
  await expect(panel.getByTestId('answered-questions')).toContainText(
    CHOSEN_OPTION,
  );
  await expect(panel.getByTestId('ask-user-question-preparing')).toHaveCount(0);
}

async function observeAskingMessage(window) {
  await window.evaluate(() => {
    const observations = { violations: [], seenAnswer: false };
    const sample = () => {
      const message = document.querySelector(
        '[data-chat-message-id="question-assistant-1"]',
      );
      if (message?.querySelector('[data-testid="answered-questions"]'))
        observations.seenAnswer = true;
      if (
        message?.querySelector(
          '[data-testid="ask-user-question-preparing"], [data-tool-status="pending"]',
        )
      )
        observations.violations.push('old-message spinner');
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    window.__can4959 = { observations, observer };
    sample();
  });
}

async function expectNoOldSpinner(window) {
  const observed = await window.evaluate(() => {
    window.__can4959.observer.disconnect();
    return window.__can4959.observations;
  });
  expect(observed.seenAnswer).toBe(true);
  expect(observed.violations).toEqual([]);
}

async function openSeededWorktree(
  electronApp,
  activeTabId,
  unreadBeforeSelection = false,
) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Inspect individual steps without changing the product's Recent default.
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree(ATTENTION_AWAY);
  await expect(
    window.getByTestId('panel-tab-panel-chat-away-chat'),
  ).toBeVisible();
  await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
  if (unreadBeforeSelection) {
    await expect(
      window
        .locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        )
        .getByTestId('worktree-row-unread'),
    ).toBeVisible();
  }
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
  const marker = 'Canopy-C4959FOLLOWUP';
  const completion = 'The release follow up is complete';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: `${'Checking the release. '.repeat(10)}${completion}`,
          streamMs: 8000,
          chunkChars: 8,
          stopReason: 'end_turn',
        },
      ],
    },
  });

  const first = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openSeededWorktree(
      first.electronApp,
      QUESTION_TAB,
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

    // Implicit entry already shows the prompt. Viewing it keeps its marker.
    await expect(window.getByTestId('chat-question-prompt')).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-question-${QUESTION_TAB}`),
    ).toBeVisible();
    await window.getByTestId(`panel-tab-panel-chat-${ACTIVE_TAB}`).click();
    const questionTab = window.getByTestId(
      `panel-tab-panel-chat-${QUESTION_TAB}`,
    );
    await expect(questionTab).toHaveAccessibleName(/Question waiting/);
    await expect(
      questionTab.getByTestId(`panel-tab-question-${QUESTION_TAB}`),
    ).toBeVisible();

    // Open the asked tab and answer in the composer's question prompt: a
    // choice answers as soon as it is clicked.
    await window.getByTestId(`panel-tab-panel-chat-${QUESTION_TAB}`).click();
    const card = window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible({ timeout: 10_000 });
    // While the composer owns the prompt, the asking message draws nothing.
    await expect(
      askingMessage(window).getByTestId('ask-user-question-preparing'),
    ).toHaveCount(0);
    await observeAskingMessage(window);
    await card
      .getByRole('button', { name: CHOSEN_OPTION, exact: true })
      .click();

    // The question is settled: no card, no orange dot, no unread on that tab.
    await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expectSettledAnswer(window);
    await expect(row.getByTestId('worktree-row-question')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${QUESTION_TAB}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-question-${QUESTION_TAB}`),
    ).toHaveCount(0);
    // A completed turn's unread is never an answer's to clear: with the
    // question gone, the sibling's blue dot surfaces on the row.
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-unread-${TURN_TAB}`),
    ).toBeVisible();
    await expectNoOldSpinner(window);
    await new CanopyAppDriver(window).selectWorktree(ATTENTION_AWAY);
    await expect(
      window.getByTestId('panel-tab-panel-chat-away-chat'),
    ).toBeVisible();
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // Durable read state: the relaunch must not resurrect the question dot or
  // the answered tab's unread, while the completed-turn unread persists.
  const second = await launchCanopy({ userDataDir });
  try {
    // Start on the other worktree; the sibling stays unread until selected.
    const { window, row } = await openSeededWorktree(
      second.electronApp,
      TURN_TAB,
      true,
    );
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${TURN_TAB}`),
    ).toHaveCount(0);
    await expect(row.getByTestId('worktree-row-question')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-unread-${QUESTION_TAB}`),
    ).toHaveCount(0);
    await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0);
    // The answer survives the relaunch on the original asking message.
    await window.getByTestId(`panel-tab-panel-chat-${QUESTION_TAB}`).click();
    await expectSettledAnswer(window);
    await observeAskingMessage(window);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${QUESTION_TAB}"]`,
    );
    const composer = panel.locator('[data-chat-composer-root]');
    await composer.getByRole('textbox').fill(`[${marker}] Check the release.`);
    await composer.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 60_000,
    });
    await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
      'data-state',
      'live',
    );
    await expectSettledAnswer(window);
    await expect(panel).toContainText(completion, { timeout: 60_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0);
    await expectSettledAnswer(window);
    await expectNoOldSpinner(window);
  } finally {
    await closeCanopy(second.electronApp, userDataDir, { keepUserData: true });
  }
  // A final relaunch proves persistence after the actual later turn closed
  // the orphan call with its non-error Cancelled result.
  const third = await launchCanopy({ userDataDir });
  try {
    const window = await third.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Inspect individual steps without changing the product's Recent default.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await window.getByTestId(`panel-tab-panel-chat-${QUESTION_TAB}`).click();
    await expectSettledAnswer(window);
  } finally {
    await closeCanopy(third.electronApp, userDataDir);
  }
});
