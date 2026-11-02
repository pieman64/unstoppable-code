// CAN-4546: the `builtin/create-project-entry` and `builtin/create-bot-entry`
// host steps create a Chats task and an App Advisor task through desktop
// main's #5721 creation path, and place each in a new sidebar group.
//
// A separate file from `pipeline-runs.spec.mjs`, which the phase 5 steps also
// extend. Deterministic and offline: seeded global pipelines, no cloud account
// (so the owner is the fixed Personal value), no provider traffic.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const LIBRARY = 'workflows-library';
const JOB = 'create';
const CHATS_PROJECT_ID = 'cowork-default';

function globalPipelineYaml(name, steps) {
  return [
    `name: ${name}`,
    'on: dispatch',
    'scope: global',
    'jobs:',
    `  ${JOB}:`,
    '    steps:',
    ...steps,
    '',
  ].join('\n');
}

/** Starts a global pipeline from Workflows with no task, as Personal. */
async function runGlobalPipeline(window, app, pipelineId) {
  await app.openWorkflowsTab(LIBRARY);
  await app
    .workflowsLibraryPipelineRow(pipelineId)
    .getByTestId('workflows-library-run')
    .click();
  const modal = window.getByTestId('pipeline-trigger-modal');
  await expect(modal).toBeVisible();
  const run = modal.getByTestId('pipeline-trigger-modal-run');
  await expect(run).toHaveText('Continue');
  await run.click();
  await expect(modal.getByTestId('pipeline-run-owner-fixed')).toHaveText(
    'Personal',
  );
  await expect(run).toHaveText('Run');
  await run.click();
  await expect(modal).toHaveCount(0);
}

/** The id of the only execution recorded for `pipelineId`. */
async function waitForExecutionId(executionsDir, pipelineId) {
  let executionId;
  await expect
    .poll(
      () => {
        if (!existsSync(executionsDir)) return undefined;
        for (const name of readdirSync(executionsDir)) {
          if (!name.endsWith('.json')) continue;
          const state = JSON.parse(
            readFileSync(path.join(executionsDir, name), 'utf8'),
          );
          if (state.pipeline_id === pipelineId) {
            executionId = state.id;
            return executionId;
          }
        }
        return undefined;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return executionId;
}

function stepReader(executionsDir, executionId) {
  const executionFile = path.join(executionsDir, `${executionId}.json`);
  return (stepId) => {
    if (!existsSync(executionFile)) return undefined;
    return JSON.parse(readFileSync(executionFile, 'utf8')).jobs?.[JOB]?.steps?.[
      stepId
    ];
  };
}

/** Every attempt journal the run's host steps wrote, wherever it is scoped. */
function readAttemptJournals(directory) {
  if (!existsSync(directory)) return [];
  const journals = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      journals.push(...readAttemptJournals(entryPath));
    } else if (entry.name === 'attempt.json') {
      journals.push(JSON.parse(readFileSync(entryPath, 'utf8')));
    }
  }
  return journals;
}

function gitWorktreeList(worktreePath) {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
}

