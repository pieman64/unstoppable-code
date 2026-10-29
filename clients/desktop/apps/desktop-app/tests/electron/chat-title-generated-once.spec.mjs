// CAN-3652: a chat receives one concise automatic title from its first user
// prompt. Later prompts, restarts, saved titles, custom names and a rename that
// races generation never replace it.
//
// The chat-summary helper runs the real bundled `claude` binary redirected to
// the shared mock server, whose `topic-summary` helper fingerprint matches the
// short chat-title system prompt. Each test registers a marker scenario with a
// `helperStepsById['topic-summary']` override, so the visible title can only
// come from the helper invocation for that marker's first prompt.
//
// Absence assertions never rely on an immediate read. Each one first sends the
// first prompt of a separate eligible "sentinel" chat and waits for its title.
// Ineligible chats return before queueing helper work, and that check is issued
// before the sentinel send, so a delayed title for the chat under test would
// already be visible once the sentinel title commits.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const DEMO_APP_ID = 'ts-pnpm-vite';
const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const NEW_CHAT_TITLE = 'New Chat';
const SENTINEL_MARKER = 'Canopy-CTITLESENTINEL';
const SENTINEL_TITLE = 'Sentinel naming checkpoint';

function seedHelperPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          canopyBackgroundProcessesMode: 'canopy',
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: true,
          summaryThinkingLevel: 'off',
          defaultWorktreeProvider: 'claude',
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'claude-haiku-4-5-20251001',
              thinkingLevel: 'off',
            },
            codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
            ollama: null,
            aiCredits: null,
          },
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function prepareUserData(prefix, tabs) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedHelperPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: tabs[0].id,
    tabs,
  });
  return userDataDir;
}

async function registerTitle(marker, step) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { helperStepsById: { 'topic-summary': step } },
  });
}

async function openApp(userDataDir) {
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(
    window.locator('[data-testid="panel-content-chat"]:visible').first(),
  ).toBeVisible();
  return { ...launched, window };
}

async function restart(launched, userDataDir) {
  await closeCanopy(launched.electronApp, userDataDir, { keepUserData: true });
  return openApp(userDataDir);
}

function chatTab(window, chatId) {
  return window.getByTestId(`panel-tab-panel-chat-${chatId}`);
}

function chatPanel(window, chatId) {
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

async function sendPrompt(window, chatId, text) {
  await chatTab(window, chatId).click();
  const panel = chatPanel(window, chatId);
  await expect(panel).toBeVisible();
  const composerRoot = panel.locator('[data-chat-composer-root]');
  const composer = composerRoot.getByRole('textbox');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await composerRoot.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(text).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0, {
    timeout: 60_000,
  });
}

/** Drains naming work queued before this call; see the file header. */
async function settleNamingQueue(window, sentinelChatId) {
  await sendPrompt(
    window,
    sentinelChatId,
    `[${SENTINEL_MARKER}] Confirm queued naming has drained`,
  );
  await expect(chatTab(window, sentinelChatId)).toContainText(SENTINEL_TITLE, {
    timeout: 90_000,
  });
}

/** Unique chat-summary audit entries for one chat, across retained days. */
function chatSummaryTasks(userDataDir, chatId) {
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  if (!existsSync(auditDir)) return [];
  const latest = new Map();
  for (const file of readdirSync(auditDir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(auditDir, file), 'utf8')
      .split('\n')
      .filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.eventType === 'chat_summary' && entry.chatId === chatId) {
        latest.set(entry.id, entry);
      }
    }
  }
  return [...latest.values()];
}

async function canonicalTab(window, chatId) {
  return window.evaluate(
    async ({ scope, id }) => {
      const state = await window.api.chat.getState(scope);
      const tab =
        state.tabsFile.tabs.find((candidate) => candidate.id === id) ?? null;
      return tab
        ? {
            description: tab.description ?? null,
            customTitle: tab.customTitle ?? null,
            automaticTitleState: tab.automaticTitleState ?? null,
          }
        : null;
    },
    { scope: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID }, id: chatId },
  );
}

