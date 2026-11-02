import { z } from 'zod';

import {
  CANOPY_ERROR_KINDS,
  CANOPY_JSON_RPC_ERROR_CODES,
  CANOPY_JSON_RPC_OPERATION_ERROR_CODES,
  CanopyErrorPayloadSchema,
  CanopyEventSchema,
  CanopyJsonRpcErrorResponseSchema,
  CanopyJsonRpcNotificationSchema,
  CanopyJsonRpcRequestSchema,
  CanopyJsonRpcSuccessResponseSchema,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  canopyErrorKindForJsonRpcCode,
  canopyStreamFrameType,
  composeCanopyOperationEnvelopes,
  decodeCanopyError,
  defineCanopyInstruction,
  encodeCanopyError,
  isCanopySnapshotRequiredError,
  parseCanopyJsonRpcMessage,
  type CanopyErrorPayload,
} from '..';

const request = {
  jsonrpc: '2.0',
  id: 'req-1',
  method: 'core.runtime.health.get',
  params: { _meta: { traceparent: 'trace' } },
};
const cursor = { daemonEpoch: 'epoch-1', sequence: 4 };
const initializeResult = {
  runtime: {
    runtimeId: 'runtime-1',
    hostId: 'host-1',
    authorityId: null,
    profile: 'core+worker',
    daemonEpoch: 'epoch-1',
    protocolVersions: [1],
    state: 'ready',
    buildVersion: '0.26.8',
  },
  selectedProtocolVersion: 1,
  capabilities: {
    operations: ['core.runtime.health.get', 'core.client.lease.acquire'],
    events: ['core.chat.messageUpserted'],
    streams: ['core.events.subscribe'],
  },
  limits: {},
  authentication: { required: true, methods: [] },
};
const snapshotRequired: CanopyErrorPayload = {
  kind: 'failed_precondition',
  message: 'Cursor is too old.',
  code: 'core.events.snapshotRequired',
  retry: { kind: 'after_refresh', resource: 'core.events' },
};

describe('JSON-RPC envelope schemas', () => {
  it('accepts string and integer ids and request metadata', () => {
    expect(CanopyJsonRpcRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CanopyJsonRpcRequestSchema.safeParse({ ...request, id: 7 }).success,
    ).toBe(true);
  });

  it.each([
    ['missing jsonrpc', { ...request, jsonrpc: undefined }],
    ['wrong version', { ...request, jsonrpc: '1.0' }],
    ['empty id', { ...request, id: '' }],
    ['oversized id', { ...request, id: 'x'.repeat(513) }],
    ['fractional id', { ...request, id: 1.5 }],
    ['unknown top-level key', { ...request, extra: true }],
    ['unqualified method', { ...request, method: 'health.get' }],
    [
      'unknown _meta key',
      { ...request, params: { _meta: { principal: 'x' } } },
    ],
    ['bad deadline', { ...request, params: { _meta: { deadlineAt: 'soon' } } }],
  ])('rejects a request with %s', (_label, value) => {
    expect(CanopyJsonRpcRequestSchema.safeParse(value).success).toBe(false);
  });

  it('rejects batch arrays and invalid envelopes as invalid_argument', () => {
    const batch = parseCanopyJsonRpcMessage([request]);
    expect(batch).toMatchObject({
      success: false,
      error: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
    expect(batch.success || batch.error.message).toMatch(/batch/);
    expect(parseCanopyJsonRpcMessage({ jsonrpc: '2.0' }).success).toBe(false);
    expect(parseCanopyJsonRpcMessage(request)).toEqual({
      success: true,
      message: request,
    });
  });

  it('validates responses, errors, and notifications', () => {
    expect(
      CanopyJsonRpcSuccessResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
      }).success,
    ).toBe(true);
    expect(
      CanopyJsonRpcSuccessResponseSchema.safeParse({ jsonrpc: '2.0', id: 1 })
        .success,
    ).toBe(false);
    const errorResponse = {
      jsonrpc: '2.0',
      id: null,
      error: encodeCanopyError(snapshotRequired),
    };
    expect(
      CanopyJsonRpcErrorResponseSchema.safeParse(errorResponse).success,
    ).toBe(true);
    expect(
      CanopyJsonRpcErrorResponseSchema.safeParse({
        ...errorResponse,
        error: { ...errorResponse.error, code: -32003 },
      }).success,
    ).toBe(false);
    expect(
      CanopyJsonRpcErrorResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request.' },
      }).success,
    ).toBe(true);
    expect(
      CanopyJsonRpcErrorResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -1, message: 'Ad hoc.' },
      }).success,
    ).toBe(false);
    expect(
      CanopyJsonRpcNotificationSchema.safeParse({
        jsonrpc: '2.0',
        method: 'core.events.subscribe.item',
        params: {},
      }).success,
    ).toBe(true);
    expect(
      CanopyEventSchema.safeParse({
        cursor,
        eventId: 'event-1',
        name: 'core.chat.updated',
        scope: { chatId: 'chat-1' },
        occurredAt: '2026-10-06T12:00:00Z',
        payload: { revision: 3 },
      }).success,
    ).toBe(true);
  });
});

