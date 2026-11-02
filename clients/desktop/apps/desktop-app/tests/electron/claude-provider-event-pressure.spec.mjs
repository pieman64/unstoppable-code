// Installed Claude SDK → utility host → routed Code chat → canonical V2
// transcript. The fake CLI emits an ordered burst through real stdout
// backpressure while the first assistant persistence write is held.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { delayProviderTranscriptWrites } from './helpers/delayProviderTranscriptWrites.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { holdProviderTranscriptWrite } from './seeders/holdProviderTranscriptWrite.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

// The installed SDK invokes .mjs executables as `node <fixture> ...`, which
// also works with the process host's spawn(shell:false) on Windows.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'claude-pressure-chat';
const SESSION_ID = `${WORKSPACE_ID}/${WORKTREE_ID}/${CHAT_ID}`;
const COUNT = 128;
const MARKER = 'CANOPY-CLAUDE-PRESSURE-';
const FIRST_MARKER = `${MARKER}000`;
const FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
);
const STEER_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-pressure-steer-cli.mjs', import.meta.url),
);

function fixtureLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sentCount(logPath) {
  return fixtureLog(logPath).filter((entry) => entry.type === 'sent').length;
}

function userInvocations(logPath) {
  return fixtureLog(logPath).filter((entry) => entry.type === 'user');
}

async function installHostCounters(electronApp, fakeCliPath) {
  await electronApp.evaluate(
    (
      { utilityProcess },
      { expectedCommand, expectedPrompt, expectedSession },
    ) => {
      const originalFork = utilityProcess.fork;
      const restoreChildren = [];
      const fixtureRequestIds = new Set();
      const matchedRequestIds = new Set();
      const inputFragments = new Map();
      const counters = {
        hosts: 0,
        fixtureSpawns: 0,
        matchedSpawns: 0,
        truncatedInputFrames: 0,
        stdoutFrames: 0,
        forwardedBytes: 0,
        acknowledgedBytes: 0,
      };
      utilityProcess.fork = function (...args) {
        const child = originalFork.apply(this, args);
        if (args[2]?.serviceName !== 'claude-process-host') return child;
        counters.hosts += 1;
        const onMessage = (message) => {
          const payload = message?.data ?? message;
          if (
            payload?.type !== 'stdout' ||
            !matchedRequestIds.has(payload.requestId)
          ) {
            return;
          }
          counters.stdoutFrames += 1;
          counters.forwardedBytes += Buffer.byteLength(
            payload.dataBase64,
            'base64',
          );
        };
        child.on('message', onMessage);
        const originalPostMessage = child.postMessage;
        child.postMessage = function (message, ...rest) {
          if (
            message?.type === 'spawn' &&
            (message.command === expectedCommand ||
              message.args?.[0] === expectedCommand)
          ) {
            fixtureRequestIds.add(message.requestId);
            counters.fixtureSpawns += 1;
          }
          if (
            message?.type === 'stdin' &&
            fixtureRequestIds.has(message.requestId) &&
            !matchedRequestIds.has(message.requestId)
          ) {
            let input =
              (inputFragments.get(message.requestId) ?? '') +
              Buffer.from(message.dataBase64, 'base64').toString('utf8');
            const lines = input.split('\n');
            input = lines.pop() ?? '';
            for (const line of lines) {
              if (!line) continue;
              try {
                const parsed = JSON.parse(line);
                const content = parsed?.message?.content;
                const text =
                  typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                      ? content
                          .filter((block) => block?.type === 'text')
                          .map((block) => String(block.text ?? ''))
                          .join('\n')
                      : '';
                if (
                  parsed?.type === 'user' &&
                  parsed.session_id === expectedSession &&
                  text.includes(expectedPrompt)
                ) {
                  matchedRequestIds.add(message.requestId);
                  counters.matchedSpawns += 1;
                }
              } catch {
                counters.truncatedInputFrames += 1;
              }
            }
            if (input.length > 8192) {
              counters.truncatedInputFrames += 1;
              inputFragments.delete(message.requestId);
            } else if (input) {
              inputFragments.set(message.requestId, input);
            } else {
              inputFragments.delete(message.requestId);
            }
          }
          if (
            message?.type === 'stdout-ack' &&
            matchedRequestIds.has(message.requestId)
          ) {
            counters.acknowledgedBytes += message.bytes;
          }
          return originalPostMessage.call(this, message, ...rest);
        };
        restoreChildren.push(() => {
          child.removeListener('message', onMessage);
          child.postMessage = originalPostMessage;
        });
        return child;
      };
      if (utilityProcess.fork === originalFork) {
        throw new Error(
          'Claude host counter could not wrap utilityProcess.fork',
        );
      }
      globalThis.__CANOPY_CLAUDE_PRESSURE_COUNTERS__ = counters;
      globalThis.__CANOPY_CLAUDE_PRESSURE_RESTORE__ = () => {
        utilityProcess.fork = originalFork;
        for (const restore of restoreChildren) restore();
        restoreChildren.length = 0;
        fixtureRequestIds.clear();
        matchedRequestIds.clear();
        inputFragments.clear();
        delete globalThis.__CANOPY_CLAUDE_PRESSURE_COUNTERS__;
        delete globalThis.__CANOPY_CLAUDE_PRESSURE_RESTORE__;
      };
    },
    {
      expectedCommand: fakeCliPath,
      expectedPrompt: 'Report Claude pressure status.',
      expectedSession: SESSION_ID,
    },
  );
}

