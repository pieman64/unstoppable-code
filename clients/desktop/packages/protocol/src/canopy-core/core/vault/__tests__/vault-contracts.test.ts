import { z } from 'zod';

import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '../../../registry';
import { composeCanopyOperationEnvelopes } from '../../../wire';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_STREAM_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
} from '../../registry';
import {
  VAULT_ERROR_CODES,
  VAULT_ERROR_SPECS,
  VAULT_UNCODED_ERROR_MESSAGES,
  vaultError,
  type VaultErrorCode,
  type VaultErrorDetails,
} from '../errors';
import {
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  CORE_VAULT_QUERY_DEFINITIONS,
  VaultEntryDeleteErrorSchema,
  VaultEntryGetErrorSchema,
  VaultEntryPutErrorSchema,
} from '../operations';
import {
  VAULT_BACKENDS,
  VAULT_ENTRY_STATES,
  VaultBackendSchema,
  VaultEntryDeleteParamsSchema,
  VaultEntryDeleteResultSchema,
  VaultEntryListResultSchema,
  VaultEntryMetadataSchema,
  VaultEntryPutParamsSchema,
  VaultEntryStateSchema,
  VaultProtectionStatusSchema,
  VaultStatusGetResultSchema,
  toVaultEntryMetadata,
  type VaultEntryMetadata,
} from '../schemas';

const SENTINEL = 'sk-vault-sentinel-7f3a9c';
const timestamp = '2026-10-23T00:00:00.000Z';
const ref = { vaultId: 'vault-1', entryId: 'entry-1' };
const meta = { idempotencyKey: 'key-1' };
const metadata: VaultEntryMetadata = {
  ref,
  family: 'copilot.account',
  label: 'GitHub Copilot',
  revision: 3,
  state: 'available',
  expiresAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const create = {
  entryId: null,
  expectedRevision: null,
  family: 'copilot.account',
  label: 'GitHub Copilot',
  secret: SENTINEL,
  expiresAt: null,
};
const replace = {
  ref,
  expectedRevision: 3,
  label: 'GitHub Copilot',
  secret: SENTINEL,
  expiresAt: timestamp,
};
const detailsFor: Record<VaultErrorCode, VaultErrorDetails | undefined> = {
  'core.vault.entry.notFound': { reason: 'deleted', ref },
  'core.vault.entry.revisionConflict': { currentRevision: 4, ref },
  'core.vault.entry.corrupt': { ref },
  'core.vault.entry.keyMissing': undefined,
  'core.vault.entry.outcomeUnknown': { ref },
  'core.vault.entry.unavailable': undefined,
  'core.vault.entry.closureUnrecorded': undefined,
  'core.vault.entry.writerRefused': { reason: 'managed_family' },
  'core.vault.entry.idempotencyKeyReused': { ref },
  'core.vault.protection.locked': {
    protection: {
      state: 'locked',
      backend: 'macos_keychain',
      evidence: 'reported',
    },
  },
  'core.vault.protection.denied': {
    protection: { state: 'denied', backend: 'windows_dpapi' },
  },
  'core.vault.protection.unavailable': {
    protection: {
      state: 'unavailable',
      backend: null,
      reason: 'authority_unavailable',
    },
  },
};

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== key),
  );
}

function withPlanted<T extends object>(value: T): T & Record<string, string> {
  return { ...value, secret: SENTINEL, accessToken: SENTINEL };
}

function writeOnlyPaths(schema: unknown, path: string[] = []): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, index) =>
      writeOnlyPaths(item, [...path, String(index)]),
    );
  if (schema === null || typeof schema !== 'object') return [];
  return Object.entries(schema).flatMap(([key, child]) =>
    key === 'writeOnly' && child === true
      ? [path.join('.')]
      : writeOnlyPaths(child, [...path, key]),
  );
}

