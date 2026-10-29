// Phase 03 (pipeline workspace panels — execution panel) placement and
// reveal coverage.
//
// `pipeline-execution-panel.spec.mjs` already covers the panel's own
// visibility gate (host page / owning document) and its left nav
// (expanded/collapsed/preview/Escape). This file covers the SURROUNDING
// panel-grid behavior that the phase 03 opener and placement helper drive:
//
//   1. Opening a run from a CHAT run card (`PipelineRunArtifactCard`, the
//      real `openPipelineExecutionFromUi` path) places it in a right-hand
//      sibling group of that chat, and a second, different run opened from
//      the same chat reuses that sibling group instead of splitting again.
//   2. Reopening an already-open run reveals it in place — while its tab is
//      inactive, while its group is collapsed, and while another group is
//      maximized — without moving it.
//   3. A run popped out into an auxiliary window is revealed there by the
//      real opener even while the main window has left the worktree, and the
//      main window's own navigation is untouched.
//   4. Closing a run's tab does not cancel the run and releases the panel's
//      session UI state (a reopen starts from defaults: no explicit job-list
//      choice, so a full-width panel docks its list again).
//   5. The Add Panel menu never offers a pipeline row, whether or not a run
//      tab is currently open.
//   6. A "Chat" follow-up (plan or report) from a run's panel or from its run
//      card brings the chat that receives the message into view, whether its
//      tab is inactive in its group, its group is collapsed, or another group
//      is maximized.
//
// Determinism: seeded executions/chats, the real chat-card and panel-grid
// UI, and the E2E panel test API for direct placement/opener calls that have
// no user-facing entry point yet (only `addPipelineExecutionPanel` and
// `openPipelineExecution` — the fixture and the real opener, respectively).
// No live agents, no network, no PTY, no fixed sleeps.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
} from './pipelineUi.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  waitForPanelLayout,
} from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

/** Minimal dispatch-tool-result carrying one `pipeline_run` receipt. */
function buildRunReceipt({ executionId, pipelineId, pipelineName, atMs }) {
  const createdAt = new Date(atMs).toISOString();
  return {
    version: 1,
    kind: 'pipeline_run',
    operation: 'pipeline.run',
    dedupeKey: `canopy:pipeline_run:execution:${executionId}`,
    createdAt,
    executionId,
    pipelineId,
    pipelineName,
    initialStatus: 'running',
    queuedAt: createdAt,
    startedAt: createdAt,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
    },
  };
}

