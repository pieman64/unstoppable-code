// Daemon workflows with host steps acceptance (CAN-5771) against the daemon
// the lane bridges into the product's lookup paths. With no Labs switch
// (CAN-5960), a workflow with host steps runs in the daemon's pipeline host
// once this app has spawned the daemon (D19), and Electron main, its owner,
// carries out each host step: a created worktree appears in the sidebar.
// Quitting during a host step leaves a paused run that resumes in the app,
// and the same workflow with a desktop notify step also runs in the daemon,
// with Electron main showing its notification (CAN-5868).
// The harness reaps every process an app started when it closes the app, so
// the daemon's 10 s owner-absent pause is covered by pipeline-host-steps.test.ts;
// here the paused run is the daemon's stop checkpoint or the relaunch sweep.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import { reopenCompletedStep } from './pipelineUi.mjs';
import { injectChatEvent } from './seeders/injectChatEvent.mjs';
import { publishTurnLifecycle } from './seeders/publishTurnLifecycle.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';

test.skip(
  process.platform !== 'darwin',
  'The lane daemon artifact and its owned-child host are macOS only.',
);

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 't1';
const TURN_MESSAGE_ID = 'e2e-host-step-wait';
const RESUME_MESSAGE_ID = 'e2e-host-step-resume';
const WARM_UP = 'E2E Warm Up';
const CREATE = 'E2E Create Worktree';
const CREATE_NOTIFY = 'E2E Notify After Worktree';
const WAIT = 'E2E Wait For Reply';
const CREATED_BRANCH = 'e2e-host-step-worktree';
// CAN-5095: a Claude agent step, answered by the mock LLM through its marker.
const MODEL = 'E2E Model Step';
const MODEL_MARKER = 'Canopy-CDAEMONMODEL5095';
const MODEL_REPLY = 'daemon-model-reply-5095';

/** Prints its step's grandparent: the daemon's pipeline host shell, or the app's. */
const EMIT = 'echo "marker grandparent=$(ps -o ppid= -p $PPID | tr -d \' \')"';

function stored(userDataDir, id, name, steps) {
  seedStoredPipeline({
    userDataDir,
    id,
    name,
    yaml: [
      `name: ${name}`,
      'on: dispatch',
      'jobs:',
      '  work:',
      '    name: Work',
      '    steps:',
      ...steps,
      '',
    ].join('\n'),
  });
}

function fixtureApp(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Chat', model: 'sonnet' }],
  });
  stored(userDataDir, 'e2e-warm-up', WARM_UP, [
    '      - id: emit',
    '        name: Emit',
    `        run: ${JSON.stringify(EMIT)}`,
  ]);
  stored(userDataDir, 'e2e-create-worktree', CREATE, [
    '      - id: wt',
    '        name: Create worktree',
    '        uses: builtin/create-worktree',
    '        with:',
    `          project_id: ${WORKSPACE_ID}`,
    `          branch: ${CREATED_BRANCH}`,
    '      - id: emit',
    '        name: Emit',
    '        run: |',
    `          ${EMIT}`,
    '          echo "created=${{ steps.wt.outputs.path }}"',
  ]);
  stored(userDataDir, 'e2e-model-step', MODEL, [
    '      - id: ask',
    '        name: Ask',
    '        uses: builtin/agent-prompt',
    '        with:',
    `          prompt: ${JSON.stringify(`[${MODEL_MARKER}] Say hello.`)}`,
    '      - id: emit',
    '        name: Emit',
    `        run: ${JSON.stringify(EMIT)}`,
  ]);
  // Electron main shows the daemon run's desktop notification (CAN-5868).
  stored(userDataDir, 'e2e-create-worktree-notify', CREATE_NOTIFY, [
    '      - id: wt',
    '        name: Create worktree',
    '        uses: builtin/create-worktree',
    '        with:',
    `          project_id: ${WORKSPACE_ID}`,
    `          branch: ${CREATED_BRANCH}`,
    '      - id: emit',
    '        name: Emit',
    '        run: |',
    `          ${EMIT}`,
    '          echo "created=${{ steps.wt.outputs.path }}"',
    '      - id: notify',
    '        name: Notify',
    '        uses: builtin/notify',
    '        with:',
    '          title: E2E',
    '          body: done',
  ]);
  stored(userDataDir, 'e2e-wait-for-reply', WAIT, [
    '      - id: wait',
    '        name: Wait for reply',
    '        uses: builtin/wait-for-agent-reply',
    '        with:',
    `          project_id: ${WORKSPACE_ID}`,
    `          task_id: ${WORKTREE_BRANCH}`,
    `          chat_id: ${CHAT_ID}`,
    '      - id: emit',
    '        name: Emit',
    `        run: ${JSON.stringify(EMIT)}`,
  ]);
  return { userDataDir };
}

