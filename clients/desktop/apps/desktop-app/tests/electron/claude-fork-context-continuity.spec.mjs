import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseChatInterfaceMode } from './chatInterfaceMode.mjs';

// ---------------------------------------------------------------------------
// Claude fork context continuity.
//
// Forking a completed turn while the source chat has already started its next
// turn is a "truncated" fork. Both fork implementations used to drop the
// Claude session outright, so the forked tab's first send started a brand-new
// SDK session with zero model context while the transcript (and the Fork
// tooltip) implied the opposite.
//
// The Agent SDK can now resume at a point in time — `resumeSessionAt` with the
// chain uuid of the last chain entry the fork kept — so the session carries
// whenever the kept transcript records one (`PersistedChatMessage.claudeUuid`).
// Transcripts written before that field existed record none, and those still
// start fresh; the fork then marks `forkedFrom.modelContext: 'fresh'` and the
// transcript renders the disclosure notice.
//
// Both cases are exercised here through the real UI:
//   source chat = turn 1 completed (user → assistant → completed turn_timer)
//   plus turn 2 still in progress (user → open turn_timer). Turn 2 carries no
//   assistant content, so `findLastForkableTurnGroupIndex` keeps the Fork
//   button on turn 1, and forking there truncates.
//
// Determinism: no live agents and no network. The transcript is static seeded
// JSON, and the send assertion replaces the `chat:send-message` IPC handler
// with a capture stub so the real renderer send path runs without a provider.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'fork-source';
const SOURCE_SESSION_ID = 'source-session';
const CHAIN_UUID = '11111111-2222-4333-8444-555555555555';
const FRESH_NOTICE = 'fork-fresh-context-notice';
const SEND_MESSAGE_CHANNEL = 'chat:send-message';

const T = Date.parse('2026-04-10T12:00:00.000Z');

/**
 * Turn 1 completed and forkable, turn 2 started but unanswered.
 *
 * @param {boolean} stamped whether the assistant message records a Claude
 *   chain uuid (a modern transcript) or not (a legacy one).
 */
function buildMessages(stamped) {
  return [
    {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Summarize the release notes.' }],
      timestamp: T,
    },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Here is the release summary.' }],
      timestamp: T + 10_000,
      ...(stamped ? { claudeUuid: CHAIN_UUID } : {}),
    },
    {
      id: 'timer-1',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: T, completedAt: T + 20_000 }],
      timestamp: T + 20_000,
    },
    {
      id: 'u2',
      role: 'user',
      blocks: [{ type: 'text', text: 'Now draft the announcement.' }],
      timestamp: T + 120_000,
    },
    {
      id: 'timer-2',
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: T + 120_000, completedAt: null },
      ],
      timestamp: T + 121_000,
    },
  ];
}

function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function launchForkCanopy(
  stamped,
  { sourceSession = true, seedSourceTranscript = false } = {},
) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-fork-ctx-'));
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedPreferences(userDataDir);
  if (seedSourceTranscript) {
    const worktreePath = seeded.workspaces?.find(
      (workspace) => workspace.id === WORKSPACE_ID,
    )?.worktreePath;
    if (!worktreePath) {
      throw new Error('Expected the seeded Claude worktree path');
    }
    const projectSlug = realpathSync(worktreePath).replace(
      /[^A-Za-z0-9-]/g,
      '-',
    );
    const transcriptPath = path.join(
      userDataDir,
      'provider-state',
      'claude',
      'projects',
      projectSlug,
      `${SOURCE_SESSION_ID}.jsonl`,
    );
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, '{}\n', 'utf8');
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Release notes',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        ...(sourceSession ? { sdkSessionId: SOURCE_SESSION_ID } : {}),
        hasStartedSession: true,
        messages: buildMessages(stamped),
      },
    ],
  });
  const launched = await launchCanopy({ userDataDir });
  return { ...launched, userDataDir };
}

async function forkTheCompletedTurn(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);

  const chatPanel = window.getByTestId('panel-content-chat');
  await expect(chatPanel).toBeVisible();
  const forkButton = chatPanel.getByTestId('fork-chat-button');
  await expect(forkButton.last()).toBeVisible({ timeout: 30_000 });
  await forkButton.last().click();
  await expect(
    window.locator('[role="tab"][data-panel-kind="chat"]'),
  ).toHaveCount(2);
  return chatPanel;
}

