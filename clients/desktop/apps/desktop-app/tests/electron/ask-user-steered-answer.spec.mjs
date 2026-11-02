import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { seedAsyncInteractiveQuestion } from './seeders/seedInteractiveQuestion.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SCORPION_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-scorpion-cli.mjs', import.meta.url),
);
const ROOT_PROMPT = '[Canopy-CASKUSERSTEERED] Continue the existing root task.';

function readJsonl(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function targetUserInputs(entries, sessionId) {
  return entries.filter(
    (entry) => entry.type === 'user' && entry.sessionId === sessionId,
  );
}

function asyncAnswerMessages(tab, requestId) {
  return (tab?.messages ?? []).filter(
    (message) =>
      message.role === 'user' &&
      message.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.asyncQuestionAnswer?.requestId === requestId,
      ),
  );
}

function turnTimerStarts(tab) {
  return (tab?.messages ?? [])
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'turn_timer')
    .map((block) => block.startedAt);
}

function assertSettledQuestion(snapshot, requestId, chatId) {
  const unsettled = (snapshot.tabsFile.pendingQuestions ?? []).filter(
    (question) =>
      question.requestId === requestId &&
      question.chatId === chatId &&
      !question.answeredAt &&
      !question.dismissedAt,
  );
  expect(unsettled).toHaveLength(0);
}

function assertPersistedAnswer(snapshot, seeded, expectedMessageId) {
  const answerMessages = asyncAnswerMessages(snapshot.tab, seeded.requestId);
  expect(answerMessages).toHaveLength(1);
  const rawAnswerMessages = (snapshot.tab?.messages ?? []).filter(
    (message) =>
      message.role === 'user' &&
      message.blocks.some(
        (block) => block.type === 'text' && block.text === seeded.answerText,
      ),
  );
  expect(rawAnswerMessages).toHaveLength(1);
  const answerMessage = answerMessages[0];
  expect(rawAnswerMessages[0].id).toBe(answerMessage.id);
  if (expectedMessageId !== undefined)
    expect(answerMessage.id).toBe(expectedMessageId);
  expect(
    snapshot.tab.messages.filter((message) => message.id === answerMessage.id),
  ).toHaveLength(1);

  const answerBlock = answerMessage.blocks.find(
    (block) =>
      block.type === 'text' &&
      block.asyncQuestionAnswer?.requestId === seeded.requestId,
  );
  expect(answerMessage.role).toBe('user');
  expect(answerBlock).toMatchObject({
    type: 'text',
    text: seeded.answerText,
  });
  expect(answerBlock.asyncQuestionAnswer).toEqual({
    requestId: seeded.requestId,
    answers: seeded.answers,
    startsTurn: false,
  });

  const answerRows = (snapshot.tab.inputDelivery?.rows ?? []).filter(
    (row) => row.id === answerMessage.id,
  );
  expect(answerRows.length).toBeLessThanOrEqual(1);
  if (answerRows.length === 1) {
    expect(answerRows[0].state).toBe('picked-up');
    expect(answerRows[0].attempts).toHaveLength(1);
  }

  assertSettledQuestion(snapshot, seeded.requestId, seeded.chatId);
  return answerMessage;
}

async function assertAnsweredTranscript(panel, seeded) {
  const transcript = panel.getByTestId('chat-message-list-content');
  const groups = transcript.getByTestId('answered-questions');
  const bubbles = transcript.getByTestId('answered-question');
  await expect(groups).toHaveCount(1, { timeout: 30_000 });
  await expect(bubbles).toHaveCount(1, { timeout: 30_000 });
  await expect(bubbles.getByText(seeded.question, { exact: true })).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(bubbles).toContainText(seeded.chosenOption, {
    timeout: 30_000,
  });
}

function assertProviderSteeredOnce(
  entries,
  { answerText, holdInit, sessionId },
) {
  const inputs = targetUserInputs(entries, sessionId);
  const rootInputs = inputs.filter((entry) => entry.text.includes(ROOT_PROMPT));
  const answerInputs = inputs.filter((entry) =>
    entry.text.includes(answerText),
  );
  expect(inputs).toHaveLength(2);
  expect(rootInputs).toHaveLength(1);
  expect(answerInputs).toHaveLength(1);
  expect(answerInputs[0].rootTurnRunning).toBe(true);
  expect(inputs[0].text).toContain(ROOT_PROMPT);
  expect(inputs[1].text).toContain(answerText);

  const rootHeld = entries.filter((entry) => entry.type === 'root_held');
  expect(rootHeld).toHaveLength(1);
  expect(
    entries.filter((entry) => entry.type === 'root_init_held'),
  ).toHaveLength(holdInit ? 1 : 0);
  const results = entries.filter((entry) => entry.type === 'root_result');
  expect(results).toHaveLength(1);
  expect(results[0].reason).toBe('steer');
  expect(
    entries.filter((entry) => entry.type === 'steer_lifecycle'),
  ).toHaveLength(1);
  expect(
    entries.filter(
      (entry) =>
        entry.type === 'control_request' && entry.subtype === 'interrupt',
    ),
  ).toHaveLength(0);
}

