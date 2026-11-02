// Standard chat tab previews. Resting on a background chat tab opens the
// shared preview after the host tooltip delay, hung 8px under the
// tab with left edges lined up: the last prompt, the agent's reply and the
// status row. The active tab never gets one. A live turn shows "Working…"
// with its tool count while hovered. The card sizes to what exists: a
// stopped chat with only a prompt shows the prompt, then the status line,
// with no reserved reply space, no "0 tools" and no warning glyph; only a
// real error reads "Failed" with the circled X.
//
// Run after building the implementation:
//   pnpm run test:electron:built chat-tab-previews.spec.mjs --reporter=line
//
// Determinism: chats are seeded on disk; the live turn runs against the
// shared mock provider with a scripted, slow stream. No network.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ACTIVE = 'preview-active';
const FINISHED = 'preview-finished';
const QUESTION = 'preview-question';
const FAILED = 'preview-failed';
const STOPPED = 'preview-stopped';
const MARKER = 'Canopy-CTABPREVIEWLIVE';
const at = (minute) => Date.parse(`2026-10-21T12:${minute}:00.000Z`);
const panel = (chatId) => `panel-chat-${chatId}`;

function seed(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: ACTIVE,
    tabs: [
      { id: ACTIVE, title: 'Active chat' },
      {
        id: FINISHED,
        title: 'Show Activity only when there is activity',
        messages: [
          {
            id: 'finished-user-1',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Show the Activity button only when there is activity',
              },
            ],
            timestamp: at('01'),
          },
          {
            id: 'finished-assistant-1',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'I moved the check into the title bar.' },
              {
                type: 'tool_use',
                toolUseId: 'finished-tool-1',
                toolName: 'Read',
                input: JSON.stringify({ file_path: 'src/App.tsx' }),
              },
            ],
            timestamp: at('02'),
          },
          {
            id: 'finished-assistant-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'The button now hides when idle.' }],
            timestamp: at('03'),
          },
        ],
      },
      {
        id: QUESTION,
        title: 'Move to org when switching orgs',
        messages: [
          {
            id: 'question-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Close the dialog on org switch' }],
            timestamp: at('04'),
          },
          {
            id: 'question-assistant-1',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'question-tool-1',
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({
                  questions: [
                    { question: 'Close at once?', options: ['Yes', 'No'] },
                  ],
                }),
              },
            ],
            timestamp: at('05'),
          },
        ],
      },
      {
        id: STOPPED,
        title: 'General greeting',
        turnEnds: {
          'stopped-user-1': { outcome: 'cancelled', endedAt: at('09') },
        },
        messages: [
          {
            id: 'stopped-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hey' }],
            timestamp: at('08'),
          },
        ],
      },
      {
        id: FAILED,
        title: 'Audit sentence case in Settings',
        turnEnds: {
          'failed-user-1': { outcome: 'failed', endedAt: at('07') },
        },
        messages: [
          {
            id: 'failed-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Audit sentence case in Settings' }],
            timestamp: at('06'),
          },
          {
            id: 'failed-assistant-1',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Rate limit reached for the model.' },
            ],
            timestamp: at('07'),
          },
        ],
      },
    ],
    pendingQuestions: [
      {
        requestId: 'preview-question-request',
        chatId: QUESTION,
        toolUseId: 'question-tool-1',
        questions: [
          {
            id: 'close',
            question: 'Close at once?',
            options: ['Yes', 'No'],
            multiSelect: false,
          },
        ],
      },
    ],
  });
}

async function launch() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-tab-preview-'),
  );
  seed(userDataDir);
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId(`panel-tab-${panel(FINISHED)}`)).toBeVisible({
    timeout: 30_000,
  });
  // Entering the worktree lands on the chat with the waiting question
  // (CAN-4957). These cases preview background tabs from the seeded active
  // chat, so choose it explicitly.
  const activeTab = window.getByTestId(`panel-tab-${panel(ACTIVE)}`);
  await activeTab.click();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  return { electronApp, userDataDir, window };
}

const label = (window, chatId) =>
  window
    .getByTestId(`panel-tab-${panel(chatId)}`)
    .locator('.canopy-panel-tab-title');
const card = (window, chatId) =>
  window.getByTestId(`panel-tab-hover-card-${panel(chatId)}`);

async function rest(window, chatId) {
  // Park the pointer elsewhere first so each rest is a fresh hover.
  await window.mouse.move(5, 400);
  await label(window, chatId).hover();
}

