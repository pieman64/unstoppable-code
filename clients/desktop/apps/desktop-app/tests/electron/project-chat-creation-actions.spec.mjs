// Phase 11: real main-runtime creation actions, driven by mock Advisor turns.
// Empty creates use no target provider. Run with the standard headless harness.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { expandAppAdvisorToFullWindow } from './helpers/appAdvisorFullWindow.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAdvisorGroups } from './seeders/advisorItemGroupsFixture.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAgentModels,
  seedCoworkWorkspace,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const PROJECT_ID = 'creation-cowork';
const ORIGINAL_ENTRY = 'creation-original-entry';
const ORIGINAL_CHAT = 'creation-original-chat';
const CREATED_AT = '2026-10-17T12:00:00.000Z';
const AGENT_ID = 'agent_model_creation_helper';

function advisorTab(id) {
  return {
    id,
    title: 'Creation coordination',
    createdAt: CREATED_AT,
    providerType: 'claude',
    model: 'sonnet',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        timestamp: Date.parse(CREATED_AT),
        blocks: [
          {
            type: 'text',
            text: 'Coordinate work without changing my selection.',
          },
        ],
      },
      {
        id: `${id}-reply`,
        role: 'assistant',
        timestamp: Date.parse(CREATED_AT) + 1000,
        blocks: [{ type: 'text', text: 'Ready.' }],
      },
    ],
  };
}

async function registerCreationTurn(marker, action, reply) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: { action },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: reply, stopReason: 'end_turn' },
      ],
    },
  });
}

async function runCreationTurn(advisor, entryId, chatId, marker, reply) {
  await advisor.getByTestId(`app-advisor-nav-entry-${entryId}`).click();
  const panel = advisor.getByTestId('panel-content-chat');
  await panel
    .getByRole('textbox')
    .first()
    .fill(`[${marker}] Create the requested empty chat.`);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(reply).first()).toBeVisible({ timeout: 90_000 });
  // Main creation must not switch even the Advisor's own selected chat.
  await expect(
    advisor.getByTestId(`panel-tab-panel-chat-${chatId}`),
  ).toBeVisible();
  const transcript = await advisor.evaluate(
    (scope) => window.api.chat.getTranscriptPage(scope),
    { projectId: 'app-advisor', worktreeId: entryId, chatId },
  );
  const result = transcript.messages
    .flatMap((message) => message.blocks)
    .find((block) => block.type === 'tool_result');
  expect(result?.isError, result?.output).not.toBe(true);
  expect(result).toBeDefined();
  const response = JSON.parse(result.output);
  expect(response, result.output).toMatchObject({ ok: true });
  return response.result;
}

