import { z } from 'zod';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyQuery,
  defineCanopyStream,
  encodeCanopyError,
  type CanopyErrorPayload,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

const TEST_ERROR = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.test.notFound']).optional(),
});

const common = {
  plane: 'core',
  domain: 'test',
  version: 1,
  placement: 'core-only',
  requiredGrants: [],
  error: TEST_ERROR,
} as const;

/** Test-only operations; `core.test.hidden` is defined but never advertised. */
export const CANONICAL_DEFINITIONS = {
  queries: {
    'core.test.echo': defineCanopyQuery({
      ...common,
      idempotency: 'inherent',
      params: z.strictObject({
        text: z.string(),
        delayMs: z.number().int().nonnegative().optional(),
      }),
      result: z.strictObject({ text: z.string(), length: z.number().int() }),
    }),
    'core.test.hidden': defineCanopyQuery({
      ...common,
      idempotency: 'inherent',
      params: z.strictObject({}),
      result: z.strictObject({}),
    }),
  },
  instructions: {
    'core.test.record': defineCanopyInstruction({
      ...common,
      idempotency: 'keyed',
      params: z.strictObject({
        value: z.number().int(),
        label: z.string().default('none'),
      }),
      result: z.strictObject({ recorded: z.number().int(), label: z.string() }),
    }),
  },
  streams: {
    'core.test.ticks': defineCanopyStream({
      ...common,
      idempotency: 'inherent',
      params: z.strictObject({
        count: z.number().int().nonnegative(),
        hold: z.boolean().optional(),
        cursor: CanopyStreamCursorSchema.nullable().optional(),
      }),
      openResult: z.object({
        subscriptionId: z.string().min(1),
        acceptedCursor: CanopyStreamCursorSchema.nullable(),
      }),
      // `pad` inflates encoded frames for byte-budget cases.
      item: z.strictObject({
        tick: z.number().int(),
        pad: z.string().optional(),
      }),
      end: CanopyStreamEndSchema.extend({
        error: TEST_ERROR.nullable(),
        pad: z.string().optional(),
      }),
    }),
  },
};

export function subscriptionIdFor(id: CanopyJsonRpcId): string {
  return `sub-${String(id)}`;
}

export function canonicalInitializeResult(
  overrides: Partial<CoreRuntimeInitializeResult> = {},
): CoreRuntimeInitializeResult {
  return {
    runtime: {
      runtimeId: 'runtime-1',
      hostId: 'host-1',
      authorityId: 'authority-1',
      profile: 'core+worker',
      daemonEpoch: 'epoch-1',
      protocolVersions: [1],
      state: 'ready',
      buildVersion: '0.0.0-canonical',
    },
    selectedProtocolVersion: 1,
    capabilities: {
      operations: ['core.test.echo', 'core.test.record'],
      events: [],
      streams: ['core.test.ticks'],
    },
    limits: {},
    authentication: { required: true, methods: [] },
    ...overrides,
  };
}

export type CanonicalHandlers = Record<
  string,
  (params: Record<string, unknown>) => unknown
>;

/** Thrown by a handler to answer with a typed operation error. */
export class CanonicalCoreError extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
  }
}

export interface CanonicalCoreServer {
  /** Every request the core received, initialize included. */
  readonly requests: readonly CanopyJsonRpcRequest[];
  /** Settles when the connection closes. */
  readonly done: Promise<void>;
  /** Sends the next item of an open stream; the core keeps one sequence. */
  emit(subscriptionId: string, item: unknown): Promise<void>;
  /** Ends an open stream as completed at its last cursor. */
  end(subscriptionId: string): Promise<void>;
}

/**
 * Plays a canonical core on `server`: answers `core.runtime.initialize`
 * (overridable by a handler) and runs handlers concurrently, so replies can
 * land out of order. Serves `core.test.ticks` after any handler for it, which
 * may throw, return a replacement open result, or return nothing: `count`
 * ticks follow the open reply, then an end unless `hold` is set.
 */
export function serveCanonicalCore(
  server: CanopyFramedConnection,
  handlers: CanonicalHandlers,
  options: { initialize?: CoreRuntimeInitializeResult } = {},
): CanonicalCoreServer {
  const initialize = options.initialize ?? canonicalInitializeResult();
  const { daemonEpoch } = initialize.runtime;
  const requests: CanopyJsonRpcRequest[] = [];
  /** The last cursor sequence of each open `core.test.ticks` subscription. */
  const streams = new Map<string, number>();
  let sequence = 0;
  const send = (message: CanopyJsonRpcMessage): Promise<void> =>
    server.send(message).catch(() => {});
  const lastSequence = (subscriptionId: string): number => {
    const last = streams.get(subscriptionId);
    if (last === undefined) throw new Error(`No open ${subscriptionId}.`);
    return last;
  };
  const emit = (subscriptionId: string, item: unknown): Promise<void> => {
    lastSequence(subscriptionId);
    streams.set(subscriptionId, (sequence += 1));
    return send({
      jsonrpc: '2.0',
      method: 'core.test.ticks.item',
      params: {
        subscriptionId,
        cursor: { daemonEpoch, sequence },
        itemId: `item-${sequence}`,
        occurredAt: '2026-10-07T12:00:00Z',
        item,
      },
    });
  };
  const end = (subscriptionId: string): Promise<void> => {
    const cursor = { daemonEpoch, sequence: lastSequence(subscriptionId) };
    streams.delete(subscriptionId);
    return send({
      jsonrpc: '2.0',
      method: 'core.test.ticks.end',
      params: { subscriptionId, cursor, outcome: 'completed', error: null },
    });
  };
  const serveStream = async (request: CanopyJsonRpcRequest): Promise<void> => {
    const { id, params } = request;
    const subscriptionId = subscriptionIdFor(id);
    streams.set(subscriptionId, sequence);
    await send({
      jsonrpc: '2.0',
      id,
      result: { subscriptionId, acceptedCursor: params.cursor ?? null },
    });
    const count = typeof params.count === 'number' ? params.count : 0;
    for (let tick = 0; tick < count; tick += 1)
      await emit(subscriptionId, { tick });
    if (params.hold !== true) await end(subscriptionId);
  };
  const answer = async (request: CanopyJsonRpcRequest): Promise<void> => {
    const { id, method } = request;
    const handler = Object.prototype.hasOwnProperty.call(handlers, method)
      ? handlers[method]
      : undefined;
    const streamed = method === 'core.test.ticks';
    if (!handler && method === 'core.runtime.initialize')
      return send({ jsonrpc: '2.0', id, result: initialize });
    if (!handler && !streamed)
      return send({
        jsonrpc: '2.0',
        id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: `Unknown method ${method}.`,
        },
      });
    try {
      const result = handler ? await handler(request.params) : undefined;
      if (streamed && result === undefined) return await serveStream(request);
      return await send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const payload: CanopyErrorPayload =
        error instanceof CanonicalCoreError
          ? error.payload
          : {
              kind: 'internal',
              message: 'Handler failed.',
              retry: { kind: 'never' },
            };
      return send({ jsonrpc: '2.0', id, error: encodeCanopyError(payload) });
    }
  };
  const done = (async (): Promise<void> => {
    for (;;) {
      const message = await server.receive().catch(() => null);
      if (!message) return;
      if (!('method' in message) || !('id' in message)) continue;
      requests.push(message);
      void answer(message);
    }
  })();
  return { requests, done, emit, end };
}
