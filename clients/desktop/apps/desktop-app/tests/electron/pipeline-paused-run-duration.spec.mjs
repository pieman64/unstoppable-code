import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
} from './pipelineUi.mjs';

// Pipeline run duration stops while the WHOLE run is paused.
//
// The run clock used to be plain wall-clock time since `started_at`, so a run
// that did 45s of work and then sat paused waiting for input reported hours in
// the sidebar badge tooltip
// (`packages/ui-shared/src/components/PipelineStatusPopover.tsx`) and an
// equally wrong final duration in the execution detail Summary bar
// (`.../activity/details/PipelineSummaryBar.tsx`). `ExecutionState.paused_at`
// now freezes the clock and `ExecutionState.paused_ms` banks closed pauses.
//
// Determinism: both executions are seeded on disk before launch with absolute
// timestamps, so the expected durations are fixed strings and never depend on
// when the test runs. No live pipeline run, no agents, no network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

// A run still paused: 45s of work, then paused for two hours and counting.
const PAUSED_ID = 'e2e-paused-duration-open';
const PAUSED_STARTED_AT = '2026-04-10T12:00:00.000Z';
const PAUSED_AT = '2026-04-10T12:00:45.000Z';

// A run that paused for two hours and then finished: 1m 30s of real work
// inside a 2h 1m 30s wall-clock window.
const RESUMED_ID = 'e2e-paused-duration-resumed';
const RESUMED_STARTED_AT = '2026-04-10T09:00:00.000Z';
const RESUMED_COMPLETED_AT = '2026-04-10T11:01:30.000Z';
const RESUMED_PAUSED_MS = 2 * 60 * 60 * 1000;

test('paused pipeline runs report work time, not wall-clock time', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pl-pause-clock-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: PAUSED_ID,
      pipelineId: 'seeded-paused-pipeline',
      pipelineName: 'Awaiting Input',
      status: 'paused',
      startedAt: PAUSED_STARTED_AT,
      pendingInput: { jobId: 'build', stepId: 'compile', title: 'Continue?' },
      stateOverrides: { paused_at: PAUSED_AT },
    },
  });

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: RESUMED_ID,
      pipelineId: 'seeded-resumed-pipeline',
      pipelineName: 'Resumed Gate',
      status: 'success',
      startedAt: RESUMED_STARTED_AT,
      completedAt: RESUMED_COMPLETED_AT,
      stateOverrides: { paused_ms: RESUMED_PAUSED_MS },
    },
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
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ---- Sidebar badge tooltip ----
    // A paused run takes the shield testid, not the generic glyph one:
    // `WorktreeRow` switches on `pipelineStatus === 'paused'`. This scenario
    // seeds a paused execution, so the generic id never renders here.
    const badge = row.getByTestId('worktree-row-paused-pipeline');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.hover();

    const popover = window.getByTestId('pipeline-status-popover');
    await expect(popover).toBeVisible({ timeout: 10_000 });

    // Each run is one direct child of the list: a name/status row plus the
    // runtime line underneath it.
    const entries = popover.getByTestId('pipeline-status-popover-list');
    const pausedEntry = entries
      .locator('> div')
      .filter({ hasText: 'Awaiting Input' });
    // 45s of work before the pause — not the hours it has been sitting there.
    await expect(pausedEntry).toContainText('45s');

    const resumedEntry = entries
      .locator('> div')
      .filter({ hasText: 'Resumed Gate' });
    // 2h 1m 30s wall clock minus the banked 2h pause.
    await expect(resumedEntry).toContainText('1m 30s');
    await expect(popover).not.toContainText('2h');

    await window.mouse.move(1, 1);
    await expect(popover).toBeHidden({ timeout: 5_000 });

    // ---- Execution detail Summary bar ----
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    const pausedCard = window.getByTestId(`pipeline-run-card-${PAUSED_ID}`);
    await expect(pausedCard).toBeVisible({ timeout: 15_000 });
    await pausedCard.click({ position: { x: 10, y: 10 } });
    await expectPipelineRunPanel(window, PAUSED_ID);

    const summaryBar = window.getByTestId('pipeline-summary-bar');
    await expect(summaryBar).toBeVisible({ timeout: 15_000 });
    await expect(summaryBar).toContainText('45s');

    await closePipelineRunPanels(window);

    const resumedCard = window.getByTestId(`pipeline-run-card-${RESUMED_ID}`);
    await expect(resumedCard).toBeVisible({ timeout: 15_000 });
    await resumedCard.click({ position: { x: 10, y: 10 } });
    await expectPipelineRunPanel(window, RESUMED_ID);

    await expect(summaryBar).toBeVisible({ timeout: 15_000 });
    // The final computed duration is the work the run actually did.
    await expect(summaryBar).toContainText('1m 30s');
    await expect(summaryBar).not.toContainText('2h');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
