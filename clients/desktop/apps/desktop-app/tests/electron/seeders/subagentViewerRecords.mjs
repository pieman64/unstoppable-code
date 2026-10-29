import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TIMESTAMP = 1788825600000;

function routeSnapshot() {
  return {
    selectedModelId: 'sonnet',
    selectedModelLabel: 'Claude Sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    runtimeModelLabel: 'Claude Sonnet 4.6',
    harnessId: 'claude',
    runtimeKind: 'bundled',
    runnerRegistrationId: 'subagent-viewer-seed',
    runtimeVersion: 'seed-runtime-v1',
    adapterVersion: 'seed-adapter-v1',
    modelSource: 'bundled',
    providerType: 'claude',
    assignmentRevision: 'subagent-viewer-seed-v1',
    billingAuthority: 'subscription',
    aiCreditsRouted: false,
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'high',
    capabilities: [],
    supportedThinkingLevels: ['high'],
    capabilitySnapshotHash: 'subagent-viewer-seed-capabilities',
    capabilityGeneration: 1,
    policyRevision: 'subagent-viewer-seed-policy',
  };
}

function contentHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function retainedRecord({
  userDataDir,
  workspaceId,
  worktreeId,
  chatId,
  node,
}) {
  const route = routeSnapshot();
  const createdAt = TIMESTAMP + node.sequence * 100;
  const startedAt = createdAt + 10;
  const settledAt = createdAt + 90;
  const callKey = contentHash(`call:${node.delegationId}`);
  const error =
    node.status === 'failed'
      ? {
          code: 'runtime_error',
          message: 'The seeded delegate could not complete its review.',
          retryable: false,
        }
      : undefined;
  const isolationRevision = node.isolated ? 'c'.repeat(40) : undefined;
  const executionCwd = node.isolated
    ? path.join(
        userDataDir,
        'workspaces',
        workspaceId,
        'worktree-data',
        worktreeId,
        'delegation',
        'worktrees',
        node.delegationId,
      )
    : undefined;

  // Earlier runs (a node's `earlierRuns`) are retained as history, as after
  // a watcher notification or a user follow-up started a later run.
  const earlierRuns = node.earlierRuns ?? [];
  const runGeneration = earlierRuns.length + 1;
  const history = earlierRuns.map((run, index) => ({
    delegationId: node.delegationId,
    runGeneration: index + 1,
    sequence: 3,
    parentHarnessId: 'claude',
    parentTurnId: 'subagent-viewer-tree-request',
    parentToolCallId: `${node.delegationId}-call`,
    createdAt: createdAt - (earlierRuns.length - index) * 10,
    task: {
      description: node.description,
      prompt: run.prompt,
      executionMode: 'background',
    },
    snapshot: {
      delegationId: node.delegationId,
      status: 'completed',
      outputTruncated: false,
      runGeneration: index + 1,
      finalText: run.text,
      routeSnapshot: route,
    },
    transcript: [
      {
        id: `${node.delegationId}-run-${index + 1}-finding`,
        sequence: 1,
        occurredAt: createdAt - (earlierRuns.length - index) * 10 + 5,
        type: 'text',
        text: run.text,
      },
    ],
  }));
  const prompt =
    node.prompt ?? `Review src/index.ts for ${node.description.toLowerCase()}.`;
  const userFollowUp =
    node.userFollowUp === true
      ? [
          {
            id: `${node.delegationId}-follow-up`,
            sequence: 1,
            occurredAt: startedAt,
            type: 'text',
            text: prompt,
            author: { kind: 'user' },
            delivery: 'follow_up',
          },
        ]
      : [];

  return {
    version: 1,
    ...(history.length > 0 ? { history } : {}),
    ...(node.parentDelegationId
      ? {
          depth: node.depth,
          parentDelegationId: node.parentDelegationId,
          parentRunGeneration: 1,
          parentDescription: node.parentDescription,
        }
      : { depth: node.depth }),
    ...(executionCwd ? { executionCwd, isolationRevision } : {}),
    ...(node.isolated ? { isolationReady: true } : {}),
    parent: {
      harnessId: 'claude',
      projectId: workspaceId,
      worktreeId,
      chatId,
      sessionKey: `${workspaceId}/${worktreeId}/${chatId}`,
      turnId: 'subagent-viewer-tree-request',
      userMessageId: 'subagent-viewer-tree-request',
      toolCallId: `${node.delegationId}-call`,
      runtimeGeneration: 1,
      depth: node.depth - 1,
      ...(node.parentDelegationId
        ? {
            parentDelegationId: node.parentDelegationId,
            parentRunGeneration: 1,
          }
        : {}),
      ...(node.parentDescription
        ? { parentDescription: node.parentDescription }
        : {}),
    },
    task: {
      modelId: route.selectedModelId,
      description: node.description,
      prompt,
      contextPolicy: 'task_only',
      isolation: node.isolated ? 'worktree' : 'shared_worktree',
      executionMode: 'background',
      permissions: { writePaths: ['src/index.ts'] },
    },
    route,
    callKey,
    requestHash: contentHash(`request:${node.delegationId}`),
    createdAt,
    transcriptRevision: 3,
    state: {
      delegationId: node.delegationId,
      runGeneration,
      sequence: 3,
      status: node.status,
      startedAt,
      finishedAt: settledAt,
      outputTruncated: false,
      ...(node.status === 'completed'
        ? { finalText: `${node.description} is complete.` }
        : {}),
      ...(error ? { error } : {}),
      usage: { inputTokens: 420, outputTokens: 120 },
      transcript: [
        ...userFollowUp,
        {
          id: `${node.delegationId}-finding`,
          sequence: userFollowUp.length + 1,
          occurredAt: startedAt + 10,
          type: 'text',
          text:
            node.status === 'failed'
              ? 'The seeded parser review failed before producing a result.'
              : `${node.description} reports that the original cause should be preserved.`,
        },
      ],
    },
    launch: {
      version: 1,
      delegationId: node.delegationId,
      launchKey: callKey,
      runGeneration,
      phase: 'settled',
      terminalStatus: node.status,
    },
    delivery: { status: 'unclaimed' },
  };
}

