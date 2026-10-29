// Installed Claude SDK → utility host → routed Code chat → canonical V2
// transcript. The fake CLI emits an ordered burst through real stdout
// backpressure while the first assistant persistence write is held.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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
const LAST_MARKER = `${MARKER}127`;
const FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
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

async function runClaudeFlow({ assertPressure }) {
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
      await expect(panel.getByText(LAST_MARKER, { exact: false })).toHaveCount(
        0,
      );
      if (assertPressure) {
        // This assertion is first so unchanged BEFORE fails on the observed
        // host excess, independent of its missing new route diagnostic IPC.
        // Chat storage group-commits, so stdout keeps arriving during a
        // pending admission up to four forwarding windows
        // (CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES); the window already credited
        // may still land after that.
        expect(host.forwardedBytes).toBeLessThanOrEqual(5 * 64 * 1024 + 4096);
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
    await expect(
      panel.getByText(LAST_MARKER, { exact: false }).first(),
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
      window.getByText(LAST_MARKER, { exact: false }).first(),
    ).toBeVisible({ timeout: 45_000 });
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
  await runClaudeFlow({ assertPressure: true });
});
