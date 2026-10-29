import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { launchCanopy } from '../launchCanopy.mjs';
import { connectMockCloudAccount } from '../seeders/index.mjs';
import { setEarlyAccess } from './earlyAccess.mjs';
import { withBundledBinaryOverridesScrubbed } from '../seeders/bundledBinaryOverrides.mjs';

/**
 * Shared helpers for device-to-device remote access specs: launching several
 * desktops on one machine, pairing them through the preload API, opening a
 * paired computer's window, running work there, and shaping the network.
 */

// Cloud sign-in needs OS secure storage. Electron cannot detect the Secret
// Service under every Linux desktop, so point it there explicitly; macOS and
// Windows ignore the switch.
export const REMOTE_ACCESS_ELECTRON_ARGS =
  process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];

export const DEMO_APPS = {
  'ts-pnpm-vite': 'TypeScript pnpm Vite',
  'ts-bun-api': 'TypeScript Bun API',
  'ts-yarn-cli': 'TypeScript Yarn CLI',
};

export function seedDesktopPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
        mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
      },
    }),
    'utf8',
  );
}

/**
 * The app's own window. A paired controller may connect before it opens, and
 * the hidden bridge window that serves it (a `data:` page) can be the first
 * window of a restarted host.
 */
async function appWindow(electronApp, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = electronApp
      .windows()
      .find((page) => !page.url().startsWith('data:'));
    if (found) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The app window did not open.');
    await electronApp
      .waitForEvent('window', { timeout: Math.min(remaining, 1_000) })
      .catch(() => undefined);
  }
}

/**
 * Launches one desktop with its own data root, optionally seeded with a demo
 * project, signed in to `apiKey`. Pass the `userDataDir` of an earlier
 * desktop to start that computer again (a restart).
 */
export async function launchDesktop({
  label,
  demoApp = null,
  apiKey,
  env,
  seed,
  userDataDir: existingUserDataDir = null,
}) {
  const userDataDir =
    existingUserDataDir ??
    mkdtempSync(path.join(os.tmpdir(), `canopy-remote-${label}-`));
  if (existingUserDataDir === null) {
    if (demoApp) seedDemoWorkspaces({ userDataDir, apps: [demoApp] });
    seedDesktopPreferences(userDataDir);
    if (seed) await seed(userDataDir);
  }
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      electronArgs: REMOTE_ACCESS_ELECTRON_ARGS,
      ...(env ? { env } : {}),
    }),
  );
  const window = await appWindow(launched.electronApp);
  await window.waitForLoadState('domcontentloaded');
  await expect(window.getByTestId('app-sidebar')).toBeVisible({
    timeout: 60_000,
  });
  await connectMockCloudAccount(window, apiKey);
  // Remote control is an early-access feature; signed in, the choice is
  // saved to the account.
  await setEarlyAccess(window, true);
  return {
    label,
    demoApp,
    userDataDir,
    electronApp: launched.electronApp,
    window,
  };
}

export async function remoteState(window, request = {}) {
  return window.evaluate(
    (options) => window.api.remoteControl.getState(options),
    request,
  );
}

/** Turns on incoming control and returns the host's device ID. */
export async function allowIncoming(host) {
  const state = await host.window.evaluate(() =>
    window.api.remoteControl.setAllowIncoming(true),
  );
  expect(state.allowIncoming).toBe(true);
  host.deviceId = state.thisDevice.deviceId;
  return host.deviceId;
}

