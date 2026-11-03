import {
  WORKER_PIPELINE_INITIATION_SOURCES,
  type OperationOrigin,
  type OperationOwner,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  ExecutionHandle,
  ExecutionOptions,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getDesktopCanopyRuntime,
  peekDesktopCanopyRuntime,
} from '../canopy-runtime/desktop-runtime-access';
import {
  attachPipelineHandle,
  definitionSourceOf,
  stagePipelineLaunch,
  pipelineCancelMark,
  readPipelineCancelCapture,
} from './pipeline-worker-host';

/*
 * The start and cancel chokepoints of every desktop caller reach the local
 * pipeline worker here (CAN-4140): core records the run, then dispatches
 * `worker.pipeline.execution.start` or `.cancel` through the local worker.
 * Legacy callers keep their results: the live handle, the full cancelled
 * state and the executor's own error come back from the in-process host.
 */

const LOCAL_PRINCIPAL = 'local-desktop-user';
function initiationSourceOf(
  options: ExecutionOptions,
): WorkerPipelineExecutionStartParams['initiationSource'] {
  return (
    WORKER_PIPELINE_INITIATION_SOURCES.find(
      (candidate) => candidate === options.initiationSource,
    ) ?? 'unknown'
  );
}

function originOf(options: ExecutionOptions): OperationOrigin {
  const source = options.initiationSource;
  return source === 'hook' || source === 'automation'
    ? { kind: source, sourceId: options.pipelineId }
    : { kind: 'client', sourceId: LOCAL_PRINCIPAL };
}

function ownerOf(owner: string): OperationOwner {
  const context = parseWorkspaceContext(owner);
  return context?.kind === 'organization'
    ? { kind: 'organization', id: context.organizationId }
    : { kind: 'principal', id: LOCAL_PRINCIPAL };
}

/**
 * Every handle that runs an execution, a start's or a resume's, carries its
 * event subscribers and its core run record.
 */
export function followExecutionHandle(handle: ExecutionHandle): void {
  attachPipelineHandle(handle);
  peekDesktopCanopyRuntime()?.pipelineRuns.reattach(handle.id);
}

/**
 * Start a run core has admitted and authorized: `options.executionId` and
 * its resolved owner (`executionContext`) are required. Resolves with the
 * executor's live handle.
 */
export async function startPipelineThroughLocalWorker(
  pipeline: Pipeline,
  options: ExecutionOptions & { executionId: string; executionContext: string },
): Promise<ExecutionHandle> {
  const { executionId, executionContext } = options;
  const staged = stagePipelineLaunch(executionId, { pipeline, options });
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['start']
    >
  >;
  let capture: ReturnType<typeof staged.take>;
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.start({
      params: {
        executionId,
        pipelineId: options.pipelineId,
        definitionSource: definitionSourceOf(options.pipelinePreferenceLocator),
        runScope:
          options.scope ??
          (options.worktreeId !== undefined ? 'worktree' : 'directory'),
        workspaceId: options.projectId ?? null,
        worktreeId: options.worktreeId ?? null,
        owner: executionContext,
        initiationSource: initiationSourceOf(options),
      },
      origin: originOf(options),
      owner: ownerOf(executionContext),
    });
  } finally {
    capture = staged.take();
  }
  if (result.status === 'completed' && capture.handle) return capture.handle;
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.status === 'completed'
      ? 'The workflow run could not start.'
      : (result.error?.message ?? 'The workflow run could not start.'),
  );
}

/**
 * Cancel an execution through core and the local worker, resolving with the
 * full cancelled state; the executor's own error is rethrown as it was.
 */
export async function cancelPipelineThroughLocalWorker(
  executionId: string,
): Promise<ExecutionState> {
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['cancel']
    >
  >;
  const mark = pipelineCancelMark(executionId);
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.cancel(
      executionId,
      LOCAL_PRINCIPAL,
    );
  } catch (error) {
    const failed = readPipelineCancelCapture(executionId, mark);
    throw failed.error instanceof Error ? failed.error : error;
  }
  // A completed cancel's state is the latest one, even when this call joined
  // a cancel that settled before its mark; only a failure must be this one's.
  const capture = readPipelineCancelCapture(
    executionId,
    result.status === 'completed' ? -1 : mark,
  );
  if (result.status === 'completed' && capture.state) return capture.state;
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.status === 'completed'
      ? 'The workflow run could not be cancelled.'
      : (result.error?.message ?? 'The workflow run could not be cancelled.'),
  );
}

/**
 * Archive teardown's cancel through core's run records: stop the
 * execution's live processes within the worker's bounded wait. Rejects when
 * the run is still stopping; its cancel request and running state stay for
 * a later retry.
 */
export async function drainPipelineThroughLocalWorker(
  executionId: string,
): Promise<void> {
  const result = await getDesktopCanopyRuntime().pipelineRuns.cancel(
    executionId,
    LOCAL_PRINCIPAL,
    'drain',
  );
  if (
    result.status === 'completed' ||
    (result.status === 'failed' &&
      result.error?.code === 'worker.pipeline.executionNotFound')
  )
    return;
  throw new Error(
    result.error?.message ?? 'The workflow run could not be stopped.',
  );
}
