import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

// ---------------------------------------------------------------------------
// Agent Background Processes in the chat's Agent activity section.
//
// Background work used to be visible only in the Agent Background Processes
// activity-panel card, so a chat that launched a background task showed no
// trace of it in the transcript. The turn that launched a process now carries
// it in its own Agent activity section, rendered with the same shared card
// body the panel uses and read from the same activity store.
//
// What this drives, end to end through the real canonical ingress:
//
//   (a) a background Bash tool use inside an open turn surfaces in that
//       turn's active Agent activity section;
//   (b) the launch result promotes it to `running` with a Stop affordance;
//   (c) the same process is simultaneously in the Agent Background Processes
//       panel card — one source, two surfaces;
//   (d) completing the turn keeps the process attached to its own turn in the
//       completed section;
//   (e) a terminal task notification folds it into the collapsed Stopped
//       group, exactly as the panel card does.
//
// Determinism: no live agents, no network. Every event goes through the E2E
// chat-event ingress (`__CANOPY_E2E_INGEST_CHAT_EVENT__`), which commits
// through `ChatStateService` exactly as a real provider session does.
//
// The cases after the first one cover stale-card resolution: the
// panel and the transcript used to show background processes as `running`
// forever once the provider session that owned them went away. They drive
//
//   * foreground tasks never becoming cards at all;
//   * the synthetic `session_ended` terminal notification main emits when a
//     chat's CLI process dies with live tasks;
//   * hydration of a transcript whose background launch has no terminal
//     bookend, which must resolve to Stopped rather than `running`;
//   * the detail modal's post-terminal flush and its captured-output
//     fallback when the output file is gone;
//   * Stop on a process whose provider session no longer exists;
//   * and the opposite guarantee — a process the session still reports live
//     must SURVIVE its turn completing.
//
// `applyE2eIngestedLiveBackgroundTaskEvent` (main, build-time gated) reduces
// injected `system` events through main's own live background-task rules, so
// `activity:list-live-bg-tasks` answers for an injected chat the way it does
// for a real session. A chat that injects no `system` event has no live-task
// entry at all, which is exactly the "session is gone" shape the stale-card
// cases need.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'bg-process-chat';
const TURN_ID = 'bg-process-turn-user';
const TOOL_USE_ID = 'bg-process-bash-1';
const TASK_ID = 'bg-task-1';
const COMMAND = 'npm run dev';
const TURN_STARTED_AT = Date.parse('2026-09-21T12:00:00.000Z');

test('a turn that launches a background process shows it in Agent activity and the panel card', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-bg-process-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Background processes' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();

    const inject = (data) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        providerType: 'claude',
        turnUserMessageId: TURN_ID,
        data: { ...data, canopy_turn_user_message_id: TURN_ID },
      });

    // (a) Open an in-flight turn, then launch the background process from it.
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 2,
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [
              { type: 'text', text: 'Start the dev server in the background.' },
            ],
          },
          {
            id: `${TURN_ID}-timer`,
            role: 'system',
            timestamp: TURN_STARTED_AT + 1_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: TURN_STARTED_AT,
                completedAt: null,
              },
            ],
          },
        ],
      },
    });
    await expect(
      panel.getByText('Start the dev server in the background.'),
    ).toBeVisible({ timeout: 30_000 });
    await inject({
      type: 'assistant',
      message: {
        id: 'bg-process-assistant',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Bash',
            input: {
              command: COMMAND,
              description: COMMAND,
              run_in_background: true,
            },
          },
        ],
      },
    });

    const activeSection = panel.getByTestId('agent-activity-active');
    await expect(activeSection).toBeVisible({ timeout: 30_000 });
    const activeProcesses = activeSection.getByTestId(
      'agent-activity-background-process-items',
    );
    await expect(activeProcesses).toBeVisible();
    const activeCard = activeProcesses.getByTestId('activity-bg-item');
    await expect(activeCard).toHaveCount(1);
    await expect(activeCard).toContainText(COMMAND);

    // (b) The launch result carries the task id, which is what makes the
    // process stoppable.
    await inject({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: `Command running in background with ID: ${TASK_ID}`,
          },
        ],
      },
    });
    await expect(activeCard).toContainText('running');
    await expect(activeProcesses.getByTestId('activity-bg-stop')).toBeVisible();

    // (c) Same process, same store, in the Agent Background Processes card.
    const panelSection = window.getByTestId(
      'activity-section-background-processes',
    );
    await panelSection.scrollIntoViewIfNeeded();
    await expect(panelSection).toContainText(COMMAND);

    // (d) A terminal notification folds the live card into the Stopped
    // group, with the panel card's own collapsed presentation.
    await inject({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      status: 'completed',
      summary: 'Dev server exited.',
    });
    const stoppedToggle = activeProcesses.getByTestId(
      'activity-bg-stopped-toggle',
    );
    await expect(stoppedToggle).toBeVisible({ timeout: 30_000 });
    await expect(stoppedToggle).toContainText('Stopped (1)');
    await stoppedToggle.click();
    await expect(activeProcesses.getByTestId('activity-bg-item')).toContainText(
      'Dev server exited.',
    );

    // (e) Completing the turn keeps the process on the turn that launched it,
    // now in that turn's completed Agent activity section.
    await inject({ type: 'result', is_error: false, result: 'Started' });
    const completedSection = panel
      .getByTestId('agent-activity-completed')
      .first();
    await expect(completedSection).toBeVisible({ timeout: 30_000 });
    await expect(
      completedSection
        .getByTestId('agent-activity-background-process-items')
        .getByTestId('activity-bg-stopped-toggle'),
    ).toContainText('Stopped (1)');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// ---------------------------------------------------------------------------
