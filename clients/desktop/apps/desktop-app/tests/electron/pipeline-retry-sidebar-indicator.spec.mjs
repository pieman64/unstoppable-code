import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  buildSuccessfulRetryStates,
  injectPipelineExecutionEvent,
} from './seeders/injectPipelineExecutionEvent.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

test('a successful retry replaces stale failed sidebar severity and tooltip copy', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-retry-sidebar-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'e2e-already-successful',
      pipelineName: 'Already Successful',
      status: 'success',
      startedAt: '2026-04-10T12:00:00.000Z',
      completedAt: '2026-04-10T12:05:00.000Z',
    },
  });
  const { state: failedState } = seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'e2e-retried-successfully',
      pipelineName: 'Retried Successfully',
      status: 'failure',
      startedAt: '2026-04-10T12:01:00.000Z',
      completedAt: '2026-04-10T12:06:00.000Z',
    },
  });
  const retryStates = buildSuccessfulRetryStates(failedState);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    const indicator = row.getByTestId('worktree-row-pipeline-attention');
    await expect(indicator).toHaveAttribute('aria-label', 'Workflow failed', {
      timeout: 15_000,
    });

    await injectPipelineExecutionEvent(electronApp, {
      state: retryStates.running,
      type: 'execution.started',
    });
    await expect(
      row.getByTestId('worktree-row-working-pipeline'),
    ).toBeVisible();
    await injectPipelineExecutionEvent(electronApp, {
      state: retryStates.success,
      type: 'execution.completed',
    });

    await expect(indicator).toHaveAttribute('aria-label', 'Workflow completed');
    await expect(indicator.locator('.bg-fg-destructive')).toHaveCount(0);
    await expect(
      row.getByTestId('worktree-row-pipeline-glyph').locator('.fg-success'),
    ).toHaveCount(1);

    await indicator.focus();
    const popover = window.getByTestId('pipeline-status-popover');
    await expect(popover).toBeVisible();
    await expect(
      popover.getByTestId('pipeline-status-popover-header'),
    ).toHaveText('Workflows Completed (2)');
    await expect(popover).toContainText('Already Successful');
    await expect(popover).toContainText('Retried Successfully');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Quitting Canopy with a run in flight pauses it (`app_shutdown`), so this is
// the ordinary way a user meets a paused row: relaunch, and the pipeline is
// blocked waiting to be resumed. A paused execution is seen-eligible, so it
// joins the unseen set as well; the row must still report the blocker rather
// than the green "Pipeline completed" glyph it showed while `unseen` outranked
// `paused` in `resolvePipelineStatus`.
test('a paused pipeline reports the blocker before the activity panel is opened', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-paused-sidebar-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'e2e-paused-on-relaunch',
      pipelineName: 'Paused On Relaunch',
      status: 'paused',
      startedAt: '2026-04-10T12:00:00.000Z',
      pendingInput: {
        title: 'Application stopped',
        message: 'Resume this run when you are ready.',
      },
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    const pausedGlyph = row.getByTestId('worktree-row-paused-pipeline');
    await expect(pausedGlyph).toBeVisible({ timeout: 15_000 });
    await expect(pausedGlyph).toHaveAttribute('aria-label', 'Workflow paused');
    await expect(pausedGlyph.locator('.fg-warning')).toHaveCount(1);

    // The completed-run glyph must not stand in for a blocked run.
    await expect(row.getByTestId('worktree-row-pipeline-glyph')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
