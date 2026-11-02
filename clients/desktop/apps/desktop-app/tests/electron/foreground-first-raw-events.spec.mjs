/** Foreground-first raw delivery through a real Codex app-server and page. */
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
const marker = 'Canopy-CForegroundRaw';
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);

function notification(method, item, turn) {
  return {
    method,
    params: method === 'turn/completed' ? { turn } : { item },
  };
}

/** Real app-server command output: the client aggregates these deltas. */
function outputDelta(delta) {
  return {
    method: 'item/commandExecution/outputDelta',
    params: { itemId: 'foreground-command', delta },
  };
}

function release(gateDir, index) {
  writeFileSync(path.join(gateDir, `release-${index}`), '', 'utf8');
}

test('off-screen updates stay off IPC, the next focused update catches up, and completion alerts', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-foreground-raw-'),
  );
  const runtimeDir = path.join(userDataDir, 'codex-fixture');
  const gateDir = path.join(runtimeDir, 'gate');
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, 'mode'), 'manual');
  writeFileSync(
    path.join(runtimeDir, 'state.json'),
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
  );
  const item = (output, status = 'inProgress') => ({
    id: 'foreground-command',
    type: 'commandExecution',
    command: 'printf foreground-first',
    aggregatedOutput: output,
    status,
  });
  writeFileSync(
    path.join(runtimeDir, `${marker}.json`),
    JSON.stringify({
      gateDir,
      chunks: [
        { notifications: [notification('item/started', item(''))] },
        { notifications: [outputDelta('output one')] },
        { notifications: [outputDelta(' two')] },
        { notifications: [outputDelta(' three')] },
        {
          notifications: [
            notification(
              'item/completed',
              item('output one two three', 'completed'),
            ),
          ],
        },
        {
          notifications: [
            notification('turn/completed', null, {
              status: 'completed',
              items: [],
              error: null,
            }),
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
        // The retired opt-in: a stored opt-out no longer turns routing off.
        chatForegroundFirstDeliveryEnabled: false,
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
      window.__foregroundRawEvents = [];
      window.api.chat.onChatEvent((event) =>
        window.__foregroundRawEvents.push(event),
      );
    });
    // Start the background turn through chat IPC, as other surfaces do,
    // without selecting its tab.
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      projectId,
      worktreeId,
      chatId,
      userMessageId: 'foreground-raw-user-message',
      text: `Run the command [${marker}]`,
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full_access',
    });
    await expect
      .poll(() => existsSync(path.join(gateDir, 'started')))
      .toBe(true);
    release(gateDir, 0);
    await expect
      .poll(() => existsSync(path.join(gateDir, 'emitted-0')))
      .toBe(true);
    const countUpdates = () =>
      window.evaluate(
        (id) =>
          window.__foregroundRawEvents.filter(
            (entry) =>
              entry.chatId === id &&
              entry.data?.type === 'codex' &&
              entry.data.event?.type === 'item.updated',
          ).length,
        chatId,
      );
    const before = await countUpdates();
    release(gateDir, 1);
    release(gateDir, 2);
    await expect
      .poll(() => existsSync(path.join(gateDir, 'emitted-2')))
      .toBe(true);
    await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
    // Release the next update only once main has the chat as focused.
    await expect
      .poll(() =>
        electronApp.evaluate(
          (_electron, id) =>
            (globalThis.__CANOPY_E2E_CHAT_INTEREST__?.list() ?? []).some(
              (entry) =>
                entry.interest.focused.some((chat) => chat.chatId === id),
            ),
          chatId,
        ),
      )
      .toBe(true);
    // The Codex client emits command output at most every 100 ms (or per
    // 16 KiB), with no trailing update: space this small delta past that.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release(gateDir, 3);
    // Only the focused update reaches the page: the two off-screen updates
    // never arrived, not even late. It carries the whole output so far.
    await expect.poll(countUpdates).toBe(before + 1);
    // The transcript shows command output once the command completes, in
    // its collapsed card.
    const command = window
      .locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
      )
      .getByTestId('chat-tool-call')
      .first();
    await command.getByRole('button').first().click();
    release(gateDir, 4);
    await expect(command.getByText('output one two three')).toBeVisible({
      timeout: 30_000,
    });
    await window.getByTestId('panel-tab-panel-chat-foreground-chat').click();
    release(gateDir, 5);
    await expect.poll(() => existsSync(path.join(gateDir, 'done'))).toBe(true);
    await expect(
      window
        .getByTestId(`panel-tab-panel-chat-${chatId}`)
        .locator('[data-testid^="panel-tab-unread-dot-"]'),
    ).toBeVisible({ timeout: 30_000 });
    await app.openOverviewPage();
    await expect(window.getByTestId('overview-notification-card')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
