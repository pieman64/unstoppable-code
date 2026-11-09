// Daemon workflows acceptance (CAN-5086) against the daemon the lane bridges
// into the product's lookup paths. With no Labs switch (CAN-5960), a workflow
// the main window starts runs in the daemon's pipeline host: its step's
// grandparent is the daemon and its output streams live. A workflow with a
// child pipeline step, which the route excludes in code, runs in process
// while the earlier daemon run still opens; its TypeScript step runs there too.
// A run keeps going after the app quits, with the harness keeping the daemon
// across the close (CAN-5862), and the next launch shows its result.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  killRetainedDaemons,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import {
  expectPipelineRunPanel,
  reopenCompletedStep,
  showPipelineJobList,
} from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

test.skip(
  process.platform !== 'darwin',
  'The lane daemon artifact and its owned-child host are macOS only.',
);

const WORKTREE_BRANCH = 'demo-main';
const PIPELINE_NAME = 'E2E Background Workflow';
const CHILD_PIPELINE_NAME = 'E2E Child Pipeline Workflow';
const FIXTURE_DIR = path.join('.canopy', 'e2e-daemon-pipelines');

function fixtureApp(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, FIXTURE_DIR), { recursive: true });
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-background-workflow',
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  work:',
      '    name: Work',
      '    steps:',
      '      - id: emit',
      '        name: Emit markers',
      '        run: |',
      `          echo "marker-1 grandparent=$(ps -o ppid= -p $PPID | tr -d ' ')"`,
      `          while [ ! -f ${FIXTURE_DIR}/release ]; do sleep 0.2; done`,
      '          echo marker-2',
      '',
    ].join('\n'),
  });
  // A child pipeline step keeps the whole run in process (`child_pipeline`).
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-child-workflow',
    name: CHILD_PIPELINE_NAME,
    yaml: [
      `name: ${CHILD_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  work:',
      '    name: Work',
      '    steps:',
      '      - id: emit',
      '        name: Emit markers',
      '        run: |',
      `          echo "marker-1 grandparent=$(ps -o ppid= -p $PPID | tr -d ' ')"`,
      '      - id: child',
      '        name: Child',
      '        uses: builtin/run-pipeline',
      '        with:',
      '          pipeline_yaml: |',
      '            name: E2E Child',
      '            on: dispatch',
      '            jobs:',
      '              child:',
      '                steps:',
      '                  - run: echo child-ran',
      // CAN-6026: an in-process TypeScript step must run tsx as Node.
      '      - id: typescript',
      '        name: TypeScript',
      '        shell: tsx',
      '        run: |',
      "          const kind: string = 'tsx';",
      '          console.log(`typescript-ran ${kind}`);',
      '',
    ].join('\n'),
  });
  return { userDataDir, worktreePath };
}

function release(worktreePath) {
  writeFileSync(path.join(worktreePath, FIXTURE_DIR, 'release'), 'go\n');
}

function hold(worktreePath) {
  rmSync(path.join(worktreePath, FIXTURE_DIR, 'release'), { force: true });
}

async function launch(userDataDir, options = {}) {
  const { electronApp } = await launchCanopy({ userDataDir, ...options });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  return { electronApp, window };
}

/** The daemon serving this data root, from its descriptor. */
function daemonPid(userDataDir) {
  const descriptor = path.join(
    realpathSync(userDataDir),
    'runtime',
    'core.json',
  );
  return existsSync(descriptor)
    ? JSON.parse(readFileSync(descriptor, 'utf8')).pid
    : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Stops a daemon the app left running, then removes the data roots. */
async function cleanup(userDataDir) {
  const pid = daemonPid(userDataDir);
  if (pid !== undefined && isAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    await expect.poll(() => isAlive(pid), { timeout: 30_000 }).toBe(false);
  }
  await removeTestDataDir(userDataDir);
  await removeTestDataDir(`${userDataDir}-secure`);
}

async function dispatch(window, name = PIPELINE_NAME) {
  const cards = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: name });
  const before = new Set(
    await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-testid')),
    ),
  );
  await new CanopyAppDriver(window).openPipelineDispatchModal(name);
  const runButton = window.getByTestId('pipeline-trigger-modal-run');
  await expect(runButton).toBeEnabled();
  await runButton.click();
  // The new run's card, not one an earlier run left in the list.
  let testId;
  await expect
    .poll(
      async () => {
        const ids = await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-testid')),
        );
        testId = ids.find((id) => id && !before.has(id));
        return testId !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return {
    executionId: testId.slice('pipeline-run-card-'.length),
    runCard: window.getByTestId(testId),
  };
}

async function openRunningStep(window, runCard, executionId) {
  await expect(runCard).toContainText('running', { timeout: 60_000 });
  const jobDot = runCard.locator('[data-job-id="work"]');
  await expect(jobDot).toHaveAttribute('aria-label', 'Work: running', {
    timeout: 60_000,
  });
  await jobDot.click();
  await expectPipelineRunPanel(window, executionId);
  await showPipelineJobList(window, { timeout: 15_000 });
  return window.getByTestId('pipeline-step-log-output-emit');
}

async function grandparentOf(output) {
  await expect(output).toContainText('marker-1', { timeout: 60_000 });
  const match = /marker-1 grandparent=(\d+)/.exec(
    (await output.textContent()) ?? '',
  );
  expect(match, 'the printed grandparent pid').toBeTruthy();
  return Number(match[1]);
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

/** The run's stored status, read from the execution store without the app. */
function storedStatus(userDataDir, executionId) {
  const file = path.join(
    realpathSync(userDataDir),
    'pipeline-executions',
    `${executionId}.json`,
  );
  return existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).status
    : undefined;
}

test.describe('daemon workflows', () => {
  test("a workflow from the main window runs in the daemon's pipeline host and streams its output", async () => {
    test.setTimeout(240_000);
    const { userDataDir, worktreePath } = fixtureApp('c5086-on-');
    let electronApp;
    try {
      const launched = await launch(userDataDir);
      electronApp = launched.electronApp;
      const { window } = launched;
      hold(worktreePath);
      const { executionId, runCard } = await dispatch(window);
      const output = await openRunningStep(window, runCard, executionId);
      // marker-1 arrives live, before the step is released.
      const grandparent = await grandparentOf(output);
      expect(grandparent).toBe(daemonPid(userDataDir));
      await expect(output).not.toContainText('marker-2');
      release(worktreePath);
      await expect(runCard).toContainText('success', { timeout: 60_000 });
      await expect(output).toContainText('marker-2', { timeout: 30_000 });
      const text = (await output.textContent()) ?? '';
      expect(count(text, 'marker-1')).toBe(1);
      expect(count(text, 'marker-2')).toBe(1);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('a workflow with a child pipeline step runs in process and the earlier daemon run still opens', async () => {
    test.setTimeout(300_000);
    const { userDataDir, worktreePath } = fixtureApp('c5086-off-');
    let electronApp;
    try {
      const first = await launch(userDataDir);
      electronApp = first.electronApp;
      hold(worktreePath);
      const daemonRun = await dispatch(first.window);
      const output = await openRunningStep(
        first.window,
        daemonRun.runCard,
        daemonRun.executionId,
      );
      const daemon = daemonPid(userDataDir);
      expect(await grandparentOf(output)).toBe(daemon);
      release(worktreePath);
      await expect(daemonRun.runCard).toContainText('success', {
        timeout: 60_000,
      });
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;

      const second = await launch(userDataDir);
      electronApp = second.electronApp;
      const { window } = second;
      const appRun = await dispatch(window, CHILD_PIPELINE_NAME);
      expect(appRun.executionId).not.toBe(daemonRun.executionId);
      await expect(appRun.runCard).toContainText('success', {
        timeout: 60_000,
      });
      const appStep = await reopenCompletedStep(
        window,
        appRun.runCard,
        'work',
        'emit',
      );
      const appGrandparent = await grandparentOf(
        appStep.getByTestId('pipeline-step-log-output-emit'),
      );
      expect(appGrandparent).not.toBe(daemon);
      expect(appGrandparent).not.toBe(daemonPid(userDataDir));
      const typescriptStep = await reopenCompletedStep(
        window,
        appRun.runCard,
        'work',
        'typescript',
      );
      await expect(
        typescriptStep.getByTestId('pipeline-step-log-output-typescript'),
      ).toContainText('typescript-ran tsx', { timeout: 30_000 });

      const daemonCard = window.getByTestId(
        `pipeline-run-card-${daemonRun.executionId}`,
      );
      await expect(daemonCard).toContainText('success', { timeout: 30_000 });
      const daemonStep = await reopenCompletedStep(
        window,
        daemonCard,
        'work',
        'emit',
      );
      await expect(
        daemonStep.getByTestId('pipeline-step-log-output-emit'),
      ).toContainText('marker-2', { timeout: 30_000 });
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('a run keeps going after the app quits and the next launch shows its result', async () => {
    test.setTimeout(300_000);
    const { userDataDir, worktreePath } = fixtureApp('c5862-quit-');
    let electronApp;
    try {
      const first = await launch(userDataDir, { retainDaemon: true });
      electronApp = first.electronApp;
      hold(worktreePath);
      const { executionId, runCard } = await dispatch(first.window);
      const output = await openRunningStep(first.window, runCard, executionId);
      const daemon = daemonPid(userDataDir);
      expect(await grandparentOf(output)).toBe(daemon);
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        retainDaemon: true,
      });
      electronApp = undefined;

      // The app is gone; the daemon and its run are not.
      expect(isAlive(daemon)).toBe(true);
      expect(storedStatus(userDataDir, executionId)).toBe('running');
      release(worktreePath);
      await expect
        .poll(() => storedStatus(userDataDir, executionId), {
          timeout: 60_000,
        })
        .toBe('success');

      const second = await launch(userDataDir);
      electronApp = second.electronApp;
      const card = second.window.getByTestId(
        `pipeline-run-card-${executionId}`,
      );
      await expect(card).toContainText('success', { timeout: 30_000 });
      const step = await reopenCompletedStep(
        second.window,
        card,
        'work',
        'emit',
      );
      const log = step.getByTestId('pipeline-step-log-output-emit');
      await expect(log).toContainText('marker-2', { timeout: 30_000 });
      const text = (await log.textContent()) ?? '';
      expect(count(text, 'marker-1')).toBe(1);
      expect(count(text, 'marker-2')).toBe(1);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await killRetainedDaemons();
      await cleanup(userDataDir);
    }
  });
});
