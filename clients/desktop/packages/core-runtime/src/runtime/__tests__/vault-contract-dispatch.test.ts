import {
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  CORE_VAULT_QUERY_DEFINITIONS,
  CanopyErrorPayloadSchema,
  VAULT_UNCODED_ERROR_MESSAGES,
  composeCanopyOperationEnvelopes,
  vaultError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError, createCanopyDispatcher } from '../dispatcher';
import type {
  CanopyDispatcher,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherInstructionParams,
  CanopyDispatcherInstructionResultInput,
  CanopyRuntimeDefinitionMaps,
  CanopyRuntimeHandlerMaps,
} from '../types';

type EmptyMap = Record<never, never>;
type VaultQueries = typeof CORE_VAULT_QUERY_DEFINITIONS;
type VaultInstructions = typeof CORE_VAULT_INSTRUCTION_DEFINITIONS;
type VaultPutHandler =
  CanopyDispatcherInstructionHandlerMap<VaultInstructions>['core.vault.entry.put'];
type VaultDeleteHandler =
  CanopyDispatcherInstructionHandlerMap<VaultInstructions>['core.vault.entry.delete'];
type VaultPutParams = CanopyDispatcherInstructionParams<
  VaultInstructions,
  'core.vault.entry.put'
>;
type VaultPutResult = CanopyDispatcherInstructionResultInput<
  VaultInstructions,
  'core.vault.entry.put'
>;

type VaultDispatcher = CanopyDispatcher<
  typeof CORE_VAULT_QUERY_DEFINITIONS,
  typeof CORE_VAULT_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

// The vault definitions are inactive contracts; this test-only dispatcher
// proves their redaction and retry rules hold at the dispatch boundary.
const SENTINEL = 'sk-vault-dispatch-sentinel';
const ref = { vaultId: 'vault-1', entryId: 'entry-1' };
const metadata: VaultPutResult = {
  ref,
  family: 'copilot.account',
  label: 'GitHub Copilot',
  revision: 2,
  state: 'available',
  expiresAt: null,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
} as const;
const caller: CanopyCallerDescriptor = {
  principalId: 'core-domain',
  clientInstanceId: 'test-client',
  authorityId: 'test-authority',
  interfaceKind: 'test',
  grants: ['core.vault.read', 'core.vault.write'],
};
const replace = {
  ref,
  expectedRevision: 2,
  label: 'GitHub Copilot',
  secret: SENTINEL,
  expiresAt: null,
};

const statusWithSecret = {
  protection: { state: 'unknown' as const, backend: null, secret: SENTINEL },
  observedAt: null,
};

function invalidMetadataResult(): VaultPutResult {
  const result = { ...metadata, secret: SENTINEL };
  Object.defineProperty(result, 'label', {
    configurable: true,
    enumerable: true,
    value: 42,
  });
  return result;
}

function dispatcherFailing(payload: CanopyErrorPayload): VaultDispatcher {
  const fail = (): never => {
    throw new CanopyOperationError(payload);
  };
  return dispatcherWith(fail, fail);
}

function dispatcherWith(
  writePut: VaultPutHandler,
  writeDelete: VaultDeleteHandler = () => ({
    ref,
    tombstoneRevision: 3,
    revokedGrantCount: 0,
  }),
): VaultDispatcher {
  const definitions: CanopyRuntimeDefinitionMaps<
    VaultQueries,
    VaultInstructions,
    EmptyMap
  > = {
    queries: CORE_VAULT_QUERY_DEFINITIONS,
    instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
    streams: {},
  };
  const handlers: CanopyRuntimeHandlerMaps<
    VaultQueries,
    VaultInstructions,
    EmptyMap
  > = {
    queries: {
      'core.vault.status.get': () => statusWithSecret,
      'core.vault.entry.list': () => ({ items: [], nextCursor: null }),
      'core.vault.entry.get': () => ({ ...metadata, secret: SENTINEL }),
    },
    instructions: {
      'core.vault.entry.put': writePut,
      'core.vault.entry.delete': writeDelete,
    },
    streams: {},
  };
  return createCanopyDispatcher({
    profile: 'core',
    definitions,
    handlers,
  });
}

async function putFailure(payload: CanopyErrorPayload): Promise<unknown> {
  return dispatcherFailing(payload)
    .instruction('core.vault.entry.put', replace, {
      caller,
      metadata: { idempotencyKey: 'put-1' },
    })
    .then(
      () => undefined,
      (error: unknown) =>
        error instanceof CanopyOperationError ? error.payload : error,
    );
}

