/** Foreground-first prefetch: intent on a stale chat reads it before the switch. */
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
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);
const PAGE_READS = 'invoke.chat:get-transcript-page';

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

/** Two steps and a completion per chat; each chunk waits for its release. */
function writeScript(runtimeDir, chatId) {
  const gateDir = path.join(runtimeDir, `gate-${chatId}`);
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, 'mode'), 'manual');
  writeFileSync(
    path.join(runtimeDir, `Canopy-C${chatId}.json`),
    JSON.stringify({
      gateDir,
      chunks: [
        agentMessage(`${chatId}-1`, `${chatId} step one`),
        agentMessage(`${chatId}-2`, `${chatId} step two`, 'final_answer'),
        {
          notifications: [
            {
              method: 'turn/completed',
              params: { turn: { status: 'completed', items: [], error: null } },
            },
          ],
        },
      ],
    }),
  );
  return gateDir;
}

async function launch({ chatIds }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-prefetch-'));
  const runtimeDir = path.join(userDataDir, 'codex-fixture');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    path.join(runtimeDir, 'state.json'),
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
  );
  const gates = Object.fromEntries(
    chatIds.map((chatId) => [chatId, writeScript(runtimeDir, chatId)]),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const tab = (id) => ({
    id,
    title: id,
    providerType: 'codex',
    model: 'gpt-6-sol',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    // The background chats are never shown before their turns stream, so
    // they are neither focused nor warm.
    activeTabId: 'foreground',
    tabs: [tab('foreground'), ...chatIds.map(tab)],
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
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(worktreeId);
  await window.evaluate(() => {
    window.__prefetchStateEvents = [];
    window.api.chat.onStateChanged((event) =>
      window.__prefetchStateEvents.push(event),
    );
  });
  const browserWindow = await electronApp.browserWindow(window);
  const webContentsId = await browserWindow.evaluate(
    (win) => win.webContents.id,
  );
  return { electronApp, window, userDataDir, gates, webContentsId };
}

/** Start `chatId`'s turn without selecting its tab; release `chunks` of it. */
async function streamHidden(window, gates, chatId, chunks) {
  const gateDir = gates[chatId];
  await window.evaluate((request) => window.api.chat.sendMessage(request), {
    projectId,
    worktreeId,
    chatId,
    userMessageId: `${chatId}-user-message`,
    text: `Run [Canopy-C${chatId}]`,
    providerType: 'codex',
    model: 'gpt-6-sol',
    approvalMode: 'full_access',
  });
  await expect.poll(() => existsSync(path.join(gateDir, 'started'))).toBe(true);
  for (let index = 0; index < chunks; index += 1) {
    writeFileSync(path.join(gateDir, `release-${index}`), '', 'utf8');
  }
  await expect
    .poll(() => existsSync(path.join(gateDir, `emitted-${chunks - 1}`)))
    .toBe(true);
}

/** Markers main sent for `chatId`: its bodies stayed off IPC. */
function omittedCount(window, chatId) {
  return window.evaluate(
    (id) =>
      window.__prefetchStateEvents
        .flatMap((event) => event.changes)
        .filter(
          (change) =>
            change.chatId === id && change.type === 'messages.omitted',
        ).length,
    chatId,
  );
}

function resetPageReads(electronApp) {
  return electronApp.evaluate(() => {
    globalThis.__CANOPY_WORK_COUNTERS__.reset();
  });
}

function pageReads(electronApp) {
  return electronApp.evaluate(
    (_electron, key) =>
      globalThis.__CANOPY_WORK_COUNTERS__.snapshot().ipc[key] ?? 0,
    PAGE_READS,
  );
}

function warmChats(electronApp, webContentsId) {
  return electronApp.evaluate((_electron, id) => {
    const hook = globalThis.__CANOPY_E2E_CHAT_INTEREST__;
    if (!hook) throw new Error('__CANOPY_E2E_CHAT_INTEREST__ is not installed');
    const entry = hook
      .list()
      .find((candidate) => candidate.webContentsId === id);
    return entry?.interest.warm.map((ref) => ref.chatId) ?? [];
  }, webContentsId);
}

/** Counts frames that paint the transcript loading spinner in `chatId`'s panel. */
async function startSpinnerProbe(window, chatId) {
  await window.evaluate((panelId) => {
    const probe = { frames: 0, stopped: false };
    const sample = () => {
      if (probe.stopped) return;
      const spinner = document.querySelector(
        `[data-testid="panel-content-chat"][data-panel-id="${panelId}"] [data-testid="chat-transcript-loading-spinner"]`,
      );
      if (spinner && spinner.getBoundingClientRect().height > 0)
        probe.frames += 1;
      requestAnimationFrame(sample);
    };
    window.__prefetchSpinnerProbe = probe;
    requestAnimationFrame(sample);
  }, `panel-chat-${chatId}`);
}

function stopSpinnerProbe(window) {
  return window.evaluate(() => {
    const probe = window.__prefetchSpinnerProbe;
    probe.stopped = true;
    return probe.frames;
  });
}

function panel(window, chatId) {
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

function tabHeader(window, chatId) {
  return window.getByTestId(`panel-tab-panel-chat-${chatId}`);
}

test('pointer, keyboard and idle intent read a stale chat once before the switch', async () => {
  test.setTimeout(240_000);
  const { electronApp, window, userDataDir, gates, webContentsId } =
    await launch({ chatIds: ['pointer', 'keyboard', 'idle'] });
  try {
    // --- Pointer: resting on a stale tab reads its newest page -------------
    // Two steps commit and the turn keeps running, so the tab is stale but
    // not unread, and the idle prefetch leaves it alone.
    await streamHidden(window, gates, 'pointer', 2);
    await expect.poll(() => omittedCount(window, 'pointer')).toBeGreaterThan(0);
    await resetPageReads(electronApp);
    await tabHeader(window, 'pointer').hover();
    await expect.poll(() => pageReads(electronApp)).toBe(1);
    expect(await warmChats(electronApp, webContentsId)).toContain('pointer');
    // The prefetch fills the cache only: the foreground chat stays shown.
    await expect(panel(window, 'foreground')).toBeVisible();

    await startSpinnerProbe(window, 'pointer');
    await tabHeader(window, 'pointer').click();
    await expect(
      panel(window, 'pointer').getByText('pointer step two'),
    ).toBeVisible();
    await expect(
      panel(window, 'pointer').getByText('pointer step one'),
    ).toBeVisible();
    expect(await stopSpinnerProbe(window)).toBe(0);
    expect(await pageReads(electronApp)).toBe(1);

    // --- Keyboard: arrowing onto a stale tab reads it at once --------------
    await tabHeader(window, 'foreground').click();
    await streamHidden(window, gates, 'keyboard', 2);
    await expect
      .poll(() => omittedCount(window, 'keyboard'))
      .toBeGreaterThan(0);
    await resetPageReads(electronApp);
    await tabHeader(window, 'foreground').focus();
    // Through the caught-up pointer chat, which needs no read, to the stale one.
    await window.keyboard.press('ArrowRight');
    await expect(tabHeader(window, 'pointer')).toBeFocused();
    await window.keyboard.press('ArrowRight');
    await expect(tabHeader(window, 'keyboard')).toBeFocused();
    await expect.poll(() => pageReads(electronApp)).toBe(1);
    expect(await warmChats(electronApp, webContentsId)).toContain('keyboard');
    await expect(panel(window, 'foreground')).toBeVisible();

    await startSpinnerProbe(window, 'keyboard');
    await window.keyboard.press('Enter');
    await expect(
      panel(window, 'keyboard').getByText('keyboard step two'),
    ).toBeVisible();
    expect(await stopSpinnerProbe(window)).toBe(0);
    expect(await pageReads(electronApp)).toBe(1);

    // --- Idle: a finished background chat is caught up without intent -----
    await resetPageReads(electronApp);
    await streamHidden(window, gates, 'idle', 3);
    await expect
      .poll(() => existsSync(path.join(gates.idle, 'done')))
      .toBe(true);
    await expect(
      tabHeader(window, 'idle').locator('[data-unread]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => pageReads(electronApp)).toBe(1);
    expect(await warmChats(electronApp, webContentsId)).toContain('idle');
    // Reading it changed neither the selection nor its unread state.
    await expect(panel(window, 'keyboard')).toBeVisible();
    await expect(
      tabHeader(window, 'idle').locator('[data-unread]'),
    ).toBeVisible();

    await startSpinnerProbe(window, 'idle');
    await tabHeader(window, 'idle').click();
    await expect(
      panel(window, 'idle').getByText('idle step two'),
    ).toBeVisible();
    expect(await stopSpinnerProbe(window)).toBe(0);
    expect(await pageReads(electronApp)).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
