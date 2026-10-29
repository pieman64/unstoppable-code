// Phase 03 (pipeline workspace panels — execution panel) coverage.
//
// A `pipeline-execution` panel hosts the real run detail. There is no user
// entry point yet (the opener lands next), so these specs create the tab
// through the phase 01 test API (`__canopyPanelTestApi
// .addPipelineExecutionPanel`) and drive it through the real UI:
//
//   1. The panel renders the run for its owner, takes the run's name as its
//      tab title, and holds detail demand only while shown: leaving the main
//      page or hiding its document suspends it (no run reads while hidden,
//      even as execution events arrive), and returning resumes it with at
//      most one snapshot read.
//   2. Beside a chat in the default 1400x900 window the panel is narrower
//      than its job-list auto-collapse width, so the list presents collapsed
//      and the run facts keep each value on one line (two columns, no
//      mid-token wraps), and the flow graph refits to the width it ends up
//      with, clear of its zoom controls. An explicit expand docks the list at
//      that width and survives the panel hiding; collapsing releases the
//      width again. The collapsed list previews on toggle hover without
//      moving the body; a selection closes the preview, Escape returns focus
//      to the toggle, and a toggle click while previewing pins it.
//   3. A popped-out run stays live while the main window leaves the worktree
//      view, and follows its own window's document visibility.
//
// Headless visibility: E2E windows are never shown. Measured on this harness
// (2026-09-29), both the main and the auxiliary documents still report
// `visibilityState === 'visible'` (Electron reports a window created with
// `show: false` as visible until it is minimized or hidden), so the gate is
// genuinely open here. Each spec still pins the document it exercises to
// `visible` first and flips it to `hidden` to prove the gate, with the
// `stuck-agent-warning.spec.mjs` override. Production never treats a hidden
// window as visible.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, SEEDED_CHAT_TAB_ID } from './panelHarness.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import {
  installPipelineIpcProbe,
  readCounts,
  resetCounts,
} from './pipelineIpcProbe.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const EXECUTION_ID = 'e2e-run-panel-1';
const PIPELINE_NAME = 'Panel Pipeline';

/** Overrides `document.visibilityState` in `page` and announces it. */
async function setDocumentVisibility(page, state) {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: next,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/**
 * Polls `read()` until it returns `expected` for `stableHits` consecutive
 * polls, so a late change cannot pass on a lucky early sample.
 */
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

async function launchWithRun() {
  let seeded = null;
  const context = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir }) => {
      seeded = seedPipelineExecution({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id: EXECUTION_ID,
          pipelineId: 'panel-pipeline',
          pipelineName: PIPELINE_NAME,
          status: 'running',
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
        },
        stepLogs: [
          { jobId: 'build', stepId: 'compile', lines: ['compiling sources'] },
        ],
      });
    },
  });
  if (seeded === null) throw new Error('pipeline execution was not seeded');
  return { ...context, seeded };
}

/** Adds the run's panel beside the seeded chat; returns its location. */
async function openRunPanel(window) {
  const result = await window.evaluate(
    ({ executionId, chatTabId }) =>
      window.__canopyPanelTestApi.addPipelineExecutionPanel({
        executionId,
        originChatTabId: chatTabId,
      }),
    { executionId: EXECUTION_ID, chatTabId: SEEDED_CHAT_TAB_ID },
  );
  expect(result.outcome).toBe('placed');
  return result.location;
}

