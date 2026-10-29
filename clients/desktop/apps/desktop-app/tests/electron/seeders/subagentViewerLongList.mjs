import { seedWorktreeChat } from './index.mjs';

export const SUBAGENT_VIEWER_LONG_LIST_CHAT_ID = 'subagent-viewer-long-list';
/** Enough rows to overflow the Subagents list in the default E2E window. */
export const SUBAGENT_VIEWER_LONG_LIST_COUNT = 40;

const TIMESTAMP = 1788825600000;

function agentToolUseId(index) {
  return `long-list-agent-${String(index).padStart(2, '0')}`;
}

/** The tool use ids of the seeded native agents, in list order. */
export function subagentViewerLongListAgentIds() {
  return Array.from({ length: SUBAGENT_VIEWER_LONG_LIST_COUNT }, (_, index) =>
    agentToolUseId(index + 1),
  );
}

/** The long-list chat tab, for callers that seed several chats at once. */
export function subagentViewerLongListTab() {
  const agentMessages = subagentViewerLongListAgentIds().flatMap(
    (toolUseId, index) => [
      {
        id: `${toolUseId}-dispatch`,
        role: 'assistant',
        timestamp: TIMESTAMP + 10 + index * 10,
        blocks: [
          {
            type: 'tool_use',
            toolUseId,
            toolName: 'Agent',
            input: JSON.stringify({
              description: `Review parser module ${index + 1}`,
              prompt: `Review parser module ${index + 1} and report one finding.`,
              subagent_type: 'Explore',
              run_in_background: false,
            }),
          },
        ],
      },
      {
        id: `${toolUseId}-result`,
        role: 'assistant',
        timestamp: TIMESTAMP + 15 + index * 10,
        blocks: [
          {
            type: 'tool_result',
            toolUseId,
            toolName: 'Agent',
            output: `Parser module ${index + 1} has no open findings.`,
            isError: false,
          },
        ],
      },
    ],
  );
  return {
    id: SUBAGENT_VIEWER_LONG_LIST_CHAT_ID,
    title: 'Parser module review',
    providerType: 'claude',
    executionHarness: 'claude',
    model: 'sonnet',
    messages: [
      {
        id: 'long-list-request',
        role: 'user',
        timestamp: TIMESTAMP,
        blocks: [
          {
            type: 'text',
            text: 'Review every parser module with one subagent each.',
          },
        ],
      },
      ...agentMessages,
      {
        id: 'long-list-answer',
        role: 'assistant',
        timestamp: TIMESTAMP + 1000,
        blocks: [{ type: 'text', text: 'Every parser module was reviewed.' }],
      },
      {
        id: 'long-list-turn-timer',
        role: 'system',
        timestamp: TIMESTAMP + 1100,
        blocks: [
          {
            type: 'turn_timer',
            startedAt: TIMESTAMP,
            completedAt: TIMESTAMP + 1100,
          },
        ],
      },
    ],
  };
}

/**
 * Seed one root chat that started many finished Claude Task agents, so the
 * Subagents list has more rows than fit in its panel. Callers seed the demo
 * worktree first. This rewrites the worktree's chats file.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} [options.workspaceId] seeded workspace id
 * @param {string} [options.worktreeId] seeded worktree id
 * @returns {ReturnType<typeof seedWorktreeChat> & {chatId: string}}
 */
export function seedSubagentViewerLongListChat(options) {
  const {
    userDataDir,
    workspaceId = 'demo-ts-pnpm-vite',
    worktreeId = 'demo-main',
  } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedSubagentViewerLongListChat requires userDataDir');
  }
  const tab = subagentViewerLongListTab();
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType: 'claude',
    activeTabId: tab.id,
    tabs: [tab],
  });
  return { ...seeded, chatId: tab.id };
}

export const SUBAGENT_VIEWER_MANAGED_LONG_LIST_CHAT_ID =
  'subagent-viewer-managed-long-list';

function managedRouteSnapshot() {
  return {
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    selectedModelLabel: 'Claude Sonnet',
    runtimeModelLabel: 'Claude Sonnet 4.6',
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'high',
    harnessId: 'claude',
    runtimeKind: 'bundled',
    runnerRegistrationId: 'capture-runner',
    runtimeVersion: 'capture-runtime-v1',
    adapterVersion: 'capture-adapter-v1',
    modelSource: 'bundled',
    providerType: 'claude',
    assignmentRevision: 'capture-assignment-v1',
    billingAuthority: 'subscription',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: ['high'],
    capabilitySnapshotHash: 'capture-capabilities',
    capabilityGeneration: 1,
    policyRevision: 'capture-policy-v1',
  };
}

/**
 * A root chat that delegated many finished managed tasks. The Portal projects
 * only managed delegations, so its long Subagents list needs this chat.
 */
export function subagentViewerManagedLongListTab() {
  const blocks = Array.from(
    { length: SUBAGENT_VIEWER_LONG_LIST_COUNT },
    (_, index) => {
      const sequence = index + 1;
      const delegationId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      const description = `Review parser module ${sequence}`;
      return {
        type: 'delegated_agent_call',
        agentBlockId: `delegated-agent-${delegationId}`,
        delegationId,
        runGeneration: 1,
        sequence,
        outputTruncated: false,
        parentHarnessId: 'claude',
        parentTurnId: 'managed-long-list-request',
        parentToolCallId: `${delegationId}-call`,
        selectedModelId: 'sonnet',
        runtimeModelId: 'claude-sonnet-4-6',
        targetHarnessId: 'claude',
        requestedThinkingLevel: 'high',
        effectiveThinkingLevel: 'high',
        routeSnapshot: managedRouteSnapshot(),
        status: 'completed',
        approvalPending: false,
        description,
        prompt: `Review parser module ${sequence} and report one finding.`,
        executionMode: 'background',
        permissions: { writePaths: ['src/index.ts'] },
        workspaceObservation: {
          consistency: 'live_shared_worktree',
          headRevision: 'a'.repeat(40),
          dirty: false,
          observedAt: TIMESTAMP + sequence * 100,
        },
        depth: 1,
        usage: { inputTokens: 420, outputTokens: 120 },
        finalText: `${description} is complete.`,
        createdAt: TIMESTAMP + sequence * 100,
      };
    },
  );
  return {
    id: SUBAGENT_VIEWER_MANAGED_LONG_LIST_CHAT_ID,
    title: 'Parser module delegation',
    providerType: 'claude',
    executionHarness: 'claude',
    model: 'sonnet',
    messages: [
      {
        id: 'managed-long-list-request',
        role: 'user',
        timestamp: TIMESTAMP,
        blocks: [
          {
            type: 'text',
            text: 'Delegate one review per parser module.',
          },
        ],
      },
      {
        id: 'managed-long-list-events',
        role: 'system',
        timestamp: TIMESTAMP + 100,
        blocks,
      },
      {
        id: 'managed-long-list-answer',
        role: 'assistant',
        timestamp: TIMESTAMP + 9000,
        blocks: [{ type: 'text', text: 'Every parser module was reviewed.' }],
      },
      {
        id: 'managed-long-list-turn-timer',
        role: 'system',
        timestamp: TIMESTAMP + 9100,
        blocks: [
          {
            type: 'turn_timer',
            startedAt: TIMESTAMP,
            completedAt: TIMESTAMP + 9100,
          },
        ],
      },
    ],
  };
}
