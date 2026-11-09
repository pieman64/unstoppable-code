import type { PipelineRunUsageEvent } from '@canopy/execution-engine/types/observability';

/**
 * Dependency-inverted hook fired whenever a pipeline execution reaches a
 * terminal state and a `pipeline_run_completed` usage event is recorded. Lives
 * in its own leaf module (depending only on shared types) so the telemetry-sync
 * service (CAN-373) can subscribe without importing the pipeline handlers —
 * which would create an import cycle back through the executor / observability
 * wiring.
 *
 * The pipeline usage recorder is the sole emitter; subscribers register here.
 */
export interface PipelineRunCompletionEvent {
  /** Workspace (project) id correlated from `ExecutionState.project_id`. */
  projectId: string;
  /** Worktree id correlated from `ExecutionState.worktree_id`. */
  worktreeId: string;
  /** The recorded `pipeline_run_completed` usage event. */
  event: PipelineRunUsageEvent;
}

export type PipelineRunCompletionListener = (
  event: PipelineRunCompletionEvent,
) => void;

const listeners = new Set<PipelineRunCompletionListener>();

export function addPipelineRunCompletionListener(
  fn: PipelineRunCompletionListener,
): void {
  listeners.add(fn);
}

export function removePipelineRunCompletionListener(
  fn: PipelineRunCompletionListener,
): void {
  listeners.delete(fn);
}

export function emitPipelineRunCompletion(
  event: PipelineRunCompletionEvent,
): void {
  listeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Listener failures must not disrupt pipeline execution/recording.
    }
  });
}
