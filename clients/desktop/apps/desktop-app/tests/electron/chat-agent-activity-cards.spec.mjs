import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
  seedPipelineExecution,
  seedWorkspaceApprovals,
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { injectChatEvent } from './seeders/injectChatEvent.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
  showPipelineJobList,
} from './pipelineUi.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'activity-chat';
const T = Date.parse('2026-08-04T12:00:00.000Z');

function seedPreferences(userDataDir, { coworkApproval = 'full-access' } = {}) {
  // Pre-seeding preferences.json makes this profile look like an upgrade to
  // migrateApprovalDefaultsToFullAccess (PR #2823), which would replace the
  // seeded approvalDefaults with full-access wholesale. Mark the migration as
  // already handled, the same way launchCanopy does for its own seed.
  writeJson(path.join(userDataDir, 'migrations.json'), {
    version: 1,
    approval_defaults_full_access: true,
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      defaultWorktreeProvider: 'claude',
      defaultChatProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'sonnet', thinkingLevel: 'off' },
      },
      approvalDefaults: {
        worktree: 'full-access',
        cowork: coworkApproval,
        appAdvisor: 'full-access',
      },
      mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
    },
  });
  // This fixture supplies current approval defaults explicitly. Mark the
  // compatibility migration complete so launch does not treat it as an older
  // profile whose defaults must be upgraded to Full Access.
  writeJson(path.join(userDataDir, 'migrations.json'), {
    version: 1,
    approval_defaults_full_access: true,
  });
}

async function registerSkillDispatch(marker, toolName, skillName) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: toolName,
              input: {
                action: {
                  type: 'skills.create_custom',
                  name: skillName,
                  description: `Created by ${marker}`,
                  body: 'Use this skill to verify the real dispatch path.',
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: `Created ${skillName}`, stopReason: 'end_turn' },
      ],
    },
  });
}

async function sendToolTurn(surface, marker, expectedReply) {
  const message = `[${marker}] Create the requested skill.`;
  const composer = surface.getByRole('textbox').first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(message);
  await surface.getByRole('button', { name: 'Send message' }).click();
  await expect(surface.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(surface.getByText(expectedReply).first()).toBeVisible({
    timeout: 120_000,
  });
}

// The receipt names a skill that is installed in the seeded profile (see
// seedInstalledSkill): the card checks live inventory and reports a missing
// skill as Removed instead of opening it.
const INSTALLED_SKILL_SOURCE_ID = 'custom:app';
const skillReceipt = {
  version: 1,
  kind: 'skill',
  operation: 'skills.create',
  dedupeKey: `canopy:skill:installed:${encodeURIComponent(INSTALLED_SKILL_SOURCE_ID)}:review`,
  createdAt: new Date(T).toISOString(),
  source: 'installed',
  sourceId: INSTALLED_SKILL_SOURCE_ID,
  installedName: 'review',
  name: 'Review',
  description: 'Reviews changes',
  canUpdate: true,
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: INSTALLED_SKILL_SOURCE_ID,
    skillName: 'review',
  },
};

function seedInstalledSkill(userDataDir, receipt) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    receipt.sourceId,
    receipt.installedName,
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', `description: ${receipt.description}`, '---', ''].join('\n'),
    'utf8',
  );
}

const updatedSkillReceipt = {
  ...skillReceipt,
  operation: 'skills.update',
  createdAt: new Date(T + 1_000).toISOString(),
  description: 'Reviews changes with the latest policy',
};

const runReceipt = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: 'canopy:pipeline_run:execution:activity-exec',
  createdAt: new Date(T + 10_000).toISOString(),
  executionId: 'activity-exec',
  pipelineId: 'activity-pipeline',
  pipelineName: 'Activity pipeline',
  initialStatus: 'pending',
  queuedAt: new Date(T + 10_000).toISOString(),
  startedAt: new Date(T + 11_000).toISOString(),
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'activity-exec',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  },
};

function executionReceipt(operation, executionId, pipelineName, status) {
  const timestamp = new Date(T + 40_000).toISOString();
  return {
    ...runReceipt,
    operation,
    dedupeKey: `canopy:pipeline_run:execution:${executionId}`,
    createdAt: timestamp,
    executionId,
    pipelineName,
    initialStatus: status,
    queuedAt: timestamp,
    startedAt: timestamp,
    navigationTarget: {
      ...runReceipt.navigationTarget,
      executionId,
    },
  };
}

