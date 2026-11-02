// Agent-sent marking (project-bot-chat-tools phase 06).
//
// An App Advisor chat sends to another, busy Advisor chat through the real
// `advisor-chat.send_message` DispatchAction. The receiving chat must show the
// sender chat's title on the queued bubble, on the delivered user message, and
// again after the window reloads from the durable transcript. A seeded project
// chat proves the cross-context form, where the sender's project is appended.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { expandAppAdvisorToFullWindow } from './helpers/appAdvisorFullWindow.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  seedWorkspaceApprovals,
  writeJson,
} from './seeders/index.mjs';

const ENTRY_ID = 'agent-sent-entry';
const SOURCE_ENTRY_ID = 'agent-sent-source-entry';
const SOURCE_CHAT_ID = 'agent-sent-source';
const TARGET_CHAT_ID = 'agent-sent-target';
const SOURCE_TITLE = 'Release prep';
const TARGET_TITLE = 'Review queue';
const CREATED_AT = '2026-10-16T12:00:00.000Z';
const TARGET_MARKER = 'Canopy-CAGENTSENTTARGET';
const SOURCE_MARKER = 'Canopy-CAGENTSENTSOURCE';
const QUEUED_MARKER = 'Canopy-CAGENTSENTQUEUED';
const QUEUED_TEXT = `[${QUEUED_MARKER}] Review the release notes when you are free.`;
const TARGET_REPLY = 'The long review finished.';
const QUEUED_REPLY = 'Reviewed the release notes.';
const SOURCE_REPLY = 'Asked the review chat.';

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-sent-'));
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
    },
  });
}

function seedAdvisorEntry(userDataDir) {
  const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  mkdirSync(path.join(advisorDir, 'chats'), { recursive: true });
  writeFileSync(
    path.join(advisorDir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { id: ENTRY_ID, createdAt: CREATED_AT, title: 'Review' },
        { id: SOURCE_ENTRY_ID, createdAt: CREATED_AT, title: 'Release' },
      ],
    }),
  );
  // Prior history keeps the seeded titles; an empty chat is auto-titled.
  const tab = (id, title) => ({
    id,
    title,
    createdAt: CREATED_AT,
    providerType: 'claude',
    model: 'sonnet',
    messages: [
      {
        id: `${id}-history-user`,
        role: 'user',
        timestamp: Date.parse(CREATED_AT),
        blocks: [{ type: 'text', text: `Earlier ${title} context` }],
      },
      {
        id: `${id}-history-reply`,
        role: 'assistant',
        timestamp: Date.parse(CREATED_AT) + 1_000,
        blocks: [{ type: 'text', text: 'Noted.' }],
      },
    ],
  });
  // Separate Work Entries: a same-entry send to a busy chat does not return
  // on the unchanged tree either, which is outside this phase.
  writeFileSync(
    path.join(advisorDir, 'chats', `${ENTRY_ID}.json`),
    JSON.stringify({
      version: 1,
      activeTabId: TARGET_CHAT_ID,
      tabs: [tab(TARGET_CHAT_ID, TARGET_TITLE)],
    }),
  );
  writeFileSync(
    path.join(advisorDir, 'chats', `${SOURCE_ENTRY_ID}.json`),
    JSON.stringify({
      version: 1,
      activeTabId: SOURCE_CHAT_ID,
      tabs: [tab(SOURCE_CHAT_ID, SOURCE_TITLE)],
    }),
  );
}

