import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { injectPipelineStepOutputChunks } from './seeders/injectPipelineStepOutputEvent.mjs';
import {
  hold,
  installPipelineIpcProbe,
  readCounts,
  release,
  resetCounts,
  uninstallPipelineIpcProbe,
} from './pipelineIpcProbe.mjs';
import { DEFAULT_GROUP_IDS } from './panelHarness.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { expectPipelineRunPanel, showPipelineJobList } from './pipelineUi.mjs';

// Phase 02 (pipeline workspace panels — detail data lifecycle) coverage.
//
// Phase 01 moved the pipeline execution/step-output/queue/advisor listeners
// into one always-mounted renderer bridge (`hooks/usePipelineRunsBridge.ts`,
// mounted once in `WorktreeManager`), replacing the per-mount
// `usePipelineRunsSubscription` hook that used to live inside
// `SharedActivityPanelAdapter` (the 'activity-section' panel) and has since
// been deleted entirely. It also introduced ref-counted detail leases
// (`stores/pipelineDetailCoordinator.ts` / `lib/pipelineDetailLeases.ts`) with
// a per-execution generation guard (`pipelineRunsStore.ts`
// `ExecutionDetailRead.superseded`) so a slow `getExecution` snapshot cannot
// clobber a newer lifecycle event, and step-log interests
// (`stores/pipelineStepLogStore.ts`) that re-read exactly once on a terminal
// transition.
//
// This spec exercises those four properties against the real renderer, using
// the phase 01 harness primitives: `seeders/injectPipelineExecutionEvent.mjs`
// (imported by path — the seeders index is a frozen fixture and deliberately
// does not re-export it), `seeders/injectPipelineStepOutputEvent.mjs`, and
// `pipelineIpcProbe.mjs`'s hold/release/readCounts gate. No live agents, no
// network, no PTY, no sleeps for correctness (`expect.poll` / Playwright's
// built-in retrying assertions only).
//
// Known harness limitation (see `docs/planning/2026-09-23-pipeline-workspace-
// panels/phases/phase-02-detail-data-lifecycle.md`): the default shared
// sidebar derives pipeline status from a main-process snapshot of LIVE
// handles only, so a seeded/injected run never gets a sidebar badge — this
// spec never asserts on sidebar badges.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

/**
 * Polls `read()` until it returns `expected` for `stableHits` CONSECUTIVE
 * polls in a row (Playwright's `expect.poll` default increasing intervals),
 * resetting the streak whenever the observed value differs. A value that
 * flips to the right answer only transiently before settling on a wrong one
 * (e.g. a late write clobbering an already-correct value) fails this, where
 * a single `expect.poll(...).toBe(expected)` could pass on a lucky early
 * sample. No fixed `waitForTimeout` is used — the "settle" window is however
 * many polls it actually takes to accumulate `stableHits` consecutive
 * matches.
 */
async function waitForStableValue(
  read,
  expected,
  { stableHits = 4, timeout = 15_000 } = {},
) {
  let streak = 0;
  await expect
    .poll(
      async () => {
        const value = await read();
        streak = value === expected ? streak + 1 : 0;
        return streak;
      },
      { timeout },
    )
    .toBeGreaterThanOrEqual(stableHits);
}

/** Minimal chat dispatch-tool-result carrying one pipeline_run receipt. */
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
 * Builds a completed `ExecutionState` for `injectPipelineExecutionEvent` from
 * a `seedPipelineExecution` seed's returned `state`: marks the execution and
 * its single job/step `success`. Mirrors the pattern in
 * `pipeline-injected-output.spec.mjs`. The seeded state carries no
 * `job_definitions`/`job_groups` (those are computed by the real
 * `getExecution` migration path on read, not persisted), matching a real
 * `ExecutionEvent` payload.
 */
function buildSuccessState(seededState, { jobId, stepId, completedAt }) {
  return {
    ...seededState,
    status: 'success',
    completed_at: completedAt,
    jobs: {
      ...seededState.jobs,
      [jobId]: {
        ...seededState.jobs[jobId],
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        completed_at: completedAt,
        steps: {
          ...seededState.jobs[jobId].steps,
          [stepId]: {
            ...seededState.jobs[jobId].steps[stepId],
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            completed_at: completedAt,
            exit_code: 0,
          },
        },
      },
    },
  };
}

