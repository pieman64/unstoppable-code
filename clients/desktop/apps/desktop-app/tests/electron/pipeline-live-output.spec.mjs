import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
  reopenCompletedStep,
  showPipelineJobList,
} from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import {
  FIXTURE_DIR as RUNNER_FIXTURE_DIR,
  seedRunnerFixture,
  processExists,
  readOwnedPids,
  expectOwnedProcessesGone,
  releasePartialAndExit,
  expectFinalOutput,
  cleanupFixture,
} from './helpers/runnerContract.mjs';

// Live pipeline output is intentionally exercised with real child processes,
// persisted log sidecars, main-to-renderer output events, and the production
// Pipeline Runs UI. Filesystem barriers distinguish partial live streams
// from completed persisted logs without relying on elapsed time.
//
// This golden protects the user-visible seams of pipeline process isolation:
//   - the Pipeline Runs card and DAG progress dot update while a job is active;
//   - the open run panel receives new output without being reopened;
//   - raw output has an exact, duplicate-free marker set both live and after
//     the running -> terminal transition, then still does after reopening;
//   - an active run can be cancelled from its panel and retried in place;
//   - stdout, stderr, partial lines and exit failures survive completion;
//   - cancellation reaps cooperative and SIGTERM-resistant owned descendants.

const WORKTREE_BRANCH = 'demo-main';
const FIXTURE_DIR = path.join('.canopy', 'e2e-pipeline-live-output');
const PLAIN_PIPELINE_NAME = 'E2E Live Plain Output';
const CANCEL_PIPELINE_NAME = 'E2E Cancel And Retry';

const waitForActivityPanel = async (window) => {
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
};

function writeFixtureFile(worktreePath, relativePath, contents) {
  const filePath = path.join(worktreePath, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function seedLiveOutputFixtures({ userDataDir, worktreePath }) {
  const waitHelper = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const wait = (milliseconds) =>',
    '  new Promise((resolve) => setTimeout(resolve, milliseconds));',
    `const fixtureDir = path.join(process.cwd(), ${JSON.stringify(FIXTURE_DIR)});`,
  ].join('\n');

  writeFixtureFile(
    worktreePath,
    path.join(FIXTURE_DIR, 'plain-stream.cjs'),
    [
      waitHelper,
      "const releaseFile = path.join(fixtureDir, 'plain.release');",
      '(async () => {',
      '  for (let index = 0; index < 16; index += 1) {',
      "    console.log(`E2E_PLAIN_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_PLAIN_PHASE_ONE_READY');",
      '  while (!fs.existsSync(releaseFile)) {',
      '    await wait(25);',
      '  }',
      '  for (let index = 16; index < 32; index += 1) {',
      "    console.log(`E2E_PLAIN_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_PLAIN_COMPLETE');",
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );

  writeFixtureFile(
    worktreePath,
    path.join(FIXTURE_DIR, 'cancel-retry.cjs'),
    [
      waitHelper,
      "const retryFile = path.join(fixtureDir, 'retry-success');",
      '(async () => {',
      '  if (!fs.existsSync(retryFile)) {',
      '    let index = 0;',
      '    while (true) {',
      "      console.log(`E2E_CANCEL_LIVE_${String(index).padStart(3, '0')}`);",
      '      index += 1;',
      '      await wait(50);',
      '    }',
      '  }',
      '  for (let index = 0; index < 16; index += 1) {',
      "    console.log(`E2E_RETRY_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_RETRY_COMPLETE');",
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );

  seedStoredPipeline({
    userDataDir,
    id: 'e2e-live-plain-output',
    name: PLAIN_PIPELINE_NAME,
    yaml: [
      `name: ${PLAIN_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  stream:',
      '    name: Plain Stream',
      '    steps:',
      '      - id: emit',
      '        name: Emit plain output',
      `        run: node ${FIXTURE_DIR}/plain-stream.cjs`,
      '',
    ].join('\n'),
  });
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-cancel-retry',
    name: CANCEL_PIPELINE_NAME,
    yaml: [
      `name: ${CANCEL_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  controllable:',
      '    name: Controllable',
      '    steps:',
      '      - id: work',
      '        name: Controllable work',
      `        run: node ${FIXTURE_DIR}/cancel-retry.cjs`,
      '',
    ].join('\n'),
  });
}

function seedRunnerPipeline({ userDataDir, worktreePath }, mode) {
  const dir = seedRunnerFixture(worktreePath, mode);
  const name = `Runner contract ${mode}`;
  seedStoredPipeline({
    userDataDir,
    id: 'runner-contract',
    name,
    yaml: [
      `name: ${name}`,
      'on: dispatch',
      'jobs:',
      '  contract:',
      '    name: Runner contract',
      '    steps:',
      '      - id: execute',
      '        name: Execute fixture',
      `        run: node ${RUNNER_FIXTURE_DIR}/runner.cjs`,
      '',
    ].join('\n'),
  });
  return dir;
}

async function launchFixtureApp(
  prefix,
  { seedFixtures = seedLiveOutputFixtures, cleanup = closeCanopy } = {},
) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const dir = seedFixtures({ userDataDir, worktreePath });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await waitForActivityPanel(window);
    return { electronApp, userDataDir, window, worktreePath, dir };
  } catch (error) {
    await cleanup(electronApp, userDataDir, dir);
    throw error;
  }
}

async function dispatchPipeline(window, pipelineName) {
  await new CanopyAppDriver(window).openPipelineDispatchModal(pipelineName);
  const runButton = window.getByTestId('pipeline-trigger-modal-run');
  await expect(runButton).toBeEnabled();
  await runButton.click();

  const runCard = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: pipelineName })
    .first();
  await expect(runCard).toBeVisible({ timeout: 30_000 });
  const testId = await runCard.getAttribute('data-testid');
  expect(testId).toMatch(/^pipeline-run-card-.+/);
  return {
    executionId: testId.slice('pipeline-run-card-'.length),
    runCard,
  };
}