test('an Advisor send to a busy Advisor chat shows the sender title when queued and sent', async () => {
  test.setTimeout(240_000);
  const userDataDir = makeUserDataDir();
  seedPreferences(userDataDir);
  seedAdvisorEntry(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TARGET_MARKER, {
    llm: {
      // The mock keys a conversation by its first marker and indexes steps
      // by history, so the delivered agent input is this chat's second turn.
      steps: [
        { text: TARGET_REPLY, stopReason: 'end_turn', streamMs: 45_000 },
        { text: QUEUED_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, SOURCE_MARKER, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: {
                action: {
                  type: 'advisor-chat.send_message',
                  workEntryId: ENTRY_ID,
                  chatId: TARGET_CHAT_ID,
                  text: QUEUED_TEXT,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: SOURCE_REPLY, stopReason: 'end_turn' },
      ],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await expandAppAdvisorToFullWindow(advisor);
    const scope = { projectId: 'app-advisor', worktreeId: ENTRY_ID };
    const sourceScope = {
      projectId: 'app-advisor',
      worktreeId: SOURCE_ENTRY_ID,
    };
    await advisor.getByTestId(`app-advisor-nav-entry-${ENTRY_ID}`).click();
    const panel = advisor.getByTestId('panel-content-chat');

    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${TARGET_MARKER}] Start a long review.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 60_000,
    });

    // The source chat lives in another Work Entry. Send from its composer, as
    // a user would; its turn calls the real `advisor-chat.send_message`.
    await advisor
      .getByTestId(`app-advisor-nav-entry-${SOURCE_ENTRY_ID}`)
      .click();
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${SOURCE_MARKER}] Ask the review chat to check the notes.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(SOURCE_REPLY).first()).toBeVisible({
      timeout: 60_000,
    });
    const sourcePage = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...sourceScope, chatId: SOURCE_CHAT_ID },
    );
    const resultBlock = sourcePage.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result');
    expect(resultBlock?.isError, resultBlock?.output).not.toBe(true);
    expect(JSON.parse(resultBlock.output)).toMatchObject({ ok: true });

    await advisor.getByTestId(`app-advisor-nav-entry-${ENTRY_ID}`).click();
    const queued = panel
      .getByTestId('queued-message-bubble')
      .filter({ hasText: QUEUED_MARKER });
    await expect(queued).toBeVisible({ timeout: 90_000 });
    // Same "project" (App Advisor): the chat title only, no project label.
    await expect(queued.getByTestId('agent-sent-title')).toHaveText(
      SOURCE_TITLE,
    );

    await expect(panel.getByText(QUEUED_REPLY).first()).toBeVisible({
      timeout: 120_000,
    });
    const sent = panel
      .locator('[data-role="user"]')
      .filter({ hasText: QUEUED_MARKER });
    await expect(sent.getByTestId('agent-sent-title')).toHaveText(SOURCE_TITLE);

    const page = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...scope, chatId: TARGET_CHAT_ID },
    );
    const stored = page.messages.find(
      (message) =>
        message.role === 'user' &&
        message.blocks.some(
          (block) => block.type === 'text' && block.text === QUEUED_TEXT,
        ),
    );
    expect(stored).toMatchObject({
      userMessageSource: 'agent',
      agentSent: {
        sender: { kind: 'bot', botId: 'app_advisor', chatId: SOURCE_CHAT_ID },
        chatTitle: SOURCE_TITLE,
      },
    });
    // The hidden sender note is provider-only and never stored as text.
    expect(JSON.stringify(page.messages)).not.toContain('agent-sender-context');

    await advisor.reload();
    await expect(
      advisor.getByTestId('app-advisor-workspace-surface'),
    ).toBeVisible({ timeout: 30_000 });
    const reloaded = advisor
      .getByTestId('panel-content-chat')
      .locator('[data-role="user"]')
      .filter({ hasText: QUEUED_MARKER });
    await expect(reloaded.getByTestId('agent-sent-title')).toHaveText(
      SOURCE_TITLE,
    );
    // The title opens the sending chat, here in this same window, in
    // whichever layout (floating or full) the window shows it.
    await reloaded.getByTestId('agent-sent-title').click();
    await expect(
      advisor.getByText(`Earlier ${SOURCE_TITLE} context`),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Stored labels render as written: transcripts from before the rename keep
// 'App Advisor', and new sends store 'Orchestrator' (ORCHESTRATOR_LABEL).
for (const projectLabel of ['App Advisor', 'Orchestrator']) {
  test(`a project chat shows the sender project beside an Advisor sender title (${projectLabel})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = makeUserDataDir();
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedAdvisorEntry(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      activeTabId: 'agent-sent-project-chat',
      tabs: [
        {
          id: 'agent-sent-project-chat',
          title: 'Release checklist',
          messages: [
            {
              id: 'agent-sent-project-user',
              role: 'user',
              timestamp: Date.parse(CREATED_AT),
              userMessageSource: 'agent',
              agentSent: {
                sender: {
                  kind: 'bot',
                  botId: 'app_advisor',
                  taskId: SOURCE_ENTRY_ID,
                  chatId: SOURCE_CHAT_ID,
                },
                chatTitle: SOURCE_TITLE,
                projectLabel,
              },
              blocks: [
                { type: 'text', text: 'Please run the release checks.' },
              ],
            },
            {
              id: 'agent-sent-project-reply',
              role: 'assistant',
              timestamp: Date.parse(CREATED_AT) + 1_000,
              blocks: [{ type: 'text', text: 'Release checks are running.' }],
            },
          ],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const sent = window
        .getByTestId('panel-content-chat')
        .locator('[data-role="user"]')
        .filter({ hasText: 'Please run the release checks.' });
      const title = sent.getByTestId('agent-sent-title');
      await expect(title).toContainText(SOURCE_TITLE);
      await expect(title).toContainText(projectLabel);
      await expect(sent).not.toContainText('Sent by');
      // The title opens the sending App Advisor chat in the Advisor window.
      const advisorWindow = electronApp.waitForEvent('window');
      await title.click();
      const advisor = await advisorWindow;
      // The window opens floating or full; either shows the sending chat.
      await expect(
        advisor.getByText(`Earlier ${SOURCE_TITLE} context`),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
}

test('a project root sends to another project without navigation or target-setting changes', async () => {
  test.setTimeout(180_000);
  const userDataDir = makeUserDataDir();
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  seedPreferences(userDataDir);
  const source = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'project-send-source',
  };
  const target = {
    projectId: 'demo-ts-npm-next',
    worktreeId: 'demo-main',
    chatId: 'project-send-target',
  };
  const marker = 'Canopy-CAGENTSENTPROJECTSOURCE';
  const text = '[Canopy-CAGENTSENTPROJECTTARGET] Review the release checklist.';
  const history = [
    {
      id: 'earlier',
      role: 'user',
      timestamp: Date.parse(CREATED_AT),
      blocks: [{ type: 'text', text: 'Earlier context' }],
    },
    {
      id: 'noted',
      role: 'assistant',
      timestamp: Date.parse(CREATED_AT) + 1_000,
      blocks: [{ type: 'text', text: 'Noted.' }],
    },
  ];
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: source.projectId,
    defaultMode: 'full-access',
  });
  const targetSettings = {
    model: 'sonnet',
    providerType: 'claude',
    thinkingLevel: 'off',
    planMode: false,
    interfaceMode: 'canopy',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  };
  for (const [scope, title, settings] of [
    [
      source,
      'Release coordination',
      { model: 'sonnet', thinkingLevel: 'high' },
    ],
    [target, 'Target review', targetSettings],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      providerType: 'claude',
      activeTabId: scope.chatId,
      tabs: [{ id: scope.chatId, title, messages: history, ...settings }],
    });
  }
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__DispatchAction',
              input: {
                action: {
                  type: 'projects.send_message',
                  projectId: target.projectId,
                  taskId: target.worktreeId,
                  chatId: target.chatId,
                  text,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Review requested.', stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    'Canopy-CAGENTSENTPROJECTTARGET',
    {
      llm: {
        steps: [
          { text: 'Release checklist reviewed.', stopReason: 'end_turn' },
        ],
      },
    },
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const row = (scope) =>
      window
        .locator(
          `[data-testid="worktree-row"][data-project-id="${scope.projectId}"][data-worktree-id="${scope.worktreeId}"]`,
        )
        .first();
    await row(source).evaluate((element) => element.click());
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${source.chatId}`),
    ).toBeVisible();
    const before = await window.evaluate(
      (scope) => window.api.chat.loadTabs(scope),
      target,
    );
    const settings = (tab) =>
      Object.fromEntries(
        Object.keys(targetSettings).map((key) => [key, tab[key]]),
      );
    const beforeTab = before.tabs.find((tab) => tab.id === target.chatId);
    expect(beforeTab).toBeDefined();
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Ask the other project to review.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText('Review requested.').first()).toBeVisible({
      timeout: 90_000,
    });
    // Sending does not select the receiving project or tab.
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${source.chatId}`),
    ).toBeVisible();
    const sourcePage = await window.evaluate(
      (scope) => window.api.chat.getTranscriptPage(scope),
      source,
    );
    const result = sourcePage.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result');
    expect(result?.isError, result?.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      result: {
        address: {
          projectId: target.projectId,
          taskId: target.worktreeId,
          chatId: target.chatId,
        },
        disposition: 'started',
        messageId: expect.any(String),
        watcherReceipts: [],
      },
    });
    await row(target).evaluate((element) => element.click());
    const sent = panel.locator('[data-role="user"]').filter({ hasText: text });
    await expect(sent.getByTestId('agent-sent-title')).toContainText(
      'Release coordination',
      { timeout: 60_000 },
    );
    await expect(sent.getByTestId('agent-sent-title')).toContainText(
      'TypeScript pnpm Vite',
    );
    const after = await window.evaluate(
      (scope) => window.api.chat.loadTabs(scope),
      target,
    );
    expect(
      settings(after.tabs.find((tab) => tab.id === target.chatId)),
    ).toEqual(settings(beforeTab));
    const transcript = await window.evaluate(
      (scope) => window.api.chat.getTranscriptPage(scope),
      target,
    );
    expect(
      transcript.messages.find((message) =>
        message.blocks.some(
          (block) => block.type === 'text' && block.text === text,
        ),
      ),
    ).toMatchObject({
      userMessageSource: 'agent',
      agentSent: {
        chatTitle: 'Release coordination',
        sender: {
          kind: 'project',
          projectId: source.projectId,
          taskId: source.worktreeId,
          chatId: source.chatId,
        },
      },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
