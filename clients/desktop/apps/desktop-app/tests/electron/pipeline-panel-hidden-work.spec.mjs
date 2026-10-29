// Phase 03 (pipeline workspace panels — execution panel) hidden-work
// coverage: a `pipeline-execution` panel must do zero detail work while it is
// not actually shown, for every distinct way a mounted tab can stop being
// visible, and must catch up with a small, bounded refresh (not a replay of
// everything that happened while hidden) once it is shown again.
//
// `pipeline-execution-panel.spec.mjs` already covers two of these paths (main
// page navigated away, and the owning document hidden) at the whole-panel
// level (no `getExecution`/`readStepLog` reads at all while suspended). This
// file adds the remaining gates the phase 03 plan calls out, all
// instrumented at the STEP-LOG level (a real live-output flow, per the
// plan's "include at least one existing real local-action streaming flow"
// guidance):
//
//   13. the panel's own tab is INACTIVE (a sibling tab in its group is
//       selected);
//   14. the panel's GROUP is collapsed;
//   15. ANOTHER group is maximized;
//   16. the MAIN WORKTREE is switched away from the panel's owner;
//   17. the page is hidden via `document.visibilityState`;
//   18. an AUX-WINDOW panel stays live while the main window switches
//       worktree, and only suspends when its OWN document is hidden.
//
// Key production fact this file's assertions are built on (confirmed against
// `stores/pipelineDetailCoordinator.ts` `useStepLogInterest`): a step log
// view's interest is released the instant `logsEnabled`/`detailEnabled` goes
// false, and the view falls back to a fixed IDLE placeholder — it does NOT
// keep rendering the last-seen lines while hidden. A live `StepOutputEvent`
// sent while there is no registered interest is dropped on arrival (per
// `seeders/injectPipelineStepOutputEvent.mjs`'s own documented precondition)
// — it is never queued or replayed on reveal. So "more work happened while
// hidden" is modeled the way a real background step-runner would produce it:
// appended directly to the step's PERSISTED log file on disk, which reveal's
// single bounded `readStepLog` call then picks up — proving a real catch-up
// read, not a replayed live event.
//
// Determinism: a seeded running execution/step with a persisted log line,
// `pipelineIpcProbe.mjs`'s counters (never a real read while hidden),
// direct persisted-log-file appends plus `injectPipelineExecutionEvent` for
// the "more happened while hidden" burst, and `expect.poll` stability checks
// (never a fixed sleep) for the negative "stays at zero" assertions. No live
// agents, no network, no PTY.

import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { injectPipelineStepOutputEvent } from './seeders/injectPipelineStepOutputEvent.mjs';
import {
  installPipelineIpcProbe,
  readCounts,
  resetCounts,
} from './pipelineIpcProbe.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS, seedPanelWorktree } from './panelHarness.mjs';
import { showPipelineJobList } from './pipelineUi.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const OTHER_WORKSPACE_ID = 'demo-go-cli';
const JOB_ID = 'build';
const STEP_ID = 'compile';
const PERSISTED_LINE = 'SEEDED_HIDDEN_WORK_LINE';
const APPENDED_LINE = 'APPENDED_WHILE_HIDDEN_LINE';

