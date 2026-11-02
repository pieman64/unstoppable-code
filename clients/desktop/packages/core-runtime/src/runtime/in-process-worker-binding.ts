import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CanopyCallerDescriptorSchema,
  CanopyErrorPayloadSchema,
  CanopyJsonRpcMessageSchema,
  CanopyJsonRpcRequestSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  composeCanopyOperationEnvelopes,
  decodeCanopyError,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyHostExecution,
  type CanopyInstructionDefinition,
  type CanopyInstructionDefinitionMap,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyJsonRpcRequest,
  type CanopyOperationEnvelopes,
  type CanopyQueryDefinition,
  type CanopyQueryDefinitionMap,
  type CanopyRequestMetadata,
  type CanopyStreamDefinition,
  type CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from './dispatcher';
import type {
  CanopyDispatcher,
  CanopyHandlerContext,
  CanopyRuntimeDefinitionMaps,
  CanopyStreamHandle,
  CanopyStreamSink,
  InProcessCanopyClient,
} from './types';
import { hostExecutionOption } from './host-execution';
import type { LocalWorkerTransport } from './local-worker-transport';
import { paramsDeclareMeta } from './request-metadata';
import {
  parseWorkerExecutorReceipt,
  type WorkerExecutorReceipt,
  type WorkerExecutorReceipts,
} from './worker-executor-receipts';
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

// `execution` crosses only to this same-host worker (CAN-5496); a transport
// to any other target must drop or refuse it.
type ForwardedContext = Pick<
  CanopyHandlerContext,
  'metadata' | 'signal' | 'execution'
>;
type ForwardedCall = (
  params: unknown,
  context: ForwardedContext,
) => Promise<unknown>;
type ForwardedStream = (
  params: unknown,
  context: ForwardedContext,
  sink: CanopyStreamSink<unknown>,
) => Promise<() => void>;

/** Core-dispatcher handlers that reach the worker only across the pair. */
export interface InProcessWorkerBindingForwarders {
  readonly queries: Readonly<Record<string, ForwardedCall>>;
  readonly instructions: Readonly<Record<string, ForwardedCall>>;
  readonly streams: Readonly<Record<string, ForwardedStream>>;
}

export interface InProcessWorkerBinding extends InProcessCanopyClient {
  readonly forwarders: InProcessWorkerBindingForwarders;
  /**
   * Asks the worker how a keyed instruction it was sent settled, waiting for
   * a running one; null when it never arrived. Never sends it again.
   */
  receipt(
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null>;
  /** The core recorded the outcome; the worker may forget its receipt. */
  releaseReceipt(operation: string, idempotencyKey: string): void;
  close(): void;
}

export interface CreateInProcessWorkerBindingOptions {
  readonly dispatcher: CanopyDispatcher;
  /** The worker dispatcher's maps; the dispatcher exposes only its queries. */
  readonly definitions: CanopyRuntimeDefinitionMaps<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap
  >;
  readonly caller: CanopyCallerDescriptor;
  readonly pair: WorkerBindingPair;
  /**
   * The worker's executor receipts, recorded by its wrapped instruction
   * handlers. Without them every receipt lookup answers that nothing arrived.
   */
  readonly receipts?: WorkerExecutorReceipts;
}

type EnvelopeSchema = CanopyOperationEnvelopes['request'];
type CallKind = 'query' | 'instruction' | 'stream';
interface BoundOperation {
  readonly definition:
    | CanopyQueryDefinition
    | CanopyInstructionDefinition
    | CanopyStreamDefinition;
  readonly envelopes: CanopyOperationEnvelopes;
  /** The params schema declares `_meta`, so the worker keeps it in params. */
  readonly declaresMeta: boolean;
}
interface PendingCall {
  reply(message: CanopyJsonRpcMessage): void;
  fail(error: CanopyOperationError): void;
}
interface StreamRoute {
  readonly name: string;
  readonly requestId: string;
  readonly notification: EnvelopeSchema;
  /** Null once the stream ended locally; later worker frames are dropped. */
  sink: CanopyStreamSink<unknown> | null;
  release(): void;
}
interface CallOptions {
  metadata?: CanopyRequestMetadata;
  signal?: AbortSignal;
  execution?: CanopyHostExecution;
}

const MAX_PENDING = 128;
const MAX_STREAMS = 128;
/** Binding-private; `worker.binding` has no profile row, so no operation can share it. */
const CANCEL_METHOD = 'worker.binding.cancel';
/** Binding-private like cancel: a receipt lookup and its release. */
const RECEIPT_METHOD = 'worker.binding.receipt';
const RELEASE_METHOD = 'worker.binding.receipt.release';
const EndOutcomeSchema = CanopyStreamEndSchema.pick({
  outcome: true,
  error: true,
});

function capacityError(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'resource_exhausted',
    message,
    retry: { kind: 'never' },
  });
}
function errorResponse(
  id: CanopyJsonRpcId,
  error: unknown,
): CanopyJsonRpcMessage {
  const payload =
    error instanceof CanopyOperationError
      ? error.payload
      : canopyInvalidHandlerResultError().payload;
  return { jsonrpc: '2.0', id, error: encodeCanopyError(payload) };
}
function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}
/**
 * The dispatcher's retry class for a failure the binding raises itself, so a
 * lost reply never invites a blind repeat of a non-idempotent effect.
 */
