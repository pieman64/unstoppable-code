// Cowork watcher final-message regression — a worktree chat completion fires
// a watcher into a regular Cowork chat. The watched agent's final report
// carries a marker absent from the visible watcher message; the mock provider
// returns the asserted follow-up only when that marker reaches Cowork through
// the hidden watcher context.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWatchers,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_CHAT_ID = 'watcher-target-chat';
const COWORK_WORKSPACE_ID = 'watcher-cowork';
const COWORK_ENTRY_ID = 'watcher-entry';
const COWORK_CHAT_ID = 'watcher-destination-chat';
const TARGET_MARKER = 'Canopy-CWATCHERTARGET';
const FINAL_MESSAGE_MARKER = 'Canopy-CWATCHERFINAL';
const TARGET_REPLY = `[${FINAL_MESSAGE_MARKER}] REPORT: target work finished.`;
const COWORK_REPLY_MARKER = 'Cowork received the watched agent final report';

function tallReply(marker, paragraphs) {
  return Array.from(
    { length: paragraphs },
    (_, index) => `${marker} paragraph ${index + 1} of the response.`,
  ).join('\n\n');
}

const COWORK_REPLY = tallReply(COWORK_REPLY_MARKER, 16);

function seedCoworkDestination(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const collectionKey = Array.isArray(index.items) ? 'items' : 'workspaces';
  index[collectionKey].push({
    id: COWORK_WORKSPACE_ID,
    name: 'Watcher Cowork',
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: false,
    order: index[collectionKey].length,
    cowork: {
      createdAt: '2026-08-28T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(indexPath, index);

  const workspaceDir = path.join(workspacesRoot, COWORK_WORKSPACE_ID);
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-08-28T10:00:00.000Z',
      defaultModel: 'claude-sonnet-4-6',
      searchIndexingEnabled: false,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt: '2026-08-28T10:00:00.000Z' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${COWORK_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: COWORK_CHAT_ID,
    tabs: [
      {
        id: COWORK_CHAT_ID,
        title: 'Watcher destination',
        description: 'Receives the watched agent report',
        createdAt: '2026-08-28T10:00:00.000Z',
        kind: 'chat',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        // Pinned rather than inherited: these specs exercise watcher delivery,
        // not approval prompts, so tool calls must not stop for a decision.
        approvalMode: 'full-access',
        messages: [
          {
            id: 'cowork-seed-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Wait for the watched task.' }],
            timestamp: Date.parse('2026-08-28T10:01:00.000Z'),
          },
          {
            id: 'cowork-seed-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: tallReply('COWORK-PRIOR', 24) }],
            timestamp: Date.parse('2026-08-28T10:01:01.000Z'),
          },
          {
            id: 'cowork-seed-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: Date.parse('2026-08-28T10:01:00.000Z'),
                completedAt: Date.parse('2026-08-28T10:01:02.000Z'),
              },
            ],
            timestamp: Date.parse('2026-08-28T10:01:02.000Z'),
          },
        ],
      },
    ],
  });
}

