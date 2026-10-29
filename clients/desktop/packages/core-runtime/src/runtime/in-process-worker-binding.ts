import {
  CanopyCallerDescriptorSchema,
  CanopyErrorPayloadSchema,
  CanopyJsonRpcMessageSchema,
  CanopyJsonRpcRequestSchema,
  composeCanopyOperationEnvelopes,
  decodeCanopyError,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
} from '@canopy/protocol/canopy-core';
import type { CanopyDispatcher, InProcessCanopyClient } from './types';
import {
  CanopyOperationError,
  canopyCancelledError,
  canopyCapabilityUnavailableError,
  canopyDeadlineExceededError,
  canopyInvalidArgumentError,
  canopyInvalidHandlerResultError,
  canopyUnavailableError,
} from './errors';

/** Host adapter owns serialization, envelope framing, and bounded delivery. */
export interface WorkerBindingConnection {
  readonly signal: AbortSignal;
  send(message: CanopyJsonRpcMessage): Promise<void>;
  receive(): Promise<CanopyJsonRpcMessage>;
  close(error?: CanopyErrorPayload): void;
}

/** Structurally compatible with L0's pair; concrete transport stays in the host. */
export interface WorkerBindingPair {
  readonly client: WorkerBindingConnection;
  readonly server: WorkerBindingConnection;
}

export interface InProcessWorkerBinding extends InProcessCanopyClient {
  close(): void;
}

interface PendingQuery {
  reply(message: CanopyJsonRpcMessage): void;
  fail(error: CanopyOperationError): void;
}
const MAX_PENDING = 128;

