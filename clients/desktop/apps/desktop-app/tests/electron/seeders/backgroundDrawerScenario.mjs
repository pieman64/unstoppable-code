// Deterministic background drawer scenario (background drawer consolidation).
//
// A worktree chat whose earlier turn started ten pipeline runs (one waiting
// for input, one paused), with their execution states seeded on disk, two background
// delegates and a Codex child still running, and a turn injected through the
// E2E chat-event ingress that leaves two background shells, one background
// agent and one workflow live after it ends. No live agents, no network.
// Shared by background-drawer.spec.mjs, the Portal drawer spec and the
// capture spec under .playwright/2026-10-23-background-drawer/.

import { dispatchTurn, pipelineRunReceipt } from './agentActivityScenario.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedPipelineExecution,
  seedWatchers,
  seedWorktreeChat,
  turnEventInjector,
} from './index.mjs';

export const DRAWER_SCENARIO = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'background-drawer-chat',
  turnId: 'background-drawer-turn',
  T: Date.parse('2026-10-25T12:00:00.000Z'),
  runs: [
    { id: 'bgd-plan-review', name: 'Plan review', input: true },
    { id: 'bgd-release', name: 'Release checks' },
    { id: 'bgd-docs', name: 'Docs link check' },
    { id: 'bgd-copy', name: 'Audit checkout copy' },
    { id: 'bgd-e2e', name: 'Nightly checkout e2e' },
    { id: 'bgd-lint', name: 'Lint and typecheck' },
    { id: 'bgd-bundle', name: 'Bundle size budget' },
    { id: 'bgd-a11y', name: 'Accessibility audit' },
    { id: 'bgd-deps', name: 'Dependency review' },
    { id: 'bgd-deploy', name: 'Deploy preview', paused: true },
  ],
  shells: [
    { id: 'bgd-shell-dev', command: 'pnpm run dev' },
    { id: 'bgd-shell-tests', command: 'pnpm test src/checkout --watch' },
  ],
  agent: {
    id: 'bgd-agent',
    description: 'Review the checkout validation diff',
  },
  delegates: [
    { id: 'bgd-delegate-e2e', description: 'Fix the flaky checkout e2e' },
    {
      id: 'bgd-delegate-notes',
      description: 'Draft the checkout release notes',
    },
  ],
  codex: {
    id: 'bgd-codex',
    threadId: 'bgd-codex-thread',
    description: 'Audit the coupon rules',
  },
  workflow: {
    id: 'bgd-workflow',
    description: 'Checkout copy review workflow',
    progress: 'Phase 2 of 3: reviewing error messages',
  },
};

/** The turn's live subagents: two background delegates and a Codex child. */
function subagentMessages() {
  const { T, delegates, codex } = DRAWER_SCENARIO;
  return [
    ...delegates.map((delegate, index) => ({
      id: `delegated-agent-${delegate.id}`,
      role: 'assistant',
      timestamp: T + 30 + index,
      blocks: [
        {
          type: 'delegated_agent_call',
          agentBlockId: `delegated-agent-${delegate.id}`,
          delegationId: delegate.id,
          parentTurnId: 'bgd-runs-turn',
          sequence: index + 1,
          createdAt: T + 30 + index,
          selectedModelId: 'sonnet',
          runtimeModelId: 'claude-sonnet-4-6',
          targetHarnessId: 'claude',
          parentToolCallId: `${delegate.id}-call`,
          parentHarnessId: 'claude',
          description: delegate.description,
          prompt: delegate.description,
          executionMode: 'background',
          status: 'running',
          runGeneration: 1,
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'sonnet',
            selectedModelLabel: 'Claude Sonnet',
            runtimeModelId: 'claude-sonnet-4-6',
            harnessId: 'claude',
          },
        },
      ],
    })),
    {
      id: `${codex.id}-message`,
      role: 'assistant',
      timestamp: T + 40,
      blocks: [
        {
          type: 'codex_agent_call',
          agentBlockId: `codex-agent-${codex.id}`,
          callId: codex.id,
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'parent',
          receiverThreadIds: [codex.threadId],
          prompt: codex.description,
          description: codex.description,
          agentsStates: { [codex.threadId]: { status: 'running' } },
        },
      ],
    },
  ];
}

/**
 * Seeds the chat, its run receipts and the runs' execution states; returns
 * each run's seeded state by id.
 */
