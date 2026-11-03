import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { ORG_CONTEXT_ENV } from './seeders/seedOrgContextScoping.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
  showPipelineJobList,
} from './pipelineUi.mjs';

// Doc 2 — Spec 6: pipeline runs + the redesigned execution detail.
//
// A run card opens the run's own `pipeline-execution` panel tab through the
// shared opener (phase 03 of the pipeline workspace panels plan; it was a
// takeover modal before). The detail is a GitHub-Actions-style layout: a
// persistent left nav (`PipelineDetailsNav`) with a `Summary` entry, a
// dynamic status filter, one entry per seeded job, and an `Open current
// definition ↗` link; a default `Summary` view (`PipelineSummaryView`) with a
// metadata bar (`PipelineSummaryBar`) + `More details` expander and the run
// flow diagram; and
// a per-job `Job` view (`PipelineJobView`) whose steps are an accordion of
// `PipelineStepRow`s that expand to reveal `PipelineStepDetail` (timing/config/
// inputs/outputs + log output).
//
// Two-phase seeding (harness primitive H4):
//   1. seedDemoWorkspaces({ apps: ['ts-pnpm-vite'] }) — workspace
//      `demo-ts-pnpm-vite`, worktree branch `demo-main`. This is the worktree
//      whose Pipeline Runs section we open.
//   2. seedPipelineExecution({ workspaceId, worktreeId, execution }) for each
//      variant. The seeder writes
//      `{userDataDir}/pipeline-executions/{id}.json` (an `ExecutionState`) plus
//      optional `{id}/logs/{job}--{step}.log` step log sidecars. The state's
//      `project_id` / `worktree_id` are what `pipelineRunsStore` filters against
//      the *selected* worktree, so they MUST equal the demo workspace/worktree
//      ids for the run cards to appear in this worktree's Pipeline Runs section.
//
// The Pipeline Runs section lives in the ActivityPanel section stack
// (`PipelineRunsSection.tsx`), which renders expanded inside the panel grid
// (`panel-content-activity-section`) — the old collapse chrome is gone, so
// we only wait for the panel content to mount. Each run renders a clickable
// card with testid
// `pipeline-run-card-${executionId}`; clicking it opens the run's panel
// (`pipeline-execution-panel`, beside the chat), which specs close by its tab.
//
// Detail testids exercised:
//   - `pipeline-details-nav` (left nav), `pipeline-details-nav-summary`,
//     `pipeline-details-nav-job-${jobId}`, `pipeline-details-open-definition`
//   - `pipeline-details-filter-button` → `pipeline-details-filter-popover`
//     (lists ONLY the job statuses present in the run)
//   - `pipeline-summary-view`, `pipeline-summary-bar`, `pipeline-summary-more`
//   - `pipeline-job-view-${jobId}`, `pipeline-step-${stepId}`,
//     `pipeline-step-detail-${stepId}` (expand-to-reveal step detail + log)
//
// Pause/resume coverage preserved from the original spec (these controls still
// render inside the detail, in the Summary view's pause slot):
//   - `pause-input-panel`, `pause-field-${key}`, `pause-input-resume`
//     (structured request-input pause — PauseInputPanel.tsx)
//   - `pause-formless-resume` (formless pause — FormlessResume)
//
// Determinism: no live agents, no network, and no PTY. Most assertions inspect
// seeded state. The structured-pause case also resumes one local shell step so
// the renderer-to-main resume wiring and the resulting UI refresh are covered.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

