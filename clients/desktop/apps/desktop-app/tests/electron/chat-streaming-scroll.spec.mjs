import { mkdtempSync } from 'node:fs';
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

// Desktop supplies ChatContent through SharedChatPanel.renderTranscript;
// exercise that real renderer here. The shared default ChatTranscript's
// >50-turn window and stable row hooks have separate Jest coverage.
// The desktop Claude session surfaces assistant text when a message completes,
// so pinning is asserted on completed replies rather than partial deltas.
const CHAT_ID = 'streaming-scroll';
const MARKER = 'Canopy-CSCROLL';
const TURN_COUNT = 160;
const STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');

function history() {
  return Array.from({ length: TURN_COUNT }, (_, index) => {
    const timestamp = STARTED_AT + index * 60_000;
    return [
      {
        id: `scroll-user-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `Historical request ${index}` }],
        timestamp,
      },
      {
        id: `scroll-assistant-${index}`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `Historical response ${index}` }],
        timestamp: timestamp + 1000,
      },
      {
        id: `scroll-timer-${index}`,
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: timestamp,
            completedAt: timestamp + 2000,
          },
        ],
        timestamp: timestamp + 2000,
      },
    ];
  }).flat();
}

async function scrollState(viewport) {
  return viewport.evaluate((element) => ({
    top: element.scrollTop,
    bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
}

function reply(label) {
  return Array.from(
    { length: 40 },
    (_, index) => `${label} line ${index}: the response keeps growing.\n\n`,
  ).join('');
}

test('a large chat stays pinned on new replies and respects scrolling upward', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-streaming-scroll-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Streaming scroll', messages: history() }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        { text: reply('First reply'), stopReason: 'end_turn', streamMs: 1_500 },
        // Long enough to scroll up while it is still streaming.
        {
          text: reply('Second reply'),
          stopReason: 'end_turn',
          streamMs: 8_000,
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const viewport = panel.getByTestId('chat-message-list-scroll');
    await expect(
      panel.getByTestId('chat-transcript-virtual-window'),
    ).toBeVisible();
    await expect
      .poll(async () => (await scrollState(viewport)).bottomGap)
      .toBeLessThan(64);

    const composer = window.getByRole('textbox').last();
    const stop = window.getByTestId('chat-stop-generation');
    await composer.fill(`[${MARKER}] Send the first long reply`);
    await composer.press('Enter');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await expect(
      panel.getByText('First reply line 39:', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    // Per-frame rendering of streamed state (phase 12) must not drop,
    // duplicate or reorder content: every line of the reply renders exactly
    // once, in order, inside its turn.
    const replyTurn = panel
      .locator('[data-chat-turn-group]')
      .filter({ hasText: 'First reply line 0:' });
    await expect(replyTurn).toHaveCount(1);
    const replyText = await replyTurn.innerText();
    const linePositions = Array.from({ length: 40 }, (_, index) => {
      const line = `First reply line ${index}:`;
      expect(replyText.split(line).length - 1, line).toBe(1);
      return replyText.indexOf(line);
    });
    expect(linePositions).toEqual([...linePositions].sort((a, b) => a - b));
    // A pinned reader follows the newly appended reply to the bottom.
    await expect
      .poll(async () => (await scrollState(viewport)).bottomGap)
      .toBeLessThan(64);

    await viewport.hover();
    await window.mouse.wheel(0, -1000);
    await expect
      .poll(async () => (await scrollState(viewport)).bottomGap)
      .toBeGreaterThan(400);

    // Sending from above brings the reader to the new prompt at the tail.
    await composer.fill(`[${MARKER}] Send the second long reply`);
    await composer.press('Enter');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByText(`[${MARKER}] Send the second long reply`, {
        exact: false,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => (await scrollState(viewport)).bottomGap)
      .toBeLessThan(64);

    // Scrolling up again while the reply streams stops following it.
    await viewport.hover();
    await window.mouse.wheel(0, -1000);
    await expect
      .poll(async () => (await scrollState(viewport)).bottomGap)
      .toBeGreaterThan(400);
    await window.waitForTimeout(300);
    const readerTop = (await scrollState(viewport)).top;
    await window.waitForTimeout(1_000);
    await expect(stop).toBeVisible();
    expect(
      Math.abs((await scrollState(viewport)).top - readerTop),
    ).toBeLessThan(32);
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await window.waitForTimeout(500);
    const state = await scrollState(viewport);
    expect(state.bottomGap).toBeGreaterThan(400);
    expect(Math.abs(state.top - readerTop)).toBeLessThan(32);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
