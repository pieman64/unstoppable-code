import type {
  BackgroundProcess,
  AgentArtifactCarryByTurn,
  AgentArtifactCarryReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  GitHubWorkflowRunWatchProgress,
  PersistedChatMessage,
  PipelineRunArtifactReceiptV1,
  AppAdvisorWatcherSummary,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import type { DisplayBlock, TurnGroupOrMessage } from './types';
import { isClaudeAgentRunning, codexAgentState } from './agent-block-state';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  buildGitHubWorkflowRunArtifactReceipt,
  buildPipelineRunArtifactReceipt,
  isSameAgentArtifactCarryReceipt,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  createEmptyAgentArtifactProjectionCache,
  projectAgentArtifactsWithCarry as projectSharedAgentArtifactsWithCarry,
  type AgentArtifactProjection,
  type AgentArtifactProjectionCache,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';
import {
  watchersForPipelineExecution,
  watchersForSubscriberDestination,
} from '@/components/watchers/watcherFilters';
import { beginTranscriptPerformanceStage } from '@/lib/transcript-performance';

// Receipt parsing, the per-turn segment cache and carry merge live in the
// shared pure module so Electron main attributes Portal pipeline_run chat
// links with the same rules (CAN-3619). This file keeps the renderer-only
// instrumentation, display-block selection and watcher filters.
export {
  createEmptyAgentArtifactProjectionCache,
  mergeAgentArtifactTurn,
  type AgentArtifactProjection,
  type AgentArtifactProjectionCache,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';

/**
 * Project presentation-safe receipts from a persisted transcript. Tool calls
 * are owned by the most recent user turn; only successful, recognized action
 * dispatch results participate.
 */
export function projectAgentArtifacts(
  messages: readonly PersistedChatMessage[],
): AgentArtifactProjection {
  return projectAgentArtifactsWithCarry(messages);
}

/**
 * Renderer entry point for the shared per-turn projection; records the
 * transcript performance stage around the shared implementation.
 */
export function projectAgentArtifactsWithCarry(
  messages: readonly PersistedChatMessage[],
  carryByTurn?: AgentArtifactCarryByTurn,
  cache: AgentArtifactProjectionCache = createEmptyAgentArtifactProjectionCache(),
): AgentArtifactProjection {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'artifact_projection',
    { messages: messages.length },
  );
  return projectSharedAgentArtifactsWithCarry(
    messages,
    carryByTurn,
    cache,
    (stats) => {
      finishPerformanceStage({ turns: stats.turns, segments: stats.segments });
    },
  );
}

/** Reuse the already-merged chat blocks, including their complete child activity. */
export function selectActiveAgentBlocks(
  groups: readonly TurnGroupOrMessage[],
  processes: readonly BackgroundProcess[],
  chatId: string,
): DisplayBlock[] {
  const latest = new Map<string, DisplayBlock>();
  const nativeStatuses = new Map(
    processes
      .filter((process) => process.chatId === chatId)
      .map((process) => [process.toolUseId, process.status]),
  );
  const visit = (block: DisplayBlock): void => {
    if (block.type === 'delegated_agent_call') {
      const key = `managed:${block.delegationId}`;
      const previous = latest.get(key);
      if (
        !previous ||
        previous.type !== 'delegated_agent_call' ||
        (block.runGeneration ?? 1) >= (previous.runGeneration ?? 1)
      ) {
        latest.set(key, block);
      }
    } else if (block.type === 'agent') {
      latest.set(`claude:${block.toolUseId}`, block);
    } else if (block.type === 'codex_agent') {
      latest.set(`codex:${block.agentBlockId}`, block);
    }
    if ('subBlocks' in block) block.subBlocks.forEach(visit);
  };
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group' ? group.assistantMessages : [group.message];
    for (const message of messages) message.blocks.forEach(visit);
  }
  return Array.from(latest.values()).filter((block) => {
    if (block.type === 'delegated_agent_call') {
      return (
        block.executionMode === 'background' &&
        (block.status === 'pending' || block.status === 'running')
      );
    }
    if (block.type === 'agent') {
      return (
        block.runInBackground &&
        isClaudeAgentRunning(
          true,
          block.result,
          block.taskOutputResult,
          nativeStatuses.get(block.toolUseId),
        )
      );
    }
    return block.type === 'codex_agent' && codexAgentState(block).running;
  });
}

export function selectWatchedChatInitiatedRuns(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): PipelineRunArtifactReceiptV1[] {
  return selectWatchedPipelineRuns(runs, [], watchers, destination);
}

function initialReceiptStatus(
  status: string | undefined,
): PipelineRunArtifactReceiptV1['initialStatus'] {
  return status === 'running' || status === 'paused' ? status : 'pending';
}

