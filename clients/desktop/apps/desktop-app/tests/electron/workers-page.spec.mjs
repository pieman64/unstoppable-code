import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const runningWorker = {
  workerId: 'e2e-running-worker',
  kind: 'commit_message_generation',
  label: 'Commit Message',
  status: 'running',
  terminalId: 'e2e-terminal-running-worker',
  startedAt: Date.now() - 60_000,
  projectId: 'project-alpha',
  worktreeId: 'worktree-main',
  chatId: 'chat-thread',
  linkTarget: {
    page: 'main',
    kind: 'worktree-chat',
    projectId: 'project-alpha',
    worktreeId: 'worktree-main',
    chatId: 'chat-thread',
  },
};

const queuedWorker = {
  workerId: 'e2e-queued-worker',
  kind: 'pipeline_agent_prompt',
  label: 'Pipeline Step',
  status: 'queued',
  terminalId: 'e2e-terminal-queued-worker',
  startedAt: Date.now() - 30_000,
  projectId: 'project-alpha',
  worktreeId: 'worktree-main',
  pipelineExecutionId: 'pipeline-run',
  stepId: 'step-agent',
  linkTarget: {
    page: 'pipelines',
    kind: 'pipeline-execution',
    projectId: 'project-alpha',
    worktreeId: 'worktree-main',
    pipelineExecutionId: 'pipeline-run',
  },
};

async function waitForWorkerE2eControls(window) {
  await expect
    .poll(
      () =>
        window.evaluate(() =>
          Boolean(window.__CANOPY_E2E_WORKERS__?.setWorkers),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function installWorkerActionSpies(window) {
  await window.evaluate(() => {
    window.__CANOPY_E2E_WORKER_ACTIONS__ = {
      cancel: [],
      retry: [],
    };
  });
}

async function setWorkerCards(window, workers) {
  await window.evaluate((cards) => {
    window.__CANOPY_E2E_WORKERS__.setWorkers(cards);
  }, workers);
}

async function patchWorkerCard(window, workerId, patch) {
  await window.evaluate(
    ({ id, data }) => {
      window.__CANOPY_E2E_WORKERS__.patchWorker(id, data);
    },
    { id: workerId, data: patch },
  );
}

function seedWorkersNavPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          canopyBackgroundProcessesMode: 'terminal',
          pipelinesMode: 'terminal',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'migrations.json'),
    JSON.stringify({ version: 1, claude_worker_modes_canopy: true }, null, 2),
    'utf8',
  );
}