/** Overrides `document.visibilityState` and announces the change, like `stuck-agent-warning.spec.mjs`. */
async function setDocumentVisibility(page, state) {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: next,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** Polls `read()` until `expected` holds for `stableHits` consecutive polls. */
async function waitForStableValue(read, expected, stableHits = 4) {
  let streak = 0;
  await expect
    .poll(
      async () => {
        const value = await read();
        streak = value === expected ? streak + 1 : 0;
        return streak;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(stableHits);
}

function runPanel(page, executionId) {
  return page.locator(
    `[data-testid="pipeline-execution-panel"][data-execution-id="${executionId}"]`,
  );
}

/**
 * Places the run's panel directly into `groupId`, opens its one job, expands
 * its one (running, so already-expanded) step, and returns the panel and the
 * step's live log line locator. Confirms the seeded persisted line renders
 * before returning, so every scenario starts from a real, visible, live
 * view with an established step-log interest.
 */
async function openRunningStepLog(window, { executionId, groupId }) {
  const placed = await window.evaluate(
    ({ id, group }) =>
      window.__canopyPanelTestApi.addPipelineExecutionPanel({
        executionId: id,
        groupId: group,
      }),
    { id: executionId, group: groupId },
  );
  expect(placed.outcome).toBe('placed');

  const panel = runPanel(window, executionId);
  await expect(panel).toHaveAttribute('data-detail-state', 'active');
  // A panel narrower than the job list's auto-collapse width presents the
  // list collapsed; expand it the way a user does.
  const nav = await showPipelineJobList(panel);
  await nav.getByTestId(`pipeline-details-nav-job-${JOB_ID}`).click();
  await expect(panel.getByTestId(`pipeline-job-view-${JOB_ID}`)).toBeVisible();

  const stepRow = panel.getByTestId(`pipeline-step-${STEP_ID}`);
  await expect(stepRow).toBeVisible();
  const stepToggle = stepRow.getByRole('button').first();
  if ((await stepToggle.getAttribute('aria-expanded')) !== 'true') {
    await stepToggle.click();
  }
  const stepDetail = panel.getByTestId(`pipeline-step-detail-${STEP_ID}`);
  await expect(stepDetail).toBeVisible();

  const logOutput = panel.getByTestId(`pipeline-step-log-output-${STEP_ID}`);
  const logLines = logOutput.locator('[data-testid="ansi-output"] > div');
  await expect.poll(() => logLines.allTextContents()).toEqual([PERSISTED_LINE]);

  return { panel, logLines };
}

function seedRunningExecution(userDataDir, executionId) {
  return seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: executionId,
      pipelineName: `Hidden work pipeline ${executionId}`,
      status: 'running',
      jobs: [
        {
          id: JOB_ID,
          name: 'Build',
          steps: [{ id: STEP_ID, name: 'Compile', run: 'npm run build' }],
        },
      ],
    },
    stepLogs: [{ jobId: JOB_ID, stepId: STEP_ID, lines: [PERSISTED_LINE] }],
  });
}

/**
 * Models "the run kept doing real work while the panel was hidden": appends
 * a line to the PERSISTED log file on disk (what a real background
 * step-runner does — never a live IPC event, which a torn-down interest
 * would just drop) and broadcasts a status-carrying execution event (the
 * always-live global summary listeners should absorb this regardless of any
 * panel's visibility).
 */
async function produceMoreWorkWhileHidden(
  electronApp,
  { stepLogPath, seededState },
) {
  appendFileSync(stepLogPath, `${APPENDED_LINE}\n`, 'utf8');
  await injectPipelineExecutionEvent(electronApp, {
    state: {
      ...seededState,
      jobs: {
        ...seededState.jobs,
        [JOB_ID]: { ...seededState.jobs[JOB_ID], status: 'running' },
      },
    },
  });
}

/** Asserts the log view is IDLE (interest released) — the hidden-state placeholder, not stale content. */
async function expectLogIdle(logLines) {
  await expect(logLines).toHaveCount(0);
}

async function assertHiddenNoWork(electronApp, logLines) {
  await waitForStableValue(
    async () => (await readCounts(electronApp)).readStepLog.count,
    0,
  );
  expect((await readCounts(electronApp)).getExecution.count).toBe(0);
  await expectLogIdle(logLines);
}

async function assertBoundedCatchUp(electronApp, panel, logLines) {
  await expect(panel).toHaveAttribute('data-detail-state', 'active');
  const afterReveal = await readCounts(electronApp);
  expect(afterReveal.readStepLog.count).toBeLessThanOrEqual(1);
  expect(afterReveal.getExecution.count).toBeLessThanOrEqual(1);
  await expect
    .poll(() => logLines.allTextContents())
    .toEqual([PERSISTED_LINE, APPENDED_LINE]);
}