test('independent Cowork ScheduleWakeup calls create distinct watchers', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-wakeup-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCoworkDestination(userDataDir);
  const marker = 'Canopy-CCOWORKWAKEUPREGISTRATION';
  const reply = 'Both wakeup registration requests completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__ScheduleWakeup',
              input: {
                delaySeconds: 60,
                followUpInstruction: 'Say hello.',
              },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              name: 'mcp__canopy__ScheduleWakeup',
              input: {
                delaySeconds: 60,
                followUpInstruction: 'Say hello.',
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: reply, stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COWORK_CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible();
    // Fail on the pinned mode itself, not on a missing reply, if the seeded
    // approvalMode ever stops surviving the chat-storage migration.
    await expect(panel.getByTestId('approval-mode-icon')).toHaveAttribute(
      'data-approval-mode',
      'full-access',
    );
    const composer = panel.getByRole('textbox').first();
    await composer.fill(`[${marker}] Wake up in one minute and say hello.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(reply, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    // A mock follow-up alone is not proof of success: require a real persisted
    // watcher belonging to this exact Cowork chat, then find and cancel it in UI.
    const readWakeups = () => {
      try {
        return JSON.parse(
          readFileSync(
            path.join(userDataDir, 'app-advisor-watchers.json'),
            'utf8',
          ),
        ).watchers.filter(
          (row) =>
            row.trigger === 'scheduled_wakeup' &&
            row.destination.chatId === COWORK_CHAT_ID,
        );
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    };
    await expect.poll(() => readWakeups().length).toBe(2);
    const wakeups = readWakeups();
    for (const watcher of wakeups) {
      expect(watcher.target.delaySeconds).toBe(60);
      expect(watcher.destination).toMatchObject({
        projectId: COWORK_WORKSPACE_ID,
        worktreeId: COWORK_ENTRY_ID,
      });
    }
    expect(new Set(wakeups.map((watcher) => watcher.id)).size).toBe(2);
    await app.openWatchersPage();
    for (const watcher of wakeups) {
      const row = app.workflowsWatcherRunRow(watcher.id);
      await expect(row).toBeVisible();
      await row.getByTestId('workflows-run-action-cancel').click();
      await expect(
        window.getByTestId('workflows-runs-cancel-watcher'),
      ).toBeVisible();
      await window.getByTestId('confirm-dialog-confirm').click();
      await expect(row).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a worktree chat watcher delivers finalMessage to a regular Cowork chat', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-watcher-final-message-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: WORKTREE_CHAT_ID, title: 'Watcher target' }],
  });
  seedCoworkDestination(userDataDir);
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'cowork-final-message-watcher',
        label: 'Worktree completion for Cowork',
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: WORKTREE_CHAT_ID,
        },
        destination: {
          projectId: COWORK_WORKSPACE_ID,
          worktreeId: COWORK_ENTRY_ID,
          chatId: COWORK_CHAT_ID,
        },
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, TARGET_MARKER, {
    llm: { steps: [{ text: TARGET_REPLY, stopReason: 'end_turn' }] },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, FINAL_MESSAGE_MARKER, {
    llm: { steps: [{ text: COWORK_REPLY, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const worktreePanel = window.getByTestId('panel-content-chat');
    const targetPrompt = `[${TARGET_MARKER}] Complete the watched task.`;
    const composer = window.getByRole('textbox').first();
    await composer.click();
    await composer.fill(targetPrompt);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(worktreePanel.getByText(TARGET_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });

    const coworkToggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
    );
    await expect(coworkToggle).toBeVisible();
    if ((await coworkToggle.getAttribute('aria-expanded')) !== 'true') {
      await coworkToggle.click();
    }
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();

    const coworkPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COWORK_CHAT_ID}"]`,
    );
    await expect(coworkPanel).toBeVisible({ timeout: 30_000 });
    await expect(coworkPanel.getByText('Canopy watcher fired.')).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      coworkPanel.getByText(`${COWORK_REPLY_MARKER} paragraph 16`, {
        exact: false,
      }),
    ).toBeVisible({ timeout: 90_000 });
    const watcherBubble = coworkPanel
      .locator('[data-role="user"]')
      .filter({ hasText: 'Worktree completion for Cowork' });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      'Chat completion watcher has fired',
    );
    await expect(
      watcherBubble.locator('[class~="bg-info-subtle"]'),
    ).toBeVisible();

    const scroller = coworkPanel.getByTestId('chat-message-list-scroll');
    const watcherReplyAnchor = coworkPanel.getByText(
      `${COWORK_REPLY_MARKER} paragraph 8`,
      { exact: false },
    );
    await expect(scroller).toBeVisible();
    await expect(watcherReplyAnchor).toBeVisible();
    await watcherReplyAnchor.scrollIntoViewIfNeeded();
    let settledGeometry = null;
    await expect
      .poll(async () => {
        const scrollerBox = await scroller.boundingBox();
        const anchorBox = await watcherReplyAnchor.boundingBox();
        settledGeometry =
          scrollerBox && anchorBox ? { scrollerBox, anchorBox } : null;
        return settledGeometry;
      })
      .not.toBeNull();
    const { scrollerBox, anchorBox } = settledGeometry;
    await scroller.evaluate(
      (element, delta) => {
        element.scrollTop += delta;
      },
      anchorBox.y - scrollerBox.y - 150,
    );
    await expect(
      coworkPanel.locator('[data-sticky-user-message-id="cowork-seed-user"]'),
    ).toHaveAttribute('data-stuck', 'true', { timeout: 15_000 });
    await expect(
      coworkPanel.locator('[data-sticky-user-message-id]').filter({
        hasText: 'Worktree completion for Cowork',
      }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