export function seedBackgroundDrawerChat(userDataDir) {
  const { projectId, worktreeId, chatId, T, runs } = DRAWER_SCENARIO;
  const turn = dispatchTurn(
    'bgd-runs-turn',
    'bgd-runs-tool',
    runs.map((run, index) =>
      pipelineRunReceipt({
        operation: 'pipeline.run',
        executionId: run.id,
        pipelineId: run.id,
        pipelineName: run.name,
        status: 'running',
        at: T + index * 1_000,
        projectId,
        worktreeId,
      }),
    ),
    T,
    T + 20_000,
  );
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'bgd-release-watcher',
        label: 'Release checks',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId,
          worktreeId,
          executionId: 'bgd-release',
          pipelineId: 'bgd-release',
          pipelineName: 'Release checks',
          executionStatus: 'running',
          executionStartedAt: new Date(T + 1000).toISOString(),
        },
        destination: { projectId, worktreeId, chatId },
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Background drawer',
        // The subagents run on after the turn, so they come before its
        // timer.
        messages: [
          ...turn.slice(0, -1),
          ...subagentMessages(),
          ...turn.slice(-1),
        ],
      },
    ],
  });
  const states = {};
  runs.forEach((run, index) => {
    states[run.id] = seedPipelineExecution({
      userDataDir,
      workspaceId: projectId,
      worktreeId,
      execution: {
        id: run.id,
        pipelineId: run.id,
        pipelineName: run.name,
        status: run.input || run.paused ? 'paused' : 'running',
        startedAt: new Date(T + index * 1_000).toISOString(),
        jobs: [
          {
            id: 'build',
            name: 'Build',
            steps: [{ id: 'compile', name: 'Compile' }],
          },
          {
            id: 'verify',
            name: 'Verify',
            steps: [{ id: 'check', name: 'Check' }],
          },
        ],
        ...(run.input
          ? {
              pendingInput: {
                jobId: 'verify',
                stepId: 'check',
                title: 'Approve the plan?',
                message: 'The plan touches checkout and billing.',
              },
            }
          : {}),
      },
    }).state;
  });
  return states;
}

/**
 * Runs a turn that starts the shells and the agent in the background, then
 * ends it, so the chat is left with background work only.
 */
export async function startBackgroundDrawerWork(electronApp) {
  const { projectId, worktreeId, chatId, turnId, T, shells, agent, workflow } =
    DRAWER_SCENARIO;
  const scope = { projectId, worktreeId, chatId };
  await injectChatEvent(electronApp, {
    ...scope,
    data: {
      type: 'claude_terminal_transcript_sync',
      importedEventCount: 1,
      messages: [
        {
          id: turnId,
          role: 'user',
          timestamp: T + 60_000,
          blocks: [
            {
              type: 'text',
              text: 'Start the dev server, the tests and a reviewer.',
            },
          ],
        },
      ],
    },
  });
  await publishTurnLifecycle(electronApp, {
    ...scope,
    turnUserMessageId: turnId,
    phase: 'start',
    atMs: T + 60_000,
  });
  const inject = turnEventInjector(electronApp, {
    ...scope,
    turnUserMessageId: turnId,
  });
  for (const shell of shells) {
    await inject({
      type: 'assistant',
      message: {
        id: `${shell.id}-message`,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: shell.id,
            name: 'Bash',
            input: {
              command: shell.command,
              description: shell.command,
              run_in_background: true,
            },
          },
        ],
      },
    });
    // Registers the task as live in main, so it survives its turn ending.
    await inject({
      type: 'system',
      subtype: 'task_started',
      task_id: `${shell.id}-task`,
      tool_use_id: shell.id,
      is_backgrounded: true,
      description: shell.command,
    });
    await inject({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: shell.id,
            content: `Command running in background with ID: ${shell.id}-task`,
          },
        ],
      },
    });
  }
  await inject({
    type: 'assistant',
    message: {
      id: `${agent.id}-message`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: agent.id,
          name: 'Agent',
          input: {
            subagent_type: 'code-reviewer',
            description: agent.description,
            prompt: agent.description,
            run_in_background: true,
          },
        },
      ],
    },
  });
  await inject({
    type: 'system',
    subtype: 'task_started',
    task_id: `${agent.id}-task`,
    tool_use_id: agent.id,
    task_type: 'local_agent',
    is_backgrounded: true,
    description: agent.description,
  });
  await inject({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: agent.id,
          content: `Async agent launched successfully. agentId: ${agent.id}-task\nThe agent is working in the background.`,
        },
      ],
    },
  });
  await inject({
    type: 'assistant',
    message: {
      id: `${workflow.id}-message`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: workflow.id,
          name: 'Workflow',
          input: { workflow: 'checkout-copy-review' },
        },
      ],
    },
  });
  await inject({
    type: 'system',
    subtype: 'task_started',
    task_id: `${workflow.id}-task`,
    tool_use_id: workflow.id,
    task_type: 'local_workflow',
    is_backgrounded: true,
    description: workflow.description,
  });
  await inject({
    type: 'system',
    subtype: 'task_progress',
    task_id: `${workflow.id}-task`,
    tool_use_id: workflow.id,
    description: workflow.progress,
  });
  await inject({ type: 'result', is_error: false, result: 'Started' });
}
