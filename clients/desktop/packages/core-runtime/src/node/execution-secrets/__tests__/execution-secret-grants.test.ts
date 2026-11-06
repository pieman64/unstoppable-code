import {
  DELEGATION_SECRETS_MAX,
  DelegationSecretFingerprintSchema,
  EXECUTION_SECRET_BINDINGS_MAX,
  type ExecutionSecretBinding,
} from '@canopy/protocol/canopy-core';
import {
  ExecutionSecretGrants,
  ExecutionSecretStageError,
  fingerprintExecutionSecretBinding,
  executionSecretFingerprints,
  type ExecutionSecretAudience,
  type ExecutionSecretReader,
} from '..';

const audience: ExecutionSecretAudience = {
  operation: 'worker.script.execute',
  key: 'run',
};
const binding: ExecutionSecretBinding = {
  name: 'KEY',
  source: {
    kind: 'stored-secret',
    family: 'environment',
    record: 'config',
    ref: `ssr1_${'a'.repeat(43)}`,
  },
};
const bindings = [binding];
const signal = new AbortController().signal;
const notGranted = { payload: { code: 'worker.executionSecret.notGranted' } };

it('redeems a staged grant once and refuses a second redemption', async () => {
  const read = jest.fn<
    ReturnType<ExecutionSecretReader['read']>,
    Parameters<ExecutionSecretReader['read']>
  >(() => Promise.resolve([{ status: 'ok', value: 'value' }]));
  const grants = new ExecutionSecretGrants({ reader: { read } });
  grants.stage(audience, bindings);
  const result = await grants.redeem({ audience, bindings }, signal);
  expect(result).toEqual({ env: { KEY: 'value' } });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.env)).toBe(true);
  await expect(
    grants.redeem({ audience, bindings }, signal),
  ).rejects.toMatchObject(notGranted);
  expect(read).toHaveBeenCalledTimes(1);
});

it('refuses an unstaged, expired, revoked, widened or narrowed request before reading any value', async () => {
  let now = 0;
  const read = jest.fn(
    (): ReturnType<ExecutionSecretReader['read']> => Promise.resolve([]),
  );
  const grants = new ExecutionSecretGrants({
    reader: { read },
    now: (): number => now,
    ttlMs: 10,
  });
  await expect(
    grants.redeem({ audience, bindings }, signal),
  ).rejects.toMatchObject(notGranted);
  grants.stage(audience, bindings);
  now = 10;
  await expect(
    grants.redeem({ audience, bindings }, signal),
  ).rejects.toMatchObject(notGranted);
  const handle = grants.stage(audience, bindings);
  handle.revoke();
  handle.revoke();
  await expect(
    grants.redeem({ audience, bindings }, signal),
  ).rejects.toMatchObject(notGranted);
  for (const requested of [[], [...bindings, { ...binding, name: 'OTHER' }]]) {
    grants.stage(audience, bindings);
    await expect(
      grants.redeem({ audience, bindings: requested }, signal),
    ).rejects.toMatchObject(notGranted);
    await expect(
      grants.redeem({ audience, bindings }, signal),
    ).rejects.toMatchObject(notGranted);
  }
  expect(read).not.toHaveBeenCalled();
});

it('drops values when the grant is revoked during the read', async () => {
  for (const mode of ['handle', 'all', 'pruned-all', 'cancelled'] as const) {
    let revoke = (): void => undefined;
    const controller = new AbortController();
    const grants = new ExecutionSecretGrants({
      reader: {
        read: (): ReturnType<ExecutionSecretReader['read']> => {
          if (mode === 'handle') revoke();
          else if (mode === 'cancelled') controller.abort();
          else {
            if (mode === 'pruned-all')
              grants.stage({ ...audience, key: 'other' }, bindings);
            grants.revokeAll();
          }
          return Promise.resolve([
            { status: 'ok', value: 'secret-canary-revoked' },
          ]);
        },
      },
    });
    const handle = grants.stage(audience, bindings);
    revoke = (): void => handle.revoke();
    await expect(
      grants.redeem({ audience, bindings }, controller.signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.revoked' },
    });
  }
});

