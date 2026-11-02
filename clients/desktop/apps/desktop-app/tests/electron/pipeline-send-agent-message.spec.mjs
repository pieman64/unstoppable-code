// CAN-5326 (5a-2): the `builtin/send-agent-message` host step sends to a
// project chat through desktop main's admitted-send path. One run creates a
// chat whose mock turn keeps streaming, queues behind that turn, then steers
// into it; each step records a `chat_send` receipt, and the chat shows the
// pipeline name on every message. A second run names a missing task and fails
// `not_found` with every output present.
//
// Offline: seeded global pipelines, no cloud account (so the owner is the
// fixed Personal value), and a mock-server scenario for the provider turn.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
  seedStoredPipeline,
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const LIBRARY = 'workflows-library';
const JOB = 'send';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const HISTORY_CHAT_ID = 'send-agent-message-history';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/.
const MARKER = 'Canopy-CPIPELINESEND';
const OUTPUT_NAMES = [
  'chat_id',
  'state',
  'project_id',
  'bot_id',
  'task_id',
  'chat_created',
  'message_id',
  'queued_message_id',
  'turn_id',
  'accepted_at',
  'steer_unavailable_reason',
  'failure_reason',
];

function globalPipelineYaml(name, steps) {
  return [
    `name: ${name}`,
    'on: dispatch',
    'scope: global',
    'jobs:',
    `  ${JOB}:`,
    '    steps:',
    ...steps,
    '',
  ].join('\n');
}

/** Starts a global pipeline from Workflows with no task, as Personal. */
async function runGlobalPipeline(window, app, pipelineId) {
  await app.openWorkflowsTab(LIBRARY);
  await app
    .workflowsLibraryPipelineRow(pipelineId)
    .getByTestId('workflows-library-run')
    .click();
  const modal = window.getByTestId('pipeline-trigger-modal');
  await expect(modal).toBeVisible();
  const run = modal.getByTestId('pipeline-trigger-modal-run');
  await expect(run).toHaveText('Continue');
  await run.click();
  await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveText(
    'Personal',
  );
  await expect(run).toHaveText('Run');
  await run.click();
  await expect(modal).toHaveCount(0);
}

/** The id of the only execution recorded for `pipelineId`. */
async function waitForExecutionId(executionsDir, pipelineId) {
  let executionId;
  await expect
    .poll(
      () => {
        if (!existsSync(executionsDir)) return undefined;
        for (const name of readdirSync(executionsDir)) {
          if (!name.endsWith('.json')) continue;
          const state = JSON.parse(
            readFileSync(path.join(executionsDir, name), 'utf8'),
          );
          if (state.pipeline_id === pipelineId) {
            executionId = state.id;
            return executionId;
          }
        }
        return undefined;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return executionId;
}

function stepReader(executionsDir, executionId) {
  const executionFile = path.join(executionsDir, `${executionId}.json`);
  return (stepId) => {
    if (!existsSync(executionFile)) return undefined;
    return JSON.parse(readFileSync(executionFile, 'utf8')).jobs?.[JOB]?.steps?.[
      stepId
    ];
  };
}

function seed(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  // A chat with history, so the first step creates a chat instead of
  // reusing an empty one.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: HISTORY_CHAT_ID,
    tabs: [
      {
        id: HISTORY_CHAT_ID,
        title: 'Earlier work',
        messages: [
          {
            id: 'history-user',
            role: 'user',
            timestamp: Date.parse('2026-10-28T12:00:00.000Z'),
            blocks: [{ type: 'text', text: 'Earlier context' }],
          },
        ],
      },
    ],
  });
}

