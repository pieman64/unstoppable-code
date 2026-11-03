import {
  WORKER_PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyInstructionHandler,
  type CanopyStreamHandlerMap,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRespondResult,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type {
  CanopyDispatcher,
  CanopyHandlerContext,
} from '../../../runtime/types';

/*
 * Host steps as worker-to-core requests (CAN-4140). The worker raises each
 * host step on `worker.pipeline.hostRequests`; the owning core applies its
 * policy and settles it with `worker.pipeline.hostRequest.respond`. A request
 * nobody settles by its deadline is withdrawn by the executor, and a late
 * response reports `already_settled`.
 */

/** How many settled requests a late response can still be told about. */
const SETTLED_MEMORY = 1024;

export function hostRequestNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.pipeline.hostRequestNotFound',
    message: 'This host request was not raised here.',
    retry: { kind: 'never' },
  });
}

/** No core settles host requests here; the step fails as it does without a desktop. */
export class PipelineHostUnavailableError extends Error {
  constructor() {
    super('No core is settling host requests.');
    this.name = 'PipelineHostUnavailableError';
  }
}

interface Pending {
  readonly request: WorkerPipelineHostRequest;
  resolve(result: WorkerPipelineHostResult): void;
}

/** The worker side: pending host requests and their subscribers. */
export class PipelineHostRequestBroker {
  private readonly pending = new Map<string, Pending>();
  /** Recently settled requests: request id to execution and settle time. */
  private readonly done = new Map<
    string,
    { executionId: string; settledAt: string }
  >();
  private readonly subscribers = new Set<
    (request: WorkerPipelineHostRequest) => void
  >();

  /** Whether a core is subscribed to settle requests. */
  get settled(): boolean {
    return this.subscribers.size > 0;
  }

  /**
   * Raise a request and resolve with core's result. Rejects with
   * {@link PipelineHostUnavailableError} when no core is subscribed, and
   * withdraws the request when `signal` aborts.
   */
  raise(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<WorkerPipelineHostResult> {
    if (this.subscribers.size === 0)
      return Promise.reject(new PipelineHostUnavailableError());
    return new Promise((resolve, reject) => {
      const withdrawn = (): Error => {
        const reason: unknown = signal.reason;
        return reason instanceof Error
          ? reason
          : new Error('The host request was withdrawn.');
      };
      const withdraw = (): void => {
        if (this.pending.get(request.requestId)?.request !== request) return;
        this.pending.delete(request.requestId);
        this.remember(request);
        reject(withdrawn());
      };
      if (signal.aborted) {
        reject(withdrawn());
        return;
      }
      signal.addEventListener('abort', withdraw, { once: true });
      this.pending.set(request.requestId, {
        request,
        resolve: (result) => {
          signal.removeEventListener('abort', withdraw);
          resolve(result);
        },
      });
      for (const subscriber of Array.from(this.subscribers))
        subscriber(request);
    });
  }

  /** Settle a pending request exactly once. */
  respond(
    executionId: string,
    requestId: string,
    result: WorkerPipelineHostResult,
  ): WorkerPipelineHostRespondResult {
    const pending = this.pending.get(requestId);
    if (pending?.request.executionId === executionId) {
      this.pending.delete(requestId);
      const settledAt = this.remember(pending.request);
      pending.resolve(result);
      return { executionId, requestId, outcome: 'applied', settledAt };
    }
    const done = this.done.get(requestId);
    if (done?.executionId === executionId)
      return {
        executionId,
        requestId,
        outcome: 'already_settled',
        settledAt: done.settledAt,
      };
    throw hostRequestNotFoundError();
  }

  private remember(request: WorkerPipelineHostRequest): string {
    const settledAt = new Date().toISOString();
    this.done.delete(request.requestId);
    this.done.set(request.requestId, {
      executionId: request.executionId,
      settledAt,
    });
    for (const key of Array.from(this.done.keys())) {
      if (this.done.size <= SETTLED_MEMORY) break;
      this.done.delete(key);
    }
    return settledAt;
  }

  /** Deliver every pending request, then each new one. */
  subscribe(
    subscriber: (request: WorkerPipelineHostRequest) => void,
  ): () => void {
    this.subscribers.add(subscriber);
    for (const { request } of Array.from(this.pending.values()))
      subscriber(request);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

export interface WorkerPipelineHostRequestHandlers {
  instructions: {
    'worker.pipeline.hostRequest.respond': CanopyInstructionHandler<
      'worker.pipeline.hostRequest.respond',
      CanopyHandlerContext
    >;
  };
  streams: Pick<
    CanopyStreamHandlerMap<CanopyHandlerContext>,
    'worker.pipeline.hostRequests'
  >;
}

export function createWorkerPipelineHostRequestHandlers(
  broker: PipelineHostRequestBroker,
): WorkerPipelineHostRequestHandlers {
  return {
    instructions: {
      'worker.pipeline.hostRequest.respond': ({
        executionId,
        requestId,
        result,
      }): Promise<WorkerPipelineHostRespondResult> =>
        Promise.resolve(broker.respond(executionId, requestId, result)),
    },
    streams: {
      'worker.pipeline.hostRequests': (
        _params,
        _context,
        sink,
      ): Promise<() => void> => {
        let stop: (() => void) | null = null;
        stop = broker.subscribe((request) => {
          if (sink.emit(request) === null) stop?.();
        });
        return Promise.resolve(() => stop?.());
      },
    },
  };
}

/** The owning core's caller for settling host requests. */
export function pipelineHostCoreCaller(
  authorityId: string,
): CanopyCallerDescriptor {
  return {
    principalId: 'core',
    clientInstanceId: 'core-pipeline-host-requests',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_PIPELINE_GRANTS.host],
  };
}

const UNEXPECTED: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: 'The host step failed unexpectedly.',
  outputs: {},
};

/**
 * The core side: subscribe to a worker's host requests, apply core policy to
 * each and settle it. An unexpected error, or a result the boundary refuses,
 * is settled as a redacted failure; its detail stays with `onError`.
 */
export async function settlePipelineHostRequests(options: {
  dispatcher: Pick<CanopyDispatcher, 'openStream' | 'instruction'>;
  caller: CanopyCallerDescriptor;
  apply(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<WorkerPipelineHostResult>;
  onError?(error: unknown, request: WorkerPipelineHostRequest): void;
}): Promise<() => void> {
  const controller = new AbortController();
  const handle = await options.dispatcher.openStream(
    'worker.pipeline.hostRequests',
    {},
    {
      caller: options.caller,
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.kind !== 'item') return;
        const request = frame.item;
        if (!isHostRequest(request)) return;
        void (async (): Promise<void> => {
          let result: WorkerPipelineHostResult;
          try {
            result = await options.apply(request, controller.signal);
          } catch (error) {
            options.onError?.(error, request);
            result = UNEXPECTED;
          }
          const respond = (
            settled: WorkerPipelineHostResult,
          ): Promise<unknown> =>
            options.dispatcher.instruction(
              'worker.pipeline.hostRequest.respond',
              {
                executionId: request.executionId,
                requestId: request.requestId,
                result: settled,
              },
              { caller: options.caller, metadata: {} },
            );
          await respond(result).catch((error: unknown) => {
            if (result === UNEXPECTED) return undefined;
            options.onError?.(error, request);
            return respond(UNEXPECTED).catch(() => undefined);
          });
        })();
      },
    },
  );
  return () => {
    controller.abort();
    handle.close();
  };
}

function isHostRequest(value: unknown): value is WorkerPipelineHostRequest {
  return typeof value === 'object' && value !== null && 'requestId' in value;
}