async function runClaudeAsyncAnswerSteering({ holdInit }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-async-answer-steer-'),
  );
  const seeded = seedAsyncInteractiveQuestion(userDataDir);
  const { demo, chatId } = seeded;
  const sessionId = `${WORKSPACE_ID}/${WORKTREE_ID}/${chatId}`;
  const fakeCliPath = path.join(userDataDir, 'fake-claude-scorpion-cli.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-scorpion.jsonl');
  const initReleasePath = path.join(userDataDir, 'release-root-init');
  copyFileSync(SCORPION_FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CLAUDE_CODE_EXECUTABLE: fakeCliPath,
          CANOPY_CLAUDE_SCORPION_LOG: logPath,
          CANOPY_CLAUDE_SCORPION_HOLD_ROOT: '1',
          ...(holdInit
            ? {
                CANOPY_CLAUDE_SCORPION_HOLD_INIT: '1',
                CANOPY_CLAUDE_SCORPION_INIT_RELEASE: initReleasePath,
              }
            : {}),
        },
      }),
    ));

    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    let panel = window.getByTestId('panel-content-chat');
    const prompt = panel.getByTestId('chat-question-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });

    // The seeded async question belongs to the previous turn. Close its prompt
    // so the ordinary root message is sent from the real chat composer.
    await panel.getByTestId('chat-question-close').click();
    await expect(prompt).toHaveCount(0, { timeout: 30_000 });
    const readyChip = panel.getByTestId('chat-input-question-ready-chip');
    await expect(readyChip).toBeVisible({ timeout: 30_000 });
    const composer = panel.getByRole('textbox').last();
    await composer.fill(ROOT_PROMPT);
    await composer.press('Enter');

    const readSnapshot = () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return {
            tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
            runtime: state.runtimeByChatId[chatId],
            tabsFile: state.tabsFile,
          };
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId },
      );
    const entries = () => readJsonl(logPath);
    if (holdInit) {
      await expect
        .poll(
          () => entries().some((entry) => entry.type === 'root_init_held'),
          { timeout: 60_000 },
        )
        .toBe(true);
    } else {
      await expect
        .poll(() => entries().some((entry) => entry.type === 'root_held'), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await readSnapshot()).runtime?.steeringCapabilities?.steer,
          { timeout: 30_000 },
        )
        .toBe(true);
    }
    await expect
      .poll(
        async () => (await readSnapshot()).runtime?.activeTurn?.userMessageId,
        { timeout: 30_000 },
      )
      .toBeTruthy();

    const beforeAnswer = await readSnapshot();
    const rootUserMessageId = beforeAnswer.runtime.activeTurn.userMessageId;
    const rootUserMessage = beforeAnswer.tab.messages.find(
      (message) => message.id === rootUserMessageId,
    );
    expect(rootUserMessage).toBeDefined();
    expect(rootUserMessage.role).toBe('user');
    expect(
      rootUserMessage.blocks.some(
        (block) => block.type === 'text' && block.text.includes(ROOT_PROMPT),
      ),
    ).toBe(true);
    // The root timer opens with the canonical turn at the provider's root init,
    // not at dispatch (turn-state phase 35c contracts: `timer.open(T)` only on
    // actual start), so a held init has no timer yet.
    let rootTimerStarts = turnTimerStarts(beforeAnswer.tab);
    expect(rootTimerStarts).toHaveLength(holdInit ? 0 : 1);

    await readyChip.click();
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(
      prompt.getByText(seeded.question, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await prompt
      .getByRole('button', { name: seeded.chosenOption, exact: true })
      .click();
    await expect(prompt).toHaveCount(0, { timeout: 30_000 });

    const queuedBubbles = panel.getByTestId('queued-message-bubble');
    if (holdInit) {
      await expect(queuedBubbles).toHaveCount(1, { timeout: 30_000 });
      const queuedBubble = queuedBubbles.first();
      await expect(queuedBubble).toContainText(seeded.answerText, {
        timeout: 30_000,
      });
      const waitingReason = queuedBubble.getByTestId(
        'queued-message-waiting-reason',
      );
      await expect(waitingReason).toBeVisible({ timeout: 30_000 });
      await expect(waitingReason).toHaveAttribute(
        'data-waiting-reason',
        'steer_unavailable',
        { timeout: 30_000 },
      );
      await expect(
        queuedBubble.getByTestId('queued-message-steer'),
      ).toHaveCount(0, { timeout: 30_000 });
      await queuedBubble.hover();
      await expect(
        queuedBubble.getByTestId('queued-message-steer'),
      ).toHaveCount(0, { timeout: 30_000 });

      const waitingSnapshot = await readSnapshot();
      expect(waitingSnapshot.runtime.activeTurn.userMessageId).toBe(
        rootUserMessageId,
      );
      expect(turnTimerStarts(waitingSnapshot.tab)).toEqual(rootTimerStarts);
      const beforeRelease = entries();
      const beforeReleaseInputs = targetUserInputs(beforeRelease, sessionId);
      expect(beforeReleaseInputs).toHaveLength(1);
      expect(beforeReleaseInputs[0].text).toContain(ROOT_PROMPT);
      expect(
        beforeReleaseInputs.filter((entry) =>
          entry.text.includes(seeded.answerText),
        ),
      ).toHaveLength(0);
      expect(
        beforeRelease.filter((entry) => entry.type === 'steer_lifecycle'),
      ).toHaveLength(0);
      expect(
        beforeRelease.filter((entry) => entry.type === 'root_result'),
      ).toHaveLength(0);
      expect(
        beforeRelease.filter(
          (entry) =>
            entry.type === 'control_request' && entry.subtype === 'interrupt',
        ),
      ).toHaveLength(0);

      writeFileSync(initReleasePath, 'release\n');
      await expect
        .poll(() => entries().some((entry) => entry.type === 'root_held'), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect
        .poll(async () => turnTimerStarts((await readSnapshot()).tab).length, {
          timeout: 30_000,
        })
        .toBe(1);
      rootTimerStarts = turnTimerStarts((await readSnapshot()).tab);
    } else {
      await expect(queuedBubbles).toHaveCount(0, { timeout: 30_000 });
    }

    await expect
      .poll(
        () =>
          entries().some(
            (entry) => entry.type === 'root_result' && entry.reason === 'steer',
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
    await expect(queuedBubbles).toHaveCount(0, { timeout: 30_000 });

    const completedEntries = entries();
    assertProviderSteeredOnce(completedEntries, {
      answerText: seeded.answerText,
      holdInit,
      sessionId,
    });

    // Wait for the settled answer's persisted identity, then make sure its
    // pending delivery row is gone before checking the transcript answer UI.
    await expect
      .poll(
        async () => {
          const snapshot = await readSnapshot();
          return (
            asyncAnswerMessages(snapshot.tab, seeded.requestId)[0]?.id ?? null
          );
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const answerSnapshotBeforeRowDisappears = await readSnapshot();
    const answerMessageId = asyncAnswerMessages(
      answerSnapshotBeforeRowDisappears.tab,
      seeded.requestId,
    )[0]?.id;
    expect(answerMessageId).toBeTruthy();
    const answerRowSelector =
      '[data-testid="input-delivery-row"]' +
      `[data-input-row-id="${answerMessageId}"]`;
    await expect(panel.locator(answerRowSelector)).toHaveCount(0, {
      timeout: 30_000,
    });

    const completedAnswerSnapshot = await readSnapshot();
    const rootPromptMessages = completedAnswerSnapshot.tab.messages.filter(
      (message) =>
        message.role === 'user' &&
        message.blocks.some(
          (block) => block.type === 'text' && block.text.includes(ROOT_PROMPT),
        ),
    );
    expect(rootPromptMessages).toHaveLength(1);
    expect(rootPromptMessages[0].id).toBe(rootUserMessageId);
    expect(
      completedAnswerSnapshot.tab.messages.filter(
        (message) => message.id === rootUserMessageId,
      ),
    ).toHaveLength(1);
    expect(turnTimerStarts(completedAnswerSnapshot.tab)).toEqual(
      rootTimerStarts,
    );
    const answerMessage = assertPersistedAnswer(
      completedAnswerSnapshot,
      seeded,
    );
    expect(answerMessage.id).toBe(answerMessageId);
    await assertAnsweredTranscript(panel, seeded);

    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId('chat-question-prompt')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(
      panel.getByTestId('chat-input-question-ready-chip'),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0, {
      timeout: 30_000,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await readSnapshot();
          return asyncAnswerMessages(snapshot.tab, seeded.requestId).length;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect(panel.locator(answerRowSelector)).toHaveCount(0, {
      timeout: 30_000,
    });
    const reloadedSnapshot = await readSnapshot();
    const reloadedAnswer = assertPersistedAnswer(
      reloadedSnapshot,
      seeded,
      answerMessageId,
    );
    expect(turnTimerStarts(reloadedSnapshot.tab)).toEqual(rootTimerStarts);
    expect(reloadedAnswer.id).toBe(answerMessageId);
    await assertAnsweredTranscript(panel, seeded);
    assertProviderSteeredOnce(entries(), {
      answerText: seeded.answerText,
      holdInit,
      sessionId,
    });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
}

test('Claude async answer steers the running turn once after init', async () => {
  test.setTimeout(300_000);
  await runClaudeAsyncAnswerSteering({ holdInit: false });
});

test('Claude async answer waits for init then steers the running turn once', async () => {
  test.setTimeout(300_000);
  await runClaudeAsyncAnswerSteering({ holdInit: true });
});
