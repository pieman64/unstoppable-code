import { randomUUID } from 'node:crypto';

import {
  OPERATION_TERMINAL_STATUSES,
  WorkerPipelineExecutionResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';

import type {
  LocalWorkerDispatchResult,
  LocalWorkerExecution,
} from '../../operations/local-worker';
import type { OperationService } from '../../operations/service';
import {
  isTerminalPipelineExecution,
  type PipelineExecutionWorker,
} from './worker-pipelines';

/** One pipeline run; its worker requests are its children. */
export const CORE_PIPELINE_RUN_KIND = 'core.pipeline.run';
/** A cancel of a run this process did not start, such as a resumed one. */
export const CORE_PIPELINE_CANCEL_KIND = 'core.pipeline.cancel';
const WORKER_START = 'worker.pipeline.execution.start';
const WORKER_CANCEL = 'worker.pipeline.execution.cancel';

const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this workflow request ended.',
  retry: { kind: 'never' },
};

const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set(
  OPERATION_TERMINAL_STATUSES,
);

const RUN_FAILED: CanopyErrorPayload = {
  kind: 'failed_precondition',
  message: 'The workflow run failed.',
  retry: { kind: 'never' },
};

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

/** A recorded failure as an error payload, keeping a plane-qualified code. */
function toErrorPayload(failure: OperationFailure | null): CanopyErrorPayload {
  if (!failure) return OUTCOME_UNKNOWN;
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

export interface CorePipelineStartRequest {
  params: WorkerPipelineExecutionStartParams;
  /** What started the run: a client, a hook or an automation. */
  origin: OperationOrigin;
  owner: OperationOwner;
}

export type CorePipelineRequestResult =
  | {
      status: 'completed';
      operationId: string;
      execution: WorkerPipelineExecution;
    }
  | {
      status: 'failed' | 'cancelled';
      operationId: string;
      error: CanopyErrorPayload | null;
    };

function requestResult(
  operationId: string,
  dispatched: LocalWorkerDispatchResult,
): CorePipelineRequestResult {
  const child = dispatched.operation;
  const reply = WorkerPipelineExecutionResultSchema.safeParse(
    dispatched.result,
  );
  if (child.status === 'completed' && reply.success)
    return {
      status: 'completed',
      operationId,
      execution: reply.data.execution,
    };
  return child.status === 'cancelled'
    ? { status: 'cancelled', operationId, error: null }
    : { status: 'failed', operationId, error: toErrorPayload(child.error) };
}

/**
 * Core-side pipeline runs (CAN-4140). A run is a `core.pipeline.run`
 * operation recorded before anything starts. Its `worker.pipeline.execution.*`
 * requests are children dispatched to the local worker, each recorded with
 * its target and lease first (CAN-4132):
 *
 * - The run is `paused` while its execution waits and finishes with the
 *   execution's terminal status.
 * - Any client cancels it through `core.operation.cancel`; the cancellation
 *   is a worker cancel dispatched under the run.
 * - Runs are `lost` across a restart. The execution store keeps a paused
 *   execution resumable; the run record is never started again.
 */
export class CorePipelineRuns {
  /** Unfinished runs this process started, by execution id. */
  private readonly runs = new Map<string, string>();
  /** The live subscription of each run whose execution is watched. */
  private readonly following = new Map<string, () => void>();
  /** Runs recorded as paused. */
  private readonly paused = new Set<string>();
  /** Starts in flight; a cancel waits for its run to exist. */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** In-flight worker cancels by parent operation and mode; a repeat joins one. */
  private readonly cancels = new Map<
    string,
    Promise<CorePipelineRequestResult>
  >();

  constructor(
    private readonly options: {
      operations: OperationService;
      localWorker: LocalWorkerExecution;
      worker: Pick<PipelineExecutionWorker, 'get' | 'observe'>;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.pipeline',
      kinds: [CORE_PIPELINE_RUN_KIND, CORE_PIPELINE_CANCEL_KIND],
      restartClass: 'lost',
      cancel: (operation, request) => {
        const { executionId } = operation.scope;
        if (operation.kind !== CORE_PIPELINE_RUN_KIND || !executionId)
          return Promise.resolve('cancelled');
        // A run being cancelled takes no more children, so the worker cancel
        // has its own operation; its reply finishes the run.
        void this.afterStart(executionId)
          .then(() =>
            this.cancelSeparately(executionId, request.requestedBy, 'finalize'),
          )
          .catch(() => undefined);
        return Promise.resolve('requested');
      },
    });
  }

  /**
   * Record a run and start it on the local worker. `completed` once the
   * worker has started the execution; the run itself stays unfinished.
   */
  async start(
    request: CorePipelineStartRequest,
  ): Promise<CorePipelineRequestResult> {
    const { executionId } = request.params;
    const started = this.startRun(request);
    this.starting.set(executionId, started);
    try {
      return await started;
    } finally {
      if (this.starting.get(executionId) === started)
        this.starting.delete(executionId);
    }
  }

  /** Resolves once any start of this execution has settled. */
  private async afterStart(executionId: string): Promise<void> {
    await this.starting.get(executionId)?.catch(() => undefined);
  }

  private async startRun(
    request: CorePipelineStartRequest,
  ): Promise<CorePipelineRequestResult> {
    const { operations, localWorker } = this.options;
    const { params } = request;
    const admitted = await operations.admit({
      kind: CORE_PIPELINE_RUN_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
      scope: {
        ...(params.workspaceId !== null
          ? { workspaceId: params.workspaceId }
          : {}),
        ...(params.worktreeId !== null
          ? { worktreeId: params.worktreeId }
          : {}),
        executionId: params.executionId,
      },
    });
    const run = admitted.operation;
    let dispatched: LocalWorkerDispatchResult;
    try {
      dispatched = await localWorker.dispatch({
        parentOperationId: run.operationId,
        operation: WORKER_START,
        params,
        idempotencyKey: params.executionId,
      });
    } catch (error) {
      await operations
        .finish(run.operationId, {
          status: 'failed',
          error: {
            kind: 'internal',
            message: 'This workflow run could not be dispatched.',
            retry: { kind: 'never' },
          },
        })
        .catch(() => undefined);
      throw error;
    }
    const result = requestResult(run.operationId, dispatched);
    if (result.status !== 'completed') {
      await operations
        .finish(
          run.operationId,
          result.status === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
        )
        .catch(() => undefined);
      return result;
    }
    this.runs.set(params.executionId, run.operationId);
    this.follow(params.executionId);
    return result;
  }

  /**
   * Watch a run's execution again after it resumed on a new handle. A
   * no-op for executions this process did not start.
   */
  reattach(executionId: string): void {
    if (this.runs.has(executionId)) this.follow(executionId);
  }

  /**
   * Cancel an execution and resolve with the worker's answer. The worker
   * cancel of a run this process started is a child of that run; any other
   * execution gets a `core.pipeline.cancel` operation of its own. A `drain`
   * never settles a run that is still stopping; it fails instead.
   */
  async cancel(
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode = 'finalize',
  ): Promise<CorePipelineRequestResult> {
    // A cancel that arrives while its run starts cancels the started run.
    await this.afterStart(executionId);
    const runId = this.runs.get(executionId);
    if (runId !== undefined) {
      const run = await this.options.operations.get(runId);
      if (
        run &&
        !TERMINAL_OPERATION_STATUSES.has(run.status) &&
        !run.cancellation
      ) {
        try {
          return await this.dispatchCancel(
            runId,
            executionId,
            requestedBy,
            mode,
          );
        } catch (error) {
          // The run finished or began cancelling after that read, so it
          // takes no more children; cancel the execution on its own.
          const after = await this.options.operations.get(runId);
          if (
            !after ||
            (!TERMINAL_OPERATION_STATUSES.has(after.status) &&
              !after.cancellation)
          )
            throw error;
        }
      }
    }
    return this.cancelSeparately(executionId, requestedBy, mode);
  }

  /**
   * Finish a run from an execution that has ended, whether its handle
   * reported it or a cancel reply did, as for a paused run whose handle has
   * already settled.
   */
  private settle(
    executionId: string,
    execution: WorkerPipelineExecution,
  ): void {
    const runId = this.runs.get(executionId);
    if (runId === undefined || !isTerminalPipelineExecution(execution)) return;
    this.following.get(executionId)?.();
    this.runs.delete(executionId);
    this.paused.delete(executionId);
    void this.options.operations
      .finish(
        runId,
        execution.status === 'success'
          ? { status: 'completed' }
          : execution.status === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'failed', error: RUN_FAILED },
      )
      .catch(() => undefined);
  }

  private async cancelSeparately(
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<CorePipelineRequestResult> {
    const { operations } = this.options;
    const admitted = await operations.admit({
      kind: CORE_PIPELINE_CANCEL_KIND,
      status: 'running',
      origin: { kind: 'client', sourceId: requestedBy },
      owner: { kind: 'principal', id: requestedBy },
      scope: { executionId },
    });
    const parent = admitted.operation;
    try {
      const result = await this.dispatchCancel(
        parent.operationId,
        executionId,
        requestedBy,
        mode,
      );
      await operations
        .finish(
          parent.operationId,
          result.status === 'completed'
            ? { status: 'completed' }
            : result.status === 'cancelled'
              ? { status: 'cancelled' }
              : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
        )
        .catch(() => undefined);
      return result;
    } catch (error) {
      await operations
        .finish(parent.operationId, { status: 'failed', error: RUN_FAILED })
        .catch(() => undefined);
      throw error;
    }
  }

  private dispatchCancel(
    parentOperationId: string,
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<CorePipelineRequestResult> {
    // A finalize never joins a drain, which may end with the run still going.
    const key = `${parentOperationId}:${mode}`;
    const existing = this.cancels.get(key);
    if (existing) return existing;
    const pending = this.options.localWorker
      .dispatch({
        parentOperationId,
        operation: WORKER_CANCEL,
        params: { executionId, ...(mode === 'drain' && { mode }) },
        idempotencyKey: `cancel:${requestedBy}:${randomUUID()}`,
      })
      .then((dispatched) => {
        const result = requestResult(parentOperationId, dispatched);
        if (result.status === 'completed')
          this.settle(executionId, result.execution);
        return result;
      })
      .finally(() => this.cancels.delete(key));
    this.cancels.set(key, pending);
    return pending;
  }

  /** Mirror the execution's pauses and terminal status onto its run. */
  private follow(executionId: string): void {
    const { operations, worker } = this.options;
    this.following.get(executionId)?.();
    this.following.delete(executionId);
    let stop: (() => void) | null = null;
    let done = false;
    const release = (): void => {
      done = true;
      stop?.();
      if (this.following.get(executionId) === release)
        this.following.delete(executionId);
    };
    const apply = (execution: WorkerPipelineExecution): void => {
      const runId = this.runs.get(executionId);
      if (done || runId === undefined) return;
      if (isTerminalPipelineExecution(execution)) {
        release();
        this.settle(executionId, execution);
        return;
      }
      const pausedNow = execution.status === 'paused';
      if (pausedNow === this.paused.has(executionId)) return;
      if (pausedNow) this.paused.add(executionId);
      else this.paused.delete(executionId);
      void operations
        .transition(runId, pausedNow ? 'paused' : 'running')
        .catch(() => undefined);
    };
    let observed = false;
    stop = worker.observe(executionId, {
      onExecution: (_event, execution) => {
        observed = true;
        apply(execution);
      },
      onOutput: () => undefined,
    });
    if (stop === null) {
      // Not running here any more: record where it stopped. A paused run
      // that resumes on a new handle is watched again through `reattach`.
      void worker
        .get(executionId)
        .then((execution) => {
          if (execution) apply(execution);
        })
        .catch(() => undefined);
      return;
    }
    if (done) {
      stop();
      return;
    }
    this.following.set(executionId, release);
    // It may have paused or ended before the subscription; an event the
    // subscription already saw is newer than this read.
    void worker
      .get(executionId)
      .then((execution) => {
        if (execution && !observed) apply(execution);
      })
      .catch(() => undefined);
  }
}