function directed(
  definition: BoundOperation['definition'],
  error: CanopyOperationError,
): CanopyOperationError {
  const { retry } = error.payload;
  if (
    definition.kind !== 'instruction' ||
    definition.idempotency === 'inherent' ||
    retry.kind !== 'same_request'
  )
    return error;
  return new CanopyOperationError(
    {
      ...error.payload,
      retry:
        definition.idempotency === 'keyed'
          ? { ...retry, kind: 'same_idempotency_key' }
          : { kind: 'never' },
    },
    error.runtimeCause,
  );
}
function subscriptionOf(result: unknown): string | undefined {
  return typeof result === 'object' &&
    result !== null &&
    'subscriptionId' in result &&
    typeof result.subscriptionId === 'string'
    ? result.subscriptionId
    : undefined;
}

/**
 * Carries worker queries, instructions and streams over a host-injected
 * serializing pair. Both sides check grants; cancellation crosses as a
 * binding-private notification.
 */
export function createInProcessWorkerBinding({
  dispatcher,
  definitions,
  caller: callerInput,
  pair,
  receipts,
}: CreateInProcessWorkerBindingOptions): InProcessWorkerBinding {
  if (dispatcher.profile !== 'worker')
    throw new Error('Worker binding requires a worker graph');
  const caller = CanopyCallerDescriptorSchema.parse(callerInput);
  Object.freeze(caller.grants);
  Object.freeze(caller);
  // Composed eagerly: a definition the wire cannot carry fails at build.
  const bindAll = (
    kind: CallKind,
    map: Readonly<Record<string, BoundOperation['definition']>>,
  ): Map<string, BoundOperation> => {
    const bound = new Map<string, BoundOperation>();
    for (const [name, definition] of Object.entries(map)) {
      if (definition.kind !== kind)
        throw new Error(`Worker binding ${name} must declare kind ${kind}`);
      const envelopes = composeCanopyOperationEnvelopes(name, definition);
      bound.set(name, {
        definition,
        envelopes,
        declaresMeta: paramsDeclareMeta(definition.params),
      });
    }
    return bound;
  };
  const operations: Record<CallKind, Map<string, BoundOperation>> = {
    query: bindAll('query', definitions.queries),
    instruction: bindAll('instruction', definitions.instructions),
    stream: bindAll('stream', definitions.streams),
  };
  const pending = new Map<string, PendingCall>();
  const routes = new Map<string, StreamRoute>();
  const served = new Map<CanopyJsonRpcId, AbortController>();
  let sequence = 0;
  let closed = false;
  let active = 0;
  let openingStreams = 0;
  let requestSends = 0;
  let replySends = 0;
  const replyWaiters: Array<() => void> = [];
  const stop = (error: CanopyOperationError): void => {
    if (closed) return;
    closed = true;
    pair.client.signal.removeEventListener('abort', disconnected);
    pair.server.signal.removeEventListener('abort', disconnected);
    // Served calls abort here, not through a per-call AbortSignal.any.
    served.forEach((controller) => controller.abort());
    pending.forEach((call) => call.fail(error));
    pending.clear();
    const open = Array.from(routes.values());
    routes.clear();
    for (const route of open) {
      const { sink } = route;
      route.sink = null;
      route.release();
      sink?.end('error', error.payload);
    }
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

  // Worker side.
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
  // Frames skip the reply waiters: one send in flight per open stream.
  const pumpStream = async (
    { id, method }: CanopyJsonRpcRequest,
    handle: CanopyStreamHandle<unknown, unknown>,
  ): Promise<void> => {
    const { subscriptionId } = handle.openResult;
    for await (const frame of handle.frames) {
      if (closed) return;
      if (frame.kind === 'end') {
        // Freed before the end crosses: the core reuses the slot on receipt.
        served.delete(id);
        return pair.server.send({
          jsonrpc: '2.0',
          method: `${method}.end`,
          params: { subscriptionId, ...without(frame, 'kind') },
        });
      }
      await pair.server.send({
        jsonrpc: '2.0',
        method: `${method}.item`,
        params: {
          subscriptionId,
          cursor: frame.cursor,
          itemId: `item-${frame.cursor.sequence}`,
          occurredAt: new Date().toISOString(),
          item: frame.item,
        },
      });
    }
  };
  const serveStream = async (
    request: CanopyJsonRpcRequest,
    operation: BoundOperation,
    signal: AbortSignal,
  ): Promise<void> => {
    const { id, method, params } = request;
    const {
      _meta,
      [CANOPY_HOST_EXECUTION_MEMBER]: execution,
      ...body
    } = params;
    let executionOption: ReturnType<typeof hostExecutionOption>;
    try {
      executionOption = hostExecutionOption(execution);
    } catch (error) {
      active -= 1;
      served.delete(id);
      return sendReply(errorResponse(id, error));
    }
    const opened = await dispatcher
      .openStream(
        method,
        operation.declaresMeta
          ? without(params, CANOPY_HOST_EXECUTION_MEMBER)
          : body,
        { caller, metadata: _meta, signal, ...executionOption },
      )
      .then(
        (handle) => ({ handle }),
        (error: unknown) => ({ error }),
      );
    active -= 1;
    if (!('handle' in opened)) {
      served.delete(id);
      return sendReply(errorResponse(id, opened.error));
    }
    const { handle } = opened;
    const reply: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      result: handle.openResult,
    };
    if (!operation.envelopes.response.safeParse(reply).success) {
      handle.close();
      served.delete(id);
      return sendReply(errorResponse(id, canopyInvalidHandlerResultError()));
    }
    try {
      await sendReply(reply);
      await pumpStream(request, handle);
    } finally {
      // Still served: the pump stopped before the end, so stop the stream too.
      if (served.delete(id)) handle.close();
    }
  };
  const serveReceipt = async (
    { id, params }: CanopyJsonRpcRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    let response: CanopyJsonRpcMessage;
    try {
      const { operation, idempotencyKey } = params;
      if (typeof operation !== 'string' || typeof idempotencyKey !== 'string')
        throw canopyInvalidArgumentError('Invalid worker receipt request.');
      const receipt =
        (await receipts?.settled(
          caller.principalId,
          operation,
          idempotencyKey,
          signal,
        )) ?? null;
      response = { jsonrpc: '2.0', id, result: { receipt } };
    } catch (error) {
      response = errorResponse(
        id,
        signal.aborted ? canopyUnavailableError() : error,
      );
    } finally {
      active -= 1;
      served.delete(id);
    }
    await sendReply(response);
  };
  const serve = async (
    request: CanopyJsonRpcRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const { id, method, params } = request;
    if (method === RECEIPT_METHOD) return serveReceipt(request, signal);
    const stream = operations.stream.get(method);
    if (stream) return serveStream(request, stream, signal);
    const instruction = operations.instruction.get(method);
    const operation = instruction ?? operations.query.get(method);
    let response: CanopyJsonRpcMessage;
    try {
      const {
        _meta,
        [CANOPY_HOST_EXECUTION_MEMBER]: execution,
        ...body
      } = params;
      const input = operation?.declaresMeta
        ? without(params, CANOPY_HOST_EXECUTION_MEMBER)
        : body;
      const options = {
        caller,
        metadata: _meta,
        signal,
        ...hostExecutionOption(execution),
      };
      const result = instruction
        ? await dispatcher.instruction(method, input, options)
        : await dispatcher.query(method, input, options);
      response = { jsonrpc: '2.0', id, result };
    } catch (error) {
      response = errorResponse(id, error);
    } finally {
      active -= 1;
      served.delete(id);
    }
    // A peer can read the reply before send resolves under write backpressure.
    await sendReply(response);
  };
  const cancelServed = (notification: CanopyJsonRpcNotification): void => {
    if (notification.method === RELEASE_METHOD) {
      const { operation, idempotencyKey } = notification.params;
      if (typeof operation !== 'string' || typeof idempotencyKey !== 'string')
        throw new Error('Unexpected worker binding notification');
      receipts?.release(caller.principalId, operation, idempotencyKey);
      return;
    }
    const { requestId } = notification.params;
    if (
      notification.method !== CANCEL_METHOD ||
      (typeof requestId !== 'string' && typeof requestId !== 'number')
    )
      throw new Error('Unexpected worker binding notification');
    // A cancel that crossed its reply finds nothing left to stop.
    served.get(requestId)?.abort();
  };
  const readWorker = async (): Promise<void> => {
    while (!closed) {
      const message = CanopyJsonRpcMessageSchema.parse(
        await pair.server.receive(),
      );
      if (closed) return;
      if (!('method' in message))
        throw new Error('Unexpected worker binding response');
      if (!('id' in message)) {
        cancelServed(message);
        continue;
      }
      if (
        active >= MAX_PENDING ||
        served.size >= MAX_PENDING + MAX_STREAMS ||
        served.has(message.id)
      )
        throw new Error('Worker request capacity exceeded');
      // Registered before serving so a cancel right behind the request is kept.
      const controller = new AbortController();
      served.set(message.id, controller);
      active += 1;
      void serve(message, controller.signal).catch(transportFailure);
    }
  };

  // Core side.
  const sendCancel = (requestId: string): void => {
    if (closed) return;
    void pair.client
      .send({ jsonrpc: '2.0', method: CANCEL_METHOD, params: { requestId } })
      .catch(transportFailure);
  };
  const transmit = (request: CanopyJsonRpcRequest): void => {
    requestSends += 1;
    void pair.client
      .send(request)
      .catch(transportFailure)
      .finally(() => {
        requestSends -= 1;
      });
  };
  const admit = (
    kind: CallKind,
    name: string,
    params: unknown,
    { metadata, signal, execution }: CallOptions,
  ): {
    id: string;
    request: CanopyJsonRpcRequest;
    operation: BoundOperation;
    deadlineAt: number | undefined;
  } => {
    const operation = operations[kind].get(name);
    if (closed)
      throw operation
        ? directed(operation.definition, canopyUnavailableError())
        : canopyUnavailableError();
    if (!operation) throw canopyCapabilityUnavailableError();
    const id = `worker-request-${++sequence}`;
    let request: CanopyJsonRpcRequest;
    try {
      const parsed = operation.definition.params.parse(params);
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
          ...(metadata === undefined ? {} : { _meta: metadata }),
          // The composed envelope admits it only on opted-in operations.
          ...(execution === undefined
            ? {}
            : { [CANOPY_HOST_EXECUTION_MEMBER]: execution }),
        },
      });
      operation.envelopes.request.parse(request);
    } catch {
      throw canopyInvalidArgumentError('Invalid worker transport request.');
    }
    if (signal?.aborted) throw canopyCancelledError();
    const deadline = request.params._meta?.deadlineAt;
    const deadlineAt =
      deadline === undefined ? undefined : Date.parse(deadline);
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      throw directed(operation.definition, canopyDeadlineExceededError());
    if (pending.size >= MAX_PENDING || requestSends >= MAX_PENDING)
      throw capacityError('Worker request capacity exceeded.');
    return { id, request, operation, deadlineAt };
  };
  const call = async (
    kind: 'query' | 'instruction',
    name: string,
    params: unknown,
    options: CallOptions,
  ): Promise<unknown> => {
    const { id, request, operation, deadlineAt } = admit(
      kind,
      name,
      params,
      options,
    );
    const { signal } = options;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        return true;
      };
      // The ID stays pending until the worker's late reply consumes it.
      const fail = (error: CanopyOperationError): void => {
        if (!finish()) return;
        reject(directed(operation.definition, error));
        sendCancel(id);
      };
      const cancel = (): void => fail(canopyCancelledError());
      pending.set(id, {
        fail,
        reply: (message): void => {
          if (!finish()) return;
          try {
            const parsed = CanopyJsonRpcMessageSchema.parse(
              operation.envelopes.response.parse(message),
            );
            if ('error' in parsed)
              reject(new CanopyOperationError(decodeCanopyError(parsed.error)));
            else if ('result' in parsed) resolve(parsed.result);
            else reject(canopyInvalidHandlerResultError());
          } catch {
            reject(canopyInvalidHandlerResultError());
          }
        },
      });
      // Sent first: a cancel must never reach the worker ahead of its request.
      transmit(request);
      signal?.addEventListener('abort', cancel, { once: true });
      if (deadlineAt !== undefined) {
        const schedule = (): void => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) fail(canopyDeadlineExceededError());
          else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
        };
        schedule();
      }
      if (signal?.aborted) cancel();
    });
  };
  const receipt = (
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null> => {
    if (closed) return Promise.reject(canopyUnavailableError());
    if (pending.size >= MAX_PENDING || requestSends >= MAX_PENDING)
      return Promise.reject(capacityError('Worker request capacity exceeded.'));
    const id = `worker-request-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        fail: reject,
        reply: (message): void => {
          if ('error' in message) {
            reject(new CanopyOperationError(decodeCanopyError(message.error)));
            return;
          }
          const result = 'result' in message ? message.result : undefined;
          const value =
            typeof result === 'object' && result !== null && 'receipt' in result
              ? result.receipt
              : undefined;
          const parsed =
            value === null ? null : parseWorkerExecutorReceipt(value);
          if (parsed === undefined) reject(canopyInvalidHandlerResultError());
          else resolve(parsed);
        },
      });
      transmit({
        jsonrpc: '2.0',
        id,
        method: RECEIPT_METHOD,
        params: { operation, idempotencyKey },
      });
    });
  };
  const releaseReceipt = (operation: string, idempotencyKey: string): void => {
    if (closed) return;
    void pair.client
      .send({
        jsonrpc: '2.0',
        method: RELEASE_METHOD,
        params: { operation, idempotencyKey },
      })
      .catch(transportFailure);
  };
  const detach = (route: StreamRoute): void => {
    if (route.sink === null) return;
    route.sink = null;
    route.release();
    sendCancel(route.requestId);
  };
  /**
   * Bridges a worker stream into the calling dispatcher's sink, which owns the
   * frame queue, its bound, cursor order and the end schema.
   */
  const openRemoteStream = (
    name: string,
    params: unknown,
    options: CallOptions,
    sink: CanopyStreamSink<unknown>,
  ): Promise<() => void> => {
    const { id, request, operation } = admit('stream', name, params, options);
    const { notification } = operation.envelopes;
    if (notification === undefined) throw canopyCapabilityUnavailableError();
    if (routes.size + openingStreams >= MAX_STREAMS)
      throw capacityError('Worker stream capacity exceeded.');
    const { signal } = options;
    openingStreams += 1;
    return new Promise((resolve, reject) => {
      let opening = true;
      const onAbort = (): void => {
        if (!opening) return detach(route);
        opening = false;
        reject(canopyCancelledError());
        sendCancel(id);
      };
      const route: StreamRoute = {
        name,
        requestId: id,
        notification,
        sink,
        release: () => signal?.removeEventListener('abort', onAbort),
      };
      pending.set(id, {
        fail: (error): void => {
          route.release();
          if (opening) reject(error);
          opening = false;
        },
        reply: (message): void => {
          openingStreams -= 1;
          const wasOpening = opening;
          opening = false;
          const valid = operation.envelopes.response.safeParse(message).success;
          if (!('result' in message)) {
            route.release();
            if (wasOpening)
              reject(
                valid && 'error' in message
                  ? new CanopyOperationError(decodeCanopyError(message.error))
                  : canopyInvalidHandlerResultError(),
              );
            return;
          }
          const subscriptionId = subscriptionOf(message.result);
          if (subscriptionId === undefined || routes.has(subscriptionId)) {
            route.release();
            if (wasOpening) reject(canopyInvalidHandlerResultError());
            // Frames for an unroutable subscription cannot be delivered safely.
            throw canopyInvalidHandlerResultError();
          }
          routes.set(subscriptionId, route);
          // Abandoned during open: its cancel is already on the wire.
          if (!wasOpening) {
            route.sink = null;
            route.release();
          } else if (!valid) {
            reject(canopyInvalidHandlerResultError());
            detach(route);
          } else resolve(() => detach(route));
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      transmit(request);
    });
  };
  const deliver = (message: CanopyJsonRpcNotification): void => {
    const { params } = message;
    const subscriptionId =
      typeof params.subscriptionId === 'string' ? params.subscriptionId : '';
    const route = routes.get(subscriptionId);
    const end = route !== undefined && message.method === `${route.name}.end`;
    if (!route || (!end && message.method !== `${route.name}.item`))
      throw canopyInvalidHandlerResultError();
    const valid = route.notification.safeParse(message).success;
    if (end) {
      routes.delete(subscriptionId);
      const { sink } = route;
      route.sink = null;
      route.release();
      const parsed = EndOutcomeSchema.safeParse({
        outcome: params.outcome,
        error: params.error,
      });
      if (valid && parsed.success)
        sink?.end(parsed.data.outcome, parsed.data.error ?? undefined);
      else sink?.end('error', canopyInvalidHandlerResultError().payload);
      return;
    }
    if (route.sink === null) return;
    const cursor = CanopyStreamCursorSchema.safeParse(params.cursor);
    if (!valid || !cursor.success) {
      route.sink.end('error', canopyInvalidHandlerResultError().payload);
      return detach(route);
    }
    // Null: the dispatcher ended the stream on cursor order or its bound.
    if (route.sink.emitAt(cursor.data, params.item) === null) detach(route);
  };
  const readCore = async (): Promise<void> => {
    while (!closed) {
      const message = CanopyJsonRpcMessageSchema.parse(
        await pair.client.receive(),
      );
      if ('method' in message) {
        if ('id' in message) throw canopyInvalidHandlerResultError();
        deliver(message);
        continue;
      }
      if (typeof message.id !== 'string')
        throw canopyInvalidHandlerResultError();
      const call = pending.get(message.id);
      if (!call) throw canopyInvalidHandlerResultError();
      pending.delete(message.id);
      call.reply(message);
    }
  };
  pair.client.signal.addEventListener('abort', disconnected, { once: true });
  pair.server.signal.addEventListener('abort', disconnected, { once: true });
  if (pair.client.signal.aborted || pair.server.signal.aborted) disconnected();
  else {
    void readWorker().catch(transportFailure);
    void readCore().catch(transportFailure);
  }

  const queries: Record<string, ForwardedCall> = {};
  const instructions: Record<string, ForwardedCall> = {};
  const streams: Record<string, ForwardedStream> = {};
  for (const name of Object.keys(definitions.queries))
    queries[name] = (
      params,
      { metadata, signal, execution },
    ): Promise<unknown> =>
      call('query', name, params, { metadata, signal, execution });
  for (const name of Object.keys(definitions.instructions))
    instructions[name] = (
      params,
      { metadata, signal, execution },
    ): Promise<unknown> =>
      call('instruction', name, params, { metadata, signal, execution });
  for (const name of Object.keys(definitions.streams))
    streams[name] = async (
      params,
      { metadata, signal, execution },
      sink,
    ): Promise<() => void> =>
      openRemoteStream(name, params, { metadata, signal, execution }, sink);
  // Direct streams get the dispatcher's frame queue, bound and cursor checks.
  const local = createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: {},
      streams: definitions.streams,
    },
    handlers: { queries: {}, instructions: {}, streams },
  });
  return {
    forwarders: { queries, instructions, streams },
    query: (name, params, options = {}): Promise<unknown> =>
      call('query', name, params, options),
    instruction: (name, params, options = {}): Promise<unknown> =>
      call('instruction', name, params, options),
    openStream: (name, params, options = {}) =>
      local.openStream(name, params, { ...options, caller }),
    receipt,
    releaseReceipt,
    close: (): void => stop(canopyUnavailableError()),
  };
}

/** The core's dispatch transport over a bundled binding (CAN-4132). */
export function localWorkerTransportOf(
  binding: InProcessWorkerBinding,
  instructions: CanopyInstructionDefinitionMap,
): LocalWorkerTransport {
  return {
    instructions,
    instruction: (name, params, options) =>
      binding.instruction(name, params, options),
    receipt: (operation, key) => binding.receipt(operation, key),
    releaseReceipt: (operation, key): void =>
      binding.releaseReceipt(operation, key),
  };
}
