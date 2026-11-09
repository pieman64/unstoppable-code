import {
  WORKER_PIPELINE_ERROR_MAX_LENGTH,
  type WorkerPipelineExecution,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';

/** Where a run's definition came from, by its preference locator. */
export function definitionSourceOf(
  locator: ExecutionState['pipeline_preference_locator'],
): WorkerPipelineExecution['definitionSource'] {
  if (locator === undefined) return 'inline';
  if (locator.type === 'stored') return locator.source;
  return locator.type === 'shared' ? 'shared' : 'project';
}

export function projectPipelineExecution(
  state: ExecutionState,
): WorkerPipelineExecution {
  const locator = state.pipeline_preference_locator;
  const owner = state.execution_context;
  return {
    executionId: state.id,
    pipelineId: state.pipeline_id,
    name: state.pipeline_snapshot.name.slice(0, 512),
    status: state.status,
    runScope:
      state.scope ??
      (state.worktree_id !== undefined ? 'worktree' : 'directory'),
    definitionSource: definitionSourceOf(locator),
    owner:
      owner !== undefined && parseWorkspaceContext(owner) !== null
        ? owner
        : null,
    workspaceId: state.project_id ?? null,
    worktreeId: state.worktree_id ?? null,
    parentExecutionId: state.parent_execution_id ?? null,
    startedAt: new Date(state.started_at).toISOString(),
    completedAt:
      state.completed_at === undefined
        ? null
        : new Date(state.completed_at).toISOString(),
    pendingPauseCount: state.pending_pauses.length,
    error:
      state.error === undefined
        ? null
        : state.error.slice(0, WORKER_PIPELINE_ERROR_MAX_LENGTH),
  };
}
