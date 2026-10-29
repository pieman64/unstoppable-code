import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { chooseChatInterfaceMode } from './chatInterfaceMode.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const BLOCKER_HOOK_MARKER = 'Canopy-CHOOKCANCELBLOCKER';
const BLOCKER_HOOK_PROMPT = `Active cancellation blocker [${BLOCKER_HOOK_MARKER}]`;
const QUEUED_HOOK_MARKER = 'Canopy-CHOOKCANCELQUEUED';
const QUEUED_HOOK_PROMPT = `Queued cancellation review [${QUEUED_HOOK_MARKER}]`;

function seedHookConfiguration(userDataDir, prompt) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.hooks = {
    'pr:create': [
      {
        type: 'chat',
        prompt,
        model: 'claude-haiku-4-5-20251001',
      },
    ],
  };
  writeJson(configPath, config);
}

function seedHookSnapshot(userDataDir) {
  const snapshotDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'github-pr',
    'project-root',
  );
  writeJson(path.join(snapshotDir, 'current.json'), {
    version: 1,
    provider: 'github',
    capturedAt: '2026-09-03T12:00:00.000Z',
    includesComments: true,
    includesReviews: true,
    includesReviewComments: true,
    repository: { owner: 'acme', name: 'app', fullName: 'acme/app' },
    branch: {
      currentName: 'feature/hook-chat-cancellation',
      headRefName: 'feature/hook-chat-cancellation',
      baseRefName: 'main',
      headSha: 'head-sha',
      baseSha: 'base-sha',
    },
    pr: {
      id: 2909,
      number: 2909,
      nodeId: 'PR_hook_chat_cancellation',
      htmlUrl: 'https://github.com/acme/app/pull/2909',
      apiUrl: 'https://api.github.com/repos/acme/app/pulls/2909',
      state: 'open',
      isDraft: false,
      title: 'Hook chat cancellation',
      body: '',
      author: null,
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  });
}

