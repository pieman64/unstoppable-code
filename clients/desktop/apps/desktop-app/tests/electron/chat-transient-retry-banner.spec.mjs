import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'transient-retry-banner-chat';
const COWORK_WORKSPACE_ID = 'transient-retry-cowork';
const COWORK_ENTRY_ID = 'transient-retry-entry';
const COWORK_CHAT_ID = 'transient-retry-cowork-chat';

function seedCoworkRetryChat(userDataDir) {
  const createdAt = '2026-09-17T12:00:00.000Z';
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    COWORK_WORKSPACE_ID,
  );
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_WORKSPACE_ID,
        name: 'Transient Retry Cowork',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { createdAt, archiveRetentionDays: null },
  });
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, title: 'Retry recovery', createdAt }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${COWORK_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: COWORK_CHAT_ID,
    tabs: [
      {
        id: COWORK_CHAT_ID,
        title: 'Cowork retry recovery',
        createdAt,
        kind: 'chat',
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'gpt-6-sol',
        messages: [
          {
            id: 'cowork-retry-seed-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Seed Cowork retry history.' }],
            timestamp: Date.parse(createdAt),
          },
        ],
      },
    ],
  });
}

test('transient retry banner renders its countdown and dismisses', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-transient-retry-banner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Transient Retry Banner' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'canopy_transient_retry_state',
        provider: 'claude',
        active: true,
        attempt: 2,
        maxAttempts: 5,
        nextRetryAt: Date.now() + 90_000,
        exhausted: false,
      },
    });

    const banner = window.getByTestId('chat-input-transient-retry-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('attempt 2 of 5');
    await expect(banner).toContainText(/Retrying in 1:2\d/);

    await window.getByTestId('chat-input-transient-retry-dismiss').click();
    await expect(banner).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Real provider-session coverage: command activity, terminal capacity failure,
// late child output, backoff, and continuation on the same thread/model.
for (const [mode, errorText] of [
  ['transient-capacity', 'Selected model is at capacity.'],
  [
    'transient-cyber-access',
    'The access_programs parameter is not enabled for this organization.',
  ],
]) {
  test(`${mode} failure after activity settles the turn and counts down to continuation`, async () => {
    test.setTimeout(120_000);
    const {
      createFixture,
      seedPreferences,
      conversationRequests,
      closeFixture,
    } = await import('./codexPipelineRuntime.mjs');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-capacity-retry-'),
    );
    const fixture = createFixture(mode, 'Recovered after capacity failure.');
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Capacity retry',
          providerType: 'codex',
          model: 'gpt-6-sol',
        },
      ],
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      await panel
        .getByRole('textbox')
        .first()
        .fill('Exercise transient retry after doing work.');
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel).toContainText(errorText, {
        timeout: 20_000,
      });
      const banner = panel.getByTestId('chat-input-transient-retry-banner');
      await expect(banner).toContainText('attempt 1 of 5');
      await expect(banner).toContainText(/Retrying in 0:[0-3]\d/);
      const countdown = await banner.textContent();
      await expect.poll(() => banner.textContent()).not.toBe(countdown);
      const state = await window.evaluate(
        async ({ projectId, worktreeId }) =>
          window.api.chat.getState({ projectId, worktreeId }),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      const timers = state.tabsFile.tabs
        .find((tab) => tab.id === 'transient-retry-banner-chat')
        .messages.flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer');
      expect(timers.length).toBeGreaterThan(0);
      expect(timers.every((timer) => timer.completedAt !== null)).toBe(true);
      await expect(panel).toContainText('Recovered after capacity failure.', {
        timeout: 45_000,
      });
      await expect(banner).toBeHidden();
      const initial = conversationRequests(fixture.logPath).find(
        (request) =>
          request.method === 'turn/start' &&
          JSON.stringify(request.params.input).includes(
            'Exercise transient retry',
          ),
      );
      const turns = conversationRequests(fixture.logPath).filter(
        (request) =>
          request.method === 'turn/start' &&
          request.params.threadId === initial.params.threadId,
      );
      expect(turns).toHaveLength(2);
      expect(turns[1].params.model).toBe(turns[0].params.model);
      expect(turns[1].params.input).toEqual([
        expect.objectContaining({ type: 'text', text: 'Continue' }),
      ]);
      // Retry/resume sends share the host send path with automations. Its live
      // display projection must not overwrite canonical tools or turn timers.
      await expect
        .poll(async () => {
          const recovered = await window.evaluate(
            async ({ projectId, worktreeId }) =>
              window.api.chat.getState({ projectId, worktreeId }),
            { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
          );
          return recovered.runtimeByChatId[CHAT_ID]?.status;
        })
        .toBe('completed');
      const agentSteps = panel.getByRole('button', {
        name: /^Agent steps:/,
      });
      for (const step of await agentSteps.all()) {
        if ((await step.getAttribute('aria-expanded')) === 'false') {
          await step.click();
        }
      }
      const recoveredCommand = panel
        .getByTestId('chat-tool-call')
        .filter({ hasText: 'echo retry-command-marker' });
      await expect(recoveredCommand).toHaveCount(1);
      await recoveredCommand.click();
      await expect(
        panel.getByText('retry-command-marker', { exact: true }),
      ).toBeVisible();
      await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
        'data-state',
        'completed',
      );
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const reloaded = await window.evaluate(
        async ({ projectId, worktreeId }) =>
          window.api.chat.getState({ projectId, worktreeId }),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      const blocks = reloaded.tabsFile.tabs
        .find((tab) => tab.id === CHAT_ID)
        .messages.flatMap((message) => message.blocks);
      expect(
        blocks.filter((block) => block.type === 'turn_timer'),
      ).toHaveLength(2);
      expect(
        blocks
          .filter((block) => block.type === 'turn_timer')
          .every((block) => typeof block.completedAt === 'number'),
      ).toBe(true);
      expect(blocks).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          toolName: 'command',
          input: 'echo retry-command-marker',
        }),
      );
      expect(blocks).not.toContainEqual({
        type: 'text',
        text: 'echo retry-command-marker',
      });
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });
}