it.each(['core.', 'core.bad name', 'worker.x', 'core.Chat.updated'])(
  'rejects the non-canonical event name %j',
  (name) => {
    expect(
      CanopyEventSchema.safeParse({
        cursor,
        eventId: 'event-1',
        name,
        scope: {},
        occurredAt: '2026-10-06T12:00:00Z',
        payload: {},
      }).success,
    ).toBe(false);
  },
);

describe('frozen error-code mapping', () => {
  it('round-trips every error kind through its numeric code', () => {
    expect(CANOPY_JSON_RPC_OPERATION_ERROR_CODES).toEqual([
      -32602, -32001, -32002, -32003, -32004, -32005, -32006, -32007, -32008,
      -32009, -32010, -32011, -32603,
    ]);
    for (const kind of CANOPY_ERROR_KINDS) {
      const payload: CanopyErrorPayload = {
        kind,
        message: `${kind} happened.`,
        retry: { kind: 'never' },
      };
      const encoded = encodeCanopyError(payload);
      expect(encoded.code).toBe(CANOPY_JSON_RPC_ERROR_CODES[kind]);
      expect(canopyErrorKindForJsonRpcCode(encoded.code)).toBe(kind);
      expect(decodeCanopyError(encoded)).toEqual(payload);
    }
  });

  it('rejects protocol error data whose kind contradicts the code', () => {
    const mismatched = {
      code: -32600,
      message: 'Invalid request.',
      data: {
        kind: 'not_found',
        message: 'Invalid request.',
        retry: { kind: 'never' },
      },
    };
    expect(
      CanopyJsonRpcErrorResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: null,
        error: mismatched,
      }).success,
    ).toBe(false);
    expect(decodeCanopyError(mismatched)).toMatchObject({ kind: 'internal' });
    expect(
      decodeCanopyError({
        ...mismatched,
        data: { ...mismatched.data, kind: 'invalid_argument' },
      }),
    ).toMatchObject({ kind: 'invalid_argument' });
  });

  it('maps protocol codes and fails closed on malformed errors', () => {
    expect(canopyErrorKindForJsonRpcCode(-32601)).toBe(
      'capability_unavailable',
    );
    expect(canopyErrorKindForJsonRpcCode(-1)).toBeNull();
    expect(
      decodeCanopyError({ code: -32700, message: 'Parse error.' }),
    ).toMatchObject({ kind: 'invalid_argument', message: 'Parse error.' });
    expect(decodeCanopyError({ code: 42 })).toMatchObject({ kind: 'internal' });
  });
});

