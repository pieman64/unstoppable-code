import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import {
  DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE,
  setDaemonPipelineOwnerRequestHandler,
  type DaemonPipelineOwnerAnswer,
} from './daemon-pipeline-owner';
import {
  PipelineOwnerRunContext,
  pipelineOwnerFailure,
  type PipelineOwnerRun,
} from './pipeline-owner-requests';

/*
 * Electron main answers the owner requests of the daemon runs with model
 * steps it started (CAN-5095 D14): each goes to its run's owner context, over
 * the one CAN-5771 owner subscription. A request for any other run is
 * refused; its run's scope comes from the start, never from the request.
 */

const contexts = new Map<string, PipelineOwnerRunContext>();

async function answer(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<DaemonPipelineOwnerAnswer> {
  const context = contexts.get(request.executionId);
  if (!context)
    return {
      result: pipelineOwnerFailure(DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE),
    };
  const { result, values } = await context.apply(request, signal);
  return values
    ? { result, execution: { pipelineOwnerValues: values } }
    : { result };
}

/**
 * Answers `run`'s owner requests until the returned detach runs. Attached
 * before its start is sent, since a step can ask before the start returns;
 * detach closes the run's routes, Ledger attempts and tool sessions (D16).
 */
export function attachDaemonPipelineOwnerRun(
  run: PipelineOwnerRun,
): (finalState: ExecutionState | null) => Promise<void> {
  setDaemonPipelineOwnerRequestHandler(answer);
  const context = new PipelineOwnerRunContext(run);
  contexts.set(run.executionId, context);
  let detached = false;
  return async (finalState) => {
    if (detached) return;
    detached = true;
    if (contexts.get(run.executionId) === context)
      contexts.delete(run.executionId);
    await context.close(finalState);
  };
}
