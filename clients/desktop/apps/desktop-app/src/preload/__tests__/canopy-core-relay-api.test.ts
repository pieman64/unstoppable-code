import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createCanopyCoreRelayApi } from '../api/canopy-core-relay-api';
import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayRequest,
} from '../../shared/canopy-core-relay';

const INVALID_REPLY = {
  ok: false,
  error: {
    kind: 'internal',
    message: 'The relay returned an invalid reply.',
    retry: { kind: 'never' },
  },
};

function relayWith(reply: unknown): {
  invoke: jest.Mock<Promise<unknown>, []>;
  api: CanopyCoreRelayApi;
} {
  const invoke = jest.fn(() => Promise.resolve(reply));
  return { invoke, api: createCanopyCoreRelayApi({ invoke }) };
}

const health: CanopyCoreRelayRequest = {
  kind: 'request',
  method: 'core.runtime.health.get',
  params: {},
};

describe('createCanopyCoreRelayApi', () => {
  it('uses the dedicated relay channel', () => {
    expect(IPC_CHANNELS.canopyCoreRelay).toEqual(expect.any(String));
  });

  it('forwards each request unchanged on the relay channel', async () => {
    const { api, invoke } = relayWith({ ok: true, value: { status: 'ok' } });
    const read: CanopyCoreRelayRequest = {
      kind: 'readStream',
      subscriptionId: 'sub-1',
    };

    await expect(api.invoke(health)).resolves.toEqual({
      ok: true,
      value: { status: 'ok' },
    });
    await api.invoke(read);

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.canopyCoreRelay, health],
      [IPC_CHANNELS.canopyCoreRelay, read],
    ]);
  });

  it('keeps a typed error and drops fields main never sends', async () => {
    const { api } = relayWith({
      ok: false,
      error: {
        kind: 'not_found',
        message: 'No workspace.',
        code: 'core.workspace.notFound',
        details: { path: '/Users/secret' },
        retry: {
          kind: 'after_refresh',
          resource: 'workspace',
          delayMs: 10,
          extra: 1,
        },
        extra: true,
      },
    });

    await expect(api.invoke(health)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'not_found',
        message: 'No workspace.',
        code: 'core.workspace.notFound',
        retry: { kind: 'after_refresh', resource: 'workspace', delayMs: 10 },
      },
    });
  });

  it.each([
    ['same_request', { kind: 'same_request' }, { kind: 'same_request' }],
    [
      'keyed',
      { kind: 'same_idempotency_key', delayMs: 5 },
      { kind: 'same_idempotency_key', delayMs: 5 },
    ],
    ['refresh without resource', { kind: 'after_refresh' }, { kind: 'never' }],
    ['unknown', { kind: 'forever' }, { kind: 'never' }],
    ['missing', undefined, { kind: 'never' }],
  ])('normalizes a %s retry', async (_name, retry, expected) => {
    const { api } = relayWith({
      ok: false,
      error: { kind: 'unavailable', message: 'Down.', retry },
    });
    const reply = await api.invoke(health);
    expect(reply.ok ? null : reply.error.retry).toEqual(expected);
  });

  it('drops a malformed error code', async () => {
    const { api } = relayWith({
      ok: false,
      error: {
        kind: 'conflict',
        message: 'Busy.',
        code: 'not a code',
        retry: { kind: 'never' },
      },
    });
    await expect(api.invoke(health)).resolves.toEqual({
      ok: false,
      error: { kind: 'conflict', message: 'Busy.', retry: { kind: 'never' } },
    });
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'ok'],
    ['an array', [true]],
    ['ok without value', { ok: true }],
    ['a non-boolean ok', { ok: 'true', value: 1 }],
    [
      'an unknown error kind',
      { ok: false, error: { kind: 'boom', message: 'x' } },
    ],
    [
      'an empty message',
      { ok: false, error: { kind: 'internal', message: '' } },
    ],
    ['a missing error', { ok: false }],
  ])('maps %s to an invalid-reply error', async (_name, reply) => {
    await expect(relayWith(reply).api.invoke(health)).resolves.toEqual(
      INVALID_REPLY,
    );
  });

  it('reports an IPC failure as unavailable without leaking its message', async () => {
    const invoke = jest.fn(() =>
      Promise.reject(new Error('No handler for /Users/secret')),
    );
    const api = createCanopyCoreRelayApi({ invoke });
    await expect(api.invoke({ kind: 'close' })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        message: 'The relay is unavailable.',
        retry: { kind: 'never' },
      },
    });
  });

  it('preserves the supplied idempotency key after an ambiguous IPC failure', async () => {
    const invoke = jest.fn(() => Promise.reject(new Error('IPC closed')));
    const api = createCanopyCoreRelayApi({ invoke });
    await expect(
      api.invoke({
        kind: 'request',
        method: 'core.client.capabilities.register',
        params: { _meta: { idempotencyKey: 'registration-key' } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  });

  it('never directs a same-key replay of an entry delete, copy or move, which retain no outcome', async () => {
    const invoke = jest.fn(() => Promise.reject(new Error('IPC closed')));
    const api = createCanopyCoreRelayApi({ invoke });
    for (const operation of ['delete', 'copy', 'move'])
      await expect(
        api.invoke({
          kind: 'request',
          method: `worker.filesystem.entry.${operation}`,
          params: { _meta: { idempotencyKey: `${operation}-key` } },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'unavailable', retry: { kind: 'never' } },
      });
  });

  it('never directs a same-key replay of a file write or folder create, which retain no outcome', async () => {
    const invoke = jest.fn(() => Promise.reject(new Error('IPC closed')));
    const api = createCanopyCoreRelayApi({ invoke });
    for (const method of [
      'worker.filesystem.file.write',
      'worker.filesystem.directory.create',
    ])
      await expect(
        api.invoke({
          kind: 'request',
          method,
          params: { _meta: { idempotencyKey: `${method}-key` } },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'unavailable', retry: { kind: 'never' } },
      });
  });

  it('imports nothing from the main process', () => {
    const source = readFileSync(
      join(__dirname, '../api/canopy-core-relay-api.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '(?:[^']*\/)?main(?:\/[^']*)?'/);
    expect(source).not.toMatch(/^import (?!type )[^;]*from 'electron'/m);
  });
});
