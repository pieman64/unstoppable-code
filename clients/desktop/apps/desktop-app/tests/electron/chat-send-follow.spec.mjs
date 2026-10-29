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
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

// Sending a prompt is a request to be at the tail: a reader who scrolled up is
// brought to the bottom and follows the reply, with early access on or off.
// Early access only changes which prompts stay pinned.
const CHAT_ID = 'send-follow-scroll';
const TURN_COUNT = 120;
const STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');

function history() {
  return Array.from({ length: TURN_COUNT }, (_, index) => {
    const timestamp = STARTED_AT + index * 60_000;
    return [
      {
        id: `send-follow-user-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `Historical request ${index}` }],
        timestamp,
      },
      {
        id: `send-follow-assistant-${index}`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `Historical response ${index}` }],
        timestamp: timestamp + 1000,
      },
      {
        id: `send-follow-timer-${index}`,
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
    { length: 30 },
    (_, index) => `${label} line ${index}: the response keeps growing.\n\n`,
  ).join('');
}

for (const earlyAccess of [true, false]) {
  test(`sending a prompt while scrolled up follows the reply with early access ${
    earlyAccess ? 'on' : 'off'
  }`, async () => {
    test.setTimeout(120_000);
    const marker = `Canopy-CSENDFOLLOW-${earlyAccess ? 'ON' : 'OFF'}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-send-follow-scroll-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      activeTabId: CHAT_ID,
      tabs: [{ id: CHAT_ID, title: 'Send follow', messages: history() }],
    });
    if (earlyAccess) seedEarlyAccess({ userDataDir });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: reply('Sent reply'),
            stopReason: 'end_turn',
            streamMs: 30_000,
          },
          { text: 'Queued reply complete.', stopReason: 'end_turn' },
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
      await expect(viewport).toBeVisible();
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeLessThan(64);

      await viewport.hover();
      await window.mouse.wheel(0, -1000);
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeGreaterThan(400);

      const composer = window.getByRole('textbox').last();
      const stop = window.getByTestId('chat-stop-generation');
      await composer.fill(`[${marker}] Send a long reply`);
      await composer.press('Enter');
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await expect(
        panel.getByText(`[${marker}] Send a long reply`, { exact: false }),
      ).toBeInViewport();
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeLessThan(64);
      await viewport.hover();
      await window.mouse.wheel(0, -1000);
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeGreaterThan(400);
      await composer.fill(`[${marker}] Queued follow-up`);
      await composer.press('Enter');
      await expect(panel.getByTestId('queued-message-bubble')).toContainText(
        'Queued follow-up',
      );
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeLessThan(64);
      await expect(panel.getByTestId('queued-message-bubble')).toBeInViewport();
      // Replay the host snapshots produced by a pre-provider refusal: removal
      // followed by restoration of the same durable queue row. No new send.
      const queuedSnapshot = await window.evaluate(async (chatId) => {
        const snapshots = await window.api.chat.getChatQueueSnapshot({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        });
        return snapshots.find((snapshot) => snapshot.chatId === chatId);
      }, CHAT_ID);
      expect(queuedSnapshot?.queue).toHaveLength(1);
      await expect(stop).toHaveCount(0, { timeout: 90_000 });
      await expect(
        panel.getByText('Queued reply complete.', { exact: false }),
      ).toBeVisible({ timeout: 30_000 });
      // The reader is at the tail and follows the reply as it lands.
      await expect(
        panel.getByText('Sent reply line 29:', { exact: false }),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeLessThan(64);
      // Once live commits settle, isolate recovery snapshots from provider
      // updates. The host mirror now has no canonical queued IDs to retain.
      const publishQueue = (snapshot) =>
        electronApp.evaluate(({ BrowserWindow }, event) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            'chat:queue-updated',
            event,
          );
        }, snapshot);
      await publishQueue(queuedSnapshot);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(1);
      await viewport.hover();
      await window.mouse.wheel(0, -1000);
      await expect
        .poll(async () => (await scrollState(viewport)).bottomGap)
        .toBeGreaterThan(400);
      const readerTop = (await scrollState(viewport)).top;
      await publishQueue({ ...queuedSnapshot, queue: [] });
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      await publishQueue(queuedSnapshot);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(1);
      expect(
        Math.abs((await scrollState(viewport)).top - readerTop),
      ).toBeLessThan(32);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
