/** Foreground-first body filtering: off-screen bodies stay off IPC, and a switch catches up. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const projectId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const chatId = 'background-codex';
const marker = 'Canopy-CForegroundCatchUp';
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);

/** One complete agent message, as the app-server reports it. */
function agentMessage(id, text, phase = 'commentary') {
  const item = { type: 'agentMessage', id, text, phase };
  return {
    notifications: [
      { method: 'item/started', params: { item: { ...item, text: '' } } },
      { method: 'item/completed', params: { item } },
    ],
  };
}

function release(gateDir, index) {
  writeFileSync(path.join(gateDir, `release-${index}`), '', 'utf8');
}

test('off-screen bodies stay off IPC, the switch shows the latest rows, and completion alerts', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-foreground-catch-up-'),
  );
  const runtimeDir = path.join(userDataDir, 'codex-fixture');
  const gateDir = path.join(runtimeDir, 'gate');
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, 'mode'), 'manual');
  writeFileSync(
    path.join(runtimeDir, 'state.json'),
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
  );
  writeFileSync(
    path.join(runtimeDir, `${marker}.json`),
    JSON.stringify({
      gateDir,
      chunks: [
        agentMessage('background-step-1', 'Background step one'),
        agentMessage('background-step-2', 'Background step two'),
        agentMessage(
          'background-final',
          'Background final answer',
          'final_answer',
        ),
        {
          notifications: [
            {
              method: 'turn/completed',
              params: {
                turn: { status: 'completed', items: [], error: null },
              },
            },
          ],
        },
      ],
    }),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    // The background chat is never shown before its turn streams, so it is
    // neither focused nor warm.
    activeTabId: 'foreground-chat',
    tabs: [
      {
        id: chatId,
        title: 'Background Codex',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'foreground-chat',
        title: 'Foreground chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultChatProvider: 'codex',
      },
    }),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CODEX_EXECUTABLE: fixture,
      CANOPY_E2E_CODEX_STATE_PATH: path.join(runtimeDir, 'state.json'),
      CANOPY_E2E_CODEX_CANONICAL_HOME: runtimeDir,
      CANOPY_E2E_CODEX_MODE: 'perf-script',
      CANOPY_E2E_CODEX_PERF_SCRIPT_DIR: runtimeDir,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    await window.evaluate(() => {
      window.__foregroundStateEvents = [];
      window.api.chat.onStateChanged((event) =>
        window.__foregroundStateEvents.push(event),
      );
    });
    // Start the background turn through chat IPC without selecting its tab.
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      projectId,
      worktreeId,
      chatId,
      userMessageId: 'foreground-catch-up-user-message',
      text: `Run the background turn [${marker}]`,
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full_access',
    });
    await expect
      .poll(() => existsSync(path.join(gateDir, 'started')))
      .toBe(true);
    release(gateDir, 0);
    release(gateDir, 1);
    await expect
      .poll(() => existsSync(path.join(gateDir, 'emitted-1')))
      .toBe(true);
    const delivered = () =>
      window.evaluate((id) => {
        const changes = window.__foregroundStateEvents.flatMap((event) =>
          event.changes.filter((change) => change.chatId === id),
        );
        return {
          omitted: changes.filter(
            (change) => change.type === 'messages.omitted',
          ).length,
          bodies: changes.filter(
            (change) =>
              (change.type === 'message.upserted' &&
                change.message.role !== 'user') ||
              change.type === 'messages.replaced',
          ).length,
        };
      }, chatId);
    // Both background steps commit, and the window gets markers, not bodies.
    await expect
      .poll(async () => (await delivered()).omitted)
      .toBeGreaterThan(0);
    expect((await delivered()).bodies).toBe(0);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
    // The switch reads the newest page: both off-screen steps appear.
    await expect(panel.getByText('Background step two')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText('Background step one')).toBeVisible();
    // Focused now: the next body arrives with the push itself.
    release(gateDir, 2);
    await expect(panel.getByText('Background final answer')).toBeVisible({
      timeout: 30_000,
    });
    expect((await delivered()).bodies).toBeGreaterThan(0);

    await window.getByTestId('panel-tab-panel-chat-foreground-chat').click();
    release(gateDir, 3);
    await expect.poll(() => existsSync(path.join(gateDir, 'done'))).toBe(true);
    await expect(
      window
        .getByTestId(`panel-tab-panel-chat-${chatId}`)
        .locator('[data-unread]'),
    ).toBeVisible({ timeout: 30_000 });
    await app.openOverviewPage();
    await expect(window.getByTestId('overview-notification-card')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