test('Claude Workers page links to settings and worker settings persist', async ({}, testInfo) => {
  const initialUserDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-workers-page-'),
  );
  seedWorkersNavPreferences(initialUserDataDir);
  const firstLaunch = await launchCanopy({ userDataDir: initialUserDataDir });
  let { electronApp, userDataDir } = firstLaunch;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // Claude Workers is a main-nav row in the default layout (CAN-3678). The
    // seeded terminal modes enable the nav item (workers visibility gate).
    await window.getByTestId('sidebar-nav-workers').click();
    await expect(window.getByTestId('page-workers')).toBeVisible();
    await expect(
      window.getByRole('heading', { name: 'Claude workers' }),
    ).toBeVisible();
    await expect(window.getByTestId('workers-empty-state')).toBeVisible();
    await expect(window.getByTestId('workers-empty-open-settings')).toHaveText(
      'Open Claude settings',
    );

    await waitForWorkerE2eControls(window);
    await installWorkerActionSpies(window);
    await setWorkerCards(window, [runningWorker, queuedWorker]);

    const runningCard = window.getByTestId(
      `worker-card-${runningWorker.workerId}`,
    );
    await expect(runningCard).toBeVisible();
    await expect(
      window.getByTestId(`worker-status-${runningWorker.workerId}`),
    ).toHaveText('Running');
    await expect(runningCard).toContainText(runningWorker.kind);
    await expect(runningCard).toContainText(runningWorker.projectId);
    await expect(runningCard).toContainText(runningWorker.worktreeId);
    await expect(runningCard).toContainText(runningWorker.chatId);
    await expect(
      window.getByTestId(`worker-terminal-${runningWorker.workerId}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`worker-inspect-${runningWorker.workerId}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`worker-retry-${runningWorker.workerId}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`worker-cancel-${runningWorker.workerId}`),
    ).toBeVisible();

    await window.getByTestId(`worker-retry-${runningWorker.workerId}`).click();
    await window.getByTestId(`worker-cancel-${runningWorker.workerId}`).click();
    await expect
      .poll(() =>
        window.evaluate(() => window.__CANOPY_E2E_WORKER_ACTIONS__.retry),
      )
      .toEqual([runningWorker.workerId]);
    await expect
      .poll(() =>
        window.evaluate(() => window.__CANOPY_E2E_WORKER_ACTIONS__.cancel),
      )
      .toEqual([runningWorker.workerId]);

    await expect(
      window.getByTestId(`worker-queued-indicator-${queuedWorker.workerId}`),
    ).toBeVisible();

    await patchWorkerCard(window, runningWorker.workerId, {
      status: 'success',
    });
    await expect(
      window.getByTestId(`worker-status-${runningWorker.workerId}`),
    ).toHaveText('Success');
    await expect(
      window.getByTestId(`worker-retry-${runningWorker.workerId}`),
    ).toBeHidden();
    await expect(
      window.getByTestId(`worker-cancel-${runningWorker.workerId}`),
    ).toBeHidden();

    await setWorkerCards(window, []);
    await expect(window.getByTestId('workers-empty-state')).toBeVisible();

    await window.getByTestId('workers-empty-open-settings').click();
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect(window.getByTestId('settings-tab-claude')).toBeVisible();
    await expect(
      window.getByTestId('settings-claude-workers-section'),
    ).toBeVisible();

    await window
      .getByTestId('settings-claude-background-processes-mode-canopy')
      .click();
    await expect(
      window.getByTestId('settings-claude-background-processes-mode-canopy'),
    ).toBeChecked();

    await window.getByTestId('settings-claude-pipelines-mode-canopy').click();
    await expect(
      window.getByTestId('settings-claude-pipelines-mode-canopy'),
    ).toBeChecked();

    const concurrency = window.getByTestId(
      'settings-claude-worker-concurrency',
    );
    await concurrency.fill('3');
    await concurrency.blur();
    await expect(concurrency).toHaveValue('3');

    await app.closeSettings();
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = null;

    const secondLaunch = await launchCanopy({ userDataDir });
    electronApp = secondLaunch.electronApp;
    const secondWindow = await electronApp.firstWindow();
    const secondApp = new CanopyAppDriver(secondWindow);

    await secondApp.waitForShell();
    await secondApp.openSettings();
    await secondApp.openSettingsSection('claude');
    await expect(
      secondWindow.getByTestId(
        'settings-claude-background-processes-mode-canopy',
      ),
    ).toBeChecked();
    await expect(
      secondWindow.getByTestId('settings-claude-pipelines-mode-canopy'),
    ).toBeChecked();
    await expect(
      secondWindow.getByTestId('settings-claude-worker-concurrency'),
    ).toHaveValue('3');

    await secondWindow.screenshot({
      path: testInfo.outputPath('workers-page-settings.png'),
    });
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('Claude settings disables terminal-mode options when Claude is unauthenticated', async ({}, testInfo) => {
  const scenarioKey = 'workers-page-claude-settings-unauthenticated';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'unauthenticated' },
  });

  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('claude');

    for (const testId of [
      'settings-claude-default-chat-mode-auto',
      'settings-claude-default-chat-mode-claude-code',
      'settings-claude-default-standalone-chat-mode-auto',
      'settings-claude-default-standalone-chat-mode-claude-code',
      'settings-claude-default-app-advisor-chat-mode-auto',
      'settings-claude-default-app-advisor-chat-mode-claude-code',
      'settings-claude-background-processes-mode-terminal',
      'settings-claude-pipelines-mode-terminal',
    ]) {
      await expect(window.getByTestId(testId)).toBeDisabled();
    }

    await window.screenshot({
      path: testInfo.outputPath('claude-settings-unauthenticated.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
