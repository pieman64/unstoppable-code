import { randomUUID } from 'node:crypto';
import {
  WORKER_AGENT_HELPER_MODEL_MAX,
  WORKER_AGENT_HELPER_FAILED_CODE,
  type WorkerAgentHelperKind,
} from '@canopy/protocol/canopy-core';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CoreHelperRunResult } from '@canopy/core-runtime/node/agent/helpers';
import type { HelperUsage } from '@canopy/desktop-shared/lib/helper-usage';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  stageHelperLaunch,
  type HelperLaunch,
  type HelperLaunchSettlement,
} from './helper-worker-host';

export interface HelperRunRequest<T> {
  kind: WorkerAgentHelperKind;
  model: string;
  scope: {
    workspaceId?: string;
    worktreeId?: string;
    chatId?: string;
    executionId?: string;
    repoId?: string;
  };
  origin: 'client' | 'system';
  workOwner?: WorkOwner | null;
  signal?: AbortSignal;
  launch: HelperLaunch<T>;
  usageOf: (value: T) => HelperUsage | undefined;
}

export class HelperWorkerUnavailableError extends Error {
  declare readonly cause?: unknown;

  constructor(options?: { cause?: unknown }) {
    super('The helper could not start on the local worker.');
    this.name = 'HelperWorkerUnavailableError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export function linkHelperAbort(
  workerSignal: AbortSignal,
  controller: AbortController,
): () => void {
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(workerSignal.reason);
  };
  if (workerSignal.aborted) abort();
  else workerSignal.addEventListener('abort', abort, { once: true });
  return () => workerSignal.removeEventListener('abort', abort);
}

export async function runHelperThroughWorker<T>(
  request: HelperRunRequest<T>,
): Promise<T> {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) throw new HelperWorkerUnavailableError();
  if (request.signal?.aborted)
    throw (
      request.signal.reason ??
      new DOMException('This operation was aborted', 'AbortError')
    );
  const helperRunId = randomUUID();
  const staged = stageHelperLaunch(helperRunId, {
    launch: request.launch,
    usageOf: request.usageOf,
  });
  let result: CoreHelperRunResult | undefined;
  let cause: unknown;
  let recordThrew = false;
  let settlement: HelperLaunchSettlement<T>;
  const { workspaceId, worktreeId, chatId, executionId, repoId } =
    request.scope;
  try {
    result = await runtime.helperRuns.run(
      {
        params: {
          helperRunId,
          kind: request.kind,
          model:
            request.model.slice(0, WORKER_AGENT_HELPER_MODEL_MAX) ||
            'unspecified',
          scope: {
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(worktreeId !== undefined ? { worktreeId } : {}),
            ...(chatId !== undefined ? { chatId } : {}),
            ...(executionId !== undefined ? { executionId } : {}),
            ...(repoId !== undefined ? { repoId } : {}),
          },
        },
        origin:
          request.origin === 'client'
            ? { kind: 'client', sourceId: 'local-desktop-user' }
            : { kind: 'system', sourceId: `helper:${request.kind}` },
        owner:
          request.workOwner?.kind === 'organization'
            ? { kind: 'organization', id: request.workOwner.organizationId }
            : { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      },
      {
        ...(request.signal ? { signal: request.signal } : {}),
        cancelledBy: 'local-desktop-user',
      },
    );
  } catch (error) {
    cause = error;
    recordThrew = true;
  } finally {
    settlement = staged.take();
  }
  if (settlement.ran) {
    if (
      recordThrew ||
      (result?.status === 'failed' &&
        (settlement.status === 'fulfilled' ||
          result.error.code !== WORKER_AGENT_HELPER_FAILED_CODE))
    )
      logMainProcessWarn('[helper-runs] The helper run record did not settle', {
        kind: request.kind,
        helperRunId,
      });
    if (settlement.status === 'fulfilled') return settlement.value;
    throw settlement.error;
  }
  if (request.signal?.aborted)
    throw (
      request.signal.reason ??
      new DOMException('This operation was aborted', 'AbortError')
    );
  throw new HelperWorkerUnavailableError({
    cause: recordThrew
      ? cause
      : result?.status === 'failed'
        ? result.error
        : undefined,
  });
}
