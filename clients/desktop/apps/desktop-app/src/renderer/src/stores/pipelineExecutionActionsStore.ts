import { create } from 'zustand';

/**
 * In-flight guards for pipeline execution actions, shared by every surface
 * that acts on a run (Activity run rows, the compatibility detail modal, and
 * pipeline execution panels). Keeping them renderer-wide means a Retry
 * clicked in a panel disables the same run's Retry in the run list, and a
 * double click on either surface cannot start the action twice.
 *
 * The shapes match the pre-extraction `PipelineRunsSection` state: cancel,
 * resume, debug, and chat follow-up each track one run at a time; retry and
 * rerun track sets.
 */
export interface PipelineExecutionActionsInFlight {
  cancellingId: string | null;
  resumingId: string | null;
  retryingIds: ReadonlySet<string>;
  rerunningIds: ReadonlySet<string>;
  debuggingFailureId: string | null;
  chatFollowUpInProgress: boolean;
}

function initialInFlight(): PipelineExecutionActionsInFlight {
  return {
    cancellingId: null,
    resumingId: null,
    retryingIds: new Set<string>(),
    rerunningIds: new Set<string>(),
    debuggingFailureId: null,
    chatFollowUpInProgress: false,
  };
}

export const usePipelineExecutionActionsStore =
  create<PipelineExecutionActionsInFlight>(() => initialInFlight());

/** Adds or removes one id from an in-flight set without mutating it. */
export function withInFlightId(
  ids: ReadonlySet<string>,
  executionId: string,
  inFlight: boolean,
): ReadonlySet<string> {
  const next = new Set(ids);
  if (inFlight) {
    next.add(executionId);
  } else {
    next.delete(executionId);
  }
  return next;
}

export function resetPipelineExecutionActionsStoreForTests(): void {
  usePipelineExecutionActionsStore.setState(initialInFlight(), true);
}