async function rename(window, chatId, value) {
  await chatTab(window, chatId).click({ button: 'right' });
  await window.getByTestId('panel-tab-context-rename').click();
  const input = window.getByTestId('chat-tab-rename-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  await window.getByTestId('chat-tab-rename-save').click();
  await expect(window.getByTestId('chat-tab-rename-dialog')).toHaveCount(0);
}

test.beforeAll(async () => {
  await registerTitle(SENTINEL_MARKER, {
    text: SENTINEL_TITLE,
    stopReason: 'end_turn',
  });
});

test('first prompt names a fresh chat once and later prompts keep it', async () => {
  test.setTimeout(300_000);
  const marker = 'Canopy-CTITLEONCE';
  const title = 'Mobile release checklist';
  const chatId = 'title-once';
  const sentinelId = 'title-once-sentinel';
  const restartSentinelId = 'title-once-restart-sentinel';
  const userDataDir = prepareUserData('canopy-title-once-', [
    { id: chatId, title: NEW_CHAT_TITLE },
    { id: sentinelId, title: NEW_CHAT_TITLE },
    { id: restartSentinelId, title: NEW_CHAT_TITLE },
  ]);
  await registerTitle(marker, { text: title, stopReason: 'end_turn' });
  let launched = await openApp(userDataDir);
  try {
    await sendPrompt(
      launched.window,
      chatId,
      `[${marker}] Please could you automate our mobile release checklist so nobody forgets a step`,
    );
    await expect(chatTab(launched.window, chatId)).toContainText(title, {
      timeout: 90_000,
    });
    await expect
      .poll(() =>
        chatSummaryTasks(userDataDir, chatId).map((task) => task.status),
      )
      .toEqual(['success']);

    // Any regeneration would use this answer instead.
    await registerTitle(marker, {
      text: 'Regenerated later title',
      stopReason: 'end_turn',
    });
    await sendPrompt(
      launched.window,
      chatId,
      `[${marker}] Now also cover the database migrations`,
    );
    await settleNamingQueue(launched.window, sentinelId);
    await expect(chatTab(launched.window, chatId)).toContainText(title);
    expect(chatSummaryTasks(userDataDir, chatId)).toHaveLength(1);
    expect(await canonicalTab(launched.window, chatId)).toEqual({
      description: title,
      customTitle: null,
      automaticTitleState: 'closed',
    });

    launched = await restart(launched, userDataDir);
    await expect(chatTab(launched.window, chatId)).toContainText(title);
    await sendPrompt(
      launched.window,
      chatId,
      `[${marker}] One more follow-up after the restart`,
    );
    await settleNamingQueue(launched.window, restartSentinelId);
    await expect(chatTab(launched.window, chatId)).toContainText(title);
    expect(chatSummaryTasks(userDataDir, chatId)).toHaveLength(1);
    expect((await canonicalTab(launched.window, chatId))?.description).toBe(
      title,
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('saved generated and custom names never invoke naming across restart', async () => {
  test.setTimeout(360_000);
  const marker = 'Canopy-CTITLESETTLED';
  const generatedId = 'title-generated';
  const customId = 'title-custom';
  const generated = 'Seeded generated title';
  const custom = 'My custom chat name';
  const userDataDir = prepareUserData('canopy-title-settled-', [
    { id: generatedId, title: NEW_CHAT_TITLE, description: generated },
    { id: customId, title: NEW_CHAT_TITLE, customTitle: custom },
    { id: 'title-settled-sentinel-1', title: NEW_CHAT_TITLE },
    { id: 'title-settled-sentinel-2', title: NEW_CHAT_TITLE },
  ]);
  await registerTitle(marker, {
    text: 'Unexpected replacement title',
    stopReason: 'end_turn',
  });
  let launched = await openApp(userDataDir);
  const assertSettled = async () => {
    await expect(chatTab(launched.window, generatedId)).toContainText(
      generated,
    );
    await expect(chatTab(launched.window, customId)).toContainText(custom);
    expect(chatSummaryTasks(userDataDir, generatedId)).toEqual([]);
    expect(chatSummaryTasks(userDataDir, customId)).toEqual([]);
    expect(
      (await canonicalTab(launched.window, generatedId))?.description,
    ).toBe(generated);
    expect(await canonicalTab(launched.window, customId)).toMatchObject({
      description: null,
      customTitle: custom,
    });
  };
  try {
    await sendPrompt(
      launched.window,
      generatedId,
      `[${marker}] Ask something in the chat with a saved title`,
    );
    await sendPrompt(
      launched.window,
      customId,
      `[${marker}] Ask something in the chat with a custom name`,
    );
    await launched.window.evaluate(
      async (scope) => {
        await window.api.chat.destroySession({
          ...scope,
          chatId: 'title-generated',
        });
        const state = await window.api.chat.getState(scope);
        const result = await window.api.chat.command({
          ...scope,
          schemaVersion: 1,
          commandId: 'title-switch-harness',
          expectedRevision: state.revision,
          command: {
            type: 'chat.set_model',
            tabId: 'title-generated',
            model: 'gpt-5.5',
            providerType: 'codex',
          },
        });
        if (result.outcome !== 'applied')
          throw new Error(JSON.stringify(result));
        const updated = await window.api.chat.getState(scope);
        const tab = updated.tabsFile.tabs.find(
          (tab) => tab.id === 'title-generated',
        );
        if (tab?.model !== 'gpt-5.5' || tab.providerType !== 'codex')
          throw new Error('The model change did not select the Codex model.');
      },
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    await sendPrompt(
      launched.window,
      generatedId,
      `[${marker}] Retry with a recreated Codex session`,
    );
    await settleNamingQueue(launched.window, 'title-settled-sentinel-1');
    await assertSettled();

    launched = await restart(launched, userDataDir);
    await sendPrompt(
      launched.window,
      generatedId,
      `[${marker}] Ask again after restarting`,
    );
    await sendPrompt(
      launched.window,
      customId,
      `[${marker}] Ask the custom chat again after restarting`,
    );
    await settleNamingQueue(launched.window, 'title-settled-sentinel-2');
    await assertSettled();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a rename during title generation wins and survives clear and restart', async () => {
  test.setTimeout(300_000);
  const marker = 'Canopy-CTITLERACE';
  const chatId = 'title-race';
  const lateTitle = 'Late generated title';
  const custom = 'Planning notes';
  const sentinelId = 'title-race-sentinel';
  const userDataDir = prepareUserData('canopy-title-race-', [
    { id: chatId, title: NEW_CHAT_TITLE },
    { id: sentinelId, title: NEW_CHAT_TITLE },
  ]);
  // Hold the helper stream open long enough to rename while it runs.
  await registerTitle(marker, {
    text: lateTitle,
    stopReason: 'end_turn',
    streamMs: 20_000,
    chunkChars: 2,
  });
  let launched = await openApp(userDataDir);
  try {
    const prompt = `[${marker}] Draft the quarterly planning document`;
    await sendPrompt(launched.window, chatId, prompt);
    await expect
      .poll(
        () =>
          launched.window.evaluate(async (id) => {
            const snapshot = await window.api.observability.loadSnapshot();
            return snapshot.recentEntries.some(
              (entry) =>
                entry.eventType === 'chat_summary' &&
                entry.chatId === id &&
                entry.status === 'running',
            );
          }, chatId),
        { timeout: 30_000 },
      )
      .toBe(true);

    await rename(launched.window, chatId, custom);
    await expect(chatTab(launched.window, chatId)).toContainText(custom);

    // The late result is discarded rather than saved under the custom name.
    await expect
      .poll(
        () => chatSummaryTasks(userDataDir, chatId).map((task) => task.status),
        { timeout: 60_000 },
      )
      .toEqual(['cancelled']);
    await expect(chatTab(launched.window, chatId)).toContainText(custom);
    expect(await canonicalTab(launched.window, chatId)).toEqual({
      description: null,
      customTitle: custom,
      automaticTitleState: 'closed',
    });

    launched = await restart(launched, userDataDir);
    await expect(chatTab(launched.window, chatId)).toContainText(custom);
    expect(await canonicalTab(launched.window, chatId)).toEqual({
      description: null,
      customTitle: custom,
      automaticTitleState: 'closed',
    });

    // Clearing reveals the creation title; it does not reopen naming.
    await rename(launched.window, chatId, '');
    await expect(chatTab(launched.window, chatId)).not.toContainText(custom);
    await expect(chatTab(launched.window, chatId)).not.toContainText(lateTitle);

    launched = await restart(launched, userDataDir);
    await sendPrompt(
      launched.window,
      chatId,
      `[${marker}] A follow-up after clearing the name`,
    );
    await settleNamingQueue(launched.window, sentinelId);
    await expect(chatTab(launched.window, chatId)).not.toContainText(lateTitle);
    expect(await canonicalTab(launched.window, chatId)).toEqual({
      description: null,
      customTitle: null,
      automaticTitleState: 'closed',
    });
    expect(chatSummaryTasks(userDataDir, chatId)).toHaveLength(1);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
