import {
  WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH,
  WORKER_PIPELINE_TERMINAL_STATUSES,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type CanopyStreamHandlerMap,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineExecutionResult,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';

/** What a worker reports while one of its executions runs. */
export interface PipelineExecutionObserver {
  onExecution(event: string, execution: WorkerPipelineExecution): void;
  onOutput(output: {
    jobId: string;
    stepId: string;
    stream: 'stdout' | 'stderr';
    text: string;
  }): void;
}

/**
 * The trusted host side of `worker.pipeline.execution.*`: the executor, its
 * execution store and the launches core prepared. Every method speaks
 * portable projections; host paths and live handles stay on the host.
 */
export interface PipelineExecutionWorker {
  /**
   * Run the launch core prepared for this execution, once. Throws
   * {@link pipelineLaunchUnavailableError} when there is none, so a client
   * can never start a run core did not admit.
   */
  start(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
  ): Promise<WorkerPipelineExecution>;
  /** `null` when this worker has no such execution. */
  get(executionId: string): Promise<WorkerPipelineExecution | null>;
  /**
   * Throws {@link pipelineExecutionNotFoundError} for an unknown run, and
   * {@link PipelineDrainTimeoutError} when a drain's bounded wait ends first.
   */
  cancel(
    executionId: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<WorkerPipelineExecution>;
  /**
   * Live events for an execution, across every handle that runs it, such
   * as a resume's. `null` when the worker can't follow it.
   */
  observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null;
}

export function pipelineExecutionNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.pipeline.executionNotFound',
    message: 'This workflow run does not exist.',
    retry: { kind: 'never' },
  });
}

export function pipelineLaunchUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.launchUnavailable',
    message: 'Core has not prepared this workflow run.',
    retry: { kind: 'never' },
  });
}

/** A drain whose bounded wait ended with the run still stopping. */
export class PipelineDrainTimeoutError extends Error {
  constructor() {
    super('The workflow run is still stopping.');
    this.name = 'PipelineDrainTimeoutError';
  }
}

