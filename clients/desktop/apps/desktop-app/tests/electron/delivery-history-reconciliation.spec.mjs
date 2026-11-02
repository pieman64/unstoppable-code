import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { withoutChatSummaryTraffic } from './fixtures/codex-chat-summary-traffic.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 't1';
const CODEX_APP_SERVER_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);
const ROOT_TEXT = 'Begin the held Codex root turn.';
const STEER_TEXT = 'Recover this steered Codex message after restart.';

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function requestsContainingText(logPath, text) {
  return withoutChatSummaryTraffic(readJsonl(logPath))
    .filter(
      (entry) =>
        entry.direction === 'client' &&
        ['turn/start', 'turn/steer'].includes(entry.message?.method) &&
        JSON.stringify(entry.message.params).includes(text),
    )
    .map((entry) => entry.message);
}

async function readChatSnapshot(window) {
  return window.evaluate(
    async ({ workspaceId, worktreeId, chatId }) => {
      const state = await window.api.chat.getState({
        projectId: workspaceId,
        worktreeId,
      });
      return {
        tab: state.tabsFile.tabs.find((candidate) => candidate.id === chatId),
        runtime: state.runtimeByChatId[chatId],
      };
    },
    { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
  );
}

function userMessageCount(tab, text) {
  return (
    tab?.messages?.filter(
      (message) =>
        message.role === 'user' && JSON.stringify(message).includes(text),
    ).length ?? 0
  );
}

async function send(window, text) {
  const composer = window
    .getByTestId('panel-content-chat')
    .getByRole('textbox')
    .last();
  await composer.fill(text);
  await expect
    .poll(async () => {
      const draft = await composer.evaluate((element) => {
        const content = element.cloneNode(true);
        content
          .querySelectorAll('[data-slate-placeholder]')
          .forEach((placeholder) => placeholder.remove());
        return (content.textContent ?? '').replaceAll('\uFEFF', '').trim();
      });
      if (draft !== '') await composer.press('Enter');
      return draft;
    })
    .toBe('');
}

test('Codex rollout history reconciles an accepted steer after a hard restart', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-delivery-history-reconcile-'),
  );
  const protocolLogPath = path.join(userDataDir, 'codex-protocol.jsonl');
  const codexStatePath = path.join(userDataDir, 'codex-state.json');
  const holdRootTurnPath = path.join(userDataDir, 'release-root-turn');
  const canonicalHome = path.join(userDataDir, 'provider-state', 'codex');
  const fixtureEnv = {
    CODEX_EXECUTABLE: CODEX_APP_SERVER_FIXTURE,
    CANOPY_E2E_CODEX_LOG_PATH: protocolLogPath,
    CANOPY_E2E_CODEX_STATE_PATH: codexStatePath,
    CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
    CANOPY_E2E_CODEX_ROLLOUT_HISTORY: '1',
    CANOPY_E2E_CODEX_DROP_STEER_PICKUP: '1',
    CANOPY_E2E_CODEX_HOLD_ROOT_TURN_FILE: holdRootTurnPath,
  };
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Delivery history reconciliation',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  let firstElectronApp;
  let restartedElectronApp;
  try {
    ({ electronApp: firstElectronApp } =
      await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir, env: fixtureEnv }),
      ));
    const firstWindow = await firstElectronApp.firstWindow();
    const firstApp = new CanopyAppDriver(firstWindow);
    await firstApp.waitForShell({ timeout: 30_000 });
    await firstApp.openMainPage();
    await firstApp.selectWorktree(WORKTREE_ID);
    const panel = firstWindow.getByTestId('panel-content-chat');

    await send(firstWindow, ROOT_TEXT);
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await send(firstWindow, STEER_TEXT);
    const queuedBubble = panel
      .getByTestId('queued-message-bubble')
      .filter({ hasText: STEER_TEXT });
    await expect(queuedBubble).toBeVisible({ timeout: 15_000 });
    await queuedBubble
      .getByRole('button', { name: 'Steer', exact: true })
      .click();

    let before;
    await expect
      .poll(
        async () => {
          before = await readChatSnapshot(firstWindow);
          const row = before.tab?.inputDelivery?.rows.find(
            (candidate) => candidate.text === STEER_TEXT,
          );
          return row?.currentAttemptId ?? null;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const beforeRow = before.tab.inputDelivery.rows.find(
      (candidate) => candidate.text === STEER_TEXT,
    );
    const attemptId = beforeRow.currentAttemptId;
    const currentAttempt = beforeRow.attempts.find(
      (attempt) => attempt.id === attemptId,
    );
    expect(currentAttempt).toBeDefined();
    expect(currentAttempt.pickedUpAt).toBeUndefined();

    let rootThreadId;
    await expect
      .poll(
        () => {
          rootThreadId = readJsonl(protocolLogPath).find(
            (entry) =>
              entry.direction === 'client' &&
              entry.message?.method === 'turn/start' &&
              JSON.stringify(entry.message.params?.input).includes(ROOT_TEXT),
          )?.message?.params?.threadId;
          return rootThreadId ?? null;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const rootTurnRequest = readJsonl(protocolLogPath).find(
      (entry) =>
        entry.direction === 'client' &&
        entry.message?.method === 'turn/start' &&
        entry.message?.params?.threadId === rootThreadId &&
        JSON.stringify(entry.message.params?.input).includes(ROOT_TEXT),
    );
    const rootTurnId = readJsonl(protocolLogPath).find(
      (entry) =>
        entry.direction === 'server' &&
        entry.message?.id === rootTurnRequest?.message?.id,
    )?.message?.result?.turn?.id;
    expect(rootTurnId).toEqual(expect.any(String));
    const rolloutPath = path.join(
      canonicalHome,
      'sessions',
      '2026',
      '10',
      '16',
      `rollout-2026-10-16T00-00-00-${rootThreadId}.jsonl`,
    );
    await expect
      .poll(
        () =>
          existsSync(rolloutPath) &&
          readFileSync(rolloutPath, 'utf8').includes(attemptId),
        { timeout: 30_000 },
      )
      .toBe(true);
    const rollout = readJsonl(rolloutPath);
    expect(
      rollout.filter((record) => record.type === 'session_meta'),
    ).toHaveLength(1);
    expect(readFileSync(rolloutPath, 'utf8').endsWith('\n')).toBe(true);
    expect(rollout[0]).toEqual({
      type: 'session_meta',
      payload: { id: rootThreadId },
    });
    expect(
      rollout.some(
        (record) =>
          record.type === 'event_msg' &&
          record.payload?.type === 'task_started' &&
          record.payload.turn_id === rootTurnId,
      ),
    ).toBe(true);
    expect(
      rollout.some(
        (record) =>
          record.type === 'event_msg' &&
          record.payload?.type === 'item_completed' &&
          record.payload.item?.client_id === attemptId,
      ),
    ).toBe(true);
    expect(userMessageCount(before.tab, STEER_TEXT)).toBe(0);
    const pickupNotifications = readJsonl(protocolLogPath).filter(
      (entry) =>
        entry.direction === 'server' &&
        ['item/started', 'item/completed'].includes(entry.message?.method) &&
        [
          entry.message.params?.item?.clientId,
          entry.message.params?.item?.client_id,
        ].includes(attemptId),
    );
    expect(pickupNotifications).toHaveLength(0);
    const requestsBeforeRestart = requestsContainingText(
      protocolLogPath,
      STEER_TEXT,
    );
    expect(requestsBeforeRestart).toHaveLength(1);
    expect(requestsBeforeRestart[0].method).toBe('turn/steer');
    expect(requestsBeforeRestart[0].params.clientUserMessageId).toBe(attemptId);
    const steerRequestId = readJsonl(protocolLogPath).find(
      (entry) =>
        entry.direction === 'client' &&
        entry.message?.method === 'turn/steer' &&
        entry.message?.params?.threadId === rootThreadId &&
        JSON.stringify(entry.message.params).includes(STEER_TEXT),
    )?.message?.id;
    expect(
      readJsonl(protocolLogPath).some(
        (entry) =>
          entry.direction === 'server' &&
          entry.message?.id === steerRequestId &&
          typeof entry.message?.result?.turnId === 'string',
      ),
    ).toBe(true);
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible();

    const mainPid = await firstElectronApp.evaluate(() => process.pid);
    process.kill(mainPid, 'SIGKILL');
    await closeCanopy(firstElectronApp, userDataDir, { keepUserData: true });
    firstElectronApp = null;

    ({ electronApp: restartedElectronApp } =
      await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir, env: fixtureEnv }),
      ));
    const freshWindow = await restartedElectronApp.firstWindow();
    const freshApp = new CanopyAppDriver(freshWindow);
    await freshApp.waitForShell({ timeout: 30_000 });
    await freshApp.openMainPage();
    await freshApp.selectWorktree(WORKTREE_ID);
    const freshPanel = freshWindow.getByTestId('panel-content-chat');

    let after;
    await expect
      .poll(
        async () => {
          after = await readChatSnapshot(freshWindow);
          const row = after.tab?.inputDelivery?.rows.find(
            (candidate) => candidate.id === beforeRow.id,
          );
          const attempt = row?.attempts.find(
            (candidate) => candidate.id === attemptId,
          );
          return (
            row?.state === 'picked-up' && attempt?.pickedUpAt !== undefined
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const afterRow = after.tab.inputDelivery.rows.find(
      (candidate) => candidate.id === beforeRow.id,
    );
    expect(afterRow.currentAttemptId).toBe(attemptId);
    expect(
      afterRow.attempts.find((attempt) => attempt.id === attemptId).pickedUpAt,
    ).toEqual(expect.any(Number));
    await expect(
      freshPanel
        .getByTestId('queued-message-bubble')
        .filter({ hasText: STEER_TEXT }),
    ).toHaveCount(0);
    expect(userMessageCount(after.tab, STEER_TEXT)).toBe(1);
    await expect(freshPanel.getByText(STEER_TEXT, { exact: true })).toHaveCount(
      1,
    );
    expect(requestsContainingText(protocolLogPath, STEER_TEXT)).toHaveLength(
      requestsBeforeRestart.length,
    );
    await expect(freshPanel.getByText(/delivery uncertain/i)).toHaveCount(0);

    // Let the held fake turn drain before normal teardown.
    writeFileSync(holdRootTurnPath, 'release\n', 'utf8');
  } finally {
    writeFileSync(holdRootTurnPath, 'release\n', 'utf8');
    if (restartedElectronApp) {
      await closeCanopy(restartedElectronApp, userDataDir).catch(
        () => undefined,
      );
    } else if (firstElectronApp) {
      await closeCanopy(firstElectronApp, userDataDir).catch(() => undefined);
    }
  }
});
