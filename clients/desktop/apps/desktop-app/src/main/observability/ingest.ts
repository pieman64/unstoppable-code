import {
  createPipelineObservabilityFeed,
  type AgentObservabilityHostTypes,
  type AgentObservabilityIngest,
  type ExecutionObservabilityIngest,
  type PipelineObservabilityFeed,
} from '@canopy/core-runtime/observability';
import { getObservabilityService } from './index';
import type {
  AppDiagnosticRecord,
  ObservabilityService,
  PipelineExecutionStateSyncInput,
  SessionDiagnosticRecord,
  TranscriptSeedOptions,
} from './service';

/** How desktop main binds the agent producer contract's parameters. */
export interface DesktopAgentObservabilityTypes extends AgentObservabilityHostTypes {
  turnStart: Parameters<ObservabilityService['startChatTurn']>[0];
  steeringInput: Parameters<ObservabilityService['observeSteeringInput']>[0];
  transcriptSeed: TranscriptSeedOptions;
  createdPullRequest: Parameters<
    ObservabilityService['recordCreatedPullRequest']
  >[0];
  sessionDiagnostic: SessionDiagnosticRecord;
}

export type DesktopExecutionObservabilityIngest = ExecutionObservabilityIngest<
  PipelineExecutionStateSyncInput,
  AppDiagnosticRecord
> &
  AgentObservabilityIngest<DesktopAgentObservabilityTypes>;

/**
 * The producer-facing view of the service: pipeline steps, chat turns,
 * subagents, helpers, transcripts, usage events, Codex host hooks and
 * process-gone events write through this port, never the service class
 * (CAN-4136, CAN-5096).
 */
export function getExecutionObservabilityIngest(): DesktopExecutionObservabilityIngest {
  return getObservabilityService();
}

/** Feeds a pipeline run's events and step output into observability. */
export function createDesktopPipelineObservabilityFeed(): PipelineObservabilityFeed<PipelineExecutionStateSyncInput> {
  return createPipelineObservabilityFeed(getExecutionObservabilityIngest());
}