test.describe('Chat tab previews', () => {
  test('previews background chat tabs without an opt-in', async () => {
    test.setTimeout(180_000);
    const { electronApp, userDataDir, window } = await launch();
    try {
      await expect(label(window, FINISHED)).not.toHaveAttribute('title');
      // The active tab keeps its title and never gets a card.
      await expect(label(window, ACTIVE)).toHaveAttribute(
        'title',
        'Active chat',
      );

      await rest(window, FINISHED);
      await window.waitForTimeout(250);
      await expect(card(window, FINISHED)).toHaveCount(0);
      const finished = card(window, FINISHED);
      await expect(finished).toBeVisible({ timeout: 5_000 });
      await expect(finished.getByTestId('chat-tab-preview-prompt')).toHaveText(
        'Show the Activity button only when there is activity',
      );
      await expect(
        finished.getByTestId('chat-tab-preview-reply'),
      ).toContainText('The button now hides when idle.');
      await expect(finished.getByTestId('chat-tab-preview-status')).toHaveText(
        /^Finished .*1 tool$/,
      );

      // Hung 8px under the whole tab, left edges lined up.
      const tabBox = await window
        .getByTestId(`panel-tab-${panel(FINISHED)}`)
        .boundingBox();
      const cardBox = await finished.boundingBox();
      expect(tabBox).not.toBeNull();
      expect(cardBox).not.toBeNull();
      expect(Math.abs(cardBox.y - (tabBox.y + tabBox.height + 8))).toBeLessThan(
        1.5,
      );
      expect(Math.abs(cardBox.x - tabBox.x)).toBeLessThan(1.5);
      expect(Math.round(cardBox.width)).toBe(280);

      // The close button belongs to this tab's preview hover region too.
      await window.getByTestId(`panel-tab-close-${panel(FINISHED)}`).hover();
      await window.waitForTimeout(1_000);
      await expect(finished).toBeVisible();

      await rest(window, QUESTION);
      await expect(
        card(window, QUESTION).getByTestId('chat-tab-preview-status'),
      ).toHaveText(/^Question waiting/, { timeout: 5_000 });

      // A real error: "Failed" with the circled X in the shared 16×18 slot.
      await rest(window, FAILED);
      const failedStatus = card(window, FAILED).getByTestId(
        'chat-tab-preview-status',
      );
      await expect(failedStatus).toHaveText(/^Failed /, { timeout: 5_000 });
      const failedSlot = failedStatus.locator(':scope > :first-child');
      await expect(failedSlot.locator('svg circle')).toHaveCount(1);
      const slotBox = await failedSlot.boundingBox();
      expect(slotBox).not.toBeNull();
      expect(Math.round(slotBox.width)).toBe(16);
      expect(Math.round(slotBox.height)).toBe(18);

      // Stopped with only a prompt: the status line follows the prompt
      // directly, as plain text with no glyph and no zero count.
      await rest(window, STOPPED);
      const stopped = card(window, STOPPED);
      const stoppedStatus = stopped.getByTestId('chat-tab-preview-status');
      await expect(stoppedStatus).toHaveText(/^Stopped \S+ ago$/, {
        timeout: 5_000,
      });
      await expect(stoppedStatus.locator('svg')).toHaveCount(0);
      await expect(stopped.getByTestId('chat-tab-preview-reply')).toHaveCount(
        0,
      );
      const promptBox = await stopped
        .getByTestId('chat-tab-preview-prompt')
        .boundingBox();
      const statusBox = await stoppedStatus.boundingBox();
      expect(promptBox).not.toBeNull();
      expect(statusBox).not.toBeNull();
      // The card's 10px gap, nothing reserved for a reply.
      expect(
        Math.abs(statusBox.y - (promptBox.y + promptBox.height) - 10),
      ).toBeLessThan(1.5);

      await rest(window, ACTIVE);
      await window.waitForTimeout(900);
      await expect(card(window, ACTIVE)).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a working background chat updates its card live', async () => {
    test.setTimeout(180_000);
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        // Each step's words reach the chat when the step completes; a slow
        // tool spaces the steps out. (The mock holds a step that paces text
        // and also calls a tool, so only the last step is paced.)
        steps: [
          {
            text: "I'll add the new robot as a custom glyph first.",
            toolCalls: [
              { name: 'Bash', input: { command: 'sleep 2' }, id: 'live-1' },
            ],
            stopReason: 'tool_use',
          },
          {
            text: "Then I'll check the manifest rules so the icon check stays green.",
            toolCalls: [
              { name: 'Bash', input: { command: 'sleep 2' }, id: 'live-2' },
            ],
            stopReason: 'tool_use',
          },
          {
            text: 'Done. The robot glyph is in, and the icon check passes.',
            streamMs: 3_000,
            stopReason: 'end_turn',
          },
        ],
      },
    });
    const { electronApp, userDataDir, window } = await launch();
    try {
      const composer = window.getByRole('textbox').last();
      await composer.fill(`[${MARKER}] Add the robot glyph`);
      await composer.press('Enter');
      await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
        timeout: 30_000,
      });
      // Move to another chat: the working one is now a background tab.
      await window.getByTestId(`panel-tab-${panel(FINISHED)}`).click();

      await rest(window, ACTIVE);
      const live = card(window, ACTIVE);
      await expect(live).toBeVisible({ timeout: 5_000 });
      await expect(live.getByTestId('chat-tab-preview-prompt')).toHaveText(
        `[${MARKER}] Add the robot glyph`,
      );
      await expect(live.getByTestId('chat-tab-preview-spinner')).toBeVisible();
      const status = live.getByTestId('chat-tab-preview-status');
      await expect(status).toHaveText(/^Working… \d+:\d\d/);
      // The timer ticks and the second step's words arrive while hovered.
      const first = await status.textContent();
      await expect.poll(() => status.textContent()).not.toBe(first);
      await expect(live.getByTestId('chat-tab-preview-reply')).toContainText(
        "Then I'll check the manifest rules",
        { timeout: 30_000 },
      );
      await expect(live.getByTestId('chat-tab-preview-reply')).toContainText(
        'Done.',
        { timeout: 30_000 },
      );
      await expect(status).toHaveText(/^Finished /, { timeout: 30_000 });
      await expect(status).toHaveText(/2 tools$/);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