// Distinct execution ids so each variant gets its own run card.
const FAILED_ID = 'e2e-failed-1';
const PAUSED_STRUCTURED_ID = 'e2e-paused-structured-1';
const PAUSED_FORMLESS_ID = 'e2e-paused-formless-1';
const PAUSED_RECOVERY_ID = 'e2e-paused-recovery-1';
const RECOVERY_REASON_ID = '223e4567-e89b-42d3-a456-426614174000';
const FORMLESS_REASON_ID = '323e4567-e89b-42d3-a456-426614174000';
const FORMLESS_CHECKPOINT_ID = '423e4567-e89b-42d3-a456-426614174000';
const LIVE_RESUME_PIPELINE_ID = 'e2e-live-partial-resume';
const LIVE_RESUME_PIPELINE_NAME = 'E2E Live Partial Resume Pipeline';
const LIVE_RESUME_PIPELINE_YAML = [
  `name: ${LIVE_RESUME_PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  gate:',
  '    name: Gate',
  '    steps:',
  '      - id: pause_once',
  '        name: Pause Once',
  '        run: |',
  '          if [ ! -f .e2e-live-resume-once ]; then',
  '            touch .e2e-live-resume-once',
  '            echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
  '          fi',
  '  peer:',
  '    name: Peer',
  '    steps:',
  '      - id: wait',
  '        name: Wait',
  '        run: sleep 10',
  '',
].join('\n');

// A 90s step window — the wall-clock step duration we assert (formatElapsed).
const STEP_STARTED_AT = '2026-04-10T12:00:00.000Z';
const STEP_COMPLETED_AT = '2026-04-10T12:01:30.000Z';

async function waitForActivityPanel(window) {
  // The activity panel renders expanded inside the panel grid (the old
  // collapse chrome and expand button are gone); wait for its panel content
  // to mount so the sections are queryable.
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
}

async function openRunCard(window, executionId) {
  const card = window.getByTestId(`pipeline-run-card-${executionId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Click the card's top-left (the status-badge row). In the panel grid the
  // activity column is narrow enough that the card's CENTER lands on the
  // wrapped Debug/Retry/Start-over action buttons, which stopPropagation and
  // dispatch their own actions instead of opening the run's panel.
  await card.click({ position: { x: 10, y: 10 } });
  const panel = await expectPipelineRunPanel(window, executionId);
  // Beside the chat the panel is narrower than the job list's auto-collapse
  // width, so the list presents collapsed; these specs drive the list, so
  // expand it the way a user does.
  await showPipelineJobList(panel);
}

async function closeRunPanel(window) {
  await closePipelineRunPanels(window);
}

// ---------------------------------------------------------------------------
// `foreach` fan-out helpers (grouped fan-out UI coverage).
//
// A **`foreach` child** is one materialized member of a fan-out job living on
// `JobResult.children[]` inside a SINGLE `ExecutionState`. It is NOT a nested
// **child execution** (`parent_execution_id` / `ExecutionSummary.child_count`).
// `foreach` children therefore have no execution id, never get an activity
// row, and are never promoted to top-level graph nodes or sidebar jobs — which
// is exactly what these specs assert.
//
// Seeding note: `seedPipelineExecution` builds ordinary jobs, so fan-out job
// results are injected through `stateOverrides.jobs`. A `foreach` parent's own
// `steps` is `{}` and its `outputs` is `{}` — the child list is the content.
// ---------------------------------------------------------------------------

/** Mirrors the executor's `child-<index base36, 6 wide>` id format. */
function foreachChildId(index) {
  return `child-${index.toString(36).padStart(6, '0')}`;
}

function terminalStepResult(status, startedAt, completedAt) {
  return {
    status,
    conclusion: status,
    outcome: status,
    outputs: {},
    dynamic_env: {},
    started_at: startedAt,
    ...(completedAt ? { completed_at: completedAt } : {}),
    exit_code: status === 'success' ? 0 : 1,
  };
}

/**
 * One `foreach` child result. `name` defaults to empty so the UI exercises its
 * `Child 1` / `Child 2` fallback labels over the 0-based `index`.
 */
function foreachChild({
  index,
  status,
  name = '',
  outcome,
  key,
  stepId,
  startedAt,
  completedAt,
}) {
  const childStatus = status;
  const stepStatus =
    childStatus === 'success' || childStatus === 'failure'
      ? childStatus
      : childStatus === 'running' || childStatus === 'paused'
        ? 'running'
        : 'pending';
  return {
    id: foreachChildId(index),
    index,
    ...(key !== undefined ? { key } : {}),
    item: `item-${String(index)}`,
    name,
    status: childStatus,
    ...(outcome ? { outcome, conclusion: outcome } : {}),
    steps: stepId
      ? {
          [stepId]:
            stepStatus === 'pending'
              ? { status: 'pending', outputs: {}, dynamic_env: {} }
              : stepStatus === 'running'
                ? {
                    status: 'running',
                    outputs: {},
                    dynamic_env: {},
                    started_at: startedAt,
                  }
                : terminalStepResult(stepStatus, startedAt, completedAt),
        }
      : {},
    outputs: {},
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
  };
}

/**
 * A `foreach` parent job result. Note `steps: {}` / `outputs: {}` — the empty
 * `steps` trap this feature's UI has to survive.
 */
function foreachJobResult({
  status,
  children,
  maxParallel,
  outcome,
  conclusion,
  startedAt,
  completedAt,
}) {
  return {
    status,
    steps: {},
    outputs: {},
    children,
    ...(maxParallel !== undefined
      ? { resolved_max_parallel: maxParallel }
      : {}),
    ...(outcome ? { outcome } : {}),
    ...(conclusion ? { conclusion } : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
  };
}

test.describe('pipeline runs + redesigned run detail panel (Spec 6)', () => {
  test('left nav, summary view, status filter, job view, and step detail render from seeded state', async () => {
    // Phase 1: seed the demo workspace into an isolated data dir.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-pipeline-runs-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Phase 2a: FAILED run with two jobs and a step carrying a log sidecar plus
    // a known 90s step window. Both jobs share the seeded top-level status
    // (`failure`), so the status filter lists ONLY `failure` (+ `All`) — letting
    // us assert a present status appears and absent statuses do not. The
    // `compile` step's started/completed timestamps are 90s apart so its detail
    // Timing renders the wall-clock Duration `1m 30s`.
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: FAILED_ID,
        pipelineName: 'E2E Failed Pipeline',
        status: 'failure',
        startedAt: STEP_STARTED_AT,
        completedAt: STEP_COMPLETED_AT,
        jobs: [
          {
            id: 'build',
            name: 'Build',
            steps: [{ id: 'compile', name: 'Compile', run: 'npm run build' }],
          },
          {
            id: 'test',
            name: 'Test',
            steps: [{ id: 'unit', name: 'Unit tests', run: 'npm test' }],
          },
        ],
        stepResults: {
          'build.compile': {
            started_at: STEP_STARTED_AT,
            completed_at: STEP_COMPLETED_AT,
          },
        },
      },
      stepLogs: [
        {
          jobId: 'build',
          stepId: 'compile',
          lines: [
            '> e2e build start',
            'compiling sources...',
            'E2E_STEP_LOG_MARKER build finished',
          ],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await waitForActivityPanel(window);
      await expect(window.getByText('Workflow runs').first()).toBeVisible({
        timeout: 15_000,
      });

      // ---- The run row labels its start and shows the exact time on hover ----
      // The tooltip is local time without a year, so assert only that it
      // resolved a real timestamp; the row's dateTime pins the seeded start.
      const dispatched = window
        .getByTestId(`pipeline-run-card-${FAILED_ID}`)
        .getByTestId(`pipeline-run-dispatched-${FAILED_ID}`);
      await expect(dispatched).toHaveText(/^Dispatched /, { timeout: 15_000 });
      await expect(dispatched).toHaveAttribute('datetime', STEP_STARTED_AT);
      await dispatched.hover();
      const dispatchedTooltip = window.getByRole('tooltip');
      await expect(dispatchedTooltip).toHaveText(/\S/);
      await expect(dispatchedTooltip).not.toHaveText('Not available');
      await window.mouse.move(0, 0);

      await openRunCard(window, FAILED_ID);

      // ---- Left nav present, with Summary + the two seeded jobs ----
      const nav = window.getByTestId('pipeline-details-nav');
      await expect(nav).toBeVisible({ timeout: 15_000 });
      await expect(
        nav.getByTestId('pipeline-details-nav-summary'),
      ).toBeVisible();
      await expect(
        nav.getByTestId('pipeline-details-nav-job-build'),
      ).toBeVisible();
      await expect(
        nav.getByTestId('pipeline-details-nav-job-test'),
      ).toBeVisible();
      // The "Open current definition ↗" link lives at the foot of the nav.
      await expect(
        nav.getByTestId('pipeline-details-open-definition'),
      ).toBeVisible();

      // ---- Default Summary view + metadata bar + More details expander ----
      const summaryView = window.getByTestId('pipeline-summary-view');
      await expect(summaryView).toBeVisible();
      const summaryBar = window.getByTestId('pipeline-summary-bar');
      await expect(summaryBar).toBeVisible();
      // The bar shows always-visible run status/timing fields.
      await expect(summaryBar.getByText('Status').first()).toBeVisible();
      await expect(summaryBar.getByText('Duration').first()).toBeVisible();
      // "More details" toggles the lower-signal metadata (working directory).
      const summaryMore = window.getByTestId('pipeline-summary-more');
      await expect(summaryMore).toBeVisible();
      await expect(summaryMore).toHaveAttribute('aria-expanded', 'false');
      await summaryMore.click();
      await expect(summaryMore).toHaveAttribute('aria-expanded', 'true');
      await expect(summaryBar.getByText('Working directory')).toBeVisible();
      // Restored run-metadata fields (Trigger / Workflow ID / Execution ID).
      await expect(summaryBar.getByText('Trigger')).toBeVisible();
      await expect(summaryBar.getByText('Workflow ID')).toBeVisible();
      await expect(summaryBar.getByText('Execution ID')).toBeVisible();

      // ---- Status filter lists ONLY statuses present in the run ----
      const filterButton = window.getByTestId('pipeline-details-filter-button');
      await expect(filterButton).toBeVisible();
      await filterButton.click();
      const filterPopover = window.getByTestId(
        'pipeline-details-filter-popover',
      );
      await expect(filterPopover).toBeVisible();
      // Both seeded jobs are `failure`, so `failure` is the only present status.
      await expect(
        filterPopover.getByText('Failure', { exact: true }),
      ).toBeVisible();
      // Statuses with no jobs in this run must not be offered.
      await expect(
        filterPopover.getByText('Success', { exact: true }),
      ).toHaveCount(0);
      await expect(
        filterPopover.getByText('Running', { exact: true }),
      ).toHaveCount(0);
      // Close the popover by re-clicking the filter trigger.
      await filterButton.click();
      await expect(filterPopover).toHaveCount(0);

      // ---- Selecting a job renders that job's Job view ----
      await window.getByTestId('pipeline-details-nav-job-build').click();
      const jobView = window.getByTestId('pipeline-job-view-build');
      await expect(jobView).toBeVisible();
      // Summary view is no longer shown once a job is selected.
      await expect(window.getByTestId('pipeline-summary-view')).toHaveCount(0);

      // ---- Expanding a step reveals its detail with the seeded log output ----
      const stepRow = window.getByTestId('pipeline-step-compile');
      await expect(stepRow).toBeVisible();
      // A non-running (failed) step is collapsed by default; its detail is not
      // yet mounted.
      await expect(
        window.getByTestId('pipeline-step-detail-compile'),
      ).toHaveCount(0);
      await stepRow.getByRole('button').first().click();

      const stepDetail = window.getByTestId('pipeline-step-detail-compile');
      await expect(stepDetail).toBeVisible();
      // The seeded log sidecar text renders in the step's log output.
      await expect(
        stepDetail.getByText('E2E_STEP_LOG_MARKER build finished'),
      ).toBeVisible({ timeout: 15_000 });
      // The step's own 90s wall-clock window renders as Duration `1m 30s` in the
      // Timing card — provably the step window, not time-since-modal-open.
      await expect(stepDetail.getByText('1m 30s').first()).toBeVisible();
      // The log output search box is present in the step detail.
      await expect(stepDetail.getByTestId('content-search-bar')).toBeVisible();

      // Escape inside the log search clears the search and leaves the detail
      // open; a panel never closes on Escape.
      const searchInput = stepDetail
        .getByTestId('content-search-bar')
        .locator('input')
        .first();
      await searchInput.fill('build');
      await expect(searchInput).toHaveValue('build');
      await searchInput.press('Escape');
      await expect(searchInput).toHaveValue('');
      await expect(window.getByTestId('pipeline-details-nav')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('pipeline-details-nav')).toBeVisible();

      // The "Open current definition ↗" link opens the pipeline in the
      // Workflows edit shell. Leaving the page hides (and suspends) the run
      // panel without closing its tab.
      const runPanel = window.locator(
        `[data-testid="pipeline-execution-panel"][data-execution-id="${FAILED_ID}"]`,
      );
      await window.getByTestId('pipeline-details-open-definition').click();
      await expect(window.getByTestId('pipeline-details-nav')).toBeHidden();
      await expect(runPanel).toHaveAttribute('data-detail-state', 'suspended');
      await expect(
        window.getByTestId(`panel-tab-panel-pipeline-${FAILED_ID}`),
      ).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('inline child executions render populated and empty matrix summaries', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-inline-matrix-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const parentExecutionId = 'e2e-inline-matrix-parent';
    const childExecutionId = 'e2e-inline-matrix-child';

    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: parentExecutionId,
        pipelineName: 'Inline Matrix Parent',
        status: 'success',
        completedAt: '2026-04-10T12:01:00.000Z',
        jobs: [
          {
            id: 'orchestrate',
            name: 'Orchestrate',
            steps: [{ id: 'nested', name: 'Nested pipeline' }],
          },
        ],
        stateOverrides: {
          pipeline_snapshot: {
            name: 'Inline Matrix Parent',
            jobs: {
              orchestrate: {
                name: 'Orchestrate',
                needs: [],
                timeout_minutes: 60,
                max_retries: 0,
                continue_on_error: false,
                steps: [
                  {
                    id: 'nested',
                    name: 'Nested pipeline',
                    uses: 'builtin/run-pipeline',
                    with: { pipeline: 'inline-matrix-child' },
                    continue_on_error: false,
                    timeout_minutes: 30,
                    skip_on_missing_action: false,
                  },
                ],
              },
            },
          },
        },
      },
    });
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: childExecutionId,
        pipelineName: 'Inline Matrix Child',
        status: 'success',
        completedAt: '2026-04-10T12:00:30.000Z',
        jobs: [
          {
            id: 'populated',
            name: 'Populated matrix',
            steps: [{ id: 'work', name: 'Work' }],
          },
          {
            id: 'empty',
            name: 'Empty matrix',
            steps: [{ id: 'noop', name: 'Noop' }],
          },
        ],
        stateOverrides: {
          parent_execution_id: parentExecutionId,
          parent_step_id: 'nested',
          parent_attempt: 0,
          jobs: {
            populated: foreachJobResult({
              status: 'success',
              conclusion: 'success',
              outcome: 'success',
              children: [
                foreachChild({ index: 0, status: 'success' }),
                foreachChild({ index: 1, status: 'success' }),
              ],
              maxParallel: 1,
              startedAt: STEP_STARTED_AT,
              completedAt: '2026-04-10T12:00:30.000Z',
            }),
            empty: foreachJobResult({
              status: 'success',
              conclusion: 'success',
              outcome: 'success',
              children: [],
              maxParallel: 0,
              startedAt: STEP_STARTED_AT,
              completedAt: '2026-04-10T12:00:05.000Z',
            }),
          },
        },
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
      await openRunCard(window, parentExecutionId);
      await window.getByTestId('pipeline-details-nav-job-orchestrate').click();
      await window.getByText('Inline Matrix Child', { exact: true }).click();

      await expect(
        window.getByTestId('pipeline-inline-matrix-populated'),
      ).toContainText('2 variants');
      await expect(
        window.getByTestId('pipeline-inline-matrix-populated'),
      ).toContainText('Max parallel: 1');
      await expect(
        window.getByTestId('pipeline-inline-matrix-empty-empty'),
      ).toHaveText('No variants were generated for this job.');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('expanded nested paused executions hydrate their resume controls', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-nested-pause-preview-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const parentExecutionId = 'e2e-nested-pause-parent';
    const childExecutionId = 'e2e-nested-pause-child';

    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: parentExecutionId,
        pipelineName: 'Nested Pause Parent',
        status: 'success',
        completedAt: '2026-04-10T12:01:00.000Z',
      },
    });
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: childExecutionId,
        pipelineName: 'Nested Pause Child',
        status: 'paused',
        stepResults: {
          'build.compile': {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            pause_requested: true,
          },
        },
        stateOverrides: {
          version: 8,
          parent_execution_id: parentExecutionId,
          parent_step_id: 'compile',
          parent_attempt: 0,
          jobs: {
            build: {
              status: 'paused',
              steps: {
                compile: {
                  status: 'success',
                  conclusion: 'success',
                  outcome: 'success',
                  outputs: {},
                  dynamic_env: {},
                  started_at: STEP_STARTED_AT,
                  completed_at: STEP_STARTED_AT,
                  exit_code: 0,
                  pause_requested: true,
                },
              },
              outputs: {},
              retry_count: 0,
              retry_history: [],
              iteration_count: 1,
              started_at: STEP_STARTED_AT,
            },
          },
          job_definitions: {
            build: {
              name: 'Build',
              needs: [],
              if: 'true',
              env: {},
              outputs: {},
              timeout_minutes: 60,
              max_retries: 0,
              continue_on_error: false,
              steps: [
                {
                  id: 'compile',
                  name: 'Compile',
                  run: 'echo resumed',
                  shell: 'bash',
                  continue_on_error: false,
                  timeout_minutes: 30,
                  skip_on_missing_action: false,
                },
              ],
              physical_job_id: 'build',
              logical_job_id: 'build',
            },
          },
          job_groups: {
            build: {
              job_id: 'build',
              kind: 'single',
              expansion: 'expanded',
              variant_job_ids: ['build'],
              status: 'paused',
              started_at: STEP_STARTED_AT,
            },
          },
          pending_pauses: [
            {
              id: 'nested-pause-checkpoint',
              kind: 'action',
              job_id: 'build',
              logical_job_id: 'build',
              step_id: 'compile',
              attempt: 0,
              iteration: 1,
              detected_at: STEP_STARTED_AT,
            },
          ],
          status_reasons: [
            {
              id: '123e4567-e89b-42d3-a456-426614174010',
              kind: 'action_paused',
              code: 'action_requested_pause',
              detected_at: STEP_STARTED_AT,
              source: {
                job_id: 'build',
                step_id: 'compile',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        },
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

      const parentCard = window.getByTestId(
        `pipeline-run-card-${parentExecutionId}`,
      );
      await expect(parentCard).toBeVisible({ timeout: 15_000 });
      await window.getByRole('button', { name: '1 sub-workflow' }).click();

      await expect(
        window.getByTestId(`pipeline-run-card-${childExecutionId}`),
      ).toBeVisible();
      await expect(
        window.getByTestId(`pipeline-run-resume-${childExecutionId}`),
      ).toBeEnabled();
      await window
        .getByTestId(`pipeline-run-resume-${childExecutionId}`)
        .click();
      await expect(
        window.getByTestId(`pipeline-run-resume-${childExecutionId}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(`pipeline-run-card-${childExecutionId}`),
      ).toContainText('success', { timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('paused runs render structured request-input and formless resume controls', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-pipeline-pauses-'),
    );
    const seedResult = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const demoWorktreePath = seedResult.workspaces.find(
      (workspace) => workspace.id === WORKSPACE_ID,
    )?.worktreePath;
    expect(demoWorktreePath).toBeTruthy();

    // PAUSED-STRUCTURED run (request-input). One required string field, so
    // `pause-input-resume` reports the missing value until one is entered.
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: PAUSED_STRUCTURED_ID,
        pipelineName: 'E2E Structured Pause Pipeline',
        status: 'paused',
        startedAt: STEP_STARTED_AT,
        cwd: demoWorktreePath,
        jobs: [
          {
            id: 'review',
            name: 'Review',
            steps: [{ id: 'ask', name: 'Ask', run: 'echo ask' }],
          },
        ],
        stepResults: {
          'review.ask': {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            pause_requested: true,
          },
        },
        pendingInput: {
          jobId: 'review',
          stepId: 'ask',
          title: 'Reviewer approval required',
          message: 'Enter the reviewer name to continue.',
          fields: [
            {
              key: 'reviewer',
              label: 'Reviewer',
              type: 'string',
              required: true,
            },
            {
              key: 'decision',
              label: 'Decision',
              type: 'choice',
              options: ['Approve', 'Request changes'],
              required: false,
            },
          ],
        },
      },
    });

    // PAUSED-RECOVERY run — a first-class provider usage-limit reason renders
    // both manual and scheduled resume controls in the Summary pause slot.
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: PAUSED_RECOVERY_ID,
        pipelineName: 'E2E Provider Recovery Pipeline',
        status: 'paused',
        startedAt: STEP_STARTED_AT,
        stepResults: {
          'build.compile': {
            status: 'paused',
            recovery_count: 0,
            agent_recovery: {
              version: 1,
              reason_id: RECOVERY_REASON_ID,
              action: 'agent-prompt',
              provider: 'claude',
              had_agent_activity: false,
              strategy: 'restart_step',
              recovery_count: 0,
              paused_at: STEP_STARTED_AT,
              failure_message: 'usage exhausted',
            },
          },
        },
        stateOverrides: {
          version: 6,
          status_reasons: [
            {
              id: RECOVERY_REASON_ID,
              kind: 'provider_usage_limit',
              code: 'rate_limit',
              provider: 'claude',
              account_scope: 'native',
              resets_at: '2099-04-10T13:00:00.000Z',
              detected_at: STEP_STARTED_AT,
              source: {
                job_id: 'build',
                step_id: 'compile',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        },
      },
    });

    // PAUSED-FORMLESS run — v8 models action pauses as explicit checkpoints.
    // The shared pause panel renders the checkpoint without form fields and
    // resumes only that job rather than every blocker on the execution.
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: PAUSED_FORMLESS_ID,
        pipelineName: 'E2E Formless Pause Pipeline',
        status: 'paused',
        startedAt: STEP_STARTED_AT,
        jobs: [
          {
            id: 'gate',
            name: 'Gate',
            steps: [{ id: 'hold', name: 'Hold', run: 'echo hold' }],
          },
        ],
        stateOverrides: {
          version: 8,
          jobs: {
            gate: {
              status: 'paused',
              steps: {
                hold: {
                  status: 'success',
                  conclusion: 'success',
                  outcome: 'success',
                  outputs: {},
                  dynamic_env: {},
                  started_at: STEP_STARTED_AT,
                  completed_at: STEP_STARTED_AT,
                  exit_code: 0,
                  pause_requested: true,
                },
              },
              outputs: {},
              retry_count: 0,
              retry_history: [],
              iteration_count: 1,
              started_at: STEP_STARTED_AT,
            },
          },
          job_definitions: {
            gate: {
              name: 'Gate',
              needs: [],
              if: 'true',
              env: {},
              outputs: {},
              timeout_minutes: 60,
              max_retries: 0,
              continue_on_error: false,
              steps: [
                {
                  id: 'hold',
                  name: 'Hold',
                  run: 'echo hold',
                  shell: 'bash',
                  continue_on_error: false,
                  timeout_minutes: 30,
                  skip_on_missing_action: false,
                },
              ],
              physical_job_id: 'gate',
              logical_job_id: 'gate',
            },
          },
          job_groups: {
            gate: {
              job_id: 'gate',
              kind: 'single',
              expansion: 'expanded',
              variant_job_ids: ['gate'],
              status: 'paused',
              started_at: STEP_STARTED_AT,
            },
          },
          pending_pauses: [
            {
              id: FORMLESS_CHECKPOINT_ID,
              kind: 'action',
              job_id: 'gate',
              logical_job_id: 'gate',
              step_id: 'hold',
              attempt: 0,
              iteration: 1,
              detected_at: STEP_STARTED_AT,
            },
          ],
          status_reasons: [
            {
              id: FORMLESS_REASON_ID,
              kind: 'action_paused',
              code: 'action_requested_pause',
              detected_at: STEP_STARTED_AT,
              source: {
                job_id: 'gate',
                step_id: 'hold',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        },
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await waitForActivityPanel(window);
      await expect(window.getByText('Workflow runs').first()).toBeVisible({
        timeout: 15_000,
      });

      // ---- Structured request-input pause ----
      const structuredPreview = window.getByTestId(
        `pipeline-run-card-${PAUSED_STRUCTURED_ID}`,
      );
      await expect(structuredPreview.getByText('Input required')).toBeVisible();
      await expect(
        window.getByTestId(`pipeline-run-resume-${PAUSED_STRUCTURED_ID}`),
      ).toHaveCount(0);
      await openRunCard(window, PAUSED_STRUCTURED_ID);
      // The run panel renders the pause panel (in the Summary slot).
      await expect(window.getByTestId('pipeline-details-nav')).toBeVisible({
        timeout: 15_000,
      });

      const pausePanel = window.getByTestId('pause-input-panel');
      await expect(pausePanel).toBeVisible({ timeout: 15_000 });
      await expect(
        pausePanel.getByText('Reviewer approval required'),
      ).toBeVisible();
      await expect(
        pausePanel.getByText('Enter the reviewer name to continue.'),
      ).toBeVisible();

      const reviewerField = window.getByTestId('pause-field-reviewer');
      await expect(reviewerField).toBeVisible();

      // Resume with the required field empty shows its error under the
      // field and keeps the run paused; editing the field clears the error.
      // A valid resume must leave the persisted paused state and immediately
      // remove the pause UI from the still-open run panel.
      const resumeButton = window.getByTestId('pause-input-resume');
      await expect(resumeButton).toBeVisible();
      await expect(reviewerField).not.toHaveAttribute('aria-invalid', 'true');
      await resumeButton.click();
      await expect(pausePanel).toBeVisible();
      await expect(reviewerField).toHaveAttribute('aria-invalid', 'true');
      await expect(pausePanel.getByText('reviewer is required')).toBeVisible();
      await reviewerField.fill('Ada Lovelace');
      await expect(pausePanel.getByText('reviewer is required')).toHaveCount(0);
      const decisionField = pausePanel.getByTestId('pause-field-decision');
      await expect(decisionField).toHaveText('No selection');
      await decisionField.click();
      await window.getByRole('option', { name: 'Approve' }).click();
      await decisionField.click();
      await window.getByRole('option', { name: 'Request changes' }).click();
      await decisionField.click();
      await window.getByRole('option', { name: 'No selection' }).click();
      await expect(decisionField).toHaveText('No selection');
      await decisionField.click();
      await window.getByRole('option', { name: 'Approve' }).click();
      await expect(resumeButton).toBeEnabled();
      await resumeButton.click();
      await expect(pausePanel).toBeHidden({ timeout: 15_000 });
      await expect
        .poll(
          () =>
            JSON.parse(
              readFileSync(
                path.join(
                  userDataDir,
                  'pipeline-executions',
                  `${PAUSED_STRUCTURED_ID}.json`,
                ),
                'utf8',
              ),
            ).status,
          { timeout: 15_000 },
        )
        .not.toBe('paused');
      await expect
        .poll(() => {
          const resumedState = JSON.parse(
            readFileSync(
              path.join(
                userDataDir,
                'pipeline-executions',
                `${PAUSED_STRUCTURED_ID}.json`,
              ),
              'utf8',
            ),
          );
          return resumedState.jobs.review.steps.ask.outputs;
        })
        .toMatchObject({ reviewer: 'Ada Lovelace', decision: 'Approve' });

      await closeRunPanel(window);

      // ---- Formless pause ----
      await expect(
        window.getByTestId(`pipeline-run-resume-${PAUSED_FORMLESS_ID}`),
      ).toBeEnabled();
      await openRunCard(window, PAUSED_FORMLESS_ID);
      await expect(window.getByTestId('pipeline-details-nav')).toBeVisible({
        timeout: 15_000,
      });

      const formlessPausePanel = window.getByTestId('pause-input-panel');
      await expect(formlessPausePanel).toContainText(
        'This job is paused and ready to continue.',
      );
      const formlessResume =
        formlessPausePanel.getByTestId('pause-input-resume');
      await expect(formlessResume).toBeVisible({ timeout: 15_000 });
      // Formless resume is enabled immediately (no fields to validate). We assert
      // it renders/enables but do not click it (no live executor).
      await expect(formlessResume).toBeEnabled();

      await closeRunPanel(window);

      // ---- Provider recovery pause ----
      await expect(
        window.getByTestId(`pipeline-run-resume-${PAUSED_RECOVERY_ID}`),
      ).toBeEnabled();
      await openRunCard(window, PAUSED_RECOVERY_ID);
      await expect(window.getByTestId('pipeline-details-nav')).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByTestId('pause-formless-resume')).toBeEnabled();
      const scheduleResume = window.getByTestId(
        'pipeline-recovery-schedule-claude',
      );
      await expect(scheduleResume).toBeEnabled();
      await scheduleResume.click();
      await expect(scheduleResume).toHaveText('Resume scheduled', {
        timeout: 15_000,
      });

      await closeRunPanel(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('running runs resume a paused step while a sibling stays active', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-live-partial-resume-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedStoredPipeline({
      userDataDir,
      id: LIVE_RESUME_PIPELINE_ID,
      name: LIVE_RESUME_PIPELINE_NAME,
      yaml: LIVE_RESUME_PIPELINE_YAML,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForActivityPanel(window);

      await app.openPipelineDispatchModal(LIVE_RESUME_PIPELINE_NAME);
      const runButton = window.getByTestId('pipeline-trigger-modal-run');
      await expect(runButton).toBeEnabled();
      await runButton.click();

      const runCard = window
        .locator('[data-testid^="pipeline-run-card-"]')
        .filter({ hasText: LIVE_RESUME_PIPELINE_NAME })
        .first();
      await expect(runCard).toBeVisible({ timeout: 30_000 });
      await expect(runCard).toContainText('running', { timeout: 30_000 });
      await runCard.click({ position: { x: 10, y: 10 } });
      const runPanel = await expectPipelineRunPanel(
        window,
        (await runCard.getAttribute('data-testid')).replace(
          'pipeline-run-card-',
          '',
        ),
      );

      await showPipelineJobList(runPanel);
      const pausePanel = window.getByTestId('pause-input-panel');
      await expect(pausePanel.getByText('Input required')).toBeVisible({
        timeout: 15_000,
      });
      await expect(pausePanel).toContainText(
        'This job is paused and ready to continue.',
      );
      const resumeButton = pausePanel.getByTestId('pause-input-resume');
      await expect(resumeButton).toBeEnabled();
      await resumeButton.click();

      // The selected pause reason is cleared immediately while the peer job
      // keeps the overall execution running.
      await expect(resumeButton).toBeHidden({ timeout: 15_000 });
      await closeRunPanel(window);
      await expect(runCard).toContainText('success', { timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('matrix variants use current navigation and retry controls', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-matrix-grouped-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const executionId = 'e2e-matrix-failed-1';
    const physicalJobId = '__matrix__build__0';
    const logicalJob = {
      name: 'Build matrix',
      needs: [],
      if: 'true',
      env: {},
      outputs: {},
      timeout_minutes: 60,
      max_retries: 0,
      continue_on_error: false,
      strategy: {
        matrix: { os: ['macos'] },
        dynamic: false,
        fail_fast: true,
      },
      steps: [
        {
          id: 'work',
          name: 'Work',
          run: 'echo work',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 30,
          skip_on_missing_action: false,
        },
      ],
    };

    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: executionId,
        pipelineName: 'E2E Matrix Pipeline',
        status: 'failure',
        startedAt: STEP_STARTED_AT,
        completedAt: STEP_COMPLETED_AT,
        stateOverrides: {
          version: 8,
          pipeline_snapshot: {
            name: 'E2E Matrix Pipeline',
            jobs: { build: logicalJob },
          },
          jobs: {
            [physicalJobId]: {
              status: 'failure',
              outcome: 'failure',
              conclusion: 'failure',
              steps: {
                work: terminalStepResult(
                  'failure',
                  STEP_STARTED_AT,
                  STEP_COMPLETED_AT,
                ),
              },
              outputs: {},
              retry_count: 0,
              retry_history: [],
              iteration_count: 0,
              started_at: STEP_STARTED_AT,
              completed_at: STEP_COMPLETED_AT,
            },
          },
          job_definitions: {
            [physicalJobId]: {
              ...logicalJob,
              physical_job_id: physicalJobId,
              logical_job_id: 'build',
              matrix: {
                index: 0,
                total: 1,
                values: { os: 'macos' },
              },
            },
          },
          job_groups: {
            build: {
              job_id: 'build',
              kind: 'matrix',
              expansion: 'expanded',
              variant_job_ids: [physicalJobId],
              status: 'failure',
              outcome: 'failure',
              conclusion: 'failure',
              fail_fast: true,
              resolved_max_parallel: 1,
              started_at: STEP_STARTED_AT,
              completed_at: STEP_COMPLETED_AT,
            },
          },
          pending_pauses: [],
          status_reasons: [],
        },
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
      await openRunCard(window, executionId);

      const nav = window.getByTestId('pipeline-details-nav');
      await expect(nav).toBeVisible({ timeout: 15_000 });
      await expect(
        nav.getByTestId('pipeline-details-nav-job-child-count-build'),
      ).toHaveText('1 variants');

      await nav.getByTestId('pipeline-details-nav-job-build').click();
      const matrixView = window.getByTestId('pipeline-matrix-view-build');
      await expect(matrixView).toContainText('1 variants');
      await expect(
        matrixView.getByRole('button', { name: 'Try all variants again' }),
      ).toBeEnabled();
      await expect(
        matrixView.getByRole('button', { name: 'Try failed variants again' }),
      ).toBeEnabled();
      await expect(
        matrixView.getByRole('button', { name: 'Try variant again' }),
      ).toBeEnabled();

      const toggle = nav.getByTestId('pipeline-details-nav-job-toggle-build');
      await toggle.click();
      const variantRow = nav.getByTestId(
        `pipeline-details-nav-child-build-${physicalJobId}`,
      );
      await variantRow.click();
      await expect(
        window.getByTestId(`pipeline-job-view-${physicalJobId}`),
      ).toContainText('failure');

      // The selected variant carries a painted accent line that differs from
      // the base border color (a `border-<color>` marker is inert under the
      // unlayered base border rule, CAN-2734); unselected rows carry none.
      await expect(variantRow).toHaveAttribute('aria-current', 'true');
      const marker = variantRow.getByTestId(
        'pipeline-details-nav-selection-marker',
      );
      await expect(marker).toBeVisible();
      const paint = await marker.evaluate((element) => {
        const probe = element.ownerDocument.createElement('div');
        probe.style.backgroundColor = 'var(--line-base)';
        element.ownerDocument.body.append(probe);
        const base = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const rect = element.getBoundingClientRect();
        return {
          marker: getComputedStyle(element).backgroundColor,
          base,
          width: rect.width,
          height: rect.height,
        };
      });
      expect(paint.marker).not.toBe(paint.base);
      expect(paint.marker).not.toBe('rgba(0, 0, 0, 0)');
      expect(paint.width).toBeGreaterThan(0);
      expect(paint.height).toBeGreaterThan(0);
      for (const unselected of [
        nav.getByTestId('pipeline-details-nav-summary'),
        nav.getByTestId('pipeline-details-nav-job-build').locator('..'),
      ]) {
        await expect(
          unselected.getByTestId('pipeline-details-nav-selection-marker'),
        ).toHaveCount(0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Cancel force-finishes an unresponsive run whose recorded owner is still alive', async () => {
    test.setTimeout(60_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-force-cancel-stuck-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const executionId = 'e2e-unresponsive-live-owner';
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: executionId,
        pipelineName: 'Unresponsive Live Owner',
        status: 'running',
        stateOverrides: {
          owner_pid: process.pid,
        },
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

      const runCard = window.getByTestId(`pipeline-run-card-${executionId}`);
      await expect(runCard).toContainText('running');
      await window.getByTestId(`pipeline-run-cancel-${executionId}`).click();
      await expect(runCard).toContainText('cancelled', { timeout: 25_000 });
      await expect(
        window.getByTestId(`pipeline-run-cancel-${executionId}`),
      ).toHaveCount(0);

      const persisted = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'pipeline-executions', `${executionId}.json`),
          'utf8',
        ),
      );
      expect(persisted.status).toBe('cancelled');
      expect(persisted.completed_at).toBeTruthy();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('hidden-only history keeps a full-card Dispatch action', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'pipeline-hidden-action-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  for (let index = 0; index < 6; index++)
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: `history-only-${index}`,
        pipelineName: 'Past review',
        status: 'success',
      },
    });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const card = window.getByTestId('activity-section-pipeline-runs');
    await expect(
      card.getByText('Past review', { exact: true }).first(),
    ).toBeVisible();
    const title = card.locator('[data-panel-section-title-row]');
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expect(card.getByTestId('pipeline-dispatch-open')).toBeVisible();
    await card.getByTestId('pipeline-dispatch-open').click();
    const dispatchDialog = window.getByRole('dialog');
    await expect(dispatchDialog).toBeVisible();
    // Escape is delivered to the focused element, and the modal moves focus
    // asynchronously after it mounts. Pressing on the frame where focus is
    // still on the opener sent the key outside the dialog's scoped handler
    // (CAN-2309 narrowed which targets may consume Escape), so the dialog
    // stayed open. Wait for focus to land inside before pressing.
    await expect
      .poll(() =>
        dispatchDialog.evaluate((element) =>
          element.contains(element.ownerDocument.activeElement),
        ),
      )
      .toBe(true);
    await window.keyboard.press('Escape');
    await expect(dispatchDialog).toBeHidden();
    await title.click();
    for (let index = 0; index < 6; index++) {
      await card
        .getByRole('button', { name: 'Hide workflow run', exact: true })
        .first()
        .click();
      await expect(
        card.getByRole('button', { name: 'Hide workflow run', exact: true }),
      ).toHaveCount(5 - index);
    }
    const dispatch = card.getByTestId('pipeline-dispatch-open');
    await expect(dispatch).toHaveText('Dispatch workflow');
    const unifiedCard = card.getByTestId('action-card-container');
    await expect(unifiedCard.getByTestId('action-card-body')).toBeVisible();
    await dispatch.hover();
    await expect(dispatch).toHaveCSS('border-bottom-left-radius', '0px');
    await expect(dispatch).toHaveCSS('border-bottom-right-radius', '0px');
    const divider = unifiedCard.getByTestId('action-card-divider');
    await expect(divider).toHaveCSS(
      'height',
      await window.evaluate(() =>
        window.devicePixelRatio >= 2 ? '0.5px' : '1px',
      ),
    );
    const dispatchIcon = await dispatch.locator('svg').boundingBox();
    const chevron = await unifiedCard
      .getByTestId('pipeline-hidden-chevron')
      .boundingBox();
    expect(
      Math.abs(
        dispatchIcon.x + dispatchIcon.width / 2 - chevron.x - chevron.width / 2,
      ),
    ).toBeLessThan(1);
    await expect(
      card.getByRole('button', { name: /Hidden.*6/ }).locator('svg'),
    ).toHaveCount(1);

    await expect(unifiedCard.getByTestId('action-card-body')).toHaveCSS(
      'margin-top',
      '0px',
    );
    await expect(dispatch).toHaveAttribute(
      'data-activity-action-card-button',
      'true',
    );
    await card.getByRole('button', { name: /Hidden.*6/ }).click();
    await expect(
      card.getByRole('button', { name: /Hidden.*6/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    const viewport = card.getByTestId('pipeline-hidden-viewport');
    await expect(viewport).toBeVisible();
    await expect(viewport).toHaveCSS('overflow-x', 'hidden');
    const railBounds = await card
      .locator('[data-overlay-scrollbar]')
      .boundingBox();
    const cardBounds = await unifiedCard.boundingBox();
    expect(
      Math.abs(
        railBounds.x + railBounds.width - cardBounds.x - cardBounds.width,
      ),
    ).toBeLessThan(1);

    const metrics = await viewport.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      clientWidth: element.clientWidth,
      overflowing: element.scrollHeight > element.clientHeight,
    }));
    expect(metrics.overflowing).toBe(true);
    expect(Math.abs(metrics.width - metrics.clientWidth)).toBeLessThan(1);
    await viewport.evaluate((element) => {
      element.scrollTop = 100;
    });
    await expect(viewport).toHaveCSS('mask-image', /linear-gradient/);
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    // Resize the Activity panel itself so the viewport observer runs while
    // history remains scrolled (resizing the window can leave its width fixed).
    const widthBefore = await viewport.evaluate(
      (element) => element.clientWidth,
    );
    const sash = window.locator('.canopy-sash.vertical').last();
    const sashBox = await sash.boundingBox();
    expect(sashBox).not.toBeNull();
    const sashX = sashBox.x + sashBox.width / 2;
    const sashY = sashBox.y + sashBox.height / 2;
    await window.mouse.move(sashX, sashY);
    await window.mouse.down();
    await window.mouse.move(sashX - 80, sashY, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(() => viewport.evaluate((element) => element.clientWidth))
      .toBeGreaterThan(widthBefore);
    await viewport.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(viewport).toHaveCSS('mask-image', /linear-gradient/);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(viewport).toHaveCSS('mask-image', 'none');

    await expect(
      card.getByText('Past review', { exact: true }).first(),
    ).toBeVisible();
    await card.getByRole('button', { name: /Hidden.*6/ }).click();
    await dispatch.click();
    await expect(window.getByRole('dialog')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('builtin create-worktree keeps unsupported instruction links non-blocking', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'instructions-pipeline-create-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    fixturesDir: path.join(userDataDir, 'fixtures'),
  });
  const workspace = seeded.workspaces[0];
  const source = workspace.repoPath;
  for (const name of ['AGENTS.md', 'CLAUDE.md'])
    rmSync(path.join(source, name), { force: true });
  mkdirSync(path.join(source, 'docs'), { recursive: true });
  const guidance = '# Keep nested project guidance\n';
  writeFileSync(path.join(source, 'docs', 'AGENTS.md'), guidance);
  symlinkSync('docs/AGENTS.md', path.join(source, 'AGENTS.md'));
  writeFileSync(path.join(source, '.gitignore'), 'repos/\n');
  execFileSync('git', ['add', '-A'], { cwd: source });
  execFileSync('git', ['commit', '-m', 'Nested project guidance'], {
    cwd: source,
  });
  const pipelineName = 'Create worktree with nested instructions';
  seedStoredPipeline({
    userDataDir,
    id: 'instructions-create-worktree',
    name: pipelineName,
    yaml: [
      `name: ${pipelineName}`,
      'on: dispatch',
      'jobs:',
      '  create:',
      '    steps:',
      '      - uses: builtin/create-worktree',
      '        with:',
      `          workspace_id: ${workspace.id}`,
      '          branch: instructions-created',
      '          repair: true',
      '',
    ].join('\n'),
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await waitForActivityPanel(window);
    await app.openPipelineDispatchModal(pipelineName);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const card = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: pipelineName })
      .first();
    await expect(card).toBeVisible();
    try {
      await expect(card).toContainText('success', { timeout: 60_000 });
    } catch (error) {
      const executionId = (await card.getAttribute('data-testid')).replace(
        'pipeline-run-card-',
        '',
      );
      const executionsDir = path.join(userDataDir, 'pipeline-executions');
      await test.info().attach('create-worktree-execution.json', {
        body: readFileSync(path.join(executionsDir, `${executionId}.json`)),
        contentType: 'application/json',
      });
      const logsDir = path.join(executionsDir, executionId, 'logs');
      if (existsSync(logsDir)) {
        for (const filename of readdirSync(logsDir)) {
          await test.info().attach(filename, {
            body: readFileSync(path.join(logsDir, filename)),
            contentType: 'text/plain',
          });
        }
      }
      throw error;
    }
    const record = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', workspace.id, 'worktrees.json'),
        'utf8',
      ),
    ).worktrees.find((entry) => entry.branchName === 'instructions-created');
    expect(record).toBeDefined();
    const root = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'worktrees',
      record.id,
    );
    expect(existsSync(path.join(root, '.git'))).toBe(true);
    expect(readlinkSync(path.join(root, 'AGENTS.md'))).toBe('docs/AGENTS.md');
    expect(readFileSync(path.join(root, 'docs', 'AGENTS.md'), 'utf8')).toBe(
      guidance,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The desktop host route: main creates the worktree, waits for its setup,
// keeps a copy of the failing setup log under the execution, and groups the
// new row; `continue_on_error` lets the next step read the typed failure.
test('builtin create-worktree runs setup, keeps its log and groups the row through desktop main', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'pipeline-create-worktree-host-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seeded.workspaces[0];
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts = {
    ...config.scripts,
    setup: 'echo pipeline-setup-output; exit 3',
  };
  writeFileSync(configPath, JSON.stringify(config));
  const pipelineName = 'Create worktree with setup and group';
  seedStoredPipeline({
    userDataDir,
    id: 'host-create-worktree',
    name: pipelineName,
    yaml: [
      `name: ${pipelineName}`,
      'on: dispatch',
      'jobs:',
      '  create:',
      '    steps:',
      '      - id: make',
      '        uses: builtin/create-worktree',
      '        continue_on_error: true',
      '        with:',
      `          project_id: ${workspace.id}`,
      '          branch: pipeline-host-created',
      '          worktree_setup: run_and_wait',
      '          group: E2E',
      '      - id: report',
      '        run: echo "result ${{ steps.make.outputs.failure_reason }} ${{ steps.make.outputs.setup_exit_code }}"',
      '',
    ].join('\n'),
  });
  const executionsDir = path.join(userDataDir, 'pipeline-executions');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await waitForActivityPanel(window);
    await app.openPipelineDispatchModal(pipelineName);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const card = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: pipelineName })
      .first();
    await expect(card).toBeVisible();
    const executionId = (await card.getAttribute('data-testid')).replace(
      'pipeline-run-card-',
      '',
    );
    const executionFile = path.join(executionsDir, `${executionId}.json`);
    const readStep = (stepId) => {
      if (!existsSync(executionFile)) return undefined;
      return JSON.parse(readFileSync(executionFile, 'utf8')).jobs?.create
        ?.steps?.[stepId];
    };
    await expect
      .poll(() => readStep('report')?.status, { timeout: 90_000 })
      .toBe('success');

    const outputs = readStep('make').outputs;
    expect(outputs).toMatchObject({
      project_id: workspace.id,
      workspace_id: workspace.id,
      branch_name: 'pipeline-host-created',
      failure_reason: 'setup_failed',
      setup_state: 'failed',
      setup_exit_code: '3',
      grouped: 'true',
      group_created: 'true',
      not_grouped_reason: '',
    });
    expect(outputs.task_id).toBe(outputs.worktree_id);
    const hostDir = path.join(executionsDir, executionId, 'host');
    expect(outputs.setup_log_file.startsWith(`${hostDir}${path.sep}`)).toBe(
      true,
    );
    expect(readFileSync(outputs.setup_log_file, 'utf8')).toContain(
      'pipeline-setup-output',
    );
    const results = JSON.parse(
      readFileSync(outputs.setup_results_file, 'utf8'),
    );
    expect(results).toMatchObject({
      version: 1,
      project_id: workspace.id,
      task_id: outputs.task_id,
      setup_state: 'failed',
    });
    expect(results.scripts).toEqual([
      expect.objectContaining({
        lifecycle: 'setup',
        state: 'failed',
        exit_code: 3,
        log_file: path.basename(outputs.setup_log_file),
      }),
    ]);

    const logsDir = path.join(executionsDir, executionId, 'logs');
    const logs = readdirSync(logsDir)
      .map((name) => readFileSync(path.join(logsDir, name), 'utf8'))
      .join('\n');
    expect(logs).toContain('result setup_failed 3');

    // The row appears inside its new group without a reload.
    const groupBlock = window.locator(
      `[data-sidebar-item-group-id="${outputs.group_id}"]`,
    );
    await expect(groupBlock).toContainText('E2E');
    await expect(
      groupBlock.locator(
        `[data-testid="worktree-row"][data-worktree-id="${outputs.task_id}"]`,
      ),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Retry re-authorizes every resource in the run (`authorizePipelineReplay`).
// With organization projects on, a bundled `builtin/*` step must classify as
// system-owned; if the packaged main cannot resolve the action manifest, the
// step is ownerless and Retry is refused as unknown provenance.
test('Retry re-runs a failed pipeline with a builtin step under organization projects', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-retry-builtin-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const pipelineName = 'Retry builtin step';
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-retry-builtin-step',
    name: pipelineName,
    yaml: [
      `name: ${pipelineName}`,
      'on: dispatch',
      'jobs:',
      '  greet:',
      '    steps:',
      '      - id: hello',
      '        uses: builtin/hello-world-js',
      '      - id: fail_once',
      '        run: |',
      '          if [ ! -f .e2e-retry-builtin-once ]; then',
      '            touch .e2e-retry-builtin-once',
      '            exit 1',
      '          fi',
      '',
    ].join('\n'),
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await waitForActivityPanel(window);

    await app.openPipelineDispatchModal(pipelineName);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const card = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: pipelineName })
      .first();
    await expect(card).toContainText('failure', { timeout: 60_000 });
    const cardTestId = await card.getAttribute('data-testid');
    expect(cardTestId).toBeTruthy();
    const executionId = cardTestId.replace('pipeline-run-card-', '');

    await window.getByTestId(`pipeline-run-retry-${executionId}`).click();

    // Retry re-runs the same execution, so its original card reports success.
    await expect(
      window.getByTestId(`pipeline-run-card-${executionId}`),
    ).toContainText('success', { timeout: 60_000 });
    await expect(
      window.getByText(/Couldn't confirm where something this uses came from/),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
