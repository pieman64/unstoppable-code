// Observed pipeline cost rows, run-summary entry points, attempts and step
// duration details. The run and advisor report are persisted fixtures, and
// costs arrive exclusively through audit day files before launch.

import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCostInsights } from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function launchFixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cost-pipeline-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeJson(path.join(worktreeDataDir, 'panel-layout-mode.json'), {
    version: 1,
    mode: 'minimal',
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { launched, userDataDir, window, cost };
}

async function openRunFromCost(
  window,
  cost,
  executionId = cost.ids.rootExecution,
) {
  // The Minimal layout's plus button starts a chat; the palette opens Cost.
  await window.keyboard.press(
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`,
  );
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('command-palette-input').fill('Open Cost panel');
  await palette.getByTestId('command-palette-command-open-cost-panel').click();
  const costPanel = window.getByTestId('panel-content-cost');
  await expect(
    costPanel.getByTestId(`cost-run-row-${executionId}`),
  ).toBeVisible();
  await costPanel.getByTestId(`cost-run-row-${executionId}`).click();
  const runPanel = window.getByTestId('pipeline-execution-panel');
  await expect(runPanel).toBeVisible();
  // The Side Panel is narrow, so the job list starts collapsed; pin it open.
  const toggle = runPanel.getByTestId('pipeline-panel-nav-toggle');
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute('aria-expanded')) !== 'true'
  ) {
    await toggle.click();
  }
  await expect(runPanel.getByTestId('pipeline-details-nav')).toBeVisible();
  return runPanel;
}

test('pipeline cost appears in Summary, records retries and Advisor, and opens step jobs', async () => {
  test.setTimeout(150_000);
  const { launched, userDataDir, window, cost } = await launchFixture();
  try {
    const runPanel = await openRunFromCost(window, cost);
    const nav = runPanel.getByTestId('pipeline-details-nav');
    await expect(nav.getByTestId('pipeline-job-list-cost')).toContainText(
      cost.expected.pipelineTotal,
    );
    await expect(nav.getByTestId('pipeline-job-list-cost')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(
      runPanel
        .getByTestId('pipeline-run-cost-view')
        .getByTestId('pipeline-run-cost-total'),
    ).toContainText(cost.expected.pipelineTotal);

    await nav.getByTestId('pipeline-details-nav-summary').click();
    await expect(
      runPanel.getByTestId('pipeline-summary-cost-preview'),
    ).toBeVisible();
    const preview = runPanel.getByTestId('pipeline-run-cost-preview');
    await expect(preview).toContainText(cost.expected.pipelineTotal);
    await preview.click();
    await expect(nav.getByTestId('pipeline-job-list-cost')).toHaveAttribute(
      'aria-current',
      'true',
    );

    const breakdown = runPanel.getByTestId('pipeline-run-cost-view');
    const review = breakdown.getByTestId('pipeline-run-cost-step-review');
    await expect(review).toContainText('2 attempts');
    await expect(review).toContainText('13.5k tokens');
    await expect(
      breakdown.getByTestId('pipeline-run-cost-step-verify'),
    ).toContainText('Agent verify');
    await expect(
      breakdown.getByTestId('pipeline-run-cost-advisor'),
    ).toContainText('Pipeline Advisor');
    await expect(
      breakdown.getByTestId(
        `pipeline-run-cost-child-${cost.ids.childExecution}`,
      ),
    ).toBeVisible();
    // The nested run's step is represented by its child run row only.
    await expect(
      breakdown.getByTestId('pipeline-run-cost-step-child-review'),
    ).toHaveCount(0);

    await review.click();
    await expect(
      nav.getByTestId('pipeline-details-nav-job-review'),
    ).toHaveAttribute('aria-current', 'true');
    const reviewJob = runPanel.getByTestId('pipeline-job-view-review');
    // The step ran twice; its combined cost sits on the latest attempt's row.
    const reviewStepRow = reviewJob
      .getByTestId('pipeline-step-agent-review')
      .last();
    await expect(
      reviewStepRow.getByTestId('pipeline-step-cost-agent-review'),
    ).toContainText(cost.expected.pipelineSteps.review);
    await expect(reviewStepRow).toContainText('5m');
    await expect(
      nav
        .getByTestId('pipeline-details-nav-job-review')
        .getByTestId('pipeline-step-cost-agent-review'),
    ).toHaveCount(0);

    // The script-only run is reachable through the same Activity Pipeline Runs
    // entry as any execution, but has no observed-cost nav item or summary card.
    const activityToggle = window.getByTestId('worktree-activity-card-toggle');
    await activityToggle.click();
    const card = window.getByTestId('activity-card');
    await expect(
      card.getByTestId('activity-card-row-pipeline-runs'),
    ).toBeVisible();
    await card.getByTestId('activity-card-row-pipeline-runs').click();
    await window.keyboard.press('Escape');
    const scriptCard = window
      .getByTestId(`pipeline-run-card-${cost.ids.scriptOnlyExecution}`)
      .filter({ visible: true });
    await expect(scriptCard).toBeVisible();
    await scriptCard.click();
    // The earlier run's panel stays mounted behind this one.
    const scriptPanel = window
      .getByTestId('pipeline-execution-panel')
      .filter({ visible: true });
    await expect(scriptPanel).toBeVisible();
    const scriptNav = scriptPanel.getByTestId('pipeline-details-nav');
    await expect(scriptNav.getByTestId('pipeline-job-list-cost')).toHaveCount(
      0,
    );
    await expect(
      scriptPanel.getByTestId('pipeline-summary-cost-preview'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
