import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { seedPipelineExecution } from './seedPipelineExecution.mjs';
import { seedEarlyAccess } from './seedEarlyAccess.mjs';
import { writeJson, writeJsonl } from './fsHelpers.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';
import {
  seedSubagentViewerTreeChat,
  SUBAGENT_VIEWER_CHAT_ID,
  SUBAGENT_VIEWER_TREE_IDS,
} from './subagentViewerCapture.mjs';

/**
 * Seed the real observed-cost input surfaces before Electron starts.
 *
 * CostIndex reads `{userDataDir}/agent-observability/audit/<UTC day>.jsonl`
 * and classifies audit records; the first Cost view performs the normal open
 * refresh. Chats, archived-chat metadata, and pipeline execution snapshots are
 * persisted through the existing fixture writers, with no cost-only test API.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} [options.workspaceId] project/workspace identity
 * @param {string} [options.worktreeId] worktree or Work Entry identity
 * @param {boolean} [options.earlyAccess] default true, for flows that drive
 *   Early access layouts; false explicitly disables it. Cost needs neither.
 * @returns {{ ids: object, expected: object, auditFiles: string[] }}
 */
export function seedCostInsights({
  userDataDir,
  workspaceId = 'demo-ts-pnpm-vite',
  worktreeId = 'demo-main',
  earlyAccess = true,
} = {}) {
  if (!userDataDir || !workspaceId || !worktreeId) {
    throw new Error(
      'seedCostInsights requires userDataDir, workspaceId, and worktreeId',
    );
  }
  // Early access starts off without a stored choice.
  if (earlyAccess) seedEarlyAccess({ userDataDir });

  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const ids = {
    twoModelChat: 'cost-two-models',
    rootChat: SUBAGENT_VIEWER_CHAT_ID,
    archivedChat: 'cost-archived-chat',
    nativeSubagent: SUBAGENT_VIEWER_TREE_IDS.native,
    managedDelegation: SUBAGENT_VIEWER_TREE_IDS.idleParent,
    rootExecution: 'cost-pipeline-root',
    childExecution: 'cost-pipeline-child',
    scriptOnlyExecution: 'cost-script-only',
  };

  // The existing subagent fixture supplies a navigable child chat record and
  // stable managed-agent identity that the production subagent router reads.
  const seededRoot = seedSubagentViewerTreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    chatId: ids.rootChat,
  });
  const rootTab = seededRoot?.file?.tabs?.[0]
    ? { ...seededRoot.file.tabs[0], createdAt: at(60) }
    : {
        id: ids.rootChat,
        title: 'Claude subagent review',
        providerType: 'claude',
        createdAt: at(60),
        messages: [],
      };
  const twoModelTab = {
    id: ids.twoModelChat,
    title: 'Two model review',
    providerType: 'claude',
    model: 'sonnet',
    createdAt: at(50),
    messages: [],
  };
  const archivedTab = {
    id: ids.archivedChat,
    title: 'Archived cost review',
    providerType: 'codex',
    createdAt: at(40),
    messages: [],
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [twoModelTab, rootTab],
    activeTabId: ids.twoModelChat,
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      workspaceId,
      'chat-archives',
      `${worktreeId}.json`,
    ),
    {
      version: 1,
      archived: [{ tab: archivedTab, archivedAt: at(10), turnCount: 1 }],
    },
  );

  const pipelineStartedAt = at(17);
  const childStartedAt = at(14);
  const baseTokens = {
    input: 1200,
    output: 300,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  // Ids follow the shapes the observability service writes, slashes included:
  // `chat:<project>/<worktree>/<chat>:<startedAt>`,
  // `pipeline:<run>/<job>/<step>/<attempt>:<startedAt>` and
  // `managed_delegation:<delegation>:<generation>`. The seed name keeps same
  // instant entries distinct, as the service's uuid suffix does.
  const auditId = (name, eventType, startedAt, details) => {
    if (eventType === 'managed_delegation' && details.delegation) {
      return `managed_delegation:${details.delegation.delegationId}:${details.delegation.runGeneration}`;
    }
    if (eventType === 'pipeline_agent_turn') {
      return `pipeline:${details.pipelineExecutionId}/${details.jobId}/${details.stepId}/${details.attempt ?? 0}:${startedAt}`;
    }
    const owner = details.chatId ?? eventType;
    return `chat:${workspaceId}/${worktreeId}/${owner}:${startedAt}:${name}`;
  };
  const record = (
    name,
    eventType,
    provider,
    label,
    startedAt,
    details = {},
  ) => ({
    id: auditId(name, eventType, startedAt, details),
    eventType,
    status: 'success',
    provider,
    label,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 45_000).toISOString(),
    durationMs: 45_000,
    model: provider === 'codex' ? 'gpt-5-codex' : 'claude-sonnet-4-5',
    tokens: baseTokens,
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 3,
    subAgentCount: 0,
    // `canopy` counts the app's own tools; the views name it after the brand.
    toolCounts: { read: 1, bash: 1, canopy: 1 },
    projectId: workspaceId,
    worktreeId,
    billingBasis: provider === 'codex' ? 'api_key' : 'subscription',
    ...details,
  });

  const entries = [
    record(
      'cost-two-models-sonnet',
      'worktree_chat',
      'claude',
      'Two model review',
      at(50),
      {
        chatId: ids.twoModelChat,
        model: 'claude-sonnet-4-5',
        totalCostUsd: 2.4,
      },
    ),
    record(
      'cost-two-models-haiku',
      'worktree_chat',
      'claude',
      'Two model review',
      at(49),
      {
        chatId: ids.twoModelChat,
        model: 'claude-haiku-4-5',
        totalCostUsd: 0.6,
      },
    ),
    record(
      'cost-claude-root-turn',
      'worktree_chat',
      'claude',
      'Claude subagent review',
      at(30),
      {
        chatId: ids.rootChat,
        model: 'claude-sonnet-4-5',
        totalCostUsd: 4,
        subAgentCount: 1,
        subagents: [
          {
            id: ids.nativeSubagent,
            kind: 'claude_task',
            inclusion: 'included',
            costUsd: 0.4,
            label: 'Native parser review',
            model: 'claude-sonnet-4-5',
            // The row's label counts cache reads too: 1.0k, not 400.
            tokens: { input: 320, output: 80, cacheReadInputTokens: 600 },
          },
        ],
        context: {
          endTokens: 32_000,
          peakTokens: 48_000,
          windowTokens: 200_000,
          categories: [
            { name: 'System prompt', tokens: 4_000, kind: 'used' },
            { name: 'Conversation', tokens: 28_000, kind: 'used' },
          ],
        },
        compactions: [{ at: at(29), trigger: 'auto', preTokens: 92_000 }],
        planEvents: { created: 1, approved: 1 },
      },
    ),
    record(
      'cost-managed-delegation',
      'managed_delegation',
      'claude',
      'Finished parser review',
      at(28),
      {
        chatId: ids.rootChat,
        model: 'claude-sonnet-4-5',
        totalCostUsd: 0.7,
        delegation: {
          delegationId: ids.managedDelegation,
          runGeneration: 1,
          parentChatId: ids.rootChat,
          harness: 'claude',
          label: 'Finished parser review',
        },
      },
    ),
    record(
      'cost-chat-title-helper',
      'chat_summary',
      'claude',
      'Chat title helper',
      at(27),
      {
        chatId: ids.rootChat,
        totalCostUsd: 0.1,
      },
    ),
    record(
      'cost-branch-helper',
      'branch_naming',
      'claude',
      'Branch naming helper',
      at(26),
      {
        chatId: ids.rootChat,
        totalCostUsd: 0.2,
      },
    ),
    record(
      'cost-entry-summary-helper',
      'worktree_summary',
      'claude',
      'Entry summary helper',
      at(25),
      {
        totalCostUsd: 0.3,
      },
    ),
    record(
      'cost-archived-turn',
      'worktree_chat',
      'codex',
      'Archived cost review',
      at(20),
      {
        chatId: ids.archivedChat,
        model: 'gpt-5-codex',
        totalCostUsd: 0.8,
      },
    ),
    record(
      'cost-review-attempt-0',
      'pipeline_agent_turn',
      'claude',
      'Release review',
      pipelineStartedAt,
      {
        pipelineId: 'pipeline-cost-review',
        pipelineName: 'Release review',
        pipelineExecutionId: ids.rootExecution,
        jobId: 'review',
        stepId: 'agent-review',
        attempt: 0,
        totalCostUsd: 0.25,
        // Cache tokens count toward a step's token label (13.5k, not 3.0k).
        tokens: {
          ...baseTokens,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 500,
        },
      },
    ),
    record(
      'cost-review-attempt-1',
      'pipeline_agent_turn',
      'claude',
      'Release review',
      at(15),
      {
        pipelineId: 'pipeline-cost-review',
        pipelineName: 'Release review',
        pipelineExecutionId: ids.rootExecution,
        jobId: 'review',
        stepId: 'agent-review',
        attempt: 1,
        totalCostUsd: 0.35,
      },
    ),
    record(
      'cost-verify-agent',
      'pipeline_agent_turn',
      'claude',
      'Release review',
      at(12),
      {
        pipelineId: 'pipeline-cost-review',
        pipelineName: 'Release review',
        pipelineExecutionId: ids.rootExecution,
        jobId: 'verify',
        stepId: 'agent-verify',
        attempt: 0,
        totalCostUsd: 0.5,
      },
    ),
    record(
      'cost-child-agent',
      'pipeline_agent_turn',
      'claude',
      'Nested review',
      childStartedAt,
      {
        pipelineId: 'pipeline-cost-review',
        pipelineName: 'Release review',
        pipelineExecutionId: ids.childExecution,
        rootPipelineExecutionId: ids.rootExecution,
        jobId: 'child-review',
        stepId: 'agent-child',
        attempt: 0,
        totalCostUsd: 0.2,
      },
    ),
    record(
      'cost-pipeline-advisor',
      'pipeline_advisor',
      'claude',
      'Release review Advisor',
      at(11),
      {
        pipelineId: 'pipeline-cost-review',
        pipelineName: 'Release review',
        pipelineExecutionId: ids.rootExecution,
        totalCostUsd: 0.1,
      },
    ),
  ];

  const auditDirectory = path.join(userDataDir, 'agent-observability', 'audit');
  mkdirSync(auditDirectory, { recursive: true });
  const byDay = new Map();
  for (const entry of entries) {
    const day = entry.startedAt.slice(0, 10);
    const dayEntries = byDay.get(day) ?? [];
    dayEntries.push(entry);
    byDay.set(day, dayEntries);
  }
  const auditFiles = [];
  for (const [day, dayEntries] of byDay) {
    const filePath = path.join(auditDirectory, `${day}.jsonl`);
    writeJsonl(filePath, dayEntries);
    auditFiles.push(filePath);
  }

  const agentStep = (id, name, run) => ({ id, name, run });
  const seededExecution = seedPipelineExecution({
    userDataDir,
    workspaceId,
    worktreeId,
    execution: {
      id: ids.rootExecution,
      pipelineId: 'pipeline-cost-review',
      pipelineName: 'Release review',
      startedAt: pipelineStartedAt,
      completedAt: at(10),
      status: 'success',
      jobs: [
        {
          id: 'review',
          name: 'Review',
          steps: [agentStep('agent-review', 'Agent review', 'use codex agent')],
        },
        {
          id: 'verify',
          name: 'Verify',
          steps: [agentStep('agent-verify', 'Agent verify', 'use codex agent')],
        },
      ],
      stepResults: {
        'review.agent-review': {
          agent_provider: 'claude',
          agent_model: 'claude-sonnet-4-5',
          started_at: at(15),
        },
        'verify.agent-verify': {
          agent_provider: 'claude',
          agent_model: 'claude-sonnet-4-5',
          started_at: at(13),
        },
      },
    },
    advisorSnapshot: true,
  });
  const reviewJob = seededExecution.state.jobs.review;
  const reviewStep = reviewJob.steps['agent-review'];
  reviewJob.retry_count = 1;
  reviewJob.retry_history = [
    {
      attempt: 0,
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      steps: {
        'agent-review': {
          ...reviewStep,
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          exit_code: 1,
          started_at: at(17),
          completed_at: at(16),
        },
      },
      started_at: at(17),
      completed_at: at(16),
    },
  ];
  writeJson(seededExecution.stateFilePath, seededExecution.state);

  seedPipelineExecution({
    userDataDir,
    workspaceId,
    worktreeId,
    execution: {
      id: ids.childExecution,
      pipelineId: 'pipeline-cost-review',
      pipelineName: 'Nested review',
      startedAt: childStartedAt,
      completedAt: at(13),
      status: 'success',
      stateOverrides: {
        parent_execution_id: ids.rootExecution,
        parent_step_id: 'agent-verify',
        root_execution_id: ids.rootExecution,
      },
      jobs: [
        {
          id: 'child-review',
          name: 'Child review',
          steps: [agentStep('agent-child', 'Child agent', 'use claude agent')],
        },
      ],
      stepResults: {
        'child-review.agent-child': {
          agent_provider: 'claude',
          agent_model: 'claude-sonnet-4-5',
        },
      },
    },
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId,
    worktreeId,
    execution: {
      id: ids.scriptOnlyExecution,
      pipelineId: 'pipeline-script-only',
      pipelineName: 'Script-only run',
      startedAt: at(5),
      completedAt: at(4),
      status: 'success',
      jobs: [
        {
          id: 'scripts',
          name: 'Scripts',
          steps: [{ id: 'lint', name: 'Lint script', run: 'npm run lint' }],
        },
      ],
    },
  });

  return {
    ids,
    expected: {
      chats: {
        [ids.twoModelChat]: '$3.00',
        [ids.rootChat]: '$5.00',
        [ids.archivedChat]: '$0.80',
      },
      pipelineTotal: '$1.40',
      pipelineSteps: {
        review: '$0.60',
        verify: '$0.50',
        advisor: '$0.10',
        child: '$0.20',
      },
      scopeTotal: '$10.50',
      unattachedTotal: '$0.30',
    },
    auditFiles,
  };
}
