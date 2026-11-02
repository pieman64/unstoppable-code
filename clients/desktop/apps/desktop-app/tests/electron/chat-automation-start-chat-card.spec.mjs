// CAN-4551 (7b): saving a chat automation by the chat automation pipelines
// Labs experiment.
//   1. Off (the default): saving a chat automation keeps it native.
//   2. On: saving converts it. It reopens with the Start chat summary, the
//      Library still shows one row and no pipeline row, and Run now starts
//      the same chat. Off again: saving converts it back and its workflow is
//      gone.
//   3. A workflow changed by hand opens as a notice that sends the person to
//      the pipeline editor.
//   4. A D4 scheduled send keeps the form it had.
//
// Offline: the staged fake Codex app-server answers at once; no network.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { closeFixture, createFixture } from './codexPipelineRuntime.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedCoworkWorkspace,
  seedStoredPipeline,
  seedWorktreeChat,
} from './seeders/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  readFileSync(
    path.join(here, 'fixtures', 'converted-chat-automations.json'),
    'utf8',
  ),
);
const COWORK_ID = 'automation-cowork';
const ACTIVITY_ID = 'cowork-digest';
const EXPERIMENT_ID = 'chat-automation-pipelines';

function automation(id, name, action, extra = {}) {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2099-06-01T15:00:00.000Z',
      timezone: 'local',
    },
    action,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    failureCount: 0,
    ...extra,
  };
}

function seedCowork(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_ID,
    name: 'Team notes',
    collapsed: false,
  });
  mkdirSync(path.join(userDataDir, 'workspaces', COWORK_ID, 'home'), {
    recursive: true,
  });
  return userDataDir;
}

function storedActivity(userDataDir, id) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  ).activities.find((activity) => activity.id === id);
}

function readRun(userDataDir, activityId) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  ).recentRuns?.find((run) => run.activityId === activityId);
}

function userPipelineExists(userDataDir, pipelineId) {
  const dir = path.join(userDataDir, 'pipelines');
  return (
    existsSync(dir) &&
    readdirSync(dir, { recursive: true }).some((name) =>
      String(name).startsWith(pipelineId),
    )
  );
}

async function setExperiment(window, enabled) {
  await window.evaluate(
    async ({ experimentId, value }) =>
      window.api.experiments.setChoice({ experimentId, enabled: value }),
    { experimentId: EXPERIMENT_ID, value: enabled },
  );
  await expect
    .poll(async () =>
      window.evaluate(
        async (experimentId) =>
          (await window.api.experiments.getSnapshot()).experiments.find(
            (entry) => entry.id === experimentId,
          )?.enabled,
        EXPERIMENT_ID,
      ),
    )
    .toBe(enabled);
}

/** Opens the automation's Definition, renames it and saves. */
async function renameAndSave(app, window, activityId, name) {
  await app.openAutomationsPage();
  await app.openWorkflowsLibraryRow(
    app.workflowsLibraryAutomationRow(activityId),
  );
  const shell = window.getByTestId('workflow-edit-shell');
  await expect(shell).toHaveAttribute('data-kind', 'automation');
  await shell.getByTestId('automations-form-name').fill(name);
  await saveWorkflowEdit(window);
  await expect(shell.getByTestId('automations-form-error')).toHaveCount(0);
  return shell;
}

async function launch(userDataDir, env) {
  const { electronApp } = await launchCanopy({ userDataDir, env });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  return { electronApp, window, app };
}

test.describe.configure({ mode: 'serial' });

