// Main-owned watcher delivery regression.
//
// Fired watcher messages are submitted directly to the destination chat queue
// by the main process. These tests use the E2E-only delivery hook instead of a
// synthetic renderer window command or delivery acknowledgements, then verify
// the accepted messages and mocked provider replies survive reloads.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  seedWatchers,
  seedPipelineExecution,
} from './seeders/index.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { delayProviderTranscriptWrites } from './helpers/delayProviderTranscriptWrites.mjs';
import {
  seedCancelledCopiedDelivery,
  seedUncertainWatcherDeliveries,
} from './seeders/uncertainWatcherDelivery.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SECOND_WORKTREE_ID = 'watcher-never-loaded';
const CHAT_ID = 'watcher-delivery-dedup';
const CLAUDE_SCORPION_CHAT_ID = 't1';
const CLAUDE_SCORPION_SESSION_ID = `${WORKSPACE_ID}/${WORKTREE_ID}/${CLAUDE_SCORPION_CHAT_ID}`;
const CLAUDE_SCORPION_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-scorpion-cli.mjs', import.meta.url),
);
const CODEX_APP_SERVER_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
);
const WATCHER_TEXT =
  '[Canopy-CWATCHERDELIVERYDEDUP] Inspect the completed run.';
const WATCHER_REPLY = 'Canopy-CWATCHERDELIVERYDEDUP-REPLY complete.';

const deliverWatcher = (electronApp, delivery) =>
  electronApp.evaluate(
    (_electron, delivery) =>
      globalThis.__CANOPY_E2E_DELIVER_WATCHER_MESSAGE__(delivery),
    delivery,
  );