function runPanel(page) {
  return page.locator(
    `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
  );
}

test('hosts the run for its owner and holds detail demand only while shown', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window, app, seeded } =
    await launchWithRun();
  try {
    await setDocumentVisibility(window, 'visible');
    await installPipelineIpcProbe(electronApp, {
      channels: ['getExecution', 'readStepLog'],
    });
    await openRunPanel(window);

    const panel = runPanel(window);
    await expect(panel).toHaveAttribute('data-detail-state', 'active');
    await expect(panel.getByTestId('pipeline-execution-detail')).toBeVisible();
    await expect(panel.getByTestId('pipeline-panel-nav-toggle')).toBeVisible();
    // No takeover chrome: the tab owns the title and close control.
    await expect(panel.locator('[role="dialog"]')).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-panel-pipeline-${EXECUTION_ID}`),
    ).toContainText(PIPELINE_NAME);

    // The main page leaves the worktree view: the panel suspends and reads
    // nothing while execution events keep arriving.
    await app.openOverviewPage();
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await resetCounts(electronApp);
    await injectPipelineExecutionEvent(electronApp, {
      state: {
        ...seeded.state,
        jobs: {
          ...seeded.state.jobs,
          build: { ...seeded.state.jobs.build, status: 'running' },
        },
      },
    });
    await waitForStableValue(
      async () => (await readCounts(electronApp)).getExecution.count,
      0,
    );

    await app.openMainPage();
    await expect(panel).toHaveAttribute('data-detail-state', 'active');
    await expect(panel.getByTestId('pipeline-execution-detail')).toBeVisible();
    await expect(panel.getByTestId('pipeline-summary-view')).toBeVisible();
    const afterReveal = await readCounts(electronApp);
    expect(afterReveal.getExecution.count).toBeLessThanOrEqual(1);

    // Its window's document hiding suspends it the same way.
    await resetCounts(electronApp);
    await setDocumentVisibility(window, 'hidden');
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await waitForStableValue(
      async () => (await readCounts(electronApp)).getExecution.count,
      0,
    );
    await setDocumentVisibility(window, 'visible');
    await expect(panel).toHaveAttribute('data-detail-state', 'active');
    await expect(panel.getByTestId('pipeline-summary-view')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('job list presents collapsed beside a chat, honors an explicit expand, previews on hover, and pins', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window, app } = await launchWithRun();
  try {
    await setDocumentVisibility(window, 'visible');
    await openRunPanel(window);
    const panel = runPanel(window);
    await expect(panel).toHaveAttribute('data-detail-state', 'active');

    const toggle = panel.getByTestId('pipeline-panel-nav-toggle');
    const rail = panel.getByTestId('pipeline-panel-nav');
    const preview = panel.getByTestId('pipeline-panel-nav-preview');
    const body = panel.getByTestId('pipeline-execution-detail-body');

    // Beside the chat the panel is narrower than the auto-collapse width, so
    // the list presents collapsed and the body keeps the panel's width.
    await expect(toggle).toBeVisible();
    await expect(panel).toHaveAttribute('data-panel-width', 'narrow');
    expect((await panel.boundingBox()).width).toBeLessThan(768);
    await expect(toggle).toHaveAttribute('data-nav-state', 'collapsed');
    await expect(toggle).toHaveAttribute('aria-label', 'Show jobs');
    await expect(rail).toHaveCount(0);
    const collapsedBody = await body.boundingBox();
    expect(collapsedBody.width).toBeGreaterThanOrEqual(480);

    // The run facts take two columns here and keep each value on one line:
    // the Started timestamp is one line box and is not cut short.
    const fields = panel.getByTestId('pipeline-summary-fields');
    await expect(fields).toBeVisible();
    expect(
      await fields.evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
    ).toBe(2);
    const started = panel
      .getByTestId('pipeline-summary-field-started')
      .getByTestId('pipeline-summary-field-value');
    await expect(started).toHaveText(/\d/);
    const startedLayout = await started.evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      return {
        lineBoxes: range.getClientRects().length,
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        clipped: element.scrollWidth > element.clientWidth,
      };
    });
    expect(startedLayout.lineBoxes).toBe(1);
    expect(startedLayout.height).toBeLessThanOrEqual(
      startedLayout.lineHeight + 1,
    );
    expect(startedLayout.clipped).toBe(false);

    // The flow graph fits the width it ended up with (the list collapsed
    // after the first layout): every node sits inside the area the fit
    // keeps clear of the zoom controls, and the fit is tight in one axis.
    const flow = panel.locator('.react-flow');
    await expect(flow.locator('.react-flow__node')).toHaveCount(2);
    await expect
      .poll(() =>
        flow.evaluate((root) => {
          const box = root.getBoundingClientRect();
          const nodes = Array.from(
            root.querySelectorAll('.react-flow__node'),
            (node) => node.getBoundingClientRect(),
          );
          const left = Math.min(...nodes.map((rect) => rect.left));
          const right = Math.max(...nodes.map((rect) => rect.right));
          const top = Math.min(...nodes.map((rect) => rect.top));
          const bottom = Math.max(...nodes.map((rect) => rect.bottom));
          const tolerance = 3;
          const inside =
            left >= box.left + 56 - tolerance &&
            right <= box.right - 16 + tolerance &&
            top >= box.top + 16 - tolerance &&
            bottom <= box.bottom - 16 + tolerance;
          const tight =
            Math.abs(right - left - (box.width - 72)) <= tolerance ||
            Math.abs(bottom - top - (box.height - 32)) <= tolerance;
          return inside && tight;
        }),
      )
      .toBe(true);

    // An explicit expand docks the list at this width...
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');
    await expect(toggle).toHaveAttribute('aria-label', 'Hide jobs');
    await expect(rail).toBeVisible();
    expect((await body.boundingBox()).width).toBeLessThan(collapsedBody.width);
    // ...and is the panel's choice from then on, across hiding and showing.
    await app.openOverviewPage();
    await expect(panel).toHaveAttribute('data-detail-state', 'suspended');
    await app.openMainPage();
    await expect(panel).toHaveAttribute('data-detail-state', 'active');
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');
    await expect(rail).toBeVisible();

    // Collapse: the list's width goes back to the body.
    await toggle.click();
    await expect(rail).toHaveCount(0);
    await expect(toggle).toHaveAttribute('data-nav-state', 'collapsed');
    await expect(toggle).toHaveAttribute('aria-label', 'Show jobs');
    expect((await body.boundingBox()).width).toBe(collapsedBody.width);

    // Hover previews over the body without changing its geometry.
    await body.hover();
    await toggle.hover();
    await expect(preview).toBeVisible();
    await expect(toggle).toHaveAttribute('data-nav-state', 'preview');
    expect(await body.boundingBox()).toEqual(collapsedBody);

    // The pointer path from the toggle down into the list is continuous:
    // travel straight down from the toggle in half-pixel steps (so no rule
    // between them can be skipped) keeps it open.
    const toggleBox = await toggle.boundingBox();
    const jobRow = preview.getByTestId('pipeline-details-nav-job-test');
    const jobBox = await jobRow.boundingBox();
    const startY = toggleBox.y + toggleBox.height / 2;
    const endY = jobBox.y + jobBox.height / 2;
    await window.mouse.move(toggleBox.x + toggleBox.width / 2, endY, {
      steps: Math.ceil((endY - startY) * 2),
    });
    await expect(preview).toBeVisible();

    // Selecting a job navigates and closes the preview; still collapsed.
    await jobRow.click();
    await expect(panel.getByTestId('pipeline-job-view-test')).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(rail).toHaveCount(0);

    // Escape closes the preview and returns focus to the toggle.
    await toggle.hover();
    await expect(preview).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(toggle).toBeFocused();

    // Clicking the toggle while previewing pins the list open.
    await body.hover();
    await toggle.hover();
    await expect(preview).toBeVisible();
    await toggle.click();
    await expect(rail).toBeVisible();
    await expect(toggle).toHaveAttribute('data-nav-state', 'expanded');
    await expect(panel.getByTestId('pipeline-job-view-test')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a popped-out run stays live while the main window leaves, and follows its own document', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window, app } = await launchWithRun();
  try {
    await setDocumentVisibility(window, 'visible');
    const location = await openRunPanel(window);
    await expect(runPanel(window)).toHaveAttribute(
      'data-detail-state',
      'active',
    );

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      location.groupId,
    );
    const aux = await auxWindowPromise;
    await setDocumentVisibility(aux, 'visible');
    const auxPanel = runPanel(aux);
    await expect(auxPanel).toBeVisible();
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    await expect(auxPanel.getByTestId('pipeline-summary-view')).toBeVisible();

    // The main window leaves the worktree view; the aux window still shows
    // the run, so it keeps its demand.
    await app.openOverviewPage();
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    // Hiding the MAIN document no longer matters to the adopted panel.
    await setDocumentVisibility(window, 'hidden');
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');

    // Its own window's document does.
    await setDocumentVisibility(aux, 'hidden');
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'suspended');
    await setDocumentVisibility(aux, 'visible');
    await expect(auxPanel).toHaveAttribute('data-detail-state', 'active');
    await expect(auxPanel.getByTestId('pipeline-summary-view')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const REPORT_EXECUTION_ID = 'e2e-run-report-1';

/** Seeds a completed run whose saved report is long enough to scroll. */
function seedRunWithReport(userDataDir) {
  const reportFilePath = path.join(
    userDataDir,
    'pipeline-executions',
    REPORT_EXECUTION_ID,
    'report.md',
  );
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: REPORT_EXECUTION_ID,
      pipelineName: 'Report Pipeline',
      status: 'success',
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
      stateOverrides: { report_outputs: { report_file: reportFilePath } },
    },
  });
  mkdirSync(path.dirname(reportFilePath), { recursive: true });
  const lines = Array.from(
    { length: 80 },
    (_, index) => `- Finding ${index + 1}: everything checked out.`,
  );
  writeFileSync(
    reportFilePath,
    `# Inline report heading\n\n${lines.join('\n')}\n`,
    'utf8',
  );
}

