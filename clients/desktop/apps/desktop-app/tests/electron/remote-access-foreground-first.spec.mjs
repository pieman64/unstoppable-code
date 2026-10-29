/** Each remote controller routes the host's raw chat output by its own interest. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const projectId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const y = 'remote-background-y';
const z = 'remote-background-z';
const marker = 'Canopy-CRemoteForeground';
const zMarker = 'Canopy-CRemoteForegroundBodies';
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);

test('controller misses off-screen Y updates, catches up on focus, and keeps completion attention', async () => {
  test.setTimeout(300_000);
  const relay = await startDeviceRelay();
  const apiKey = `csk_remote_foreground_${randomUUID()}`;
  await registerScenario(undefined, apiKey, {
    cloud: {
      deviceRelay: {
        url: relay.url,
        secret: relay.secret,
        userId: 'remote-foreground-user',
      },
    },
  });
  const desktops = [];
  try {
    const hostEnv = {
      CODEX_EXECUTABLE: fixture,
      CANOPY_E2E_CODEX_MODE: 'perf-script',
    };
    const host = await launchDesktop({
      label: 'foreground-host',
      demoApp: 'ts-pnpm-vite',
      apiKey,
      seed: (userDataDir) => {
        const runtime = path.join(userDataDir, 'codex-fixture');
        const gateDir = path.join(runtime, 'gate');
        mkdirSync(gateDir, { recursive: true });
        writeFileSync(path.join(gateDir, 'mode'), 'manual');
        writeFileSync(
          path.join(runtime, 'state.json'),
          JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
        );
        const item = (aggregatedOutput, status = 'inProgress') => ({
          id: 'remote-command',
          type: 'commandExecution',
          command: 'printf remote',
          aggregatedOutput,
          status,
        });
        const notify = (method, itemValue) => ({
          method,
          params: { item: itemValue },
        });
        // Real app-server command output: the client aggregates the deltas.
        const outputDelta = (delta) => ({
          method: 'item/commandExecution/outputDelta',
          params: { itemId: 'remote-command', delta },
        });
        writeFileSync(
          path.join(runtime, `${marker}.json`),
          JSON.stringify({
            gateDir,
            chunks: [
              { notifications: [notify('item/started', item(''))] },
              { notifications: [outputDelta('remote one')] },
              { notifications: [outputDelta(' two')] },
              { notifications: [outputDelta(' three')] },
              {
                notifications: [
                  notify(
                    'item/completed',
                    item('remote one two three', 'completed'),
                  ),
                ],
              },
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
        // Z answers on its own while the controller never shows it.
        const zGate = path.join(runtime, 'gate-z');
        mkdirSync(zGate, { recursive: true });
        writeFileSync(path.join(zGate, 'mode'), 'auto');
        const agentMessage = (id, text, phase = 'commentary') => ({
          delayMs: 200,
          notifications: [
            notify('item/started', {
              type: 'agentMessage',
              id,
              text: '',
              phase,
            }),
            notify('item/completed', { type: 'agentMessage', id, text, phase }),
          ],
        });
        writeFileSync(
          path.join(runtime, `${zMarker}.json`),
          JSON.stringify({
            gateDir: zGate,
            chunks: [
              agentMessage('remote-z-step', 'Remote Z step'),
              agentMessage(
                'remote-z-final',
                'Remote Z final answer',
                'final_answer',
              ),
              {
                delayMs: 200,
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
        seedWorktreeChat({
          userDataDir,
          workspaceId: projectId,
          worktreeId,
          providerType: 'codex',
          // The controller never shows Y before its turn streams, so Y is
          // neither focused nor warm in the controller's window.
          activeTabId: 'remote-foreground-x',
          tabs: [
            {
              id: 'remote-foreground-x',
              title: 'Remote X',
              providerType: 'codex',
              model: 'gpt-6-sol',
            },
            {
              id: y,
              title: 'Remote Y',
              providerType: 'codex',
              model: 'gpt-6-sol',
            },
            {
              id: z,
              title: 'Remote Z',
              providerType: 'codex',
              model: 'gpt-6-sol',
            },
          ],
        });
        const preferencesPath = path.join(userDataDir, 'preferences.json');
        const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
        preferences.preferences.defaultChatProvider = 'codex';
        writeFileSync(preferencesPath, JSON.stringify(preferences));
        hostEnv.CANOPY_E2E_CODEX_STATE_PATH = path.join(runtime, 'state.json');
        hostEnv.CANOPY_E2E_CODEX_CANONICAL_HOME = runtime;
        hostEnv.CANOPY_E2E_CODEX_PERF_SCRIPT_DIR = runtime;
      },
      env: hostEnv,
    });
    desktops.push(host);
    const controller = await launchDesktop({
      label: 'foreground-controller',
      apiKey,
    });
    desktops.push(controller);
    await pairDevices(controller, host);
    const remote = await openRemoteWindow(controller, host);
    const remoteApp = new CanopyAppDriver(remote.window);
    await remoteApp.openMainPage();
    await remoteApp.selectWorktree(worktreeId);
    await remote.window
      .getByTestId('panel-tab-panel-chat-remote-foreground-x')
      .click();
    await remote.window.evaluate(() => {
      window.__remoteRawEvents = [];
      window.api.chat.onChatEvent((event) =>
        window.__remoteRawEvents.push(event),
      );
    });
    // Start Y's turn on the host through chat IPC, without selecting it.
    await host.window.evaluate(
      (request) => window.api.chat.sendMessage(request),
      {
        projectId,
        worktreeId,
        chatId: y,
        userMessageId: 'remote-foreground-y-user-message',
        text: `Run command [${marker}]`,
        providerType: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full_access',
      },
    );
    const gateDir = path.join(host.userDataDir, 'codex-fixture', 'gate');
    await expect
      .poll(() => existsSync(path.join(gateDir, 'started')))
      .toBe(true);
    const release = (index) =>
      writeFileSync(path.join(gateDir, `release-${index}`), '');
    release(0);
    await expect
      .poll(() => existsSync(path.join(gateDir, 'emitted-0')))
      .toBe(true);
    release(1);
    release(2);
    await expect
      .poll(() => existsSync(path.join(gateDir, 'emitted-2')))
      .toBe(true);
    const updates = () =>
      remote.window.evaluate(
        (id) =>
          window.__remoteRawEvents.filter(
            (entry) =>
              entry.chatId === id &&
              entry.data?.type === 'codex' &&
              entry.data.event?.type === 'item.updated',
          ).length,
        y,
      );
    await remote.window.getByTestId(`panel-tab-panel-chat-${y}`).click();
    // Release the next update only once the host records Y as focused for
    // the controller's bridge.
    await expect
      .poll(() =>
        host.electronApp.evaluate(
          (_electron, id) =>
            (globalThis.__CANOPY_E2E_CHAT_INTEREST__?.list() ?? []).some(
              (entry) =>
                entry.interest.focused.some((chat) => chat.chatId === id),
            ),
          y,
        ),
      )
      .toBe(true);
    // The Codex client emits command output at most every 100 ms (or per
    // 16 KiB), with no trailing update: space this small delta past that.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release(3);
    // Only the focused update reaches the controller: the two off-screen
    // updates never arrived, not even late.
    await expect.poll(updates).toBe(1);
    // The transcript shows command output once the command completes, in
    // its collapsed card.
    const command = remote.window
      .locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${y}"]`,
      )
      .getByTestId('chat-tool-call')
      .first();
    await command.getByRole('button').first().click();
    release(4);
    await expect(command.getByText('remote one two three')).toBeVisible({
      timeout: 30_000,
    });
    await remote.window
      .getByTestId('panel-tab-panel-chat-remote-foreground-x')
      .click();
    release(5);
    await expect.poll(() => existsSync(path.join(gateDir, 'done'))).toBe(true);
    await expect(
      remote.window
        .getByTestId(`panel-tab-panel-chat-${y}`)
        .locator('[data-unread]'),
    ).toBeVisible({ timeout: 30_000 });

    // Bodies: Z's committed rows never reach the controller while it shows X,
    // its notification still carries the new answer, and showing Z catches up
    // through the tunnel.
    await remote.window.evaluate(() => {
      window.__remoteStateEvents = [];
      window.api.chat.onStateChanged((event) =>
        window.__remoteStateEvents.push(event),
      );
    });
    await host.window.evaluate(
      (request) => window.api.chat.sendMessage(request),
      {
        projectId,
        worktreeId,
        chatId: z,
        userMessageId: 'remote-foreground-z-user-message',
        text: `Answer in the background [${zMarker}]`,
        providerType: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full_access',
      },
    );
    const zGate = path.join(host.userDataDir, 'codex-fixture', 'gate-z');
    await expect
      .poll(() => existsSync(path.join(zGate, 'done')), { timeout: 60_000 })
      .toBe(true);
    const zDelivered = () =>
      remote.window.evaluate((id) => {
        const changes = window.__remoteStateEvents.flatMap((event) =>
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
      }, z);
    await expect
      .poll(async () => (await zDelivered()).omitted)
      .toBeGreaterThan(0);
    expect((await zDelivered()).bodies).toBe(0);
    await expect(
      remote.window
        .getByTestId(`panel-tab-panel-chat-${z}`)
        .locator('[data-unread]'),
    ).toBeVisible({ timeout: 30_000 });
    await remoteApp.openOverviewPage();
    await expect(
      remote.window
        .getByTestId('overview-notification-card')
        .filter({ hasText: 'Remote Z final answer' }),
    ).toBeVisible({ timeout: 30_000 });
    await remoteApp.openMainPage();
    await remoteApp.selectWorktree(worktreeId);
    await remote.window.getByTestId(`panel-tab-panel-chat-${z}`).click();
    await expect(
      remote.window
        .locator(
          `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${z}"]`,
        )
        .getByText('Remote Z final answer'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    for (const desktop of desktops.reverse())
      await closeCanopy(desktop.electronApp, desktop.userDataDir);
    await relay.stop();
  }
});
