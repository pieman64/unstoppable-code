// Deterministic "one Agent activity section per chat" scenario (CAN-4690).
//
// A chat whose first turn launched a pipeline run, whose chat watches a second
// run (a watcher pinned to its execution, launched elsewhere), and whose last
// turn started a managed background delegate that is still running. Every
// state is seeded on disk: no live agents and no network beyond the mocks.
// Shared by chat-agent-activity-single-section.spec.mjs and the CAN-4690
// capture spec under .playwright/can-4690/.

import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import {
  seedPipelineExecution,
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './index.mjs';
import { pinnedAgentHistory } from './pinnedAgentHistory.mjs';

export const SCENARIO = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'single-section-chat',
  chatTitle: 'Single section',
  launchedExecutionId: 'launched-exec',
  watchedExecutionId: 'watched-exec',
  pipelineId: 'single-section-pipeline',
  pipelineName: 'Single section pipeline',
  launchedPipelineId: 'single-section-release',
  launchedPipelineName: 'Release checks',
  T: Date.parse('2026-08-04T12:00:00.000Z'),
};

export function pipelineRunReceipt({
  operation,
  executionId,
  pipelineId,
  pipelineName,
  status,
  at,
  projectId,
  worktreeId,
}) {
  const timestamp = new Date(at).toISOString();
  return {
    version: 1,
    kind: 'pipeline_run',
    operation,
    dedupeKey: `canopy:pipeline_run:execution:${executionId}`,
    createdAt: timestamp,
    executionId,
    pipelineId,
    pipelineName,
    initialStatus: status,
    queuedAt: timestamp,
    startedAt: timestamp,
    projectId,
    worktreeId,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId,
      worktreeId,
    },
  };
}

// One completed turn whose DispatchAction results carry `receipts`. Ids derive
// from `turnId` / `toolId`, so they never collide with pinnedAgentHistory's.
export function dispatchTurn(turnId, toolId, receipts, timestamp, completedAt) {
  return [
    {
      id: turnId,
      role: 'user',
      blocks: [{ type: 'text', text: `Dispatch ${receipts[0].kind}` }],
      timestamp,
    },
    ...receipts.flatMap((receipt, index) => {
      const receiptToolId = `${toolId}-${index + 1}`;
      const offset = index * 2 + 1;
      return [
        {
          id: `${receiptToolId}-use`,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: receiptToolId,
              toolName: 'DispatchAction',
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
              toolName: 'DispatchAction',
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
      blocks: [{ type: 'turn_timer', startedAt: timestamp, completedAt }],
      timestamp: timestamp + receipts.length * 2 + 1,
    },
  ];
}

export function seedPreferences(userDataDir) {
  // Pre-seeding preferences.json makes this profile look like an upgrade to
  // migrateApprovalDefaultsToFullAccess; mark the migration handled, the same
  // way launchCanopy does for its own seed.
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
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
      mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
    },
  });
}

// A watcher pinned to the watched execution, delivering to `destination`.
export function pinnedPipelineWatcher({ id, destination }) {
  const {
    projectId,
    worktreeId,
    watchedExecutionId,
    pipelineId,
    pipelineName,
  } = SCENARIO;
  return {
    id,
    label: 'Single section watcher',
    trigger: 'worktree_pipeline_completion',
    // Main copies the execution's status and start time into the target when
    // it creates a watcher; a seeded watcher must carry them itself, or chats
    // with no execution summary in scope (Cowork, App Advisor) get no card.
    target: {
      kind: 'worktree_pipeline',
      projectId,
      worktreeId,
      executionId: watchedExecutionId,
      pipelineId,
      pipelineName,
      executionStatus: 'running',
      executionStartedAt: watchedExecutionStartedAt(),
    },
    destination,
  };
}

function watchedExecutionStartedAt() {
  return new Date(SCENARIO.T + 30_000).toISOString();
}

// The watched run's execution state on disk, so worktree chats also see it
// through their execution summaries.
export function seedWatchedExecution(userDataDir) {
  const {
    projectId,
    worktreeId,
    watchedExecutionId,
    pipelineId,
    pipelineName,
    T,
  } = SCENARIO;
  return seedPipelineExecution({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    execution: {
      id: watchedExecutionId,
      pipelineId,
      pipelineName,
      status: 'running',
      startedAt: watchedExecutionStartedAt(),
    },
  });
}

// The launched run's execution state on disk: it has finished, so its card
// lives in the launch turn rather than in the pinned section (CAN-4690).
export function seedLaunchedExecution(userDataDir, executionId) {
  const { projectId, worktreeId, launchedPipelineId, launchedPipelineName, T } =
    SCENARIO;
  return seedPipelineExecution({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    execution: {
      id: executionId,
      pipelineId: launchedPipelineId,
      pipelineName: launchedPipelineName,
      status: 'success',
      startedAt: new Date(T + 10_000).toISOString(),
      completedAt: new Date(T + 20_000).toISOString(),
    },
  });
}

// The launch turn first (no watcher targets its run), then the delegate turn,
// whose managed child is still running. pinnedAgentHistory's timestamps come
// after T, so the delegate turn is the last turn group.
export function launchedTurnMessages(executionId, projectId, worktreeId) {
  const {
    launchedPipelineId: pipelineId,
    launchedPipelineName: pipelineName,
    T,
  } = SCENARIO;
  return [
    ...dispatchTurn(
      'launch-turn',
      'launch-tool',
      [
        pipelineRunReceipt({
          operation: 'pipeline.run',
          executionId,
          pipelineId,
          pipelineName,
          status: 'running',
          at: T + 10_000,
          projectId,
          worktreeId,
        }),
      ],
      T,
      T + 5_000,
    ),
    ...pinnedAgentHistory('managed'),
  ];
}

// The worktree chat. `seedWatchers` overwrites the watcher file, so extra
// watchers are passed in rather than seeded in a second call.
export function seedWorktreeScenario({ userDataDir, watchers = [] }) {
  const { projectId, worktreeId, chatId, chatTitle, launchedExecutionId } =
    SCENARIO;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'claude',
    tabs: [
      {
        id: chatId,
        title: chatTitle,
        messages: launchedTurnMessages(
          launchedExecutionId,
          projectId,
          worktreeId,
        ),
      },
    ],
  });
  seedWatchedExecution(userDataDir);
  seedLaunchedExecution(userDataDir, launchedExecutionId);
  seedWatchers({
    userDataDir,
    watchers: [
      pinnedPipelineWatcher({
        id: 'single-section-watcher',
        destination: { projectId, worktreeId, chatId, chatTitle },
      }),
      ...watchers,
    ],
  });
  return SCENARIO;
}
