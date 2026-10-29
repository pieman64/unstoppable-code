import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedWatchers,
  seedWorktreeChat,
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';

// Doc 2 Spec 11 (App Advisor watchers: PRs 703/711) — DETERMINISTIC parts only.
//
// Scope: the watcher-MANAGEMENT UI rendered from seeded watcher state on the
// MAIN window. Live watcher firing/delivery, the App-Advisor terminal-mode +
// voice surfaces (795/821), and the second-window App-Advisor indicator are all
// out of scope (live-turn / second-window — deferred per the plan).
//
// Surface reality (read from the components, do NOT guess):
//   - The plan's suggested `watcher-management-row-${id}` /
//     `watcher-management-confirm-delete-${id}` testids live in
//     `components/watchers/WatcherManagementModal.tsx`. That modal is the
//     App-Advisor INDICATOR path — it is only rendered by `ChatInput`,
//     `PipelineRunsSection`, the pipeline run detail
//     (`PipelineExecutionDetail`), and Workflows › Runs (CAN-3981), which
//     opens it for one watcher from that watcher's row.
//   - Workflows › Runs (`WorkflowsRunsTab.tsx`) lists each watcher as a row of
//     the one runs feed. The old Automations page Watchers tab and its
//     `automations-watcher-*` testids are gone:
//       * row:      `workflows-run-row` with `data-run-key="watcher:${id}"`
//                    and `data-run-kind="watcher"`; it shows the label, the
//                    kind and the subscribed chat
//       * cancel:   `workflows-run-action-cancel` on a watching row, confirmed
//                    in the `workflows-runs-cancel-watcher` dialog
//       * menu:     `workflows-run-menu` → `workflows-run-menu-item-inspect` /
//                    `-go-to-chat`
//       * inspect:  opens `watcher-management-modal` for that watcher, which
//                    holds the trigger, target, local progress, and the
//                    delete (`watcher-management-delete-${id}` then
//                    `watcher-management-confirm-delete-${id}`) with its
//                    `watcher-management-notify-${id}` checkbox
//   - Active, fired and `delivery_failed` watchers are all rows of the feed;
//     the seeder defaults seeded rows to `active`.
//
// This spec drives the lower-cost main-window Workflows › Runs path.
//
// Event-driven fixtures stay idle; local deadline/command fixtures exercise the
// real scheduler with deterministic mock-agent replies. The list/delete IPC
// handlers operate on the persisted file. `deleteWatcher` validates ids against
// `/^[a-z0-9][a-z0-9-]*$/`, so seeded ids stay lowercase/hyphenated.

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
}

const DEMO_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const DEMO_WORKTREE_ID = 'demo-main';
const DEMO_WORKTREE_BRANCH = 'demo-main';