describe('composed operation envelopes', () => {
  it('pins each request to its method and metadata rules', () => {
    const health = composeCanopyOperationEnvelopes(
      'core.runtime.health.get',
      CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.health.get'],
    );
    expect(health.request.safeParse(request).success).toBe(true);
    expect(
      health.request.safeParse({
        ...request,
        method: 'core.runtime.initialize',
      }).success,
    ).toBe(false);
    expect(
      health.request.safeParse({
        ...request,
        params: { _meta: { idempotencyKey: 'k' } },
      }).success,
    ).toBe(false);

    const ack = composeCanopyOperationEnvelopes(
      'core.events.ack',
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
    );
    expect(
      ack.response.safeParse({
        jsonrpc: '2.0',
        id: 'a',
        result: { acknowledgedCursor: cursor },
      }).success,
    ).toBe(true);
    expect(
      ack.response.safeParse({
        jsonrpc: '2.0',
        id: 'a',
        error: encodeCanopyError({
          kind: 'not_found',
          message: 'No subscription.',
          code: 'core.events.notFound',
          retry: { kind: 'never' },
        }),
      }).success,
    ).toBe(true);
    expect(ack.notification).toBeUndefined();
  });

  it('adds request metadata to every object branch of union params', () => {
    const create = z.strictObject({ entryId: z.null() });
    const replace = z.strictObject({ ref: z.string() });
    const envelopeFor = (
      params: z.ZodType,
      idempotency: 'keyed' | 'inherent',
    ): z.ZodType =>
      composeCanopyOperationEnvelopes(
        'core.example.put',
        defineCanopyInstruction({
          plane: 'core',
          domain: 'example',
          version: 1,
          placement: 'core-only',
          params,
          result: z.object({}),
          error: CanopyErrorPayloadSchema,
          idempotency,
          requiredGrants: [],
        }),
      ).request;
    const accepts = (envelope: z.ZodType, params: unknown): boolean =>
      envelope.safeParse({
        jsonrpc: '2.0',
        id: 1,
        method: 'core.example.put',
        params,
      }).success;
    const key = { idempotencyKey: 'k' };
    for (const params of [
      z.union([create, replace]),
      z.discriminatedUnion('kind', [
        create.extend({ kind: z.literal('create') }),
        replace.extend({ kind: z.literal('replace') }),
      ]),
    ]) {
      const keyed = envelopeFor(params, 'keyed');
      const first =
        params instanceof z.ZodDiscriminatedUnion
          ? { kind: 'create', entryId: null }
          : { entryId: null };
      const second =
        params instanceof z.ZodDiscriminatedUnion
          ? { kind: 'replace', ref: 'r' }
          : { ref: 'r' };
      for (const branch of [first, second]) {
        expect(accepts(keyed, { ...branch, _meta: key })).toBe(true);
        expect(accepts(keyed, branch)).toBe(false);
        expect(accepts(keyed, { ...branch, _meta: {} })).toBe(false);
        expect(accepts(keyed, { ...branch, extra: 1, _meta: key })).toBe(false);
      }
      const inherent = envelopeFor(params, 'inherent');
      expect(accepts(inherent, first)).toBe(true);
      expect(accepts(inherent, { ...first, _meta: key })).toBe(false);
    }
    // A union with a non-object branch is left as declared.
    const mixed = envelopeFor(z.union([create, z.string()]), 'keyed');
    expect(accepts(mixed, { entryId: null })).toBe(true);
    expect(accepts(mixed, { entryId: null, _meta: key })).toBe(false);
  });

  it('requires the build version and effective allowlists in the initialize result', () => {
    const { response } = composeCanopyOperationEnvelopes(
      'core.runtime.initialize',
      CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.initialize'],
    );
    const accepts = (result: unknown): boolean =>
      response.safeParse({ jsonrpc: '2.0', id: 1, result }).success;
    const omit = (
      value: Record<string, unknown>,
      key: string,
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(value).filter(([name]) => name !== key),
      );
    const runtime = initializeResult.runtime;
    const capabilities = initializeResult.capabilities;

    expect(accepts(initializeResult)).toBe(true);
    expect(
      accepts({ ...initializeResult, runtime: omit(runtime, 'buildVersion') }),
    ).toBe(false);
    expect(
      accepts({
        ...initializeResult,
        runtime: { ...runtime, buildVersion: '' },
      }),
    ).toBe(false);
    for (const list of ['operations', 'events', 'streams'] as const) {
      expect(
        accepts({
          ...initializeResult,
          capabilities: omit(capabilities, list),
        }),
      ).toBe(false);
      for (const name of [
        'runtime.initialize',
        'core.runtime',
        'core.core.runtime.initialize',
      ])
        expect(
          accepts({
            ...initializeResult,
            capabilities: { ...capabilities, [list]: [name] },
          }),
        ).toBe(false);
      expect(
        accepts({
          ...initializeResult,
          capabilities: {
            ...capabilities,
            [list]: [capabilities[list][0], capabilities[list][0]],
          },
        }),
      ).toBe(false);
    }
    // Later minors may add capability fields; the allowlists stay required.
    expect(
      accepts({
        ...initializeResult,
        capabilities: { ...capabilities, accessModes: {} },
      }),
    ).toBe(true);
  });

  it('composes stream notifications and classifies lifecycle frames', () => {
    const name = 'core.events.subscribe';
    const envelopes = composeCanopyOperationEnvelopes(
      name,
      CORE_TRANSPORT_STREAM_DEFINITIONS[name],
    );
    const item = {
      jsonrpc: '2.0' as const,
      method: `${name}.item` as const,
      params: {
        subscriptionId: 'sub-1',
        cursor,
        itemId: 'event-1',
        occurredAt: '2026-10-06T12:00:00Z',
        item: {
          cursor,
          eventId: 'event-1',
          name: 'core.chat.updated',
          scope: {},
          occurredAt: '2026-10-06T12:00:00Z',
          payload: {},
        },
      },
    };
    const end = {
      jsonrpc: '2.0' as const,
      method: `${name}.end` as const,
      params: {
        subscriptionId: 'sub-1',
        cursor,
        outcome: 'completed',
        error: null,
      },
    };
    const stale = {
      ...end,
      params: { ...end.params, outcome: 'error', error: snapshotRequired },
    };
    for (const frame of [item, end, stale])
      expect(envelopes.notification?.safeParse(frame).success).toBe(true);
    expect(canopyStreamFrameType(name, item)).toBe('item');
    expect(canopyStreamFrameType(name, end)).toBe('end');
    expect(canopyStreamFrameType(name, stale)).toBe('snapshot_required');
    expect(canopyStreamFrameType('core.runtime.events', item)).toBeNull();
    expect(isCanopySnapshotRequiredError(snapshotRequired)).toBe(true);
    expect(
      isCanopySnapshotRequiredError({ ...snapshotRequired, kind: 'conflict' }),
    ).toBe(false);
  });
});