async function openRunningJob(window, runCard, jobId, jobName) {
  await expect(runCard).toContainText('running', { timeout: 30_000 });
  const jobDot = runCard.locator(`[data-job-id="${jobId}"]`);
  await expect(jobDot).toHaveAttribute('aria-label', `${jobName}: running`, {
    timeout: 30_000,
  });
  await jobDot.click();
  // The job link opens the run's panel at that job.
  await expectPipelineRunPanel(
    window,
    (await runCard.getAttribute('data-testid')).replace(
      'pipeline-run-card-',
      '',
    ),
  );
  await showPipelineJobList(window, { timeout: 15_000 });
  await expect(window.getByTestId(`pipeline-job-view-${jobId}`)).toBeVisible();
  return jobDot;
}

async function closeDetails(window) {
  await closePipelineRunPanels(window);
}

function expectedMarkers(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(3, '0')}`,
  );
}

async function expectExactMarkers(locator, prefix, count) {
  const expected = expectedMarkers(prefix, count);
  await expect
    .poll(
      async () => {
        const text = (await locator.textContent()) ?? '';
        return text.match(new RegExp(`${prefix}\\d{3}`, 'g')) ?? [];
      },
      {
        message: `expected exactly ${String(count)} ordered ${prefix} markers`,
        timeout: 30_000,
      },
    )
    .toEqual(expected);
}

async function launchRunnerFixture(mode) {
  const fixture = await launchFixtureApp('canopy-pipeline-contract-', {
    seedFixtures: (context) => seedRunnerPipeline(context, mode),
    cleanup: cleanupFixture,
  });
  const { electronApp, userDataDir, window, dir } = fixture;
  try {
    const run = await dispatchPipeline(window, `Runner contract ${mode}`);
    const jobDot = await openRunningJob(
      window,
      run.runCard,
      'contract',
      'Runner contract',
    );
    const output = window.getByTestId('pipeline-step-log-output-execute');
    await expect(output).toBeVisible();
    return { ...fixture, ...run, jobDot, output };
  } catch (error) {
    await cleanupFixture(electronApp, userDataDir, dir);
    throw error;
  }
}

function persistedState(userDataDir, executionId) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'pipeline-executions', `${executionId}.json`),
      'utf8',
    ),
  );
}

async function expectSettledState(userDataDir, executionId, status) {
  await expect
    .poll(() => persistedState(userDataDir, executionId).status)
    .toBe(status);
  const state = persistedState(userDataDir, executionId);
  expect(state.completed_at).toBeTruthy();
  expect(state.jobs.contract.status).toBe(status);
  expect(state.jobs.contract.steps.execute.status).toBe(status);
  return state;
}

test.describe('live pipeline output and controls', () => {
  test('streams complete raw output to progress and details during and after execution', async () => {
    test.setTimeout(180_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-live-plain-',
    );
    const { electronApp, userDataDir, window, worktreePath } = fixture;

    try {
      const { runCard } = await dispatchPipeline(window, PLAIN_PIPELINE_NAME);
      const jobDot = await openRunningJob(
        window,
        runCard,
        'stream',
        'Plain Stream',
      );
      const output = window.getByTestId('pipeline-step-log-output-emit');

      await expect(output).toContainText('E2E_PLAIN_PHASE_ONE_READY', {
        timeout: 30_000,
      });
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 16);

      writeFixtureFile(
        worktreePath,
        path.join(FIXTURE_DIR, 'plain.release'),
        'release\n',
      );

      // The already-open panel receives the second phase live. The same
      // transition also forces a fresh persisted-log read at completion.
      await expect(output).toContainText('E2E_PLAIN_COMPLETE', {
        timeout: 30_000,
      });
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 32);
      await expect(runCard).toContainText('success', { timeout: 30_000 });
      await expect(jobDot).toHaveAttribute(
        'aria-label',
        'Plain Stream: success',
      );
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 32);

      await closeDetails(window);
      const reopened = await reopenCompletedStep(
        window,
        runCard,
        'stream',
        'emit',
      );
      await expectExactMarkers(
        reopened.getByTestId('pipeline-step-log-output-emit'),
        'E2E_PLAIN_LINE_',
        32,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cancels a live run from details and retries it to success in place', async () => {
    test.setTimeout(180_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-cancel-retry-',
    );
    const { electronApp, userDataDir, window, worktreePath } = fixture;

    try {
      const { executionId, runCard } = await dispatchPipeline(
        window,
        CANCEL_PIPELINE_NAME,
      );
      await openRunningJob(window, runCard, 'controllable', 'Controllable');

      const liveOutput = window
        .getByTestId('pipeline-step-log-output-work')
        .last();
      await expect(liveOutput).toContainText('E2E_CANCEL_LIVE_005', {
        timeout: 30_000,
      });

      const cancelButton = window.getByTestId(
        `pipeline-detail-cancel-${executionId}`,
      );
      await expect(cancelButton).toBeEnabled();
      await cancelButton.click();
      await expect(runCard).toContainText('cancelled', { timeout: 30_000 });

      const retryButton = window.getByTestId(
        `pipeline-detail-retry-${executionId}`,
      );
      await expect(retryButton).toBeEnabled({ timeout: 15_000 });
      writeFixtureFile(
        worktreePath,
        path.join(FIXTURE_DIR, 'retry-success'),
        'retry\n',
      );
      await retryButton.click();

      // Retry reuses the execution id and keeps the panel open. Verify the
      // second process streams into that live surface before it terminates.
      await expect(runCard).toContainText('running', { timeout: 30_000 });
      const retryOutput = window
        .getByTestId('pipeline-step-log-output-work')
        .last();
      await expect(retryOutput).toContainText('E2E_RETRY_LINE_005', {
        timeout: 30_000,
      });
      await expect(retryOutput).toContainText('E2E_RETRY_COMPLETE', {
        timeout: 30_000,
      });
      await expectExactMarkers(retryOutput, 'E2E_RETRY_LINE_', 16);
      await expect(runCard).toContainText('success', { timeout: 30_000 });
      await expect(
        runCard.locator('[data-job-id="controllable"]'),
      ).toHaveAttribute('aria-label', 'Controllable: success');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('pipeline streams stdout and stderr before failure and preserves partial lines', async () => {
  const {
    electronApp,
    userDataDir,
    dir,
    window,
    runCard,
    jobDot,
    executionId,
    output,
  } = await launchRunnerFixture('stream');
  try {
    await expect(output).toContainText('RUNNER_STDOUT_READY');
    await expect(output).toContainText('RUNNER_STDERR_READY');
    await expect(runCard).toContainText('running');
    expect(persistedState(userDataDir, executionId).status).toBe('running');
    await releasePartialAndExit(dir);
    await expect(runCard).toContainText('failure');
    await expect(jobDot).toHaveAttribute(
      'aria-label',
      'Runner contract: failure',
    );
    await expectFinalOutput(output);
    const state = await expectSettledState(userDataDir, executionId, 'failure');
    expect(state.jobs.contract.steps.execute.exit_code).toBe(23);
    await closePipelineRunPanels(window);
    const reopened = await reopenCompletedStep(
      window,
      runCard,
      'contract',
      'execute',
    );
    await expectFinalOutput(
      reopened.getByTestId('pipeline-step-log-output-execute'),
    );
  } finally {
    await cleanupFixture(electronApp, userDataDir, dir);
  }
});

for (const mode of ['cooperative', 'ignore-term']) {
  test(`cancels a pipeline and reaps its owned descendant (${mode})`, async () => {
    const {
      electronApp,
      userDataDir,
      dir,
      window,
      runCard,
      executionId,
      output,
    } = await launchRunnerFixture(mode);
    try {
      await expect(output).toContainText('RUNNER_DESCENDANT_READY');
      expect(readOwnedPids(dir).every(processExists)).toBe(true);
      await window.getByTestId(`pipeline-detail-cancel-${executionId}`).click();
      await expect(runCard).toContainText('cancelled');
      await expectSettledState(userDataDir, executionId, 'cancelled');
      await expectOwnedProcessesGone(dir);
      await closePipelineRunPanels(window);
      const reopened = await reopenCompletedStep(
        window,
        runCard,
        'contract',
        'execute',
      );
      await expect(
        reopened.getByTestId('pipeline-step-log-output-execute'),
      ).toContainText('RUNNER_DESCENDANT_READY');
      expect(persistedState(userDataDir, executionId).status).toBe('cancelled');
    } finally {
      await cleanupFixture(electronApp, userDataDir, dir);
    }
  });
}
