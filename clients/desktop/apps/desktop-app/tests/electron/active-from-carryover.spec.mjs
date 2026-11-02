import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  injectChatEvent,
  publishTurnLifecycle,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';
import {
  closeWorkspaceContextMenu,
  expectWorkspaceContext,
  openWorkspaceContextMenu,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

// CAN-2959: activity left running (or finished unread) in another context is
// flagged by a small blue dot, on the footer scope switcher (CAN-3522) and on
// that context in the switcher's menu. There is no Active-from pane, and the
// account avatar keeps its dot for usage warnings only.
async function expectContextDot(window, contextId, visible) {
  await expect(window.getByTestId('sidebar-context-attention-dot')).toHaveCount(
    visible ? 1 : 0,
  );
  await expect(window.getByTestId('sidebar-account-attention-dot')).toHaveCount(
    0,
  );
  await openWorkspaceContextMenu(window);
  await expect(
    window.getByTestId(`sidebar-context-activity-${contextId}`),
  ).toHaveCount(visible ? 1 : 0);
  await closeWorkspaceContextMenu(window);
}

test('a foreign running turn marks its context with a dot until completed carryover expires on the next switch', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2959_active_from';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2959-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await expect
      .poll(() => window.evaluate(() => window.api.workspaceContext.get()))
      .toMatchObject({
        organizations: [{ id: ORG_CONTEXT_A }, { id: ORG_CONTEXT_B }],
      });
    await expectWorkspaceContext(window, 'personal');
    await window
      .getByTestId('app-sidebar')
      .getByText('Personal planning chat', { exact: true })
      .click();
    await expect(
      window.getByText('Plan my personal work.', { exact: true }),
    ).toBeVisible();
    const target = {
      projectId: 'cowork-default',
      worktreeId: 'context-personal-chat',
      chatId: 'context-chat-tab',
      turnUserMessageId: 'carryover-turn',
    };
    await electronApp.evaluate(
      async (_, target) => globalThis.__CANOPY_E2E_HOLD_CHAT_TURN__(target),
      target,
    );
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Finish carried work',
        canopy_turn_user_message_id: 'carryover-turn',
      },
    });
    await publishTurnLifecycle(electronApp, { ...target, phase: 'start' });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectContextDot(window, 'personal', true);
    await expect(window.getByText('Active from Personal')).toHaveCount(0);
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'assistant',
        message: {
          id: 'carryover-answer',
          role: 'assistant',
          content: [{ type: 'text', text: 'Finished carried work' }],
        },
      },
    });
    await publishTurnLifecycle(electronApp, { ...target, phase: 'end' });
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'result',
        is_error: false,
        result: 'Finished carried work',
        canopy_turn_user_message_id: 'carryover-turn',
      },
    });
    await expectContextDot(window, 'personal', true);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expectContextDot(window, 'personal', false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a pipeline completion carries new unread attention and resets on another switch', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2959_pipeline';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2959-pipeline-'),
  );
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: ['active-from-worktree'],
  });
  const { state } = seedPipelineExecution({
    userDataDir,
    workspaceId: 'context-personal',
    worktreeId: 'active-from-worktree',
    execution: {
      id: 'active-from-pipeline',
      pipelineName: 'Carried pipeline',
      status: 'success',
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await injectPipelineExecutionEvent(electronApp, {
      state: { ...state, status: 'running', completed_at: undefined },
      type: 'execution.started',
    });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectContextDot(window, 'personal', true);
    await injectPipelineExecutionEvent(electronApp, {
      state: {
        ...state,
        status: 'success',
        completed_at: '2026-09-23T12:00:00.000Z',
      },
      type: 'execution.completed',
    });
    await expectContextDot(window, 'personal', true);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expectContextDot(window, 'personal', false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('an account change fences old activity until a fresh source event', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2959_account_fence';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2959-pipeline-'),
  );
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: ['active-from-worktree'],
  });
  const { state } = seedPipelineExecution({
    userDataDir,
    workspaceId: 'context-personal',
    worktreeId: 'active-from-worktree',
    execution: {
      id: 'active-from-pipeline',
      pipelineName: 'Carried pipeline',
      status: 'success',
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await injectPipelineExecutionEvent(electronApp, {
      state: { ...state, status: 'running', completed_at: undefined },
      type: 'execution.started',
    });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectContextDot(window, 'personal', true);
    await window.evaluate(() => window.api.disconnectCanopyCloudAccount());
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, 'personal');
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectContextDot(window, 'personal', false);
    await injectPipelineExecutionEvent(electronApp, {
      state: { ...state, status: 'running', completed_at: undefined },
      type: 'execution.started',
    });
    await expectContextDot(window, 'personal', true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a scheduled retry stays active under its original turn and foreign Stop cancels it', async () => {
  test.setTimeout(120_000);
  const { createFixture, seedPreferences, closeFixture } =
    await import('./codexPipelineRuntime.mjs');
  const fixture = createFixture(
    'transient-capacity',
    'Retry should have been cancelled.',
  );
  const apiKey = 'csk_can2959_retry_stop';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2959-retry-'),
  );
  seedOrgContextScoping(userDataDir);
  seedPreferences(userDataDir);
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    'cowork-default',
    'chats',
    'context-personal-chat.json',
  );
  const chats = JSON.parse(readFileSync(chatPath, 'utf8'));
  Object.assign(chats.tabs[0], {
    providerType: 'codex',
    executionHarness: 'codex',
    model: 'gpt-6-sol',
  });
  writeFileSync(chatPath, JSON.stringify(chats));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...fixture.env, ...ORG_CONTEXT_ENV },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await window
      .getByTestId('app-sidebar')
      .getByText('Personal planning chat', { exact: true })
      .click();
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill('Exercise transient retry and foreign Stop.');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      panel.getByTestId('chat-input-transient-retry-banner'),
    ).toContainText('attempt 1 of 5', { timeout: 20_000 });
    const originalTurnId = await window.evaluate(async () => {
      const state = await window.api.chat.getState({
        projectId: 'cowork-default',
        worktreeId: 'context-personal-chat',
      });
      return state.tabsFile.tabs
        .find((tab) => tab.id === 'context-chat-tab')
        .messages.filter((message) => message.role === 'user')
        .at(-1).id;
    });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expectContextDot(window, 'personal', true);
    const projection = await window.evaluate(() =>
      window.api.foreignActivity.get(),
    );
    const stopTarget = projection.groups[0].workspaces[0].stopTargets[0];
    expect(stopTarget.operationId).toBe(originalTurnId);
    await window.evaluate(
      ({ epoch, target }) => window.api.foreignActivity.stop({ epoch, target }),
      { epoch: projection.epoch, target: stopTarget },
    );
    await expect
      .poll(() =>
        window.evaluate(() => window.api.chat.getTransientRetrySnapshot()),
      )
      .toEqual([]);
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
