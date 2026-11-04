// Phase 13: execute the orchestration recipe through real root-chat tools.
// The mock scripts bind runtime-returned addresses between turns, as in phase 11;
// they do not emulate DispatchAction, send acceptance, or watcher delivery.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedCoworkWorkspace,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const SOURCE = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'orchestrate-root',
};
const SOURCE_TITLE = 'Phase 13 coordination';
const ROOT_MARKER = 'Canopy-CP13ORCHESTRATOR';
const COWORK_PROJECT = 'orchestrate-cowork';
const CODE_PROJECT = 'demo-ts-npm-next';
const CREATED_AT = '2026-10-17T12:00:00.000Z';

function priorHistory(id) {
  // Keep titles stable rather than exercising first-message auto-titling.
  return [
    {
      id: `${id}-user`,
      role: 'user',
      timestamp: Date.parse(CREATED_AT),
      blocks: [{ type: 'text', text: 'Prepare for the handoff.' }],
    },
    {
      id: `${id}-assistant`,
      role: 'assistant',
      timestamp: Date.parse(CREATED_AT) + 1000,
      blocks: [{ type: 'text', text: 'Ready.' }],
    },
  ];
}

function toolId(tag, index = 0) {
  return `toolu_orchestrate_${tag}_${index}`;
}

function actionSteps(tag, actions, reply) {
  return [
    ...actions.map((action, index) => ({
      toolCalls: [
        {
          id: toolId(tag, index),
          name: 'mcp__canopy__DispatchAction',
          input: { action },
        },
      ],
      stopReason: 'tool_use',
    })),
    { text: reply, stopReason: 'end_turn' },
  ];
}

async function transcript(window, scope = SOURCE) {
  return window.evaluate(
    (address) => window.api.chat.getTranscriptPage(address),
    scope,
  );
}

async function resultFor(window, tag, index = 0) {
  const page = await transcript(window);
  const result = page.messages
    .flatMap((message) => message.blocks)
    .find(
      (block) =>
        block.type === 'tool_result' && block.toolUseId === toolId(tag, index),
    );
  expect(result, `Missing ${tag} tool result`).toBeDefined();
  expect(result.isError, result.output).not.toBe(true);
  const response = JSON.parse(result.output);
  expect(response, result.output).toMatchObject({ ok: true });
  return response.result;
}