/** Pairs `controller` with `host` through the preload API (host approves). */
export async function pairDevices(controller, host) {
  const hostId = host.deviceId ?? (await allowIncoming(host));
  await expect
    .poll(
      async () =>
        (
          await remoteState(controller.window, { discover: true })
        ).discoverable.map((device) => device.deviceId),
      { timeout: 30_000 },
    )
    .toContain(hostId);
  await controller.window.evaluate(
    (deviceId) => window.api.remoteControl.startPairing(deviceId),
    hostId,
  );
  let pairingId = null;
  await expect
    .poll(
      async () => {
        const state = await remoteState(host.window);
        const controllerId = (await remoteState(controller.window)).thisDevice
          ?.deviceId;
        const pending = state.incomingPairings.find(
          (entry) => entry.deviceId === controllerId,
        );
        pairingId = pending?.pairingId ?? null;
        return pairingId !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await host.window.evaluate(
    (id) =>
      window.api.remoteControl.respondToPairing({
        pairingId: id,
        approve: true,
      }),
    pairingId,
  );
  await expect
    .poll(
      async () =>
        (await remoteState(controller.window)).outgoingPairing?.status,
      { timeout: 30_000 },
    )
    .toBe('approved');
  controller.deviceId = (
    await remoteState(controller.window)
  ).thisDevice.deviceId;
  return hostId;
}

/** Opens the window that shows `host` on `controller`; waits for its project. */
export async function openRemoteWindow(controller, host) {
  const windowPromise = controller.electronApp.waitForEvent('window');
  const startedAt = Date.now();
  await controller.window.evaluate(
    (deviceId) => window.api.remoteControl.openMachine(deviceId),
    host.deviceId,
  );
  const remoteWindow = await windowPromise;
  await remoteWindow.waitForLoadState('domcontentloaded');
  if (host.demoApp) {
    await expect(remoteWindow.getByTestId('app-sidebar')).toContainText(
      DEMO_APPS[host.demoApp],
      { timeout: 60_000 },
    );
  }
  return { window: remoteWindow, openedInMs: Date.now() - startedAt };
}

/**
 * Runs a shell command on the computer a remote window shows, through that
 * window's terminal API, and resolves with its streamed output once `marker`
 * appears. End commands with `sleep 1` after the marker: the terminal drops
 * output that arrives after the shell exits.
 */
export async function runRemoteTerminal(
  remoteWindow,
  { projectId, worktreeId, command, marker, timeoutMs = 60_000 },
) {
  return remoteWindow.evaluate(
    async ({ projectId, worktreeId, command, marker, timeoutMs }) => {
      const decoder = new TextDecoder();
      let text = '';
      let terminalId = null;
      const startedAt = performance.now();
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No terminal output for ${marker}: ${text.slice(-400)}`,
              ),
            ),
          timeoutMs,
        );
        const unsubscribe = window.api.terminal.onOutput((event) => {
          if (terminalId !== null && event.terminalId !== terminalId) return;
          text += decoder.decode(event.data);
          if (text.includes(marker)) {
            clearTimeout(timer);
            unsubscribe();
            resolve({ text, elapsedMs: performance.now() - startedAt });
          }
        });
      });
      const spawned = await window.api.terminal.spawn({
        projectId,
        worktreeId,
        cols: 120,
        rows: 30,
        initialCommand: command,
      });
      terminalId = spawned.id;
      return done;
    },
    { projectId, worktreeId, command, marker, timeoutMs },
  );
}

/**
 * TCP proxy in front of the relay that delays every chunk by `oneWayDelayMs`
 * in each direction, so a WebSocket through it sees a round trip of twice
 * that. Order is preserved because every chunk in a direction waits the same
 * time. It can also break the network on purpose:
 * - `dropConnections()` resets every connection through it, like a network
 *   that went away;
 * - `corruptNext(direction)` flips one byte in the middle of the next large
 *   chunk going `'toRelay'` or `'toDesktop'`, like a bad packet that got past
 *   TCP's checksum.
 */
export async function startDelayProxy({ targetPort, oneWayDelayMs = 0 }) {
  const sockets = new Set();
  const corruptions = { toRelay: 0, toDesktop: 0 };
  let corrupted = 0;
  const maybeCorrupt = (direction, chunk) => {
    if (corruptions[direction] === 0 || chunk.length < 512) return chunk;
    corruptions[direction] -= 1;
    corrupted += 1;
    const copy = Buffer.from(chunk);
    const index = Math.floor(copy.length / 2);
    copy[index] ^= 0xff;
    return copy;
  };
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    // Like the relay and the desktop client, never hold small frames back
    // (Nagle plus delayed ACKs would add ~40 ms that real paths do not have).
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const pipeDelayed = (from, to, direction) => {
      from.on('data', (received) => {
        const chunk = maybeCorrupt(direction, received);
        if (oneWayDelayMs === 0) {
          if (!to.destroyed) to.write(chunk);
          return;
        }
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, oneWayDelayMs);
      });
      from.on('close', () => {
        setTimeout(() => to.destroy(), oneWayDelayMs);
      });
      from.on('error', () => to.destroy());
    };
    pipeDelayed(client, upstream, 'toRelay');
    pipeDelayed(upstream, client, 'toDesktop');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    dropConnections() {
      for (const socket of sockets) socket.resetAndDestroy();
      sockets.clear();
    },
    corruptNext(direction) {
      corruptions[direction] += 1;
    },
    /** Chunks corrupted so far. */
    corrupted: () => corrupted,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
}

export function summarize(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
}
