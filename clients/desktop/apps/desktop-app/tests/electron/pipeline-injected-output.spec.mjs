import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import {
  injectPipelineStepOutputChunks,
  injectPipelineStepOutputEvent,
} from './seeders/injectPipelineStepOutputEvent.mjs';
import {
  hold,
  installPipelineIpcProbe,
  readCounts,
  release,
  resetCounts,
  uninstallPipelineIpcProbe,
} from './pipelineIpcProbe.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
  showPipelineJobList,
} from './pipelineUi.mjs';

// Phase 01 (pipeline workspace panels) harness preservation spec.
//
// It proves three harness primitives against the pipeline execution detail
// that a run card opens (see `docs/planning/2026-09-23-pipeline-workspace-
// panels/phases/phase-01-panel-contract-and-harness.md`). Since phase 03 the
// card opens the run's `pipeline-execution` panel tab, which replaced the
// takeover modal these tests were first written against:
//
//   1. `seeders/injectPipelineStepOutputEvent.mjs` — sends live
//      `StepOutputEvent`s on the real `pipelines:step-output-event` channel.
//   2. `pipelineIpcProbe.mjs` — counts (and can hold) calls to the pipeline
//      read channels (`readStepLog`, `getExecution`, `readReportFile`) via the
//      existing `ipcMain._invokeHandlers` rewiring pattern.
//   3. `seeders/injectPipelineExecutionEvent.mjs` — imported by path. The
//      seeders index is a frozen browser-profiles study harness input, so new
//      pipeline helpers are deliberately NOT re-exported from it.
//
// A third test below exercises the probe's `hold`/`release` gate and
// `uninstall` restoration DIRECTLY against `window.pipelines.*` (no detail UI
// involved), for all three probed channels — the first two tests only ever
// observed `readStepLog` incidentally through the detail, and never held or
// released a channel or uninstalled mid-test.
//
// Determinism: one execution is seeded on disk (`seedPipelineExecution`) with
// a persisted step log sidecar before launch; the live pieces are the
// injected `StepOutputEvent`s and one injected `ExecutionEvent` transition —
// no live agents, no network, no PTY, no sleeps (`expect.poll` / `toContainText`
// timeouts only). The hold/release test never races a fixed delay against
// completion either: because `hold()` installs a gate the wrapper awaits
// before delegating to the original handler, the held renderer promise is
// PROVABLY unresolved (not just probably) until this test calls `release()`.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const EXECUTION_ID = 'e2e-injected-output-1';
const JOB_ID = 'build';
const JOB_NAME = 'Build';
const STEP_ID = 'compile';
const STEP_NAME = 'Compile';
const STARTED_AT = '2026-04-10T12:00:00.000Z';

// Seeded persisted log content — textually distinct from every injected line
// below so `mergeStepOutputLines`'s persisted/live overlap heuristic
// (`pipelineRunOutput.ts`, up to a 5-line textual overlap window) cannot fold
// any of them together. That keeps "each injected line appears exactly once"
// an unambiguous assertion.
const PERSISTED_LINES = ['SEEDED_PERSISTED_LINE_1', 'SEEDED_PERSISTED_LINE_2'];

async function waitForActivityPanel(window) {
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
}

