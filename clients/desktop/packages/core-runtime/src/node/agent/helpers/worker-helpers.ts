import type {
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  WorkerAgentHelperRunParams,
  WorkerAgentHelperRunResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcherInstructionHandlerMap } from '../../../runtime/types';
import { KeyedOutcomes } from '../../operations/keyed-outcomes';

export interface HelperExecutionWorker {
  run(
    params: WorkerAgentHelperRunParams,
    signal: AbortSignal,
  ): Promise<WorkerAgentHelperRunResult>;
}

export interface WorkerAgentHelperHandlers {
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS
  >;
}

export function helperLaunchUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.agent.helperLaunchUnavailable',
    message: 'Core has not prepared this helper run.',
    retry: { kind: 'never' },
  });
}

export function helperIdempotencyKeyReusedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.agent.idempotencyKeyReused',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

export function createWorkerAgentHelperHandlers(
  worker: HelperExecutionWorker,
): WorkerAgentHelperHandlers {
  const outcomes = new KeyedOutcomes<WorkerAgentHelperRunResult>({
    reusedError: helperIdempotencyKeyReusedError,
  });
  return {
    instructions: {
      'worker.agent.helper.run': (params, context) =>
        outcomes.run(context, params, () => worker.run(params, context.signal)),
    },
  };
}