test('saving keeps a chat automation native while the experiment is off', async () => {
  const userDataDir = seedCowork('can-4551-off-');
  const { activity } = CASES.cowork;
  seedAutomations({
    userDataDir,
    activities: [automation(ACTIVITY_ID, activity.name, activity.action)],
  });
  const { electronApp, window, app } = await launch(userDataDir);
  try {
    const shell = await renameAndSave(app, window, ACTIVITY_ID, 'Notes digest');
    await expect(shell.getByTestId('start-chat-summary')).toHaveCount(0);
    expect(storedActivity(userDataDir, ACTIVITY_ID)).toMatchObject({
      name: 'Notes digest',
      action: activity.action,
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('saving converts a chat automation while the experiment is on, and back while it is off', async () => {
  test.setTimeout(240_000);
  const userDataDir = seedCowork('can-4551-on-');
  const { activity } = CASES.cowork;
  seedAutomations({
    userDataDir,
    activities: [automation(ACTIVITY_ID, activity.name, activity.action)],
  });
  const fixture = createFixture('completed', 'Done: nothing else to report.');
  const { electronApp, window, app } = await launch(userDataDir, fixture.env);
  try {
    await setExperiment(window, true);
    const shell = await renameAndSave(app, window, ACTIVITY_ID, 'Notes digest');

    const converted = storedActivity(userDataDir, ACTIVITY_ID);
    expect(converted.action).toMatchObject({
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineSource: 'user',
    });
    const pipelineId = converted.action.pipelineId;
    // The automation reopens as its chat, under the Start chat summary.
    await expect(
      shell.getByTestId('start-chat-summary-destination'),
    ).toHaveText('Start chat in Team notes');
    await expect(shell.getByTestId('start-chat-summary-steps')).toContainText(
      'Wait for the reply',
    );
    await expect(shell.getByTestId('automations-form-name')).toHaveValue(
      'Notes digest',
    );
    await discardWorkflowEditIfOpen(electronApp);

    // One Library row: the owned workflow folds into its automation.
    await app.openAutomationsPage();
    await expect(app.workflowsLibraryAutomationRow(ACTIVITY_ID)).toContainText(
      'Start chat in Team notes',
    );
    await expect(app.workflowsLibraryPipelineRow(pipelineId)).toHaveCount(0);

    // Run now starts the chat, as the native automation did.
    await app
      .workflowsLibraryAutomationRow(ACTIVITY_ID)
      .getByTestId('workflows-library-run')
      .click();
    await expect
      .poll(
        () => {
          const run = readRun(userDataDir, ACTIVITY_ID);
          return run?.status === 'success' && run.result?.standaloneChatId;
        },
        { timeout: 90_000 },
      )
      .toBeTruthy();

    // Off again: the next save converts it back.
    await setExperiment(window, false);
    const reopened = await renameAndSave(
      app,
      window,
      ACTIVITY_ID,
      'Notes digest again',
    );
    await expect(reopened.getByTestId('start-chat-summary')).toHaveCount(0);
    expect(storedActivity(userDataDir, ACTIVITY_ID)).toMatchObject({
      name: 'Notes digest again',
      action: activity.action,
    });
    await expect
      .poll(() => userPipelineExists(userDataDir, pipelineId))
      .toBe(false);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a workflow changed by hand opens as a notice to edit it there', async () => {
  const userDataDir = seedCowork('can-4551-edited-');
  const { activity, pipeline, inputs } = CASES.cowork;
  const pipelineId = 'owned-edited';
  const edited = {
    ...pipeline,
    jobs: {
      chat: {
        ...pipeline.jobs.chat,
        steps: [...pipeline.jobs.chat.steps, { id: 'extra', run: 'true' }],
      },
    },
  };
  seedStoredPipeline({
    userDataDir,
    id: pipelineId,
    name: pipeline.name,
    yaml: JSON.stringify({ pipeline: edited }),
  });
  writeFileSync(
    path.join(userDataDir, 'pipeline-local-metadata.json'),
    JSON.stringify({
      version: 1,
      entries: {
        [`stored:user:${pipelineId}`]: {
          owner: 'personal',
          ownerAutomationId: ACTIVITY_ID,
        },
      },
    }),
  );
  seedAutomations({
    userDataDir,
    activities: [
      automation(
        ACTIVITY_ID,
        activity.name,
        {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId,
          pipelineSource: 'user',
          pipelineName: pipeline.name,
          inputs,
        },
        { executionContext: 'personal' },
      ),
    ],
  });
  const { electronApp, window, app } = await launch(userDataDir);
  try {
    await app.openAutomationsPage();
    await expect(app.workflowsLibraryPipelineRow(pipelineId)).toHaveCount(0);
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(ACTIVITY_ID),
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(
      shell.getByTestId('start-chat-summary-hand-edited'),
    ).toContainText('Its workflow was changed by hand, so you edit it there.');
    await shell.getByTestId('start-chat-summary-open-workflow').click();
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(shell.getByTestId('pipeline-editor-owned-by')).toContainText(
      activity.name,
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a D4 scheduled send keeps its form while the experiment is on', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-d4-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: 'session-chat',
    tabs: [{ id: 'session-chat', title: 'Review', messages: [] }],
  });
  const { activity } = CASES.session;
  seedAutomations({
    userDataDir,
    activities: [
      automation('scheduled-send', 'Scheduled send', activity.action, {
        agentScheduledSend: {
          version: 1,
          agentSent: {
            sender: {
              kind: 'project',
              projectType: 'code',
              projectId: 'source-project',
              taskId: 'source-task',
              chatId: 'source-chat',
            },
            chatTitle: 'Origin',
            projectLabel: 'Source',
          },
          provenance: {
            version: 1,
            capturedAt: '2026-10-17T00:00:00.000Z',
            acceptedInputId: 'capture-id',
            sender: {
              kind: 'project',
              projectType: 'code',
              projectId: 'source-project',
              taskId: 'source-task',
              chatId: 'source-chat',
            },
            owner: { kind: 'personal' },
          },
        },
      }),
    ],
  });
  const { electronApp, window, app } = await launch(userDataDir);
  try {
    await setExperiment(window, true);
    const shell = await renameAndSave(
      app,
      window,
      'scheduled-send',
      'Scheduled send renamed',
    );
    await expect(shell.getByTestId('start-chat-summary')).toHaveCount(0);
    // Still the native send (the form records how the prompt was typed).
    expect(storedActivity(userDataDir, 'scheduled-send').action).toMatchObject(
      activity.action,
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
