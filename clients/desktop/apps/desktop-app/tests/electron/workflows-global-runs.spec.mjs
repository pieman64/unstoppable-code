// CAN-4542: Workflows' Run opens without a selected task and starts a global
// pipeline with no project. An input-less run still stops on the owner step,
// a pipeline that runs either way offers Run in, and the run lands in Runs as
// No project.
//
// Deterministic and offline: seeded pipelines and workspaces, no cloud
// account (so the owner is the fixed Personal value), no live agents.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const LIBRARY = 'workflows-library';
const GLOBAL_ID = 'global-digest';
const GLOBAL_NAME = 'Global digest';
const EITHER_ID = 'either-digest';
const EITHER_NAME = 'Either digest';
const TASK_ONLY_ID = 'task-digest';
const TASK_ONLY_NAME = 'Task digest';

function pipelineYaml(name, scope) {
  return [
    `name: ${name}`,
    'on: dispatch',
    `scope: ${scope}`,
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo digest',
    '',
  ].join('\n');
}

function seedGlobalPipelines({
  withWorkspace = false,
  withTaskOnly = false,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-workflows-global-'),
  );
  seedStoredPipeline({
    userDataDir,
    id: GLOBAL_ID,
    name: GLOBAL_NAME,
    yaml: pipelineYaml(GLOBAL_NAME, 'global'),
  });
  seedStoredPipeline({
    userDataDir,
    id: EITHER_ID,
    name: EITHER_NAME,
    yaml: pipelineYaml(EITHER_NAME, '[global, worktree]'),
  });
  if (withTaskOnly)
    seedStoredPipeline({
      userDataDir,
      id: TASK_ONLY_ID,
      name: TASK_ONLY_NAME,
      yaml: pipelineYaml(TASK_ONLY_NAME, 'worktree'),
    });
  if (withWorkspace)
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  return userDataDir;
}

test.describe('Workflows global runs', () => {
  test('Run with no task asks for the owner of an input-less pipeline and lists the run as No project', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedGlobalPipelines();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openWorkflowsTab(LIBRARY);

      await app
        .workflowsLibraryPipelineRow(GLOBAL_ID)
        .getByTestId('workflows-library-run')
        .click();
      const modal = window.getByTestId('pipeline-trigger-modal');
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Run pipeline');
      await expect(
        window.getByText(
          'Open a worktree or chat first, then run a pipeline in it.',
        ),
      ).toHaveCount(0);

      // Only what runs with no project is listed; nothing runs on Continue.
      const selector = modal.getByTestId('pipeline-trigger-modal-selector');
      await expect(selector.getByRole('button')).toHaveCount(2);
      const run = modal.getByTestId('pipeline-trigger-modal-run');
      await expect(run).toHaveText('Continue');
      await run.click();

      const fields = modal.getByTestId('pipeline-run-context-fields');
      await expect(fields).toBeVisible();
      // A global-only pipeline has no Run in choice.
      await expect(modal.getByTestId('pipeline-run-location')).toHaveCount(0);
      await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveText(
        'Personal',
      );
      await expect(fields).toContainText(
        "This run appears in the owner's Runs list.",
      );
      await expect(
        modal.getByTestId('pipeline-trigger-modal-watcher-toggle'),
      ).toHaveCount(0);

      await expect(run).toHaveText('Run');
      await run.click();
      await expect(modal).toHaveCount(0);
      await expect(window.getByText('Pipeline started.')).toBeVisible();

      await app.openWorkflowsTab('runs');
      const row = window
        .getByTestId('workflows-run-row')
        .filter({ hasText: GLOBAL_NAME });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('No project');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Run with no task stays off and says why for a pipeline that only runs in a task', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedGlobalPipelines({ withTaskOnly: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openWorkflowsTab(LIBRARY);

      await app
        .workflowsLibraryPipelineRow(TASK_ONLY_ID)
        .getByTestId('workflows-library-run')
        .click();
      const modal = window.getByTestId('pipeline-trigger-modal');
      await expect(modal).toBeVisible();

      // Nothing in the dialog can run it, so Run is off and says why instead
      // of doing nothing.
      const run = modal.getByTestId('pipeline-trigger-modal-run');
      await expect(run).toHaveText('Run');
      await expect(run).toBeDisabled();
      await expect(
        modal.getByTestId('pipeline-trigger-modal-run-blocked'),
      ).toHaveText('Open a compatible task to run this pipeline there.');
      await expect(window.getByText('Pipeline started.')).toHaveCount(0);

      await modal.getByTestId('pipeline-trigger-modal-cancel').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a pipeline that runs either way defaults to No project and can run in the current task', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedGlobalPipelines({ withWorkspace: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.selectWorktree('demo-main');
      await app.openWorkflowsTab(LIBRARY);

      await app
        .workflowsLibraryPipelineRow(EITHER_ID)
        .getByTestId('workflows-library-run')
        .click();
      const modal = window.getByTestId('pipeline-trigger-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('pipeline-trigger-modal-run').click();

      const location = modal.getByTestId('pipeline-run-location');
      await expect(location).toBeVisible();
      await expect(
        modal.getByTestId('pipeline-run-location-global'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveText(
        'Personal',
      );

      // The current task takes no owner: its project decides.
      await modal.getByTestId('pipeline-run-location-current-task').click();
      await expect(
        modal.getByTestId('pipeline-run-location-current-task'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveCount(
        0,
      );

      // Back to No project restores the owner without stale task state.
      await modal.getByTestId('pipeline-run-location-global').click();
      await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveText(
        'Personal',
      );
      await modal.getByTestId('pipeline-trigger-modal-cancel').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
