import { createHash } from 'node:crypto';

import { stableStringify } from '@canopy/protocol/plans';
import {
  WorkerCodeGraphBuildFailureDetailsSchema,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type WorkerCodeGraphBuildCancelResult,
  type WorkerCodeGraphBuildsCancelResult,
  type WorkerCodeGraphBuildFailure,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildQueue,
  type WorkerCodeGraphBuildResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';

/** A reorder the worker refused, and why. */
export type CodeGraphBuildQueueReorderRefusal = 'changed' | 'invalid-order';

/**
 * The trusted host side of the code-graph build queue controls: the
 * worker's build scheduler, projected to portable queue items. Host paths
 * and build hosts stay on the host.
 */
export interface CodeGraphBuildQueueWorker {
  queue(): WorkerCodeGraphBuildQueue;
  reorder(
    expectedRevision: number,
    orderedQueueItemIds: readonly string[],
  ):
    | { ok: true; queue: WorkerCodeGraphBuildQueue }
    | {
        ok: false;
        refusal: CodeGraphBuildQueueReorderRefusal;
        /** Fixed text naming what was wrong; never a path. */
        message: string;
      };
  /**
   * Cancels a queued or running item and resolves once its build host has
   * exited; `null` when no such item is queued or running.
   */
  cancel(queueItemId: string): Promise<WorkerCodeGraphBuildCancelResult | null>;
  /**
   * Cancels every build of one worktree, queued, running or still
   * preparing, and resolves once each build host has exited, with the count.
   */
  cancelWorktree(workspaceId: string, worktreeId: string): Promise<number>;
  /**
   * Builds the graph through the queue, resolving when the build settles.
   * Throws the `codeGraph*Error` refusals below; any other failure is a
   * failed build.
   */
  build(
    graphScope: WorkerCodeGraphBuildParams['graphScope'],
  ): Promise<WorkerCodeGraphBuildResult>;
}

export function codeGraphQueueChangedError(
  message = 'The generation queue changed. Reload it and try again.',
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.codeGraph.queueChanged',
    message,
    retry: { kind: 'after_refresh', resource: 'worker.codeGraph.buildQueue' },
  });
}

export function codeGraphQueueOrderInvalidError(
  message = 'The reorder must contain every queued generation exactly once.',
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'worker.codeGraph.queueOrderInvalid',
    message,
    retry: { kind: 'never' },
  });
}

/** The worker's build scheduler could not be reached. */
export function codeGraphQueueUnavailableError(
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'unavailable',
      code: 'worker.codeGraph.queueUnavailable',
      message: 'The code graph generation queue is unavailable.',
      retry: { kind: 'same_request', delayMs: 1_000 },
    },
    cause,
  );
}

export function codeGraphQueueItemNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.codeGraph.queueItemNotFound',
    message: 'This generation is not queued or running.',
    retry: { kind: 'never' },
  });
}

/** Code graph generation is turned off for this workspace. */
export function codeGraphUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.codeGraph.unavailable',
    message: 'Code graph generation is unavailable for this project.',
    retry: { kind: 'never' },
  });
}

/** The workspace or worktree is not one this host knows, or its ID is invalid. */
export function codeGraphScopeNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.codeGraph.graphScopeNotFound',
    message: 'The project or worktree does not exist.',
    retry: { kind: 'never' },
  });
}

/**
 * The build failed. `failure` names why without the host's message, which
 * stays in process as the error's cause.
 */
export function codeGraphBuildFailedError(
  failure: WorkerCodeGraphBuildFailure,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: 'worker.codeGraph.buildFailed',
      message: 'The code graph build failed.',
      details: { failure },
      retry: { kind: 'never' },
    },
    cause,
  );
}

const BUILD_REFUSAL_CODES = [
  'worker.codeGraph.unavailable',
  'worker.codeGraph.graphScopeNotFound',
  'worker.codeGraph.queueUnavailable',
  'worker.codeGraph.buildFailed',
  'worker.codeGraph.buildTimedOut',
  'worker.codeGraph.buildCanceled',
  'worker.codeGraph.idempotencyKeyReused',
] as const;

export type CodeGraphBuildRefusalCode = (typeof BUILD_REFUSAL_CODES)[number];

export interface CodeGraphBuildRefusal {
  code: CodeGraphBuildRefusalCode;
  /** Present on `worker.codeGraph.buildFailed`. */
  failure?: WorkerCodeGraphBuildFailure;
  message: string;
}

/** The typed build refusal a `worker.codeGraph.build` error carries, if any. */
export function codeGraphBuildRefusalOf(
  error: unknown,
): CodeGraphBuildRefusal | null {
  if (!(error instanceof CanopyOperationError)) return null;
  const { code, details, message } = error.payload;
  const refusal = BUILD_REFUSAL_CODES.find((candidate) => candidate === code);
  if (refusal === undefined) return null;
  const parsed = WorkerCodeGraphBuildFailureDetailsSchema.safeParse(details);
  return {
    code: refusal,
    message,
    ...(refusal === 'worker.codeGraph.buildFailed' && parsed.success
      ? { failure: parsed.data.failure }
      : {}),
  };
}