function dispatchMessages(
  turnId,
  toolId,
  receiptOrReceipts,
  timestamp,
  completedAt,
  toolName = 'DispatchAction',
) {
  const receipts = Array.isArray(receiptOrReceipts)
    ? receiptOrReceipts
    : [receiptOrReceipts];
  return [
    {
      id: turnId,
      role: 'user',
      blocks: [{ type: 'text', text: `Dispatch ${receipts[0].kind}` }],
      timestamp,
    },
    ...receipts.flatMap((receipt, index) => {
      const receiptToolId =
        receipts.length === 1 ? toolId : `${toolId}-${index + 1}`;
      const offset = index * 2 + 1;
      return [
        {
          id: `${receiptToolId}-use`,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: receiptToolId,
              toolName,
              input: '{}',
            },
          ],
          timestamp: timestamp + offset,
        },
        {
          id: `${receiptToolId}-result`,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_result',
              toolUseId: receiptToolId,
              toolName,
              output: JSON.stringify({
                ok: true,
                result: { agentArtifacts: [receipt] },
              }),
              isError: false,
            },
          ],
          timestamp: timestamp + offset + 1,
        },
      ];
    }),
    {
      id: `${turnId}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          ...(completedAt === null
            ? { pausedAt: timestamp + 3, completedAt: null }
            : { completedAt }),
        },
      ],
      timestamp: timestamp + receipts.length * 2 + 1,
    },
  ];
}

async function injectPipelineExecutionEvent(electronApp, event) {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      throw new Error('No BrowserWindow available for the pipeline event');
    }
    // Mirror the production broadcaster: auxiliary windows may precede the
    // main renderer in Electron's global window list.
    for (const window of windows) {
      window.webContents.send('pipelines:execution-event', payload);
    }
  }, event);
}

test('renders docked, deduplicated activity cards, event-backed progress, and completed-turn rollover', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedInstalledSkill(userDataDir, skillReceipt);
  const messages = [
    ...dispatchMessages(
      'skill-turn',
      'skill-tool',
      [skillReceipt, updatedSkillReceipt],
      T,
      T + 5_000,
    ),
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Agent activity',
        messages,
      },
    ],
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'activity-run-watcher',
        label: 'Activity run watcher',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          executionId: runReceipt.executionId,
          pipelineId: runReceipt.pipelineId,
          pipelineName: runReceipt.pipelineName,
        },
        destination: {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          chatTitle: 'Agent activity',
        },
      },
    ],
  });
  const { state: pendingExecutionState } = seedPipelineExecution({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: runReceipt.executionId,
      pipelineId: runReceipt.pipelineId,
      pipelineName: runReceipt.pipelineName,
      status: 'pending',
      startedAt: runReceipt.startedAt,
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  let window;
  const rendererConsoleErrors = [];
  try {
    window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 2200, height: 1000 });
    window.on('console', (message) => {
      if (message.type() !== 'error') return;
      rendererConsoleErrors.push({
        text: message.text(),
        location: message.location(),
      });
    });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const injectTurn = async (turnId, timestamp, completedAt) => {
      await injectChatEvent(electronApp, {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        data: {
          type: 'claude_terminal_transcript_sync',
          importedEventCount: 2,
          messages: [
            {
              id: turnId,
              role: 'user',
              blocks: [{ type: 'text', text: `Continue watching ${turnId}` }],
              timestamp,
            },
            {
              id: `${turnId}-timer`,
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: timestamp,
                  ...(completedAt === null
                    ? { pausedAt: timestamp + 1_000, completedAt: null }
                    : { completedAt }),
                },
              ],
              timestamp: timestamp + 1_000,
            },
          ],
        },
      });
    };

    // There is deliberately no pipeline-run receipt in this chat. Carry is
    // produced from the watcher plus the event-backed execution summary, so
    // this proves a run started elsewhere still follows the watching chat.
    // Two separate events prove repeated carry; no agentArtifactCarryByTurn
    // fixture is seeded.
    await injectTurn('carry-turn-one', T + 20_000, T + 22_000);
    await expect(
      panel.getByText('Continue watching carry-turn-one'),
    ).toBeVisible();
    await injectTurn('carry-turn-two', T + 30_000, null);

    await expect(panel.getByTestId('agent-activity-active')).toBeVisible();
    const activeActivity = panel.getByTestId('agent-activity-active');
    const composerShell = panel.locator('[data-chat-composer-root]');
    await expect(async () => {
      const activityBox = await activeActivity.boundingBox();
      const composerBox = await composerShell.boundingBox();
      expect(Math.abs(activityBox.x - composerBox.x)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(activityBox.width - composerBox.width),
      ).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    const runCard = panel.getByTestId(
      `pipeline-run-card-${runReceipt.executionId}`,
    );
    await expect(runCard).toHaveCount(1);
    await expect(runCard).toContainText('pending');
    await expect(
      panel.getByTestId(`pipeline-run-watchers-${runReceipt.executionId}`),
    ).toBeVisible();
    await expect(
      panel.getByTestId(`pipeline-run-toggle-hidden-${runReceipt.executionId}`),
    ).toHaveCount(0);

    const runningExecutionState = {
      ...pendingExecutionState,
      status: 'running',
      jobs: {
        build: {
          ...pendingExecutionState.jobs.build,
          status: 'running',
          steps: {
            compile: {
              ...pendingExecutionState.jobs.build.steps.compile,
              status: 'running',
              started_at: runReceipt.startedAt,
            },
          },
        },
      },
    };
    delete runningExecutionState.job_definitions;
    delete runningExecutionState.job_groups;
    await injectPipelineExecutionEvent(electronApp, {
      type: 'execution.updated',
      executionId: runReceipt.executionId,
      timestamp: new Date(T + 31_000).toISOString(),
      state: runningExecutionState,
    });
    await expect(runCard).toContainText('running');
    await runCard.click();
    // The chat card opens the run's own panel tab beside its chat, where
    // the job list presents collapsed until the user expands it.
    const runPanel = await expectPipelineRunPanel(
      window,
      runReceipt.executionId,
      { timeout: 30_000 },
    );
    const detailsNav = await showPipelineJobList(runPanel, {
      timeout: 30_000,
    });
    await expect(
      detailsNav.getByTestId('pipeline-details-nav-job-build'),
    ).toBeVisible();
    await closePipelineRunPanels(window);

    const completed = panel.getByTestId('agent-activity-completed').first();
    await expect(completed).toBeVisible();
    const completedBox = await completed.boundingBox();
    const composerBox = await composerShell.boundingBox();
    expect(Math.abs(completedBox.x - composerBox.x - 16)).toBeLessThanOrEqual(
      2,
    );
    expect(
      Math.abs(completedBox.width - composerBox.width + 32),
    ).toBeLessThanOrEqual(2);

    await expect(
      completed.getByRole('button', { name: 'Expand agent activity' }),
    ).toBeVisible();
    await completed
      .getByRole('button', { name: 'Expand agent activity' })
      .click();
    const skillCard = completed.getByTestId('agent-artifact-skill');
    await expect(panel.getByTestId('agent-artifact-skill')).toHaveCount(1);
    await expect(skillCard).toContainText('Updated');
    await expect(skillCard).toContainText(updatedSkillReceipt.description);
    // Share appears only once the installed-skill list has loaded with this
    // skill, so after it the card has settled on live inventory: an installed
    // skill keeps its state rather than reporting a removal.
    await expect(completed.getByTestId('agent-artifact-share')).toBeVisible();
    await expect(skillCard).not.toContainText('Removed');
    // CAN-3480: the hover preview must not survive the navigation that opens
    // the skill details. The chat page stays mounted but hidden, so the card
    // used to stay open and re-anchor to the top-left corner over the sidebar.
    await skillCard.hover();
    const skillPreview = window
      .getByRole('tooltip')
      .filter({ hasText: updatedSkillReceipt.description });
    await expect(skillPreview).toBeVisible();
    await skillCard.click();
    // CAN-3483: an installed skill opens as its Marketplace detail page.
    const skillDetailTitle = window.locator('#skill-detail-modal-title');
    const skillDetailPage = window.getByTestId('plugins-entry-detail-page');
    await expect(skillDetailPage).toBeVisible();
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    // CAN-4261: the page has no Back; leave through the breadcrumb.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(skillDetailTitle).toHaveCount(0);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    // Navigation must not mutate or remove the immutable historical card.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    // Check the skill preview before touching the pointer, so moving it cannot
    // be what dismisses a stray preview.
    await expect(skillPreview).toHaveCount(0);
    // `selectWorktree` re-expands the collapsed activity rail with a real
    // click, which leaves the pointer resting on the group's menu button and
    // legitimately opens its tooltip. Park the pointer on the chat transcript
    // before asserting that no tooltip of any kind is left open.
    await window.getByTestId('panel-content-chat').hover();
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByTestId('agent-activity-active'),
    ).toBeVisible();
  } catch (error) {
    const rendererDiagnostics = await window
      ?.evaluate(() => document.body.innerText)
      .then((body) => ({ body, errors: rendererConsoleErrors }))
      .catch(() => ({
        body: '<renderer unavailable>',
        errors: rendererConsoleErrors,
      }));
    await testInfo.attach('agent-activity-failure', {
      body: `${String(error)}\n\nRenderer diagnostics:\n${JSON.stringify(rendererDiagnostics, null, 2)}`,
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovers a pipeline-id-only watcher on the latest completed turn without summaries', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-completed-watcher-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Completed watcher recovery',
        messages: [
          ...dispatchMessages(
            'pipeline-origin-turn',
            'pipeline-origin-tool',
            runReceipt,
            T,
            T + 5_000,
          ),
          {
            id: 'latest-completed-turn',
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep watching the pipeline.' }],
            timestamp: T + 20_000,
          },
          {
            id: 'latest-completed-answer',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'The watcher is still active.' }],
            timestamp: T + 21_000,
          },
          {
            id: 'latest-completed-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: T + 20_000,
                completedAt: T + 22_000,
              },
            ],
            timestamp: T + 22_000,
          },
        ],
      },
    ],
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'pipeline-only-watcher',
        label: 'Pipeline-only watcher',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          pipelineId: runReceipt.pipelineId,
        },
        destination: {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          chatTitle: 'Completed watcher recovery',
        },
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText('The watcher is still active.')).toBeVisible();
    const completed = panel.getByTestId('agent-activity-completed');
    await expect(completed).toHaveCount(2);
    await expect(
      completed
        .last()
        .getByTestId(`pipeline-run-card-${runReceipt.executionId}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retry and resume activity remain in the turn that dispatched them', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-execution-actions-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const retryReceipt = executionReceipt(
    'pipeline.execution_retry',
    'activity-retry-exec',
    'Retried pipeline',
    'pending',
  );
  const resumeReceipt = executionReceipt(
    'pipeline.execution_resume',
    'activity-resume-exec',
    'Resumed pipeline',
    'running',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'execution-actions-chat',
        title: 'Execution action activity',
        messages: [
          ...dispatchMessages(
            'execution-actions-turn',
            'execution-actions-tool',
            [retryReceipt, resumeReceipt],
            T + 40_000,
            T + 45_000,
          ),
          {
            id: 'later-turn',
            role: 'user',
            blocks: [{ type: 'text', text: 'A later turn' }],
            timestamp: T + 50_000,
          },
          {
            id: 'later-turn-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: T + 50_000,
                pausedAt: T + 51_000,
                completedAt: null,
              },
            ],
            timestamp: T + 51_000,
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');

    // Neither execution is watched, so the later active turn must not carry
    // either card forward.
    await expect(panel.getByTestId('agent-activity-active')).toHaveCount(0);
    const completed = panel.getByTestId('agent-activity-completed').first();
    await completed
      .getByRole('button', { name: 'Expand agent activity' })
      .click();
    await expect(
      completed.getByTestId(`pipeline-run-card-${retryReceipt.executionId}`),
    ).toBeVisible();
    await expect(
      completed.getByTestId(`pipeline-run-card-${resumeReceipt.executionId}`),
    ).toBeVisible();
    await expect(
      completed.getByTestId(
        `pipeline-run-toggle-hidden-${retryReceipt.executionId}`,
      ),
    ).toHaveCount(0);
    await expect(
      completed.getByTestId(
        `pipeline-run-toggle-hidden-${resumeReceipt.executionId}`,
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('resumes a paused execution from its chat artifact card', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-resume-control-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const executionId = 'activity-paused-resume-exec';
  const receipt = executionReceipt(
    'pipeline.run',
    executionId,
    'Paused artifact pipeline',
    'paused',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'resume-control-chat',
        title: 'Resume control activity',
        messages: dispatchMessages(
          'resume-control-turn',
          'resume-control-tool',
          receipt,
          T + 60_000,
          T + 65_000,
        ),
      },
    ],
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: executionId,
      pipelineName: receipt.pipelineName,
      status: 'paused',
      jobs: [
        {
          id: 'gate',
          name: 'Gate',
          steps: [{ id: 'hold', name: 'Hold', run: 'echo resumed' }],
        },
      ],
      stepResults: {
        'gate.hold': {
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          pause_requested: true,
        },
      },
      stateOverrides: {
        version: 8,
        jobs: {
          gate: {
            status: 'paused',
            steps: {
              hold: {
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                outputs: {},
                dynamic_env: {},
                started_at: new Date(T + 60_000).toISOString(),
                completed_at: new Date(T + 60_000).toISOString(),
                exit_code: 0,
                pause_requested: true,
              },
            },
            outputs: {},
            retry_count: 0,
            retry_history: [],
            iteration_count: 1,
            started_at: new Date(T + 60_000).toISOString(),
          },
        },
        job_definitions: {
          gate: {
            name: 'Gate',
            needs: [],
            if: 'true',
            env: {},
            outputs: {},
            timeout_minutes: 60,
            max_retries: 0,
            continue_on_error: false,
            steps: [
              {
                id: 'hold',
                name: 'Hold',
                run: 'echo resumed',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 30,
                skip_on_missing_action: false,
              },
            ],
            physical_job_id: 'gate',
            logical_job_id: 'gate',
          },
        },
        job_groups: {
          gate: {
            job_id: 'gate',
            kind: 'single',
            expansion: 'expanded',
            variant_job_ids: ['gate'],
            status: 'paused',
            started_at: new Date(T + 60_000).toISOString(),
          },
        },
        pending_pauses: [
          {
            id: 'artifact-pause-checkpoint',
            kind: 'action',
            job_id: 'gate',
            logical_job_id: 'gate',
            step_id: 'hold',
            attempt: 0,
            iteration: 1,
            detected_at: new Date(T + 60_000).toISOString(),
          },
        ],
        status_reasons: [
          {
            id: '123e4567-e89b-42d3-a456-426614174011',
            kind: 'action_paused',
            code: 'action_requested_pause',
            detected_at: new Date(T + 60_000).toISOString(),
            source: {
              job_id: 'gate',
              step_id: 'hold',
              attempt: 0,
              iteration: 1,
            },
          },
        ],
      },
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const card = panel.getByTestId(`pipeline-run-card-${executionId}`);
    await expect(card).toBeVisible();
    const resume = panel.getByTestId(`pipeline-run-resume-${executionId}`);
    await expect(resume).toBeEnabled();
    await resume.click();

    await expect(resume).toHaveCount(0);
    await expect(card).toContainText('success', { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('real worktree and App Advisor dispatches create activity cards', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-dispatch-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: PROJECT_ID,
    defaultMode: 'full-access',
  });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: 'app-advisor',
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'dispatch-chat', title: 'Dispatch activity' }],
  });

  await registerSkillDispatch(
    'Canopy-CACTWORKTREE',
    'mcp__canopy__DispatchAction',
    'electron-worktree-dispatch',
  );
  await registerSkillDispatch(
    'Canopy-CACTADVISOR',
    'mcp__canopy_app_advisor__DispatchAction',
    'electron-advisor-dispatch',
  );

  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CACRECOMMEND', {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__ShowCapabilities',
              input: {
                items: [
                  { kind: 'skill', name: 'canopy-pipeline-writing' },
                  {
                    kind: 'skill',
                    name: 'Release formatter',
                    url: 'https://example.com/skills/release-formatter',
                    reason: 'Formats the release notes you asked about',
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Recommended the release formatter', stopReason: 'end_turn' },
      ],
    },
  });

  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CACADVISORAGENT', {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: {
                action: {
                  type: 'agents.create',
                  name: 'Activity reviewer',
                  baseModel: 'sonnet',
                  instructions: 'Review the requested change.',
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Created the activity reviewer', stopReason: 'end_turn' },
      ],
    },
  });

  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CACADVISORSKILL', {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__ShowCapabilities',
              input: {
                items: [
                  { kind: 'skill', id: 'builtin:app/canopy-pipeline-writing' },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Recommended the built-in skill', stopReason: 'end_turn' },
      ],
    },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    await sendToolTurn(
      panel,
      'Canopy-CACTWORKTREE',
      'Created electron-worktree-dispatch',
    );
    const skillCard = panel.getByTestId('agent-artifact-skill');
    await expect(skillCard).toContainText('electron-worktree-dispatch');

    // CAN-3611: an installed standalone skill's card offers the common Share
    // action as a sibling of the card button. Sharing starts from the chat
    // (here the sign-in prompt, since this profile has no shareable account)
    // and does not open the skill the way clicking the card does.
    const cardShare = panel.getByTestId('agent-artifact-share');
    await expect(cardShare).toBeVisible();
    await expect(cardShare).toHaveAccessibleName(/^Share /);
    await expect(skillCard.locator('button')).toHaveCount(0);
    await cardShare.click();
    const signInPrompt = window.getByTestId('cloud-sync-modal');
    await expect(signInPrompt).toBeVisible();
    await expect(window.getByTestId('share-skill-submit')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(signInPrompt).toHaveCount(0);
    await expect(skillCard).toBeVisible();
    await expect(panel).toBeVisible();

    // Mock provider scenarios bind to a chat's first marker. Each producer
    // needs a fresh chat so its own scenario runs.
    await window.getByTestId('panel-add-tab-group-chat').click();
    // Exercise the actual injected-tool producer, rather than seeding its receipt.
    await sendToolTurn(
      panel,
      'Canopy-CACRECOMMEND',
      'Recommended the release formatter',
    );
    const recommendation = panel.getByTestId(
      'agent-artifact-capability_reference',
    );
    await expect(recommendation).toHaveCount(2);
    const external = recommendation.filter({ hasText: 'Release formatter' });
    await expect(external).toContainText('Recommended');
    await expect(external).toContainText('External');
    await expect(
      recommendation.filter({ hasText: 'canopy-pipeline-writing' }),
    ).toContainText('Installed');

    const advisor = await app.openAppAdvisorWindow(electronApp);
    const advisorSurface = advisor.getByTestId('app-advisor-workspace-surface');
    await sendToolTurn(
      advisorSurface,
      'Canopy-CACTADVISOR',
      'Created electron-advisor-dispatch',
    );
    await expect(
      advisorSurface.getByTestId('agent-artifact-skill'),
    ).toContainText('electron-advisor-dispatch');
    // The App Advisor window mounts no share host (it has no sign-in gate),
    // so its cards offer no chat-side Share.
    await expect(
      advisorSurface.getByTestId('agent-artifact-share'),
    ).toHaveCount(0);

    await advisor.getByTestId('panel-add-tab-group-chat').click();
    await sendToolTurn(
      advisorSurface,
      'Canopy-CACADVISORSKILL',
      'Recommended the built-in skill',
    );
    await expect(
      advisorSurface.getByTestId('agent-artifact-capability_reference'),
    ).toContainText('canopy-pipeline-writing');

    // The tile crosses the detached Advisor -> main-window dispatcher and
    // its payload validator before the saved agent editor can open.
    await advisor.getByTestId('panel-add-tab-group-chat').click();
    await sendToolTurn(
      advisorSurface,
      'Canopy-CACADVISORAGENT',
      'Created the activity reviewer',
    );
    const advisorAgent = advisorSurface.getByTestId('agent-artifact-agent');
    await expect(advisorAgent).toContainText('Activity reviewer');
    await advisorAgent.click();
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(window.getByTestId('agent-model-name')).toHaveValue(
      'Activity reviewer',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('worktree SetBaseBranch uses the branded app row and summary group', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-set-base-branch-display-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'set-base-branch-display',
        title: 'Set base branch display',
        messages: [
          {
            id: 'set-base-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Use release/next as the base.' }],
            timestamp: T,
          },
          {
            id: 'set-base-use',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'set-base-tool',
                toolName: 'canopy_set_base_branch',
                input: JSON.stringify({
                  baseBranch: 'release/next',
                  repoId: 'repo-a',
                }),
              },
            ],
            timestamp: T + 1,
          },
          {
            id: 'set-base-result',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'set-base-tool',
                toolName: 'canopy_set_base_branch',
                output: JSON.stringify({ ok: true }),
                isError: false,
              },
            ],
            timestamp: T + 2,
          },
          {
            id: 'set-base-final',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Base branch updated.' }],
            timestamp: T + 3,
          },
          {
            id: 'set-base-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: T,
                completedAt: T + 4,
              },
            ],
            timestamp: T + 4,
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const summary = panel.getByRole('button', {
      name: 'Agent steps: 1 app',
    });
    await expect(summary).toBeVisible();
    await summary.click();

    const row = panel.locator('[data-tool-name="canopy_set_base_branch"]');
    await expect(row).toBeVisible();
    await expect(row.locator('[data-tool-family="canopy"]')).toContainText(
      'Set base branch release/next repo repo-a',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('managed delegation tools count with the branded app summary group', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-delegation-tool-summary-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  // Claude and Codex spellings of the tools that read, list and stop
  // delegates a spawn already started.
  const delegationTools = [
    ['mcp__canopy__GetDelegateOutput', { delegationId: 'child-1' }],
    ['mcp__canopy__ListDelegates', {}],
    ['canopy_inspect_delegate', { delegationId: 'child-1' }],
    ['canopy_stop_delegate', { delegationId: 'child-1' }],
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'delegation-tool-summary',
        title: 'Delegation tool summary',
        messages: [
          {
            id: 'delegation-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Check on the delegate.' }],
            timestamp: T,
          },
          ...delegationTools.flatMap(([toolName, input], index) => [
            {
              id: `delegation-use-${String(index)}`,
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: `delegation-tool-${String(index)}`,
                  toolName,
                  input: JSON.stringify(input),
                },
              ],
              timestamp: T + 1 + index * 2,
            },
            {
              id: `delegation-result-${String(index)}`,
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: `delegation-tool-${String(index)}`,
                  toolName,
                  output: JSON.stringify({ ok: true }),
                  isError: false,
                },
              ],
              timestamp: T + 2 + index * 2,
            },
          ]),
          {
            id: 'delegation-final',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'The delegate is stopped.' }],
            timestamp: T + 20,
          },
          {
            id: 'delegation-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: T,
                completedAt: T + 21,
              },
            ],
            timestamp: T + 21,
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // One app group, never the generic "other" group.
    const panel = window.getByTestId('panel-content-chat');
    const summary = panel.getByRole('button', {
      name: 'Agent steps: 4 app',
    });
    await expect(summary).toBeVisible();
    await expect(
      panel.getByRole('button', { name: /^Agent steps:.*\bother\b/ }),
    ).toHaveCount(0);
    await summary.click();

    for (const [toolName] of delegationTools) {
      const row = panel.locator(`[data-tool-name="${toolName}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('[data-tool-family="canopy"]')).toBeVisible();
    }
    await expect(
      panel.locator('[data-tool-name="mcp__canopy__GetDelegateOutput"]'),
    ).toContainText('Get delegate output');
    await expect(
      panel.locator('[data-tool-name="mcp__canopy__ListDelegates"]'),
    ).toContainText('List delegations');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('real cowork dispatch creates an activity card', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-activity-cowork-'),
  );
  const coworkId = 'activity-cowork';
  const workspaceDir = path.join(userDataDir, 'workspaces', coworkId);
  seedPreferences(userDataDir, { coworkApproval: 'ask' });
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: coworkId,
        name: 'Activity Cowork',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt: new Date().toISOString() },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { createdAt: new Date().toISOString() },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [],
  });
  await registerSkillDispatch(
    'Canopy-CACTCOWORK',
    'mcp__canopy__DispatchAction',
    'electron-cowork-dispatch',
  );

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${coworkId}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    const home = await app.openHomeForProject(coworkId);
    const message = '[Canopy-CACTCOWORK] Create the requested skill.';
    await expect(home.getByTestId('approval-mode-picker')).toHaveAttribute(
      'aria-label',
      'Tool approval mode, current mode Ask',
      { timeout: 15_000 },
    );
    await home.getByTestId('home-composer-editor').fill(message);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    const approvalCard = window.getByTestId('tool-approval-card');
    await expect(approvalCard).toBeVisible({ timeout: 60_000 });
    await expect(approvalCard).toContainText('DispatchAction');
    await window.getByTestId('tool-approval-allow').click();
    await expect(approvalCard).toHaveCount(0);
    await expect(
      panel.getByText('Created electron-cowork-dispatch'),
    ).toBeVisible({
      timeout: 120_000,
    });
    await expect(panel.getByTestId('agent-artifact-skill')).toContainText(
      'electron-cowork-dispatch',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const variant of ['managed', 'claude', 'codex', 'managed-paged']) {
  const kind = variant === 'managed-paged' ? 'managed' : variant;
  test(`pinned ${variant} background agent expands the full chat transcript`, async () => {
    const { pinnedAgentHistory } =
      await import('./seeders/pinnedAgentHistory.mjs');
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pinned-agent-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Background review',
          messages: [
            ...pinnedAgentHistory(kind),
            ...(variant === 'managed-paged'
              ? [
                  {
                    id: 'later-request',
                    role: 'user',
                    timestamp: 1789490000100,
                    blocks: [
                      {
                        type: 'text',
                        text: 'Continue after background review',
                      },
                    ],
                  },
                  ...Array.from({ length: 600 }, (_, index) => ({
                    id: `later-response-${index}`,
                    role: 'assistant',
                    timestamp: 1789490000101 + index,
                    blocks: [{ type: 'text', text: `Later response ${index}` }],
                  })),
                ]
              : []),
          ],
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      const pinned = panel.getByTestId('agent-activity-active');
      if (kind === 'claude') {
        // A persisted Claude launch without its native process is historical
        // activity, so the transcript lives in the completed turn.
        await panel
          .getByRole('button', { name: /^Agent steps:/, expanded: false })
          .click();
        await expect(pinned).toHaveCount(0);
      } else {
        await expect(pinned).toBeVisible();
      }
      const card =
        kind === 'managed'
          ? pinned.getByTestId('chat-delegated-agent')
          : kind === 'claude'
            ? panel.getByTestId('agent-block')
            : pinned.getByTestId('agent-block');
      await expect(card).toHaveCount(1);
      if (kind === 'managed') {
        // A direct child of this chat omits the redundant "Depth 1 · Parent:
        // This chat" lineage prefix.
        await expect(card.getByTestId('delegated-agent-lineage')).toHaveCount(
          0,
        );
        await expect(card).not.toContainText('Parent: This chat');
      }
      await card.getByRole('button').first().click();
      await expect(
        card.getByText(
          `Child transcript for ${kind}: the original cause is preserved.`,
        ),
      ).toBeVisible();
      if (kind === 'claude') {
        await expect(card.getByLabel('Thinking', { exact: true })).toHaveCount(
          0,
        );
      } else {
        await expect(
          card.getByLabel('Thinking', { exact: true }),
        ).toBeVisible();
      }
      await expect(card.getByText('Running', { exact: true })).toHaveCount(0);
      await card.getByRole('button').first().click();
      await expect(
        card.getByText(
          `Child transcript for ${kind}: the original cause is preserved.`,
        ),
      ).toHaveCount(0);
      // Expansion still works after a renderer reload using persisted native history.
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      if (kind === 'claude') {
        await panel
          .getByRole('button', { name: /^Agent steps:/, expanded: false })
          .click();
      }
      await card.getByRole('button').first().click();
      await expect(
        card.getByText(
          `Child transcript for ${kind}: the original cause is preserved.`,
        ),
      ).toBeVisible();
      if (kind === 'claude') {
        await injectChatEvent(electronApp, {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          data: {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'abc123',
            tool_use_id: 'claude-child',
            status: 'completed',
            summary: 'Finished reviewing source.',
          },
        });
      } else if (kind === 'codex') {
        await injectChatEvent(electronApp, {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          data: {
            type: 'codex',
            event: {
              type: 'item.completed',
              item: {
                id: 'wait-complete',
                type: 'collab_agent_tool_call',
                tool: 'wait',
                status: 'completed',
                sender_thread_id: 'parent',
                receiver_thread_ids: ['native-child'],
                agents_states: { 'native-child': { status: 'completed' } },
              },
            },
          },
        });
      } else {
        const snapshot = pinnedAgentHistory('managed', true)[1].blocks[0];
        await injectChatEvent(electronApp, {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          data: {
            type: 'canopy_delegation',
            delegation: {
              delegationId: snapshot.delegationId,
              runGeneration: 1,
              sequence: 2,
              parentHarnessId: snapshot.parentHarnessId,
              parentTurnId: 'request',
              parentToolCallId: snapshot.parentToolCallId,
              createdAt: snapshot.createdAt,
              task: {
                description: snapshot.description,
                prompt: snapshot.prompt,
                executionMode: 'background',
              },
              snapshot,
              transcript: [
                {
                  id: 'final',
                  sequence: 2,
                  occurredAt: snapshot.createdAt + 10,
                  type: 'text',
                  text: snapshot.finalText,
                },
              ],
            },
          },
        });
      }
      await expect(pinned).toHaveCount(0);
      if (variant === 'managed-paged') {
        await panel
          .getByTestId('chat-message-list-scroll')
          .evaluate((element) =>
            element.scrollTo({ top: 0, behavior: 'instant' }),
          );
        await expect(
          panel.getByText('Review the source in the background.', {
            exact: true,
          }),
        ).toBeVisible();
      }
      if (kind === 'managed') {
        for (const summary of await panel
          .getByRole('button', { name: /^Agent steps:/, expanded: false })
          .all())
          await summary.click();
        const completedCard = panel.getByTestId('chat-delegated-agent');
        await expect(completedCard).toBeVisible();
        // The main transcript card omits the direct-child lineage too.
        await expect(
          completedCard.getByTestId('delegated-agent-lineage'),
        ).toHaveCount(0);
        await expect(completedCard).not.toContainText('Parent: This chat');
        await expect(
          completedCard.getByText('Completed', { exact: true }),
        ).toHaveCount(0);
        await expect(
          completedCard.getByLabel('Thinking', { exact: true }),
        ).toHaveCount(0);
        await completedCard
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await completedCard
          .getByRole('button', { name: 'Show result' })
          .click();
        await expect(
          completedCard.getByText('Finished reviewing source.'),
        ).toBeVisible();
        if (variant === 'managed-paged') {
          await window.reload();
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree(WORKTREE_ID);
          await panel
            .getByTestId('chat-message-list-scroll')
            .evaluate((element) =>
              element.scrollTo({ top: 0, behavior: 'instant' }),
            );
          await expect(
            panel.getByText('Review the source in the background.', {
              exact: true,
            }),
          ).toBeVisible();
          for (const summary of await panel
            .getByRole('button', { name: /^Agent steps:/, expanded: false })
            .all())
            await summary.click();
          await completedCard
            .getByRole('button', { name: 'Expand delegated task' })
            .click();
          await completedCard
            .getByRole('button', { name: 'Show result' })
            .click();
          await expect(
            completedCard.getByText('Finished reviewing source.'),
          ).toBeVisible();
          await expect(panel.getByTestId('agent-activity-active')).toHaveCount(
            0,
          );
          const followUpSnapshot = pinnedAgentHistory('managed', true)[1]
            .blocks[0];
          await injectChatEvent(electronApp, {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            chatId: CHAT_ID,
            data: {
              type: 'canopy_delegation',
              delegation: {
                delegationId: followUpSnapshot.delegationId,
                runGeneration: 2,
                sequence: 1,
                parentHarnessId: followUpSnapshot.parentHarnessId,
                parentTurnId: 'request',
                parentToolCallId: followUpSnapshot.parentToolCallId,
                createdAt: followUpSnapshot.createdAt,
                task: {
                  description: followUpSnapshot.description,
                  prompt: followUpSnapshot.prompt,
                  executionMode: 'background',
                },
                snapshot: {
                  ...followUpSnapshot,
                  runGeneration: 2,
                  finalText: 'Follow-up review result.',
                },
                transcript: [
                  {
                    id: 'follow-up-final',
                    sequence: 1,
                    occurredAt: followUpSnapshot.createdAt + 20,
                    type: 'text',
                    text: 'Follow-up review result.',
                  },
                ],
              },
            },
          });
          await window.reload();
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree(WORKTREE_ID);
          await panel
            .getByTestId('chat-message-list-scroll')
            .evaluate((element) =>
              element.scrollTo({ top: 0, behavior: 'instant' }),
            );
          await expect(
            panel.getByText('Review the source in the background.', {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            panel.getByRole('button', {
              name: /^Agent steps:/,
              expanded: false,
            }),
          ).toHaveCount(1);
          for (const summary of await panel
            .getByRole('button', { name: /^Agent steps:/, expanded: false })
            .all())
            await summary.click();
          await expect(panel.getByTestId('chat-delegated-agent')).toHaveCount(
            2,
          );
        }
      }
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(pinned).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

// The desktop half of CAN-4046's cloud agent cards: the native card is the same
// shared AgentBlockCard, so it must nest a child agent and settle from running
// to completed or error the same way. Cloud-only sub-block truncation has no
// desktop source and is covered by the web `cloud/cloud-agent-cards.spec.mjs`.
for (const outcome of ['completed', 'error']) {
  test(`native agent card nests a child agent and settles from running to ${outcome}`, async () => {
    const { pinnedAgentHistory } =
      await import('./seeders/pinnedAgentHistory.mjs');
    const history = pinnedAgentHistory('codex');
    const childIndex = history.findIndex(
      (message) => message.id === 'child-read',
    );
    history.splice(
      childIndex + 1,
      0,
      {
        id: 'child-spawn',
        role: 'assistant',
        timestamp: 1789490000003,
        parentBlockId: 'codex-child',
        blocks: [
          {
            type: 'codex_agent_call',
            agentBlockId: 'codex-grandchild',
            callId: 'codex-grandchild',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'native-child',
            receiverThreadIds: ['native-grandchild'],
            prompt: 'Check contract coverage',
            agentsStates: { 'native-grandchild': { status: 'completed' } },
          },
        ],
      },
      {
        id: 'grandchild-answer',
        role: 'assistant',
        timestamp: 1789490000003,
        parentBlockId: 'codex-grandchild',
        blocks: [
          {
            type: 'text',
            text: 'Nested agent transcript: every contract has a spec.',
          },
        ],
      },
    );
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nested-agent-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      tabs: [{ id: CHAT_ID, title: 'Nested review', messages: history }],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      const pinned = panel.getByTestId('agent-activity-active');
      // The card's own header, not the nested card's.
      const header = (card) => card.locator(':scope > button').first();

      // Running: the pinned card spins and carries no error.
      await expect(pinned).toBeVisible();
      await expect(pinned.getByTestId('agent-block')).toHaveCount(1);
      const card = pinned.getByTestId('agent-block').first();
      await expect(
        header(card).getByLabel('Thinking', { exact: true }),
      ).toBeVisible();
      await expect(
        header(card).getByText('error', { exact: true }),
      ).toHaveCount(0);

      // Expanding reveals the child transcript and its nested agent card,
      // which expands on its own.
      await header(card).click();
      await expect(
        card.getByText(
          'Child transcript for codex: the original cause is preserved.',
        ),
      ).toBeVisible();
      const nested = card.getByTestId('agent-block');
      await expect(nested).toHaveCount(1);
      await expect(
        header(nested).getByLabel('Thinking', { exact: true }),
      ).toHaveCount(0);
      await header(nested).click();
      await expect(
        nested.getByText('Nested agent transcript: every contract has a spec.'),
      ).toBeVisible();

      // The child settles; the card leaves the pinned list for its turn.
      await injectChatEvent(electronApp, {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        data: {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              id: 'wait-complete',
              type: 'collab_agent_tool_call',
              tool: 'wait',
              status: 'completed',
              sender_thread_id: 'parent',
              receiver_thread_ids: ['native-child'],
              agents_states: {
                'native-child': {
                  status: outcome === 'error' ? 'errored' : 'completed',
                },
              },
            },
          },
        },
      });
      await expect(pinned).toHaveCount(0);
      // The settled card folds into its completed turn's steps row.
      const expandSteps = async () => {
        const steps = panel.getByRole('button', {
          name: /^Agent steps/,
          expanded: false,
        });
        await expect(steps).toHaveCount(1);
        await steps.click();
      };
      const expectSettled = async () => {
        const settled = panel.getByTestId('agent-block').first();
        await expect(settled).toBeVisible();
        await expect(
          header(settled).getByLabel('Thinking', { exact: true }),
        ).toHaveCount(0);
        await expect(
          header(settled).getByText('error', { exact: true }),
        ).toHaveCount(outcome === 'error' ? 1 : 0);
        await header(settled).click();
        await expect(settled.getByTestId('agent-block')).toHaveCount(1);
        await header(settled.getByTestId('agent-block')).click();
        await expect(
          settled.getByText(
            'Nested agent transcript: every contract has a spec.',
          ),
        ).toBeVisible();
      };
      await expandSteps();
      await expectSettled();

      // The settled state is durable across a renderer reload.
      await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(pinned).toHaveCount(0);
      await expandSteps();
      await expectSettled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('pinned managed agent stays expanded and left aligned while siblings settle', async () => {
  const { pinnedAgentHistory } =
    await import('./seeders/pinnedAgentHistory.mjs');
  const history = pinnedAgentHistory('managed');
  const first = history[1].blocks[0];
  // A second running delegate that is awaiting approval, listed after the
  // first so the first one settling shifts it up the pinned list.
  const sibling = {
    ...first,
    agentBlockId: 'delegated-agent-managed-sibling',
    delegationId: 'managed-sibling',
    parentToolCallId: 'delegate-sibling-call',
    description: 'Review managed tests',
    prompt: 'Review managed tests',
    approvalPending: true,
  };
  const messages = [
    ...history.slice(0, 2),
    {
      id: sibling.agentBlockId,
      role: 'assistant',
      timestamp: history[1].timestamp,
      blocks: [sibling],
    },
    ...history.slice(2),
  ];
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pinned-siblings-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    tabs: [{ id: CHAT_ID, title: 'Parallel review', messages }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const pinned = window
      .getByTestId('panel-content-chat')
      .getByTestId('agent-activity-active');
    const siblingCard = pinned.locator(
      '[data-delegation-id="managed-sibling"]',
    );
    await expect(pinned.getByTestId('chat-delegated-agent')).toHaveCount(2);

    // "Awaiting approval" sits at the end of the row; the agent label stays
    // at the start instead of being pushed right with it.
    const header = siblingCard.getByRole('button', {
      name: 'Expand delegated task',
    });
    const status = siblingCard.getByRole('status');
    await expect(status).toHaveText('Awaiting approval');
    const label = header.getByText(/^Agent/);
    const [headerBox, labelBox, statusBox] = await Promise.all([
      header.boundingBox(),
      label.boundingBox(),
      status.boundingBox(),
    ]);
    if (!headerBox || !labelBox || !statusBox)
      throw new Error('Missing header geometry');
    expect(labelBox.x - headerBox.x).toBeLessThan(40);
    expect(statusBox.x).toBeGreaterThan(labelBox.x + labelBox.width);

    await header.click();
    await expect(
      siblingCard.getByRole('button', { name: 'Collapse delegated task' }),
    ).toBeVisible();

    const settled = pinnedAgentHistory('managed', true)[1].blocks[0];
    await injectChatEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'canopy_delegation',
        delegation: {
          delegationId: settled.delegationId,
          runGeneration: 1,
          sequence: 2,
          parentHarnessId: settled.parentHarnessId,
          parentTurnId: 'request',
          parentToolCallId: settled.parentToolCallId,
          createdAt: settled.createdAt,
          task: {
            description: settled.description,
            prompt: settled.prompt,
            executionMode: 'background',
          },
          snapshot: settled,
          transcript: [
            {
              id: 'final',
              sequence: 2,
              occurredAt: settled.createdAt + 10,
              type: 'text',
              text: settled.finalText,
            },
          ],
        },
      },
    });
    await expect(pinned.getByTestId('chat-delegated-agent')).toHaveCount(1);
    await expect(
      siblingCard.getByRole('button', { name: 'Collapse delegated task' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const matching of [true, false]) {
  test(`pinned patch uses edit display and ${matching ? 'deduplicates' : 'preserves different'} route details`, async () => {
    const { pinnedPatchHistory } =
      await import('./seeders/pinnedAgentHistory.mjs');
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pinned-patch-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Patch review',
          messages: pinnedPatchHistory(matching),
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const card = window
        .getByTestId('agent-activity-active')
        .getByTestId('chat-delegated-agent');
      for (const reload of [false, true]) {
        if (reload) {
          await window.reload();
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree(WORKTREE_ID);
        }
        await card
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await expect(
          card.locator('dt', { hasText: /^Runtime model$/ }),
        ).toHaveCount(matching ? 0 : 1);
        await expect(card.locator('dt', { hasText: /^Thinking$/ })).toHaveCount(
          matching ? 1 : 0,
        );
        await expect(
          card.locator('dt', { hasText: /^Requested thinking$/ }),
        ).toHaveCount(matching ? 0 : 1);
        await expect(
          card.locator('dt', { hasText: /^Effective thinking$/ }),
        ).toHaveCount(matching ? 0 : 1);
        const legacy = card.locator('[data-tool-name="apply_patch"]');
        await expect(legacy.locator('[data-tool-family="edit"]')).toContainText(
          'File change',
        );
        await expect(legacy).not.toContainText('Apply Patch');
        await expect(
          card.locator('[data-tool-name="file_change"]'),
        ).toContainText('Edit index.ts');
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('expanded pinned subagent unwraps POSIX and Windows Bash commands after reload', async () => {
  const { pinnedShellHistory } =
    await import('./seeders/pinnedAgentHistory.mjs');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pinned-shell-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      { id: CHAT_ID, title: 'Shell review', messages: pinnedShellHistory() },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    for (const reload of [false, true]) {
      if (reload) await window.reload();
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const card = window
        .getByTestId('agent-activity-active')
        .getByTestId('chat-delegated-agent');
      await card.getByRole('button', { name: 'Expand delegated task' }).click();
      for (const command of [
        'printf hello && pwd',
        'Get-ChildItem -Force',
        'Get-Content README.md',
      ]) {
        await expect(
          card.getByRole('button').filter({ hasText: command }),
        ).toBeVisible();
      }
      await expect(card).not.toContainText('/bin/zsh');
      await expect(card).not.toContainText('pwsh.exe');
      await expect(card).not.toContainText('powershell.exe');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const TILE_ACTIVITY_ID = 'tiles-nightly';
const TILE_RUN_ID = 'tiles-run-failed';
const DELETED_ACTIVITY_ID = 'tiles-deleted';
const DELETED_RUN_ID = 'tiles-run-deleted';
const EXTERNAL_SKILL_URL = 'https://example.com/skills/release-notes';

function automationRunReceipt(activityId, runId, name, status, offset) {
  const timestamp = new Date(T + offset).toISOString();
  return {
    version: 1,
    kind: 'automation_run',
    operation: 'automation.run_now',
    dedupeKey: `canopy:automation_run:local:${runId}`,
    createdAt: timestamp,
    activityId,
    runId,
    name,
    status,
    trigger: 'manual',
    scheduledFor: timestamp,
    startedAt: timestamp,
    navigationTarget: {
      kind: 'automation_editor',
      activityId,
      section: 'runs',
      runId,
    },
  };
}

const externalReferenceReceipt = {
  version: 1,
  kind: 'capability_reference',
  operation: 'capabilities.show',
  dedupeKey: `canopy:capability_reference:skill:external:${EXTERNAL_SKILL_URL}`,
  createdAt: new Date(T + 3_000).toISOString(),
  itemKind: 'skill',
  source: 'external',
  sourceId: EXTERNAL_SKILL_URL,
  name: 'Release notes writer',
  description: 'Drafts release notes from merged pull requests',
  sourceLabel: 'example.com',
  state: 'unknown',
  relation: 'recommended',
  reason: 'Matches the release checklist you asked about',
  navigationTarget: { kind: 'external_url', url: EXTERNAL_SKILL_URL },
};

function longCapabilityTurn(messages) {
  return messages.flatMap((message) =>
    message.id === 'tiles-turn-timer'
      ? [
          ...Array.from({ length: 160 }, (_, index) => ({
            id: `tiles-noise-${index}`,
            role: 'assistant',
            timestamp: T + 100 + index,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: `noise-${index}`,
                toolName: 'Read',
                input: JSON.stringify({ file_path: 'README.md' }),
              },
              {
                type: 'tool_result',
                toolUseId: `noise-${index}`,
                toolName: 'Read',
                output: 'Unrelated inspection output',
                isError: false,
              },
            ],
          })),
          {
            id: 'tiles-final',
            role: 'assistant',
            timestamp: T + 500,
            blocks: [{ type: 'text', text: 'Finished the capability checks.' }],
          },
          message,
        ]
      : [message],
  );
}

test('capability tiles show live run outcomes, open the run, and keep deleted history', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-capability-tiles-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const runStartedAt = new Date(T + 1_000).toISOString();
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: TILE_ACTIVITY_ID,
        name: 'Nightly triage',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Triage new issues.' },
        createdAt: new Date(T - 60_000).toISOString(),
        updatedAt: new Date(T - 60_000).toISOString(),
        failureCount: 1,
      },
    ],
    recentRuns: [
      {
        id: TILE_RUN_ID,
        activityId: TILE_ACTIVITY_ID,
        activityName: 'Nightly triage',
        scheduledFor: runStartedAt,
        manual: true,
        trigger: 'manual',
        status: 'failure',
        startedAt: runStartedAt,
        completedAt: new Date(T + 5_000).toISOString(),
        durationMs: 4_000,
        error: 'Advisor prompt failed',
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Capability tiles',
        messages: longCapabilityTurn(
          dispatchMessages(
            'tiles-turn',
            'tiles-tool',
            [
              // Persisted while the run was still going; the live run history
              // reports its failure.
              automationRunReceipt(
                TILE_ACTIVITY_ID,
                TILE_RUN_ID,
                'Nightly triage',
                'running',
                1_000,
              ),
              // Its automation was deleted after this turn.
              automationRunReceipt(
                DELETED_ACTIVITY_ID,
                DELETED_RUN_ID,
                'Weekly digest',
                'success',
                2_000,
              ),
              externalReferenceReceipt,
              // A repeat mention collapses into one tile.
              externalReferenceReceipt,
            ],
            T,
            T + 6_000,
          ),
        ),
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  let window;
  try {
    window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1600, height: 1000 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const section = panel.getByTestId('agent-activity-completed').first();
    await expect(section).toBeVisible({ timeout: 30_000 });
    const expand = section.getByRole('button', {
      name: 'Expand agent activity',
    });
    if (await expand.isVisible()) await expand.click();

    const runTiles = section.getByTestId('agent-artifact-automation_run');
    await expect(runTiles).toHaveCount(2);
    const failedRun = section.getByRole('button', {
      name: /^Nightly triage, Automation run, Triggered, Failed/,
    });
    await expect(failedRun).toBeVisible();
    await expect(failedRun).toContainText('Manual run · 4 s');

    // The deleted automation keeps its outcome but offers no navigation.
    const deletedRun = section.getByRole('group', {
      name: /^Weekly digest, Automation run, Triggered, Succeeded/,
    });
    await expect(deletedRun).toContainText('Automation deleted');
    await expect(
      section.getByRole('button', { name: /^Weekly digest/ }),
    ).toHaveCount(0);

    const reference = section.getByTestId(
      'agent-artifact-capability_reference',
    );
    await expect(reference).toHaveCount(1);
    await expect(reference).toContainText('Recommended');
    await expect(reference).toContainText('External');
    await expect(reference).toContainText(externalReferenceReceipt.reason);

    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const reopened = panel.getByTestId('agent-activity-completed').first();
    await expect(reopened).toBeVisible();
    const expandReopened = reopened.getByRole('button', {
      name: 'Expand agent activity',
    });
    if (await expandReopened.isVisible()) await expandReopened.click();
    await expect(
      reopened.getByTestId('agent-artifact-automation_run'),
    ).toHaveCount(2);
    await expect(
      reopened.getByTestId('agent-artifact-capability_reference'),
    ).toHaveCount(1);

    // Keyboard activation opens the automation's Runs with the run selected.
    await failedRun.focus();
    await window.keyboard.press('Enter');
    const runsSection = window.getByTestId('automation-runs-section');
    await expect(runsSection).toBeVisible({ timeout: 15_000 });
    await expect(
      runsSection.locator(
        `[data-run-key="automation-run:${TILE_RUN_ID}"][data-highlighted="true"]`,
      ),
    ).toBeVisible();
  } catch (error) {
    const body = await window
      ?.evaluate(() => document.body.innerText)
      .catch(() => '<renderer unavailable>');
    await testInfo.attach('capability-tiles-failure', {
      body: `${String(error)}\n\n${body}`,
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
