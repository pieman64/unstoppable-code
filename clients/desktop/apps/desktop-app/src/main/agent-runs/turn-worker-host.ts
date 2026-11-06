import type {
  WorkerAgentSubagentRunResult,
  WorkerAgentTurnRunResult,
} from '@canopy/protocol/canopy-core';
import {
  agentRunLaunchUnavailableError,
  type SubagentExecutionWorker,
  type TurnEventSink,
  type TurnExecutionWorker,
} from '@canopy/core-runtime/node/agent/turns';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  stageAgentRun,
  takeStagedAgentRun,
  type StagedAgentRun,
} from './staged-agent-run';

export interface StagedTurn {
  readonly run: StagedAgentRun;
  /** Set by the worker handler before it serves. */
  attach(sink: TurnEventSink): void;
  /** Resolves with the host's settlement; see turn-runs.ts. */
  readonly settlement: Promise<WorkerAgentTurnRunResult>;
  /** The exact-turn Stop, called once when the worker signal aborts. */
  stop(): Promise<void>;
}

export interface StagedSubagent {
  readonly run: StagedAgentRun;
  readonly settlement: Promise<WorkerAgentSubagentRunResult>;
}

// The staged run is the key, so a discarded stage leaves nothing behind.
const stagedTurns = new WeakMap<StagedAgentRun, StagedTurn>();
const stagedSubagents = new WeakMap<StagedAgentRun, StagedSubagent>();

export function stageTurn(turnRunId: string, turn: StagedTurn): void {
  if (turn.run.context.runId !== turnRunId || turn.run.context.kind !== 'turn')
    throw new Error('A staged turn must use its own turn run id.');
  stageAgentRun(turn.run);
  stagedTurns.set(turn.run, turn);
}

export function stageSubagent(
  subagentRunId: string,
  subagent: StagedSubagent,
): void {
  if (
    subagent.run.context.runId !== subagentRunId ||
    subagent.run.context.kind !== 'subagent'
  )
    throw new Error('A staged subagent must use its own subagent run id.');
  stageAgentRun(subagent.run);
  stagedSubagents.set(subagent.run, subagent);
}

function warnStopFailed(error: unknown): void {
  logMainProcessWarn('[turn-worker] The exact-turn Stop failed', error);
}

export const desktopTurnWorker: TurnExecutionWorker = {
  run: async (params, signal, sink): Promise<WorkerAgentTurnRunResult> => {
    const run = takeStagedAgentRun(params.turnRunId);
    const turn = run ? stagedTurns.get(run) : undefined;
    if (!turn) throw agentRunLaunchUnavailableError();
    turn.attach(sink);
    const onAbort = (): void => {
      void turn.stop().catch(warnStopFailed);
    };
    try {
      if (signal.aborted) {
        // Cancelled before serving: nothing reached a provider, so the run
        // is never taken and its expressions never run.
        await turn.stop().catch(warnStopFailed);
        return await turn.settlement;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      turn.run.take();
      return await turn.settlement;
    } finally {
      turn.run.close();
      signal.removeEventListener('abort', onAbort);
    }
  },
};

export const desktopSubagentWorker: SubagentExecutionWorker = {
  run: async (params): Promise<WorkerAgentSubagentRunResult> => {
    const run = takeStagedAgentRun(params.subagentRunId);
    const subagent = run ? stagedSubagents.get(run) : undefined;
    if (!subagent) throw agentRunLaunchUnavailableError();
    // The broker's own stop path stops a subagent (CAN-4115 D13).
    subagent.run.take();
    try {
      return await subagent.settlement;
    } finally {
      subagent.run.close();
    }
  },
};
