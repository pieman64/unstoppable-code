/**
 * Device-to-device remote access latency benchmark (manual).
 *
 * Run: REMOTE_ACCESS_BENCH=1 pnpm run test:electron:built remote-access-bench.spec.mjs --reporter=line
 *
 * Two desktops on one machine talk through the real `apps/device-relay`,
 * behind a TCP proxy that adds a fixed delay in each direction, for each
 * round-trip profile below. Because both desktops share one clock, one-way
 * push latency is measured directly from timestamps the host prints.
 * Results are printed and written to `.performance/remote-access/`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  summarize,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'bench-chat';
const BACKGROUND_CHAT_IDS = [
  'bench-background-1',
  'bench-background-2',
  'bench-background-3',
];
// REMOTE_ACCESS_BENCH_PROFILES=rtt-40ms,... runs only the named profiles.
const PROFILES = [
  { name: 'loopback', oneWayDelayMs: 0 },
  { name: 'rtt-40ms', oneWayDelayMs: 20 },
  { name: 'rtt-150ms', oneWayDelayMs: 75 },
].filter(
  (profile) =>
    !process.env.REMOTE_ACCESS_BENCH_PROFILES ||
    process.env.REMOTE_ACCESS_BENCH_PROFILES.split(',').includes(profile.name),
);
// Each background chat is switched to once, alternating no dwell and a dwell
// on its tab first, which lets the foreground-first prefetch read it.
const SWITCH_HOVER_MS = [0, 250, 0];
const STREAM_STEP = {
  text: `Streaming reply token by token. ${'More text follows here. '.repeat(20)}`,
  streamMs: 3_000,
  chunkChars: 6,
};
const BACKGROUND_STREAM_STEP = {
  text: `Background stream reply. ${'More background text follows here. '.repeat(20)}`,
  streamMs: 8_000,
  chunkChars: 6,
};

/**
 * TCP proxy used by this manual bench. It matches startDelayProxy's delay
 * behavior while also counting the outer WebSocket frames and bytes, which
 * remain opaque because the relay payloads are end-to-end encrypted.
 */