test('cowork retry preserves canonical tools and timers after reload', async () => {
  test.setTimeout(120_000);
  const { createFixture, seedPreferences, conversationRequests, closeFixture } =
    await import('./codexPipelineRuntime.mjs');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-capacity-retry-'),
  );
  const fixture = createFixture(
    'transient-capacity',
    'Recovered Cowork after capacity failure.',
  );
  seedPreferences(userDataDir);
  seedCoworkRetryChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const entryRow = window.getByTestId(
      `sidebar-work-entry-${COWORK_ENTRY_ID}`,
    );
    await expect(entryRow).toBeVisible({ timeout: 30_000 });
    await entryRow.click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    await panel
      .getByRole('textbox')
      .first()
      .fill('Exercise transient retry in Cowork after doing work.');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel).toContainText(
      'Recovered Cowork after capacity failure.',
      {
        timeout: 45_000,
      },
    );
    const coworkInitial = conversationRequests(fixture.logPath).find(
      (request) =>
        request.method === 'turn/start' &&
        JSON.stringify(request.params.input).includes(
          'Exercise transient retry in Cowork',
        ),
    );
    const coworkTurns = conversationRequests(fixture.logPath).filter(
      (request) => request.method === 'turn/start',
    );
    expect(coworkInitial).toBeDefined();
    expect(coworkTurns).toHaveLength(2);
    expect(
      coworkTurns.every(
        (request) => request.params.threadId === coworkInitial.params.threadId,
      ),
    ).toBe(true);
    await expect
      .poll(async () => {
        const state = await window.evaluate(
          async ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: COWORK_WORKSPACE_ID, worktreeId: COWORK_ENTRY_ID },
        );
        return state.runtimeByChatId[COWORK_CHAT_ID]?.status;
      })
      .toBe('completed');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    const reloaded = await window.evaluate(
      async ({ projectId, worktreeId }) =>
        window.api.chat.getState({ projectId, worktreeId }),
      { projectId: COWORK_WORKSPACE_ID, worktreeId: COWORK_ENTRY_ID },
    );
    const blocks = reloaded.tabsFile.tabs
      .find((tab) => tab.id === COWORK_CHAT_ID)
      .messages.flatMap((message) => message.blocks);
    expect(blocks.filter((block) => block.type === 'turn_timer')).toHaveLength(
      2,
    );
    expect(
      blocks
        .filter((block) => block.type === 'turn_timer')
        .every((block) => typeof block.completedAt === 'number'),
    ).toBe(true);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use',
        toolName: 'command',
        input: 'echo retry-command-marker',
      }),
    );
    expect(blocks).not.toContainEqual({
      type: 'text',
      text: 'echo retry-command-marker',
    });
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});
