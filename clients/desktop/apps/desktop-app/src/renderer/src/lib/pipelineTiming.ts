import type {
  ExecutionState,
  JobResult,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';

// Timestamp and elapsed-time display helpers live in @canopy/ui-shared/lib so
// the renderer and the shared pipeline popover share one implementation.
import {
  TIMING_NOT_AVAILABLE,
  formatElapsed,
  formatTimingTimestamp,
  getElapsedMs,
  parseIsoToEpoch,
} from '@canopy/ui-shared/lib';

export {
  TIMING_NOT_AVAILABLE,
  formatElapsed,
  formatTimingTimestamp,
  getElapsedMs,
  parseIsoToEpoch,
};
export type { PipelineElapsedOptions } from '@canopy/ui-shared/lib';

export type PipelineTimingKind = 'execution' | 'job' | 'step';
export type PipelineTimingSource = 'current' | 'retry' | 'iteration';
export type PipelineTimingStatus =
  | ExecutionState['status']
  | JobResult['status']
  | StepResult['status'];

interface ActiveTimingOptions {
  kind: PipelineTimingKind;
  status: PipelineTimingStatus;
  source?: PipelineTimingSource;
  startedAt?: string;
  completedAt?: string;
}

export function isActiveTiming({
  kind,
  status,
  source = 'current',
  startedAt,
  completedAt,
}: ActiveTimingOptions): boolean {
  if (source === 'retry' || source === 'iteration') {
    return false;
  }

  if (parseIsoToEpoch(startedAt) === null) {
    return false;
  }

  if (parseIsoToEpoch(completedAt) !== null) {
    return false;
  }

  if (kind === 'execution') {
    return status === 'running';
  }

  if (kind === 'job') {
    return status === 'running' || status === 'restarting';
  }

  return status === 'running';
}