function invokeManualHook(window) {
  return window.evaluate(
    ({ projectId, worktreeId }) =>
      window.api.runHook({
        target: 'project',
        triggerName: 'pr:create',
        projectId,
        worktreeId,
      }),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

function isMissingSnapshotError(error) {
  return String(error).includes('No current PR snapshot exists');
}

async function runManualHookWithSnapshotRetry({ window, userDataDir }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    seedHookSnapshot(userDataDir);
    try {
      const response = await invokeManualHook(window);
      expect(response.success).toBe(true);
      return;
    } catch (error) {
      if (!isMissingSnapshotError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

test('closing a queued hook placeholder survives a failed persisted start', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-chat-cancellation-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  seedHookConfiguration(userDataDir, BLOCKER_HOOK_PROMPT);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'active-chat', title: 'Active chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, BLOCKER_HOOK_MARKER, {
    llm: {
      steps: [
        {
          text: 'active hook completes after the queued hook is prepared',
          streamMs: 15_000,
        },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, QUEUED_HOOK_MARKER, {
    llm: {
      steps: [{ text: 'cancelled hook must never dispatch' }],
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_HOOK_CHAT_PERSIST_DELAY_TITLE: 'Queued cancellation review',
      CANOPY_E2E_HOOK_CHAT_PERSIST_DELAY_MS: '10000',
      CANOPY_E2E_HOOK_CHAT_PERSIST_FAIL_AFTER_DELAY: '1',
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // The disabled-network PR poller can remove the on-disk fixture between a
    // write and the real manual-hook IPC read. Observe that specific rejection
    // and retry it instead of turning it into an opaque persistence timeout.
    await runManualHookWithSnapshotRetry({ window, userDataDir });
    await expect
      .poll(
        () => {
          const persisted = readChatStorageIndexes(
            workspaceRoot,
            WORKTREE_ID,
          ).live;
          return persisted.tabs.some(
            (tab) =>
              tab.id !== 'active-chat' &&
              tab.title.startsWith('Active cancellation blocker'),
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const firstHookChatId = readChatStorageIndexes(
      workspaceRoot,
      WORKTREE_ID,
    ).live.tabs.find(
      (tab) =>
        tab.id !== 'active-chat' &&
        tab.title.startsWith('Active cancellation blocker'),
    ).id;

    await window.evaluate(() => {
      window.__queuedHookQueueId = null;
      window.api.chat.onHookTabStarted((event) => {
        if (event.queuedMessage) {
          window.__queuedHookQueueId = event.queuedMessage.queueId;
        }
      });
    });
    seedHookConfiguration(userDataDir, QUEUED_HOOK_PROMPT);
    await runManualHookWithSnapshotRetry({ window, userDataDir });

    await expect
      .poll(
        () => {
          const persisted = readChatStorageIndexes(
            workspaceRoot,
            WORKTREE_ID,
          ).live;
          return persisted.tabs.some(
            (tab) =>
              tab.id !== 'active-chat' &&
              tab.id !== firstHookChatId &&
              tab.title.startsWith('Queued cancellation review'),
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const queuedChatId = readChatStorageIndexes(
      workspaceRoot,
      WORKTREE_ID,
    ).live.tabs.find(
      (tab) =>
        tab.id !== 'active-chat' &&
        tab.id !== firstHookChatId &&
        tab.title.startsWith('Queued cancellation review'),
    ).id;
    const panelId = `panel-chat-${queuedChatId}`;
    const panelTestId = `panel-tab-${panelId}`;
    const queuedPanelTabById = window.getByTestId(panelTestId);
    await expect(queuedPanelTabById).toBeVisible({ timeout: 30_000 });

    // A queued placeholder persists with no messages. The real start replaces
    // it with the initial hook transcript before waiting at the configured
    // persistence barrier, so this proves cancellation happens in flight
    // rather than while the hook is merely waiting behind the blocker.
    await expect
      .poll(
        () => {
          return readChatStorageMessages(
            workspaceRoot,
            WORKTREE_ID,
            queuedChatId,
          ).length;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const activityBeforeCancellation = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      QUEUED_HOOK_MARKER,
    );
    expect(activityBeforeCancellation.activity.llmRequests ?? 0).toBe(0);

    const queueId = await window.evaluate(() => window.__queuedHookQueueId);
    expect(queueId).toBeTruthy();
    await window.evaluate((id) => {
      window.__hookCancelSettled = false;
      window.__hookCancelResult = window.api.chat
        .cancelQueuedHookChat({ queueId: id })
        .then((result) => {
          window.__hookCancelSettled = true;
          return result;
        });
    }, queueId);
    await closePanelTab(window, panelId);
    // Even with a concurrent close request, cancellation cannot acknowledge
    // until the in-flight persisted start has been removed.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await window.evaluate(() => window.__hookCancelSettled)).toBe(false);
    expect(await window.evaluate(() => window.__hookCancelResult)).toEqual({
      cancelled: true,
    });
    await expect(queuedPanelTabById).toHaveCount(0);

    await expect
      .poll(
        () => {
          const persisted = readChatStorageIndexes(
            workspaceRoot,
            WORKTREE_ID,
          ).live;
          return persisted.tabs.some((tab) => tab.id === queuedChatId);
        },
        { timeout: 30_000 },
      )
      .toBe(false);

    await expect(queuedPanelTabById).toHaveCount(0);
    const hookActivity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      QUEUED_HOOK_MARKER,
    );
    expect(hookActivity.activity.llmRequests ?? 0).toBe(0);
    await expect(composerIdleAction(window)).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a queued hook chat shows its hook banner before it starts', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-chat-queued-banner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedHookConfiguration(userDataDir, BLOCKER_HOOK_PROMPT);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'active-chat', title: 'Active chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, BLOCKER_HOOK_MARKER, {
    llm: {
      steps: [
        {
          text: 'active hook keeps the worktree busy',
          streamMs: 20_000,
        },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, QUEUED_HOOK_MARKER, {
    llm: {
      steps: [{ text: 'queued hook finished its review' }],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.evaluate(() => {
      window.__hookTabStarts = [];
      window.api.chat.onHookTabStarted((event) => {
        window.__hookTabStarts.push({
          chatId: event.chatId,
          queued: event.queuedMessage !== undefined,
        });
      });
    });

    await runManualHookWithSnapshotRetry({ window, userDataDir });
    await expect
      .poll(
        async () =>
          (
            await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              BLOCKER_HOOK_MARKER,
            )
          ).activity.llmRequests ?? 0,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    seedHookConfiguration(userDataDir, QUEUED_HOOK_PROMPT);
    await runManualHookWithSnapshotRetry({ window, userDataDir });
    await expect
      .poll(
        () =>
          window.evaluate(
            () =>
              window.__hookTabStarts.find((start) => start.queued)?.chatId ??
              null,
          ),
        { timeout: 60_000 },
      )
      .not.toBeNull();
    const queuedChatId = await window.evaluate(
      () => window.__hookTabStarts.find((start) => start.queued).chatId,
    );
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${queuedChatId}"]`,
    );
    const banner = panel.getByTestId('chat-hook-info-banner');

    // The placeholder is still waiting behind the blocker, yet already shows
    // which hook initiated it. Hook chats open in the background, so its
    // tab is selected first.
    const queuedTab = window.getByTestId(
      `panel-tab-panel-chat-${queuedChatId}`,
    );
    await expect(queuedTab).toBeVisible({ timeout: 30_000 });
    // A canonical refresh can land right after the click; select again
    // until this panel is the one showing.
    await expect(async () => {
      await queuedTab.click();
      await expect(panel).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      panel.getByText('Waiting for active chat sessions to finish.'),
    ).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Chat initiated by PR Created hook');
    const queuedActivity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      QUEUED_HOOK_MARKER,
    );
    expect(queuedActivity.activity.llmRequests ?? 0).toBe(0);

    // Once the blocker finishes, the started chat replaces the placeholder
    // with its real transcript, which keeps exactly one banner.
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, QUEUED_HOOK_MARKER))
            .activity.llmRequests ?? 0,
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
    await window.getByTestId(`panel-tab-panel-chat-${queuedChatId}`).click();
    await expect(
      panel.getByText('queued hook finished its review'),
    ).toBeVisible({ timeout: 90_000 });
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText('Chat initiated by PR Created hook');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a queued Claude hook remains explained in Claude Code mode', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-chat-queued-claude-mode-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedHookConfiguration(userDataDir, BLOCKER_HOOK_PROMPT);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'active-chat', title: 'Active chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, BLOCKER_HOOK_MARKER, {
    llm: {
      steps: [
        { text: 'active hook keeps the worktree busy', streamMs: 60_000 },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, QUEUED_HOOK_MARKER, {
    llm: { steps: [{ text: 'queued hook finished its review' }] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.evaluate(() => {
      window.__queuedHookChatId = null;
      window.api.chat.onHookTabStarted((event) => {
        if (event.queuedMessage) window.__queuedHookChatId = event.chatId;
      });
    });

    await runManualHookWithSnapshotRetry({ window, userDataDir });
    await expect
      .poll(
        async () =>
          (
            await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              BLOCKER_HOOK_MARKER,
            )
          ).activity.llmRequests ?? 0,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    seedHookConfiguration(userDataDir, QUEUED_HOOK_PROMPT);
    await runManualHookWithSnapshotRetry({ window, userDataDir });
    await expect
      .poll(() => window.evaluate(() => window.__queuedHookChatId), {
        timeout: 60_000,
      })
      .not.toBeNull();
    const queuedChatId = await window.evaluate(() => window.__queuedHookChatId);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${queuedChatId}"]`,
    );
    const banner = panel.getByTestId('chat-hook-info-banner');
    // Hook chats open in the background, so select the queued tab first.
    const queuedTab = window.getByTestId(
      `panel-tab-panel-chat-${queuedChatId}`,
    );
    await expect(queuedTab).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await queuedTab.click();
      await expect(panel).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(banner).toBeVisible();
    await chooseChatInterfaceMode(window, panel, 'claude-code');
    await expect(banner).toBeVisible();
    // The queued launch owns the mode, so switching never reaches main's
    // canonical tab state (which would refresh the placeholder away).
    await expect(window.getByTestId('chat-state-conflict-notice')).toHaveCount(
      0,
    );
    await expect(banner).toContainText('Chat initiated by PR Created hook');
    await expect(
      panel.getByText('Waiting for active chat sessions to finish.'),
    ).toBeVisible();
    await chooseChatInterfaceMode(window, panel, 'canopy');
    await expect(banner).toBeVisible();
    const queuedActivity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      QUEUED_HOOK_MARKER,
    );
    expect(queuedActivity.activity.llmRequests ?? 0).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
