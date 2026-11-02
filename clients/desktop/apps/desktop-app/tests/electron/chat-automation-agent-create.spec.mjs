// CAN-4551 (7c): an automation the Orchestrator creates while the chat
// automation pipelines Labs experiment is on is stored converted, with the
// agent's marker on the automation and on the workflow it owns; the Library
// shows one row, and Run now starts the Orchestrator chat.
//
// Real composer → bundled Claude → HTTP model fixture → real injected tool
// handlers → persisted state; offline.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/registerScenario.mjs';

const EXPERIMENT_ID = 'chat-automation-pipelines';
const NAME = 'Morning email';
const SCHEDULE = {
  kind: 'one_time',
  runAt: '2099-01-01T09:00:00.000Z',
  timezone: 'local',
};

function readJson(userDataDir, file) {
  return JSON.parse(readFileSync(path.join(userDataDir, file), 'utf8'));
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

test('an automation the Orchestrator creates is stored as its own workflow, marked as the agent’s', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-agent-'));
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'claude-sonnet-4-6',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    },
  });
  const marker = 'Canopy-CAGENTCREATE';
  const runMarker = 'Canopy-CAGENTRUN';
  const reply = 'Scheduled the morning email check.';
  const prompt = `[${runMarker}] Check my email.`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: {
                action: {
                  type: 'automation.create',
                  input: {
                    name: NAME,
                    schedule: SCHEDULE,
                    action: { type: 'app_advisor_prompt', prompt },
                  },
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: reply, stopReason: 'end_turn' },
      ],
    },
  });
  // The chat each run starts.
  await registerScenario(DEFAULT_MOCK_BASE_URL, runMarker, {
    llm: { steps: [{ text: 'Inbox checked.', stopReason: 'end_turn' }] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await setExperiment(window, true);
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const panel = advisor.getByTestId('app-advisor-workspace-surface');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Check my email every morning.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(reply, { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });

    const [activity] = readJson(userDataDir, 'automations.json').activities;
    expect(activity).toMatchObject({
      name: NAME,
      schedule: SCHEDULE,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineSource: 'user',
      },
    });
    expect(activity.agentAuthor?.chat?.projectId).toBe('app-advisor');
    const pipelineId = activity.action.pipelineId;
    const metadata = readJson(userDataDir, 'pipeline-local-metadata.json')
      .entries[`stored:user:${pipelineId}`];
    expect(metadata).toMatchObject({
      ownerAutomationId: activity.id,
      agentAuthor: activity.agentAuthor,
    });

    // One Library row: the owned workflow folds into its automation.
    await app.openAutomationsPage();
    const row = app.workflowsLibraryAutomationRow(activity.id);
    await expect(row).toContainText(NAME);
    await expect(app.workflowsLibraryPipelineRow(pipelineId)).toHaveCount(0);

    // Run now starts the Orchestrator chat through the workflow.
    await row.getByTestId('workflows-library-run').click();
    await expect
      .poll(
        () =>
          readJson(userDataDir, 'automations.json').recentRuns?.find(
            (run) => run.activityId === activity.id,
          )?.status,
        { timeout: 90_000 },
      )
      .toBe('success');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