export function codeGraphBuildTimedOutError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'deadline_exceeded',
    code: 'worker.codeGraph.buildTimedOut',
    message: 'Code graph generation timed out.',
    retry: { kind: 'never' },
  });
}

export function codeGraphBuildCanceledError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'cancelled',
    code: 'worker.codeGraph.buildCanceled',
    message: 'The code graph build was canceled.',
    retry: { kind: 'never' },
  });
}

export function codeGraphIdempotencyKeyReusedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.codeGraph.idempotencyKeyReused',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

/** Keyed outcomes kept for replay; the oldest are dropped. */
const MAX_KEYED_OUTCOMES = 512;

/**
 * Keyed replay for the queue instructions, as the script worker does: a
 * repeat with the same caller, key and parameters returns the
 * first outcome, joining it while it runs, instead of reordering or
 * canceling again; other parameters are refused.
 */
export class KeyedOutcomes<T> {
  private readonly outcomes = new Map<
    string,
    { fingerprint: string; outcome: Promise<T> }
  >();

  run(
    context: CanopyHandlerContext,
    params: unknown,
    start: () => Promise<T>,
  ): Promise<T> {
    const key = context.metadata.idempotencyKey;
    if (key === undefined) return start();
    const id = `${context.caller.principalId}\0${key}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(params) ?? 'null')
      .digest('hex');
    const existing = this.outcomes.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(codeGraphIdempotencyKeyReusedError());
      return existing.outcome;
    }
    const outcome = start();
    this.outcomes.set(id, { fingerprint, outcome });
    // A refusal the caller may retry is not the outcome: drop it, so the
    // retry with the same key runs again instead of replaying the refusal.
    outcome.catch((error: unknown) => {
      if (
        error instanceof CanopyOperationError &&
        error.payload.retry.kind !== 'never' &&
        this.outcomes.get(id)?.outcome === outcome
      )
        this.outcomes.delete(id);
    });
    while (this.outcomes.size > MAX_KEYED_OUTCOMES) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return outcome;
  }
}

export interface WorkerCodeGraphHandlers {
  queries: {
    'worker.codeGraph.buildQueue.get': CanopyQueryHandler<
      'worker.codeGraph.buildQueue.get',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'worker.codeGraph.build': CanopyInstructionHandler<
      'worker.codeGraph.build',
      CanopyHandlerContext
    >;
    'worker.codeGraph.buildQueue.update': CanopyInstructionHandler<
      'worker.codeGraph.buildQueue.update',
      CanopyHandlerContext
    >;
    'worker.codeGraph.build.cancel': CanopyInstructionHandler<
      'worker.codeGraph.build.cancel',
      CanopyHandlerContext
    >;
    'worker.codeGraph.builds.cancel': CanopyInstructionHandler<
      'worker.codeGraph.builds.cancel',
      CanopyHandlerContext
    >;
  };
}

/** The code-graph build queue controls over one worker (CAN-4149). */
export function createWorkerCodeGraphHandlers(
  worker: CodeGraphBuildQueueWorker,
): WorkerCodeGraphHandlers {
  const builds = new KeyedOutcomes<WorkerCodeGraphBuildResult>();
  const reorders = new KeyedOutcomes<WorkerCodeGraphBuildQueue>();
  const cancels = new KeyedOutcomes<WorkerCodeGraphBuildCancelResult>();
  const worktreeCancels =
    new KeyedOutcomes<WorkerCodeGraphBuildsCancelResult>();
  return {
    queries: {
      'worker.codeGraph.buildQueue.get': () => Promise.resolve(worker.queue()),
    },
    instructions: {
      'worker.codeGraph.build': (params, context) =>
        builds.run(context, params, async () => {
          try {
            return await worker.build(params.graphScope);
          } catch (error) {
            throw error instanceof CanopyOperationError
              ? error
              : codeGraphBuildFailedError('internal', error);
          }
        }),
      'worker.codeGraph.buildQueue.update': (params, context) =>
        reorders.run(context, params, () => {
          const outcome = worker.reorder(
            params.expectedRevision,
            params.orderedQueueItemIds,
          );
          if (outcome.ok) return Promise.resolve(outcome.queue);
          return Promise.reject(
            outcome.refusal === 'changed'
              ? codeGraphQueueChangedError(outcome.message)
              : codeGraphQueueOrderInvalidError(outcome.message),
          );
        }),
      'worker.codeGraph.build.cancel': (params, context) =>
        cancels.run(context, params, async () => {
          const canceled = await worker.cancel(params.queueItemId);
          if (canceled === null) throw codeGraphQueueItemNotFoundError();
          return canceled;
        }),
      'worker.codeGraph.builds.cancel': (params, context) =>
        worktreeCancels.run(context, params, async () => ({
          canceled: await worker.cancelWorktree(
            params.workspaceId,
            params.worktreeId,
          ),
        })),
    },
  };
}