describe('vault protection and entry states', () => {
  it('parses every protection state and rejects unknown ones', () => {
    for (const protection of [
      { state: 'unknown', backend: null },
      { state: 'available', backend: 'linux_secret_service' },
      { state: 'locked', backend: 'macos_keychain', evidence: 'inferred' },
      { state: 'denied', backend: 'windows_credential_manager' },
      { state: 'unavailable', backend: null, reason: 'no_backend' },
      {
        state: 'unavailable',
        backend: 'linux_secret_service',
        reason: 'unsupported_session',
      },
      { state: 'unavailable', backend: null, reason: 'backend_failed' },
      { state: 'unavailable', backend: null, reason: 'authority_unavailable' },
      { state: 'key_missing', backend: 'windows_dpapi' },
    ])
      expect(VaultProtectionStatusSchema.safeParse(protection).success).toBe(
        true,
      );
    for (const protection of [
      { state: 'plaintext', backend: 'file' },
      { state: 'unavailable', backend: null, reason: 'passphrase_fallback' },
      { state: 'locked', backend: 'macos_keychain' },
    ])
      expect(VaultProtectionStatusSchema.safeParse(protection).success).toBe(
        false,
      );
  });

  it('keeps the entry state vocabulary closed, with unconfirmed and no invalid', () => {
    expect(VAULT_ENTRY_STATES).toEqual([
      'available',
      'locked',
      'denied',
      'unavailable',
      'corrupt',
      'key_missing',
      'expired',
      'unconfirmed',
      'delete_unconfirmed',
    ]);
    expect(VaultEntryStateSchema.safeParse('unconfirmed').success).toBe(true);
    expect(VaultEntryStateSchema.safeParse('delete_unconfirmed').success).toBe(
      true,
    );
    expect(VaultEntryStateSchema.safeParse('invalid').success).toBe(false);
    expect(
      VaultEntryMetadataSchema.safeParse({ ...metadata, state: 'invalid' })
        .success,
    ).toBe(false);
  });

  it('documents no plaintext backend and bounds the backend identifier', () => {
    for (const backend of Object.values(VAULT_BACKENDS)) {
      expect(backend).not.toMatch(/plain|file|passphrase|none/);
      expect(VaultBackendSchema.safeParse(backend).success).toBe(true);
    }
    expect(VaultBackendSchema.safeParse('web_envelope').success).toBe(true);
    for (const backend of ['', 'Keychain', 'a'.repeat(65), 'has space'])
      expect(VaultBackendSchema.safeParse(backend).success).toBe(false);
  });
});

describe('vault results are redacted', () => {
  it('strips planted secret fields from every result before emission', () => {
    const results: [z.ZodType, unknown][] = [
      [VaultEntryMetadataSchema, withPlanted(metadata)],
      [
        VaultEntryListResultSchema,
        withPlanted({ items: [withPlanted(metadata)], nextCursor: null }),
      ],
      [
        VaultStatusGetResultSchema,
        withPlanted({
          protection: withPlanted({
            state: 'available',
            backend: 'macos_keychain',
          }),
          observedAt: timestamp,
        }),
      ],
      [
        VaultEntryDeleteResultSchema,
        withPlanted({ ref, tombstoneRevision: 4, revokedGrantCount: 1 }),
      ],
    ];
    for (const [schema, value] of results) {
      const parsed = schema.safeParse(value);
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(parsed.data)).not.toContain(SENTINEL);
    }
    expect(
      Object.keys(VaultEntryMetadataSchema.parse(metadata)).sort(),
    ).toEqual([
      'createdAt',
      'expiresAt',
      'family',
      'label',
      'ref',
      'revision',
      'state',
      'updatedAt',
    ]);
  });

  it('refuses a planted field inside a strict reference', () => {
    expect(
      VaultEntryMetadataSchema.safeParse({
        ...metadata,
        ref: { ...ref, secret: SENTINEL },
      }).success,
    ).toBe(false);
  });

  it('projects only the redacted metadata fields', () => {
    const projected = toVaultEntryMetadata({
      ...withPlanted(metadata),
      ref: withPlanted(ref),
    });
    expect(projected).toEqual(metadata);
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
  });

  it('marks only the put secret as write-only', () => {
    const paths = [
      ...Object.entries(CORE_VAULT_QUERY_DEFINITIONS),
      ...Object.entries(CORE_VAULT_INSTRUCTION_DEFINITIONS),
    ].flatMap(([name, definition]) =>
      [definition.params, definition.result, definition.error].flatMap(
        (schema, index) =>
          writeOnlyPaths(
            z.toJSONSchema(schema, { unrepresentable: 'any' }),
          ).map((path) => `${name}:${index}:${path}`),
      ),
    );
    expect(paths).toEqual([
      'core.vault.entry.put:0:anyOf.0.properties.secret',
      'core.vault.entry.put:0:anyOf.1.properties.secret',
    ]);
  });
});