/** One dispatch turn: user message, DispatchAction tool_use/tool_result carrying `receipt`, completed turn timer. */
function buildDispatchMessages({ turnId, toolId, receipt, timestamp }) {
  return [
    {
      id: turnId,
      role: 'user',
      blocks: [{ type: 'text', text: `Dispatch ${receipt.kind}` }],
      timestamp,
    },
    {
      id: `${toolId}-use`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: toolId,
          toolName: 'DispatchAction',
          input: '{}',
        },
      ],
      timestamp: timestamp + 1,
    },
    {
      id: `${toolId}-result`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: toolId,
          toolName: 'DispatchAction',
          output: JSON.stringify({
            ok: true,
            result: { agentArtifacts: [receipt] },
          }),
          isError: false,
        },
      ],
      timestamp: timestamp + 2,
    },
    {
      id: `${turnId}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 3,
        },
      ],
      timestamp: timestamp + 3,
    },
  ];
}

/**
 * A completed turn's "Agent activity" section collapses once it is no longer
 * the newest turn, hiding its `PipelineRunArtifactCard` behind an "Expand
 * agent activity" toggle. Expand it (a no-op if already expanded) before
 * looking for the run card underneath.
 */
async function expandTurnActivity(chatPanel, turnId) {
  const turnGroup = chatPanel.locator(`[data-chat-turn-group="${turnId}"]`);
  await expect(turnGroup).toBeVisible({ timeout: 15_000 });
  const expandButton = turnGroup.getByRole('button', {
    name: 'Expand agent activity',
  });
  if (await expandButton.isVisible().catch(() => false)) {
    await expandButton.click();
  }
}

/** The `pipeline-execution` leaf hosting `executionId`, or `undefined`. */
function findExecutionLeaf(layout, executionId) {
  return collectLeaves(layout.root).find((leaf) =>
    leaf.panels.some(
      (panel) =>
        panel.kind === 'pipeline-execution' &&
        panel.instance?.executionId === executionId,
    ),
  );
}

test('opening a run from a chat run card places it beside the chat, and a second run reuses the sibling group', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-panel-placement-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const CHAT_ID = 'placement-chat';
  const EXECUTION_A = 'e2e-placement-a';
  const EXECUTION_B = 'e2e-placement-b';
  const T = Date.parse('2026-05-01T12:00:00.000Z');

  const receiptA = buildRunReceipt({
    executionId: EXECUTION_A,
    pipelineId: 'placement-pipeline-a',
    pipelineName: 'Placement Pipeline A',
    atMs: T,
  });
  const receiptB = buildRunReceipt({
    executionId: EXECUTION_B,
    pipelineId: 'placement-pipeline-b',
    pipelineName: 'Placement Pipeline B',
    atMs: T + 10_000,
  });

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Placement chat',
        messages: [
          ...buildDispatchMessages({
            turnId: 'placement-turn-a',
            toolId: 'placement-tool-a',
            receipt: receiptA,
            timestamp: T,
          }),
          ...buildDispatchMessages({
            turnId: 'placement-turn-b',
            toolId: 'placement-tool-b',
            receipt: receiptB,
            timestamp: T + 10_000,
          }),
        ],
      },
    ],
  });

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_A,
      pipelineId: receiptA.pipelineId,
      pipelineName: receiptA.pipelineName,
      status: 'running',
    },
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_B,
      pipelineId: receiptB.pipelineId,
      pipelineName: receiptB.pipelineName,
      status: 'running',
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH, {
      expandDefaultActivityRail: false,
    });

    const before = await waitForPanelLayout(window, {
      requiredGroupIds: [
        DEFAULT_GROUP_IDS.chat,
        DEFAULT_GROUP_IDS.terminal,
        DEFAULT_GROUP_IDS.activity,
      ],
    });
    // Baseline: the right rail is not yet collapsed.
    expect(
      collectLeaves(before.root).find(
        (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
      )?.collapsed,
    ).toBe(null);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible();

    await expandTurnActivity(chatPanel, 'placement-turn-a');
    const cardA = chatPanel.getByTestId(`pipeline-run-card-${EXECUTION_A}`);
    await expect(cardA).toBeVisible({ timeout: 15_000 });
    await cardA.click({ position: { x: 10, y: 10 } });

    const panelA = await expectPipelineRunPanel(window, EXECUTION_A);
    await expect(panelA.getByTestId('pipeline-execution-detail')).toBeVisible();

    const layoutAfterA = await getLayout(window);
    const leafA = findExecutionLeaf(layoutAfterA, EXECUTION_A);
    expect(leafA, 'run A placed a panel').toBeTruthy();
    expect(leafA.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    expect(leafA.groupId).not.toBe(DEFAULT_GROUP_IDS.activity);
    // The pre-existing full-height right activity rail collapsed to make
    // room for the new sibling (`createChatSiblingGroupToRight`).
    const activityAfterA = collectLeaves(layoutAfterA.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
    );
    expect(activityAfterA?.collapsed).toBe('right');

    // A second, different run opened from the SAME chat reuses the sibling
    // group instead of creating another split.
    await expandTurnActivity(chatPanel, 'placement-turn-b');
    const cardB = chatPanel.getByTestId(`pipeline-run-card-${EXECUTION_B}`);
    await expect(cardB).toBeVisible({ timeout: 15_000 });
    await cardB.click({ position: { x: 10, y: 10 } });

    const panelB = await expectPipelineRunPanel(window, EXECUTION_B);
    await expect(panelB.getByTestId('pipeline-execution-detail')).toBeVisible();

    const layoutAfterB = await getLayout(window);
    const leafB = findExecutionLeaf(layoutAfterB, EXECUTION_B);
    expect(leafB, 'run B placed a panel').toBeTruthy();
    expect(leafB.groupId).toBe(leafA.groupId);
    expect(
      leafB.panels.filter((panel) => panel.kind === 'pipeline-execution'),
    ).toHaveLength(2);
    // No further split: still the same three original groups plus the one
    // sibling group.
    expect(collectLeaves(layoutAfterB.root)).toHaveLength(4);

    await closePipelineRunPanels(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('reopening an already-open run reveals it in place: inactive tab, collapsed group, and a maximized sibling', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-reveal-target';
  const OTHER_EXECUTION_ID = 'e2e-reveal-other';
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: EXECUTION_ID, pipelineName: 'Reveal Target' },
      });
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: OTHER_EXECUTION_ID, pipelineName: 'Reveal Other' },
      });
    },
  });
  try {
    // Both panels land directly in the terminal group (an explicit group
    // add), independent of chat-sibling placement, which this test does not
    // exercise.
    const place = (executionId) =>
      window.evaluate(
        ({ id, groupId }) =>
          window.__canopyPanelTestApi.addPipelineExecutionPanel({
            executionId: id,
            groupId,
          }),
        { id: executionId, groupId: DEFAULT_GROUP_IDS.terminal },
      );
    const targetPanel = window.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
    );
    const otherPanel = window.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${OTHER_EXECUTION_ID}"]`,
    );

    const placedTarget = await place(EXECUTION_ID);
    expect(placedTarget.outcome).toBe('placed');
    // Confirm the target's content BEFORE placing the second execution steals
    // its active-tab focus (a new tab activates by default).
    await expect(
      targetPanel.getByTestId('pipeline-execution-detail'),
    ).toBeVisible();

    const placedOther = await place(OTHER_EXECUTION_ID);
    expect(placedOther.outcome).toBe('placed');

    // Two different executions coexist as two independently addressable tabs
    // in the same group.

    // Reopening omits `groupId` so it takes the REVEAL path
    // (`placeOrRevealContentPanel` finds the existing tab by instance key),
    // not a second, doomed-to-fail `addTab` at the same explicit group.
    const reopenTarget = () =>
      window.evaluate(
        (id) =>
          window.__canopyPanelTestApi.addPipelineExecutionPanel({
            executionId: id,
          }),
        EXECUTION_ID,
      );

    // ---- Phase 1: the target's tab is INACTIVE (another tab in its group
    // is selected). Reopening reveals and reselects it. ----
    await expect(
      otherPanel.getByTestId('pipeline-execution-detail'),
    ).toBeVisible();
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'suspended');
    const revealed1 = await reopenTarget();
    expect(revealed1.outcome).toBe('revealed');
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'active');
    await expect(
      targetPanel.getByTestId('pipeline-execution-detail'),
    ).toBeVisible();

    // ---- Phase 2: the target's GROUP is collapsed. Reopening expands it. ----
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.terminal,
    );
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'suspended');
    const revealed2 = await reopenTarget();
    expect(revealed2.outcome).toBe('revealed');
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'active');
    const layoutAfterCollapseReveal = await getLayout(window);
    expect(
      findExecutionLeaf(layoutAfterCollapseReveal, EXECUTION_ID)?.collapsed,
    ).toBe(null);

    // ---- Phase 3: ANOTHER group is maximized. Reopening exits that
    // maximize and reveals the target. ----
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'suspended');
    const revealed3 = await reopenTarget();
    expect(revealed3.outcome).toBe('revealed');
    await expect(targetPanel).toHaveAttribute('data-detail-state', 'active');
    const layoutAfterMaximizeReveal = await getLayout(window);
    expect(
      collectLeaves(layoutAfterMaximizeReveal.root).some(
        (leaf) => leaf.maximized,
      ),
    ).toBe(false);

    await closePipelineRunPanels(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a popped-out run stays revealed in its aux window without navigating the main window', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-aux-reveal';
  let seeded = null;
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      seeded = seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: EXECUTION_ID, pipelineName: 'Aux Reveal Pipeline' },
      });
    },
  });
  if (seeded === null) throw new Error('pipeline execution was not seeded');
  try {
    const placed = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId: 'group-terminal',
        }),
      EXECUTION_ID,
    );
    expect(placed.outcome).toBe('placed');

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      placed.location.groupId,
    );
    const aux = await auxWindowPromise;
    const auxPanel = aux.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
    );
    await expect(auxPanel).toBeVisible();

    // Leave the worktree view in the MAIN window before reopening the run:
    // the real opener must not need (or trigger) main-window navigation
    // because the run's tab already lives in an auxiliary window.
    await app.openOverviewPage();
    await expect(window.getByTestId('overview-page')).toBeVisible();

    const result = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.openPipelineExecution({ executionId: id }),
      EXECUTION_ID,
    );
    expect(result.status).toBe('applied');
    expect(result.outcome).toBe('revealed');
    // The applied layout is the auxiliary one, not the owner's main layout.
    expect(result.layoutKey).not.toBe(result.ownerKey);

    // The main window never navigated back to the worktree.
    await expect(window.getByTestId('overview-page')).toBeVisible();

    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    await expect(
      auxPanel.getByTestId('pipeline-execution-detail'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing a run tab does not cancel it and releases the panel session state', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-close-release';
  let seeded = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      seeded = seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id: EXECUTION_ID,
          pipelineName: 'Close Release Pipeline',
          status: 'running',
        },
      });
    },
  });
  if (seeded === null) throw new Error('pipeline execution was not seeded');
  try {
    const placed = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId: 'group-terminal',
        }),
      EXECUTION_ID,
    );
    expect(placed.outcome).toBe('placed');

    const panel = window.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
    );
    await expect(panel).toHaveAttribute('data-detail-state', 'active');

    // The terminal row spans the grid, wider than the job list's
    // auto-collapse width, so the list starts docked. Collapsing it stores an
    // explicit choice for this panel, so a reopen's DEFAULT state is a
    // meaningful assertion.
    const toggle = panel.getByTestId('pipeline-panel-nav-toggle');
    await expect(panel).toHaveAttribute('data-panel-width', 'wide');
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-nav-state', 'collapsed');

    await window
      .locator(`[data-testid="panel-tab-close-panel-pipeline-${EXECUTION_ID}"]`)
      .click({ force: true });
    await expect(panel).toHaveCount(0);

    // Closing the tab never cancels the run.
    const stillRunning = await window.evaluate(async (id) => {
      const result = await window.pipelines.getExecution(id);
      return result.success ? result.data.status : null;
    }, EXECUTION_ID);
    expect(stillRunning).toBe('running');

    // Reopening starts from defaults: the explicit collapse is gone, so the
    // wide panel docks its list again.
    const reopened = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId: 'group-terminal',
        }),
      EXECUTION_ID,
    );
    expect(reopened.outcome).toBe('placed');
    await expect(panel).toHaveAttribute('data-detail-state', 'active');
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');

    await closePipelineRunPanels(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Add Panel menu never offers a pipeline row, before or after a run tab closes', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-add-panel-menu';
  let seeded = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      seeded = seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id: EXECUTION_ID,
          pipelineName: 'Add Panel Menu Pipeline',
        },
      });
    },
  });
  if (seeded === null) throw new Error('pipeline execution was not seeded');

  const noPipelineRow = async () => {
    await window.getByTestId('panel-add-panel-group-chat').click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await expect(
      window.locator('[data-testid^="panel-add-menu-item-pipeline-execution"]'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('panel-add-menu')).toBeHidden();
  };

  try {
    // Before any run tab exists.
    await noPipelineRow();

    const placed = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId: 'group-terminal',
        }),
      EXECUTION_ID,
    );
    expect(placed.outcome).toBe('placed');
    await expect(
      window.locator(
        `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
      ),
    ).toHaveAttribute('data-detail-state', 'active');

    // While a run tab is open.
    await noPipelineRow();

    await window
      .locator(`[data-testid="panel-tab-close-panel-pipeline-${EXECUTION_ID}"]`)
      .click({ force: true });
    await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(0);

    // After the run tab closes.
    await noPipelineRow();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const FOLLOW_UP_PLAN_PATH = '/tmp/canopy-follow-up/plan.md';

/**
 * Seeds a completed run that has a saved plan and a saved report, so its
 * plan Chat and report Chat follow-ups are enabled.
 */
function seedFollowUpRun(userDataDir, executionId) {
  const reportFilePath = path.join(
    userDataDir,
    'pipeline-executions',
    executionId,
    'report.md',
  );
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: executionId,
      pipelineName: 'Follow-up Pipeline',
      status: 'success',
      stateOverrides: {
        event_name: 'plan_ready',
        event_data: { plan_ready: { plan_path: FOLLOW_UP_PLAN_PATH } },
        plan_hash_after: 'plan-hash',
        report_outputs: { report_file: reportFilePath },
      },
    },
  });
  mkdirSync(path.dirname(reportFilePath), { recursive: true });
  writeFileSync(reportFilePath, '# Follow-up report\n\nAll good.\n', 'utf8');
  return { reportFilePath };
}

/** Records chat sends in the main process instead of starting an agent. */
async function captureChatSends(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__followUpSends = [];
    ipcMain.removeHandler('chat:send-message');
    ipcMain.handle('chat:send-message', async (_event, request) => {
      globalThis.__followUpSends.push({
        chatId: request.chatId,
        text: request.text,
      });
      return {};
    });
  });
}

function readChatSends(electronApp) {
  return electronApp.evaluate(() => globalThis.__followUpSends);
}

test("a panel's Chat follow-ups bring the receiving chat into view from an inactive tab, a collapsed group, and a maximized sibling", async () => {
  test.setTimeout(180_000);
  const EXECUTION_ID = 'e2e-follow-up-panel';
  let reportFilePath = '';
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      ({ reportFilePath } = seedFollowUpRun(dir, EXECUTION_ID));
    },
  });
  try {
    await captureChatSends(electronApp);
    // The run panel sits in the terminal group, apart from the chat's group,
    // so each case can hide the chat without hiding the run.
    const placed = await window.evaluate(
      ({ id, groupId }) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId,
        }),
      { id: EXECUTION_ID, groupId: DEFAULT_GROUP_IDS.terminal },
    );
    expect(placed.outcome).toBe('placed');
    const runPanel = await expectPipelineRunPanel(window, EXECUTION_ID);
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SEEDED_CHAT_TAB_ID}"]`,
    );
    const chatTab = window.getByTestId(
      `panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`,
    );

    // ---- Inactive tab: another tab of the chat's group is selected. ----
    await window.evaluate(
      ({ panelId, groupId }) =>
        window.__canopyPanelTestApi.movePanel(panelId, groupId, 'center'),
      { panelId: 'panel-activity', groupId: DEFAULT_GROUP_IDS.chat },
    );
    await expect(chatPanel).toBeHidden();
    await expect(chatTab).toHaveAttribute('data-active', 'false');
    await runPanel
      .getByTestId(`pipeline-detail-chat-follow-up-${EXECUTION_ID}`)
      .click();
    await expect(chatPanel).toBeVisible();
    await expect(chatTab).toHaveAttribute('data-active', 'true');
    await expect
      .poll(() => readChatSends(electronApp))
      .toEqual([
        {
          chatId: SEEDED_CHAT_TAB_ID,
          text: `Review this plan: ${FOLLOW_UP_PLAN_PATH}`,
        },
      ]);
    await expect(
      chatPanel.getByText(`Review this plan: ${FOLLOW_UP_PLAN_PATH}`),
    ).toBeVisible();

    // ---- Collapsed group: the chat's group is collapsed. ----
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(chatPanel).toBeHidden();
    await runPanel
      .getByTestId(`pipeline-detail-report-chat-follow-up-${EXECUTION_ID}`)
      .click();
    await expect(chatPanel).toBeVisible();
    await expect
      .poll(
        async () =>
          collectLeaves((await getLayout(window)).root).find(
            (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
          )?.collapsed,
      )
      .toBe(null);
    await expect
      .poll(async () => (await readChatSends(electronApp)).at(-1))
      .toEqual({
        chatId: SEEDED_CHAT_TAB_ID,
        text: `Review this report: ${reportFilePath}`,
      });

    // ---- Maximized sibling: the run's own group covers the chat. ----
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      DEFAULT_GROUP_IDS.terminal,
    );
    await expect(chatPanel).toBeHidden();
    await runPanel
      .getByTestId(`pipeline-detail-chat-follow-up-${EXECUTION_ID}`)
      .click();
    await expect(chatPanel).toBeVisible();
    expect(
      collectLeaves((await getLayout(window)).root).some(
        (leaf) => leaf.maximized,
      ),
    ).toBe(false);
    await expect
      .poll(async () => (await readChatSends(electronApp)).length)
      .toBe(3);

    await closePipelineRunPanels(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("a run card's Chat follow-ups bring the receiving chat into view from an inactive tab and a collapsed group", async () => {
  test.setTimeout(180_000);
  const EXECUTION_ID = 'e2e-follow-up-card';
  let reportFilePath = '';
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      ({ reportFilePath } = seedFollowUpRun(dir, EXECUTION_ID));
    },
  });
  try {
    await captureChatSends(electronApp);
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SEEDED_CHAT_TAB_ID}"]`,
    );
    const chatTab = window.getByTestId(
      `panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`,
    );
    const planChat = window.getByTestId(
      `pipeline-run-chat-follow-up-${EXECUTION_ID}`,
    );
    const reportChat = window.getByTestId(
      `pipeline-run-report-follow-up-${EXECUTION_ID}`,
    );
    await expect(planChat).toBeVisible({ timeout: 30_000 });

    // ---- Inactive tab: the terminal tab covers the chat in its group. ----
    await window.evaluate(
      ({ panelId, groupId }) =>
        window.__canopyPanelTestApi.movePanel(panelId, groupId, 'center'),
      { panelId: 'panel-terminal', groupId: DEFAULT_GROUP_IDS.chat },
    );
    await expect(chatPanel).toBeHidden();
    await expect(chatTab).toHaveAttribute('data-active', 'false');
    await planChat.click();
    await expect(chatPanel).toBeVisible();
    await expect(chatTab).toHaveAttribute('data-active', 'true');
    await expect
      .poll(() => readChatSends(electronApp))
      .toEqual([
        {
          chatId: SEEDED_CHAT_TAB_ID,
          text: `Review this plan: ${FOLLOW_UP_PLAN_PATH}`,
        },
      ]);

    // ---- Collapsed group. ----
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(chatPanel).toBeHidden();
    await reportChat.click();
    await expect(chatPanel).toBeVisible();
    await expect
      .poll(async () => (await readChatSends(electronApp)).at(-1))
      .toEqual({
        chatId: SEEDED_CHAT_TAB_ID,
        text: `Review this report: ${reportFilePath}`,
      });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