export function pipelineDrainTimedOutError(
  cause: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'deadline_exceeded',
      code: 'worker.pipeline.drainTimedOut',
      message: 'The workflow run is still stopping.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A start the executor refused; its message stays in host diagnostics. */
export function pipelineStartFailedError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: 'worker.pipeline.startFailed',
      message: 'The workflow run could not start.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

const TERMINAL: ReadonlySet<string> = new Set(
  WORKER_PIPELINE_TERMINAL_STATUSES,
);

export function isTerminalPipelineExecution(
  execution: WorkerPipelineExecution,
): boolean {
  return TERMINAL.has(execution.status);
}

/**
 * Output budget for one events subscription: at most `items` output items
 * per `windowMs`. Output past it is dropped and counted into the next `gap`
 * item; lifecycle items never count against it.
 */
export interface PipelineOutputBudget {
  readonly items: number;
  readonly windowMs: number;
  /**
   * The most frames a slow consumer may have waiting before output is
   * dropped, well under the dispatcher's buffer, so lifecycle and terminal
   * items always fit.
   */
  readonly backlog: number;
}

/** How often a held update retries while the consumer is behind. */
const HELD_UPDATE_RETRY_MS = 50;

export const DEFAULT_PIPELINE_OUTPUT_BUDGET: PipelineOutputBudget = {
  items: 200,
  windowMs: 1_000,
  backlog: 256,
};

export interface WorkerPipelineHandlers {
  queries: {
    'worker.pipeline.execution.get': CanopyQueryHandler<
      'worker.pipeline.execution.get',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'worker.pipeline.execution.start': CanopyInstructionHandler<
      'worker.pipeline.execution.start',
      CanopyHandlerContext
    >;
    'worker.pipeline.execution.cancel': CanopyInstructionHandler<
      'worker.pipeline.execution.cancel',
      CanopyHandlerContext
    >;
  };
  streams: Pick<
    CanopyStreamHandlerMap<CanopyHandlerContext>,
    'worker.pipeline.execution.events'
  >;
}

/** `worker.pipeline.execution.*` over one worker host (CAN-4140). */
export function createWorkerPipelineHandlers(
  worker: PipelineExecutionWorker,
  options: { budget?: PipelineOutputBudget; now?: () => number } = {},
): WorkerPipelineHandlers {
  const budget = options.budget ?? DEFAULT_PIPELINE_OUTPUT_BUDGET;
  const now = options.now ?? Date.now;
  return {
    queries: {
      'worker.pipeline.execution.get': async ({
        executionId,
      }): Promise<WorkerPipelineExecutionResult> => {
        const execution = await worker.get(executionId);
        if (!execution) throw pipelineExecutionNotFoundError();
        return { execution };
      },
    },
    instructions: {
      'worker.pipeline.execution.start': async (
        params,
        { signal },
      ): Promise<WorkerPipelineExecutionResult> => ({
        execution: await worker.start(params, signal),
      }),
      'worker.pipeline.execution.cancel': async ({
        executionId,
        mode = 'finalize',
      }): Promise<WorkerPipelineExecutionResult> => {
        try {
          return { execution: await worker.cancel(executionId, mode) };
        } catch (error) {
          if (error instanceof PipelineDrainTimeoutError)
            throw pipelineDrainTimedOutError(error);
          throw error;
        }
      },
    },
    streams: {
      'worker.pipeline.execution.events': async (
        { executionId },
        context,
        sink,
      ): Promise<(() => void) | void> => {
        let ended = false;
        let stop: (() => void) | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const cancelRetry = (): void => {
          if (retry !== null) clearTimeout(retry);
          retry = null;
        };
        const finish = (): void => {
          if (ended) return;
          ended = true;
          cancelRetry();
          stop?.();
          sink.end('completed');
        };
        const emit = (item: WorkerPipelineExecutionEventsItem): void => {
          if (!ended && sink.emit(item) === null) {
            ended = true;
            stop?.();
          }
        };
        let windowStart = now();
        let windowItems = 0;
        let dropped = 0;
        const flushGap = (): void => {
          if (dropped === 0) return;
          emit({ kind: 'gap', droppedOutputItems: dropped });
          dropped = 0;
        };
        let lastStatus: WorkerPipelineExecution['status'] | null = null;
        // The latest update held back while a slow consumer has a backlog.
        let heldUpdate: {
          event: string;
          execution: WorkerPipelineExecution;
        } | null = null;
        const backlogged = (): boolean =>
          (sink.buffered?.() ?? 0) >= budget.backlog;
        const deliver = (
          event: string,
          execution: WorkerPipelineExecution,
        ): void => {
          flushGap();
          lastStatus = execution.status;
          emit({ kind: 'execution', event, execution });
          if (isTerminalPipelineExecution(execution)) finish();
        };
        const flushHeld = (): void => {
          if (ended || heldUpdate === null) return;
          // The consumer drains without telling the handler, so a held
          // update retries until it fits, with or without more output.
          if (backlogged()) {
            retry ??= setTimeout(() => {
              retry = null;
              flushHeld();
            }, HELD_UPDATE_RETRY_MS);
            return;
          }
          cancelRetry();
          const { event, execution } = heldUpdate;
          heldUpdate = null;
          deliver(event, execution);
        };
        // Updates coalesce into the latest while the consumer is behind;
        // every other lifecycle item, and the terminal one, always goes.
        const onExecution = (
          event: string,
          execution: WorkerPipelineExecution,
        ): void => {
          if (ended) return;
          if (event === 'execution.updated' && backlogged()) {
            heldUpdate = { event, execution };
            flushHeld();
            return;
          }
          heldUpdate = null;
          cancelRetry();
          deliver(event, execution);
        };
        let observed = false;
        const current = await worker.get(executionId);
        if (!current) {
          sink.end('error', pipelineExecutionNotFoundError().payload);
          return;
        }
        onExecution('snapshot', current);
        if (ended) return;
        stop = worker.observe(executionId, {
          onExecution: (event, execution) => {
            observed = true;
            onExecution(event, execution);
          },
          onOutput: ({ jobId, stepId, stream, text }) => {
            if (ended) return;
            flushHeld();
            const at = now();
            if (at - windowStart >= budget.windowMs) {
              windowStart = at;
              windowItems = 0;
            }
            if (
              windowItems >= budget.items ||
              (sink.buffered?.() ?? 0) >= budget.backlog
            ) {
              dropped += 1;
              return;
            }
            windowItems += 1;
            flushGap();
            const truncated =
              text.length > WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH;
            emit({
              kind: 'output',
              jobId,
              stepId,
              stream,
              text: truncated
                ? text.slice(0, WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH)
                : text,
              truncated,
            });
          },
        });
        if (stop === null) {
          // It settled between the snapshot and the subscription.
          const settled = await worker.get(executionId);
          if (settled) onExecution('snapshot', settled);
          finish();
          return;
        }
        // It may have paused or settled between the snapshot and the
        // subscription; an event the subscription already saw is newer.
        const latest = await worker.get(executionId);
        if (latest && !observed && latest.status !== lastStatus)
          onExecution('snapshot', latest);
        if (context.signal.aborted) stop();
        return () => {
          ended = true;
          cancelRetry();
          stop?.();
        };
      },
    },
  };
}
