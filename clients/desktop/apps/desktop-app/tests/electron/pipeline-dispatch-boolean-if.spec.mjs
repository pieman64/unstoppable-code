import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { showPipelineJobList } from './pipelineUi.mjs';

// Regression for the YAML boolean `if:` crash: an unquoted `if: false` parses
// to a boolean (JSON_SCHEMA), and before the normalize-pipeline coercion the
// executor's `evaluateCondition` threw `expression?.trim is not a function`,
// failing the WHOLE execution instead of skipping the gated step.
//
// This spec runs the real executor end-to-end through the UI:
//   1. seedDemoWorkspaces creates a real git worktree (`demo-main`).
//   2. seedStoredPipeline writes a user pipeline whose first step is gated
//      with `if: false` and whose second step is a plain `echo`.
//   3. The test dispatches it from the Pipeline Runs section
//      (`pipeline-dispatch-open` → PipelineTriggerModal →
//      `pipeline-trigger-modal-run`) and waits for the live run.
//   4. The run card must reach `success` (pre-fix: `failure`), and the
//      execution detail modal's Job view must show the gated step as `skipped`.
//
// Deterministic: the only live work is the executor running `echo` in the
// seeded worktree — no agents, no network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';

const PIPELINE_ID = 'e2e-boolean-if';
const PIPELINE_NAME = 'E2E Boolean If Pipeline';
const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  gate:',
  '    name: Gate',
  '    steps:',
  '      - id: gated_step',
  '        name: Gated Step',
  '        if: false',
  '        run: echo should-not-run',
  '      - id: echo_step',
  '        name: Echo Step',
  '        run: echo ran',
  '',
].join('\n');

test.describe('pipeline dispatch with boolean if: step', () => {
  test('run succeeds and the gated step is skipped', async () => {
    // Launch + demo-workspace selection + a live executor run exceeds the
    // 60s suite default.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-boolean-if-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedStoredPipeline({
      userDataDir,
      id: PIPELINE_ID,
      name: PIPELINE_NAME,
      yaml: PIPELINE_YAML,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The Pipeline Runs section (and its Dispatch button) lives in the
      // activity panel, which renders expanded inside the panel grid (no
      // collapse chrome); wait for its content to mount.
      await expect(
        window.getByTestId('panel-content-activity-section'),
      ).toBeVisible();

      // Select the seeded pipeline, then run it. The pipeline has no inputs
      // and no plugin collections, so the select-step button runs directly.
      await app.openPipelineDispatchModal(PIPELINE_NAME);
      const runButton = window.getByTestId('pipeline-trigger-modal-run');
      await expect(runButton).toBeEnabled();
      await runButton.click();

      // The live executor runs `echo` in the seeded worktree. Pre-fix this
      // run fails with `expression?.trim is not a function`; post-fix the
      // gated step is skipped and the run completes successfully.
      const runCard = window
        .locator('[data-testid^="pipeline-run-card-"]')
        .filter({ hasText: PIPELINE_NAME })
        .first();
      await expect(runCard).toBeVisible({ timeout: 30_000 });
      await expect(runCard).toContainText('success', { timeout: 60_000 });
      await expect(runCard).not.toContainText('failure');

      // Open the redesigned execution detail modal. The left nav is the durable
      // mount signal; the per-step outcome lives in the job's Job view, so we
      // select the gated job and pin the gated step row as `skipped`, not failed.
      await runCard.click();
      await showPipelineJobList(window, { timeout: 15_000 });
      await window.getByTestId('pipeline-details-nav-job-gate').click();
      await expect(window.getByTestId('pipeline-job-view-gate')).toBeVisible();

      const gatedStepRow = window.getByTestId('pipeline-step-gated_step');
      await expect(gatedStepRow).toBeVisible();
      await expect(gatedStepRow).toContainText('Gated Step');
      await expect(gatedStepRow).toContainText('skipped');

      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