async function launch(userDataDir) {
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  return { electronApp, window, app };
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

/** Records each desktop notification Electron main shows, instead of showing it. */
async function recordNotifications(electronApp) {
  await electronApp.evaluate(({ Notification }) => {
    globalThis.__canopyE2eNotifications = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function show() {
      globalThis.__canopyE2eNotifications.push({
        title: this.title,
        body: this.body,
      });
    };
  });
}

function shownNotifications(electronApp) {
  return electronApp.evaluate(() => globalThis.__canopyE2eNotifications ?? []);
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

async function dispatch(window, name) {
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

async function emitted(window, runCard) {
  const step = await reopenCompletedStep(window, runCard, 'work', 'emit');
  const output = step.getByTestId('pipeline-step-log-output-emit');
  await expect(output).toContainText('marker', { timeout: 60_000 });
  const text = (await output.textContent()) ?? '';
  const match = /marker grandparent=(\d+)/.exec(text);
  expect(match, 'the printed grandparent pid').toBeTruthy();
  return { grandparent: Number(match[1]), text };
}

/**
 * Runs the shell-only workflow once, in the daemon: the owner check passes
 * only once this app spawned the daemon (D19).
 */
async function warmUp(window, userDataDir) {
  const run = await dispatch(window, WARM_UP);
  await expect(run.runCard).toContainText('success', { timeout: 120_000 });
  const { grandparent } = await emitted(window, run.runCard);
  expect(grandparent).toBe(daemonPid(userDataDir));
}

test.describe('daemon workflows with model steps (CAN-5095)', () => {
  test("a Claude agent step runs in the daemon's pipeline host and shows its reply", async () => {
    test.setTimeout(300_000);
    await registerScenario(DEFAULT_MOCK_BASE_URL, MODEL_MARKER, {
      llm: { steps: [{ text: MODEL_REPLY, stopReason: 'end_turn' }] },
    });
    const { userDataDir } = fixtureApp('c5095-model-');
    let electronApp;
    try {
      const launched = await launch(userDataDir);
      electronApp = launched.electronApp;
      const { window } = launched;
      await warmUp(window, userDataDir);
      const run = await dispatch(window, MODEL);
      await expect(run.runCard).toContainText('success', {
        timeout: 180_000,
      });
      const { grandparent } = await emitted(window, run.runCard);
      expect(grandparent).toBe(daemonPid(userDataDir));
      const ask = await reopenCompletedStep(window, run.runCard, 'work', 'ask');
      await expect(ask).toContainText(MODEL_REPLY, { timeout: 60_000 });
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });
});

test.describe('daemon workflows with host steps', () => {
  test('a workflow that creates a worktree runs in the daemon and the worktree appears', async () => {
    test.setTimeout(300_000);
    const { userDataDir } = fixtureApp('c5771-create-');
    let electronApp;
    try {
      const launched = await launch(userDataDir);
      electronApp = launched.electronApp;
      const { window, app } = launched;
      await warmUp(window, userDataDir);
      const run = await dispatch(window, CREATE);
      await expect(run.runCard).toContainText('success', {
        timeout: 120_000,
      });
      const { grandparent, text } = await emitted(window, run.runCard);
      expect(grandparent).toBe(daemonPid(userDataDir));
      expect(text).toMatch(/created=\/\S+/);
      await app.selectWorktree(CREATED_BRANCH);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('quitting during a wait pauses the run, and it resumes in the app', async () => {
    test.setTimeout(360_000);
    const { userDataDir } = fixtureApp('c5771-wait-');
    let electronApp;
    try {
      const first = await launch(userDataDir);
      electronApp = first.electronApp;
      await warmUp(first.window, userDataDir);
      const daemon = daemonPid(userDataDir);
      // A turn in progress in the chat, so the wait step waits.
      const turn = {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        chatId: CHAT_ID,
        turnUserMessageId: TURN_MESSAGE_ID,
      };
      await publishTurnLifecycle(electronApp, { ...turn, phase: 'start' });
      const run = await dispatch(first.window, WAIT);
      const jobDot = run.runCard.locator('[data-job-id="work"]');
      await expect(jobDot).toHaveAttribute('aria-label', 'Work: running', {
        timeout: 60_000,
      });
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;
      await new Promise((resolve) => setTimeout(resolve, 15_000));

      const second = await launch(userDataDir);
      electronApp = second.electronApp;
      const { window } = second;
      const card = window.getByTestId(`pipeline-run-card-${run.executionId}`);
      await expect(card).toContainText('paused', { timeout: 60_000 });
      // The quit interrupted the watched turn, so the relaunch records it as
      // awaiting a resume, and only a resume settles it. Resume it, and the
      // resume's end is the reply the wait was for.
      const resume = { ...turn, turnUserMessageId: RESUME_MESSAGE_ID };
      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        chatId: CHAT_ID,
        providerType: 'claude',
        turnUserMessageId: RESUME_MESSAGE_ID,
        data: {
          type: 'canopy_user_prompt',
          original_text: 'Continue',
          canopy_turn_user_message_id: RESUME_MESSAGE_ID,
          canopy_resumes_interrupted_turn: true,
          canopy_resumes_user_message_id: TURN_MESSAGE_ID,
        },
      });
      await publishTurnLifecycle(electronApp, { ...resume, phase: 'start' });
      await publishTurnLifecycle(electronApp, {
        ...resume,
        phase: 'end',
        outcome: 'completed',
      });
      await card.getByRole('button', { name: 'Resume' }).click();
      await expect(card).toContainText('success', { timeout: 120_000 });
      const { grandparent } = await emitted(window, card);
      expect(grandparent).not.toBe(daemon);
      expect(grandparent).not.toBe(daemonPid(userDataDir));
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('the same workflow with a desktop notify step runs in the daemon and shows its notification', async () => {
    test.setTimeout(300_000);
    const { userDataDir } = fixtureApp('c5868-notify-');
    let electronApp;
    try {
      const launched = await launch(userDataDir);
      electronApp = launched.electronApp;
      const { window, app } = launched;
      await recordNotifications(electronApp);
      await warmUp(window, userDataDir);
      const run = await dispatch(window, CREATE_NOTIFY);
      await expect(run.runCard).toContainText('success', {
        timeout: 120_000,
      });
      const { grandparent, text } = await emitted(window, run.runCard);
      expect(grandparent).toBe(daemonPid(userDataDir));
      expect(text).toMatch(/created=\/\S+/);
      await expect
        .poll(() => shownNotifications(electronApp), { timeout: 30_000 })
        .toContainEqual({ title: 'E2E', body: 'done' });
      await app.selectWorktree(CREATED_BRANCH);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });
});
