// The plain pressure fake only acknowledges SDK-to-fake control requests and
// emits pressure text/results; it never sends a can_use_tool request back to
// the SDK. Without lifecycle replay, no real approval card can appear and the
// card wait below fails, so this proves the approval round trip uses replay.
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
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { loadReplayFixture } from './fixtures/lifecycle-replay.mjs';
import { composeClaudeTwoAgentStopFixture } from './fixtures/lifecycle-replay-claude.mjs';

const SESSION_ID = 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat';
const [WORKSPACE_ID, WORKTREE_ID, CHAT_ID] = SESSION_ID.split('/');
const PROMPT = 'Report Claude pressure status.';
const TOOL_COMMAND = 'printf canopy-lifecycle-replay';
const REPLAY_TEXT = 'Claude lifecycle replay complete';
const FAKE_CLI = fileURLToPath(
  new URL('./fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
);
const REPLAY_FIXTURE = fileURLToPath(
  new URL(
    '../../../../scripts/harness-contract/lifecycle/fixtures/claude/permission-wait.json',
    import.meta.url,
  ),
);
const REPLAY_MODULE = fileURLToPath(
  new URL('./fixtures/lifecycle-replay.mjs', import.meta.url),
);
const LIFECYCLE_FIXTURE_DIR = fileURLToPath(
  new URL(
    '../../../../scripts/harness-contract/lifecycle/fixtures/claude/',
    import.meta.url,
  ),
);

function replayEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeCliEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function chatMessages(userDataDir) {
  return readChatStorageMessages(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
    CHAT_ID,
  );
}

function chatText(userDataDir) {
  return chatMessages(userDataDir)
    .flatMap((message) => message.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function chatStatus(userDataDir) {
  const { live } = readChatStorageIndexes(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
  );
  return live.runtimeByChatId[CHAT_ID]?.status;
}

test('Claude permission-wait lifecycle replay pauses for Ask approval and persists the completed turn @provider-lifecycle', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-lifecycle-replay-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fakeCliLogPath = path.join(userDataDir, 'fake-claude-pressure.log');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  copyFileSync(FAKE_CLI, fakeCliPath);
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
        title: 'Claude lifecycle replay chat',
        providerType: 'claude',
        approvalMode: 'ask',
      },
    ],
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_PRESSURE_LOG: fakeCliLogPath,
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: REPLAY_FIXTURE,
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
      },
    }),
  );

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
      'aria-label',
      'Tool approval mode, current mode Ask',
      { timeout: 15_000 },
    );

    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot.getByRole('textbox').fill(PROMPT);
    await composerRoot.getByRole('button', { name: 'Send message' }).click();

    const card = window.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(TOOL_COMMAND);
    const timer = window.getByTestId('turn-timer');
    await expect(timer).toHaveAttribute('data-state', 'paused');
    await expect
      .poll(
        () =>
          fakeCliEntries(fakeCliLogPath).filter(
            (entry) => entry.type === 'user' && entry.target,
          ),
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    expect(fakeCliEntries(fakeCliLogPath)).toContainEqual(
      expect.objectContaining({
        type: 'user',
        target: true,
        targetSession: true,
      }),
    );

    await expect
      .poll(
        () =>
          replayEntries(replayLogPath).filter(
            (entry) => entry.kind === 'permission_request',
          ),
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    const heldEntries = replayEntries(replayLogPath);
    expect(heldEntries).toContainEqual({
      kind: 'permission_request',
      requestId: expect.any(String),
      toolUseId: expect.any(String),
    });
    expect(
      heldEntries.some(
        (entry) =>
          entry.kind === 'frame' && entry.type?.startsWith('sdk:result:'),
      ),
    ).toBe(false);
    expect(heldEntries.some((entry) => entry.kind === 'done')).toBe(false);
    expect(chatStatus(userDataDir)).not.toBe('completed');
    expect(chatText(userDataDir)).not.toContain(REPLAY_TEXT);
    await expect(panel.getByText(REPLAY_TEXT, { exact: true })).toHaveCount(0);

    await window.getByTestId('tool-approval-allow').click();

    await expect(card).toHaveCount(0);
    await expect(panel.getByText(REPLAY_TEXT, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect.poll(() => chatStatus(userDataDir)).toBe('completed');
    await expect
      .poll(() =>
        replayEntries(replayLogPath).some((entry) => entry.kind === 'done'),
      )
      .toBe(true);

    const completedEntries = replayEntries(replayLogPath);
    const permissionRequest = completedEntries.find(
      (entry) => entry.kind === 'permission_request',
    );
    expect(permissionRequest).toEqual({
      kind: 'permission_request',
      requestId: expect.any(String),
      toolUseId: expect.any(String),
    });
    expect(
      completedEntries.filter((entry) => entry.kind === 'permission_response'),
    ).toEqual([
      {
        kind: 'permission_response',
        requestId: permissionRequest.requestId,
        behavior: 'allow',
      },
    ]);
    expect(completedEntries).toContainEqual({
      kind: 'frame',
      index: expect.any(Number),
      type: 'sdk:result:success',
    });
    expect(completedEntries.at(-1)).toEqual({ kind: 'done' });
    expect(chatText(userDataDir)).toContain(REPLAY_TEXT);
    expect(
      chatMessages(userDataDir).some((message) =>
        (message.blocks ?? []).some(
          (block) => block.type === 'text' && block.text === REPLAY_TEXT,
        ),
      ),
    ).toBe(true);

    await window.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = new CanopyAppDriver(window);
    await reloaded.waitForShell({ timeout: 30_000 });
    await reloaded.openMainPage();
    await reloaded.selectWorktree(WORKTREE_ID);
    const reloadedPanel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(
      reloadedPanel.getByText(REPLAY_TEXT, { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    expect(chatText(userDataDir)).toContain(REPLAY_TEXT);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Claude composer Stop preserves live native agents and per-agent Stop targets only the selected task @provider-lifecycle', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-agent-stop-replay-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fakeCliLogPath = path.join(userDataDir, 'fake-claude-pressure.log');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
  const replayFixturePath = path.join(
    userDataDir,
    'claude-two-agent-stop-fixture.json',
  );
  const composedFixture = composeClaudeTwoAgentStopFixture({
    agentFixture: loadReplayFixture(
      path.join(LIFECYCLE_FIXTURE_DIR, 'agent-default-background.json'),
    ),
    interruptFixture: loadReplayFixture(
      path.join(LIFECYCLE_FIXTURE_DIR, 'interrupt-with-background-agents.json'),
    ),
    stopTaskFixture: loadReplayFixture(
      path.join(LIFECYCLE_FIXTURE_DIR, 'stop-task.json'),
    ),
  });
  writeFileSync(replayFixturePath, JSON.stringify(composedFixture));
  mkdirSync(gatesDir);
  copyFileSync(FAKE_CLI, fakeCliPath);
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
        title: 'Claude native agent stop replay chat',
        providerType: 'claude',
        approvalMode: 'ask',
      },
    ],
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_PRESSURE_LOG: fakeCliLogPath,
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: replayFixturePath,
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify([
          'release-sibling-finish',
        ]),
      },
    }),
  );

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot.getByRole('textbox').fill(PROMPT);
    await composerRoot.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        () =>
          fakeCliEntries(fakeCliLogPath).filter(
            (entry) => entry.type === 'task_started',
          ),
        { timeout: 60_000 },
      )
      .toHaveLength(2);
    const fakeEntries = () => fakeCliEntries(fakeCliLogPath);
    const startedTasks = fakeEntries().filter(
      (entry) => entry.type === 'task_started',
    );
    expect(startedTasks.map((entry) => entry.taskAlias)).toEqual(['k1', 'k2']);
    expect(startedTasks[0].taskId).not.toBe(startedTasks[1].taskId);
    expect(fakeEntries().some((entry) => entry.type === 'initialize')).toBe(
      true,
    );
    expect(
      fakeEntries().find((entry) => entry.type === 'initialize'),
    ).toHaveProperty('options');

    // Live native agents are rows in the composer's background drawer.
    const activity = await openBackgroundDrawer(panel, { timeout: 60_000 });
    const agentRows = activity
      .getByTestId('background-tray-agent')
      .filter({ hasText: 'Claude lifecycle replay agent' });
    const firstAgent = agentRows.filter({
      hasText: 'Claude lifecycle replay agent 1',
    });
    const secondAgent = agentRows.filter({
      hasText: 'Claude lifecycle replay agent 2',
    });
    await expect(agentRows).toHaveCount(2, { timeout: 60_000 });
    const firstAgentStop = firstAgent.getByTestId('background-tray-agent-stop');
    const secondAgentStop = secondAgent.getByTestId(
      'background-tray-agent-stop',
    );
    await expect(firstAgentStop).toHaveAccessibleName('Stop agent');
    await expect(secondAgentStop).toHaveAccessibleName('Stop agent');

    const composerStop = panel.getByTestId('chat-stop-generation');
    await expect(composerStop).toBeVisible();
    await composerStop.click();
    await expect(composerStop).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(
        () =>
          fakeEntries().filter(
            (entry) =>
              entry.type === 'control_request' && entry.subtype === 'interrupt',
          ),
        { timeout: 30_000 },
      )
      .toHaveLength(1);
    await expect
      .poll(
        () =>
          replayEntries(replayLogPath).filter(
            (entry) =>
              entry.kind === 'frame' &&
              entry.type === 'sdk:result:error_during_execution',
          ),
        { timeout: 30_000 },
      )
      .toHaveLength(1);

    // This is the regression assertion: Composer Stop cancels the foreground
    // turn without stopping either native Agent task.
    await expect(
      agentRows,
      'composer Stop must leave both native agents live in the drawer',
    ).toHaveCount(2, { timeout: 15_000 });
    await expect(firstAgentStop).toBeVisible();
    await expect(secondAgentStop).toBeVisible();

    const secondTaskId = startedTasks.find(
      (entry) => entry.taskAlias === 'k2',
    ).taskId;
    await secondAgentStop.click();
    await expect
      .poll(
        () =>
          fakeEntries().filter(
            (entry) =>
              entry.type === 'control_request' && entry.subtype === 'stop_task',
          ),
        { timeout: 30_000 },
      )
      .toEqual([
        {
          type: 'control_request',
          subtype: 'stop_task',
          requestId: expect.any(String),
          taskId: secondTaskId,
        },
      ]);
    await expect
      .poll(
        () =>
          fakeEntries().filter(
            (entry) =>
              entry.type === 'task_notification' &&
              entry.taskAlias === 'k2' &&
              entry.status === 'stopped',
          ),
        { timeout: 30_000 },
      )
      .toHaveLength(1);
    await expect
      .poll(
        () =>
          replayEntries(replayLogPath).some(
            (entry) =>
              entry.kind === 'gate' && entry.name === 'release-sibling-finish',
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(
      fakeEntries().some(
        (entry) =>
          entry.type === 'task_notification' &&
          entry.taskAlias === 'k1' &&
          entry.status === 'completed',
      ),
    ).toBe(false);
    await expect(firstAgentStop).toBeVisible();

    writeFileSync(path.join(gatesDir, 'release-sibling-finish'), '');
    await expect
      .poll(
        () =>
          fakeEntries().filter(
            (entry) =>
              entry.type === 'task_notification' &&
              entry.taskAlias === 'k1' &&
              entry.status === 'completed',
          ),
        { timeout: 30_000 },
      )
      .toHaveLength(1);
    await expect
      .poll(() =>
        replayEntries(replayLogPath).some((entry) => entry.kind === 'done'),
      )
      .toBe(true);
  } finally {
    writeFileSync(path.join(gatesDir, 'release-sibling-finish'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});