/** Clicks a step row's toggle if it is not already expanded. */
async function ensureStepExpanded(window, stepId) {
  const stepRow = window.getByTestId(`pipeline-step-${stepId}`);
  await expect(stepRow).toBeVisible();
  const stepToggle = stepRow.getByRole('button').first();
  if ((await stepToggle.getAttribute('aria-expanded')) !== 'true') {
    await stepToggle.click();
  }
  await expect(
    window.getByTestId(`pipeline-step-detail-${stepId}`),
  ).toBeVisible();
}

test('chat run card stays live with no Activity panel', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-detail-lifecycle-no-activity-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const EXECUTION_ID = 'e2e-detail-lifecycle-no-activity-1';
  const JOB_ID = 'build';
  const STEP_ID = 'compile';
  const CHAT_ID = 'no-activity-chat';
  const T = Date.parse('2026-05-01T12:00:00.000Z');

  const receipt = buildRunReceipt({
    executionId: EXECUTION_ID,
    pipelineId: 'no-activity-pipeline',
    pipelineName: 'No Activity Pipeline',
    atMs: T,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'No activity chat',
        messages: buildDispatchMessages({
          turnId: 'run-turn',
          toolId: 'run-tool',
          receipt,
          timestamp: T,
        }),
      },
    ],
  });

  const { state: seededState } = seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineId: receipt.pipelineId,
      pipelineName: receipt.pipelineName,
      status: 'running',
      startedAt: receipt.startedAt,
      jobs: [
        {
          id: JOB_ID,
          name: 'Build',
          steps: [{ id: STEP_ID, name: 'Compile', run: 'npm run build' }],
        },
      ],
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

    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);

    // Remove the Activity group from the layout entirely (not merely
    // collapsed — fully closed, so `SharedActivityPanelAdapter` never
    // mounts). Before this phase, the execution-event listener lived in
    // `usePipelineRunsSubscription`, mounted ONLY by `SharedActivityPanelAdapter`
    // (the 'activity-section' panel's contents; see the now-deleted
    // `hooks/usePipelineRunsSubscription.ts` and its one call site removed
    // from `SharedActivityPanelAdapter.tsx`). With no Activity panel present,
    // that hook never mounted, so `window.pipelines.onExecutionEvent` was
    // never subscribed at all — an injected `execution.completed` event would
    // have been dropped on the floor and this chat run card would have
    // stayed on its stale status forever. The fix moved that subscription
    // into `usePipelineRunsBridge`, mounted once in `WorktreeManager`
    // regardless of panel layout, and added a lightweight summary interest
    // (`usePipelineExecutionSummaryInterest`) so a chat card's cached state
    // stays live under events independent of any Activity surface.
    await window.evaluate((groupId) => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.closeGroup(groupId);
    }, DEFAULT_GROUP_IDS.activity);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toHaveCount(0);

    const chatPanel = window.getByTestId('panel-content-chat');
    const runCard = chatPanel.getByTestId(`pipeline-run-card-${EXECUTION_ID}`);
    // A live run is the composer drawer's alone; its turn card appears only
    // once the run finishes (background drawer D3).
    const tray = await openBackgroundDrawer(chatPanel);
    const runRow = tray.locator(`[data-tray-row="run:${receipt.dedupeKey}"]`);
    await expect(runRow).toHaveCount(1, { timeout: 15_000 });
    await expect(runCard).toHaveCount(0);

    const successState = buildSuccessState(seededState, {
      jobId: JOB_ID,
      stepId: STEP_ID,
      completedAt: '2026-05-01T12:02:00.000Z',
    });
    await injectPipelineExecutionEvent(electronApp, {
      state: successState,
      type: 'execution.completed',
    });
    // Completion moves the run from live work into history and its transcript.
    await expect(runRow).toHaveCount(0, { timeout: 15_000 });
    await expect(runCard).toContainText('success', { timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('two Activity panels do not duplicate output', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-detail-lifecycle-two-panels-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const EXECUTION_ID = 'e2e-detail-lifecycle-two-panels-1';
  const JOB_ID = 'build';
  const JOB_NAME = 'Build';
  const STEP_ID = 'compile';
  const STEP_NAME = 'Compile';
  const STARTED_AT = '2026-05-02T12:00:00.000Z';
  // Textually distinct from every injected chunk below so the persisted/live
  // overlap heuristic (`mergeStepOutputLines`, up to a 5-line window) cannot
  // fold any of them together.
  const PERSISTED_LINES = ['TWO_PANELS_SEEDED_PERSISTED_LINE'];

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'Two Panels Pipeline',
      status: 'running',
      startedAt: STARTED_AT,
      jobs: [
        {
          id: JOB_ID,
          name: JOB_NAME,
          steps: [{ id: STEP_ID, name: STEP_NAME, run: 'npm run build' }],
        },
      ],
    },
    stepLogs: [{ jobId: JOB_ID, stepId: STEP_ID, lines: PERSISTED_LINES }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const stackedActivity = window.getByTestId(
      'panel-content-activity-section',
    );
    await expect(stackedActivity).toBeVisible();
    const stackedRunCard = stackedActivity.getByTestId(
      `pipeline-run-card-${EXECUTION_ID}`,
    );
    await expect(stackedRunCard).toBeVisible({ timeout: 15_000 });

    // Mount a SECOND, independently-rendered Activity surface for the SAME
    // 'pipeline-runs' section (`PanelActivityCardContent` in
    // `lib/panels/registry.tsx` renders the section's own `render()` function
    // directly — a completely separate React subtree from the stacked
    // `SharedActivityPanelAdapter` one above).
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu-item-activity-card-pipeline-runs')
      .click();
    const standaloneRuns = window.getByTestId(
      'activity-card-section-pipeline-runs',
    );
    await expect(standaloneRuns).toBeVisible();
    const standaloneRunCard = standaloneRuns.getByTestId(
      `pipeline-run-card-${EXECUTION_ID}`,
    );
    await expect(standaloneRunCard).toBeVisible({ timeout: 15_000 });

    // Open the run's detail from the DEFAULT (stacked) surface. It opens as
    // the run's own `pipeline-execution` panel tab (no run list hosts a
    // detail any more), so the standalone card's `PipelineRunsSection`
    // instance stays an unopened list for the rest of this test — it exists
    // purely to prove that a SECOND live
    // reader of the shared `pipelineRunsStore`/`pipelineStepLogStore` does
    // not cause the renderer's pipeline IPC bridge
    // (`usePipelineRunsBridge`, mounted exactly once in `WorktreeManager`,
    // independent of how many Activity surfaces exist) to process the same
    // live event twice. The deleted `usePipelineRunsSubscription` hook this
    // phase replaced was mounted per `SharedActivityPanelAdapter` instance
    // (a singleton panel kind) rather than per pipeline-runs-showing
    // surface, so this exact two-surface shape could not literally double a
    // subscription on the immediately prior commit; this test instead locks
    // in the invariant the new single, ref-counted bridge design exists to
    // guarantee going forward, as any additional simultaneous consumer
    // (chat cards, a future panel) is added.
    await stackedRunCard.click({ position: { x: 10, y: 10 } });
    await expectPipelineRunPanel(window, EXECUTION_ID);
    await showPipelineJobList(window, { timeout: 15_000 });
    await window.getByTestId(`pipeline-details-nav-job-${JOB_ID}`).click();
    await expect(
      window.getByTestId(`pipeline-job-view-${JOB_ID}`),
    ).toBeVisible();
    await ensureStepExpanded(window, STEP_ID);

    const logOutput = window.getByTestId(`pipeline-step-log-output-${STEP_ID}`);
    const logLines = logOutput.locator('[data-testid="ansi-output"] > div');
    await expect
      .poll(() => logLines.allTextContents(), { timeout: 15_000 })
      .toEqual(PERSISTED_LINES);

    await injectPipelineStepOutputChunks(
      electronApp,
      {
        executionId: EXECUTION_ID,
        jobId: JOB_ID,
        jobName: JOB_NAME,
        stepId: STEP_ID,
        stepName: STEP_NAME,
        attempt: 0,
        iteration: 1,
        stream: 'stdout',
      },
      ['delta-one\n', 'delta-two\ndel', 'ta-three\n'],
    );

    const expectedLines = [
      ...PERSISTED_LINES,
      'delta-one',
      'delta-two',
      'delta-three',
    ];
    await expect
      .poll(() => logLines.allTextContents(), { timeout: 15_000 })
      .toEqual(expectedLines);
    // Re-assert after settling: each injected line appears EXACTLY once, even
    // with a second Activity surface mounted alongside the one that opened
    // this detail.
    const finalLines = await logLines.allTextContents();
    for (const line of ['delta-one', 'delta-two', 'delta-three']) {
      expect(finalLines.filter((entry) => entry === line)).toHaveLength(1);
    }

    // The second surface's own list row is untouched: still exactly one row
    // for this execution, no duplicated content in the standalone list.
    await expect(standaloneRunCard).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a slow snapshot does not overwrite a newer terminal event', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-detail-lifecycle-slow-snapshot-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const EXECUTION_ID = 'e2e-detail-lifecycle-slow-snapshot-1';
  const JOB_ID = 'build';
  const STEP_ID = 'compile';
  const STARTED_AT = '2026-05-03T12:00:00.000Z';

  const { state: seededState } = seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'Slow Snapshot Pipeline',
      status: 'running',
      startedAt: STARTED_AT,
      jobs: [
        {
          id: JOB_ID,
          name: 'Build',
          steps: [{ id: STEP_ID, name: 'Compile', run: 'npm run build' }],
        },
      ],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Install the probe and hold `getExecution` BEFORE selecting the
    // worktree. `PipelineRunsSection` proactively prefetches full execution
    // detail for every VISIBLE run row as soon as it renders (`useEffect` /
    // `prefetchMissingDetails` — "Auto-load full execution details for
    // visible runs so the DAG progress bar and rerun/retry affordances
    // render immediately"), independent of whether a detail is open. Holding
    // before selection makes that first prefetch call the one that gets
    // held; opening the run card then joins that SAME single-flight read
    // (`pipelineRunsStore.loadExecutionDetails`) instead of issuing a second
    // one that would race past the held one and defeat this test.
    await installPipelineIpcProbe(electronApp);
    try {
      await hold(electronApp, 'getExecution');

      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId('panel-content-activity-section'),
      ).toBeVisible();

      const runCard = window.getByTestId(`pipeline-run-card-${EXECUTION_ID}`);
      // The row itself renders from the lightweight summary the run list
      // already loaded; it does not need the held detail read.
      await expect(runCard).toBeVisible({ timeout: 15_000 });
      await expect(runCard).toContainText('running');
      await expect
        .poll(async () => (await readCounts(electronApp)).getExecution.count)
        .toBeGreaterThan(0);

      // Corner click: the activity column is narrow enough that the card's
      // center lands on wrapped action buttons that stop propagation instead
      // of opening the run's panel (see `pipeline-runs.spec.mjs`'s
      // `openRunCard`). The opener takes the run's owner from the listed
      // summary, so it issues no read of its own behind the held one.
      await runCard.click({ position: { x: 10, y: 10 } });
      await expectPipelineRunPanel(window, EXECUTION_ID);

      // The detail lease's snapshot read is blocked behind the held IPC
      // call: the panel renders its loading state, never the nav, until the
      // read resolves.
      await expect(window.getByText('Loading execution details…')).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByTestId('pipeline-details-nav')).toHaveCount(0);

      // A newer terminal event arrives while the read is still held. It
      // carries no `job_definitions`/`job_groups` (mirroring a real
      // `ExecutionEvent` — see `seedPipelineExecution`'s returned `state`),
      // so `pipelineRunsStore.handleExecutionEvent` has nothing cached to
      // merge it onto yet and cannot update `statesById` from it alone — but
      // it DOES mark the in-flight read superseded
      // (`noteExecutionStateObserved` / `ExecutionDetailRead.superseded`) and
      // remembers this state as `latestState`. The panel is still stuck
      // loading at this point; that is expected, not a bug, and is asserted
      // below to make the ordering explicit.
      const successState = buildSuccessState(seededState, {
        jobId: JOB_ID,
        stepId: STEP_ID,
        completedAt: '2026-05-03T12:02:00.000Z',
      });
      await injectPipelineExecutionEvent(electronApp, {
        state: successState,
        type: 'execution.completed',
      });
      await expect(window.getByTestId('pipeline-details-nav')).toHaveCount(0);

      // Release the held (now stale) snapshot read. Before this phase's
      // generation guard, a `loadExecutionDetails`-style read's `.then`
      // handler would have unconditionally installed whatever `getExecution`
      // returned — the STALE, still-'running' snapshot read from disk —
      // clobbering the newer completed event and leaving the panel
      // permanently on 'running' once it resolved. With the guard, the
      // superseded read merges the newer event's status/jobs onto the
      // snapshot's structure (`mergeExecutionEventState`) instead of
      // overwriting outright, so the final, settled value is 'success'.
      await release(electronApp, 'getExecution');

      const summaryBar = window.getByTestId('pipeline-summary-bar');
      await expect(summaryBar).toBeVisible({ timeout: 15_000 });
      await waitForStableValue(async () => {
        const text = (await summaryBar.textContent()) ?? '';
        if (text.includes('success')) return 'success';
        if (text.includes('running')) return 'running';
        return text;
      }, 'success');
    } finally {
      await uninstallPipelineIpcProbe(electronApp);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('terminal transition re-reads the log once', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-detail-lifecycle-single-reread-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const EXECUTION_ID = 'e2e-detail-lifecycle-single-reread-1';
  const JOB_ID = 'build';
  const STEP_ID = 'compile';
  const STARTED_AT = '2026-05-04T12:00:00.000Z';
  const PERSISTED_LINES = ['SINGLE_REREAD_SEEDED_PERSISTED_LINE'];

  const { state: seededState } = seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'Single Re-read Pipeline',
      status: 'running',
      startedAt: STARTED_AT,
      jobs: [
        {
          id: JOB_ID,
          name: 'Build',
          steps: [{ id: STEP_ID, name: 'Compile', run: 'npm run build' }],
        },
      ],
    },
    stepLogs: [{ jobId: JOB_ID, stepId: STEP_ID, lines: PERSISTED_LINES }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await installPipelineIpcProbe(electronApp);
    try {
      const runCard = window.getByTestId(`pipeline-run-card-${EXECUTION_ID}`);
      await expect(runCard).toBeVisible({ timeout: 15_000 });
      await runCard.click({ position: { x: 10, y: 10 } });
      await expectPipelineRunPanel(window, EXECUTION_ID);
      await showPipelineJobList(window, { timeout: 15_000 });
      await window.getByTestId(`pipeline-details-nav-job-${JOB_ID}`).click();
      await expect(
        window.getByTestId(`pipeline-job-view-${JOB_ID}`),
      ).toBeVisible();
      await ensureStepExpanded(window, STEP_ID);

      const logOutput = window.getByTestId(
        `pipeline-step-log-output-${STEP_ID}`,
      );
      const logLines = logOutput.locator('[data-testid="ansi-output"] > div');
      // Wait for the INITIAL snapshot read to settle (and its content to
      // render) before resetting counts, so the post-reset baseline of 0 is
      // not an accident of timing against the mount-time read.
      await expect
        .poll(() => logLines.allTextContents(), { timeout: 15_000 })
        .toEqual(PERSISTED_LINES);
      await expect
        .poll(async () => (await readCounts(electronApp)).readStepLog.count)
        .toBeGreaterThan(0);

      await resetCounts(electronApp);

      // The step is currently open and RUNNING
      // (`terminal: !isStepRunning` in `PipelineStepDetail.tsx`); this event
      // flips its status to `success` for the first time, which should
      // trigger exactly one authoritative re-read
      // (`StepLogInterest.setTerminal(true)` -> `requestRead` in
      // `pipelineStepLogStore.ts`) — not zero (stuck showing stale output
      // forever past completion) and not more than one (a duplicate-read
      // storm). Before this phase's log catch-up gate, step output lived in
      // `pipelineRunsStore`'s coarser `appendStepOutputBatch`
      // (see the deleted `usePipelineRunsSubscription.ts`) with no
      // documented one-re-read-per-terminal-transition contract for a
      // dedicated per-log interest.
      const successState = buildSuccessState(seededState, {
        jobId: JOB_ID,
        stepId: STEP_ID,
        completedAt: '2026-05-04T12:02:00.000Z',
      });
      await injectPipelineExecutionEvent(electronApp, {
        state: successState,
        type: 'execution.completed',
      });

      await waitForStableValue(
        async () => (await readCounts(electronApp)).readStepLog.count,
        1,
      );
    } finally {
      await uninstallPipelineIpcProbe(electronApp);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
