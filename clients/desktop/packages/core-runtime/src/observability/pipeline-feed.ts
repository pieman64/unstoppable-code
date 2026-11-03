import type {
  ExecutionObservabilityIngest,
  PipelineStepOutputObservation,
} from './ports';

/** The pipeline runner callbacks that feed observability. */
export interface PipelineObservabilityFeed<TState> {
  /** Every execution event; the state it carries is the run's latest. */
  onExecutionEvent(event: { readonly state: TState }): void;
  onStepOutput(event: PipelineStepOutputObservation): void;
}

/**
 * Feeds a pipeline run's steps into an ingest: each execution event syncs
 * the steps' audit records from the run state, and step output is parsed
 * into the open step record. A host that runs pipelines, desktop main today
 * and the daemon's worker later, wires its runner callbacks through this.
 */
export function createPipelineObservabilityFeed<TState>(
  ingest: Pick<
    ExecutionObservabilityIngest<TState>,
    'syncPipelineExecutionState' | 'observePipelineOutput'
  >,
): PipelineObservabilityFeed<TState> {
  return {
    onExecutionEvent: (event): void => {
      ingest.syncPipelineExecutionState(event.state);
    },
    onStepOutput: (event): void => {
      ingest.observePipelineOutput(event);
    },
  };
}
