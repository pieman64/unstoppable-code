// App Advisor watcher-fired transcript UX regression.
//
// A real `send_watcher_message` command is delivered to the App Advisor
// renderer, which dispatches and persists the follow-up through the normal
// App Advisor chat service. The popout is then reloaded so the assertions read
// the durable transcript rather than the renderer-local optimistic message.
// This catches metadata loss that is invisible until App Advisor rehydrates.

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
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TARGET_CHAT_ID = 'watcher-advisor-target';
const ENTRY_ID = 'watcher-advisor-entry';
const CHAT_ID = 'watcher-advisor-chat';
const WATCHER_MARKER = 'App Advisor watcher display parity';
const TARGET_MARKER = 'Canopy-CAPPADVISORWATCHERTARGET';
const FINAL_MESSAGE_MARKER = 'Canopy-CAPPADVISORWATCHERFINAL';
const TARGET_REPLY = `[${FINAL_MESSAGE_MARKER}] target work finished.`;
const BASE = Date.parse('2026-09-01T12:00:00.000Z');

function tallReply(marker, paragraphs) {
  return Array.from(
    { length: paragraphs },
    (_, index) => `${marker} paragraph ${index + 1} of the response.`,
  ).join('\n\n');
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

function seedAppAdvisorChat(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: ENTRY_ID,
        createdAt: '2026-09-01T12:00:00.000Z',
        title: 'Watcher display parity',
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Watcher display parity',
        createdAt: '2026-09-01T12:00:00.000Z',
        providerType: 'claude',
        model: 'sonnet',
        messages: [
          {
            id: 'advisor-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Prepare the deployment report.' }],
            timestamp: BASE,
          },
          {
            id: 'advisor-reply-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: tallReply('ADVISOR-PRIOR', 24) }],
            timestamp: BASE + 1_000,
          },
          {
            id: 'advisor-timer-1',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: BASE,
                completedAt: BASE + 2_000,
              },
            ],
            timestamp: BASE + 2_000,
          },
        ],
      },
    ],
  });
}

async function scrollAnchorToTop(page, scroller, anchor, offset) {
  await anchor.scrollIntoViewIfNeeded();
  const scrollerBox = await scroller.boundingBox();
  const anchorBox = await anchor.boundingBox();
  if (!scrollerBox || !anchorBox) throw new Error('Missing scroll geometry');
  await scroller.evaluate(
    (element, delta) => {
      element.scrollTop += delta;
    },
    anchorBox.y - scrollerBox.y - offset,
  );
  await page.waitForTimeout(100);
}

test('rehydrated watcher message keeps the info bubble and never becomes the sticky user header', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-app-advisor-watcher-ux-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TARGET_CHAT_ID,
    tabs: [{ id: TARGET_CHAT_ID, title: 'Watcher target' }],
  });
  seedAppAdvisorChat(userDataDir);
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'watcher-display-parity',
        label: WATCHER_MARKER,
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: TARGET_CHAT_ID,
        },
        destination: {
          projectId: 'app-advisor',
          worktreeId: ENTRY_ID,
          chatId: CHAT_ID,
        },
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, TARGET_MARKER, {
    llm: { steps: [{ text: TARGET_REPLY, stopReason: 'end_turn' }] },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, FINAL_MESSAGE_MARKER, {
    llm: {
      steps: [
        {
          text: tallReply('ADVISOR-WATCHER-REPLY', 16),
          stopReason: 'end_turn',
        },
      ],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const mainWindow = await electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const advisor = await app.openAppAdvisorWindow(electronApp);

    const worktreePanel = mainWindow.getByTestId('panel-content-chat');
    const composer = worktreePanel.getByRole('textbox').first();
    await composer.fill(`[${TARGET_MARKER}] Complete the watched task.`);
    await worktreePanel.getByRole('button', { name: 'Send message' }).click();
    await expect(worktreePanel.getByText(TARGET_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });

    await expect(
      advisor.getByText('ADVISOR-WATCHER-REPLY paragraph 16', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 90_000 });

    await advisor.reload();
    await expect(
      advisor.getByTestId('app-advisor-workspace-surface'),
    ).toBeVisible({ timeout: 30_000 });
    const chatPanel = advisor.getByTestId('panel-content-chat');
    await expect(chatPanel).toBeVisible();
    const watcherBubble = chatPanel
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_MARKER });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      /Chat completion.*watcher has fired/,
    );
    await expect(
      watcherBubble.locator('[class~="bg-info-subtle"]'),
    ).toBeVisible();

    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await scrollAnchorToTop(
      advisor,
      scroller,
      advisor.getByText('ADVISOR-WATCHER-REPLY paragraph 8', { exact: false }),
      150,
    );
    await expect(
      chatPanel.locator('[data-sticky-user-message-id="advisor-user-1"]'),
    ).toHaveAttribute('data-stuck', 'true');
    await expect(
      chatPanel.locator('[data-sticky-user-message-id]').filter({
        hasText: WATCHER_MARKER,
      }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