/** W1 carries queries only. The host must inject a real serializing binding. */
export function createInProcessWorkerBinding(
  dispatcher: CanopyDispatcher,
  callerInput: CanopyCallerDescriptor,
  pair: WorkerBindingPair,
): InProcessWorkerBinding {
  if (dispatcher.profile !== 'worker')
    throw new Error('Worker binding requires a worker graph');
  const caller = CanopyCallerDescriptorSchema.parse(callerInput);
  Object.freeze(caller.grants);
  Object.freeze(caller);
  const pending = new Map<string, PendingQuery>();
  let sequence = 0;
  let closed = false;
  let active = 0;
  let requestSends = 0;
  let replySends = 0;
  const replyWaiters: Array<() => void> = [];
  const stop = (error: CanopyOperationError): void => {
    if (closed) return;
    closed = true;
    pair.client.signal.removeEventListener('abort', disconnected);
    pair.server.signal.removeEventListener('abort', disconnected);
    pending.forEach((query) => query.fail(error));
    pending.clear();
    for (const resume of replyWaiters.splice(0)) resume();
    pair.client.close(error.payload);
    pair.server.close(error.payload);
  };
  const disconnected = (): void => stop(canopyUnavailableError());
  const transportFailure = (error: unknown): void => {
    const payload = CanopyErrorPayloadSchema.safeParse(
      typeof error === 'object' && error !== null && 'payload' in error
        ? error.payload
        : undefined,
    );
    stop(
      payload.success
        ? new CanopyOperationError(payload.data)
        : canopyUnavailableError(),
    );
  };
  const sendReply = async (response: CanopyJsonRpcMessage): Promise<void> => {
    if (closed) return;
    if (replySends >= MAX_PENDING) {
      if (replyWaiters.length >= MAX_PENDING) throw canopyUnavailableError();
      await new Promise<void>((resolve) => replyWaiters.push(resolve));
    } else replySends += 1;
    if (closed) return;
    try {
      await pair.server.send(response);
    } finally {
      const next = replyWaiters.shift();
      if (next) next();
      else replySends -= 1;
    }
  };
  const serve = async (request: CanopyJsonRpcRequest): Promise<void> => {
    const { id, method, params } = request;
    let response: CanopyJsonRpcMessage;
    try {
      const { _meta, ...body } = params;
      const result = await dispatcher.query(method, body, {
        caller,
        metadata: _meta,
        signal: pair.server.signal,
      });
      response = { jsonrpc: '2.0', id, result };
    } catch (error) {
      const payload =
        error instanceof CanopyOperationError
          ? error.payload
          : canopyInvalidHandlerResultError().payload;
      response = {
        jsonrpc: '2.0',
        id,
        error: encodeCanopyError(payload),
      };
    } finally {
      active -= 1;
    }
    // A peer can read the reply before send resolves under write backpressure.
    await sendReply(response);
  };
  const readWorker = async (): Promise<void> => {
    while (!closed) {
      const request = CanopyJsonRpcRequestSchema.parse(
        await pair.server.receive(),
      );
      if (active >= MAX_PENDING)
        throw new Error('Worker request capacity exceeded');
      active += 1;
      void serve(request).catch(transportFailure);
    }
  };
  const readCore = async (): Promise<void> => {
    while (!closed) {
      const message = CanopyJsonRpcMessageSchema.parse(
        await pair.client.receive(),
      );
      if (
        !('id' in message) ||
        'method' in message ||
        typeof message.id !== 'string'
      )
        throw canopyInvalidHandlerResultError();
      const query = pending.get(message.id);
      if (!query) throw canopyInvalidHandlerResultError();
      pending.delete(message.id);
      query.reply(message);
    }
  };
  pair.client.signal.addEventListener('abort', disconnected, { once: true });
  pair.server.signal.addEventListener('abort', disconnected, { once: true });
  if (pair.client.signal.aborted || pair.server.signal.aborted) disconnected();
  else {
    void readWorker().catch(transportFailure);
    void readCore().catch(transportFailure);
  }
  return {
    async query(name, params, options = {}): Promise<unknown> {
      if (closed) throw canopyUnavailableError();
      const definition = Object.prototype.hasOwnProperty.call(
        dispatcher.definitions,
        name,
      )
        ? dispatcher.definitions[name]
        : undefined;
      if (!definition) throw canopyCapabilityUnavailableError();
      const envelopes = composeCanopyOperationEnvelopes(name, definition);
      const id = `worker-request-${++sequence}`;
      let request: CanopyJsonRpcRequest;
      try {
        const parsed = definition.params.parse(params);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        )
          throw new Error('Operation params must be an object');
        request = CanopyJsonRpcRequestSchema.parse({
          jsonrpc: '2.0',
          id,
          method: name,
          params: {
            ...parsed,
            ...(options.metadata === undefined
              ? {}
              : { _meta: options.metadata }),
          },
        });
        envelopes.request.parse(request);
      } catch {
        throw canopyInvalidArgumentError('Invalid worker transport request.');
      }
      if (options.signal?.aborted) throw canopyCancelledError();
      const deadline = request.params._meta?.deadlineAt;
      const deadlineAt =
        deadline === undefined ? undefined : Date.parse(deadline);
      if (deadlineAt !== undefined && deadlineAt <= Date.now())
        throw canopyDeadlineExceededError();
      if (pending.size >= MAX_PENDING || requestSends >= MAX_PENDING)
        throw new CanopyOperationError({
          kind: 'resource_exhausted',
          message: 'Worker request capacity exceeded.',
          retry: { kind: 'never' },
        });
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): boolean => {
          if (settled) return false;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', cancel);
          return true;
        };
        // The wire has no query-cancel frame: retain the ID until its late reply.
        const fail = (error: CanopyOperationError): void => {
          if (finish()) reject(error);
        };
        const cancel = (): void => fail(canopyCancelledError());
        pending.set(id, {
          fail,
          reply: (message): void => {
            if (!finish()) return;
            try {
              const parsed = CanopyJsonRpcMessageSchema.parse(
                envelopes.response.parse(message),
              );
              if ('error' in parsed)
                reject(
                  new CanopyOperationError(decodeCanopyError(parsed.error)),
                );
              else if ('result' in parsed) resolve(parsed.result);
              else reject(canopyInvalidHandlerResultError());
            } catch {
              reject(canopyInvalidHandlerResultError());
            }
          },
        });
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (deadlineAt !== undefined) {
          const schedule = (): void => {
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) fail(canopyDeadlineExceededError());
            else
              timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
          };
          schedule();
        }
        if (options.signal?.aborted) cancel();
        requestSends += 1;
        void pair.client
          .send(request)
          .catch(transportFailure)
          .finally(() => {
            requestSends -= 1;
          });
      });
    },
    close: (): void => stop(canopyUnavailableError()),
    instruction: (): Promise<never> =>
      Promise.reject(canopyCapabilityUnavailableError()),
    openStream: (): Promise<never> =>
      Promise.reject(canopyCapabilityUnavailableError()),
  };
}