test('builtin send-agent-message creates, queues and steers through desktop main', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'pipeline-send-agent-message-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seed(userDataDir);

  const startText = `[${MARKER}] Start the nightly triage`;
  const queueText = `[${MARKER}] Then list the open issues`;
  const steerText = `[${MARKER}] Focus on the failing tests first`;
  const target = [
    `          project_id: ${WORKSPACE_ID}`,
    `          task_id: ${WORKTREE_ID}`,
  ];
  const sendId = 'host-send-agent-message';
  const sendName = 'Nightly triage sender';
  seedStoredPipeline({
    userDataDir,
    id: sendId,
    name: sendName,
    yaml: globalPipelineYaml(sendName, [
      '      - id: first',
      '        uses: builtin/send-agent-message',
      '        with:',
      ...target,
      `          text: "${startText}"`,
      '      - id: queue',
      '        uses: builtin/send-agent-message',
      '        with:',
      ...target,
      '          chat_id: ${{ steps.first.outputs.chat_id }}',
      '          mode: queue',
      `          text: "${queueText}"`,
      '      - id: steer',
      '        uses: builtin/send-agent-message',
      '        with:',
      ...target,
      '          chat_id: ${{ steps.first.outputs.chat_id }}',
      '          mode: steer',
      `          text: "${steerText}"`,
    ]),
  });
  const missingId = 'host-send-agent-message-missing-task';
  const missingName = 'Send to a missing task';
  seedStoredPipeline({
    userDataDir,
    id: missingId,
    name: missingName,
    yaml: globalPipelineYaml(missingName, [
      '      - id: send',
      '        uses: builtin/send-agent-message',
      '        continue_on_error: true',
      '        with:',
      `          project_id: ${WORKSPACE_ID}`,
      '          task_id: missing-task',
      '          text: Never sent',
      '      - id: report',
      '        run: echo "result ${{ steps.send.outputs.failure_reason }}"',
    ]),
  });

  // The first turn keeps streaming, so the next two sends find it busy.
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        {
          text: 'The triage turn is still running. '.repeat(20),
          streamMs: 90_000,
          chunkChars: 8,
        },
      ],
    },
  });

  const executionsDir = path.join(userDataDir, 'pipeline-executions');
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await runGlobalPipeline(window, app, sendId);
    const executionId = await waitForExecutionId(executionsDir, sendId);
    const readStep = stepReader(executionsDir, executionId);
    await expect
      .poll(() => readStep('steer')?.status, { timeout: 90_000 })
      .toBe('success');

    const first = readStep('first');
    const queued = readStep('queue');
    const steered = readStep('steer');
    const chatId = first.outputs.chat_id;
    expect(chatId).toBeTruthy();
    expect(chatId).not.toBe(HISTORY_CHAT_ID);
    for (const step of [first, queued, steered]) {
      expect(step.status).toBe('success');
      expect(Object.keys(step.outputs).sort()).toEqual(
        [...OUTPUT_NAMES].sort(),
      );
      expect(step.outputs).toMatchObject({
        chat_id: chatId,
        project_id: WORKSPACE_ID,
        bot_id: '',
        task_id: WORKTREE_ID,
        failure_reason: '',
      });
      expect(step.outputs.message_id).toBeTruthy();
      expect(step.outputs.accepted_at).toBeTruthy();
      expect(step.chat_send).toMatchObject({
        version: 1,
        address: {
          kind: 'project',
          projectId: WORKSPACE_ID,
          taskId: WORKTREE_ID,
          chatId,
        },
        userMessageId: step.outputs.message_id,
        state: step.outputs.state,
      });
    }
    expect(first.outputs).toMatchObject({
      state: 'sent',
      chat_created: 'true',
      queued_message_id: '',
      steer_unavailable_reason: '',
    });
    expect(first.chat_send.chatCreated).toBe(true);
    expect(queued.outputs).toMatchObject({
      state: 'queued',
      chat_created: 'false',
      steer_unavailable_reason: '',
    });
    expect(queued.outputs.queued_message_id).toBeTruthy();
    // The mock Claude provider can steer, so the message joins the turn.
    expect(steered.outputs).toMatchObject({
      state: 'steered',
      chat_created: 'false',
      steer_unavailable_reason: '',
    });

    // The created chat shows the pipeline name on each message, and none of
    // the hidden sender note.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const tab = window.getByTestId(`panel-tab-panel-chat-${chatId}`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();
    const panel = window.getByTestId('panel-content-chat');
    const startBubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: startText });
    const startTitle = startBubble.getByTestId('agent-sent-title');
    await expect(startTitle).toHaveText(sendName, { timeout: 30_000 });
    await expect(startTitle).toHaveAttribute('data-sender', 'pipeline');
    // The queued message waits in the queue row and the steer is pending in
    // the running turn (or already in the transcript); each shows the title.
    for (const text of [queueText, steerText]) {
      const title = panel
        .locator('div')
        .filter({ hasText: text })
        .filter({ has: window.getByTestId('agent-sent-title') })
        .last()
        .getByTestId('agent-sent-title');
      await expect(title).toHaveText(sendName, { timeout: 30_000 });
      await expect(title).toHaveAttribute('data-sender', 'pipeline');
    }
    await expect(panel.getByText('agent-sender-context')).toHaveCount(0);
    await expect(panel.getByText('system_instruction')).toHaveCount(0);
    await panel.getByTestId('chat-stop-generation').click();

    // A missing task fails before any effect, with every output present.
    await runGlobalPipeline(window, app, missingId);
    const missingExecutionId = await waitForExecutionId(
      executionsDir,
      missingId,
    );
    const readMissingStep = stepReader(executionsDir, missingExecutionId);
    await expect
      .poll(() => readMissingStep('report')?.status, { timeout: 90_000 })
      .toBe('success');
    const missing = readMissingStep('send');
    // `continue_on_error` keeps the run going; the step's outcome is the failure.
    expect(missing.outcome).toBe('failure');
    expect(missing.error).toContain(
      `Task \`missing-task\` isn't in project \`${WORKSPACE_ID}\``,
    );
    expect(Object.keys(missing.outputs).sort()).toEqual(
      [...OUTPUT_NAMES].sort(),
    );
    expect(missing.outputs).toMatchObject({
      failure_reason: 'not_found',
      chat_id: '',
      state: '',
      chat_created: 'false',
      message_id: '',
    });
    expect(missing.chat_send).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

