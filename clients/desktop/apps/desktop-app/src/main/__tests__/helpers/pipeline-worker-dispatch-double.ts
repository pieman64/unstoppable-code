import type { PipelineControlRequest } from '@canopy/core-runtime/node/pipeline';
import type {
  ExecutionHandle,
  ExecutionOptions,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import {
  attachPipelineHandle,
  definitionSourceOf,
  desktopPipelineWorker,
  drainPipelineExecution,
  stagePipelineLaunch,
  pipelineCancelMark,
  readPipelineCancelCapture,
  stagePipelineControl,
  type PipelineControlLaunch,
  type PipelineControlSettlement,
} from '../../pipelines/pipeline-worker-host';

/*
 * `pipeline-worker-dispatch` without a dispatcher, for suites that compose
 * no desktop runtime: the real worker host runs each start and cancel, but
 * no core run records are written. Recovery controls run the same way.
 */

export function followExecutionHandle(handle: ExecutionHandle): void {
  attachPipelineHandle(handle);
}

export async function startPipelineThroughLocalWorker(
  pipeline: Pipeline,
  options: ExecutionOptions & { executionId: string; executionContext: string },
): Promise<ExecutionHandle> {
  const staged = stagePipelineLaunch(options.executionId, {
    pipeline,
    options,
  });
  try {
    await desktopPipelineWorker.start(
      {
        executionId: options.executionId,
        pipelineId: options.pipelineId,
        definitionSource: definitionSourceOf(options.pipelinePreferenceLocator),
        runScope: options.scope ?? 'directory',
        workspaceId: options.projectId ?? null,
        worktreeId: options.worktreeId ?? null,
        owner: options.executionContext,
        initiationSource: 'unknown',
      },
      new AbortController().signal,
    );
  } catch {
    // The capture keeps the executor's own error.
  }
  const capture = staged.take();
  if (capture.handle) return capture.handle;
  throw capture.error instanceof Error
    ? capture.error
    : new Error(String(capture.error));
}

export async function cancelPipelineThroughLocalWorker(
  executionId: string,
): Promise<ExecutionState> {
  const mark = pipelineCancelMark(executionId);
  try {
    await desktopPipelineWorker.cancel(executionId, 'finalize');
  } catch {
    // The capture keeps the executor's own error.
  }
  const capture = readPipelineCancelCapture(executionId, mark);
  if (capture.state) return capture.state;
  throw capture.error instanceof Error
    ? capture.error
    : new Error(String(capture.error));
}

export async function controlPipelineThroughLocalWorker(
  control: PipelineControlRequest,
  launch: PipelineControlLaunch,
): Promise<PipelineControlSettlement> {
  const staged = stagePipelineControl(control.params.requestId, launch);
  try {
    await desktopPipelineWorker.control(control, new AbortController().signal);
  } catch {
    // The capture keeps the entry point's own error.
  }
  const capture = staged.take();
  if (capture.settlement) return capture.settlement;
  throw capture.error instanceof Error
    ? capture.error
    : new Error(String(capture.error));
}

let drainRuntime: ExecutionRuntime | null = null;

/** The runtime the suite's executions live in, for archive drains. */
export function useDrainRuntime(runtime: ExecutionRuntime | null): void {
  drainRuntime = runtime;
}

export async function drainPipelineThroughLocalWorker(
  executionId: string,
): Promise<void> {
  if (!drainRuntime) throw new Error('No drain runtime for this suite.');
  await drainPipelineExecution(executionId, drainRuntime);
}
