import type {
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  WorkerAgentSubagentRunParams,
  WorkerAgentSubagentRunResult,
  WorkerAgentTurnRunParams,
  WorkerAgentTurnRunResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcherInstructionHandlerMap } from '../../../runtime/types';
import { KeyedOutcomes } from '../../operations/keyed-outcomes';
import { helperIdempotencyKeyReusedError } from '../helpers';
import type { TurnEventSink } from './core-chat-turn-runs';

export interface TurnExecutionWorker {
  run(
    params: WorkerAgentTurnRunParams,
    signal: AbortSignal,
    sink: TurnEventSink,
  ): Promise<WorkerAgentTurnRunResult>;
}

export interface SubagentExecutionWorker {
  run(
    params: WorkerAgentSubagentRunParams,
    signal: AbortSignal,
  ): Promise<WorkerAgentSubagentRunResult>;
}

export interface WorkerAgentRunHandlers {
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS
  >;
}

export function agentRunLaunchUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.agent.runLaunchUnavailable',
    message: 'Core has not prepared this agent run.',
    retry: { kind: 'never' },
  });
}

export function createWorkerAgentRunHandlers(options: {
  turns: TurnExecutionWorker;
  subagents: SubagentExecutionWorker;
  sinkFor: (turnRunId: string) => TurnEventSink | null;
}): WorkerAgentRunHandlers {
  const turns = new KeyedOutcomes<WorkerAgentTurnRunResult>({
    reusedError: helperIdempotencyKeyReusedError,
  });
  const subagents = new KeyedOutcomes<WorkerAgentSubagentRunResult>({
    reusedError: helperIdempotencyKeyReusedError,
  });
  return {
    instructions: {
      'worker.agent.turn.run': (params, context) =>
        turns.run(context, params, () => {
          const sink = options.sinkFor(params.turnRunId);
          if (!sink) return Promise.reject(agentRunLaunchUnavailableError());
          return options.turns.run(params, context.signal, sink);
        }),
      'worker.agent.subagent.run': (params, context) =>
        subagents.run(context, params, () =>
          options.subagents.run(params, context.signal),
        ),
    },
  };
}
