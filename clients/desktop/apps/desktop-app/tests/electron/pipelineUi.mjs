// Pipeline UI steps shared by more than one spec: configuring a pipeline
// secret through the real Settings → Environments section, reopening a completed step's
// details from its run card, finding or closing a run's panel, and showing a
// run panel's job list.
//
// Run links open the run's `pipeline-execution` panel tab (through the shared
// opener) rather than a takeover modal. A panel does not close on Escape;
// specs close its tab. A panel narrower than its auto-collapse width (a run
// beside a chat in the default 1400px window) presents its job list
// collapsed; `showPipelineJobList` expands it the way a user does.
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';

/** The shown panel for `executionId`, once its detail is active. */
export async function expectPipelineRunPanel(
  window,
  executionId,
  { timeout = 15_000 } = {},
) {
  const panel = window.locator(
    `[data-testid="pipeline-execution-panel"][data-execution-id="${executionId}"]`,
  );
  await expect(panel).toBeVisible({ timeout });
  await expect(panel).toHaveAttribute('data-detail-state', 'active', {
    timeout,
  });
  return panel;
}

/**
 * Shows the run's job list in `scope` (a window, or a run panel) and returns
 * it. A run panel presents the list collapsed when it is narrower than its
 * auto-collapse width; this expands it with the toggle, which the panel keeps
 * as the user's explicit choice (it stays docked across hide/reveal). A host
 * without a toggle (the ownerless compat modal, the archived viewer) always
 * docks it.
 */
export async function showPipelineJobList(scope, { timeout = 15_000 } = {}) {
  const nav = scope
    .getByTestId('pipeline-details-nav')
    .filter({ visible: true })
    .first();
  const toggle = scope
    .getByTestId('pipeline-panel-nav-toggle')
    .filter({ visible: true })
    .first();
  await expect(nav.or(toggle).first()).toBeVisible({ timeout });
  if (
    (await toggle.count()) > 0 &&
    (await toggle.getAttribute('data-nav-state')) !== 'expanded'
  ) {
    // Collapsed, or previewing under a resting pointer: either way the click
    // pins the list open.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');
  }
  await expect(nav).toBeVisible({ timeout });
  return nav;
}

/** Closes every open pipeline run tab through its tab close control. */
export async function closePipelineRunPanels(window) {
  const closeButtons = window.locator(
    '[data-testid^="panel-tab-close-panel-pipeline-"]',
  );
  for (let remaining = await closeButtons.count(); remaining > 0; ) {
    // The active-tab reveal overlay can briefly win hit-testing over a tab's
    // close control (see archive-worktree-chat.spec.mjs), so force the click.
    await closeButtons.first().click({ force: true });
    remaining -= 1;
    await expect(closeButtons).toHaveCount(remaining);
  }
  await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(0);
  await expect(window.getByTestId('pipeline-details-nav')).toHaveCount(0);
}

export async function configureGlobalPipelineSecret(window, key, value) {
  const app = new CanopyAppDriver(window);
  await app.openEnvironmentsSettings();

  await window.getByTestId('environments-list-row-default-pipeline').click();
  await window.getByTestId('environment-editor-add-row').click();
  await window
    .locator('input[data-testid^="environment-editor-key-"]')
    .last()
    .fill(key);
  await window
    .locator('input[data-testid^="environment-editor-value-"]')
    .last()
    .fill(value);
  await window
    .locator('input[data-testid^="environment-editor-secret-"]')
    .last()
    .check();
  await window.getByTestId('environments-save').click();
  await expect(window.getByTestId('environments-save-status')).toHaveText(
    'Saved.',
  );
  // Close Settings so the following steps see the page beneath it.
  await app.closeSettings();
}

export async function reopenCompletedStep(window, runCard, jobId, stepId) {
  await runCard.click({ position: { x: 10, y: 10 } });
  const executionId = (await runCard.getAttribute('data-testid')).replace(
    'pipeline-run-card-',
    '',
  );
  const panel = await expectPipelineRunPanel(window, executionId);
  const nav = await showPipelineJobList(panel);
  await nav.getByTestId(`pipeline-details-nav-job-${jobId}`).click();
  const stepDetail = window.getByTestId(`pipeline-step-detail-${stepId}`);
  if (!(await stepDetail.isVisible().catch(() => false))) {
    await window.getByTestId(`pipeline-step-${stepId}`).click();
  }
  await expect(stepDetail).toBeVisible();
  return stepDetail;
}