test('inactive tab: no reads or appends while hidden, one bounded refresh on reveal', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-inactive-tab';
  const OTHER_EXECUTION_ID = 'e2e-hidden-inactive-tab-other';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: OTHER_EXECUTION_ID, pipelineName: 'Other run' },
      });
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    const { panel, logLines } = await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    // Hide: a sibling tab in the same group is selected instead.
    await window.evaluate(
      ({ id, groupId }) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
          groupId,
        }),
      { id: OTHER_EXECUTION_ID, groupId: DEFAULT_GROUP_IDS.terminal },
    );
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await expectLogIdle(logLines);

    await resetCounts(electronApp);
    await produceMoreWorkWhileHidden(electronApp, { stepLogPath, seededState });
    await assertHiddenNoWork(electronApp, logLines);

    // Reveal: reselect the target tab.
    await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId: id,
        }),
      EXECUTION_ID,
    );
    await assertBoundedCatchUp(electronApp, panel, logLines);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('collapsed group: no reads or appends while hidden, one bounded refresh on reveal', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-collapsed-group';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    const { panel, logLines } = await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.terminal,
    );
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await expectLogIdle(logLines);

    await resetCounts(electronApp);
    await produceMoreWorkWhileHidden(electronApp, { stepLogPath, seededState });
    await assertHiddenNoWork(electronApp, logLines);

    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, false),
      DEFAULT_GROUP_IDS.terminal,
    );
    await assertBoundedCatchUp(electronApp, panel, logLines);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('another group maximized: no reads or appends while hidden, one bounded refresh on reveal', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-maximized-sibling';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    const { panel, logLines } = await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await expectLogIdle(logLines);

    await resetCounts(electronApp);
    await produceMoreWorkWhileHidden(electronApp, { stepLogPath, seededState });
    await assertHiddenNoWork(electronApp, logLines);

    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, false),
      DEFAULT_GROUP_IDS.chat,
    );
    await assertBoundedCatchUp(electronApp, panel, logLines);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('main worktree switched: no reads while hidden (the panel unmounts), one bounded refresh on reveal', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-worktree-switch';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree({
    apps: ['ts-pnpm-vite', 'go-cli'],
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    const { panel, logLines } = await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    // Switch the MAIN worktree to the other demo workspace.
    const otherRow = window.locator(
      `[data-testid="worktree-row"][data-project-id="${OTHER_WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    await expect(otherRow).toBeVisible({ timeout: 15_000 });
    await otherRow.click();
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({ has: otherRow }),
    ).toHaveCount(1);
    // The owning worktree's whole panel-grid React subtree unmounts on a
    // worktree switch (not merely hidden) — see
    // `stores/pipelinePanelUiStore.ts`'s module doc.
    await expect(panel).toHaveCount(0);

    await resetCounts(electronApp);
    await produceMoreWorkWhileHidden(electronApp, { stepLogPath, seededState });
    await waitForStableValue(
      async () => (await readCounts(electronApp)).readStepLog.count,
      0,
    );
    expect((await readCounts(electronApp)).getExecution.count).toBe(0);

    // Switch back and reveal the same run's tab again.
    await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });
    await assertBoundedCatchUp(electronApp, panel, logLines);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('page hidden via document visibility: no reads or appends while hidden, one bounded refresh on reveal', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-document-visibility';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await setDocumentVisibility(window, 'visible');
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    const { panel, logLines } = await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    await setDocumentVisibility(window, 'hidden');
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await expectLogIdle(logLines);

    await resetCounts(electronApp);
    await produceMoreWorkWhileHidden(electronApp, { stepLogPath, seededState });
    await assertHiddenNoWork(electronApp, logLines);

    await setDocumentVisibility(window, 'visible');
    await assertBoundedCatchUp(electronApp, panel, logLines);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an aux-window panel stays live while the main window switches worktree, and suspends on its own document hidden', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-hidden-aux-persists';
  let seededState = null;
  let stepLogPath = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    apps: ['ts-pnpm-vite', 'go-cli'],
    onBeforeLaunch: ({ userDataDir: dir }) => {
      const seeded = seedRunningExecution(dir, EXECUTION_ID);
      seededState = seeded.state;
      stepLogPath = seeded.stepLogPaths[0];
    },
  });
  if (!seededState) throw new Error('execution was not seeded');
  try {
    await setDocumentVisibility(window, 'visible');
    await installPipelineIpcProbe(electronApp, {
      channels: ['readStepLog', 'getExecution'],
    });
    await openRunningStepLog(window, {
      executionId: EXECUTION_ID,
      groupId: DEFAULT_GROUP_IDS.terminal,
    });

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    const aux = await auxWindowPromise;
    await setDocumentVisibility(aux, 'visible');
    const auxPanel = runPanel(aux, EXECUTION_ID);
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    const auxLogLines = auxPanel
      .getByTestId(`pipeline-step-log-output-${STEP_ID}`)
      .locator('[data-testid="ansi-output"] > div');
    await expect
      .poll(() => auxLogLines.allTextContents())
      .toEqual([PERSISTED_LINE]);

    // The main window switches worktree entirely; the aux window keeps its
    // own live demand — its interest is still registered, so a LIVE output
    // event (not merely a persisted-file append) reaches it immediately.
    const otherRow = window.locator(
      `[data-testid="worktree-row"][data-project-id="${OTHER_WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    await expect(otherRow).toBeVisible({ timeout: 15_000 });
    await otherRow.click();
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({ has: otherRow }),
    ).toHaveCount(1);
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');

    await injectPipelineStepOutputEvent(electronApp, {
      executionId: EXECUTION_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      stream: 'stdout',
      data: 'LIVE_WHILE_MAIN_SWITCHED_LINE\n',
    });
    await expect
      .poll(() => auxLogLines.allTextContents())
      .toEqual([PERSISTED_LINE, 'LIVE_WHILE_MAIN_SWITCHED_LINE']);

    // Its OWN document hiding suspends it: the interest is released, so a
    // live event no longer reaches it, and only a persisted-file append plus
    // a bounded catch-up read on reveal restores current content.
    await setDocumentVisibility(aux, 'hidden');
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'suspended');
    await expect(auxLogLines).toHaveCount(0);

    await resetCounts(electronApp);
    appendFileSync(stepLogPath, `${APPENDED_LINE}\n`, 'utf8');
    await injectPipelineStepOutputEvent(electronApp, {
      executionId: EXECUTION_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      stream: 'stdout',
      data: 'DROPPED_WHILE_AUX_HIDDEN_LINE\n',
    });
    await waitForStableValue(
      async () => (await readCounts(electronApp)).readStepLog.count,
      0,
    );
    expect((await readCounts(electronApp)).getExecution.count).toBe(0);
    await expect(auxLogLines).toHaveCount(0);

    await setDocumentVisibility(aux, 'visible');
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    const afterReveal = await readCounts(electronApp);
    expect(afterReveal.readStepLog.count).toBeLessThanOrEqual(1);
    // The reveal's ONE bounded read re-establishes the interest from
    // scratch (a full release evicts the prior cached view entirely — see
    // `pipelineStepLogStore.ts` `releaseEntry`), so it reflects the
    // PERSISTED file exactly: the earlier live-only line never reached disk
    // and is gone, while the appended line (written while hidden) is now
    // picked up.
    await expect
      .poll(() => auxLogLines.allTextContents())
      .toEqual([PERSISTED_LINE, APPENDED_LINE]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