/**
 * Writes fake, private retained-delegation records for terminal subagent
 * viewer nodes only. Live nodes belong in the transcript fixture instead:
 * broker recovery settles retained live records when no host owns a handle.
 * The isolated delegate intentionally has no materialized worktree; its
 * reader returns the durable "Isolated · missing" state without invoking an
 * agent or creating a worktree.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} options.workspaceId seeded workspace id
 * @param {string} options.worktreeId seeded worktree id
 * @param {string} options.chatId seeded root chat id
 * @param {Array<object>} options.nodes terminal managed tree node definitions
 * @param {'workspaces' | 'app-workspaces'} [options.storageRoot] data-dir
 *   folder the workspace lives in; App Advisor needs `app-workspaces`
 * @returns {{ directory: string, files: string[] }} seeded record paths
 */
export function seedSubagentViewerManagedRecords(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    chatId,
    nodes,
    storageRoot = 'workspaces',
  } = options ?? {};
  if (!userDataDir || !workspaceId || !worktreeId || !chatId) {
    throw new Error('seedSubagentViewerManagedRecords requires a chat scope');
  }
  if (!Array.isArray(nodes)) {
    throw new Error(
      'seedSubagentViewerManagedRecords requires node definitions',
    );
  }
  if (
    nodes.some(
      (node) => node.status !== 'completed' && node.status !== 'failed',
    )
  ) {
    throw new Error(
      'seedSubagentViewerManagedRecords accepts terminal nodes only; seed live nodes in the transcript',
    );
  }

  const directory = path.join(
    userDataDir,
    storageRoot,
    workspaceId,
    'worktree-data',
    worktreeId,
    'delegation',
    'runs',
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const files = nodes.map((node) => {
    const filePath = path.join(directory, `${node.delegationId}.json`);
    writeFileSync(
      filePath,
      JSON.stringify(
        retainedRecord({
          userDataDir,
          workspaceId,
          worktreeId,
          chatId,
          node,
        }),
      ),
      { mode: 0o600 },
    );
    return filePath;
  });
  return { directory, files };
}