// CAN-5381 (5c-4): once an automation's pipeline ends, its run records the
// chat the pipeline sent to. Opening the run still opens the execution; its
// Go to chat action opens the chat at the sent turn, and an armed
// automation_run watcher fires once with the chat in its event.
test('an automation pipeline run records the chat it sent to', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'pipeline-run-chat-send-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seed(userDataDir);
  const marker = 'Canopy-CAUTOMATIONSEND';
  const text = `[${marker}] Summarize the overnight failures`;
  const pipelineId = 'automation-chat-send';
  const pipelineName = 'Overnight summary sender';
  seedStoredPipeline({
    userDataDir,
    id: pipelineId,
    name: pipelineName,
    yaml: globalPipelineYaml(pipelineName, [
      '      - id: send',
      '        uses: builtin/send-agent-message',
      '        with:',
      `          project_id: ${WORKSPACE_ID}`,
      `          task_id: ${WORKTREE_ID}`,
      `          text: "${text}"`,
    ]),
  });
  const activityId = 'automation-pipeline-chat-send';
  const automationName = 'Overnight summary';
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: automationName,
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId,
          pipelineSource: 'user',
          pipelineName,
        },
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'automation-chat-send-watcher',
        label: 'Overnight summary watcher',
        trigger: 'automation_run',
        target: {
          kind: 'automation',
          automationId: activityId,
          automationName,
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: HISTORY_CHAT_ID,
          chatTitle: 'Earlier work',
        },
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: 'Two suites failed overnight.' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openAutomationsPage();
    await app
      .workflowsLibraryAutomationRow(activityId)
      .getByTestId('workflows-library-run')
      .click();

    // The run records the chat once its execution ends.
    let result = {};
    await expect
      .poll(
        () => {
          const run = JSON.parse(
            readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
          ).recentRuns?.find((entry) => entry.activityId === activityId);
          result = run?.result ?? {};
          return result.chatId;
        },
        { timeout: 90_000 },
      )
      .toBeTruthy();
    expect(result).toMatchObject({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      pipelineExecutionId: expect.any(String),
      userMessageId: expect.any(String),
    });
    expect(result.chatId).not.toBe(HISTORY_CHAT_ID);

    // The watcher fires once, with the chat in its event.
    const deliveries = () =>
      electronApp.evaluate(
        () => globalThis.__CANOPY_E2E_WATCHER_DELIVERIES__ ?? [],
      );
    await expect
      .poll(async () => (await deliveries()).length, { timeout: 60_000 })
      .toBe(1);
    const [delivery] = await deliveries();
    const fired = JSON.parse(
      /<([a-z0-9_]+)_watcher_event>\s*([\s\S]*?)\s*<\/\1_watcher_event>/.exec(
        delivery.hiddenContextText ?? '',
      )?.[2] ?? 'null',
    );
    expect(fired?.event?.dispatched).toMatchObject({
      chatId: result.chatId,
      userMessageId: result.userMessageId,
      pipelineExecutionId: result.pipelineExecutionId,
    });

    // Run history: Go to chat opens the chat at the sent turn.
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(activityId),
      'view-runs',
    );
    const row = window
      .getByTestId('automation-runs-section')
      .getByTestId('workflows-run-row')
      .first();
    await row.getByTestId('workflows-run-menu').click();
    await window.getByTestId('workflows-run-menu-item-go-to-chat').click();
    await expect(
      window.locator(
        `[data-chat-sticky-section="${result.userMessageId}"][data-chat-turn-focus="true"]`,
      ),
    ).toBeVisible({ timeout: 30_000 });
    expect(await deliveries()).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