async function startMeasuredDelayProxy({ targetPort, oneWayDelayMs = 0 }) {
  const sockets = new Set();
  const traffic = {
    toRelay: { bytes: 0, tcpChunks: 0, webSocketFrames: 0 },
    toDesktop: { bytes: 0, tcpChunks: 0, webSocketFrames: 0 },
  };
  const countFrames = (direction) => {
    let handshake = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    let upgraded = false;
    return (chunk) => {
      const counts = traffic[direction];
      counts.bytes += chunk.length;
      counts.tcpChunks += 1;
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const separator = handshake.indexOf('\r\n\r\n');
        if (separator === -1) return;
        pending = handshake.subarray(separator + 4);
        handshake = Buffer.alloc(0);
        upgraded = true;
      } else {
        pending = Buffer.concat([pending, chunk]);
      }

      while (pending.length >= 2) {
        const lengthCode = pending[1] & 0x7f;
        let payloadLength = lengthCode;
        let headerLength = 2;
        if (lengthCode === 126) {
          if (pending.length < 4) break;
          payloadLength = pending.readUInt16BE(2);
          headerLength = 4;
        } else if (lengthCode === 127) {
          if (pending.length < 10) break;
          const extendedLength = pending.readBigUInt64BE(2);
          if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('WebSocket frame length is too large to count');
          }
          payloadLength = Number(extendedLength);
          headerLength = 10;
        }
        if ((pending[1] & 0x80) !== 0) headerLength += 4;
        const frameLength = headerLength + payloadLength;
        if (pending.length < frameLength) break;
        counts.webSocketFrames += 1;
        pending = pending.subarray(frameLength);
      }
    };
  };

  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    // Match the production test proxy: avoid Nagle/delayed-ACK latency.
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const pipeDelayed = (from, to, direction) => {
      const countForwarded = countFrames(direction);
      from.on('data', (chunk) => {
        const forward = () => {
          if (to.destroyed) return;
          countForwarded(chunk);
          to.write(chunk);
        };
        if (oneWayDelayMs === 0) {
          forward();
        } else {
          setTimeout(forward, oneWayDelayMs);
        }
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
    trafficSnapshot() {
      return Object.fromEntries(
        Object.entries(traffic).map(([direction, counts]) => [
          direction,
          { ...counts },
        ]),
      );
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function trafficDelta(before, after) {
  return Object.fromEntries(
    Object.entries(after).map(([direction, counts]) => [
      direction,
      {
        bytes: counts.bytes - before[direction].bytes,
        tcpChunks: counts.tcpChunks - before[direction].tcpChunks,
        webSocketFrames:
          counts.webSocketFrames - before[direction].webSocketFrames,
      },
    ]),
  );
}

/**
 * Sends a chat in a window and samples the reply's visible length until the
 * turn completes: first text, how many distinct partial lengths were seen
 * (incremental streaming), and completion.
 */
async function measureChat(window, marker) {
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = await showChatPanel(window, CHAT_ID);
  await panel.getByRole('textbox').fill(`[${marker}] Stream please`);
  const count = (text, needle) => text.split(needle).length - 1;
  const baseline = await panel.evaluate((element) => element.textContent ?? '');
  const sentAt = Date.now();
  await panel.getByRole('textbox').press('Enter');
  return panel.evaluate(
    async (element, { sentAt, replyBefore, doneBefore }) => {
      const count = (text, needle) => text.split(needle).length - 1;
      const lengths = new Set();
      let firstTextMs = null;
      for (;;) {
        const text = element.textContent ?? '';
        if (count(text, 'Streaming reply') > replyBefore) {
          firstTextMs ??= Date.now() - sentAt;
          lengths.add(text.length);
        }
        if (count(text, 'Completed in') > doneBefore) {
          return {
            firstTextMs,
            completeMs: Date.now() - sentAt,
            distinctPartialRenders: lengths.size,
          };
        }
        if (Date.now() - sentAt > 60_000) {
          return { firstTextMs, completeMs: null, distinctPartialRenders: 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    {
      sentAt,
      replyBefore: count(baseline, 'Streaming reply'),
      doneBefore: count(baseline, 'Completed in'),
    },
  );
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

async function measureInvokes(window, count) {
  return window.evaluate(async (n) => {
    const samples = [];
    for (let index = 0; index < n; index += 1) {
      const startedAt = performance.now();
      await window.api.terminal.list();
      samples.push(performance.now() - startedAt);
    }
    return samples;
  }, count);
}

async function measureTerminal(remoteWindow, { echoOnly = false } = {}) {
  return remoteWindow.evaluate(
    async ({ projectId, worktreeId, echoOnly }) => {
      const decoder = new TextDecoder();
      const listeners = new Set();
      let terminalId = null;
      const unsubscribe = window.api.terminal.onOutput((event) => {
        if (terminalId !== null && event.terminalId !== terminalId) return;
        const text = decoder.decode(event.data);
        const receivedAt = Date.now();
        for (const listener of listeners)
          listener(text, receivedAt, event.data.byteLength);
      });
      const waitFor = (predicate, timeoutMs = 30_000) =>
        new Promise((resolve, reject) => {
          let buffer = '';
          const timer = setTimeout(() => {
            listeners.delete(listener);
            reject(new Error(`Timed out: ${buffer.slice(-200)}`));
          }, timeoutMs);
          const listener = (text, receivedAt, bytes) => {
            buffer += text;
            const result = predicate(buffer, receivedAt, bytes);
            if (result !== undefined) {
              clearTimeout(timer);
              listeners.delete(listener);
              resolve(result);
            }
          };
          listeners.add(listener);
        });
      const spawned = await window.api.terminal.spawn({
        projectId,
        worktreeId,
        cols: 200,
        rows: 50,
      });
      terminalId = spawned.id;
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Keystroke to echo: type a unique token and wait for the shell's echo.
      const echo = [];
      for (let index = 0; index < 30; index += 1) {
        const token = `k${index}x${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = performance.now();
        const seen = waitFor((buffer) =>
          buffer.includes(token) ? true : undefined,
        );
        await window.api.terminal.write({ terminalId, data: token });
        await seen;
        echo.push(performance.now() - startedAt);
        await window.api.terminal.write({ terminalId, data: '\u0015' });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      if (echoOnly) {
        unsubscribe();
        await window.api.terminal.kill({ terminalId });
        return { echo };
      }

      // One-way push latency from host timestamps (same machine clock).
      const pushLatency = [];
      const pushDone = waitFor((buffer, receivedAt) => {
        const matches = buffer.match(/TS:(\d{13})/g) ?? [];
        while (pushLatency.length < matches.length) {
          const stamp = Number(matches[pushLatency.length].slice(3));
          pushLatency.push(receivedAt - stamp);
        }
        return buffer.includes('TS-2END') ? true : undefined;
      });
      await window.api.terminal.write({
        terminalId,
        data: 'for i in $(seq 1 40); do echo TS:$(date +%s%3N); sleep 0.05; done; echo TS-$((1+1))END\r',
      });
      await pushDone;

      // Streaming throughput: 5 MB of output.
      let bytes = 0;
      const throughputStartedAt = performance.now();
      const streamed = waitFor((buffer, _receivedAt, chunkBytes) => {
        bytes += chunkBytes;
        return buffer.includes('BULK-5END') ? true : undefined;
      }, 120_000);
      await window.api.terminal.write({
        terminalId,
        data: 'head -c 3750000 /dev/urandom | base64 -w 200; echo BULK-$((2+3))END\r',
      });
      await streamed;
      const throughputMs = performance.now() - throughputStartedAt;
      unsubscribe();
      await window.api.terminal.kill({ terminalId });
      return { echo, pushLatency, bytes, throughputMs };
    },
    { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, echoOnly },
  );
}

/** Every seeded chat's panel stays mounted, so select one by its panel id. */
async function showChatPanel(window, chatId) {
  await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

async function sendBackgroundChatTurn(hostWindow, chatId, marker) {
  const panel = await showChatPanel(hostWindow, chatId);
  await panel.getByRole('textbox').fill(`[${marker}] Stream please`);
  await panel.getByRole('textbox').press('Enter');
}

async function waitForBackgroundChatTurns(hostWindow) {
  const observedRunning = new Set();
  await expect
    .poll(
      async () => {
        const sessions = await hostWindow.evaluate(
          async ({ projectId, worktreeId }) => {
            const state = await window.api.chat.activeSessions({
              projectId,
              worktreeId,
            });
            return state.sessions ?? [];
          },
          { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        );
        const byChatId = new Map(
          sessions.map((session) => [session.chatId, session]),
        );
        for (const chatId of BACKGROUND_CHAT_IDS) {
          if (byChatId.get(chatId)?.turnActive) observedRunning.add(chatId);
        }
        return BACKGROUND_CHAT_IDS.every(
          (chatId) =>
            observedRunning.has(chatId) &&
            byChatId.get(chatId)?.turnActive !== true,
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

async function measureBackgroundStreaming({
  profile,
  hostWindow,
  remoteWindow,
  hostProxy,
  controllerProxy,
  markers,
}) {
  const hostApp = new CanopyAppDriver(hostWindow);
  await hostApp.openMainPage();
  await hostApp.selectWorktree(WORKTREE_ID);
  const remoteApp = new CanopyAppDriver(remoteWindow);
  await remoteApp.openMainPage();
  await remoteApp.selectWorktree(WORKTREE_ID);
  await remoteWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();

  await remoteWindow.evaluate((chatIds) => {
    const counts = Object.fromEntries(chatIds.map((chatId) => [chatId, 0]));
    const unsubscribe = window.api.chat.onChatEvent(({ chatId }) => {
      if (Object.hasOwn(counts, chatId)) counts[chatId] += 1;
    });
    window.__remoteAccessBenchChatEventCounts = counts;
    window.__remoteAccessBenchChatEventUnsubscribe = unsubscribe;
  }, BACKGROUND_CHAT_IDS);

  const hostTrafficBefore = hostProxy.trafficSnapshot();
  const controllerTrafficBefore = controllerProxy.trafficSnapshot();
  const startedAt = Date.now();
  for (const [index, chatId] of BACKGROUND_CHAT_IDS.entries()) {
    await sendBackgroundChatTurn(hostWindow, chatId, markers[index]);
  }

  // Keep the controller on its foreground chat while the host's other chats
  // stream, and sample the same terminal echo path as the baseline measure.
  await remoteWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
  const backgroundTurnsDone = waitForBackgroundChatTurns(hostWindow);
  const [echo] = await Promise.all([
    measureTerminal(remoteWindow, { echoOnly: true }),
    backgroundTurnsDone,
  ]);
  await remoteWindow.waitForTimeout(profile.oneWayDelayMs * 2 + 50);

  const eventCounts = await remoteWindow.evaluate(() => ({
    ...window.__remoteAccessBenchChatEventCounts,
  }));
  const hostTraffic = trafficDelta(
    hostTrafficBefore,
    hostProxy.trafficSnapshot(),
  );
  const controllerTraffic = trafficDelta(
    controllerTrafficBefore,
    controllerProxy.trafficSnapshot(),
  );
  await remoteWindow.evaluate(() => {
    window.__remoteAccessBenchChatEventUnsubscribe?.();
    delete window.__remoteAccessBenchChatEventCounts;
    delete window.__remoteAccessBenchChatEventUnsubscribe;
  });

  return {
    burstMs: Date.now() - startedAt,
    backgroundChatCount: BACKGROUND_CHAT_IDS.length,
    remoteForegroundChatId: CHAT_ID,
    pushesAtControllerByChannel: {
      'chat:event': {
        total: Object.values(eventCounts).reduce(
          (total, count) => total + count,
          0,
        ),
        byBackgroundChat: eventCounts,
      },
    },
    keystrokeEchoMs: summarize(echo.echo),
    controllerProxyTraffic: {
      controllerToRelay: controllerTraffic.toRelay,
      relayToController: controllerTraffic.toDesktop,
    },
    hostProxyTraffic: {
      hostToRelay: hostTraffic.toRelay,
      relayToHost: hostTraffic.toDesktop,
    },
    perChannelTraffic: null,
    perChannelTrafficNote:
      'The relay payloads are end-to-end encrypted; only aggregate outer WebSocket traffic is visible at the proxy. Controller chat:event pushes are counted by background chat above.',
  };
}

/** Click to the background reply at the controller, after an optional dwell. */
async function measureBackgroundSwitches(remoteWindow) {
  const switches = [];
  for (const [index, chatId] of BACKGROUND_CHAT_IDS.entries()) {
    const hoverMs = SWITCH_HOVER_MS[index];
    const tab = remoteWindow.getByTestId(`panel-tab-panel-chat-${chatId}`);
    const panel = remoteWindow.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    if (hoverMs > 0) {
      await tab.hover();
      await remoteWindow.waitForTimeout(hoverMs);
    }
    const startedAt = performance.now();
    await tab.click();
    await expect(panel.getByText('Background stream reply.')).toBeVisible({
      timeout: 30_000,
    });
    switches.push({
      chatId,
      hoverMs,
      clickToReplyMs: Math.round(performance.now() - startedAt),
    });
    await remoteWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
  }
  return switches;
}

test.describe('device-to-device remote access latency', () => {
  test.skip(
    process.env.REMOTE_ACCESS_BENCH !== '1',
    'Manual benchmark: set REMOTE_ACCESS_BENCH=1',
  );
  test.setTimeout(1_800_000);

  test('measures remote access latency across network profiles', async () => {
    const relay = await startDeviceRelay();
    const results = [];
    try {
      for (const profile of PROFILES) {
        const hostProxy = await startMeasuredDelayProxy({
          targetPort: relay.port,
          oneWayDelayMs: profile.oneWayDelayMs,
        });
        const controllerProxy = await startMeasuredDelayProxy({
          targetPort: relay.port,
          oneWayDelayMs: profile.oneWayDelayMs,
        });
        const hostApiKey = `csk_remote_bench_host_${randomUUID()}`;
        const controllerApiKey = `csk_remote_bench_controller_${randomUUID()}`;
        const userId = `remote-access-bench-${profile.name}`;
        const marker = `Canopy-CREMOTEBENCH${randomUUID().slice(0, 8).toUpperCase()}`;
        const backgroundMarkers = BACKGROUND_CHAT_IDS.map(
          (_, index) => `${marker}BACKGROUND${index + 1}`,
        );
        const desktops = [];
        try {
          await registerScenario(undefined, hostApiKey, {
            cloud: {
              deviceRelay: { url: hostProxy.url, secret: relay.secret, userId },
            },
          });
          await registerScenario(undefined, controllerApiKey, {
            cloud: {
              deviceRelay: {
                url: controllerProxy.url,
                secret: relay.secret,
                userId,
              },
            },
          });
          await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
            llm: { steps: [STREAM_STEP] },
          });
          await Promise.all(
            backgroundMarkers.map((backgroundMarker) =>
              registerScenario(DEFAULT_MOCK_BASE_URL, backgroundMarker, {
                llm: { steps: [BACKGROUND_STREAM_STEP] },
              }),
            ),
          );
          const host = await launchDesktop({
            label: `bench-host-${profile.name}`,
            demoApp: 'ts-pnpm-vite',
            apiKey: hostApiKey,
            seed: (userDataDir) => {
              seedWorktreeChat({
                userDataDir,
                workspaceId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                providerType: 'claude',
                tabs: [
                  {
                    id: CHAT_ID,
                    title: 'Bench chat',
                    model: 'claude-haiku-4-5-20251001',
                  },
                  ...BACKGROUND_CHAT_IDS.map((id, index) => ({
                    id,
                    title: `Background bench chat ${index + 1}`,
                    model: 'claude-haiku-4-5-20251001',
                  })),
                ],
              });
            },
          });
          desktops.push(host);
          const controller = await launchDesktop({
            label: `bench-controller-${profile.name}`,
            apiKey: controllerApiKey,
          });
          desktops.push(controller);
          const pairStartedAt = Date.now();
          await pairDevices(controller, host);
          const pairMs = Date.now() - pairStartedAt;
          const remote = await openRemoteWindow(controller, host);

          await measureInvokes(remote.window, 20);
          const remoteInvoke = await measureInvokes(remote.window, 200);
          const localInvoke = await measureInvokes(controller.window, 200);
          const terminal = await measureTerminal(remote.window);

          // Alternate remote and local turns so a cold provider start does
          // not land on one side only.
          const chatRounds = [];
          for (let round = 0; round < 2; round += 1) {
            for (const [side, target] of [
              ['remote', remote.window],
              ['local', host.window],
            ]) {
              const roundMarker = `${marker}${side.toUpperCase()}${round}`;
              await registerScenario(DEFAULT_MOCK_BASE_URL, roundMarker, {
                llm: { steps: [STREAM_STEP] },
              });
              chatRounds.push({
                side,
                round,
                ...(await measureChat(target, roundMarker)),
              });
            }
          }
          const localTerminal = await measureTerminal(host.window);
          const backgroundStreaming =
            profile.oneWayDelayMs === 0 || profile.oneWayDelayMs === 20
              ? await measureBackgroundStreaming({
                  profile,
                  hostWindow: host.window,
                  remoteWindow: remote.window,
                  hostProxy,
                  controllerProxy,
                  markers: backgroundMarkers,
                })
              : null;
          const backgroundSwitches = backgroundStreaming
            ? await measureBackgroundSwitches(remote.window)
            : null;

          results.push({
            profile: profile.name,
            // Both computers reach the relay over the delayed link, so a
            // computer-to-computer round trip crosses it twice each way.
            deviceToRelayRttMs: profile.oneWayDelayMs * 2,
            deviceToDeviceRttMs: profile.oneWayDelayMs * 4,
            pairMs,
            openWindowToProjectsMs: remote.openedInMs,
            localInvokeMs: summarize(localInvoke),
            remoteInvokeMs: summarize(remoteInvoke),
            keystrokeEchoMs: summarize(terminal.echo),
            pushOneWayMs: summarize(terminal.pushLatency),
            streamedBytes: terminal.bytes,
            streamThroughputMBps:
              Math.round(
                (terminal.bytes / 1e6 / (terminal.throughputMs / 1000)) * 10,
              ) / 10,
            chatRounds,
            localKeystrokeEchoOnHostMs: summarize(localTerminal.echo),
            localPushOneWayOnHostMs: summarize(localTerminal.pushLatency),
            backgroundStreaming,
            backgroundSwitches,
          });
        } finally {
          for (const desktop of desktops.reverse()) {
            await closeCanopy(desktop.electronApp, desktop.userDataDir);
          }
          await Promise.all([hostProxy.stop(), controllerProxy.stop()]);
        }
      }
    } finally {
      await relay.stop();
    }
    const outDir = path.join(repoRoot, '.performance', 'remote-access');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(
      outDir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`REMOTE-ACCESS-BENCH ${JSON.stringify(results)}`);
    expect(results).toHaveLength(PROFILES.length);
  });
});