describe('vault contracts at the dispatch boundary', () => {
  it('strips planted secret fields from query results', async () => {
    const dispatcher = dispatcherFailing(
      vaultError('core.vault.entry.unavailable'),
    );
    const results = await Promise.all([
      dispatcher.query('core.vault.entry.get', { ref }, { caller }),
      dispatcher.query('core.vault.status.get', {}, { caller }),
    ]);
    expect(results[0]).toEqual(metadata);
    expect(JSON.stringify(results)).not.toContain(SENTINEL);
  });

  it('forwards the reserved managed-family refusal unchanged', async () => {
    const refusal = vaultError('core.vault.entry.writerRefused', {
      reason: 'managed_family',
    });
    expect(await putFailure(refusal)).toEqual(refusal);
  });

  it('forwards an idempotency-key reuse refusal from put and delete unchanged', async () => {
    const reused = vaultError('core.vault.entry.idempotencyKeyReused', { ref });
    const dispatcher = dispatcherFailing(reused);
    const options = { caller, metadata: { idempotencyKey: 'reused-1' } };
    const failures = await Promise.all(
      [
        dispatcher.instruction('core.vault.entry.put', replace, options),
        dispatcher.instruction(
          'core.vault.entry.delete',
          { ref, expectedRevision: 2 },
          options,
        ),
      ].map((call) =>
        call.then(
          () => undefined,
          (error: unknown) =>
            error instanceof CanopyOperationError ? error.payload : error,
        ),
      ),
    );
    expect(failures).toEqual([reused, reused]);
  });

  it('forwards an unrecorded closure intent from put and delete, and redacts one naming a ref', async () => {
    const options = { caller, metadata: { idempotencyKey: 'intent-1' } };
    const failures = (payload: CanopyErrorPayload): Promise<unknown[]> => {
      const dispatcher = dispatcherFailing(payload);
      return Promise.all(
        [
          dispatcher.instruction('core.vault.entry.put', replace, options),
          dispatcher.instruction(
            'core.vault.entry.delete',
            { ref, expectedRevision: 2 },
            options,
          ),
        ].map((call) =>
          call.then(
            () => undefined,
            (error: unknown) =>
              error instanceof CanopyOperationError ? error.payload : error,
          ),
        ),
      );
    };
    const refused = vaultError('core.vault.entry.closureUnrecorded');
    expect(await failures(refused)).toEqual([refused, refused]);
    for (const failure of await failures({ ...refused, details: { ref } }))
      expect(failure).toMatchObject({
        kind: 'internal',
        message: 'The operation returned an invalid error.',
      });
  });

  // Known gap, documented in the put and delete specs: only a dispatcher
  // rewrite of keyed `resource_exhausted` retries would close it.
  it("forwards a handler's copy of the control plane's overload refusal", async () => {
    const overload = {
      kind: 'resource_exhausted',
      message: 'Too many requests in flight on this connection.',
      retry: { kind: 'same_request', delayMs: 100 },
    } as const;
    expect(await putFailure(overload)).toEqual(overload);
  });

  it('turns a vault error carrying secret text into a redacted internal error', async () => {
    const leaked = await putFailure({
      ...vaultError('core.vault.entry.notFound', { reason: 'absent' }),
      message: `No entry for ${SENTINEL}.`,
    });
    expect(leaked).toMatchObject({ kind: 'internal' });
    expect(JSON.stringify(leaked)).not.toContain(SENTINEL);
  });

  it('keeps entry outcome retries apart from protection refreshes', async () => {
    expect(
      await putFailure(vaultError('core.vault.entry.outcomeUnknown', { ref })),
    ).toMatchObject({
      code: 'core.vault.entry.outcomeUnknown',
      retry: { kind: 'same_idempotency_key' },
    });
    expect(
      await putFailure(
        vaultError('core.vault.protection.unavailable', {
          protection: {
            state: 'unavailable',
            backend: null,
            reason: 'backend_failed',
          },
        }),
      ),
    ).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'after_refresh', resource: 'core.vault.status' },
    });
    expect(
      await putFailure({
        kind: 'unavailable',
        message: 'The runtime is unavailable.',
        retry: { kind: 'same_request' },
      }),
    ).toMatchObject({ retry: { kind: 'same_idempotency_key' } });
  });

  it('refuses a put without an idempotency key before the handler runs', async () => {
    const dispatcher = dispatcherFailing(
      vaultError('core.vault.entry.unavailable'),
    );
    await expect(
      dispatcher.instruction('core.vault.entry.put', replace, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });
  it('redacts an uncoded handler error that carries arbitrary text', async () => {
    for (const payload of [
      { kind: 'unavailable', message: 'TOP_SECRET', retry: { kind: 'never' } },
      {
        kind: 'failed_precondition',
        message: `Keychain said ${SENTINEL}`,
        retry: { kind: 'never' },
      },
    ] as const) {
      const leaked = await putFailure(payload);
      expect(leaked).toMatchObject({
        kind: 'internal',
        message: 'The operation returned an invalid error.',
      });
      expect(JSON.stringify(leaked)).not.toMatch(/TOP_SECRET|sk-vault/);
    }
  });

  // Mirrors the daemon control plane and the renderer relay, which validate
  // the wire request and dispatch params without `_meta`.
  it('runs put and delete from a wire request after the transport strips _meta', async () => {
    const seen: unknown[] = [];
    const dispatcher = dispatcherWith(
      (params, context) => {
        seen.push([params, context.metadata.idempotencyKey]);
        return metadata;
      },
      (params, context) => {
        seen.push([params, context.metadata.idempotencyKey]);
        return { ref, tombstoneRevision: 3, revokedGrantCount: 0 };
      },
    );
    for (const [method, body] of [
      ['core.vault.entry.put', replace],
      [
        'core.vault.entry.put',
        {
          entryId: null,
          expectedRevision: null,
          family: 'copilot.account',
          label: 'GitHub Copilot',
          secret: SENTINEL,
          expiresAt: null,
        },
      ],
      ['core.vault.entry.delete', { ref, expectedRevision: 2 }],
    ] as const) {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...body, _meta: { idempotencyKey: `${method}-1` } },
      };
      expect(
        composeCanopyOperationEnvelopes(
          method,
          CORE_VAULT_INSTRUCTION_DEFINITIONS[method],
        ).request.safeParse(request).success,
      ).toBe(true);
      const { _meta, ...params } = request.params;
      await expect(
        dispatcher.instruction(method, params, { caller, metadata: _meta }),
      ).resolves.toBeDefined();
      // Left in params, `_meta` is refused: hosts must split it off.
      await expect(
        dispatcher.instruction(method, request.params, {
          caller,
          metadata: _meta,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          message: 'Invalid operation parameters.',
        },
      });
    }
    expect(seen).toEqual([
      [replace, 'core.vault.entry.put-1'],
      [expect.objectContaining({ entryId: null }), 'core.vault.entry.put-1'],
      [{ ref, expectedRevision: 2 }, 'core.vault.entry.delete-1'],
    ]);
  });

  // Guards VAULT_UNCODED_ERROR_MESSAGES against drift in the dispatcher.
  it("forwards the dispatcher's own refusals with their fixed messages", async () => {
    const key = { idempotencyKey: 'put-1' };
    const refusal = async (
      call: (dispatcher: VaultDispatcher) => Promise<unknown>,
      dispatcher = dispatcherWith(() => metadata),
    ): Promise<unknown> =>
      call(dispatcher).then(
        () => undefined,
        (error: unknown) =>
          error instanceof CanopyOperationError ? error.payload : error,
      );
    const metadataWithExtra = { ...key, principal: 'x' };
    const invalidGetParams = { ref, extra: 1 };
    const put =
      (
        options: Parameters<VaultDispatcher['instruction']>[2],
        params: VaultPutParams = replace,
      ) =>
      (dispatcher: VaultDispatcher): Promise<unknown> =>
        dispatcher.instruction('core.vault.entry.put', params, options);
    const drained = dispatcherWith(() => metadata);
    drained.drainInstructions();
    const payloads = await Promise.all([
      refusal(put({ caller })),
      refusal(put({ caller, metadata: metadataWithExtra })),
      refusal(put({ caller, metadata: key }, { ...replace, label: '' })),
      refusal(put({ caller: { ...caller, grants: [] }, metadata: key })),
      refusal(put({ caller: { ...caller, principalId: '' }, metadata: key })),
      refusal(
        put({
          caller,
          metadata: { ...key, deadlineAt: '2000-01-01T00:00:00.000Z' },
        }),
      ),
      refusal(put({ caller, metadata: key, signal: AbortSignal.abort() })),
      refusal(put({ caller, metadata: key }), drained),
      refusal(
        put({ caller, metadata: key }),
        dispatcherWith(() => {
          throw new Error(SENTINEL);
        }),
      ),
      refusal(
        put({ caller, metadata: key }),
        dispatcherWith(() => invalidMetadataResult()),
      ),
      refusal((dispatcher) =>
        dispatcher.query('core.vault.entry.get', invalidGetParams, { caller }),
      ),
    ]);
    const messages: Readonly<Partial<Record<string, readonly string[]>>> =
      VAULT_UNCODED_ERROR_MESSAGES;
    const parsed = payloads.map((payload) =>
      CanopyErrorPayloadSchema.parse(payload),
    );
    expect(parsed.map(({ kind }) => kind)).toEqual([
      'invalid_argument',
      'invalid_argument',
      'invalid_argument',
      'permission_denied',
      'unauthenticated',
      'deadline_exceeded',
      'cancelled',
      'unavailable',
      'internal',
      'internal',
      'invalid_argument',
    ]);
    for (const payload of parsed) {
      const { kind, message } = payload;
      expect(messages[kind]).toContain(message);
      expect(message).not.toBe('The operation returned an invalid error.');
      expect(JSON.stringify(payload)).not.toContain(SENTINEL);
    }
  });
});
