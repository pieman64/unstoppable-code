import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Doc 2 Spec 4 — Ask-User question rendering. PRs 724 / 775 / 806.
//
// Two-phase seeding (worktree chat):
//   1. `seedDemoWorkspaces({ apps: ['ts-pnpm-vite'] })` materializes the demo
//      workspace `demo-ts-pnpm-vite` with a default `demo-main` worktree
//      (demo-apps/seed-canopy-data.mjs → DEFAULT_WORKTREE_ID = 'demo-main').
//   2. `seedWorktreeChat(...)` overwrites `workspaces/demo-ts-pnpm-vite/chats/
//      demo-main.json` with a deterministic answered-ask-user transcript.
//
// Then `launchCanopy({ userDataDir })`, `openMainPage()`,
// `selectWorktree('demo-main')`, and assert the chat panel content (`panel-content-chat`) mounts.
//
// What renders, and why (verified against the renderer + an isolated probe):
//
//  ANSWERED ask-user bubbles (PR 806): an assistant message carrying an
//  ask-user `tool_use` (`toolName` satisfies `isAskUserQuestionToolName` —
//  `mcp__canopy__AskUserQuestion`) PLUS a matching `tool_result` block (same
//  `toolUseId`). `mergeToolResults` folds the result onto `block.result`, and
//  `parseAnsweredQuestions` (answered-questions.ts) reconstructs the answers
//  from the `Q: <question>\nA: <answer>` output, anchored on the verbatim
//  question text from the tool input (with an optional `\nAdditional: <text>`
//  free-form tail). `ChatBlockRenderer` then renders the standard collapsed
//  "User questions" tool row (`ToolCallBlock`) followed by
//  `AnsweredQuestionsBlock` (`answered-questions` / `answered-question`
//  testids added in PR 806), one bubble per answered question, showing the
//  chosen answer (and any "Other" free-form text).
//
//  LIMITATION (PR 724/775 live card): the interactive `AskUserQuestionCard`
//  (`ask-user-question-card` testid, Submit/Dismiss, selectable options, and
//  the question rendered as Markdown) is NOT reachable from purely seeded
//  persisted state. On load, `restoreStreamingTabs` → `closeOpenToolUseBlocks`
//  (chatStore.ts) cancels any orphan `tool_use` that lacks a `tool_result`
//  for a tab without an active main-process session, synthesizing a
//  `{ output: 'Cancelled', isError: false }` result. That makes `block.result`
//  truthy, so the live-card branch (`!block.result`) never fires — the block
//  renders as a collapsed "User questions" row instead. And the answered
//  read-only card variant requires a hydrated pending question with
//  `answeredAt` set, which `hydratePendingQuestionsFromFile` explicitly drops.
//  Exercising the live card therefore needs a live session and belongs to the
//  live-turn specs, not this seeded-state spec. This spec asserts the answered
//  bubble surface (PR 806), which fully reflects the seeded transcript.
//
// Determinism: no live agents, no network. Everything is static persisted JSON.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'seeded-ask-user';

// Single-question answered prompt with a plain selected option.
const COLOR_QUESTION = 'Pick a color';
const COLOR_ANSWER = 'Blue';

// Two-question answered prompt; the second carries an "Other" free-form tail.
// The `Q:/A:`/`Additional:` text matches what `formatAskUserAnswers` produces
// in the main process and what `parseAnsweredQuestions` anchors on.
const ENV_QUESTION = 'Which environment?';
const ENV_ANSWER = 'Staging';
const REGION_QUESTION = 'Preferred region?';
const REGION_ANSWER = 'Other';
const REGION_ADDITIONAL = 'eu-west-2';

function buildSeededChat(userDataDir) {
  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Ask User Coverage',
        providerType: 'claude',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Ask me what you need.' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
          // Single answered question.
          {
            id: 'msg-assistant-color',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'ask-color-1',
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({
                  questions: [{ question: COLOR_QUESTION }],
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'ask-color-1',
                toolName: 'mcp__canopy__AskUserQuestion',
                output: `Q: ${COLOR_QUESTION}\nA: ${COLOR_ANSWER}`,
                isError: false,
              },
            ],
            timestamp: Date.parse('2026-04-10T12:01:00.000Z'),
          },
          // Two answered questions in one tool call; the second has an
          // "Other" free-form tail (`Additional: ...`).
          {
            id: 'msg-assistant-deploy',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'ask-deploy-1',
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({
                  questions: [
                    { question: ENV_QUESTION },
                    { question: REGION_QUESTION },
                  ],
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'ask-deploy-1',
                toolName: 'mcp__canopy__AskUserQuestion',
                output: [
                  `Q: ${ENV_QUESTION}\nA: ${ENV_ANSWER}`,
                  `Q: ${REGION_QUESTION}\nA: ${REGION_ANSWER}\nAdditional: ${REGION_ADDITIONAL}`,
                ].join('\n\n'),
                isError: false,
              },
            ],
            timestamp: Date.parse('2026-04-10T12:02:00.000Z'),
          },
        ],
      },
    ],
  });
}

