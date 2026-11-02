import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  buildExecutionTree,
  type ExecutionTreeNode,
} from '@canopy/ui-shared/lib/execution-tree';
import type {
  PipelineRunStatus,
  PipelineRunSummary,
} from '../activity/pipeline/PipelineRunRows';

/** Any status outside {@link PipelineRunStatus} reads as `pending`. */
export function normalizePipelineRunStatus(
  status: string | undefined,
): PipelineRunStatus {
  switch (status) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'success':
    case 'failure':
    case 'cancelled':
      return status;
    default:
      return 'pending';
  }
}

/** The run as the receipt captured it when the agent started it. */
export function pipelineRunReceiptSummary(
  receipt: PipelineRunArtifactReceiptV1,
): PipelineRunSummary {
  return {
    id: receipt.executionId,
    pipeline_id: receipt.pipelineId,
    pipeline_name: receipt.pipelineName,
    status: receipt.initialStatus,
    status_reasons: [],
    started_at: receipt.startedAt ?? receipt.queuedAt,
    project_id: receipt.projectId,
    worktree_id: receipt.worktreeId,
  };
}

/**
 * Live fields a host overlays from the run's execution state. `status` is any
 * string and is normalized; an absent field keeps the stored value.
 */
export type PipelineRunReceiptLiveOverride = Partial<
  Pick<
    PipelineRunSummary,
    'status_reasons' | 'planId' | 'rerun_source_id' | 'trigger_source'
  >
> & { readonly status?: string };

export interface PipelineRunReceiptView {
  readonly summary: PipelineRunSummary;
  readonly node: ExecutionTreeNode<PipelineRunSummary>;
  readonly summaryLookup: Readonly<Record<string, PipelineRunSummary>>;
}

function findNode(
  nodes: readonly ExecutionTreeNode<PipelineRunSummary>[],
  executionId: string,
): ExecutionTreeNode<PipelineRunSummary> | undefined {
  for (const node of nodes) {
    if (node.summary.id === executionId) return node;
    const child = findNode(node.children, executionId);
    if (child) return child;
  }
  return undefined;
}

/**
 * The receipt's run merged as receipt snapshot, then the host's stored
 * summary, then its live override, placed in the run tree of `summaries` so
 * sub-pipelines nest under it.
 */
export function pipelineRunReceiptView(
  receipt: PipelineRunArtifactReceiptV1,
  summaries: readonly PipelineRunSummary[],
  liveOverride?: PipelineRunReceiptLiveOverride,
): PipelineRunReceiptView {
  const stored = summaries.find(
    (candidate) => candidate.id === receipt.executionId,
  );
  const snapshot = pipelineRunReceiptSummary(receipt);
  // A host that has not seen the run start yet stores an empty start time;
  // the receipt's queued or started time stands in for it.
  const base: PipelineRunSummary = {
    ...snapshot,
    ...stored,
    started_at:
      stored === undefined || stored.started_at === ''
        ? snapshot.started_at
        : stored.started_at,
  };
  const summary: PipelineRunSummary = {
    ...base,
    status: normalizePipelineRunStatus(liveOverride?.status ?? base.status),
    status_reasons: liveOverride?.status_reasons ?? base.status_reasons,
    planId: liveOverride?.planId ?? base.planId,
    rerun_source_id: liveOverride?.rerun_source_id ?? base.rerun_source_id,
    trigger_source: liveOverride?.trigger_source ?? base.trigger_source,
  };
  const all = [
    ...summaries.filter((candidate) => candidate.id !== summary.id),
    summary,
  ];
  const summaryLookup: Record<string, PipelineRunSummary> = {};
  for (const item of all) summaryLookup[item.id] = item;
  const node = findNode(buildExecutionTree(all), summary.id) ?? {
    summary,
    children: [],
    depth: 0,
  };
  return { summary, node, summaryLookup };
}
