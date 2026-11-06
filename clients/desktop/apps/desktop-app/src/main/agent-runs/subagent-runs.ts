import { randomUUID } from 'node:crypto';
import {
  WORKER_AGENT_SUBAGENT_FAILED_CODE,
  WORKER_AGENT_SUBAGENT_FAILED_MESSAGE,
  type WorkerAgentSubagentRunResult,
} from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { StagedAgentRun, discardStagedAgentRun } from './staged-agent-run';
import { TurnWorkerUnavailableError } from './turn-runs';
import { stageSubagent } from './turn-worker-host';

export interface BeginSubagentRunRequest {
  delegationId: string;
  runGeneration: number;
  harnessId: string;
  scope: { workspaceId: string; worktreeId: string; chatId: string };
  /** The parent chat turn's user message id, when the parent is a chat turn. */
  parentTurnId: string | undefined;
  parentDelegation: { delegationId: string; runGeneration: number } | undefined;
}

export interface SubagentRunHandle {
  readonly subagentRunId: string;
  execute<T>(fn: () => T | Promise<T>): Promise<T>;
  settle(status: 'completed' | 'failed' | 'cancelled'): void;
}

/**
 * One managed subagent generation as a `core.agent.subagent.run` on the
 * in-process worker (CAN-4115), a child of the live run that started it.
 */
export async function beginSubagentRun(
  request: BeginSubagentRunRequest,
): Promise<SubagentRunHandle> {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) throw new TurnWorkerUnavailableError();
  const subagentRunId = randomUUID();
  const staged = new StagedAgentRun({ kind: 'subagent', runId: subagentRunId });
  let resolveSettlement: (result: WorkerAgentSubagentRunResult) => void = () =>
    undefined;
  const settlement = new Promise<WorkerAgentSubagentRunResult>((resolve) => {
    resolveSettlement = resolve;
  });
  let settled = false;
  const settle = (status: 'completed' | 'failed' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    resolveSettlement(
      status === 'failed'
        ? {
            subagentRunId,
            status,
            error: {
              code: WORKER_AGENT_SUBAGENT_FAILED_CODE,
              message: WORKER_AGENT_SUBAGENT_FAILED_MESSAGE,
            },
          }
        : { subagentRunId, status },
    );
  };
  stageSubagent(subagentRunId, { run: staged, settlement });
  const { parentDelegation, parentTurnId, scope } = request;
  const parentOperationId =
    (parentDelegation
      ? runtime.subagentRuns.findLive(
          parentDelegation.delegationId,
          parentDelegation.runGeneration,
        )?.operationId
      : parentTurnId
        ? runtime.chatTurnRuns.findLive(scope, parentTurnId)?.operationId
        : undefined) ?? null;
  let run: Awaited<ReturnType<typeof runtime.subagentRuns.begin>>;
  try {
    run = await runtime.subagentRuns.begin({
      params: {
        subagentRunId,
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        harnessId: request.harnessId.slice(0, 64),
        scope,
      },
      origin: {
        kind: 'system',
        sourceId: `subagent:${request.harnessId.slice(0, 54)}`,
      },
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      parentOperationId,
    });
  } catch (error) {
    discardStagedAgentRun(subagentRunId);
    throw error;
  }
  void run.settled.then((result) => {
    settle(result.status);
    if (!staged.closed) staged.close(new TurnWorkerUnavailableError());
    discardStagedAgentRun(subagentRunId);
  });
  return {
    subagentRunId,
    execute: (fn) => staged.execute(fn),
    settle,
  };
}