async function launchAskUserCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ask-user-'));
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    buildSeededChat(userDataDir);
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

test('renders answered ask-user bubbles with the chosen answers and free-form text', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } = await launchAskUserCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Two answered tool calls → two `answered-questions` groups, with a total
    // of three `answered-question` bubbles (1 from the color call + 2 from the
    // env/region call).
    const answeredGroups = window.getByTestId('answered-questions');
    await expect(answeredGroups).toHaveCount(2);

    const answeredBubbles = window.getByTestId('answered-question');
    await expect(answeredBubbles).toHaveCount(3);

    // Each collapsed "User questions" tool row (one per answered call) renders
    // above its answer bubbles.
    await expect(window.getByText('User questions')).toHaveCount(2);

    // Bubble 1 — single-question color answer.
    const colorBubble = answeredBubbles.nth(0);
    await expect(colorBubble).toContainText(COLOR_ANSWER);
    await expect(colorBubble.getByText(COLOR_QUESTION)).toBeVisible();

    // Bubble 2 — env answer (first question of the two-question call).
    const envBubble = answeredBubbles.nth(1);
    await expect(envBubble).toContainText(ENV_ANSWER);
    await expect(envBubble.getByText(ENV_QUESTION)).toBeVisible();

    // Bubble 3 — region answer with its "Other" free-form tail rendered
    // alongside the selected option.
    const regionBubble = answeredBubbles.nth(2);
    await expect(regionBubble).toContainText(REGION_ANSWER);
    await expect(regionBubble).toContainText(REGION_ADDITIONAL);
    await expect(regionBubble.getByText(REGION_QUESTION)).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('ask-user-question.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

import { seedInteractiveQuestion } from './seeders/seedInteractiveQuestion.mjs';
test('keeps question progress when switching panels', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'interactive-question-switch-'),
  );
  seedInteractiveQuestion(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const prompt = window.getByTestId('chat-question-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(prompt).toContainText('Project name');

    // Another panel unmounts the prompt; coming back resumes on question 2.
    await window.getByTestId('panel-tab-panel-chat-other').click();
    await expect(prompt).toHaveCount(0);
    await window.getByTestId('panel-tab-panel-chat-interactive').click();
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('Project name');
    await expect(prompt).not.toContainText('Continue?');
    await expect(prompt.locator('[aria-current="step"]')).toHaveAttribute(
      'aria-label',
      'Question 2 of 3',
    );

    // Finish without answering question 1 again: the kept pick is sent.
    const composer = window
      .locator('[data-chat-composer-root]')
      .filter({ has: prompt });
    await composer.locator('[contenteditable=true]').fill('Example project');
    await composer.getByTestId('chat-question-send').click();
    await prompt.getByRole('button', { name: 'Staging', exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(() =>
          window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
        return snapshot.tabsFile.pendingQuestions?.find(
          (question) => question.requestId === 'interactive-request',
        )?.answers;
      })
      .toEqual([
        { question: 'Continue?', selectedOptions: ['Yes'] },
        {
          question: 'Project name',
          selectedOptions: [],
          freeformText: 'Example project',
        },
        { question: 'Environment', selectedOptions: ['Staging'] },
      ]);
    await expect(prompt).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('agent controls collect structured answers in chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'interactive-question-'),
  );
  seedInteractiveQuestion(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    // The composer box asks the question, one step at a time.
    const prompt = window.getByTestId('chat-question-prompt');
    await expect(prompt).toBeVisible();
    const composer = window
      .locator('[data-chat-composer-root]')
      .filter({ has: prompt });
    await expect(composer).toHaveAttribute('data-question-prompt', 'true');
    await expect(
      composer.locator('[data-composer-layout="question"]'),
    ).toBeVisible();
    // A choice answers as soon as it is clicked and moves to the next step.
    await prompt.getByRole('button', { name: 'Yes', exact: true }).click();
    // A text question takes the composer's own input as its answer.
    await expect(prompt).toContainText('Project name');
    await composer.locator('[contenteditable=true]').fill('Example project');
    await composer.getByTestId('chat-question-send').click();
    // Two environments read as rows; choosing one sends every answer.
    await prompt.getByRole('button', { name: 'Staging', exact: true }).click();
    // The seeded prompt has no live provider waiter to append a tool result.
    // Verify the main-owned answer record; the portal live-turn spec covers
    // the resumed provider and the resulting read-only transcript bubbles.
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(() =>
          window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
        return snapshot.tabsFile.pendingQuestions?.find(
          (question) => question.requestId === 'interactive-request',
        )?.answers;
      })
      .toEqual([
        { question: 'Continue?', selectedOptions: ['Yes'] },
        {
          question: 'Project name',
          selectedOptions: [],
          freeformText: 'Example project',
        },
        { question: 'Environment', selectedOptions: ['Staging'] },
      ]);
    await expect(prompt).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