async function readHostCounters(electronApp) {
  return electronApp.evaluate(() => ({
    ...globalThis.__CANOPY_CLAUDE_PRESSURE_COUNTERS__,
  }));
}

async function runClaudeFlow({
  assertPressure,
  count = 128,
  assertDrain = true,
}) {
  const lastMarker = `${MARKER}${String(count - 1).padStart(3, '0')}`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-pressure-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-pressure.log');
  copyFileSync(FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: CHAT_ID, title: 'Claude pressure chat', providerType: 'claude' },
    ],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_PRESSURE_LOG: logPath,
        CANOPY_CLAUDE_PRESSURE_COUNT: String(count),
      },
    }),
  );
  let barrier;
  let countersInstalled = false;
  try {
    await installHostCounters(electronApp, fakeCliPath);
    countersInstalled = true;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    barrier = await holdProviderTranscriptWrite(electronApp, {
      userDataDir,
      workspaceId: WORKSPACE_ID,
      scopeId: WORKTREE_ID,
      marker: FIRST_MARKER,
    });
    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot
      .getByRole('textbox')
      .fill('Report Claude pressure status.');
    await composerRoot.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(async () => (await barrier.read())?.reached, {
        timeout: 45_000,
      })
      .toBe(true);
    // Diagnostic brackets only: observe a sustained held sink at two fixed
    // points. Neither bracket contributes to benchmark timing acceptance.
    const heldSamples = [];
    for (const delayMs of [200, 400]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const host = await readHostCounters(electronApp);
      const sourceSent = sentCount(logPath);
      const users = userInvocations(logPath);
      const route = await window.evaluate(
        (target) =>
          window.electron.ipcRenderer
            .invoke('__CANOPY_E2E_PROVIDER_EVENT_PRESSURE__', target)
            .catch(() => null),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
      );
      heldSamples.push({ host, sourceSent, route });
      console.log(
        `CLAUDE_PRESSURE_HELD ${JSON.stringify({ delayMs, host, sourceSent, users, route })}`,
      );
      expect(host.hosts).toBeGreaterThanOrEqual(1);
      expect(host.fixtureSpawns).toBeGreaterThanOrEqual(1);
      expect(host.matchedSpawns).toBe(1);
      expect(host.truncatedInputFrames).toBe(0);
      expect(users.filter((entry) => entry.target)).toHaveLength(1);
      expect(host.forwardedBytes).toBeGreaterThan(0);
      expect(host.acknowledgedBytes).toBeLessThanOrEqual(host.forwardedBytes);
      await expect(panel.getByText(lastMarker, { exact: false })).toHaveCount(
        0,
      );
      if (assertPressure) {
        // The receipt read-ahead allowance (1 MiB,
        // CLAUDE_RECEIPT_READ_AHEAD_BYTES) on top of the group-commit bound:
        // stdout keeps arriving during a pending admission up to four
        // forwarding windows (CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES), and the
        // window already credited may still land after that. The flow emits
        // more than that, so the bound is reached while held.
        expect(host.forwardedBytes).toBeLessThanOrEqual(
          16 * 64 * 1024 + 5 * 64 * 1024 + 4096,
        );
        expect(route).not.toBeNull();
        expect(route.routeCount).toBeGreaterThanOrEqual(1);
        // The route holds up to 256 KiB of this chat's events in flight
        // (GROUP_COMMIT_EVENT_PRESSURE_LIMITS).
        expect(route.estimatedChargedBytes).toBeLessThanOrEqual(256 * 1024);
        expect(route.waitingCount).toBeLessThanOrEqual(1);
      }
    }
    expect(heldSamples[1].host.forwardedBytes).toBeGreaterThanOrEqual(
      heldSamples[0].host.forwardedBytes,
    );

    await barrier.release();
    // The saturating burst only proves the bound while held; the
    // ordered-messages case covers the drain.
    if (assertDrain) {
      await expect(
        panel.getByText(lastMarker, { exact: false }).first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect
        .poll(() => sentCount(logPath), { timeout: 30_000 })
        .toBe(COUNT);
      expect(
        userInvocations(logPath).filter((entry) => entry.target),
      ).toHaveLength(1);
      await expect
        .poll(
          () => {
            const { live } = readChatStorageIndexes(
              path.join(userDataDir, 'workspaces', WORKSPACE_ID),
              WORKTREE_ID,
            );
            return live.runtimeByChatId[CHAT_ID]?.status;
          },
          { timeout: 30_000 },
        )
        .toBe('completed');
      const messages = readChatStorageMessages(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
        CHAT_ID,
      );
      const rows = messages
        .map((message) => ({
          id: message.id,
          markers: (message.blocks ?? [])
            .filter((block) => block.type === 'text')
            .flatMap((block) =>
              Array.from(
                block.text.matchAll(/CANOPY-CLAUDE-PRESSURE-\d{3}/g),
                (match) => match[0],
              ),
            ),
        }))
        .filter((row) => row.markers.length > 0);
      expect(rows).toHaveLength(COUNT);
      expect(new Set(rows.map((row) => row.id)).size).toBe(COUNT);
      expect(rows.map((row) => row.markers)).toEqual(
        Array.from({ length: COUNT }, (_, index) => [
          `${MARKER}${String(index).padStart(3, '0')}`,
        ]),
      );
      const { live } = readChatStorageIndexes(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
      );
      expect(live.runtimeByChatId[CHAT_ID]?.status).toBe('completed');

      await window.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = new CanopyAppDriver(window);
      await reloaded.waitForShell({ timeout: 30_000 });
      await reloaded.openMainPage();
      await reloaded.selectWorktree(WORKTREE_ID);
      await expect(
        window.getByText(lastMarker, { exact: false }).first(),
      ).toBeVisible({ timeout: 45_000 });
    }
  } finally {
    try {
      await barrier?.stop();
    } finally {
      if (countersInstalled) {
        await electronApp
          .evaluate(() => globalThis.__CANOPY_CLAUDE_PRESSURE_RESTORE__?.())
          .catch(() => undefined);
      }
      await closeCanopy(electronApp, userDataDir);
    }
  }
}

