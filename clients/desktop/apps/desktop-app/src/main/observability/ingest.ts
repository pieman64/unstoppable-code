import {
  createPipelineObservabilityFeed,
  type ExecutionObservabilityIngest,
  type PipelineObservabilityFeed,
} from '@canopy/core-runtime/observability';
import { getObservabilityService } from './index';
import type {
  AppDiagnosticRecord,
  PipelineExecutionStateSyncInput,
} from './service';

export type DesktopExecutionObservabilityIngest = ExecutionObservabilityIngest<
  PipelineExecutionStateSyncInput,
  AppDiagnosticRecord
>;

/**
 * The producer-facing view of the service: pipeline steps, Codex host hooks
 * and process-gone events write through this port, never the service class.
 */
export function getExecutionObservabilityIngest(): DesktopExecutionObservabilityIngest {
  return getObservabilityService();
}

/** Feeds a pipeline run's events and step output into observability. */
export function createDesktopPipelineObservabilityFeed(): PipelineObservabilityFeed<PipelineExecutionStateSyncInput> {
  return createPipelineObservabilityFeed(getExecutionObservabilityIngest());
}