// Shared setup for the stale-card cases below.
// ---------------------------------------------------------------------------

function seedWorkspace(prefix, chatId, tabs) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: tabs ?? [{ id: chatId, title: 'Background processes' }],
  });
  return userDataDir;
}

async function openWorktree(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return { window, app, panel };
}

/** Inject one provider event into `chatId`, attributed to `turnId`. */
function turnInjector(electronApp, chatId, turnId) {
  return (data) =>
    injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      providerType: 'claude',
      turnUserMessageId: turnId,
      data: { ...data, canopy_turn_user_message_id: turnId },
    });
}

/** Open an in-flight turn the way the first case does, and wait for it. */
async function startTurn(electronApp, panel, { chatId, turnId, prompt }) {
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId,
    data: {
      type: 'claude_terminal_transcript_sync',
      importedEventCount: 2,
      messages: [
        {
          id: turnId,
          role: 'user',
          timestamp: TURN_STARTED_AT,
          blocks: [{ type: 'text', text: prompt }],
        },
        {
          id: `${turnId}-timer`,
          role: 'system',
          timestamp: TURN_STARTED_AT + 1_000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: TURN_STARTED_AT,
              completedAt: null,
            },
          ],
        },
      ],
    },
  });
  await expect(panel.getByText(prompt)).toBeVisible({ timeout: 30_000 });
}

function bashToolUse({ toolUseId, command, background }) {
  return {
    type: 'assistant',
    message: {
      id: `${toolUseId}-message`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: {
            command,
            description: command,
            ...(background ? { run_in_background: true } : {}),
          },
        },
      ],
    },
  };
}

function bashToolResult({ toolUseId, content }) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  };
}

/** The Agent Background Processes activity-panel card, scrolled into view. */
async function backgroundProcessesPanelCard(window) {
  const section = window.getByTestId('activity-section-background-processes');
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.scrollIntoViewIfNeeded();
  return section;
}