async function readForkedTab(window) {
  return window.evaluate(
    async ({ projectId, worktreeId, sourceTabId }) => {
      const loaded = await window.api.chat.loadTabs({ projectId, worktreeId });
      const fork = loaded.tabs.find((tab) => tab.id !== sourceTabId);
      return fork
        ? {
            id: fork.id,
            sdkSessionId: fork.sdkSessionId,
            claudeForkSessionOnNextSend: fork.claudeForkSessionOnNextSend,
            modelContext: fork.forkedFrom?.modelContext,
            resumePointRequired: fork.forkedFrom?.resumePointRequired,
          }
        : null;
    },
    {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      sourceTabId: TAB_ID,
    },
  );
}

test('a truncated Claude fork keeps its session and resumes at the kept chain entry', async () => {
  test.setTimeout(90_000);
  const { electronApp, userDataDir } = await launchForkCanopy(true);

  try {
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, request) => {
        globalThis.__forkSendRequest = request;
        return { ok: true, chatId: request.chatId };
      });
    }, SEND_MESSAGE_CHANNEL);

    const chatPanel = await forkTheCompletedTurn(window);

    await expect
      .poll(() => readForkedTab(window))
      .toMatchObject({
        sdkSessionId: SOURCE_SESSION_ID,
        claudeForkSessionOnNextSend: true,
        resumePointRequired: true,
      });
    const fork = await readForkedTab(window);
    expect(fork?.modelContext).toBeUndefined();

    // The transcript must NOT claim the agent lost its context.
    await expect(chatPanel.getByTestId(FRESH_NOTICE)).toHaveCount(0);

    // The first send carries the point-in-time anchor, not a plain resume.
    const composer = chatPanel.getByRole('textbox').first();
    await composer.click();
    await composer.fill('Continue from the summary.');
    await composer.press('Enter');

    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const request = globalThis.__forkSendRequest;
          return request
            ? {
                sdkSessionId: request.sdkSessionId,
                claudeForkSession: request.claudeForkSession,
                claudeForkResumeAt: request.claudeForkResumeAt,
              }
            : null;
        }),
      )
      .toEqual({
        sdkSessionId: SOURCE_SESSION_ID,
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
      });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a legacy transcript fork starts fresh and says so in the transcript', async () => {
  test.setTimeout(90_000);
  const { electronApp, userDataDir } = await launchForkCanopy(false);

  try {
    const window = await electronApp.firstWindow();
    const chatPanel = await forkTheCompletedTurn(window);

    await expect
      .poll(() => readForkedTab(window))
      .toMatchObject({ modelContext: 'fresh' });
    const fork = await readForkedTab(window);
    expect(fork?.sdkSessionId).toBeUndefined();
    expect(fork?.claudeForkSessionOnNextSend).toBeUndefined();

    const notice = chatPanel.getByTestId(FRESH_NOTICE);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      "The agent can't see the messages above",
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a truncated Claude fork still discloses fresh context after its source session was cleared', async () => {
  test.setTimeout(90_000);
  const { electronApp, userDataDir } = await launchForkCanopy(true, {
    sourceSession: false,
  });

  try {
    const window = await electronApp.firstWindow();
    const chatPanel = await forkTheCompletedTurn(window);

    await expect
      .poll(() => readForkedTab(window))
      .toMatchObject({ modelContext: 'fresh' });
    const fork = await readForkedTab(window);
    expect(fork?.sdkSessionId).toBeUndefined();
    expect(fork?.claudeForkSessionOnNextSend).toBeUndefined();
    await expect(chatPanel.getByTestId(FRESH_NOTICE)).toContainText(
      "The agent can't see the messages above",
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a truncated Claude fork starts fresh before entering terminal mode', async () => {
  test.setTimeout(90_000);
  const { electronApp, userDataDir } = await launchForkCanopy(true, {
    seedSourceTranscript: true,
  });

  try {
    const window = await electronApp.firstWindow();
    await forkTheCompletedTurn(window);

    await expect
      .poll(() => readForkedTab(window))
      .toMatchObject({
        sdkSessionId: SOURCE_SESSION_ID,
        resumePointRequired: true,
      });

    await chooseChatInterfaceMode(window, window, 'claude-code');

    await expect
      .poll(() => readForkedTab(window), { timeout: 30_000 })
      .toMatchObject({
        modelContext: 'fresh',
      });
    const terminalFork = await readForkedTab(window);
    expect(terminalFork?.sdkSessionId).not.toBe(SOURCE_SESSION_ID);
    expect(terminalFork?.resumePointRequired).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
