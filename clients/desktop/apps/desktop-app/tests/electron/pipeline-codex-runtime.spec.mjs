import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  openWorkspaceAndRun,
  pipelineInitialTurnRequests,
  pipelineTurnRequests,
  pipelineYaml,
  conversationRequests,
  protocolRequests,
  seedPreferences,
  threadModelsByThreadId,
  WORKTREE_BRANCH,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { showPipelineJobList } from './pipelineUi.mjs';
import { toggleHomePipelineMode } from './homeComposerMenu.mjs';

// Live output streaming for these runs is covered — with its before/after
// live-streaming behavior — by `codex-pipeline-streaming.spec.mjs`.

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `pipeline-retry-ui-state-${Date.now()}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor UI state')),
          5_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

test.describe('in-process Codex pipeline runtime', () => {
  for (const stopMode of ['quit', 'crash']) {
    test(`recovers an active pipeline after ${stopMode} and resumes the same provider thread`, async () => {
      test.setTimeout(180_000);
      const name = 'E2E Shutdown Recovery';
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-shutdown-recovery-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedPreferences(userDataDir);
      seedStoredPipeline({
        userDataDir,
        id: 'shutdown-recovery',
        name,
        yaml: pipelineYaml(name),
      });
      const fixture = createFixture('staged');
      fixture.env.CANOPY_E2E_CODEX_UNICODE_RESUME = 'true';
      let { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });
      try {
        const window = await electronApp.firstWindow();
        const card = await openWorkspaceAndRun(window, name);
        await expect
          .poll(() => pipelineTurnRequests(fixture.logPath).length)
          .toBe(1);
        await expect(card).toContainText('running');
        await expect
          .poll(() =>
            readFileSync(fixture.logPath, 'utf8').includes(
              'E2E_CODEX_STREAM_007',
            ),
          )
          .toBe(true);
        const threadId = pipelineTurnRequests(fixture.logPath)[0].params
          .threadId;
        if (stopMode === 'crash') {
          const pid = await electronApp.evaluate(() => process.pid);
          process.kill(pid, 'SIGKILL');
          await closeCanopy(electronApp, userDataDir, {
            keepUserData: true,
          }).catch(() => undefined);
        } else {
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        }
        const executionsDir = path.join(userDataDir, 'pipeline-executions');
        const state = JSON.parse(
          readFileSync(
            path.join(
              executionsDir,
              readdirSync(executionsDir).find((entry) =>
                entry.endsWith('.json'),
              ),
            ),
            'utf8',
          ),
        );
        expect(state.status).toBe(stopMode === 'crash' ? 'running' : 'paused');
        if (stopMode === 'quit')
          expect(state.jobs.verify.steps.codex.agent_recovery.session_id).toBe(
            threadId,
          );
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: { ...fixture.env, CANOPY_E2E_CODEX_MODE: 'normal' },
        }));
        const restartedWindow = await electronApp.firstWindow();
        const app = new CanopyAppDriver(restartedWindow);
        await app.waitForShell();
        await app.openUsagePage();
        // The Usage page's one interrupted-sessions notice opens the same
        // review as Home's Continue row, which lists interrupted pipelines too.
        await restartedWindow
          .getByTestId('usage-interrupted-sessions-resume')
          .click();
        const modal = restartedWindow.getByTestId('usage-limit-resume-modal');
        await expect(modal).toContainText(name);
        await expect(modal).toContainText('Application stopped');
        await restartedWindow.getByTestId('usage-limit-resume-confirm').click();
        await expect(modal).toBeHidden();
        await expect
          .poll(() =>
            protocolRequests(fixture.logPath).some(
              (request) =>
                request.method === 'thread/resume' &&
                request.params.threadId === threadId,
            ),
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              JSON.parse(
                readFileSync(
                  path.join(executionsDir, `${state.id}.json`),
                  'utf8',
                ),
              ).status,
            { timeout: 30_000 },
          )
          .toBe('success');
      } finally {
        await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }

  test('contains a broken worker input pipe and starts a subsequent run', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Pipe Recovery';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-pipe-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-pipe',
      name,
      yaml: pipelineYaml(name),
    });
    const fixture = createFixture('normal', 'recovered after pipe failure');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      const window = await electronApp.firstWindow();
      await electronApp.evaluate((_, faultPath) => {
        const fs = process.getBuiltinModule('fs');
        process.on('uncaughtExceptionMonitor', (error) => {
          fs.appendFileSync(faultPath, `${error.stack}\n`);
        });
        const cp = process.getBuiltinModule('child_process');
        const spawn = cp.spawn;
        let injected = false;
        cp.spawn = function (...args) {
          const child = spawn(...args);
          if (!args[1]?.includes('app-server') || !child.stdin) return child;
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = function (chunk, ...rest) {
            if (
              !injected &&
              String(chunk).includes('"method":"turn/start"') &&
              String(chunk).includes(
                'Exercise the in-process Codex pipeline runtime.',
              )
            ) {
              injected = true;
              fs.appendFileSync(faultPath, 'Injected Codex stdin EOF\n');
              cp.spawn = spawn;
              setImmediate(() =>
                child.stdin.destroy(
                  Object.assign(new Error('write EOF'), {
                    code: 'EOF',
                    syscall: 'write',
                  }),
                ),
              );
              return true;
            }
            return write(chunk, ...rest);
          };
          return child;
        };
      }, testInfo.outputPath('pipe-fault.log'));
      const failed = await openWorkspaceAndRun(window, name);
      await expect(failed).toContainText('failed', { timeout: 60_000 });
      const recovered = await openWorkspaceAndRun(window, name);
      await expect(recovered).toContainText('success', { timeout: 60_000 });
      expect(readFileSync(testInfo.outputPath('pipe-fault.log'), 'utf8')).toBe(
        'Injected Codex stdin EOF\n',
      );
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('retries structured output on one fast-mode thread and completes in the UI', async () => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Structured Retry';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-codex-structured-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-structured-retry',
      name,
      yaml: pipelineYaml(name, { fastMode: true, structured: true }),
    });
    const fixture = createFixture(
      'structured-retry',
      '{"summary":"retry succeeded"}',
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const card = await openWorkspaceAndRun(window, name);
      await expect(card).toContainText('success', { timeout: 60_000 });

      await expect
        .poll(() => pipelineTurnRequests(fixture.logPath).length, {
          timeout: 30_000,
        })
        .toBe(2);
      const requests = protocolRequests(fixture.logPath);
      const start = requests.find(
        (request) =>
          request.method === 'thread/start' &&
          request.params?.serviceTier === 'priority',
      );
      expect(start?.params).toHaveProperty('selectedCapabilityRoots', []);
      expect(
        requests.find(
          (request) =>
            request.method === 'thread/start' &&
            request.params?.serviceTier === 'priority',
        )?.params?.serviceTier,
      ).toBe('priority');
      const turns = pipelineTurnRequests(fixture.logPath);
      expect(turns[0]?.params?.outputSchema).toMatchObject({
        type: 'object',
      });
      expect(JSON.stringify(turns[1]?.params?.input)).toContain(
        'Your previous response failed JSON Schema validation.',
      );
      expect(
        requests.some((request) => request.method === 'thread/unsubscribe'),
      ).toBe(true);
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('repairs an incomplete capability root before a second pipeline run', async () => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Capability Recovery';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-codex-capability-recovery-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-capability-recovery',
      name,
      yaml: pipelineYaml(name, { capabilitySkill: 'canopy-config' }),
    });
    const fixture = createFixture('normal');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const firstCard = await openWorkspaceAndRun(window, name);
      await expect(firstCard).toContainText('success', { timeout: 60_000 });
      await expect
        .poll(() => pipelineInitialTurnRequests(fixture.logPath).length, {
          timeout: 30_000,
        })
        .toBe(1);

      const firstStart = protocolRequests(fixture.logPath).find(
        (request) =>
          request.method === 'thread/start' &&
          request.params?.selectedCapabilityRoots?.length > 0,
      );
      expect(firstStart?.params?.selectedCapabilityRoots).toHaveLength(1);
      const rootUrl =
        firstStart?.params?.selectedCapabilityRoots?.[0]?.location?.path;
      expect(rootUrl).toEqual(expect.stringMatching(/^file:/));
      const rootPath = fileURLToPath(rootUrl);
      const metadataPath = path.join(rootPath, '.capability-root.json');
      chmodSync(rootPath, 0o700);
      rmSync(metadataPath);
      chmodSync(rootPath, 0o500);

      const secondCard = await openWorkspaceAndRun(window, name);
      await expect
        .poll(() => pipelineInitialTurnRequests(fixture.logPath).length, {
          timeout: 60_000,
        })
        .toBe(2);
      await expect(secondCard).toContainText('success', { timeout: 60_000 });
      expect(existsSync(metadataPath)).toBe(true);
      expect(
        readdirSync(path.dirname(rootPath)).filter((entry) =>
          entry.startsWith('.incomplete-'),
        ),
      ).toEqual([]);

      const executionFiles = readdirSync(
        path.join(userDataDir, 'pipeline-executions'),
      ).filter((entry) => entry.endsWith('.json'));
      expect(executionFiles).toHaveLength(2);
      expect(
        executionFiles.map(
          (entry) =>
            JSON.parse(
              readFileSync(
                path.join(userDataDir, 'pipeline-executions', entry),
                'utf8',
              ),
            ).status,
        ),
      ).toEqual(['success', 'success']);
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('interrupts a hung turn at the configured pipeline timeout', async () => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Turn Timeout';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-codex-timeout-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-timeout',
      name,
      yaml: pipelineYaml(name, { timeoutMinutes: 0.002 }),
    });
    const fixture = createFixture('hang');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const card = await openWorkspaceAndRun(window, name);
      await expect
        .poll(
          () =>
            protocolRequests(fixture.logPath).some(
              (request) => request.method === 'turn/interrupt',
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect(card).toContainText('failure', { timeout: 30_000 });

      const executionFiles = readdirSync(
        path.join(userDataDir, 'pipeline-executions'),
      ).filter((entry) => entry.endsWith('.json'));
      expect(executionFiles).toHaveLength(1);
      const state = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'pipeline-executions', executionFiles[0]),
          'utf8',
        ),
      );
      expect(state.jobs?.verify?.steps?.codex?.status).toBe('failure');
      expect(state.jobs?.verify?.steps?.codex?.error).toBe(
        'Codex workflow turn was interrupted before completion',
      );
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('routes the bundled task-plan summary through host Codex and publishes the plan', async () => {
    test.setTimeout(240_000);
    // Regression coverage for the bundled `Create Task Implementation Plan`
    // preset: its `summary.summarize` step used to declare no model, so
    // `maybeRunCodexPrompt` declined interception and the step fell through to
    // the packaged `builtin/agent-prompt` subprocess, which resolves a
    // modelless step to the Claude harness regardless of what the user picked.
    // The step now declares `model: ${{ inputs.model }}`, so the summary is
    // intercepted by the host runtime on the SAME harness the plan was drafted
    // with, and the `summary` job is `continue_on_error: true` so a summary
    // failure degrades the run instead of sinking an already-generated plan.
    // This drives the real `task_ready` launch path against the shipped preset
    // rather than a seeded copy of the YAML.
    //
    // Editing the preset alone does NOT change what this test runs: the app
    // resolves bundled resources through the brand-rendered copy under
    // `.cache/brand/<brand>/resources`, so re-run `pnpm run build:e2e` (or
    // `pnpm run brand:prepare --all`) after touching the YAML or this spec
    // will keep passing against the previously rendered definition.
    const pipelineName = 'Create Task Implementation Plan';
    const taskText = 'Plan a billing metrics panel.';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-task-plan-summary-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    // `CANOPY_E2E_CODEX_REPLY` is a single global reply, so it must satisfy
    // both turns: the draft step needs an extractable `<proposed_plan>` block
    // for `steps.create_plan.outputs.proposed_plan_file`, and the summary
    // step's `text_response_file` is read verbatim by `prepare_report`.
    const fixture = createFixture(
      'normal',
      [
        '<proposed_plan>',
        '# E2E Implementation Plan',
        '## Scope',
        'Exercise bundled task planning.',
        '</proposed_plan>',
      ].join('\n'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await toggleHomePipelineMode(window, home);
      // Target the seeded worktree so the run does not depend on live
      // worktree provisioning.
      await home.getByTestId('home-branch-picker-button').click();
      await window
        .getByTestId(`home-branch-picker-worktree-${WORKTREE_BRANCH}`)
        .click();
      await home.getByTestId('home-composer-editor').fill(taskText);
      await home.getByTestId('home-send-button').click();

      const modal = window.getByTestId('pipeline-trigger-modal-body');
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: pipelineName }).first().click();
      const runButton = window.getByTestId('pipeline-trigger-modal-run');
      const initialRunLabel = (await runButton.textContent())?.trim();
      await runButton.click();
      if (initialRunLabel === 'Continue') {
        await expect(runButton).toHaveText('Run');
        await runButton.click();
      }

      const card = window
        .locator('[data-testid^="pipeline-run-card-"]')
        .filter({ hasText: pipelineName })
        .first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText('success', { timeout: 150_000 });

      // Both agent steps executed through the host Codex runtime (the fake
      // app-server only sees traffic the in-process runner produced), and the
      // summary ran on the same model the plan was drafted with rather than a
      // hard-pinned provider.
      const turnStarts = conversationRequests(fixture.logPath).filter(
        (request) => request.method === 'turn/start',
      );
      const draftTurns = turnStarts.filter((request) =>
        JSON.stringify(request.params?.input).includes(taskText),
      );
      const summaryTurns = turnStarts.filter((request) =>
        JSON.stringify(request.params?.input).includes(
          'Summarize the generated implementation plan',
        ),
      );
      expect(draftTurns).toHaveLength(1);
      expect(summaryTurns).toHaveLength(1);
      // The runner carries the model on `thread/start`, so resolve each turn's
      // thread back to the model that opened it.
      // `$default-codex` is the `inputs.model` default, and both the draft and
      // the summary declare `${{ inputs.model }}`, so both threads open on it.
      const threadModels = threadModelsByThreadId(fixture.logPath);
      expect(threadModels.get(draftTurns[0]?.params?.threadId)).toBe(
        'gpt-6.1-sol',
      );
      expect(threadModels.get(summaryTurns[0]?.params?.threadId)).toBe(
        'gpt-6.1-sol',
      );

      const executionsDir = path.join(userDataDir, 'pipeline-executions');
      const executionFiles = readdirSync(executionsDir).filter((entry) =>
        entry.endsWith('.json'),
      );
      expect(executionFiles).toHaveLength(1);
      const state = JSON.parse(
        readFileSync(path.join(executionsDir, executionFiles[0]), 'utf8'),
      );
      expect(state.status).toBe('success');
      expect(state.jobs.plan.conclusion).toBe('success');
      expect(state.jobs.summary.conclusion).toBe('success');
      expect(state.jobs.summary.steps.publish_report.status).toBe('success');

      // The plan is published to the allocated `task_ready.plan_path`.
      const planPath = state.jobs.plan.outputs.plan_path;
      expect(planPath).toBe(state.event_data.task_ready.plan_path);
      expect(readFileSync(planPath, 'utf8')).toContain(
        '# E2E Implementation Plan',
      );
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('renders a recoverable Codex usage-limit failure as a paused run', async () => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Recoverable Failure';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-codex-recovery-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-recovery',
      name,
      yaml: pipelineYaml(name),
    });
    const fixture = createFixture('usage-limit');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const card = await openWorkspaceAndRun(window, name);
      await expect(card).toContainText('paused', { timeout: 60_000 });
      await card.click({ position: { x: 10, y: 10 } });
      await showPipelineJobList(window, { timeout: 15_000 });
      await expect(window.getByTestId('pause-formless-resume')).toBeEnabled();

      const executionFiles = readdirSync(
        path.join(userDataDir, 'pipeline-executions'),
      ).filter((entry) => entry.endsWith('.json'));
      expect(executionFiles).toHaveLength(1);
      const state = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'pipeline-executions', executionFiles[0]),
          'utf8',
        ),
      );
      expect(state.status_reasons?.[0]?.provider).toBe('codex');
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });
});

test('capacity recovery shows the countdown and continues the same pipeline agent', async () => {
  test.setTimeout(150_000);
  const name = 'E2E Capacity Retry';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-capacity-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedStoredPipeline({
    userDataDir,
    id: 'capacity-retry',
    name,
    yaml: pipelineYaml(name),
  });
  const fixture = createFixture('transient-capacity', 'Pipeline recovered.');
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('paused', { timeout: 25_000 });
    await card.click();
    const countdown = window.getByTestId('pipeline-transient-retry-status');
    await expect(countdown).toContainText(/Retrying in 0:[0-3]\d/);
    await expect(countdown).toContainText('attempt 1 of 10');
    await expect
      .poll(async () => {
        const response = await getAdvisorUiState(electronApp);
        return response.uiState?.snapshot.activePipelineRun?.transientRetry;
      })
      .toMatchObject({
        attempt: 1,
        maxAttempts: 10,
        exhausted: false,
      });
    const before = await countdown.textContent();
    await expect.poll(() => countdown.textContent()).not.toBe(before);
    await expect
      .poll(() => pipelineTurnRequests(fixture.logPath).length, {
        timeout: 45_000,
      })
      .toBe(2);
    const turns = pipelineTurnRequests(fixture.logPath);
    expect(turns[1].params.threadId).toBe(turns[0].params.threadId);
    expect(turns[1].params.model).toBe(turns[0].params.model);
    await expect(countdown).toBeHidden({ timeout: 15_000 });
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});