/** Expand the collapsed Stopped group and return its cards. */
async function expandStopped(scope, expectedCount) {
  const toggle = scope.getByTestId('activity-bg-stopped-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toContainText(`Stopped (${expectedCount})`);
  await toggle.click();
  return scope.getByTestId('activity-bg-item');
}

test('a foreground task never becomes a background-process card, while a backgrounded one in the same turn does', async () => {
  const CHAT = 'foreground-task-chat';
  const TURN = 'foreground-task-turn';
  const FOREGROUND_TOOL_USE = 'foreground-bash-1';
  const FOREGROUND_TASK = 'foreground-task-1';
  const FOREGROUND_COMMAND = 'npm run test:unit';
  const BACKGROUND_TOOL_USE = 'backgrounded-bash-1';
  const BACKGROUND_TASK = 'backgrounded-task-1';
  const BACKGROUND_COMMAND = 'tail -f build.log';
  const userDataDir = seedWorkspace('canopy-bg-foreground-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Run the tests, then watch the build log.',
    });

    // A normal foreground Bash call. The SDK reports task lifecycle for these
    // too, with `is_backgrounded: false` — and they must not become cards.
    await inject(
      bashToolUse({
        toolUseId: FOREGROUND_TOOL_USE,
        command: FOREGROUND_COMMAND,
        background: false,
      }),
    );
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: FOREGROUND_TASK,
      tool_use_id: FOREGROUND_TOOL_USE,
      is_backgrounded: false,
      description: FOREGROUND_COMMAND,
    });
    await inject(
      bashToolResult({
        toolUseId: FOREGROUND_TOOL_USE,
        content: 'Test Suites: 1 passed, 1 total',
      }),
    );

    // Same turn, an explicitly backgrounded call. Its card is the anchor that
    // proves the ingress and the store are working, so the absence of a
    // foreground card is a real exclusion rather than a dead pipeline.
    await inject(
      bashToolUse({
        toolUseId: BACKGROUND_TOOL_USE,
        command: BACKGROUND_COMMAND,
        background: true,
      }),
    );
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: BACKGROUND_TASK,
      tool_use_id: BACKGROUND_TOOL_USE,
      is_backgrounded: true,
      description: BACKGROUND_COMMAND,
    });
    await inject(
      bashToolResult({
        toolUseId: BACKGROUND_TOOL_USE,
        content: `Command running in background with ID: ${BACKGROUND_TASK}`,
      }),
    );

    const section = await backgroundProcessesPanelCard(window);
    const panelCards = section.getByTestId('activity-bg-item');
    await expect(panelCards).toHaveCount(1);
    await expect(panelCards).toContainText(BACKGROUND_COMMAND);
    await expect(section).not.toContainText(FOREGROUND_COMMAND);

    const turnProcesses = panel
      .getByTestId('agent-activity-background-process-items')
      .first();
    await expect(turnProcesses.getByTestId('activity-bg-item')).toHaveCount(1);
    await expect(turnProcesses).toContainText(BACKGROUND_COMMAND);
    await expect(turnProcesses).not.toContainText(FOREGROUND_COMMAND);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a background agent stays in its subagent block, not Agent activity, while the panel still lists it', async () => {
  const CHAT = 'background-agent-chat';
  const TURN = 'background-agent-turn';
  const AGENT_TOOL_USE = 'background-agent-1';
  const AGENT_DESCRIPTION = 'Investigate delegation Windows gaps';
  const BASH_TOOL_USE = 'background-agent-bash-1';
  const BASH_TASK = 'background-agent-bash-task-1';
  const BASH_COMMAND = 'npm run dev';
  const userDataDir = seedWorkspace('canopy-bg-agent-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Investigate in the background and start the dev server.',
    });

    await inject({
      type: 'assistant',
      message: {
        id: `${AGENT_TOOL_USE}-message`,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: AGENT_TOOL_USE,
            name: 'Agent',
            input: {
              subagent_type: 'Explore',
              description: AGENT_DESCRIPTION,
              prompt: 'Look for Windows gaps in delegation.',
              run_in_background: true,
            },
          },
        ],
      },
    });
    await inject(
      bashToolUse({
        toolUseId: BASH_TOOL_USE,
        command: BASH_COMMAND,
        background: true,
      }),
    );
    await inject(
      bashToolResult({
        toolUseId: BASH_TOOL_USE,
        content: `Command running in background with ID: ${BASH_TASK}`,
      }),
    );

    // The background agent is tracked: the panel card lists both processes.
    const section = await backgroundProcessesPanelCard(window);
    await expect(section.getByTestId('activity-bg-item')).toHaveCount(2);
    await expect(section).toContainText(AGENT_DESCRIPTION);
    await expect(section).toContainText(BASH_COMMAND);

    // Agent activity already shows the agent through its dedicated subagent
    // row, so it keeps that row and the Bash card but drops the redundant
    // agent process card.
    const activeSection = panel.getByTestId('agent-activity-active');
    await expect(activeSection.getByTestId('agent-block')).toContainText(
      AGENT_DESCRIPTION,
    );
    const turnProcesses = activeSection.getByTestId(
      'agent-activity-background-process-items',
    );
    await expect(turnProcesses.getByTestId('activity-bg-item')).toHaveCount(1);
    await expect(turnProcesses).toContainText(BASH_COMMAND);
    await expect(turnProcesses).not.toContainText(AGENT_DESCRIPTION);
    await expect(activeSection).toContainText('2 items');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a running background process folds into Stopped when its chat session ends', async () => {
  const CHAT = 'session-ended-chat';
  const TURN = 'session-ended-turn';
  const TOOL_USE = 'session-ended-bash-1';
  const TASK = 'session-ended-task-1';
  const COMMAND_TEXT = 'node scripts/watch.mjs';
  const userDataDir = seedWorkspace('canopy-bg-session-ended-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Watch the source tree in the background.',
    });

    await inject(
      bashToolUse({
        toolUseId: TOOL_USE,
        command: COMMAND_TEXT,
        background: true,
      }),
    );
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: TASK,
      tool_use_id: TOOL_USE,
      is_backgrounded: true,
      description: COMMAND_TEXT,
    });
    await inject(
      bashToolResult({
        toolUseId: TOOL_USE,
        content: `Command running in background with ID: ${TASK}`,
      }),
    );

    const section = await backgroundProcessesPanelCard(window);
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      'running',
    );
    await expect(section.getByTestId('activity-bg-stop')).toBeVisible();

    // The exact notification main mints for every task still live when a
    // chat's CLI process goes away (`buildSessionEndedTaskNotification`).
    // Delivered here through the deterministic ingress while the turn is still
    // open, which is the real shape of the failure: the process dies mid-turn
    // and the provider never sends a terminal bookend of its own.
    await inject({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK,
      tool_use_id: TOOL_USE,
      description: COMMAND_TEXT,
      status: 'stopped',
      reason: 'session_ended',
      summary: 'Stopped when the chat session ended',
      canopy_synthetic: true,
    });

    const stoppedCards = await expandStopped(section, 1);
    await expect(stoppedCards).toContainText(
      'Stopped when the chat session ended',
    );
    await expect(stoppedCards).toContainText('stopped');
    await expect(section.getByTestId('activity-bg-stop')).toHaveCount(0);

    const turnProcesses = panel
      .getByTestId('agent-activity-background-process-items')
      .first();
    await expect(await expandStopped(turnProcesses, 1)).toContainText(
      'Stopped when the chat session ended',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a persisted background launch with no terminal event loads as Stopped, not running', async () => {
  const CHAT = 'hydrated-bg-chat';
  const TURN = 'hydrated-bg-turn';
  const TOOL_USE = 'hydrated-bg-bash-1';
  const TASK = 'hydrated-bg-task-1';
  const COMMAND_TEXT = 'python -m http.server 8123';
  const OUTPUT_FILE = path.join(os.tmpdir(), `canopy-bg-hydrated-${TASK}.log`);

  // A transcript that records the launch and nothing else: the provider
  // session died before any terminal notification was written, which is what
  // used to rebuild as a permanently `running` card on every load.
  const userDataDir = seedWorkspace('canopy-bg-hydration-', CHAT, [
    {
      id: CHAT,
      title: 'Hydrated background launch',
      messages: [
        {
          id: TURN,
          role: 'user',
          timestamp: TURN_STARTED_AT,
          blocks: [{ type: 'text', text: 'Serve the docs in the background.' }],
        },
        {
          id: `${TURN}-assistant`,
          role: 'assistant',
          timestamp: TURN_STARTED_AT + 1_000,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: TOOL_USE,
              toolName: 'Bash',
              input: JSON.stringify({
                command: COMMAND_TEXT,
                description: COMMAND_TEXT,
                run_in_background: true,
              }),
            },
            {
              type: 'tool_result',
              toolUseId: TOOL_USE,
              toolName: 'Bash',
              output: `Command running in background with ID: ${TASK}. Output is being written to: ${OUTPUT_FILE}.`,
              isError: false,
            },
          ],
        },
      ],
    },
  ]);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window } = await openWorktree(electronApp);
    const section = await backgroundProcessesPanelCard(window);

    // No provider session exists for this chat, so `list-live-bg-tasks` cannot
    // account for the task and the rebuilt row must resolve to Stopped.
    const stoppedCards = await expandStopped(section, 1);
    await expect(stoppedCards).toContainText(
      'Ended before completion was recorded',
    );
    await expect(stoppedCards).toContainText(COMMAND_TEXT);
    await expect(section.getByTestId('activity-bg-stop')).toHaveCount(0);
    await expect(section.getByTestId('activity-bg-item')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the detail modal flushes final output, then falls back to captured output when the file is gone', async () => {
  const CHAT = 'bg-modal-chat';
  const TURN = 'bg-modal-turn';
  const TOOL_USE = 'bg-modal-bash-1';
  const TASK = 'bg-modal-task-1';
  const COMMAND_TEXT = 'bash scripts/seed.sh';
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-bg-output-'));
  const outputFile = path.join(outputDir, 'task.output');
  writeFileSync(outputFile, 'seed-line-one\n', 'utf8');

  const userDataDir = seedWorkspace('canopy-bg-modal-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Seed the database in the background.',
    });

    await inject(
      bashToolUse({
        toolUseId: TOOL_USE,
        command: COMMAND_TEXT,
        background: true,
      }),
    );
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: TASK,
      tool_use_id: TOOL_USE,
      is_backgrounded: true,
      description: COMMAND_TEXT,
    });
    // The launch receipt is the only place the output file is named, so this is
    // what starts main's output poller for the task.
    await inject(
      bashToolResult({
        toolUseId: TOOL_USE,
        content: `Command running in background with ID: ${TASK}. Output is being written to: ${outputFile}.`,
      }),
    );

    const section = await backgroundProcessesPanelCard(window);
    const card = section.getByTestId('activity-bg-item');
    await expect(card).toContainText('running');

    await card.click();
    const modal = window.getByTestId('bg-process-detail-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal).toContainText(outputFile);
    // Read straight off disk when the modal opened.
    await expect(modal).toContainText('seed-line-one');
    await expect(modal.getByTestId('bg-process-output-notice')).toHaveCount(0);

    // Output written while the modal is open arrives over the live
    // subscription (main polls the file every 1.5s).
    appendFileSync(outputFile, 'seed-line-two\n', 'utf8');
    await expect(modal).toContainText('seed-line-two', { timeout: 30_000 });

    // The last writes land AFTER the terminal notification. The modal holds
    // its subscription open across the store's flush window and then re-reads
    // the finished file, so neither the streamed tail nor the file tail is
    // lost.
    appendFileSync(outputFile, 'seed-line-final\n', 'utf8');
    await inject({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK,
      tool_use_id: TOOL_USE,
      status: 'completed',
      summary: 'Seeding finished.',
      output_file: outputFile,
    });
    await expect(modal).toContainText('completed', { timeout: 30_000 });
    await expect(modal).toContainText('seed-line-final', { timeout: 30_000 });
    await expect(modal).toContainText('seed-line-one');

    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // A finished task's temp file is eventually swept. Reopening must show the
    // output the store captured while the task ran, labelled as such, instead
    // of an empty pane.
    rmSync(outputFile, { force: true });
    const stoppedCards = await expandStopped(section, 1);
    await stoppedCards.click();
    const reopened = window.getByTestId('bg-process-detail-modal');
    await expect(reopened).toBeVisible({ timeout: 30_000 });
    const notice = reopened.getByTestId('bg-process-output-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Showing captured output only');
    await expect(notice).toContainText("The output file couldn't be read.");
    await expect(reopened).toContainText('seed-line-two');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('Stop on a process whose chat has no provider session resolves and moves the card to Stopped', async () => {
  const CHAT = 'bg-stop-no-session-chat';
  const TURN = 'bg-stop-no-session-turn';
  const TOOL_USE = 'bg-stop-bash-1';
  const TASK = 'bg-stop-task-1';
  const COMMAND_TEXT = 'node scripts/long-job.mjs';
  const userDataDir = seedWorkspace('canopy-bg-stop-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Kick off the long job in the background.',
    });

    // Deliberately no `system` event for this chat: main has no live-task
    // entry for it, which is exactly the state a chat is in once its provider
    // session has gone away while the card still says `running`.
    await inject(
      bashToolUse({
        toolUseId: TOOL_USE,
        command: COMMAND_TEXT,
        background: true,
      }),
    );
    await inject(
      bashToolResult({
        toolUseId: TOOL_USE,
        content: `Command running in background with ID: ${TASK}`,
      }),
    );

    const section = await backgroundProcessesPanelCard(window);
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      'running',
    );

    const stop = section.getByTestId('activity-bg-stop');
    await expect(stop).toBeVisible();
    await stop.click();

    // The stop request cannot reach a provider, and it must still clear the
    // card rather than rejecting and leaving it `running` forever.
    const stoppedCards = await expandStopped(section, 1);
    await expect(stoppedCards).toContainText('stopped');
    await expect(stoppedCards).toContainText(COMMAND_TEXT);
    await expect(section.getByTestId('activity-bg-stop')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The panel card and the transcript's Agent activity card are both the
// shared ui-app BackgroundTasksList with its shared detail modal, driven by
// the same desktop host actions. Opening the modal from the transcript and
// stopping from inside it must settle the card on both surfaces.
test('Stop from the detail modal opened in Agent activity settles the card in both lists', async () => {
  const CHAT = 'bg-modal-stop-chat';
  const TURN = 'bg-modal-stop-turn';
  const TOOL_USE = 'bg-modal-stop-bash-1';
  const TASK = 'bg-modal-stop-task-1';
  const COMMAND_TEXT = 'npm run watch:types';
  const userDataDir = seedWorkspace('canopy-bg-modal-stop-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Watch the types in the background.',
    });
    // No `system` event: the chat has no live provider session, so Stop
    // resolves locally instead of reaching a provider.
    await inject(
      bashToolUse({
        toolUseId: TOOL_USE,
        command: COMMAND_TEXT,
        background: true,
      }),
    );
    await inject(
      bashToolResult({
        toolUseId: TOOL_USE,
        content: `Command running in background with ID: ${TASK}`,
      }),
    );

    const activity = panel
      .getByTestId('agent-activity-active')
      .getByTestId('agent-activity-background-process-items');
    const transcriptCard = activity.getByTestId('activity-bg-item');
    await expect(transcriptCard).toContainText('running', { timeout: 30_000 });
    const section = await backgroundProcessesPanelCard(window);
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      COMMAND_TEXT,
    );

    await transcriptCard.click();
    const modal = window.getByTestId('bg-process-detail-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal).toContainText(COMMAND_TEXT);
    await expect(modal).toContainText('bash · running');
    await expect(modal).toContainText(TASK);
    const modalStop = modal.getByRole('button', { name: 'Stop' });
    await expect(modalStop).toBeVisible();
    await modalStop.click();

    // The modal follows the task to its terminal status and drops Stop.
    await expect(modal).toContainText('bash · stopped', { timeout: 30_000 });
    await expect(modal.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // Both lists fold the stopped card away from their active cards.
    for (const scope of [activity, section]) {
      const stopped = await expandStopped(scope, 1);
      await expect(stopped).toContainText('stopped');
      await expect(stopped).toContainText(COMMAND_TEXT);
      await expect(scope.getByTestId('activity-bg-stop')).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a background process the session still reports live survives its turn completing', async () => {
  const CHAT = 'bg-live-chat';
  const TURN = 'bg-live-turn';
  const TOOL_USE = 'bg-live-bash-1';
  const TASK = 'bg-live-task-1';
  const COMMAND_TEXT = 'npm run watch:types';
  const userDataDir = seedWorkspace('canopy-bg-live-', CHAT);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, panel } = await openWorktree(electronApp);
    const inject = turnInjector(electronApp, CHAT, TURN);
    await startTurn(electronApp, panel, {
      chatId: CHAT,
      turnId: TURN,
      prompt: 'Watch the types in the background.',
    });

    await inject(
      bashToolUse({
        toolUseId: TOOL_USE,
        command: COMMAND_TEXT,
        background: true,
      }),
    );
    // Registers the task as live for this chat in main, so
    // `activity:list-live-bg-tasks` can account for it.
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: TASK,
      tool_use_id: TOOL_USE,
      is_backgrounded: true,
      description: COMMAND_TEXT,
    });
    await inject(
      bashToolResult({
        toolUseId: TOOL_USE,
        content: `Command running in background with ID: ${TASK}`,
      }),
    );

    const section = await backgroundProcessesPanelCard(window);
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      'running',
    );

    // Completing the turn runs the full resolution pass. A live task must come
    // out of it untouched — the stale-card repair must not reap real work.
    await inject({ type: 'result', is_error: false, result: 'Watching' });
    await expect(
      panel.getByTestId('agent-activity-completed').first(),
    ).toBeVisible({ timeout: 30_000 });

    // The resolution pass is asynchronous (an audit-trail read plus the
    // live-task IPC), so re-assert after it has had time to land: passing
    // instantly would prove nothing.
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      'running',
    );
    await window.waitForTimeout(4_000);
    await expect(section.getByTestId('activity-bg-item')).toContainText(
      'running',
    );
    await expect(section.getByTestId('activity-bg-stop')).toBeVisible();
    await expect(section.getByTestId('activity-bg-stopped-toggle')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