function receiptFromExecutionSummary(
  summary: ExecutionSummary,
): PipelineRunArtifactReceiptV1 | null {
  if (!summary.project_id || !summary.worktree_id) return null;
  return buildPipelineRunArtifactReceipt({
    operation: 'pipeline.watch',
    executionId: summary.id,
    pipelineId: summary.pipeline_id,
    pipelineName: summary.pipeline_name,
    initialStatus: initialReceiptStatus(summary.status),
    queuedAt: summary.started_at,
    ...(summary.status !== 'pending' ? { startedAt: summary.started_at } : {}),
    projectId: summary.project_id,
    worktreeId: summary.worktree_id,
    createdAt: summary.started_at,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: summary.id,
      projectId: summary.project_id,
      worktreeId: summary.worktree_id,
    },
  });
}

function receiptFromPinnedWatcher(
  watcher: AppAdvisorWatcherSummary,
): PipelineRunArtifactReceiptV1 | null {
  if (
    watcher.trigger !== 'worktree_pipeline_completion' ||
    watcher.target.kind !== 'worktree_pipeline' ||
    !watcher.target.executionId ||
    !watcher.target.pipelineId ||
    !watcher.target.executionStartedAt
  ) {
    return null;
  }
  return buildPipelineRunArtifactReceipt({
    operation: 'pipeline.watch',
    executionId: watcher.target.executionId,
    pipelineId: watcher.target.pipelineId,
    pipelineName: watcher.target.pipelineName ?? watcher.target.pipelineId,
    initialStatus: initialReceiptStatus(watcher.target.executionStatus),
    queuedAt: watcher.target.executionStartedAt,
    ...(watcher.target.executionStatus !== 'pending'
      ? { startedAt: watcher.target.executionStartedAt }
      : {}),
    projectId: watcher.target.projectId,
    worktreeId: watcher.target.worktreeId,
    createdAt: watcher.target.executionStartedAt,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: watcher.target.executionId,
      projectId: watcher.target.projectId,
      worktreeId: watcher.target.worktreeId,
    },
  });
}

/**
 * Resolve every run this chat is actively watching. Existing transcript
 * receipts remain authoritative, but watcher-pinned or currently active
 * executions can contribute a card even when another surface started them.
 */
export function selectWatchedPipelineRuns(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  summaries: readonly ExecutionSummary[],
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): PipelineRunArtifactReceiptV1[] {
  const activeDestinationWatchers = watchersForSubscriberDestination(
    [...watchers],
    destination,
  ).filter((watcher) => watcher.status === 'active');
  const selected = new Map<string, PipelineRunArtifactReceiptV1>();
  const summariesById = new Map(
    summaries.map((summary) => [summary.id, summary]),
  );
  for (const receipt of Object.values(runs)) {
    const matching = watchersForPipelineExecution(activeDestinationWatchers, {
      projectId: receipt.projectId,
      worktreeId: receipt.worktreeId,
      executionId: receipt.executionId,
      pipelineId: receipt.pipelineId,
    });
    if (matching.length === 0) continue;
    const pinned = matching.some(
      (watcher) =>
        watcher.target.kind === 'worktree_pipeline' &&
        watcher.target.executionId === receipt.executionId,
    );
    const status =
      summariesById.get(receipt.executionId)?.status ?? receipt.initialStatus;
    if (
      !pinned &&
      status !== 'pending' &&
      status !== 'running' &&
      status !== 'paused'
    ) {
      continue;
    }
    selected.set(receipt.executionId, receipt);
  }
  for (const summary of summaries) {
    const matching = watchersForPipelineExecution(activeDestinationWatchers, {
      projectId: summary.project_id,
      worktreeId: summary.worktree_id,
      executionId: summary.id,
      pipelineId: summary.pipeline_id,
    });
    if (matching.length === 0) continue;
    const pinned = matching.some(
      (watcher) =>
        watcher.target.kind === 'worktree_pipeline' &&
        watcher.target.executionId === summary.id,
    );
    if (
      !pinned &&
      summary.status !== 'pending' &&
      summary.status !== 'running' &&
      summary.status !== 'paused'
    ) {
      continue;
    }
    const receipt = receiptFromExecutionSummary(summary);
    if (receipt) selected.set(summary.id, receipt);
  }
  for (const watcher of activeDestinationWatchers) {
    const receipt = receiptFromPinnedWatcher(watcher);
    if (receipt && !selected.has(receipt.executionId)) {
      selected.set(receipt.executionId, receipt);
    }
  }
  return Array.from(selected.values()).sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt),
  );
}

function receiptFromGitHubProgress(
  watcher: AppAdvisorWatcherSummary,
  run: GitHubWorkflowRunWatchProgress,
  createdAt: string,
  watcherId = watcher.id,
): GitHubWorkflowRunArtifactReceiptV1 {
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt,
    watcherId,
    repository: run.repository,
    runId: run.runId,
    runAttempt: run.runAttempt,
    ...(run.workflowName ? { workflowName: run.workflowName } : {}),
    ...(run.runNumber !== undefined ? { runNumber: run.runNumber } : {}),
    htmlUrl: run.htmlUrl,
    state: run.state,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    observedAt: run.observedAt,
    ...(run.jobs ? { jobs: run.jobs } : {}),
    ...(run.definition ? { definition: run.definition } : {}),
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: run.repository,
      runId: run.runId,
      htmlUrl: run.htmlUrl,
    },
  });
}