test('injected step-output events and the IPC probe hold up against the run detail panel', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-injected-output-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { state: seededState } = seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'Injected Output Pipeline',
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
    await waitForActivityPanel(window);

    // Install the probe BEFORE opening the run, so the very first
    // `readStepLog` triggered by mounting the step detail is observed.
    await installPipelineIpcProbe(electronApp);

    try {
      // ---- Open the run card, then navigate to its one job ----
      const runCard = window.getByTestId(`pipeline-run-card-${EXECUTION_ID}`);
      await expect(runCard).toBeVisible({ timeout: 15_000 });
      await expect(runCard).toContainText('running');
      // Click the card's top-left corner: the panel-grid activity column is
      // narrow enough that the card's center lands on wrapped action buttons
      // that stop propagation instead of opening the run's panel (see
      // `pipeline-runs.spec.mjs` `openRunCard`).
      await runCard.click({ position: { x: 10, y: 10 } });
      await expectPipelineRunPanel(window, EXECUTION_ID);

      await showPipelineJobList(window, { timeout: 15_000 });
      await window.getByTestId(`pipeline-details-nav-job-${JOB_ID}`).click();
      await expect(
        window.getByTestId(`pipeline-job-view-${JOB_ID}`),
      ).toBeVisible();

      // ---- The running step is expanded by default (`isStepDefaultExpanded`
      // in `lib/pipelineDetailsView.ts` expands a step whose status is
      // `'running'`), so its detail — and therefore its log output — is
      // already mounted without a click. Assert that surprise explicitly
      // instead of assuming a click is required, then fall back to clicking
      // if a future change ever reverts the auto-expand default. ----
      const stepRow = window.getByTestId(`pipeline-step-${STEP_ID}`);
      await expect(stepRow).toBeVisible();
      const stepToggle = stepRow.getByRole('button').first();
      if ((await stepToggle.getAttribute('aria-expanded')) !== 'true') {
        await stepToggle.click();
      }

      const stepDetail = window.getByTestId(`pipeline-step-detail-${STEP_ID}`);
      await expect(stepDetail).toBeVisible();
      const logOutput = window.getByTestId(
        `pipeline-step-log-output-${STEP_ID}`,
      );
      const logLines = logOutput.locator('[data-testid="ansi-output"] > div');

      // The seeded persisted lines render from the initial `readStepLog` read.
      await expect
        .poll(() => logLines.allTextContents(), { timeout: 15_000 })
        .toEqual(PERSISTED_LINES);

      // ---- The probe observed the readStepLog call(s) that populated it ----
      const countsAfterOpen = await readCounts(electronApp);
      expect(countsAfterOpen.readStepLog.count).toBeGreaterThan(0);
      expect(
        countsAfterOpen.readStepLog.calls.some(
          (call) =>
            call.executionId === EXECUTION_ID &&
            call.jobId === JOB_ID &&
            call.stepId === STEP_ID,
        ),
      ).toBe(true);

      // ---- Inject distinct stdout chunks, including one that splits a line
      // mid-token across two events, and assert they appear in order, exactly
      // once, appended after the seeded persisted lines. ----
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
        ['gamma-1\n', 'alpha-1\nalph', 'a-2\n'],
      );

      const expectedLines = [
        ...PERSISTED_LINES,
        'gamma-1',
        'alpha-1',
        'alpha-2',
      ];
      await expect
        .poll(() => logLines.allTextContents(), { timeout: 15_000 })
        .toEqual(expectedLines);
      // Re-assert after settling: each injected line appears EXACTLY once
      // (no duplication from a re-render or a second buffer flush).
      const finalLines = await logLines.allTextContents();
      for (const line of ['gamma-1', 'alpha-1', 'alpha-2']) {
        expect(finalLines.filter((entry) => entry === line)).toHaveLength(1);
      }

      // ---- `injectPipelineExecutionEvent`, now re-exported from
      // `seeders/index.mjs`, still drives a live status transition. ----
      const successState = {
        ...seededState,
        status: 'success',
        completed_at: '2026-04-10T12:02:00.000Z',
        jobs: {
          ...seededState.jobs,
          [JOB_ID]: {
            ...seededState.jobs[JOB_ID],
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            completed_at: '2026-04-10T12:02:00.000Z',
            steps: {
              ...seededState.jobs[JOB_ID].steps,
              [STEP_ID]: {
                ...seededState.jobs[JOB_ID].steps[STEP_ID],
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                completed_at: '2026-04-10T12:02:00.000Z',
                exit_code: 0,
              },
            },
          },
        },
      };
      await injectPipelineExecutionEvent(electronApp, {
        state: successState,
        type: 'execution.completed',
      });
      await expect(runCard).toContainText('success', { timeout: 15_000 });

      await closePipelineRunPanels(window);
    } finally {
      await uninstallPipelineIpcProbe(electronApp);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Sanity-check the single-event injector independently of the chunk
// convenience wrapper: a lone event with `stream: 'stderr'` and no
// trailing-newline remainder renders as one line, keeping the two exported
// helpers independently exercised.
test('a single injected stderr event without the chunk helper renders one line', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-injected-output-single-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'Injected Single Event Pipeline',
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
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await waitForActivityPanel(window);

    const runCard = window.getByTestId(`pipeline-run-card-${EXECUTION_ID}`);
    await expect(runCard).toBeVisible({ timeout: 15_000 });
    await runCard.click({ position: { x: 10, y: 10 } });
    await expectPipelineRunPanel(window, EXECUTION_ID);
    await showPipelineJobList(window, { timeout: 15_000 });
    await window.getByTestId(`pipeline-details-nav-job-${JOB_ID}`).click();
    await expect(
      window.getByTestId(`pipeline-job-view-${JOB_ID}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`pipeline-step-detail-${STEP_ID}`),
    ).toBeVisible();

    await injectPipelineStepOutputEvent(electronApp, {
      executionId: EXECUTION_ID,
      jobId: JOB_ID,
      jobName: JOB_NAME,
      stepId: STEP_ID,
      stepName: STEP_NAME,
      attempt: 0,
      iteration: 1,
      stream: 'stderr',
      data: 'STDERR_SINGLE_LINE\n',
    });

    const logLines = window
      .getByTestId(`pipeline-step-log-output-${STEP_ID}`)
      .locator('[data-testid="ansi-output"] > div');
    await expect
      .poll(() => logLines.allTextContents(), { timeout: 15_000 })
      .toEqual(['STDERR_SINGLE_LINE']);

    await closePipelineRunPanels(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Exercises `pipelineIpcProbe`'s hold/release gate and its `uninstall`
// restoration directly against `window.pipelines.*`, for EACH of the three
// probed channels (`getExecution`, `readStepLog`, `readReportFile`). The
// earlier tests in this file only ever observed `readStepLog` incidentally
// through the run detail and never held a channel, released one, or uninstalled
// mid-test — this test is the PR-review follow-up closing that gap.
test('pipelineIpcProbe holds, counts, and releases getExecution/readStepLog/readReportFile, and uninstall restores the originals', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-ipc-probe-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  // `readReportFile` only returns `{ success: true, data }` when the seeded
  // state points at a real file under the execution's data directory
  // (`state.report_outputs.report_file`, checked with `isPathInside` against
  // `executionsDir`); write one alongside the seeded execution so this test
  // exercises the SUCCESS shape, not just the "no report" error shape.
  const executionsDir = path.join(userDataDir, 'pipeline-executions');
  const reportFilePath = path.join(executionsDir, EXECUTION_ID, 'report.txt');
  const REPORT_CONTENT = 'REPORT_CONTENT_MARKER\n';

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: EXECUTION_ID,
      pipelineName: 'IPC Probe Pipeline',
      status: 'success',
      startedAt: STARTED_AT,
      completedAt: '2026-04-10T12:01:00.000Z',
      jobs: [
        {
          id: JOB_ID,
          name: JOB_NAME,
          steps: [{ id: STEP_ID, name: STEP_NAME, run: 'npm run build' }],
        },
      ],
      stateOverrides: { report_outputs: { report_file: reportFilePath } },
    },
    stepLogs: [{ jobId: JOB_ID, stepId: STEP_ID, lines: PERSISTED_LINES }],
  });
  mkdirSync(path.dirname(reportFilePath), { recursive: true });
  writeFileSync(reportFilePath, REPORT_CONTENT, 'utf8');

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // No run detail is opened here on purpose: these are direct `window.pipelines`
    // calls, proving the probe intercepts the real preload API surface, not
    // only whatever a particular UI flow happens to trigger.
    await installPipelineIpcProbe(electronApp);
    try {
      const cases = [
        {
          key: 'getExecution',
          invoke: () =>
            window.evaluate(
              (id) => window.pipelines.getExecution(id),
              EXECUTION_ID,
            ),
          assertResolved: (result) => {
            expect(result.success).toBe(true);
            expect(result.data?.id).toBe(EXECUTION_ID);
          },
        },
        {
          key: 'readStepLog',
          invoke: () =>
            window.evaluate(
              (locator) => window.pipelines.readStepLog(locator),
              { executionId: EXECUTION_ID, jobId: JOB_ID, stepId: STEP_ID },
            ),
          assertResolved: (result) => {
            expect(result.success).toBe(true);
            expect(result.data?.lines).toEqual(PERSISTED_LINES);
          },
        },
        {
          key: 'readReportFile',
          invoke: () =>
            window.evaluate(
              ({ id, kind }) => window.pipelines.readReportFile(id, kind),
              { id: EXECUTION_ID, kind: 'text' },
            ),
          assertResolved: (result) => {
            expect(result.success).toBe(true);
            expect(result.data?.content).toBe(REPORT_CONTENT);
          },
        },
      ];

      for (const probeCase of cases) {
        await resetCounts(electronApp);
        await hold(electronApp, probeCase.key);

        let settled = false;
        const pending = probeCase.invoke().then((result) => {
          settled = true;
          return result;
        });

        // The probe counted the call while the renderer promise is still
        // unresolved: the wrapper increments the count BEFORE awaiting the
        // hold gate, so this poll can only observe count === 1 once the call
        // has already been intercepted and parked behind the gate.
        await expect
          .poll(
            async () => (await readCounts(electronApp))[probeCase.key].count,
          )
          .toBe(1);
        // Not a race: `release` has not been called yet, and the wrapper
        // cannot reach `entry.original(...)` until it has been, so this is a
        // deterministic assertion rather than a point-in-time guess.
        expect(settled).toBe(false);

        await release(electronApp, probeCase.key);
        const result = await pending;
        expect(settled).toBe(true);
        probeCase.assertResolved(result);

        // Exactly one call was recorded for this channel across the whole
        // held-then-released round trip.
        const counts = await readCounts(electronApp);
        expect(counts[probeCase.key].count).toBe(1);
      }
    } finally {
      await uninstallPipelineIpcProbe(electronApp);
    }

    // `uninstall` removed the probe's `globalThis` state entirely, so it can
    // no longer count anything...
    await expect(readCounts(electronApp)).rejects.toThrow(
      /Pipeline IPC probe is not installed/,
    );
    // ...and the ORIGINAL (real, production-wrapped) handler is back in
    // place: an ordinary call still succeeds with the same result shape as
    // before the probe was ever installed.
    const resultAfterUninstall = await window.evaluate(
      (id) => window.pipelines.getExecution(id),
      EXECUTION_ID,
    );
    expect(resultAfterUninstall.success).toBe(true);
    expect(resultAfterUninstall.data?.id).toBe(EXECUTION_ID);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
