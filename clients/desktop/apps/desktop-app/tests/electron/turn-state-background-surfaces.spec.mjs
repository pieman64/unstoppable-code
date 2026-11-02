// Turn-state invariant 10 (phase 43i): every renderer surface agrees with the
// canonical runtime. A Claude turn starts two native background agents; the
// composer Stop ends the foreground turn while both agents keep running, so
// the chat moves foreground → background → idle. At each step the composer,
// the turn timer, the chat tab, the worktree row, the background tray and the
// stuck banner must show what the persisted runtime says (phases 38–40). The
// second flow follows a background shell's wake turn through the same states
// and checks the wake's own boundary row and timer (phases 40c and 40d). The
// third checks invariant 8's chat-level notice: a background chat whose turn
// ends while its agent runs gets one completion notice, after the wake (36d).
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
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  loadReplayFixture,
  scheduleSteps,
} from './fixtures/lifecycle-replay.mjs';
import {
  composeClaudeCronFireWakeFixture,
  composeClaudeMonitorEventWakeFixture,
  composeClaudeTwoAgentStopFixture,
  REPLAY_CRON_PROMPT,
  REPLAY_MONITOR_DESCRIPTION,
  REPLAY_TEXT,
  wakeReplyDelays,
} from './fixtures/lifecycle-replay-claude.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// The fake CLI replays its fixture only for this session and prompt.
const SESSION_ID = 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat';
const [WORKSPACE_ID, WORKTREE_ID, CHAT_ID] = SESSION_ID.split('/');
const PROMPT = 'Report Claude pressure status.';
const FAKE_CLI = fileURLToPath(
  new URL('./fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
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
// How long a surface may lag the committed runtime (invariant 10's grace).
const GRACE_MS = 5_000;

function logEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runtime(userDataDir) {
  const { live } = readChatStorageIndexes(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
  );
  return live.runtimeByChatId[CHAT_ID];
}

function liveNativeTasks(userDataDir) {
  return runtime(userDataDir)?.turn?.background?.native?.length ?? 0;
}

// A tab's working spinner is a bare "Thinking" spinner; the background glyph
// wraps the same spinner in an image named for its task count.
function tabWorking(tab) {
  return tab.locator('[aria-label="Thinking"]:not([role="img"] *)');
}

function tabBackground(tab, count) {
  const name =
    count === undefined
      ? 'running'
      : count === 1
        ? '1 background task running'
        : `${count} background tasks running`;
  return tab.locator(
    `[role="img"][aria-label${count === undefined ? '$' : ''}="${name}"]`,
  );
}

test('surfaces follow the runtime from a foreground turn through background-only work to idle', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-surfaces-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fakeCliLogPath = path.join(userDataDir, 'fake-claude-pressure.log');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
  const replayFixturePath = path.join(userDataDir, 'two-agent-fixture.json');
  writeFileSync(
    replayFixturePath,
    JSON.stringify(
      composeClaudeTwoAgentStopFixture({
        agentFixture: loadReplayFixture(
          path.join(LIFECYCLE_FIXTURE_DIR, 'agent-default-background.json'),
        ),
        interruptFixture: loadReplayFixture(
          path.join(
            LIFECYCLE_FIXTURE_DIR,
            'interrupt-with-background-agents.json',
          ),
        ),
        stopTaskFixture: loadReplayFixture(
          path.join(LIFECYCLE_FIXTURE_DIR, 'stop-task.json'),
        ),
      }),
    ),
  );
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
        title: 'Background surfaces chat',
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
    const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    const stop = panel.getByTestId('chat-stop-generation');
    const timer = panel.getByTestId('turn-timer').last();
    const tray = panel.getByTestId('composer-work-drawer');
    // Each native background agent is its own agent row (background drawer
    // Phase 04), with its task merged into it.
    const trayRows = tray.getByTestId('background-tray-agent');
    const stuckBanner = window.getByTestId('stuck-agent-warning');

    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot.getByRole('textbox').fill(PROMPT);
    await composerRoot.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        () =>
          logEntries(fakeCliLogPath).filter(
            (entry) => entry.type === 'task_started',
          ),
        { timeout: 60_000 },
      )
      .toHaveLength(2);

    // Foreground: the turn runs, so every surface shows a working turn.
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase)
      .toBe('foreground');
    await expect(stop).toBeVisible({ timeout: GRACE_MS });
    await expect(timer).toHaveAttribute('data-state', 'live');
    await expect(tabWorking(tab)).toBeVisible({ timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toBeVisible({ timeout: GRACE_MS });
    await expect(stuckBanner).toHaveCount(0);

    // Background: Stop ends the foreground turn and both agents keep running.
    await stop.click();
    await expect
      .poll(
        () =>
          logEntries(replayLogPath).filter(
            (entry) =>
              entry.kind === 'frame' &&
              entry.type === 'sdk:result:error_during_execution',
          ),
        { timeout: 30_000 },
      )
      .toHaveLength(1);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('background');
    expect(liveNativeTasks(userDataDir)).toBe(2);
    await expect(stop).toHaveCount(0, { timeout: GRACE_MS });
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: GRACE_MS });
    await expect(timer).toHaveAttribute('data-state', 'completed', {
      timeout: GRACE_MS,
    });
    await expect(tabWorking(tab)).toHaveCount(0, {
      timeout: GRACE_MS,
    });
    await expect(tabBackground(tab, 2)).toBeVisible({ timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0, { timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-background-spinner'),
    ).toBeVisible({ timeout: GRACE_MS });
    await expect(tray).toBeVisible({ timeout: GRACE_MS });
    await expect(stuckBanner).toHaveCount(0);

    // The tray lists both agents, once each; a row's Stop stops only the one
    // it names, through its task.
    await tray.getByTestId('composer-work-drawer-toggle').click();
    await expect(trayRows).toHaveCount(2, { timeout: GRACE_MS });
    await expect(tray.getByTestId('background-tray-row')).toHaveCount(0);
    const secondTaskId = logEntries(fakeCliLogPath).find(
      (entry) => entry.type === 'task_started' && entry.taskAlias === 'k2',
    ).taskId;
    await trayRows
      .filter({ hasText: 'Claude lifecycle replay agent 2' })
      .getByTestId('background-tray-agent-stop')
      .click();
    await expect
      .poll(
        () =>
          logEntries(fakeCliLogPath).filter(
            (entry) =>
              entry.type === 'control_request' && entry.subtype === 'stop_task',
          ),
        { timeout: 30_000 },
      )
      .toEqual([
        expect.objectContaining({
          subtype: 'stop_task',
          taskId: secondTaskId,
        }),
      ]);
    await expect
      .poll(() => liveNativeTasks(userDataDir), { timeout: 30_000 })
      .toBe(1);
    await expect(trayRows).toHaveCount(1, { timeout: GRACE_MS });
    await expect(tabBackground(tab, 1)).toBeVisible({ timeout: GRACE_MS });
    await expect(stop).toHaveCount(0);

    // Idle: the last agent finishes, and every background surface clears.
    writeFileSync(path.join(gatesDir, 'release-sibling-finish'), '');
    await expect
      .poll(
        () => logEntries(replayLogPath).some((entry) => entry.kind === 'done'),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('idle');
    await expect(tray).toHaveCount(0, { timeout: GRACE_MS });
    await expect(tabBackground(tab)).toHaveCount(0, { timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-background-spinner'),
    ).toHaveCount(0, { timeout: GRACE_MS });
    await expect(tabWorking(tab)).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    await expect(composerIdleAction(panel)).toBeVisible();
    await expect(stuckBanner).toHaveCount(0);
  } finally {
    writeFileSync(path.join(gatesDir, 'release-sibling-finish'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a background shell wake keeps the surfaces in step and opens its own boundary and timer', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-wake-surfaces-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fakeCliLogPath = path.join(userDataDir, 'fake-claude-pressure.log');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
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
        title: 'Background wake surfaces chat',
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
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.join(
          LIFECYCLE_FIXTURE_DIR,
          'background-bash-wake.json',
        ),
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify([
          'release-helper-finished',
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
    const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    const stop = panel.getByTestId('chat-stop-generation');
    const timers = panel.getByTestId('turn-timer');
    const tray = panel.getByTestId('composer-work-drawer');

    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot.getByRole('textbox').fill(PROMPT);
    await composerRoot.getByRole('button', { name: 'Send message' }).click();

    // Background: the root turn ended with the shell still running.
    await expect
      .poll(
        () =>
          logEntries(replayLogPath).some(
            (entry) =>
              entry.kind === 'gate' && entry.name === 'release-helper-finished',
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('background');
    expect(liveNativeTasks(userDataDir)).toBe(1);
    await expect(stop).toHaveCount(0, { timeout: GRACE_MS });
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: GRACE_MS });
    await expect(timers).toHaveCount(1);
    await expect(timers.first()).toHaveAttribute('data-state', 'completed', {
      timeout: GRACE_MS,
    });
    await expect(tabBackground(tab, 1)).toBeVisible({ timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-background-spinner'),
    ).toBeVisible({ timeout: GRACE_MS });
    await expect(tray).toBeVisible({ timeout: GRACE_MS });
    await expect(panel.getByTestId('wake-turn-boundary')).toHaveCount(0);

    // Wake: the shell finishes, and the agent continues on its own.
    writeFileSync(path.join(gatesDir, 'release-helper-finished'), '');
    await expect
      .poll(
        () => logEntries(replayLogPath).some((entry) => entry.kind === 'done'),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('idle');
    await expect(tray).toHaveCount(0, { timeout: GRACE_MS });
    await expect(tabBackground(tab)).toHaveCount(0, { timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-background-spinner'),
    ).toHaveCount(0, { timeout: GRACE_MS });
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0, { timeout: GRACE_MS });
    await expect(stop).toHaveCount(0);

    // The wake has its own boundary row and its own completed timer.
    const boundary = panel.getByTestId('wake-turn-boundary');
    await expect(boundary).toHaveCount(1, { timeout: GRACE_MS });
    await expect(boundary).toContainText('Continued after');
    await expect(timers).toHaveCount(2, { timeout: GRACE_MS });
    for (const timer of await timers.all())
      await expect(timer).toHaveAttribute('data-state', 'completed');
    const timerBlocks = readChatStorageMessages(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
      CHAT_ID,
    )
      .flatMap((message) => message.blocks ?? [])
      .filter((block) => block.type === 'turn_timer');
    expect(timerBlocks).toHaveLength(2);
    expect(timerBlocks[0].spawnedBy).toBeUndefined();
    expect(timerBlocks[1].spawnedBy).toEqual({
      taskId: expect.any(String),
      toolUseId: expect.any(String),
    });

    // "Show where it started" brings the prompt that spawned the shell back.
    const prompt = panel.getByText(PROMPT, { exact: true });
    const showSpawningTurn = boundary.getByTestId(
      'wake-turn-boundary-show-spawning-turn',
    );
    await expect(showSpawningTurn).toBeVisible();
    await showSpawningTurn.click();
    await expect(prompt).toBeInViewport({ timeout: GRACE_MS });
  } finally {
    writeFileSync(path.join(gatesDir, 'release-helper-finished'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a Monitor event wakes its own named turn, and its link brings the Monitor call into view', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-monitor-event-wake-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fixturePath = path.join(userDataDir, 'monitor-event-wake.json');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
  mkdirSync(gatesDir);
  copyFileSync(FAKE_CLI, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  // The root turn starts a shell and a Monitor; the Monitor's event wakes a
  // turn before the shell's own wake.
  const fixture = composeClaudeMonitorEventWakeFixture({
    wakeFixture: loadReplayFixture(
      path.join(LIFECYCLE_FIXTURE_DIR, 'background-bash-wake.json'),
    ),
  });
  writeFileSync(fixturePath, JSON.stringify(fixture));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Monitor event wake chat',
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
        CANOPY_CLAUDE_PRESSURE_LOG: path.join(userDataDir, 'fake.log'),
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: fixturePath,
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify([
          'release-monitor-event',
          'release-helper-finished',
        ]),
        CANOPY_LIFECYCLE_REPLAY_DELAYS: JSON.stringify(
          wakeReplyDelays(fixture),
        ),
      },
    }),
  );
  const release = async (gate) => {
    await expect
      .poll(
        () =>
          logEntries(replayLogPath).some(
            (entry) => entry.kind === 'gate' && entry.name === gate,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    writeFileSync(path.join(gatesDir, gate), '');
  };

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
    await release('release-monitor-event');
    await release('release-helper-finished');

    const timers = panel.getByTestId('turn-timer');
    await expect(timers).toHaveCount(3, { timeout: 30_000 });
    for (const timer of await timers.all())
      await expect(timer).toHaveAttribute('data-state', 'completed');

    // Each turn holds its own reply and is closed by its own single timer, in
    // order: the prompt's, the Monitor event's, then the shell's.
    const order = await panel.evaluate(
      (root, replyText) =>
        Array.from(root.querySelectorAll('*')).flatMap((element) => {
          const testId = element.getAttribute('data-testid');
          if (testId === 'turn-timer') return ['timer'];
          if (testId === 'wake-turn-boundary')
            return [
              (element.textContent ?? '').includes('an event from')
                ? 'event'
                : 'wake',
            ];
          return element.children.length === 0 &&
            element.textContent === replyText
            ? ['reply']
            : [];
        }),
      REPLAY_TEXT,
    );
    expect(order).toEqual([
      'reply',
      'timer',
      'event',
      'reply',
      'timer',
      'wake',
      'reply',
      'timer',
    ]);
    const boundaries = panel.getByTestId('wake-turn-boundary');
    await expect(boundaries.first()).toContainText(
      `Continued after an event from ${REPLAY_MONITOR_DESCRIPTION}`,
    );
    await expect(boundaries.nth(1)).toContainText('finished');
    await expect(panel.getByText(REPLAY_TEXT, { exact: true })).toHaveCount(3);

    const timerBlocks = readChatStorageMessages(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
      CHAT_ID,
    )
      .flatMap((message) => message.blocks ?? [])
      .filter((block) => block.type === 'turn_timer');
    expect(timerBlocks.map((block) => block.spawnedBy)).toEqual([
      undefined,
      {
        taskId: expect.any(String),
        toolUseId: expect.any(String),
        event: true,
      },
      { taskId: expect.any(String), toolUseId: expect.any(String) },
    ]);

    // "Show where it started" opens the prompt's turn and brings the Monitor
    // call itself into view, highlighting only that row.
    const monitorCall = panel.locator(
      `[data-tool-use-id="${timerBlocks[1].spawnedBy.toolUseId}"]`,
    );
    await expect(monitorCall).toHaveCount(0);
    await boundaries
      .first()
      .getByTestId('wake-turn-boundary-show-spawning-turn')
      .click();
    await expect(monitorCall).toBeInViewport({ timeout: GRACE_MS });
    await expect(monitorCall).toHaveAttribute('data-chat-call-focus', 'true');
    await expect(panel.locator('[data-chat-turn-focus]')).toHaveCount(0);
  } finally {
    writeFileSync(path.join(gatesDir, 'release-monitor-event'), '');
    writeFileSync(path.join(gatesDir, 'release-helper-finished'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});

test("a cron job's fire heads its own turn named for its prompt, and its link brings the CronCreate call into view", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cron-fire-wake-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fixturePath = path.join(userDataDir, 'cron-fire-wake.json');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
  mkdirSync(gatesDir);
  copyFileSync(FAKE_CLI, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  // The root turn starts a shell and schedules a one-shot prompt; the
  // prompt's fire starts a turn before the shell's own wake. The fire reports
  // no prompt and no origin, as the CLI does.
  const fixture = composeClaudeCronFireWakeFixture({
    wakeFixture: loadReplayFixture(
      path.join(LIFECYCLE_FIXTURE_DIR, 'background-bash-wake.json'),
    ),
  });
  writeFileSync(fixturePath, JSON.stringify(fixture));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Cron fire wake chat',
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
        CANOPY_CLAUDE_PRESSURE_LOG: path.join(userDataDir, 'fake.log'),
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: fixturePath,
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify([
          'release-cron-fire',
          'release-helper-finished',
        ]),
        CANOPY_LIFECYCLE_REPLAY_DELAYS: JSON.stringify(
          wakeReplyDelays(fixture),
        ),
      },
    }),
  );
  const release = async (gate) => {
    await expect
      .poll(
        () =>
          logEntries(replayLogPath).some(
            (entry) => entry.kind === 'gate' && entry.name === gate,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    writeFileSync(path.join(gatesDir, gate), '');
  };

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
    await release('release-cron-fire');
    await release('release-helper-finished');

    const timers = panel.getByTestId('turn-timer');
    await expect(timers).toHaveCount(3, { timeout: 30_000 });
    for (const timer of await timers.all())
      await expect(timer).toHaveAttribute('data-state', 'completed');

    // Each turn holds its own reply and is closed by its own single timer, in
    // order: the prompt's, the cron fire's, then the shell's.
    const order = await panel.evaluate(
      (root, replyText) =>
        Array.from(root.querySelectorAll('*')).flatMap((element) => {
          const testId = element.getAttribute('data-testid');
          if (testId === 'turn-timer') return ['timer'];
          if (testId === 'wake-turn-boundary')
            return [
              (element.textContent ?? '').includes('scheduled prompt')
                ? 'scheduled'
                : 'wake',
            ];
          return element.children.length === 0 &&
            element.textContent === replyText
            ? ['reply']
            : [];
        }),
      REPLAY_TEXT,
    );
    expect(order).toEqual([
      'reply',
      'timer',
      'scheduled',
      'reply',
      'timer',
      'wake',
      'reply',
      'timer',
    ]);
    const boundaries = panel.getByTestId('wake-turn-boundary');
    await expect(boundaries.first()).toContainText(
      `Continued for the scheduled prompt ${REPLAY_CRON_PROMPT}`,
    );
    await expect(boundaries.nth(1)).toContainText('finished');
    await expect(panel.getByText(REPLAY_TEXT, { exact: true })).toHaveCount(3);

    const timerBlocks = readChatStorageMessages(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
      CHAT_ID,
    )
      .flatMap((message) => message.blocks ?? [])
      .filter((block) => block.type === 'turn_timer');
    expect(timerBlocks.map((block) => block.spawnedBy)).toEqual([
      undefined,
      { toolUseId: expect.any(String), scheduled: true },
      { taskId: expect.any(String), toolUseId: expect.any(String) },
    ]);

    // "Show where it started" opens the prompt's turn and brings the
    // CronCreate call itself into view, named as a scheduled prompt.
    const cronCall = panel.locator(
      `[data-tool-use-id="${timerBlocks[1].spawnedBy.toolUseId}"]`,
    );
    await expect(cronCall).toHaveCount(0);
    await boundaries
      .first()
      .getByTestId('wake-turn-boundary-show-spawning-turn')
      .click();
    await expect(cronCall).toBeInViewport({ timeout: GRACE_MS });
    await expect(cronCall).toHaveAttribute('data-chat-call-focus', 'true');
    await expect(cronCall).toContainText('Schedule prompt');
    await expect(cronCall).toContainText(REPLAY_CRON_PROMPT);
    await expect(panel.locator('[data-chat-turn-focus]')).toHaveCount(0);
  } finally {
    writeFileSync(path.join(gatesDir, 'release-cron-fire'), '');
    writeFileSync(path.join(gatesDir, 'release-helper-finished'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a background chat with a running agent shows one completion notice, after its wake', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-held-completion-notice-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const fakeCliLogPath = path.join(userDataDir, 'fake-claude-pressure.log');
  const replayLogPath = path.join(userDataDir, 'claude-lifecycle-replay.jsonl');
  const gatesDir = path.join(userDataDir, 'gates');
  const fixturePath = path.join(
    LIFECYCLE_FIXTURE_DIR,
    'background-agent-wake.json',
  );
  // Hold the root result until the chat is in the background, so a notice
  // is due at all (the active chat shows none).
  const rootResultIndex = scheduleSteps(loadReplayFixture(fixturePath)).find(
    ({ step }) => step.kind === 'frame' && step.type === 'sdk:result:success',
  ).index;
  const rootResultGate = `before-${String(rootResultIndex)}`;
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
        title: 'Held notice chat',
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
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: fixturePath,
        CANOPY_LIFECYCLE_REPLAY_MODULE: REPLAY_MODULE,
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify([
          rootResultGate,
          'release-child-finish',
        ]),
      },
    }),
  );

  const reachedGate = (name) =>
    logEntries(replayLogPath).some(
      (entry) => entry.kind === 'gate' && entry.name === name,
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
      .poll(() => reachedGate(rootResultGate), { timeout: 60_000 })
      .toBe(true);

    // The chat goes to the background before its root turn ends.
    await app.openOverviewPage();
    await expect(window.getByTestId('overview-page')).toBeVisible();
    // The Overview lists every completion notice it receives; a toast may
    // auto-dismiss before the wake's end is observed.
    const notices = window
      .getByTestId('overview-notification-card')
      .filter({ hasText: 'Held notice chat' });

    // The root turn ends while the agent runs: the notice is held. A shell
    // alone holds nothing: it doesn't keep the chat from closing (36d, 38c).
    writeFileSync(path.join(gatesDir, rootResultGate), '');
    await expect
      .poll(() => reachedGate('release-child-finish'), { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('background');
    // Notices render within a frame of the result; give a held one time to
    // show if it wrongly would.
    await window.waitForTimeout(3_000);
    await expect(notices).toHaveCount(0);

    // The agent finishes and the wake ends: the notice shows once.
    writeFileSync(path.join(gatesDir, 'release-child-finish'), '');
    await expect
      .poll(
        () => logEntries(replayLogPath).some((entry) => entry.kind === 'done'),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => runtime(userDataDir)?.turn?.phase, { timeout: 30_000 })
      .toBe('idle');
    await expect(notices).toHaveCount(1, { timeout: 15_000 });
    await window.waitForTimeout(3_000);
    await expect(notices).toHaveCount(1);
  } finally {
    writeFileSync(path.join(gatesDir, rootResultGate), '');
    writeFileSync(path.join(gatesDir, 'release-child-finish'), '');
    await closeCanopy(electronApp, userDataDir);
  }
});