/** Opens the watcher modal for one Runs row through its More menu. */
async function inspectWatcher(window, row) {
  await row.getByTestId('workflows-run-menu').click();
  await window.getByTestId('workflows-run-menu-item-inspect').click();
  const modal = window.getByTestId('watcher-management-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeWatcherModal(modal) {
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toHaveCount(0);
}

for (const kind of ['command', 'wakeup']) {
  test(`local ${kind} watcher fires through the durable chat notification path`, async () => {
    test.setTimeout(120_000);
    const userDataDir = makeUserDataDir();
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const chatId = `local-${kind}-destination`;
    const marker = `Canopy-CLOCALWATCHER${kind.toUpperCase()}`;
    const reply = `Local ${kind} watcher received.`;
    const past = '2026-01-01T00:00:00.000Z';
    seedWorktreeChat({
      userDataDir,
      workspaceId: DEMO_WORKSPACE_ID,
      worktreeId: DEMO_WORKTREE_ID,
      providerType: 'claude',
      activeTabId: chatId,
      tabs: [{ id: chatId, title: 'Local watcher destination' }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
    });
    seedWatchers({
      userDataDir,
      watchers: [
        {
          id: `fire-local-${kind}`,
          label: `Local ${kind} notification`,
          trigger:
            kind === 'command' ? 'command_watch_resolved' : 'scheduled_wakeup',
          target:
            kind === 'command'
              ? {
                  kind: 'command_watch',
                  command:
                    process.platform === 'win32'
                      ? "[Console]::Out.Write('terminal-output'); [Console]::Error.Write('terminal-error'); exit 2"
                      : 'printf terminal-output; printf terminal-error >&2; exit 2',
                  cwd: userDataDir,
                  intervalSeconds: 5,
                  maxAttempts: 2,
                }
              : {
                  kind: 'scheduled_wakeup',
                  delaySeconds: 60,
                  scheduledFor: past,
                },
          destination: {
            projectId: DEMO_WORKSPACE_ID,
            worktreeId: DEMO_WORKTREE_ID,
            chatId,
          },
          followUpInstruction: `[${marker}] Review the terminal watcher result.`,
          runtimeState: {
            kind: 'local_watcher',
            attempts: 0,
            nextAttemptAt: past,
          },
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(DEMO_WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByText(reply, { exact: true }).first()).toBeVisible(
        { timeout: 90_000 },
      );
      await expect(panel.getByTestId('watcher-fired-title')).toContainText(
        kind === 'command' ? 'Watch command' : 'Scheduled wakeup',
      );
      const stored = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'app-advisor-watchers.json'),
          'utf8',
        ),
      ).watchers.find((row) => row.id === `fire-local-${kind}`);
      expect(stored.status).toBe('fired');
      const event = stored.runtimeState.pendingDelivery.event;
      expect(event.outcome).toBe(kind === 'command' ? 'failure' : 'success');
      if (kind === 'command') {
        expect(event.reason).toBe('exit_status');
        expect(event.exitCode).toBe(2);
        expect(event.output.text).toContain('terminal-output');
        expect(event.output.text).toContain('terminal-error');
      }
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(DEMO_WORKTREE_ID);
      await expect(window.getByTestId('watcher-fired-title')).toHaveCount(1, {
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
}

test('local watchers show deadlines and command bounds and can be cancelled', async () => {
  const userDataDir = makeUserDataDir();
  const nextAttemptAt = '2099-01-01T00:00:00.000Z';
  const destination = {
    projectId: 'seeded-workspace',
    worktreeId: 'seeded-worktree',
    chatId: 'seeded-chat',
    chatTitle: 'Waiting chat',
  };
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'local-wakeup',
        label: 'Wakeup probe',
        trigger: 'scheduled_wakeup',
        target: {
          kind: 'scheduled_wakeup',
          delaySeconds: 60,
          scheduledFor: nextAttemptAt,
        },
        destination,
        runtimeState: { kind: 'local_watcher', attempts: 0, nextAttemptAt },
      },
      {
        id: 'local-command',
        label: 'Command probe',
        trigger: 'command_watch_resolved',
        target: {
          kind: 'command_watch',
          command: 'test -f ready',
          cwd: '/tmp',
          intervalSeconds: 5,
          maxAttempts: 20,
        },
        destination,
        runtimeState: { kind: 'local_watcher', attempts: 3, nextAttemptAt },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openWatchersPage();
    const wake = app.workflowsWatcherRunRow('local-wakeup');
    const command = app.workflowsWatcherRunRow('local-command');
    await expect(wake).toBeVisible();
    await expect(command).toBeVisible();
    // The deadline and command bounds are in each watcher's Inspect modal.
    const wakeModal = await inspectWatcher(window, wake);
    await expect(
      wakeModal.getByTestId('watcher-management-row-local-wakeup'),
    ).toContainText('Scheduled wakeup');
    await closeWatcherModal(wakeModal);
    const commandModal = await inspectWatcher(window, command);
    const commandDetail = commandModal.getByTestId(
      'watcher-management-row-local-command',
    );
    await expect(commandDetail).toContainText('test -f ready');
    await expect(commandDetail).toContainText('3 / 20');
    await closeWatcherModal(commandModal);
    await command.getByTestId('workflows-run-action-cancel').click();
    await expect(
      window.getByTestId('workflows-runs-cancel-watcher'),
    ).toBeVisible();
    await window.getByTestId('confirm-dialog-confirm').click();
    await expect(command).toHaveCount(0);
    await expect(wake).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('app advisor watchers: seeded rows render on Automations and delete', async ({}, testInfo) => {
  const userDataDir = makeUserDataDir();

  // Seed two active watchers (a pipeline-completion watcher and a worktree-chat
  // watcher) before launch. The seeder writes them verbatim into
  // `app-advisor-watchers.json` at the data-dir root and fills the required
  // scalar fields (version/status/createdAt/updatedAt/dedupeKey).
  const pipelineWatcherId = 'seeded-pipeline-watcher';
  const chatWatcherId = 'seeded-chat-watcher';
  const automationWatcherId = 'seeded-automation-watcher';
  const failedLocalWatcherId = 'seeded-failed-local-watcher';
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: pipelineWatcherId,
        label: 'Pipeline completion watcher',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          pipelineId: 'seeded-pipeline',
          pipelineName: 'Seeded Pipeline',
        },
        destination: {
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
      },
      {
        id: chatWatcherId,
        label: 'Worktree chat watcher',
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
        destination: {
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
      },
      // REG-2821: automation_run watchers persist an `automation` target and
      // must render through the same table with the automation's display name.
      {
        id: automationWatcherId,
        label: 'Automation run watcher',
        trigger: 'automation_run',
        target: {
          kind: 'automation',
          automationId: 'seeded-automation',
          automationName: 'Nightly triage',
        },
        destination: {
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
      },
      {
        id: failedLocalWatcherId,
        label: 'Failed command watcher',
        trigger: 'command_watch_resolved',
        target: {
          kind: 'command_watch',
          command: 'test -f build/ready',
          cwd: '/workspace/demo',
          intervalSeconds: 10,
          maxAttempts: 3,
        },
        destination: {
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
        runtimeState: {
          kind: 'local_watcher',
          attempts: 3,
          nextAttemptAt: '2099-01-01T00:00:00.000Z',
          pendingDelivery: {
            eventId: 'failed-local-event',
            attempts: 0,
            event: {
              type: 'local_watcher_resolved',
              outcome: 'failure',
              reason: 'execution_scope_unavailable',
              attempts: 3,
              completedAt: '2026-09-07T18:44:00.000Z',
            },
          },
        },
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // Watchers are rows of Workflows › Runs.
    await app.openWatchersPage();
    await expect(window.getByTestId('workflows-tab-workflows')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // All seeded active watcher rows hydrate and render.
    const watcherRows = window.locator(
      '[data-testid="workflows-run-row"][data-run-kind="watcher"]',
    );
    const pipelineRow = app.workflowsWatcherRunRow(pipelineWatcherId);
    const chatRow = app.workflowsWatcherRunRow(chatWatcherId);
    const automationRow = app.workflowsWatcherRunRow(automationWatcherId);
    const failedLocalRow = app.workflowsWatcherRunRow(failedLocalWatcherId);
    await expect(pipelineRow).toBeVisible();
    await expect(chatRow).toBeVisible();
    await expect(automationRow).toBeVisible();
    await expect(failedLocalRow).toBeVisible();
    // The local watcher's failure reason is in its Inspect modal.
    const failedModal = await inspectWatcher(window, failedLocalRow);
    await expect(
      failedModal.getByTestId(`local-watcher-progress-${failedLocalWatcherId}`),
    ).toContainText('Failed · Worktree no longer available');
    await closeWatcherModal(failedModal);

    // Rows carry the seeded label.
    await expect(pipelineRow).toContainText('Pipeline completion watcher');
    await expect(chatRow).toContainText('Worktree chat watcher');
    await expect(automationRow).toContainText('Automation run watcher');
    // The automation watcher's Inspect modal renders the shared-catalog
    // trigger title and the captured automation display name
    // (watcherTargetDisplay automation branch).
    const automationModal = await inspectWatcher(window, automationRow);
    const automationDetail = automationModal.getByTestId(
      `watcher-management-row-${automationWatcherId}`,
    );
    await expect(automationDetail).toContainText('Automation run watcher');
    await expect(automationDetail).toContainText('Automation run completion');
    await expect(automationDetail).toContainText('Nightly triage');
    await closeWatcherModal(automationModal);

    // Exactly the four seeded rows are present.
    await expect(watcherRows).toHaveCount(4);

    await window.screenshot({
      path: testInfo.outputPath('watchers-seeded.png'),
    });

    // --- Delete the chat watcher (two-step confirm in its Inspect modal) ---
    const chatModal = await inspectWatcher(window, chatRow);
    const chatDelete = chatModal.getByTestId(
      `watcher-management-delete-${chatWatcherId}`,
    );
    await expect(chatDelete).toBeVisible();
    // First click arms the confirm state (the button becomes "Confirm delete";
    // a notify-subscriber checkbox appears for the row).
    await chatDelete.click();
    const chatConfirmDelete = chatModal.getByTestId(
      `watcher-management-confirm-delete-${chatWatcherId}`,
    );
    await expect(chatConfirmDelete).toHaveText('Confirm delete');
    await expect(
      chatModal.getByTestId(`watcher-management-notify-${chatWatcherId}`),
    ).toBeVisible();

    // Second click confirms the delete via the IPC handler, which rewrites the
    // persisted watcher file and broadcasts the new list back to the renderer.
    await chatConfirmDelete.click();

    // The chat-watcher row is removed, and its modal closes with it; the
    // pipeline and automation rows remain.
    await expect(chatRow).toHaveCount(0);
    await expect(chatModal).toHaveCount(0);
    await expect(pipelineRow).toBeVisible();
    await expect(automationRow).toBeVisible();
    await expect(failedLocalRow).toBeVisible();
    await expect(watcherRows).toHaveCount(3);

    await window.screenshot({
      path: testInfo.outputPath('watchers-after-delete.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('app advisor watchers: empty Watchers tab shows the no-watchers state', async () => {
  const userDataDir = makeUserDataDir();
  // Seed zero watchers — the file exists but is empty, so with no runs
  // either, Workflows › Runs renders its empty state rather than the table.
  seedWatchers({ userDataDir, watchers: [] });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openWatchersPage();

    await expect(window.getByTestId('workflows-runs-empty')).toBeVisible();
    await expect(
      window.locator(
        '[data-testid="workflows-run-row"][data-run-kind="watcher"]',
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('app advisor watchers: hook watcher controls render in the Hooks activity section', async ({}, testInfo) => {
  const userDataDir = makeUserDataDir();
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const hookWatcherId = 'seeded-hook-watcher';
  const secondHookWatcherId = 'seeded-hook-watcher-two';
  const hookWatcherTarget = {
    kind: 'worktree_hook',
    projectId: DEMO_WORKSPACE_ID,
    worktreeId: DEMO_WORKTREE_ID,
    triggerName: 'pr:update:comments',
  };
  const hookWatcherDestination = {
    projectId: DEMO_WORKSPACE_ID,
    worktreeId: DEMO_WORKTREE_ID,
    chatId: 'seeded-chat',
    chatTitle: 'Seeded chat',
  };
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: hookWatcherId,
        label: 'PR comment hook watcher',
        trigger: 'worktree_hook_triggered',
        target: hookWatcherTarget,
        destination: hookWatcherDestination,
      },
      {
        id: secondHookWatcherId,
        label: 'Second PR comment hook watcher',
        trigger: 'worktree_hook_triggered',
        target: hookWatcherTarget,
        destination: hookWatcherDestination,
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(DEMO_WORKTREE_BRANCH);

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount before using its sections.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    const hookWatcherButton = window.getByTestId(
      'hook-watchers-trigger:pr:update:comments',
    );
    await expect(hookWatcherButton).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('hook-watchers-trigger:pr:update:comments-count'),
    ).toHaveText('2');

    await hookWatcherButton.click();
    const modal = window.getByTestId('watcher-management-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Hook watchers');
    await expect(
      window.getByTestId(`watcher-management-row-${hookWatcherId}`),
    ).toContainText('PR comment hook watcher');
    await expect(
      window.getByTestId(`watcher-management-row-${secondHookWatcherId}`),
    ).toContainText('Second PR comment hook watcher');

    await window.screenshot({
      path: testInfo.outputPath('hook-watcher-activity-control.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