test('builtin create-project-entry and create-bot-entry create grouped tasks through desktop main', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'pipeline-create-entry-host-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const codeWorkspace = seeded.workspaces[0];
  // A per-run suffix keeps `group_created: 'true'` deterministic even if a
  // seed ever ships a group with the same name.
  const suffix = Date.now();
  const reportsGroup = `Reports-${suffix}`;
  const reviewsGroup = `Reviews-${suffix}`;

  const createId = 'host-create-entries';
  const createName = 'Create Chats and App Advisor tasks';
  seedStoredPipeline({
    userDataDir,
    id: createId,
    name: createName,
    yaml: globalPipelineYaml(createName, [
      '      - id: project',
      '        uses: builtin/create-project-entry',
      '        with:',
      `          project_id: ${CHATS_PROJECT_ID}`,
      '          title: Nightly report',
      `          group: ${reportsGroup}`,
      '      - id: bot',
      '        uses: builtin/create-bot-entry',
      '        with:',
      `          group: ${reviewsGroup}`,
      '      - id: report',
      '        run: echo "ids ${{ steps.project.outputs.task_id }} ${{ steps.bot.outputs.chat_id }}"',
    ]),
  });
  const codeId = 'host-create-entry-code-project';
  const codeName = 'Create a task in a code project';
  seedStoredPipeline({
    userDataDir,
    id: codeId,
    name: codeName,
    yaml: globalPipelineYaml(codeName, [
      '      - id: project',
      '        uses: builtin/create-project-entry',
      '        continue_on_error: true',
      '        with:',
      `          project_id: ${codeWorkspace.id}`,
      '          title: Never created',
      '      - id: report',
      '        run: echo "result ${{ steps.project.outputs.failure_reason }}"',
    ]),
  });

  const executionsDir = path.join(userDataDir, 'pipeline-executions');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The demo seeder creates no Chats project; the app provisions Personal
    // Chats on first use, and #5721 refuses an unindexed one as not_found.
    await app.openHomeForProject(CHATS_PROJECT_ID);

    await runGlobalPipeline(window, app, createId);
    const executionId = await waitForExecutionId(executionsDir, createId);
    const readStep = stepReader(executionsDir, executionId);
    await expect
      .poll(() => readStep('report')?.status, { timeout: 90_000 })
      .toBe('success');

    const project = readStep('project').outputs;
    const bot = readStep('bot').outputs;
    const createdAndGrouped = {
      failure_reason: '',
      task_created: 'true',
      chat_created: 'true',
      grouped: 'true',
      group_created: 'true',
      not_grouped_reason: '',
    };
    expect(project).toMatchObject({
      ...createdAndGrouped,
      project_id: CHATS_PROJECT_ID,
    });
    expect(bot).toMatchObject({ ...createdAndGrouped, bot_id: 'app_advisor' });
    for (const outputs of [project, bot]) {
      expect(outputs.task_id).toBeTruthy();
      expect(outputs.task_id).toBe(outputs.chat_id);
      expect(outputs.group_id).toBeTruthy();
    }

    const logsDir = path.join(executionsDir, executionId, 'logs');
    const logs = readdirSync(logsDir)
      .map((name) => readFileSync(path.join(logsDir, name), 'utf8'))
      .join('\n');
    expect(logs).toContain(`ids ${project.task_id} ${bot.chat_id}`);

    // Each step journaled its attempt and finished it.
    const journals = readAttemptJournals(path.join(executionsDir, executionId));
    for (const taskId of [project.task_id, bot.task_id]) {
      expect(journals.filter((journal) => journal.taskId === taskId)).toEqual([
        expect.objectContaining({ phase: 'finalized', taskId }),
      ]);
    }

    // The Chats task appears inside its new group without a reload.
    const reportsBlock = window.locator(
      `[data-sidebar-item-group-id="${project.group_id}"]`,
    );
    await expect(reportsBlock).toContainText(reportsGroup);
    await expect(
      reportsBlock.getByTestId(`sidebar-work-entry-${project.task_id}`),
    ).toBeVisible();

    // The App Advisor task appears in its group, and the chat created
    // without a first message is usable.
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const advisorNav = advisor.getByTestId('app-advisor-nav');
    const reviewsBlock = advisorNav.locator(
      `[data-sidebar-item-group-id="${bot.group_id}"]`,
    );
    await expect(reviewsBlock).toContainText(reviewsGroup);
    const botEntry = reviewsBlock.getByTestId(
      `app-advisor-nav-entry-${bot.task_id}`,
    );
    await expect(botEntry).toBeVisible();
    await botEntry.click();
    const composer = advisor.locator(
      '[data-chat-composer-root] [contenteditable="true"]',
    );
    await expect(composer).toBeAttached();
    await expect(composer).toBeEditable();

    // A code project is refused before any effect: no task, no worktree.
    await window.bringToFront();
    const worktreesBefore = gitWorktreeList(codeWorkspace.worktreePath);
    const worktreeRows = window.locator('[data-testid="worktree-row"]');
    const worktreeRowCount = await worktreeRows.count();
    await runGlobalPipeline(window, app, codeId);
    const codeExecutionId = await waitForExecutionId(executionsDir, codeId);
    const readCodeStep = stepReader(executionsDir, codeExecutionId);
    await expect
      .poll(() => readCodeStep('report')?.status, { timeout: 90_000 })
      .toBe('success');
    expect(readCodeStep('project').outputs).toMatchObject({
      failure_reason: 'unsupported_action',
      task_id: '',
      chat_id: '',
      task_created: 'false',
      chat_created: 'false',
    });
    expect(gitWorktreeList(codeWorkspace.worktreePath)).toBe(worktreesBefore);
    await expect(worktreeRows).toHaveCount(worktreeRowCount);
    await expect(window.getByText('Never created')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