describe('vault put and delete params', () => {
  const requestFor = (
    name: 'core.vault.entry.put' | 'core.vault.entry.delete',
  ): z.ZodType =>
    composeCanopyOperationEnvelopes(
      name,
      CORE_VAULT_INSTRUCTION_DEFINITIONS[name],
    ).request;
  const putRequest = requestFor('core.vault.entry.put');
  const deleteRequest = requestFor('core.vault.entry.delete');
  const envelope = (
    params: unknown,
    method = 'core.vault.entry.put',
  ): unknown => ({ jsonrpc: '2.0', id: 1, method, params });
  const keyed = (params: object): Record<string, unknown> => ({
    ...params,
    _meta: meta,
  });
  const remove = { ref, expectedRevision: 3 };

  it('accepts exactly a create or a replace', () => {
    expect(VaultEntryPutParamsSchema.safeParse(create).success).toBe(true);
    expect(VaultEntryPutParamsSchema.safeParse(replace).success).toBe(true);
    expect(putRequest.safeParse(envelope(keyed(create))).success).toBe(true);
    expect(putRequest.safeParse(envelope(keyed(replace))).success).toBe(true);
  });

  it('rejects a missing idempotency key on both branches of the envelope', () => {
    for (const params of [create, replace])
      for (const candidate of [
        params,
        { ...params, _meta: {} },
        { ...params, _meta: { deadlineAt: timestamp } },
        { ...params, _meta: { idempotencyKey: '' } },
      ])
        expect(putRequest.safeParse(envelope(candidate)).success).toBe(false);
  });

  // Every host splits `_meta` off before dispatch (the daemon control plane,
  // the renderer relay and the in-process binding), so the definition params
  // must hold exactly what remains.
  it('validates the dispatched params after the transport strips _meta', () => {
    const cases = [
      [putRequest, 'core.vault.entry.put', VaultEntryPutParamsSchema, create],
      [putRequest, 'core.vault.entry.put', VaultEntryPutParamsSchema, replace],
      [
        deleteRequest,
        'core.vault.entry.delete',
        VaultEntryDeleteParamsSchema,
        remove,
      ],
    ] as const;
    for (const [request, method, params, body] of cases) {
      const wire = z
        .object({ params: z.record(z.string(), z.unknown()) })
        .parse(request.parse(envelope(keyed(body), method)));
      const { _meta: stripped, ...dispatched } = wire.params;
      expect(stripped).toEqual(meta);
      expect(params.safeParse(dispatched).success).toBe(true);
      // Metadata never reaches the handler through params.
      expect(params.safeParse(wire.params).success).toBe(false);
    }
  });

  it('refuses a create at a caller-chosen ID and a replace without a ref', () => {
    const refused = [
      { ...create, entryId: 'chosen-id' },
      { ...create, entryId: 'chosen-id', expectedRevision: 0 },
      { ...create, expectedRevision: 0 },
      { ...create, ref },
      without(replace, 'ref'),
      { ...without(replace, 'ref'), entryId: 'entry-1' },
      { ...replace, expectedRevision: null },
      { ...replace, family: 'copilot.account' },
      { ...replace, ref: { ...ref, revision: 3 } },
    ];
    for (const params of refused) {
      expect(VaultEntryPutParamsSchema.safeParse(params).success).toBe(false);
      expect(putRequest.safeParse(envelope(keyed(params))).success).toBe(false);
    }
  });

  it('deletes by reference and expected revision', () => {
    expect(VaultEntryDeleteParamsSchema.safeParse(remove).success).toBe(true);
    expect(
      deleteRequest.safeParse(
        envelope(keyed(remove), 'core.vault.entry.delete'),
      ).success,
    ).toBe(true);
    for (const params of [
      { entryId: 'entry-1', expectedRevision: 3 },
      { ref },
      { ref, expectedRevision: null },
    ]) {
      expect(VaultEntryDeleteParamsSchema.safeParse(params).success).toBe(
        false,
      );
      expect(
        deleteRequest.safeParse(
          envelope(keyed(params), 'core.vault.entry.delete'),
        ).success,
      ).toBe(false);
    }
    expect(
      deleteRequest.safeParse(envelope(remove, 'core.vault.entry.delete'))
        .success,
    ).toBe(false);
  });
});