/**
 * The newest observation a run snapshot carries. Job cursors advance without
 * replacing the run snapshot, so the run's own `observedAt` alone would hide a
 * job-only change.
 */
function latestObservedAt(run: {
  observedAt: string;
  jobs?: readonly { observedAt: string }[];
}): string {
  let latest = run.observedAt;
  for (const job of run.jobs ?? []) {
    if (job.observedAt.localeCompare(latest) > 0) latest = job.observedAt;
  }
  return latest;
}

/**
 * Resolve every GitHub workflow run this chat is actively watching, one
 * receipt per run. When several watchers follow the same run the most recent
 * observation wins. Only active watchers whose destination is this chat
 * contribute; their progress comes from the watcher's own polling, so no
 * additional GitHub request is ever made here. Each receipt is then refreshed
 * from `completedWatchers` exactly as the run card refreshes it: the fire
 * history is read separately and can be newer, and two writers recording
 * different snapshots of one run would overwrite each other on every render.
 */
export function selectWatchedGitHubWorkflowRuns(
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
  completedWatchers: readonly AppAdvisorWatcherSummary[] = [],
): GitHubWorkflowRunArtifactReceiptV1[] {
  const activeDestinationWatchers = watchersForSubscriberDestination(
    [...watchers],
    destination,
  ).filter((watcher) => watcher.status === 'active');
  const selected = new Map<string, GitHubWorkflowRunArtifactReceiptV1>();
  for (const watcher of activeDestinationWatchers) {
    if (
      watcher.trigger !== 'github_workflow_runs_changed' ||
      !watcher.githubProgress
    ) {
      continue;
    }
    for (const run of watcher.githubProgress.runs) {
      const receipt = receiptFromGitHubProgress(
        watcher,
        run,
        watcher.createdAt,
      );
      const existing = selected.get(receipt.dedupeKey);
      if (
        !existing ||
        latestObservedAt(existing).localeCompare(latestObservedAt(run)) <= 0
      ) {
        selected.set(receipt.dedupeKey, receipt);
      }
    }
  }
  const known = [...watchers, ...completedWatchers];
  return Array.from(selected.values(), (receipt) =>
    refreshGitHubWorkflowRunReceipt(receipt, known),
  ).sort(
    (left, right) =>
      (left.startedAt ?? left.createdAt).localeCompare(
        right.startedAt ?? right.createdAt,
      ) || left.runId.localeCompare(right.runId),
  );
}

/**
 * Bring a carried GitHub run receipt up to date from any watcher summary
 * (active or recently completed) that observed the same run more recently.
 * Returns the same reference when nothing newer is known so memoized cards
 * and carry writes stay quiet. Identity, creation time, and the originating
 * watcher id are preserved; an older observation never regresses the card.
 */
export function refreshGitHubWorkflowRunReceipt(
  receipt: GitHubWorkflowRunArtifactReceiptV1,
  watchers: readonly AppAdvisorWatcherSummary[],
): GitHubWorkflowRunArtifactReceiptV1 {
  let best = receipt;
  for (const watcher of watchers) {
    if (
      watcher.id !== receipt.watcherId ||
      watcher.trigger !== 'github_workflow_runs_changed' ||
      !watcher.githubProgress
    ) {
      continue;
    }
    for (const run of watcher.githubProgress.runs) {
      if (
        run.repository !== receipt.repository ||
        run.runId !== receipt.runId ||
        run.runAttempt !== receipt.runAttempt ||
        latestObservedAt(run).localeCompare(latestObservedAt(best)) < 0
      ) {
        continue;
      }
      const candidate = receiptFromGitHubProgress(
        watcher,
        run,
        receipt.createdAt,
        receipt.watcherId,
      );
      if (!isSameAgentArtifactCarryReceipt(best, candidate)) best = candidate;
    }
  }
  return best;
}

/**
 * Everything a chat carries forward while it watches: pipeline runs (live
 * state read from the execution store) plus GitHub workflow runs (snapshot
 * embedded from the watcher's progress projection).
 */
export function selectWatchedCarryReceipts(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  summaries: readonly ExecutionSummary[],
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
  completedWatchers: readonly AppAdvisorWatcherSummary[] = [],
): AgentArtifactCarryReceiptV1[] {
  return [
    ...selectWatchedPipelineRuns(runs, summaries, watchers, destination),
    ...selectWatchedGitHubWorkflowRuns(
      watchers,
      destination,
      completedWatchers,
    ),
  ];
}