function readJsonl(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function scorpionUserInputs(entries, text) {
  return entries.filter(
    (entry) =>
      entry.type === 'user' &&
      entry.sessionId === CLAUDE_SCORPION_SESSION_ID &&
      entry.text.includes(text),
  );
}

function codexClientRequests(entries, threadId) {
  return entries
    .filter(
      (entry) =>
        entry.direction === 'client' &&
        entry.message?.params?.threadId === threadId,
    )
    .map((entry) => entry.message);
}

function allCodexClientRequests(entries) {
  return entries
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

function readChatSnapshot(window, chatId) {
  return window.evaluate(
    async ({ projectId, worktreeId, chatId }) => {
      const state = await window.api.chat.getState({ projectId, worktreeId });
      return {
        tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
        runtime: state.runtimeByChatId[chatId],
      };
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId },
  );
}

function createWatcherStartHeldCodexFixture(userDataDir, releasePath) {
  const logPath = path.join(userDataDir, 'watcher-codex-protocol.jsonl');
  const statePath = path.join(userDataDir, 'watcher-codex-state.json');
  const canonicalHome = path.join(userDataDir, 'watcher-codex-home');
  mkdirSync(canonicalHome, { recursive: true });
  return {
    logPath,
    env: {
      CODEX_EXECUTABLE: CODEX_APP_SERVER_FIXTURE,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
      CANOPY_E2E_CODEX_MODE: 'watcher-start-held',
      CANOPY_E2E_CODEX_TURN_START_RELEASE_PATH: releasePath,
      CANOPY_E2E_CODEX_REPLY: 'Watcher start-held Codex reply',
    },
  };
}

function createLateSteerRefusalCodexFixture(
  userDataDir,
  { steerRefusalDelayMs = 35_000, rootTurnDelayMs = 50_000 } = {},
) {
  const logPath = path.join(userDataDir, 'late-steer-codex-protocol.jsonl');
  const statePath = path.join(userDataDir, 'late-steer-codex-state.json');
  const canonicalHome = path.join(userDataDir, 'late-steer-codex-home');
  mkdirSync(canonicalHome, { recursive: true });
  return {
    logPath,
    env: {
      CODEX_EXECUTABLE: CODEX_APP_SERVER_FIXTURE,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
      CANOPY_E2E_CODEX_MODE: 'watcher-steer-late-refusal',
      CANOPY_E2E_CODEX_STEER_REFUSAL_DELAY_MS: String(steerRefusalDelayMs),
      CANOPY_E2E_CODEX_ROOT_TURN_DELAY_MS: String(rootTurnDelayMs),
      CANOPY_E2E_CODEX_REPLY: 'Late steer fixture reply',
    },
  };
}

function createDefaultCodexFixture(userDataDir) {
  const logPath = path.join(
    userDataDir,
    'uncertain-resend-codex-protocol.jsonl',
  );
  const statePath = path.join(userDataDir, 'uncertain-resend-codex-state.json');
  const canonicalHome = path.join(userDataDir, 'uncertain-resend-codex-home');
  mkdirSync(canonicalHome, { recursive: true });
  return {
    logPath,
    env: {
      CODEX_EXECUTABLE: CODEX_APP_SERVER_FIXTURE,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
    },
  };
}

function withinTimeout(promise, timeoutMs, description) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(new Error(`${description} did not resolve in ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

function addSecondWorktree(userDataDir, seed) {
  const repoPath = seed.workspaces[0]?.repoPath;
  if (!repoPath) throw new Error('Expected a seeded source repository');
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const worktreePath = path.join(workspaceDir, 'worktrees', SECOND_WORKTREE_ID);
  execFileSync(
    'git',
    ['worktree', 'add', '-b', SECOND_WORKTREE_ID, worktreePath],
    { cwd: repoPath, stdio: 'pipe' },
  );
  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktrees.worktrees.push({
    id: SECOND_WORKTREE_ID,
    branchName: SECOND_WORKTREE_ID,
    createdAt: '2026-10-12T00:00:00.000Z',
    trackedBaseBranch: 'main',
  });
  writeFileSync(worktreesPath, `${JSON.stringify(worktrees, null, 2)}\n`);
}

function readStoredChat(userDataDir, worktreeId, chatId) {
  try {
    const root = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-v2',
      worktreeId,
    );
    const index = JSON.parse(
      readFileSync(path.join(root, 'live-index.json'), 'utf8'),
    );
    const transcriptPath = path.join(root, 'transcripts', `${chatId}.jsonl`);
    const messages = readFileSync(transcriptPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const activePath = path.join(root, 'transcripts', `${chatId}.active.json`);
    if (existsSync(activePath)) {
      const committedIds = new Set(messages.map((message) => message.id));
      messages.push(
        ...JSON.parse(readFileSync(activePath, 'utf8')).messages.filter(
          (message) => !committedIds.has(message.id),
        ),
      );
    }
    return {
      tab: index.tabs.find((candidate) => candidate.id === chatId),
      runtime: index.runtimeByChatId?.[chatId],
      messages,
    };
  } catch {
    return null;
  }
}

function watcherAndReplyCounts(snapshot, watcherMessageId, reply) {
  const messages = snapshot?.messages ?? [];
  return {
    watcherCount: messages.filter(
      (message) => message.id === watcherMessageId && message.role === 'user',
    ).length,
    replyCount: messages.filter(
      (message) =>
        message.role === 'assistant' && JSON.stringify(message).includes(reply),
    ).length,
  };
}

test('a retried watcher delivery is persisted exactly once', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-delivery-dedup-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Watcher delivery dedup' }],
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    'Canopy-CWATCHERDELIVERYDEDUP',
    {
      llm: { steps: [{ text: WATCHER_REPLY, stopReason: 'end_turn' }] },
    },
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: 'watcher-dedup',
      deliveryId: 'delivery-dedup',
      text: WATCHER_TEXT,
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    const concurrentOutcomes = await Promise.all([
      deliverWatcher(electronApp, delivery),
      deliverWatcher(electronApp, delivery),
    ]);
    expect(concurrentOutcomes).toHaveLength(2);
    expect(concurrentOutcomes).toContain('submitted');
    expect(
      concurrentOutcomes.every((outcome) =>
        ['submitted', 'already_delivered'].includes(outcome),
      ),
    ).toBe(true);

    const storedTab = () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return state.tabsFile.tabs.find((tab) => tab.id === chatId);
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
      );

    await expect(window.getByText(WATCHER_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const firstReloadWatcherMessages = window
      .getByTestId('panel-content-chat')
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_TEXT });
    await expect(firstReloadWatcherMessages).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      firstReloadWatcherMessages.getByTestId('watcher-fired-title'),
    ).toHaveText('Pipeline completion (Deploy) watcher has fired');
    const firstReloadTab = await storedTab();
    const firstReloadWatcher = firstReloadTab.messages.filter(
      (message) => message.id === 'watcher-delivery-dedup',
    );
    expect(firstReloadWatcher).toHaveLength(1);
    expect(firstReloadWatcher[0].watcherFired).toEqual(delivery.watcherFired);
    expect(
      firstReloadTab.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          JSON.stringify(message).includes(WATCHER_REPLY),
      ),
    ).toHaveLength(1);

    expect(await deliverWatcher(electronApp, delivery)).toBe(
      'already_delivered',
    );
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const watcherMessages = window
      .getByTestId('panel-content-chat')
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_TEXT });
    await expect(watcherMessages).toHaveCount(1, { timeout: 30_000 });
    await expect(watcherMessages.getByTestId('watcher-fired-title')).toHaveText(
      'Pipeline completion (Deploy) watcher has fired',
    );
    await expect(
      window
        .getByTestId('panel-content-chat')
        .locator('[data-role="assistant"]')
        .filter({ hasText: WATCHER_REPLY }),
    ).toHaveCount(1, { timeout: 30_000 });
    const finalTab = await storedTab();
    expect(
      finalTab.messages.filter(
        (message) => message.id === 'watcher-delivery-dedup',
      ),
    ).toHaveLength(1);
    expect(
      finalTab.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          JSON.stringify(message).includes(WATCHER_REPLY),
      ),
    ).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a busy chat does not hold up watcher delivery to another chat', async () => {
  test.setTimeout(180_000);
  const busyChatId = 'watcher-delivery-busy';
  const idleChatId = 'watcher-delivery-idle';
  const marker = 'Canopy-CWATCHERHEADOFLINE';
  const busyWatcherMessageId = 'watcher-delivery-busy';
  const idleReply = `${marker}-IDLE-REPLY complete.`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-head-of-line-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: busyChatId,
    tabs: [
      { id: busyChatId, title: 'Busy watcher destination' },
      { id: idleChatId, title: 'Idle watcher destination' },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        { text: 'Unexpected untagged watcher request', stopReason: 'end_turn' },
      ],
      stepsByRequestTag: {
        root: {
          text: 'The root turn is still streaming. '.repeat(30),
          streamMs: 60_000,
          chunkChars: 8,
          stopReason: 'end_turn',
        },
        busy: { text: 'Busy watcher reply', stopReason: 'end_turn' },
        idle: { text: idleReply, stopReason: 'end_turn' },
      },
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const busyPanel = window.getByTestId('panel-content-chat');
    await busyPanel
      .getByRole('textbox')
      .last()
      .fill(`[${marker}] [Canopy-Mock-Request:root] Work on the root task`);
    await busyPanel.getByRole('textbox').last().press('Enter');
    const state = () =>
      window.evaluate(
        async ({ projectId, worktreeId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return {
            busyTab: state.tabsFile.tabs.find(
              (tab) => tab.id === 'watcher-delivery-busy',
            ),
            idleTab: state.tabsFile.tabs.find(
              (tab) => tab.id === 'watcher-delivery-idle',
            ),
            busyRuntime: state.runtimeByChatId['watcher-delivery-busy'],
          };
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    await expect
      .poll(
        async () => (await state()).busyRuntime?.steeringCapabilities?.steer,
      )
      .toBe(true);
    const root = (await state()).busyRuntime.activeTurn.userMessageId;

    const delivery = (chatId, deliveryId, requestTag, text) => ({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      watcherId: `watcher-${deliveryId}`,
      deliveryId,
      text: `[${marker}] [Canopy-Mock-Request:${requestTag}] ${text}`,
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    });
    const busyDelivery = delivery(
      busyChatId,
      'delivery-busy',
      'busy',
      'Busy destination watcher.',
    );
    const idleDelivery = delivery(
      idleChatId,
      'delivery-idle',
      'idle',
      'Idle destination watcher.',
    );
    const outcomes = await Promise.all([
      withinTimeout(
        deliverWatcher(electronApp, busyDelivery),
        5_000,
        'Busy-chat watcher delivery',
      ),
      withinTimeout(
        deliverWatcher(electronApp, idleDelivery),
        5_000,
        'Idle-chat watcher delivery',
      ),
    ]);
    expect(outcomes).toEqual(['submitted', 'submitted']);

    await expect
      .poll(
        () =>
          watcherAndReplyCounts(
            readStoredChat(userDataDir, WORKTREE_ID, idleChatId),
            `watcher-delivery-idle`,
            idleReply,
          ),
        { timeout: 90_000 },
      )
      .toEqual({ watcherCount: 1, replyCount: 1 });
    await window.getByTestId(`panel-tab-panel-chat-${idleChatId}`).click();
    const idlePanel = window.getByTestId('panel-content-chat');
    await expect(idlePanel.getByText(idleReply, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const whileIdleCompletes = await state();
    expect(whileIdleCompletes.busyRuntime.status).toBe('streaming');
    expect(whileIdleCompletes.busyRuntime.activeTurn.userMessageId).toBe(root);
    expect(
      (whileIdleCompletes.busyTab.inputDelivery?.rows ?? []).filter(
        (row) => row.id === busyWatcherMessageId,
      ),
    ).toHaveLength(1);
    expect(
      whileIdleCompletes.busyTab.messages.filter(
        (message) => message.id === busyWatcherMessageId,
      ),
    ).toHaveLength(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('startup recovers a missed pipeline watcher notification exactly once', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-recovery-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Recovered watcher' }],
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'missed-run',
      status: 'success',
      completedAt: '2026-09-01T12:00:00.000Z',
    },
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'missed-watcher',
        createdAt: '2026-09-01T11:00:00.000Z',
        label: 'Recovered pipeline',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          executionId: 'missed-run',
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
        },
        followUpInstruction:
          '[Canopy-CWATCHERRECOVERY] Summarize the recovered result.',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CWATCHERRECOVERY', {
    llm: {
      steps: [
        {
          text: 'Canopy-CWATCHERRECOVERY-REPLY complete.',
          stopReason: 'end_turn',
        },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      window.getByText('Canopy-CWATCHERRECOVERY-REPLY complete.').first(),
    ).toBeVisible({ timeout: 90_000 });
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 30_000,
    });
  } catch (error) {
    for (const relative of [
      'app-advisor-watchers.json',
      'pipeline-executions/missed-run.json',
      'logs/main.log',
    ]) {
      try {
        await testInfo.attach(relative.replaceAll('/', '-'), {
          body: readFileSync(path.join(userDataDir, relative)),
          contentType: 'text/plain',
        });
      } catch {
        /* Missing diagnostics do not replace the assertion. */
      }
    }
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

for (const providerType of ['claude', 'codex']) {
  test(`mid-turn ${providerType} watcher steers once and idle watcher starts a full turn`, async () => {
    test.setTimeout(150_000);
    const marker = `Canopy-CWATCHERSTEER${providerType.toUpperCase()}`;
    const releaseRoot = async () => {
      if (providerType !== 'codex') return;
      const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: marker, name: 'watcher-pending-ui' }),
      });
      expect(response.ok).toBe(true);
    };
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-watcher-steer-'),
    );
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType,
      activeTabId: CHAT_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Watcher steering',
          interfaceMode: 'canopy',
          model: providerType === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
        },
      ],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: 'Unexpected untagged watcher request',
            stopReason: 'end_turn',
          },
        ],
        stepsByRequestTag: {
          root: {
            text: 'Watcher root still active. '.repeat(30),
            streamMs: providerType === 'codex' ? 12_000 : 60_000,
            waitFor:
              providerType === 'codex' ? 'watcher-pending-ui' : undefined,
            barrierTimeoutMs: 120_000,
            chunkChars: 8,
            stopReason: 'end_turn',
          },
          watcher: {
            text: 'Steered watcher reply. '.repeat(20),
            streamMs: 60_000,
            chunkChars: 8,
            stopReason: 'end_turn',
          },
          idle: { text: 'Idle watcher full reply', stopReason: 'end_turn' },
        },
      },
    });
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      await panel
        .getByRole('textbox')
        .last()
        .fill(`[${marker}] [Canopy-Mock-Request:root] Work on the root task`);
      await panel.getByRole('textbox').last().press('Enter');
      const state = () =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return {
              tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
              runtime: state.runtimeByChatId[chatId],
            };
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
        );
      await expect
        .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
        .toBe(true);
      const root = (await state()).runtime.activeTurn.userMessageId;
      const delivery = {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        watcherId: 'watcher-mid-turn',
        deliveryId: 'watcher-mid-turn',
        text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed while working`,
        hiddenContextText:
          '<system_instruction>Use the event as context. Keep working.</system_instruction>',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      };
      expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
      await expect
        .poll(async () => (await state()).tab?.inputDelivery?.rows[0]?.state)
        .toBe('pending');
      const pendingBubble = panel.getByTestId('input-delivery-bubble');
      await expect(pendingBubble.getByRole('status')).toHaveText('Sending…');
      await expect(pendingBubble.getByTestId('watcher-fired-title')).toHaveText(
        'Pipeline completion (Deploy) watcher has fired',
      );
      await expect(pendingBubble).toHaveClass(/(^|\s)bg-info-subtle(\s|$)/);
      const duplicateOutcome = await deliverWatcher(electronApp, delivery);
      expect(['already_delivered', 'submitted']).toContain(duplicateOutcome);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      const admitted = await state();
      expect(admitted.tab.inputDelivery.rows).toHaveLength(1);
      expect(admitted.tab.inputDelivery.rows[0].attempts).toHaveLength(1);
      expect(admitted.tab.inputDelivery.rows[0].payload.watcherFired).toEqual(
        delivery.watcherFired,
      );
      expect(admitted.tab.inputDelivery.rows[0].payload.hiddenContext).toEqual({
        kind: 'canopy-watcher-event',
        text: delivery.hiddenContextText,
      });
      expect(admitted.runtime.activeTurn.userMessageId).toBe(root);
      if (providerType === 'codex') {
        // Hold the model response until the pending UI and receipt checks
        // finish; pickup cannot race a loaded renderer.
        await releaseRoot();
        // turn/steer's response proves admission; pickup follows at the next
        // provider input boundary, after the current model response settles.
        await expect
          .poll(
            async () => (await state()).tab?.inputDelivery?.rows[0]?.state,
            { timeout: 30_000 },
          )
          .toBe('picked-up');
        expect((await state()).runtime.activeTurn.userMessageId).toBe(root);
      }
      await panel.getByTestId('chat-stop-generation').click();
      await expect(composerIdleAction(panel)).toBeVisible();
      if (providerType === 'claude') {
        await expect(panel.getByTestId('input-delivery-row')).toContainText(
          'Cancelled',
        );
      } else {
        const picked = (await state()).tab.messages.find(
          (message) => message.id === 'watcher-watcher-mid-turn',
        );
        expect(picked.watcherFired).toEqual(delivery.watcherFired);
        expect(
          picked.blocks.some(
            (block) => block.type === 'text' && block.steering,
          ),
        ).toBe(true);
      }
      const idleDelivery = {
        ...delivery,
        watcherId: 'watcher-idle',
        deliveryId: 'watcher-idle',
        text: `[${marker}] [Canopy-Mock-Request:idle] Watcher completed after the turn`,
      };
      expect(await deliverWatcher(electronApp, idleDelivery)).toBe('submitted');
      await expect(
        panel.getByText('Idle watcher full reply', { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      expect(await deliverWatcher(electronApp, delivery)).toBe(
        'already_delivered',
      );
      await expect(composerIdleAction(panel)).toBeVisible();
      await expect
        .poll(async () => (await state()).tab?.inputDelivery?.rows.length)
        .toBe(1);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      const final = await state();
      const idle = final.tab.messages.filter(
        (message) => message.id === 'watcher-watcher-idle',
      );
      expect(idle).toHaveLength(1);
      expect(
        idle[0].blocks.some((block) => block.type === 'text' && block.steering),
      ).toBe(false);
      expect(final.tab.inputDelivery.rows[0].attempts).toHaveLength(1);
    } finally {
      await releaseRoot().catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
}

test('Claude watcher delivery waits for init and steers the held root turn once', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-claude-init-gate-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const fakeCliPath = path.join(userDataDir, 'fake-claude-scorpion-cli.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-scorpion.jsonl');
  const initReleasePath = path.join(userDataDir, 'release-root-init');
  copyFileSync(CLAUDE_SCORPION_FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CLAUDE_SCORPION_CHAT_ID,
    tabs: [
      {
        id: CLAUDE_SCORPION_CHAT_ID,
        title: 'Claude watcher init gate',
        providerType: 'claude',
        interfaceMode: 'canopy',
        model: 'claude-sonnet-4-6',
      },
    ],
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CLAUDE_CODE_EXECUTABLE: fakeCliPath,
          CANOPY_CLAUDE_SCORPION_LOG: logPath,
          CANOPY_CLAUDE_SCORPION_HOLD_INIT: '1',
          CANOPY_CLAUDE_SCORPION_INIT_RELEASE: initReleasePath,
          CANOPY_CLAUDE_SCORPION_HOLD_ROOT: '1',
        },
      }),
    ));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    let panel = window.getByTestId('panel-content-chat');
    const entries = () => readJsonl(logPath);
    const state = () => readChatSnapshot(window, CLAUDE_SCORPION_CHAT_ID);
    const rootPrompt = '[Canopy-CWATCHERCLAUDEINITGATE] Work on the root task.';
    await panel.getByRole('textbox').last().fill(rootPrompt);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(() => entries().some((entry) => entry.type === 'root_init_held'), {
        timeout: 60_000,
      })
      .toBe(true);
    expect(scorpionUserInputs(entries(), rootPrompt)).toHaveLength(1);

    const deliveryId = 'claude-init-gate';
    const watcherMessageId = `watcher-${deliveryId}`;
    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CLAUDE_SCORPION_CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: '[Canopy-CWATCHERCLAUDEINITGATE] Watcher completed while initializing.',
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    const queuedBubble = panel.getByTestId('queued-message-bubble');
    await expect(queuedBubble).toHaveCount(1, { timeout: 30_000 });
    await expect(queuedBubble).toContainText(delivery.text, {
      timeout: 30_000,
    });
    await expect(queuedBubble.getByTestId('queued-message-steer')).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    // Compact rows omit the bubble's standalone waiting reason. The held
    // runtime cannot steer yet, matching the absent Steer action above.
    const waitingState = await state();
    expect(waitingState.runtime).toBeDefined();
    expect(waitingState.runtime.steeringCapabilities?.steer).not.toBe(true);
    const beforeRelease = entries();
    expect(scorpionUserInputs(beforeRelease, delivery.text)).toHaveLength(0);
    expect(
      beforeRelease.filter((entry) => entry.type === 'steer_lifecycle'),
    ).toHaveLength(0);
    expect(
      beforeRelease.filter(
        (entry) =>
          entry.type === 'control_request' && entry.subtype === 'interrupt',
      ),
    ).toHaveLength(0);
    expect(
      beforeRelease.filter((entry) => entry.type === 'root_result'),
    ).toHaveLength(0);

    writeFileSync(initReleasePath, 'release\n');
    await expect
      .poll(() => entries().some((entry) => entry.type === 'root_held'), {
        timeout: 60_000,
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          entries().some(
            (entry) => entry.type === 'root_result' && entry.reason === 'steer',
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    const completedEntries = entries();
    const rootHeldIndex = completedEntries.findIndex(
      (entry) => entry.type === 'root_held',
    );
    const rootResultIndex = completedEntries.findIndex(
      (entry) => entry.type === 'root_result' && entry.reason === 'steer',
    );
    const steeredInputs = scorpionUserInputs(completedEntries, delivery.text);
    expect(rootHeldIndex).toBeGreaterThanOrEqual(0);
    expect(rootResultIndex).toBeGreaterThan(rootHeldIndex);
    expect(steeredInputs).toHaveLength(1);
    expect(steeredInputs[0].rootTurnRunning).toBe(true);
    expect(
      completedEntries.filter((entry) => entry.type === 'steer_lifecycle'),
    ).toHaveLength(1);
    expect(
      completedEntries.filter(
        (entry) =>
          entry.type === 'control_request' && entry.subtype === 'interrupt',
      ),
    ).toHaveLength(0);
    await expect(queuedBubble).toHaveCount(0, { timeout: 30_000 });
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });

    const completed = await state();
    const rows = completed.tab.inputDelivery.rows.filter(
      (row) => row.id === watcherMessageId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('picked-up');
    expect(rows[0].attempts).toHaveLength(1);
    const watcherMessages = completed.tab.messages.filter(
      (message) => message.id === watcherMessageId,
    );
    expect(watcherMessages).toHaveLength(1);
    expect(watcherMessages[0].watcherFired).toEqual(delivery.watcherFired);
    expect(
      watcherMessages[0].blocks.some(
        (block) => block.type === 'text' && block.steering,
      ),
    ).toBe(true);

    expect(await deliverWatcher(electronApp, delivery)).toBe(
      'already_delivered',
    );
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    panel = window.getByTestId('panel-content-chat');
    const reloadedWatcher = panel
      .locator('[data-role="user"]')
      .filter({ hasText: delivery.text });
    await expect(reloadedWatcher).toHaveCount(1, { timeout: 30_000 });
    await expect(reloadedWatcher.getByTestId('watcher-fired-title')).toHaveText(
      'Pipeline completion (Deploy) watcher has fired',
    );
    const reloaded = await state();
    const reloadedRows = reloaded.tab.inputDelivery.rows.filter(
      (row) => row.id === watcherMessageId,
    );
    expect(reloadedRows).toHaveLength(1);
    expect(reloadedRows[0].state).toBe('picked-up');
    expect(
      reloaded.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    const canonical = readStoredChat(
      userDataDir,
      WORKTREE_ID,
      CLAUDE_SCORPION_CHAT_ID,
    );
    expect(canonical?.tab).toBeDefined();
    expect(
      canonical?.tab?.inputDelivery?.rows.filter(
        (row) => row.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expect(
      canonical?.messages.filter((message) => message.id === watcherMessageId),
    ).toHaveLength(1);
    expect(scorpionUserInputs(entries(), delivery.text)).toHaveLength(1);
    expect(
      entries().filter((entry) => entry.type === 'steer_lifecycle'),
    ).toHaveLength(1);
    expect(
      entries().filter(
        (entry) =>
          entry.type === 'control_request' && entry.subtype === 'interrupt',
      ),
    ).toHaveLength(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('Codex watcher delivery waits for turn start and steers the held root turn once', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-codex-start-gate-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const releasePath = path.join(userDataDir, 'release-codex-turn-start');
  const fixture = createWatcherStartHeldCodexFixture(userDataDir, releasePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Codex watcher turn-start gate',
        interfaceMode: 'canopy',
        model: 'gpt-5.5',
      },
    ],
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: fixture.env }),
    ));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    let panel = window.getByTestId('panel-content-chat');
    const entries = () => readJsonl(fixture.logPath);
    const state = () => readChatSnapshot(window, CHAT_ID);
    const rootPrompt = '[Canopy-CWATCHERCODEXSTARTGATE] Work on the root task.';
    await panel.getByRole('textbox').last().fill(rootPrompt);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(
        () => entries().some((entry) => entry.direction === 'turn-start-held'),
        { timeout: 60_000 },
      )
      .toBe(true);
    const held = entries().find(
      (entry) => entry.direction === 'turn-start-held',
    );
    expect(held).toEqual(
      expect.objectContaining({
        direction: 'turn-start-held',
        threadId: expect.any(String),
        turnId: expect.any(String),
      }),
    );
    const initialRootRequests = codexClientRequests(entries(), held.threadId);
    const rootStarts = initialRootRequests.filter(
      (request) => request.method === 'turn/start',
    );
    expect(rootStarts).toHaveLength(1);
    expect(JSON.stringify(rootStarts[0].params.input)).toContain(rootPrompt);

    const deliveryId = 'codex-start-gate';
    const watcherMessageId = `watcher-${deliveryId}`;
    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: '[Canopy-CWATCHERCODEXSTARTGATE] Watcher completed while starting.',
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    const queuedBubble = panel.getByTestId('queued-message-bubble');
    await expect(queuedBubble).toHaveCount(1, { timeout: 30_000 });
    await expect(queuedBubble).toContainText(delivery.text, {
      timeout: 30_000,
    });
    await expect(queuedBubble.getByTestId('queued-message-steer')).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    // Compact rows omit the bubble's standalone waiting reason. The held
    // runtime cannot steer yet, matching the absent Steer action above.
    const waitingState = await state();
    expect(waitingState.runtime).toBeDefined();
    expect(waitingState.runtime.steeringCapabilities?.steer).not.toBe(true);
    const beforeReleaseRequests = allCodexClientRequests(entries());
    expect(
      beforeReleaseRequests.filter(
        (request) =>
          ['turn/start', 'turn/steer'].includes(request.method) &&
          JSON.stringify(request.params.input).includes(delivery.text),
      ),
    ).toHaveLength(0);
    expect(
      beforeReleaseRequests.filter(
        (request) => request.method === 'turn/steer',
      ),
    ).toHaveLength(0);
    expect(
      beforeReleaseRequests.filter(
        (request) => request.method === 'turn/interrupt',
      ),
    ).toHaveLength(0);

    writeFileSync(releasePath, 'release\n');
    await expect
      .poll(
        () =>
          entries().some(
            (entry) =>
              entry.direction === 'turn-start-released' &&
              entry.threadId === held.threadId &&
              entry.turnId === held.turnId,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          entries().some(
            (entry) =>
              entry.direction === 'server' &&
              entry.message?.method === 'turn/started' &&
              entry.message.params?.threadId === held.threadId &&
              entry.message.params?.turn?.id === held.turnId,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          codexClientRequests(entries(), held.threadId).filter(
            (request) => request.method === 'turn/steer',
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    await expect(queuedBubble).toHaveCount(0, { timeout: 30_000 });

    const steeredRequests = codexClientRequests(
      entries(),
      held.threadId,
    ).filter((request) => request.method === 'turn/steer');
    expect(steeredRequests).toHaveLength(1);
    expect(steeredRequests[0].params.expectedTurnId).toBe(held.turnId);
    expect(JSON.stringify(steeredRequests[0].params.input)).toContain(
      delivery.text,
    );
    const watcherProviderInputs = allCodexClientRequests(entries())
      .filter((request) =>
        ['turn/start', 'turn/steer'].includes(request.method),
      )
      .filter((request) =>
        JSON.stringify(request.params.input).includes(delivery.text),
      );
    expect(watcherProviderInputs).toHaveLength(1);
    expect(watcherProviderInputs[0].method).toBe('turn/steer');
    expect(
      codexClientRequests(entries(), held.threadId).filter(
        (request) => request.method === 'turn/start',
      ),
    ).toHaveLength(1);
    expect(
      codexClientRequests(entries(), held.threadId).filter(
        (request) => request.method === 'turn/interrupt',
      ),
    ).toHaveLength(0);

    await expect(
      panel.getByText('Watcher start-held Codex reply', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await state()).tab.inputDelivery.rows.find(
            (row) => row.id === watcherMessageId,
          )?.state,
        { timeout: 60_000 },
      )
      .toBe('picked-up');
    await expect
      .poll(
        async () =>
          (await state()).tab.messages.filter(
            (message) => message.id === watcherMessageId,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    const completed = await state();
    const watcherRows = completed.tab.inputDelivery.rows.filter(
      (row) => row.id === watcherMessageId,
    );
    expect(watcherRows).toHaveLength(1);
    expect(watcherRows[0].attempts).toHaveLength(1);
    expect(steeredRequests[0].params.clientUserMessageId).toBe(
      watcherRows[0].attempts[0].id,
    );
    const watcherMessages = completed.tab.messages.filter(
      (message) => message.id === watcherMessageId,
    );
    expect(watcherMessages).toHaveLength(1);
    expect(watcherMessages[0].watcherFired).toEqual(delivery.watcherFired);
    expect(
      watcherMessages[0].blocks.some(
        (block) => block.type === 'text' && block.steering,
      ),
    ).toBe(true);

    expect(await deliverWatcher(electronApp, delivery)).toBe(
      'already_delivered',
    );
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    panel = window.getByTestId('panel-content-chat');
    const reloadedWatcher = panel
      .locator('[data-role="user"]')
      .filter({ hasText: delivery.text });
    await expect(reloadedWatcher).toHaveCount(1, { timeout: 30_000 });
    await expect(reloadedWatcher.getByTestId('watcher-fired-title')).toHaveText(
      'Pipeline completion (Deploy) watcher has fired',
    );
    const reloaded = await state();
    const reloadedRows = reloaded.tab.inputDelivery.rows.filter(
      (row) => row.id === watcherMessageId,
    );
    expect(reloadedRows).toHaveLength(1);
    expect(reloadedRows[0].state).toBe('picked-up');
    expect(
      reloaded.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    const canonical = readStoredChat(userDataDir, WORKTREE_ID, CHAT_ID);
    expect(canonical?.tab).toBeDefined();
    expect(
      canonical?.tab?.inputDelivery?.rows.filter(
        (row) => row.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expect(
      canonical?.messages.filter((message) => message.id === watcherMessageId),
    ).toHaveLength(1);
    expect(
      codexClientRequests(entries(), held.threadId).filter(
        (request) => request.method === 'turn/steer',
      ),
    ).toHaveLength(1);
    const finalRequests = allCodexClientRequests(entries());
    expect(
      codexClientRequests(entries(), held.threadId).filter(
        (request) => request.method === 'turn/start',
      ),
    ).toHaveLength(1);
    expect(
      finalRequests
        .filter((request) =>
          ['turn/start', 'turn/steer'].includes(request.method),
        )
        .filter((request) =>
          JSON.stringify(request.params.input ?? []).includes(delivery.text),
        ),
    ).toHaveLength(1);
    expect(
      finalRequests.filter((request) => request.method === 'turn/interrupt'),
    ).toHaveLength(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('refused codex watcher steer is queued and sent once as a full turn', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CWATCHERREFUSEDSTEER';
  const deliveryId = 'watcher-refused-steer';
  const watcherMessageId = `watcher-${deliveryId}`;
  const watcherReply = 'Refused watcher full reply';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-refused-steer-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Refused watcher steering',
        interfaceMode: 'canopy',
        model: 'gpt-5.5',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: 'Unexpected untagged watcher request',
          stopReason: 'end_turn',
        },
      ],
      stepsByRequestTag: {
        root: {
          text: 'Watcher root still active. '.repeat(30),
          streamMs: 12_000,
          chunkChars: 8,
          stopReason: 'end_turn',
        },
        watcher: { text: watcherReply, stopReason: 'end_turn' },
      },
    },
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CODEX_STALE_STEER_TURN_ID:
            '01a00000-0000-7000-8000-000000000000',
        },
      }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const state = () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return {
            tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
            runtime: state.runtimeByChatId[chatId],
          };
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
      );

    await panel
      .getByRole('textbox')
      .last()
      .fill(`[${marker}] [Canopy-Mock-Request:root] Work on the root task`);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
      .toBe(true);
    const root = (await state()).runtime.activeTurn.userMessageId;
    await window.evaluate(() => {
      globalThis.__watcherUncertainRendered = false;
      const inspectChatPanel = () => {
        if (
          document
            .querySelector('[data-testid="panel-content-chat"]')
            ?.textContent?.includes('Delivery uncertain')
        ) {
          globalThis.__watcherUncertainRendered = true;
        }
      };
      const observer = new MutationObserver(inspectChatPanel);
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      globalThis.__watcherUncertainObserver = observer;
      inspectChatPanel();
    });
    const expectNoUncertainUi = async () => {
      await expect(
        panel.getByText('Delivery uncertain', { exact: true }),
      ).toHaveCount(0);
      expect(
        await window.evaluate(
          () => globalThis.__watcherUncertainRendered === true,
        ),
      ).toBe(false);
    };

    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed while working`,
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    const deliveryRow = async () =>
      (await state()).tab?.inputDelivery?.rows.find(
        (row) => row.id === watcherMessageId,
      );
    const expectNoUncertainAttempt = (row) => {
      expect(row).toBeDefined();
      expect(row.state).not.toBe('uncertain');
      expect(
        row.attempts.every((attempt) => attempt.uncertainAt === undefined),
      ).toBe(true);
    };

    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    await expect
      .poll(async () => {
        const row = await deliveryRow();
        return Boolean(
          row?.attempts.length &&
          row.reason?.includes('Falling back to ordinary delivery.'),
        );
      })
      .toBe(true);
    const refused = await state();
    const refusedRow = refused.tab.inputDelivery.rows.find(
      (row) => row.id === watcherMessageId,
    );
    expect(refusedRow.attempts.length).toBeGreaterThan(0);
    expect(refusedRow.reason).toContain('Falling back to ordinary delivery.');
    expectNoUncertainAttempt(refusedRow);
    expect(refused.runtime.activeTurn.userMessageId).toBe(root);
    const queuedBubbles = panel.getByTestId('queued-message-bubble');
    await expect(queuedBubbles).toHaveCount(1);
    await expect(queuedBubbles).toContainText(delivery.text);
    await expectNoUncertainUi();

    const duplicateOutcome = await deliverWatcher(electronApp, delivery);
    expect(['already_delivered', 'submitted']).toContain(duplicateOutcome);
    const queuedRetry = await state();
    expect(queuedRetry.tab.inputDelivery.rows).toHaveLength(1);
    expect(
      queuedRetry.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(0);
    await expect(queuedBubbles).toHaveCount(1);
    await expectNoUncertainUi();
    expect(queuedRetry.runtime.activeTurn.userMessageId).toBe(root);

    // Do not stop the root turn: the restored watcher should start ordinarily
    // only after Codex completes this active response by itself.
    await expect
      .poll(
        async () => (await state()).runtime?.activeTurn?.userMessageId !== root,
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(panel.getByText(watcherReply, { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    const completed = await state();
    const watcherMessages = completed.tab.messages.filter(
      (message) => message.id === watcherMessageId,
    );
    expect(watcherMessages).toHaveLength(1);
    expect(watcherMessages[0].watcherFired).toEqual(delivery.watcherFired);
    expect(
      watcherMessages[0].blocks.some(
        (block) => block.type === 'text' && block.steering === true,
      ),
    ).toBe(false);
    await expect(panel.getByText(watcherReply, { exact: true })).toHaveCount(1);
    expectNoUncertainAttempt(
      completed.tab.inputDelivery.rows.find(
        (row) => row.id === watcherMessageId,
      ),
    );
    await expectNoUncertainUi();

    expect(await deliverWatcher(electronApp, delivery)).toBe(
      'already_delivered',
    );
    const redelivered = await state();
    expect(redelivered.tab.inputDelivery.rows).toHaveLength(1);
    expect(
      redelivered.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expectNoUncertainAttempt(
      redelivered.tab.inputDelivery.rows.find(
        (row) => row.id === watcherMessageId,
      ),
    );
    await expect(queuedBubbles).toHaveCount(0);
    await expect(panel.getByText(watcherReply, { exact: true })).toHaveCount(1);
    await expectNoUncertainUi();
    await window.evaluate(() =>
      globalThis.__watcherUncertainObserver?.disconnect(),
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('late refused codex watcher steer is sent once as a full turn', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CWATCHERLATESTEER';
  const deliveryId = 'watcher-late-steer-refusal';
  const watcherMessageId = `watcher-${deliveryId}`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-late-steer-refusal-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const fixture = createLateSteerRefusalCodexFixture(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Late refused watcher steering',
        interfaceMode: 'canopy',
        model: 'gpt-5.5',
      },
    ],
  });

  let electronApp;
  let window;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: fixture.env }),
    ));
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const state = () => readChatSnapshot(window, CHAT_ID);
    const entries = () => readJsonl(fixture.logPath);
    const requests = () => allCodexClientRequests(entries());
    const rootPrompt = `[${marker}] [Canopy-Mock-Request:root] Work on the root task`;

    await window.evaluate(() => {
      globalThis.__watcherLateSteerUncertainRendered = false;
      const inspectChatPanel = () => {
        if (
          document
            .querySelector('[data-testid="panel-content-chat"]')
            ?.textContent?.includes('Delivery uncertain')
        ) {
          globalThis.__watcherLateSteerUncertainRendered = true;
        }
      };
      const observer = new MutationObserver(inspectChatPanel);
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      globalThis.__watcherLateSteerUncertainObserver = observer;
      inspectChatPanel();
    });
    const expectNoUncertainUi = async () => {
      await expect(
        panel.getByText('Delivery uncertain', { exact: true }),
      ).toHaveCount(0);
      expect(
        await window.evaluate(
          () => globalThis.__watcherLateSteerUncertainRendered === true,
        ),
      ).toBe(false);
    };

    await panel.getByRole('textbox').last().fill(rootPrompt);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
      .toBe(true);
    const root = (await state()).runtime.activeTurn.userMessageId;
    await expect
      .poll(() =>
        requests().some(
          (request) =>
            request.method === 'turn/start' &&
            JSON.stringify(request.params.input ?? []).includes(rootPrompt),
        ),
      )
      .toBe(true);
    const rootRequest = requests().find(
      (request) =>
        request.method === 'turn/start' &&
        JSON.stringify(request.params.input ?? []).includes(rootPrompt),
    );
    expect(rootRequest?.params.threadId).toEqual(expect.any(String));

    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed while working`,
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    const deliveryRow = async () =>
      (await state()).tab?.inputDelivery?.rows.find(
        (row) => row.id === watcherMessageId,
      );

    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    await expect
      .poll(() =>
        requests().some(
          (request) =>
            request.method === 'turn/steer' &&
            JSON.stringify(request.params.input ?? []).includes(delivery.text),
        ),
      )
      .toBe(true);
    const steerLogEntry = entries().find(
      (entry) =>
        entry.direction === 'client' &&
        entry.message?.method === 'turn/steer' &&
        JSON.stringify(entry.message.params?.input ?? []).includes(
          delivery.text,
        ),
    );
    expect(steerLogEntry?.timestamp).toEqual(expect.any(Number));

    // The app-server has no E2E request-timeout override: its default steer
    // deadline is 30 seconds, while this fixture refuses after 35 seconds.
    await expect
      .poll(() => Date.now() - steerLogEntry.timestamp >= 30_500, {
        timeout: 40_000,
        interval: 100,
      })
      .toBe(true);
    // A submit that timed out returns pending; both states read "Sending…".
    expect(['sending', 'pending']).toContain((await deliveryRow())?.state);
    await expect(panel.getByTestId('input-delivery-row')).toContainText(
      'Sending…',
    );
    await expectNoUncertainUi();

    await expect
      .poll(() =>
        entries().some(
          (entry) => entry.direction === 'turn-steer-refusal-replied',
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await deliveryRow())?.reason?.includes(
          'Falling back to ordinary delivery.',
        ),
      )
      .toBe(true);
    expect((await state()).runtime.activeTurn.userMessageId).toBe(root);
    await expectNoUncertainUi();

    await expect
      .poll(
        async () => (await state()).runtime?.activeTurn?.userMessageId !== root,
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => {
        const watcherRequests = requests().filter(
          (request) =>
            ['turn/start', 'turn/steer'].includes(request.method) &&
            JSON.stringify(request.params.input ?? []).includes(delivery.text),
        );
        return {
          steerCount: watcherRequests.filter(
            (request) => request.method === 'turn/steer',
          ).length,
          fullTurnCount: watcherRequests.filter(
            (request) => request.method === 'turn/start',
          ).length,
        };
      })
      .toEqual({ steerCount: 1, fullTurnCount: 1 });

    const fullTurnRequest = requests().find(
      (request) =>
        request.method === 'turn/start' &&
        JSON.stringify(request.params.input ?? []).includes(delivery.text),
    );
    expect(fullTurnRequest?.params.threadId).toBe(rootRequest.params.threadId);
    await expect
      .poll(async () => {
        const snapshot = await state();
        return snapshot.tab?.messages.filter(
          (message) => message.id === watcherMessageId,
        ).length;
      })
      .toBe(1);
    const completed = await state();
    expect(
      completed.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expect(
      completed.tab.inputDelivery.rows.filter(
        (row) => row.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    await expectNoUncertainUi();
    await window.evaluate(() =>
      globalThis.__watcherLateSteerUncertainObserver?.disconnect(),
    );
  } finally {
    if (window) {
      await window
        .evaluate(() =>
          globalThis.__watcherLateSteerUncertainObserver?.disconnect(),
        )
        .catch(() => undefined);
    }
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('Codex watcher fired after turn completion while transcript writes are held starts one full turn', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CWATCHERCOMMITPRESSURE';
  const deliveryId = 'watcher-commit-pressure';
  const watcherMessageId = `watcher-${deliveryId}`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-commit-pressure-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const fixture = createLateSteerRefusalCodexFixture(userDataDir, {
    rootTurnDelayMs: 1_000,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Codex watcher transcript pressure',
        interfaceMode: 'canopy',
        model: 'gpt-5.5',
      },
    ],
  });

  let electronApp;
  let window;
  let slowWrites;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: fixture.env }),
    ));
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const state = () => readChatSnapshot(window, CHAT_ID);
    const entries = () => readJsonl(fixture.logPath);
    const requests = () => allCodexClientRequests(entries());

    await window.evaluate(() => {
      globalThis.__watcherCommitPressureUncertainRendered = false;
      const inspectChatPanel = () => {
        if (
          document
            .querySelector('[data-testid="panel-content-chat"]')
            ?.textContent?.includes('Delivery uncertain')
        ) {
          globalThis.__watcherCommitPressureUncertainRendered = true;
        }
      };
      const observer = new MutationObserver(inspectChatPanel);
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      globalThis.__watcherCommitPressureUncertainObserver = observer;
      inspectChatPanel();
    });
    const expectNoUncertainUi = async () => {
      await expect(
        panel.getByText('Delivery uncertain', { exact: true }),
      ).toHaveCount(0);
      expect(
        await window.evaluate(
          () => globalThis.__watcherCommitPressureUncertainRendered === true,
        ),
      ).toBe(false);
    };

    slowWrites = await delayProviderTranscriptWrites(electronApp, {
      userDataDir,
      workspaceId: WORKSPACE_ID,
      scopeId: WORKTREE_ID,
      delayMs: 8_000,
    });
    const rootPrompt = `[${marker}] [Canopy-Mock-Request:root] Work on the root task`;
    await panel.getByRole('textbox').last().fill(rootPrompt);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
      .toBe(true);
    const root = (await state()).runtime.activeTurn.userMessageId;
    await expect
      .poll(() =>
        requests().some(
          (request) =>
            request.method === 'turn/start' &&
            JSON.stringify(request.params.input ?? []).includes(rootPrompt),
        ),
      )
      .toBe(true);
    const rootRequest = requests().find(
      (request) =>
        request.method === 'turn/start' &&
        JSON.stringify(request.params.input ?? []).includes(rootPrompt),
    );
    expect(rootRequest?.params.threadId).toEqual(expect.any(String));
    const rootTurnStarted = () =>
      entries().find(
        (entry) =>
          entry.direction === 'server' &&
          entry.message?.method === 'turn/started' &&
          entry.message.params?.threadId === rootRequest.params.threadId,
      );
    await expect.poll(rootTurnStarted).toBeDefined();
    const rootTurnId = rootTurnStarted().message.params.turn.id;
    const rootCompletion = () =>
      entries().find(
        (entry) =>
          entry.direction === 'server' &&
          entry.message?.method === 'turn/completed' &&
          entry.message.params?.threadId === rootRequest.params.threadId &&
          entry.message.params?.turn?.id === rootTurnId,
      );
    await expect.poll(rootCompletion, { timeout: 30_000 }).toBeDefined();
    await expect
      .poll(() => slowWrites.pendingCount(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // The server has ended this short turn while its transcript commits are
    // still held in the desktop process: the watcher fires at that boundary.
    // The phase the desktop reports here is an implementation detail; record
    // it, then check only the outcome.
    const boundary = (await state()).runtime;
    test.info().annotations.push({
      type: 'runtime-at-boundary',
      description: JSON.stringify({
        status: boundary?.status,
        activeTurnIsRoot: boundary?.activeTurn?.userMessageId === root,
      }),
    });
    await expectNoUncertainUi();

    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed as transcript catches up`,
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    const isWatcherRequest = (message) =>
      JSON.stringify(message?.params?.input ?? []).includes(delivery.text);
    const watcherCounts = () => {
      const sent = requests().filter(isWatcherRequest);
      return {
        turnStartCount: sent.filter(
          (request) => request.method === 'turn/start',
        ).length,
        turnSteerCount: sent.filter(
          (request) => request.method === 'turn/steer',
        ).length,
      };
    };
    await expectNoUncertainUi();
    expect(watcherCounts().turnStartCount).toBeLessThanOrEqual(1);

    await slowWrites.stop();
    // This fake never accepts a steer, so a steer sent at the boundary must
    // end refused before the payload starts its one full turn.
    await expect
      .poll(watcherCounts, { timeout: 90_000 })
      .toMatchObject({ turnStartCount: 1 });
    const { turnSteerCount } = watcherCounts();
    expect(turnSteerCount).toBeLessThanOrEqual(1);
    if (turnSteerCount === 1) {
      const log = entries();
      const refusalIndex = log.findIndex(
        (entry) => entry.direction === 'turn-steer-refusal-replied',
      );
      const startIndex = log.findIndex(
        (entry) =>
          entry.direction === 'client' &&
          entry.message?.method === 'turn/start' &&
          isWatcherRequest(entry.message),
      );
      expect(refusalIndex).toBeGreaterThanOrEqual(0);
      expect(startIndex).toBeGreaterThan(refusalIndex);
    }
    // One reply for the root turn and one for the watcher's turn.
    await expect(
      panel.getByText('Late steer fixture reply', { exact: true }),
    ).toHaveCount(2, { timeout: 30_000 });
    await expect(panel.getByTestId('input-delivery-row')).toHaveCount(0, {
      timeout: 30_000,
    });
    const completed = await state();
    expect(
      completed.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expect(
      (completed.tab.inputDelivery?.rows ?? []).filter(
        (row) => row.id === watcherMessageId,
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(watcherCounts()).toEqual({
      turnStartCount: 1,
      turnSteerCount,
    });
    await expectNoUncertainUi();
    await window.evaluate(() =>
      globalThis.__watcherCommitPressureUncertainObserver?.disconnect(),
    );
  } finally {
    if (window) {
      await window
        .evaluate(() =>
          globalThis.__watcherCommitPressureUncertainObserver?.disconnect(),
        )
        .catch(() => undefined);
    }
    try {
      await slowWrites?.stop();
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  }
});

test('watcher delivery reaches a chat in a worktree never loaded by the window', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-never-loaded-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  addSecondWorktree(userDataDir, demo);
  const chatId = 'never-loaded-watcher-chat';
  const deliveryId = 'delivery-never-loaded';
  const watcherMessageId = `watcher-${deliveryId}`;
  const marker = 'Canopy-CWATCHERNEVERLOADED';
  const text = `[${marker}] Inspect the result in the unloaded worktree.`;
  const reply = `${marker}-REPLY complete.`;
  const watcherFired = { kind: 'Pipeline completion (Deploy)' };
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: SECOND_WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Never-loaded watcher destination' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // The second worktree has never been selected or loaded in this renderer.
    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: SECOND_WORKTREE_ID,
      chatId,
      watcherId: 'watcher-never-loaded',
      deliveryId,
      text,
      watcherFired,
    };
    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    await expect
      .poll(
        () =>
          watcherAndReplyCounts(
            readStoredChat(userDataDir, SECOND_WORKTREE_ID, chatId),
            watcherMessageId,
            reply,
          ),
        { timeout: 90_000 },
      )
      .toEqual({ watcherCount: 1, replyCount: 1 });

    await app.selectWorktree(SECOND_WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const watcherBubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: text });
    await expect(watcherBubble).toHaveCount(1, { timeout: 30_000 });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      'Pipeline completion (Deploy) watcher has fired',
    );
    await expect(
      panel.locator('[data-role="assistant"]').filter({ hasText: reply }),
    ).toHaveCount(1);

    expect(await deliverWatcher(electronApp, delivery)).toBe(
      'already_delivered',
    );
    await expect(watcherBubble).toHaveCount(1);
    await expect(
      panel.locator('[data-role="assistant"]').filter({ hasText: reply }),
    ).toHaveCount(1);
    expect(
      watcherAndReplyCounts(
        readStoredChat(userDataDir, SECOND_WORKTREE_ID, chatId),
        watcherMessageId,
        reply,
      ),
    ).toEqual({ watcherCount: 1, replyCount: 1 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('watcher delivery continues while the main window is closed', async () => {
  // This lifecycle is macOS-specific: the app stays alive after its only
  // BrowserWindow closes, so main can accept and complete queue work headlessly.
  test.skip(
    process.platform !== 'darwin',
    'Only macOS keeps the Electron main process alive after its last window closes.',
  );
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-closed-window-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const chatId = 'closed-window-watcher-chat';
  const deliveryId = 'delivery-closed-window';
  const watcherMessageId = `watcher-${deliveryId}`;
  const marker = 'Canopy-CWATCHERCLOSEDWINDOW';
  const text = `[${marker}] Finish the task while no window is open.`;
  const reply = `${marker}-REPLY complete.`;
  const watcherFired = { kind: 'Pipeline completion (Deploy)' };
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Closed-window watcher destination' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.close();

    const delivery = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      watcherId: 'watcher-closed-window',
      deliveryId,
      text,
      watcherFired,
    };
    expect(await deliverWatcher(electronApp, delivery)).toBe('submitted');
    await expect
      .poll(
        () =>
          watcherAndReplyCounts(
            readStoredChat(userDataDir, WORKTREE_ID, chatId),
            watcherMessageId,
            reply,
          ),
        { timeout: 90_000 },
      )
      .toEqual({ watcherCount: 1, replyCount: 1 });

    const reopenedWindowPromise = electronApp.waitForEvent('window');
    await electronApp.evaluate(({ app }) => app.emit('activate'));
    window = await reopenedWindowPromise;
    const reopenedApp = new CanopyAppDriver(window);
    await reopenedApp.waitForShell({ timeout: 30_000 });
    await reopenedApp.openMainPage();
    await reopenedApp.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const watcherBubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: text });
    await expect(watcherBubble).toHaveCount(1, { timeout: 30_000 });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      'Pipeline completion (Deploy) watcher has fired',
    );
    await expect(
      panel.locator('[data-role="assistant"]').filter({ hasText: reply }),
    ).toHaveCount(1);
    expect(
      watcherAndReplyCounts(
        readStoredChat(userDataDir, WORKTREE_ID, chatId),
        watcherMessageId,
        reply,
      ),
    ).toEqual({ watcherCount: 1, replyCount: 1 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('Resend on an uncertain row asks before sending once', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-resend-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const fixture = createDefaultCodexFixture(userDataDir);
  seedUncertainWatcherDeliveries(userDataDir, {
    providerType: 'codex',
    model: 'gpt-6-sol',
    executionHarness: 'codex',
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: fixture.env }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const rows = panel.getByTestId('input-delivery-row');
    await expect(rows).toHaveCount(3);
    // The payload contains a newline; match the unique line, not the JSON text.
    const payloadText = 'Delegate completion 1';
    const row = rows.filter({ hasText: payloadText });
    const requestsWithPayload = () =>
      allCodexClientRequests(readJsonl(fixture.logPath)).filter((request) =>
        JSON.stringify(request.params?.input ?? []).includes(payloadText),
      );

    await row.getByTestId('input-delivery-bubble').hover();
    const resend = row.getByTestId('input-delivery-resend');
    await expect(resend).toBeVisible();
    await expect(resend).toHaveText('Resend');
    await expect(row.getByTestId('input-delivery-edit')).toHaveCount(0);
    await resend.click();

    const warning = window.getByTestId('input-delivery-resend-warning');
    await expect(warning).toBeVisible();
    await expect(
      warning.getByText('Send again? It may arrive twice.', { exact: true }),
    ).toBeVisible();
    const confirm = warning.getByTestId('input-delivery-resend-confirm');
    const keep = warning.getByTestId('input-delivery-resend-keep');
    await expect(confirm).toHaveText('Send again');
    await expect(keep).toHaveText('Keep');
    await expect(keep).toBeFocused();
    expect(requestsWithPayload()).toHaveLength(0);

    await keep.click();
    await expect(warning).toHaveCount(0);
    await expect(resend).toBeFocused();
    expect(requestsWithPayload()).toHaveLength(0);

    await resend.click();
    await expect(warning).toBeVisible();
    await warning.getByTestId('input-delivery-resend-confirm').click();
    await expect
      .poll(() => requestsWithPayload().length, { timeout: 60_000 })
      .toBe(1);
    const sentRequests = requestsWithPayload();
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0].method).toBe('turn/start');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(row).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('uncertain watcher deliveries can be dismissed durably without resending', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-dismiss-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedUncertainWatcherDeliveries(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const open = async () => {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      return window;
    };
    let window = await open();
    const rows = window.getByTestId('input-delivery-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Delivery uncertain');
    const dismiss = rows
      .first()
      .getByRole('button', { name: 'Dismiss message', exact: true });
    const dismissCorner = dismiss.locator('xpath=ancestor::div[1]');
    await window.mouse.move(0, 0);
    await expect(dismissCorner).toHaveCSS('opacity', '0');
    await rows.first().getByTestId('input-delivery-bubble').hover();
    await expect(dismissCorner).toHaveCSS('opacity', '1');
    await expect(dismiss).toBeVisible();
    await expect(rows.first().getByTestId('input-delivery-resend')).toHaveText(
      'Resend',
    );
    await window.mouse.move(0, 0);
    await expect(dismissCorner).toHaveCSS('opacity', '0');
    await dismiss.focus();
    await expect(dismissCorner).toHaveCSS('opacity', '1');
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect
      .poll(() =>
        window.evaluate(() => matchMedia('(pointer: coarse)').matches),
      )
      .toBe(true);
    // The Button keeps its 28px disc and grows a 44px hit area on touch, so
    // a tap 7px outside each edge of the disc still lands on Dismiss, and the
    // whole hit area stays inside the viewport.
    const touchTarget = await dismiss.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      const hits = [
        [box.left - 7, midY],
        [box.right + 7, midY],
        [midX, box.top - 7],
        [midX, box.bottom + 7],
      ].map(
        ([x, y]) =>
          document.elementFromPoint(x, y)?.closest('button') === element,
      );
      return { hits, right: box.right + 8, viewportWidth: window.innerWidth };
    });
    expect(touchTarget.hits).toEqual([true, true, true, true]);
    expect(touchTarget.right).toBeLessThanOrEqual(touchTarget.viewportWidth);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await dismiss.press('Enter');
    await expect(rows).toHaveCount(2);
    await expect(
      window.locator('[data-slate-editor="true"]:visible').first(),
    ).toBeFocused();
    const state = () =>
      window.evaluate(async () => {
        const snapshot = await window.api.chat.getState({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        });
        return snapshot.tabsFile.tabs.find(
          (tab) => tab.id === 'uncertain-watchers',
        );
      });
    const tab = await state();
    expect(tab.inputDelivery.rows[0].dismissedAt).toEqual(expect.any(Number));
    expect(tab.inputDelivery.rows[0].state).toBe('uncertain');
    expect(tab.inputDelivery.rows[0].attempts).toHaveLength(1);
    expect(tab.queuedMessages ?? []).toHaveLength(0);
    expect(tab.messages).toHaveLength(1);
    await window.reload();
    window = await open();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(2);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await open();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(2);
    await window.getByTestId('input-delivery-bubble').first().hover();
    await window.getByTestId('input-delivery-dismiss').first().click();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(1);
    await window.getByTestId('input-delivery-bubble').hover();
    await window.getByTestId('input-delivery-dismiss').click();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(0);
    expect((await state()).messages).toHaveLength(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a cancelled message can be dismissed durably without resending', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cancelled-dismiss-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCancelledCopiedDelivery(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const rows = window.getByTestId('input-delivery-row');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Cancelled');
    await rows.getByTestId('input-delivery-dismiss').click();
    await expect(rows).toHaveCount(0);
    const tab = await window.evaluate(async () => {
      const snapshot = await window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      });
      return snapshot.tabsFile.tabs.find((t) => t.id === 'cancelled-copy');
    });
    expect(tab.inputDelivery.rows[0].dismissedAt).toEqual(expect.any(Number));
    expect(tab.inputDelivery.rows[0].state).toBe('cancelled');
    expect(tab.queuedMessages ?? []).toHaveLength(0);
    expect(tab.messages).toHaveLength(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
