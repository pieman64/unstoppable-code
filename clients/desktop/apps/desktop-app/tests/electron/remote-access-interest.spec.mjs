/**
 * Chat interest through remote access (foreground-first streaming, phase
 * 02). A window that shows another computer runs the same renderer code, so
 * it declares the host chats it shows. Its `chat:set-interest` call tunnels
 * to the host, where the controller's hidden bridge window replays it: the
 * host records the interest for the bridge, not for its own app window.
 *
 * Two real desktops sign in to one mock account and connect through the real
 * `apps/device-relay`. The controller's remote window shows one of the host's
 * chats, then another; the host's E2E hook
 * (`globalThis.__CANOPY_E2E_CHAT_INTEREST__.list()`) must follow, and drop the
 * record once the session ends.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const HOST_PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const FIRST_CHAT = 'remote-chat-one';
const SECOND_CHAT = 'remote-chat-two';

/** The webContents id of the host's own app window. */
async function webContentsIdOf(electronApp, page) {
  const browserWindow = await electronApp.browserWindow(page);
  return browserWindow.evaluate((win) => win.webContents.id);
}

/**
 * Interests the host records for its hidden bridge windows (`data:` pages),
 * as `{ webContentsId, focused, warm }` with chat ids.
 */
async function bridgeInterests(host) {
  return host.electronApp.evaluate(({ webContents }) => {
    const hook = globalThis.__CANOPY_E2E_CHAT_INTEREST__;
    if (!hook) throw new Error('__CANOPY_E2E_CHAT_INTEREST__ is not installed');
    const bridgeIds = new Set(
      webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL().startsWith('data:'))
        .map((contents) => contents.id),
    );
    return hook
      .list()
      .filter((entry) => bridgeIds.has(entry.webContentsId))
      .map((entry) => ({
        webContentsId: entry.webContentsId,
        focused: entry.interest.focused.map((ref) => ref.chatId),
        warm: entry.interest.warm.map((ref) => ref.chatId),
      }));
  });
}

/** The webContents ids whose recorded interest names `chatId` as focused. */
async function recordsFocusing(host, chatId) {
  return host.electronApp.evaluate((_electron, id) => {
    const hook = globalThis.__CANOPY_E2E_CHAT_INTEREST__;
    if (!hook) throw new Error('__CANOPY_E2E_CHAT_INTEREST__ is not installed');
    return hook
      .list()
      .filter((entry) =>
        entry.interest.focused.some((ref) => ref.chatId === id),
      )
      .map((entry) => entry.webContentsId);
  }, chatId);
}

/** The host's recorded `remote_push_summary` bodies, oldest first. */
function remotePushSummaries(userDataDir) {
  const directory = path.join(
    userDataDir,
    'agent-observability',
    'diagnostics',
    'app-events',
  );
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names
    .sort()
    .flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8').split('\n'),
    )
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record.kind === 'remote_push_summary'
          ? [record.remotePushSummary]
          : [];
      } catch {
        return [];
      }
    });
}

test.describe('remote access chat interest', () => {
  test.setTimeout(300_000);

  test('the host records the controller window interest for its bridge', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_interest_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-interest-user',
        },
      },
    });

    const desktops = [];
    try {
      const host = await launchDesktop({
        label: 'interest-host',
        demoApp: 'ts-pnpm-vite',
        apiKey,
        seed: (userDataDir) => {
          seedWorktreeChat({
            userDataDir,
            workspaceId: HOST_PROJECT,
            worktreeId: WORKTREE_ID,
            providerType: 'claude',
            tabs: [
              { id: FIRST_CHAT, title: 'First remote chat' },
              { id: SECOND_CHAT, title: 'Second remote chat' },
            ],
            activeTabId: FIRST_CHAT,
          });
        },
      });
      desktops.push(host);
      const controller = await launchDesktop({
        label: 'interest-controller',
        apiKey,
      });
      desktops.push(controller);

      await pairDevices(controller, host);
      const remote = await openRemoteWindow(controller, host);
      const hostWindowId = await webContentsIdOf(host.electronApp, host.window);

      // The controller's window shows the host's first chat.
      const remoteApp = new CanopyAppDriver(remote.window);
      await remoteApp.openMainPage();
      await remoteApp.selectWorktree(WORKTREE_ID);
      await expect(
        remote.window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT}`),
      ).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(async () => bridgeInterests(host), { timeout: 30_000 })
        .toEqual([expect.objectContaining({ focused: [FIRST_CHAT] })]);
      const [bridge] = await bridgeInterests(host);
      expect(bridge.webContentsId).not.toBe(hostWindowId);
      // The controlling computer records nothing for its remote window.
      const remoteWindowId = await webContentsIdOf(
        controller.electronApp,
        remote.window,
      );
      expect(
        await controller.electronApp.evaluate(
          (_electron, id) =>
            globalThis.__CANOPY_E2E_CHAT_INTEREST__
              ?.list()
              .some((entry) => entry.webContentsId === id) ?? false,
          remoteWindowId,
        ),
      ).toBe(false);

      // Switching chats in the remote window moves the record with it.
      await remote.window
        .getByTestId(`panel-tab-panel-chat-${SECOND_CHAT}`)
        .click();
      await expect
        .poll(async () => bridgeInterests(host), { timeout: 30_000 })
        .toEqual([
          {
            webContentsId: bridge.webContentsId,
            focused: [SECOND_CHAT],
            warm: [FIRST_CHAT],
          },
        ]);

      // Ending the session (the host removes the controller) drops the
      // bridge and its record.
      await host.window.evaluate(
        (deviceId) =>
          window.api.remoteControl.forgetDevice({
            deviceId,
            role: 'controller',
          }),
        controller.deviceId,
      );
      await expect
        .poll(async () => (await remoteState(host.window)).controllers.length, {
          timeout: 30_000,
        })
        .toBe(0);
      await expect
        .poll(
          async () =>
            (await recordsFocusing(host, SECOND_CHAT)).filter(
              (id) => id !== hostWindowId,
            ),
          { timeout: 30_000 },
        )
        .toEqual([]);
      expect(await bridgeInterests(host)).toEqual([]);

      // Ending the session flushes its partial window: the host records a
      // content-free push summary on its own device.
      await expect
        .poll(() => remotePushSummaries(host.userDataDir).length, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      const [summary] = remotePushSummaries(host.userDataDir);
      expect(Object.keys(summary).sort()).toEqual([
        'chatEvent',
        'chatState',
        'duplicateDrops',
        'interestDeclared',
        'other',
        'terminal',
        'windowMs',
      ]);
      expect(
        summary.chatState.pushes +
          summary.chatEvent.pushes +
          summary.other.pushes,
      ).toBeGreaterThan(0);
    } finally {
      for (const desktop of desktops.reverse()) {
        await closeCanopy(desktop.electronApp, desktop.userDataDir);
      }
      await relay.stop();
    }
  });
});
