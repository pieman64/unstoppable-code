import type {
  WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
  WorkerAgentSignInRunParams,
  WorkerAgentSignInRunResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcherInstructionHandlerMap } from '../../../runtime/types';
import { KeyedOutcomes } from '../../operations/keyed-outcomes';
import { helperIdempotencyKeyReusedError } from '../helpers/worker-helpers';

export interface SignInExecutionWorker {
  run(
    params: WorkerAgentSignInRunParams,
    signal: AbortSignal,
  ): Promise<WorkerAgentSignInRunResult>;
}

export interface WorkerAgentSignInHandlers {
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS
  >;
}

export function signInLaunchUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.agent.signInLaunchUnavailable',
    message: 'Core has not prepared this sign-in.',
    retry: { kind: 'never' },
  });
}

export function createWorkerAgentSignInHandlers(
  worker: SignInExecutionWorker,
): WorkerAgentSignInHandlers {
  const outcomes = new KeyedOutcomes<WorkerAgentSignInRunResult>({
    reusedError: helperIdempotencyKeyReusedError,
  });
  return {
    instructions: {
      'worker.agent.signIn.run': (params, context) =>
        outcomes.run(context, params, () => worker.run(params, context.signal)),
    },
  };
}