it('turns a reader failure or missing value into unavailable with a fixed message', async () => {
  for (const read of [
    (): ReturnType<ExecutionSecretReader['read']> => {
      throw new Error('secret-canary-1');
    },
    (): ReturnType<ExecutionSecretReader['read']> =>
      Promise.resolve([{ status: 'missing' }]),
  ]) {
    const grants = new ExecutionSecretGrants({ reader: { read } });
    grants.stage(audience, bindings);
    const error: unknown = await grants
      .redeem({ audience, bindings }, signal)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.executionSecret.unavailable',
        message:
          'A secret this work needs is no longer available. Check its environment, integration or shared-container values, then start it again.',
        retry: { kind: 'never' },
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret-canary-1');
    expect(error).toMatchObject({ runtimeCause: undefined });
  }
});

it('refuses account-proxy routes as unsupported before reading anything', async () => {
  const read = jest.fn(
    (): ReturnType<ExecutionSecretReader['read']> => Promise.resolve([]),
  );
  const grants = new ExecutionSecretGrants({ reader: { read } });
  const proxy: ExecutionSecretBinding = {
    name: 'TOKEN',
    source: {
      kind: 'account-proxy-route',
      harness: 'codex',
      connectionId: 'connection',
    },
  };
  const request = { audience, bindings: [...bindings, proxy] };
  grants.stage(audience, request.bindings);
  await expect(grants.redeem(request, signal)).rejects.toMatchObject({
    payload: {
      kind: 'capability_unavailable',
      code: 'worker.executionSecret.unsupported',
      message: 'This worker cannot receive account-proxy routes yet.',
      retry: { kind: 'never' },
    },
  });
  await expect(grants.redeem(request, signal)).rejects.toMatchObject(
    notGranted,
  );
  expect(read).not.toHaveBeenCalled();
});

it('fingerprints a binding from its identity, never its value', async () => {
  let value = 'secret-canary-before';
  const grants = new ExecutionSecretGrants({
    reader: {
      read: (): ReturnType<ExecutionSecretReader['read']> =>
        Promise.resolve([{ status: 'ok', value }]),
    },
  });
  const before = fingerprintExecutionSecretBinding(binding);
  grants.stage(audience, bindings);
  expect(await grants.redeem({ audience, bindings }, signal)).toEqual({
    env: { KEY: value },
  });
  value = 'secret-canary-after';
  grants.stage(audience, bindings);
  expect(await grants.redeem({ audience, bindings }, signal)).toEqual({
    env: { KEY: value },
  });
  expect(fingerprintExecutionSecretBinding(binding)).toBe(before);
  expect(
    DelegationSecretFingerprintSchema.safeParse({
      name: binding.name,
      fingerprint: before,
    }).success,
  ).toBe(true);
  expect(
    fingerprintExecutionSecretBinding({
      ...binding,
      source: {
        kind: 'stored-secret',
        family: 'environment',
        record: 'config',
        ref: `ssr1_${'b'.repeat(43)}`,
      },
    }),
  ).not.toBe(before);
  expect(executionSecretFingerprints(undefined)).toEqual([]);
});

it('caps bindings and grants', () => {
  const grants = new ExecutionSecretGrants({
    reader: {
      read: (): ReturnType<ExecutionSecretReader['read']> =>
        Promise.resolve([]),
    },
    maxGrants: 1,
  });
  expect(EXECUTION_SECRET_BINDINGS_MAX).toBe(DELEGATION_SECRETS_MAX);
  try {
    grants.stage(
      audience,
      Array.from({ length: 65 }, (_, i) => ({ ...binding, name: `KEY_${i}` })),
    );
    throw new Error('Expected invalid bindings');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionSecretStageError);
    expect(error).toMatchObject({ code: 'invalid_bindings' });
  }
  grants.stage(audience, bindings);
  try {
    grants.stage({ ...audience, key: 'other' }, bindings);
    throw new Error('Expected capacity refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionSecretStageError);
    expect(error).toMatchObject({ code: 'capacity' });
  }
});
