import { createHash } from 'node:crypto';
import {
  WORKER_AGENT_HELPER_FAILED_CODE,
  WORKER_AGENT_HELPER_FAILED_MESSAGE,
  type WorkerAgentHelperRunParams,
  type WorkerAgentHelperRunResult,
  type WorkerAgentHelperUsage,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import {
  helperLaunchUnavailableError,
  type HelperExecutionWorker,
} from '@canopy/core-runtime/node/agent/helpers';
import {
  readHelperUsage,
  type HelperUsage,
} from '@canopy/desktop-shared/lib/helper-usage';
import { getStructuredHelperQueryErrorUsage } from '@canopy/desktop-shared/lib/structured-helper-query';
import { runInHelperWorker } from './helper-worker-context';

export type HelperLaunch<T> = (workerSignal: AbortSignal) => Promise<T>;
export type HelperLaunchSettlement<T> =
  | { ran: true; status: 'fulfilled'; value: T }
  | { ran: true; status: 'rejected'; error: unknown }
  | { ran: false };

type StagedRun = (
  params: WorkerAgentHelperRunParams,
  signal: AbortSignal,
) => Promise<WorkerAgentHelperRunResult>;
const stagedRuns = new Map<string, StagedRun>();

function toWireUsage(usage: HelperUsage | undefined): WorkerAgentHelperUsage {
  const wire: WorkerAgentHelperUsage = {};
  const counts = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'reasoningOutputTokens',
    'messageCount',
    'assistantMessageCount',
  ] as const;
  for (const field of counts) {
    const value = usage?.[field];
    if (
      value !== undefined &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
    )
      wire[field] = Math.trunc(value);
  }
  const cost = usage?.totalCostUsd;
  if (
    cost !== undefined &&
    Number.isFinite(cost) &&
    cost >= 0 &&
    cost <= 1_000_000
  )
    wire.totalCostUsd = cost;
  return wire;
}

function digestHelperResult(
  value: unknown,
): Extract<WorkerAgentHelperRunResult, { status: 'succeeded' }>['result'] {
  const text = stableStringify(value);
  return {
    present: value !== null && value !== undefined,
    sha256:
      text === undefined
        ? null
        : `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    bytes: text === undefined ? null : Buffer.byteLength(text, 'utf8'),
  };
}

export function stageHelperLaunch<T>(
  helperRunId: string,
  staged: {
    launch: HelperLaunch<T>;
    usageOf: (value: T) => HelperUsage | undefined;
  },
): { take(): HelperLaunchSettlement<T> } {
  const settled: { value: HelperLaunchSettlement<T> } = {
    value: { ran: false },
  };
  stagedRuns.set(helperRunId, async (params, signal) => {
    let outcome: HelperLaunchSettlement<T>;
    try {
      const value = await runInHelperWorker(
        { helperRunId, kind: params.kind },
        () => staged.launch(signal),
      );
      outcome = { ran: true, status: 'fulfilled', value };
    } catch (error) {
      outcome = { ran: true, status: 'rejected', error };
    }
    settled.value = outcome;
    const usage = toWireUsage(
      outcome.status === 'fulfilled'
        ? staged.usageOf(outcome.value)
        : (getStructuredHelperQueryErrorUsage(outcome.error) ??
            readHelperUsage(outcome.error)),
    );
    const base = { helperRunId, kind: params.kind, usage };
    if (signal.aborted) return { ...base, status: 'cancelled' };
    if (outcome.status === 'fulfilled')
      return {
        ...base,
        status: 'succeeded',
        result: digestHelperResult(outcome.value),
      };
    return {
      ...base,
      status: 'failed',
      error: {
        code: WORKER_AGENT_HELPER_FAILED_CODE,
        message: WORKER_AGENT_HELPER_FAILED_MESSAGE,
      },
    };
  });
  return {
    take: (): HelperLaunchSettlement<T> => {
      stagedRuns.delete(helperRunId);
      const outcome = settled.value;
      settled.value = { ran: false };
      return outcome;
    },
  };
}

export const desktopHelperWorker: HelperExecutionWorker = {
  run: (params, signal): Promise<WorkerAgentHelperRunResult> => {
    const launch = stagedRuns.get(params.helperRunId);
    if (!launch) throw helperLaunchUnavailableError();
    stagedRuns.delete(params.helperRunId);
    if (signal.aborted)
      return Promise.resolve({
        helperRunId: params.helperRunId,
        kind: params.kind,
        status: 'cancelled',
        usage: {},
      });
    return launch(params, signal);
  },
};