test('Claude Code stream preserves all ordered messages through a held canonical write', async () => {
  test.setTimeout(180_000);
  await runClaudeFlow({ assertPressure: false });
});

test('Claude Code host and route pressure remain bounded during a held canonical write', async () => {
  test.setTimeout(180_000);
  await runClaudeFlow({ assertPressure: true, count: 640, assertDrain: false });
});

test('Claude steer acceptance is recorded promptly while transcript writes are slow', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-pressure-steer-'),
  );
  const fakeCliPath = path.join(
    userDataDir,
    'fake-claude-pressure-steer-cli.mjs',
  );
  const logPath = path.join(userDataDir, 'fake-claude-pressure-steer.log');
  const releasePath = path.join(userDataDir, 'release-steer-turn');
  copyFileSync(STEER_FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Claude steer pressure chat',
        providerType: 'claude',
      },
    ],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_PRESSURE_STEER_LOG: logPath,
        CANOPY_CLAUDE_PRESSURE_STEER_RELEASE: releasePath,
      },
    }),
  );
  let slowWrites;
  let window;
  try {
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();

    await window.evaluate(() => {
      globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_SEEN__ = false;
      const containsUncertainText = (node) => {
        if (!node) return false;
        if (node.nodeType === Node.TEXT_NODE)
          return (node.textContent ?? '').includes('Delivery uncertain');
        return Array.from(node.childNodes ?? []).some(containsUncertainText);
      };
      globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_OBSERVER__ =
        new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (
              (mutation.type === 'characterData' &&
                containsUncertainText(mutation.target)) ||
              Array.from(mutation.addedNodes ?? []).some(containsUncertainText)
            ) {
              globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_SEEN__ = true;
              break;
            }
          }
        });
      globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_OBSERVER__.observe(
        document.body,
        { subtree: true, childList: true, characterData: true },
      );
    });

    const composerRoot = panel.locator('[data-chat-composer-root]');
    const composer = composerRoot.getByRole('textbox').last();
    await composer.fill('Start Claude steer pressure stream.');
    await composerRoot.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(
        () =>
          fixtureLog(logPath).some(
            (entry) => entry.type === 'prelude_complete',
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    // Each later provider event now takes a slow commit; the steer's backlog
    // of frames queues behind them before its acknowledgement.
    slowWrites = await delayProviderTranscriptWrites(electronApp, {
      userDataDir,
      workspaceId: WORKSPACE_ID,
      scopeId: WORKTREE_ID,
      delayMs: 400,
    });

    const steerText = 'Please continue the held Claude turn.';
    await composer.fill(steerText);
    await composer.press('Enter');
    const queuedMessage = panel.getByTestId('queued-message-bubble');
    await expect(queuedMessage).toContainText(steerText, { timeout: 15_000 });
    const steerButton = queuedMessage.getByTestId('queued-message-steer');
    await expect(steerButton).toBeEnabled({ timeout: 15_000 });
    const deliveryRow = panel.getByTestId('input-delivery-row');
    // A re-render (the chat title arrives mid-turn) can swallow the click;
    // click again only while the bubble still offers Steer.
    await expect(async () => {
      if (await steerButton.isVisible()) await steerButton.click();
      await expect(deliveryRow).toContainText('Sending…', { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    const queuedAck = () =>
      fixtureLog(logPath).find((entry) => entry.type === 'steer_queued');
    await expect
      .poll(queuedAck, { timeout: 30_000 })
      .toMatchObject({ commandUuid: expect.any(String) });
    const ack = queuedAck();
    const backlog = fixtureLog(logPath).find(
      (entry) => entry.index === 'steer-backlog',
    );
    expect(backlog?.backlogBytes).toBeGreaterThan(64 * 1024);
    expect(ack.outputBytes).toBeLessThan(1024 * 1024);

    const deliveryAttempt = async () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId, text }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          const tab = state.tabsFile.tabs.find(
            (candidate) => candidate.id === chatId,
          );
          const row = tab?.inputDelivery?.rows.find(
            (candidate) => candidate.text === text,
          );
          const attempt = row?.attempts.find(
            (candidate) => candidate.id === row.currentAttemptId,
          );
          return {
            rowId: row?.id,
            state: row?.state,
            admittedAt: attempt?.admittedAt ?? null,
          };
        },
        {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          text: steerText,
        },
      );

    // Before read-ahead the acknowledgement waited behind 40 slow admissions
    // (at least 16 s); 5 s leaves room for load without masking that.
    const remainingMs = Math.max(1, ack.ackAtMs + 5_000 - Date.now());
    await expect
      .poll(async () => (await deliveryAttempt()).admittedAt, {
        timeout: remainingMs,
        intervals: [100],
        message:
          'Claude steer acceptance was not recorded within 5 s of its CLI queued acknowledgement (' +
          ack.outputBytes +
          ' stdout bytes)',
      })
      .not.toBeNull();
    const admittedAt = (await deliveryAttempt()).admittedAt;
    expect(admittedAt).toBeGreaterThanOrEqual(ack.ackAtMs);
    expect(admittedAt).toBeLessThanOrEqual(ack.ackAtMs + 5_000);
    await expect(deliveryRow).toContainText('Sending…');
    await expect(panel.getByText('Delivery uncertain')).toHaveCount(0);

    await slowWrites.stop();
    writeFileSync(releasePath, 'released');
    await expect
      .poll(
        () =>
          fixtureLog(logPath).some(
            (entry) =>
              entry.type === 'steer_lifecycle' && entry.state === 'started',
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(
      panel.getByText('Claude pressure steer reply: ' + steerText, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(deliveryRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(
        async () =>
          window.evaluate(
            async ({ projectId, worktreeId, chatId }) => {
              const state = await window.api.chat.getState({
                projectId,
                worktreeId,
              });
              return state.runtimeByChatId?.[chatId]?.status;
            },
            {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              chatId: CHAT_ID,
            },
          ),
        { timeout: 30_000 },
      )
      .toBe('completed');
    expect(fixtureLog(logPath).some((entry) => entry.type === 'finished')).toBe(
      true,
    );
    const deliveryUncertainAppeared = await window.evaluate(() => {
      globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_OBSERVER__?.disconnect();
      return globalThis.__CANOPY_CLAUDE_PRESSURE_UNCERTAIN_SEEN__;
    });
    expect(deliveryUncertainAppeared).toBe(false);
  } finally {
    writeFileSync(releasePath, 'released');
    try {
      await slowWrites?.stop();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});