test('View report in a run panel shows the report inline on Summary and leaves the job list alone', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => seedRunWithReport(dir),
  });
  try {
    await setDocumentVisibility(window, 'visible');
    const result = await window.evaluate(
      ({ executionId, chatTabId }) =>
        window.__canopyPanelTestApi.addPipelineExecutionPanel({
          executionId,
          originChatTabId: chatTabId,
        }),
      { executionId: REPORT_EXECUTION_ID, chatTabId: SEEDED_CHAT_TAB_ID },
    );
    expect(result.outcome).toBe('placed');
    const panel = window.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${REPORT_EXECUTION_ID}"]`,
    );
    await expect(panel).toHaveAttribute('data-detail-state', 'active');

    const toggle = panel.getByTestId('pipeline-panel-nav-toggle');
    const rail = panel.getByTestId('pipeline-panel-nav');
    const preview = panel.getByTestId('pipeline-panel-nav-preview');
    const body = panel.getByTestId('pipeline-execution-detail-body');
    const report = panel.getByTestId('pipeline-report');
    const region = panel.getByTestId('pipeline-report-region');
    await expect(toggle).toHaveAttribute('data-nav-state', 'collapsed');

    // Select a job through the collapsed list's preview; the list stays
    // collapsed.
    await body.hover();
    await toggle.hover();
    await expect(preview).toBeVisible();
    await preview.getByTestId('pipeline-details-nav-job-build').click();
    await expect(panel.getByTestId('pipeline-job-view-build')).toBeVisible();
    await expect(report).toHaveCount(0);
    await expect(rail).toHaveCount(0);

    await panel
      .getByTestId(`pipeline-detail-view-report-${REPORT_EXECUTION_ID}`)
      .click();

    // Summary is selected and the report is in view inside the panel.
    await expect(panel.getByTestId('pipeline-job-view-build')).toHaveCount(0);
    await expect(report).toBeVisible();
    await expect(report.getByText('Inline report heading')).toBeVisible();
    // The report ends up at the top of the detail body once the scroll and
    // the content above it settle (or the body is scrolled as far as its
    // content allows, when too little follows the report to reach the top).
    await expect
      .poll(
        () =>
          body.evaluate((bodyElement) => {
            const regionElement = bodyElement.querySelector(
              '[data-testid="pipeline-report-region"]',
            );
            if (regionElement === null) return false;
            const offset =
              regionElement.getBoundingClientRect().top -
              bodyElement.getBoundingClientRect().top;
            const atBottom =
              bodyElement.scrollTop >=
              bodyElement.scrollHeight - bodyElement.clientHeight - 1;
            return offset <= 24 || atBottom;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(region).toBeFocused();
    // No report dialog, and the job list kept its presentation.
    await expect(
      window.getByTestId(`pipeline-report-modal-${REPORT_EXECUTION_ID}`),
    ).toHaveCount(0);
    await expect(toggle).toHaveAttribute('data-nav-state', 'collapsed');
    await expect(rail).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('View report on a run card still opens the report dialog', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => seedRunWithReport(dir),
  });
  try {
    const viewReport = window.getByTestId(
      `pipeline-run-view-report-${REPORT_EXECUTION_ID}`,
    );
    await expect(viewReport).toBeVisible({ timeout: 30_000 });
    await viewReport.click();

    const modal = window.getByTestId(
      `pipeline-report-modal-${REPORT_EXECUTION_ID}`,
    );
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Inline report heading')).toBeVisible();
    // The card's dialog does not open a run panel.
    await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