describe('vault error codes', () => {
  it('builds every code with its fixed kind, retry and message', () => {
    expect(Object.keys(VAULT_ERROR_SPECS)).toEqual([...VAULT_ERROR_CODES]);
    for (const code of VAULT_ERROR_CODES) {
      const spec = VAULT_ERROR_SPECS[code];
      const error = vaultError(code, detailsFor[code]);
      expect(error).toMatchObject({
        code,
        kind: spec.kind,
        message: spec.message,
        retry: spec.retry,
      });
    }
  });

  it('maps the W5 outcome codes to unavailable with a same-key retry', () => {
    for (const code of [
      'core.vault.entry.outcomeUnknown',
      'core.vault.entry.unavailable',
    ] as const)
      expect(vaultError(code)).toMatchObject({
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      });
    expect(
      vaultError(
        'core.vault.protection.unavailable',
        detailsFor['core.vault.protection.unavailable'],
      ),
    ).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'after_refresh', resource: 'core.vault.status' },
    });
  });

  it('keeps the closure intent of an unavailable write durable', () => {
    const { meaning } = VAULT_ERROR_SPECS['core.vault.entry.unavailable'];
    expect(meaning).not.toMatch(/changed nothing durable/);
    expect(meaning).toMatch(/closure intent is durable/);
    expect(meaning).toMatch(/across a restart/);
    // Reconciled by a same-key retry, not only at open; a put waits for the key.
    expect(meaning).toMatch(/same idempotency key re-attempts the commit/);
    expect(meaning).toMatch(
      /returns this error again while the key is not held/,
    );
  });

  it('reports an unrecorded closure intent as not accepted, without a ref', () => {
    const refused = vaultError('core.vault.entry.closureUnrecorded');
    expect(refused).toEqual({
      kind: 'unavailable',
      message: 'The vault write was not accepted.',
      code: 'core.vault.entry.closureUnrecorded',
      retry: { kind: 'same_idempotency_key' },
    });
    expect(
      VAULT_ERROR_SPECS['core.vault.entry.closureUnrecorded'].meaning,
    ).toMatch(/not accepted.*idempotency key was not reserved/);
    expect(
      VAULT_ERROR_SPECS['core.vault.entry.closureUnrecorded'].meaning,
    ).toMatch(/put leaves admission unchanged; a delete fails closed/);
    expect(
      VAULT_ERROR_SPECS['core.vault.entry.closureUnrecorded'].meaning,
    ).not.toMatch(/admission is unchanged/);
    for (const schema of [
      VaultEntryPutErrorSchema,
      VaultEntryDeleteErrorSchema,
    ]) {
      expect(schema.safeParse(refused).success).toBe(true);
      for (const payload of [
        { ...refused, details: { ref } },
        { ...refused, details: { reason: 'absent' } },
        { ...refused, details: { currentRevision: 1 } },
        { ...refused, details: detailsFor['core.vault.protection.locked'] },
        { ...refused, retry: { kind: 'never' } },
        { ...refused, retry: { kind: 'same_request' } },
        {
          ...refused,
          retry: { kind: 'after_refresh', resource: 'core.vault.status' },
        },
        { ...refused, kind: 'failed_precondition' },
        { ...refused, message: 'The vault write did not reach the store.' },
        // Not a runtime refusal: the not-accepted outcome needs its code.
        {
          kind: 'unavailable',
          message: refused.message,
          retry: { kind: 'same_idempotency_key' },
        },
      ])
        expect(schema.safeParse(payload).success).toBe(false);
    }
    for (const details of [
      { ref },
      { reason: 'absent' as const },
      { currentRevision: 1 },
    ])
      expect(() =>
        vaultError('core.vault.entry.closureUnrecorded', details),
      ).toThrow();
    for (const definition of Object.values(CORE_VAULT_QUERY_DEFINITIONS))
      expect(definition.error.safeParse(refused).success).toBe(false);
  });

  it('reports a corrupt or unrecoverable key slot as keyMissing', () => {
    expect(VAULT_ERROR_SPECS['core.vault.entry.keyMissing'].meaning).toMatch(
      /absent or unrecoverable/,
    );
  });

  it('refuses a put while the key is not held with the existing protection, corrupt and keyMissing codes', () => {
    for (const code of [
      'core.vault.protection.locked',
      'core.vault.protection.denied',
      'core.vault.protection.unavailable',
      'core.vault.entry.corrupt',
      'core.vault.entry.keyMissing',
    ] as const) {
      const error = vaultError(code, detailsFor[code]);
      expect(VaultEntryPutErrorSchema.safeParse(error).success).toBe(true);
      expect(VaultEntryDeleteErrorSchema.safeParse(error).success).toBe(false);
    }
  });

  it('refuses a put before the first key-slot observation as protection.unavailable without a backend', () => {
    const unobserved = vaultError('core.vault.protection.unavailable', {
      protection: {
        state: 'unavailable',
        backend: null,
        reason: 'backend_failed',
      },
    });
    expect(VaultEntryPutErrorSchema.safeParse(unobserved).success).toBe(true);
    expect(VaultEntryDeleteErrorSchema.safeParse(unobserved).success).toBe(
      false,
    );
    // `unknown` is a status, never an error protection state.
    expect(
      VaultEntryPutErrorSchema.safeParse({
        ...unobserved,
        details: { protection: { state: 'unknown', backend: null } },
      }).success,
    ).toBe(false);
  });

  it('reserves writerRefused as permission_denied with only the managed_family reason', () => {
    const error = vaultError('core.vault.entry.writerRefused', {
      reason: 'managed_family',
    });
    expect(error).toEqual({
      kind: 'permission_denied',
      message: 'The caller is not the writer for this entry family.',
      code: 'core.vault.entry.writerRefused',
      details: { reason: 'managed_family' },
      retry: { kind: 'never' },
    });
    for (const details of [
      undefined,
      { reason: 'absent' as const },
      { reason: 'managed_family' as const, ref },
      { reason: 'managed_family' as const, currentRevision: 1 },
    ])
      expect(() =>
        vaultError('core.vault.entry.writerRefused', details),
      ).toThrow();
    for (const schema of [
      VaultEntryPutErrorSchema,
      VaultEntryDeleteErrorSchema,
    ])
      expect(
        schema.safeParse({
          ...error,
          details: { reason: 'managed_family', secret: SENTINEL },
        }).success,
      ).toBe(false);
  });

  it('refuses idempotency-key reuse with its own conflict code, not a revision refresh', () => {
    const reused = vaultError('core.vault.entry.idempotencyKeyReused', { ref });
    expect(reused).toEqual({
      kind: 'conflict',
      message: 'The idempotency key was already used for a different request.',
      code: 'core.vault.entry.idempotencyKeyReused',
      details: { ref },
      retry: { kind: 'never' },
    });
    expect(
      vaultError('core.vault.entry.idempotencyKeyReused'),
    ).not.toHaveProperty('details');
    for (const schema of [
      VaultEntryPutErrorSchema,
      VaultEntryDeleteErrorSchema,
    ])
      expect(schema.safeParse(reused).success).toBe(true);
    expect(VaultEntryGetErrorSchema.safeParse(reused).success).toBe(false);
    for (const details of [
      { currentRevision: 4 },
      { reason: 'absent' as const },
    ])
      expect(() =>
        vaultError('core.vault.entry.idempotencyKeyReused', details),
      ).toThrow();
    for (const payload of [
      { ...reused, retry: { kind: 'same_idempotency_key' } },
      {
        ...reused,
        retry: { kind: 'after_refresh', resource: 'core.vault.entry' },
      },
      { ...reused, message: 'The vault entry revision has changed.' },
      // Key reuse has no uncoded form: a handler must send the code.
      { kind: 'conflict', message: reused.message, retry: { kind: 'never' } },
    ])
      for (const schema of [
        VaultEntryPutErrorSchema,
        VaultEntryDeleteErrorSchema,
      ])
        expect(schema.safeParse(payload).success).toBe(false);
  });

  // The daemon control plane refuses an over-limit frame before it reads the
  // method, so the dispatcher's keyed retry rewrite never sees it.
  it("accepts the control plane's overload refusal on keyed writes, and no other same-request retry", () => {
    const overload = {
      kind: 'resource_exhausted',
      message: 'Too many requests in flight on this connection.',
      retry: { kind: 'same_request', delayMs: 100 },
    } as const;
    for (const schema of [
      VaultEntryPutErrorSchema,
      VaultEntryDeleteErrorSchema,
    ]) {
      expect(schema.safeParse(overload).success).toBe(true);
      for (const retry of [
        { kind: 'same_request' },
        // What a control plane that rewrites keyed retries would send.
        { kind: 'same_idempotency_key', delayMs: 100 },
      ])
        expect(schema.safeParse({ ...overload, retry }).success).toBe(true);
      for (const payload of [
        {
          kind: 'unavailable',
          message: 'The runtime is unavailable.',
          retry: { kind: 'same_request' },
        },
        {
          kind: 'deadline_exceeded',
          message: 'The operation deadline was exceeded.',
          retry: { kind: 'same_request' },
        },
        { ...overload, kind: 'unavailable' },
        { ...overload, message: 'Stream buffer capacity exceeded.' },
        { ...overload, details: { ref } },
        {
          ...vaultError('core.vault.entry.outcomeUnknown'),
          retry: { kind: 'same_request' },
        },
      ])
        expect(schema.safeParse(payload).success).toBe(false);
    }
  });

  it('never carries a secret in a message or details', () => {
    for (const code of VAULT_ERROR_CODES)
      expect(JSON.stringify(vaultError(code, detailsFor[code]))).not.toContain(
        SENTINEL,
      );
    const notFound = vaultError('core.vault.entry.notFound', {
      reason: 'absent',
    });
    for (const payload of [
      { ...notFound, message: `Entry ${SENTINEL} was not found.` },
      { ...notFound, details: { reason: 'absent', secret: SENTINEL } },
      {
        ...vaultError(
          'core.vault.protection.locked',
          detailsFor['core.vault.protection.locked'],
        ),
        details: {
          protection: {
            state: 'locked',
            backend: 'macos_keychain',
            evidence: 'reported',
            secret: SENTINEL,
          },
        },
      },
      {
        kind: 'invalid_argument',
        message: 'Invalid operation parameters.',
        details: { secret: SENTINEL },
        retry: { kind: 'never' },
      },
    ])
      expect(VaultEntryPutErrorSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a code paired with another kind, retry or protection state', () => {
    const locked = vaultError(
      'core.vault.protection.locked',
      detailsFor['core.vault.protection.locked'],
    );
    const unknownOutcome = vaultError('core.vault.entry.outcomeUnknown');
    for (const payload of [
      { ...locked, kind: 'unavailable' },
      { ...locked, retry: { kind: 'same_idempotency_key' } },
      {
        ...locked,
        retry: { kind: 'after_refresh', resource: 'core.vault.entry' },
      },
      { ...locked, details: detailsFor['core.vault.protection.denied'] },
      { ...unknownOutcome, retry: { kind: 'never' } },
      {
        ...vaultError('core.vault.entry.notFound', { reason: 'deleted' }),
        details: {},
      },
    ])
      expect(VaultEntryPutErrorSchema.safeParse(payload).success).toBe(false);
  });

  it('ignores detail fields left undefined, which never reach the wire', () => {
    const locked = vaultError(
      'core.vault.protection.locked',
      detailsFor['core.vault.protection.locked'],
    );
    expect(
      VaultEntryPutErrorSchema.safeParse({
        ...locked,
        details: {
          ...detailsFor['core.vault.protection.locked'],
          ref: undefined,
        },
      }).success,
    ).toBe(true);
    expect(
      vaultError('core.vault.entry.corrupt', { reason: undefined }),
    ).toMatchObject({ code: 'core.vault.entry.corrupt' });
    expect(
      VaultEntryPutErrorSchema.safeParse({
        ...vaultError('core.vault.entry.notFound', { reason: 'absent' }),
        details: { reason: undefined },
      }).success,
    ).toBe(false);
  });

  it('accepts generic errors and limits each operation to its own codes', () => {
    expect(
      VaultEntryPutErrorSchema.safeParse({
        kind: 'unavailable',
        message: 'The runtime is unavailable.',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(true);
    const notFound = vaultError('core.vault.entry.notFound', {
      reason: 'foreign_vault',
      ref,
    });
    expect(VaultEntryGetErrorSchema.safeParse(notFound).success).toBe(true);
    expect(
      VaultEntryGetErrorSchema.safeParse(
        vaultError('core.vault.entry.outcomeUnknown'),
      ).success,
    ).toBe(false);
    expect(
      VaultEntryDeleteErrorSchema.safeParse(
        vaultError(
          'core.vault.protection.locked',
          detailsFor['core.vault.protection.locked'],
        ),
      ).success,
    ).toBe(false);
    for (const definition of [
      CORE_VAULT_QUERY_DEFINITIONS['core.vault.status.get'],
      CORE_VAULT_QUERY_DEFINITIONS['core.vault.entry.list'],
    ])
      expect(definition.error.safeParse(notFound).success).toBe(false);
  });

  const definitions = [
    ...Object.values(CORE_VAULT_QUERY_DEFINITIONS),
    ...Object.values(CORE_VAULT_INSTRUCTION_DEFINITIONS),
  ];
  // Never and same-idempotency-key fit the keyed directives; never fits queries.
  const retryFor = (
    definition: (typeof definitions)[number],
    kind: string,
  ): { kind: string } =>
    definition.kind === 'instruction' &&
    (kind === 'unavailable' || kind === 'deadline_exceeded')
      ? { kind: 'same_idempotency_key' }
      : { kind: 'never' };

  it('rejects an uncoded error whose message is not a fixed runtime message', () => {
    for (const definition of definitions)
      for (const [kind, message] of [
        ['unavailable', 'TOP_SECRET'],
        ['internal', `Provider said: ${SENTINEL}`],
        // A listed message under another kind is still refused.
        ['not_found', 'The operation failed.'],
        ['invalid_argument', 'Invalid operation parameters. '],
      ] as const)
        expect(
          definition.error.safeParse({
            kind,
            message,
            retry: retryFor(definition, kind),
          }).success,
        ).toBe(false);
  });

  it('accepts every fixed runtime message on an uncoded error', () => {
    for (const definition of definitions)
      for (const [kind, messages] of Object.entries(
        VAULT_UNCODED_ERROR_MESSAGES,
      ))
        for (const message of messages)
          expect(
            definition.error.safeParse({
              kind,
              message,
              retry: retryFor(definition, kind),
            }).success,
          ).toBe(true);
  });
});

describe('vault definitions stay inactive', () => {
  it('defines exactly the five vault operations, outside every composed registry', () => {
    expect(Object.keys(CORE_VAULT_QUERY_DEFINITIONS)).toEqual([
      'core.vault.status.get',
      'core.vault.entry.list',
      'core.vault.entry.get',
    ]);
    expect(Object.keys(CORE_VAULT_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.vault.entry.put',
      'core.vault.entry.delete',
    ]);
    for (const registry of [
      CANOPY_QUERY_DEFINITIONS,
      CANOPY_INSTRUCTION_DEFINITIONS,
      CANOPY_STREAM_DEFINITIONS,
      CORE_QUERY_DEFINITIONS,
      CORE_INSTRUCTION_DEFINITIONS,
      CORE_STREAM_DEFINITIONS,
      CORE_TRANSPORT_QUERY_DEFINITIONS,
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      CORE_TRANSPORT_STREAM_DEFINITIONS,
    ])
      expect(
        Object.keys(registry).filter((name) => name.startsWith('core.vault.')),
      ).toEqual([]);
  });

  it('declares core-only version 1 metadata with read and write grants', () => {
    const definitions = {
      ...CORE_VAULT_QUERY_DEFINITIONS,
      ...CORE_VAULT_INSTRUCTION_DEFINITIONS,
    };
    expect(
      Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [
          name,
          [
            definition.kind,
            definition.plane,
            definition.domain,
            definition.version,
            definition.placement,
            definition.idempotency,
            definition.requiredGrants,
          ],
        ]),
      ),
    ).toEqual({
      'core.vault.status.get': [
        'query',
        'core',
        'vault',
        1,
        'core-only',
        'inherent',
        ['core.vault.read'],
      ],
      'core.vault.entry.list': [
        'query',
        'core',
        'vault',
        1,
        'core-only',
        'inherent',
        ['core.vault.read'],
      ],
      'core.vault.entry.get': [
        'query',
        'core',
        'vault',
        1,
        'core-only',
        'inherent',
        ['core.vault.read'],
      ],
      'core.vault.entry.put': [
        'instruction',
        'core',
        'vault',
        1,
        'core-only',
        'keyed',
        ['core.vault.write'],
      ],
      'core.vault.entry.delete': [
        'instruction',
        'core',
        'vault',
        1,
        'core-only',
        'keyed',
        ['core.vault.write'],
      ],
    });
  });
});