test('Advisor creates a cowork task then reuses its empty chat without changing the original selection', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-creation-'),
  );
  seedAdvisorGroups(userDataDir, { includeThird: true });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      defaultStandaloneChatInterfaceMode: 'canopy',
      defaultChatProvider: 'claude',
      appAdvisorNavCollapsed: false,
    },
  });
  for (const [entryId, chatId] of [
    ['advisor-first', 'creation-source-task'],
    ['advisor-second', 'creation-source-chat'],
    ['advisor-third', 'creation-source-agent'],
  ]) {
    writeJson(
      path.join(
        userDataDir,
        'app-workspaces',
        'app-advisor',
        'chats',
        `${entryId}.json`,
      ),
      { version: 1, activeTabId: chatId, tabs: [advisorTab(chatId)] },
    );
  }
  // Inherits the default model, so creation pins it to the target default.
  seedAgentModels(userDataDir, [
    {
      id: AGENT_ID,
      name: 'Creation helper',
      baseModel: 'default',
      instructions: 'Help with the created task.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ]);
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: PROJECT_ID,
    name: 'Creation research',
    collapsed: false,
    providerType: 'claude',
    defaultModel: 'sonnet',
  });
  writeJson(
    path.join(userDataDir, 'workspaces', PROJECT_ID, 'work-entries.json'),
    {
      version: 1,
      entries: [
        { id: ORIGINAL_ENTRY, title: 'Original task', createdAt: CREATED_AT },
      ],
    },
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: ORIGINAL_ENTRY,
    providerType: 'claude',
    activeTabId: ORIGINAL_CHAT,
    tabs: [{ ...advisorTab(ORIGINAL_CHAT), title: 'Original selected chat' }],
  });
  const taskMarker = 'Canopy-CP11CREATETASK';
  const chatMarker = 'Canopy-CP11CREATECHAT';
  await registerCreationTurn(
    taskMarker,
    {
      type: 'projects.create_task',
      projectId: PROJECT_ID,
      title: 'Created by action',
    },
    'The empty task is ready.',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${PROJECT_ID}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${ORIGINAL_ENTRY}`).click();
    const originalTab = window.getByTestId(
      `panel-tab-panel-chat-${ORIGINAL_CHAT}`,
    );
    await expect(originalTab).toBeVisible();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await expandAppAdvisorToFullWindow(advisor);
    const created = await runCreationTurn(
      advisor,
      'advisor-first',
      'creation-source-task',
      taskMarker,
      'The empty task is ready.',
    );
    expect(created).toEqual({
      address: {
        projectId: PROJECT_ID,
        taskId: expect.any(String),
        chatId: expect.any(String),
      },
      taskCreated: true,
      chatCreated: true,
    });
    expect(created.address.taskId).not.toBe(ORIGINAL_ENTRY);
    const entry = window.getByTestId(
      `sidebar-work-entry-${created.address.taskId}`,
    );
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry).toContainText('Created by action');
    await expect(originalTab).toBeVisible();

    await registerCreationTurn(
      chatMarker,
      {
        type: 'projects.create_task_chat',
        projectId: PROJECT_ID,
        taskId: created.address.taskId,
      },
      'The task chat is ready.',
    );
    const reused = await runCreationTurn(
      advisor,
      'advisor-second',
      'creation-source-chat',
      chatMarker,
      'The task chat is ready.',
    );
    expect(reused).toEqual({
      address: created.address,
      taskCreated: false,
      chatCreated: false,
    });
    await expect(originalTab).toBeVisible();
    const original = await window.evaluate(
      (scope) => window.api.chat.loadTabs(scope),
      { projectId: PROJECT_ID, worktreeId: ORIGINAL_ENTRY },
    );
    expect(original.activeTabId).toBe(ORIGINAL_CHAT);
    const createdState = await window.evaluate(
      (scope) => window.api.chat.loadTabs(scope),
      { projectId: PROJECT_ID, worktreeId: created.address.taskId },
    );
    expect(createdState.tabs.map((tab) => tab.id)).toEqual([
      created.address.chatId,
    ]);
    expect(createdState.tabs[0].messages).toEqual([]);

    // An explicit Agent never reuses the empty founding tab.
    const agentMarker = 'Canopy-CP11CREATEAGENTCHAT';
    await registerCreationTurn(
      agentMarker,
      {
        type: 'projects.create_task_chat',
        projectId: PROJECT_ID,
        taskId: created.address.taskId,
        model: AGENT_ID,
      },
      'The Agent chat is ready.',
    );
    const agentChat = await runCreationTurn(
      advisor,
      'advisor-third',
      'creation-source-agent',
      agentMarker,
      'The Agent chat is ready.',
    );
    expect(agentChat).toMatchObject({
      address: {
        projectId: PROJECT_ID,
        taskId: created.address.taskId,
      },
      taskCreated: false,
      chatCreated: true,
      agentId: AGENT_ID,
    });
    expect(agentChat.model).toMatch(new RegExp(`^${AGENT_ID}@.+`));
    expect(agentChat.address.chatId).not.toBe(created.address.chatId);
    const withAgent = await window.evaluate(
      (scope) => window.api.chat.loadTabs(scope),
      { projectId: PROJECT_ID, worktreeId: created.address.taskId },
    );
    expect(
      withAgent.tabs.map((tab) => [tab.id, tab.model, tab.messages.length]),
    ).toEqual([
      [created.address.chatId, createdState.tabs[0].model, 0],
      [agentChat.address.chatId, agentChat.model, 0],
    ]);

    // User-origin selection can reveal the returned, durable founding tab.
    await entry.click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${created.address.chatId}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