test('orchestrator hands off cowork and code work, wakes, reads reports and follows up without automations', async () => {
  test.setTimeout(420_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-orchestrate-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_PROJECT,
    name: 'Orchestrate research',
    collapsed: false,
    providerType: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    mergeIndex: true,
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      defaultChatProvider: 'claude',
      defaultWorktreeProvider: 'claude',
      defaultChatModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'off' },
      },
      defaultWorktreeModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'off' },
      },
      defaultStandaloneChatInterfaceMode: 'canopy',
      defaultChatInterfaceMode: 'canopy',
    },
  });
  for (const projectId of [SOURCE.projectId, CODE_PROJECT, COWORK_PROJECT]) {
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: projectId,
      defaultMode: 'full-access',
    });
  }
  for (const [projectId, chatId, title] of [
    [SOURCE.projectId, SOURCE.chatId, SOURCE_TITLE],
    [CODE_PROJECT, 'orchestrate-existing', 'Existing checkout chat'],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: projectId,
      worktreeId: 'demo-main',
      providerType: 'claude',
      activeTabId: chatId,
      tabs: [
        {
          id: chatId,
          title,
          // A user-owned name survives auto-titling, so agent-sent titles stay stable.
          customTitle: title,
          createdAt: CREATED_AT,
          model: 'claude-sonnet-4-6',
          thinkingLevel: 'off',
          interfaceMode: 'canopy',
          messages: priorHistory(chatId),
        },
      ],
    });
  }

  // Request tags reset the mock's step cursor despite existing chat history.
  // The wake tag is supplied ONLY by the inline watcher's follow-up instruction.
  const stepsByRequestTag = {};
  async function script(tag, actions, reply) {
    stepsByRequestTag[tag] = actionSteps(tag, actions, reply);
    await registerScenario(DEFAULT_MOCK_BASE_URL, ROOT_MARKER, {
      llm: {
        steps: [
          {
            text: 'Unexpected untagged orchestration turn.',
            stopReason: 'end_turn',
          },
        ],
        stepsByRequestTag,
      },
    });
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${SOURCE.projectId}"][data-worktree-id="${SOURCE.worktreeId}"]`,
      )
      .first()
      .evaluate((element) => element.click());
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SOURCE.chatId}`),
    ).toBeVisible();

    async function run(tag, action) {
      const reply = `Orchestrator finished ${tag}.`;
      await script(tag, [action], reply);
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          `[${ROOT_MARKER}] [Canopy-Mock-Request:${tag}] Execute the next handoff step.`,
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(panel.getByText(reply).first()).toBeVisible({
        timeout: 90_000,
      });
      return resultFor(window, tag);
    }

    const before = await run('before', {
      type: 'automation.list',
      includeRuns: false,
    });
    expect(before).toEqual({ activities: [] });

    const cowork = await run('create_cowork', {
      type: 'projects.create_task',
      projectId: COWORK_PROJECT,
      title: 'Research the release checklist',
      // No initialMessage: the brief and watcher must be accepted together.
    });
    expect(cowork).toEqual({
      address: {
        projectId: COWORK_PROJECT,
        taskId: expect.any(String),
        chatId: expect.any(String),
      },
      taskCreated: true,
      chatCreated: true,
    });

    async function handoff(kind, address) {
      const targetMarker = `Canopy-CP13${kind.toUpperCase()}IMPLEMENTER`;
      const report = `${kind} report: release checklist reviewed; ready for follow-up.`;
      const brief = `[${targetMarker}] [Canopy-Mock-Request:brief] Review the release checklist and report back.`;
      const followup = `[${targetMarker}] [Canopy-Mock-Request:followup] Thanks for the report; check the final acceptance item.`;
      const acknowledgment = `${kind} follow-up accepted.`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, targetMarker, {
        llm: {
          steps: [
            {
              text: 'Unexpected untagged implementer turn.',
              stopReason: 'end_turn',
            },
          ],
          stepsByRequestTag: {
            brief: { text: report, streamMs: 1500, stopReason: 'end_turn' },
            followup: { text: acknowledgment, stopReason: 'end_turn' },
          },
        },
      });
      const wakeTag = `${kind}_wake`;
      const wakeReply = `Orchestrator handled the ${kind} completion.`;
      await script(
        wakeTag,
        [
          { type: 'projects.get_last_agent_response', ...address },
          { type: 'projects.send_message', ...address, text: followup },
        ],
        wakeReply,
      );
      const receipt = await run(`${kind}_brief`, {
        type: 'projects.send_message',
        ...address,
        text: brief,
        watchers: [
          {
            label: `${kind} implementer completion`,
            followUpInstruction: `[Canopy-Mock-Request:${wakeTag}] Read the completed report, then send a follow-up.`,
          },
        ],
      });
      expect(receipt).toMatchObject({
        address,
        disposition: 'started',
        messageId: expect.any(String),
        acceptedAt: expect.any(String),
        watcherReceipts: [
          { watcherId: expect.any(String), disposition: 'created' },
        ],
      });
      // No user prompt resumes the orchestrator here: only real completion wakes it.
      await expect(panel.getByText(wakeReply).first()).toBeVisible({
        timeout: 90_000,
      });
      const read = await resultFor(window, wakeTag);
      expect(read).toMatchObject({
        address,
        message: { role: 'assistant', text: report },
      });
      const followupReceipt = await resultFor(window, wakeTag, 1);
      expect(followupReceipt).toMatchObject({ address, watcherReceipts: [] });
      expect(['started', 'queued']).toContain(followupReceipt.disposition);
      const sourcePage = await transcript(window);
      expect(
        sourcePage.messages.some(
          (message) =>
            message.role === 'user' &&
            message.watcherFired &&
            message.blocks.some(
              (block) =>
                block.type === 'text' &&
                block.text.includes(`${kind} implementer completion`),
            ),
        ),
      ).toBe(true);
      const targetScope = {
        projectId: address.projectId,
        worktreeId: address.taskId,
        chatId: address.chatId,
      };
      await expect
        .poll(
          async () => {
            const page = await transcript(window, targetScope);
            return page.messages
              .flatMap((message) => message.blocks)
              .some(
                (block) =>
                  block.type === 'text' && block.text === acknowledgment,
              );
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      const targetPage = await transcript(window, targetScope);
      for (const text of [brief, followup]) {
        const sent = targetPage.messages.find(
          (message) =>
            message.role === 'user' &&
            message.blocks.some(
              (block) => block.type === 'text' && block.text === text,
            ),
        );
        expect(sent?.agentSent).toMatchObject({
          chatTitle: SOURCE_TITLE,
          sender: {
            kind: 'project',
            projectId: SOURCE.projectId,
            taskId: SOURCE.worktreeId,
            chatId: SOURCE.chatId,
          },
        });
      }
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${SOURCE.chatId}`),
      ).toBeVisible();
    }

    await handoff('cowork', cowork.address);

    // A seeded real checkout stands in for kickoff's existing CLI creation path.
    const tasks = await run('find_code', {
      type: 'projects.list_tasks',
      projectId: CODE_PROJECT,
    });
    const checkout = tasks.items.find((task) => task.taskId === 'demo-main');
    expect(checkout).toMatchObject({
      projectId: CODE_PROJECT,
      kind: 'worktree',
    });
    const code = await run('create_code_chat', {
      type: 'projects.create_task_chat',
      projectId: checkout.projectId,
      taskId: checkout.taskId,
    });
    expect(code).toEqual({
      address: {
        projectId: CODE_PROJECT,
        taskId: checkout.taskId,
        chatId: expect.any(String),
      },
      taskCreated: false,
      chatCreated: true,
    });
    expect(code.address.chatId).not.toBe('orchestrate-existing');
    await handoff('code', code.address);

    const after = await run('after', {
      type: 'automation.list',
      includeRuns: false,
    });
    expect(after).toEqual(before);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
