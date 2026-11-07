import { createSecretProtectionServices } from './fixtures/authorized-native-loader';
// Platform golden: drives PlatformSecretProtectionServices through the Windows adapter.
// Injected native replies make refusal and cancellation deterministic; the win32
// companion suite alone qualifies the real Credential Manager boundary.
import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import {
  createWindowsSecretProtection,
  type CredentialNative,
  type CredentialOperation,
} from '../secret-protection/win32';
import { type SecretProtectionOptions } from '../secret-protection';

const identity = {
  prefix: `canopy.vault.v1/canopy/dev/${'a'.repeat(64)}/`,
  principalSid: 'S-1-5-21-1-2-3-1001',
};
const options: SecretProtectionOptions = {
  os: 'win32',
  nativePath: '/not-loaded.node',
  applicationId: 'com.canopy.dev',
  authorityId: 'a'.repeat(64),
  brandId: 'canopy',
  build: 'dev',
  windowsPrincipalSid: identity.principalSid,
};
const call = (): { signal: AbortSignal; interaction: 'never' } => ({
  signal: new AbortController().signal,
  interaction: 'never',
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(reply: unknown = { code: 'ok' }): {
  run: jest.Mock<
    ReturnType<CredentialNative['run']>,
    Parameters<CredentialNative['run']>
  >;
  load: jest.Mock<{ run: CredentialNative['run'] }, []>;
  port: PlatformSecretProtectionServices;
} {
  const run = jest.fn<
    ReturnType<CredentialNative['run']>,
    Parameters<CredentialNative['run']>
  >(() => Promise.resolve(reply));
  const load = jest.fn(() => ({ run }));
  return { run, load, port: createWindowsSecretProtection(load, identity) };
}

describe('Windows secret protection failure contract', () => {
  test.each([
    'denied',
    'unsupported_session',
    'unavailable',
    'interaction_required',
    'locked',
  ])('reports %s as refusal, never as a missing key', async (code) => {
    const { port } = harness({ code });
    const reason = ['unsupported_session', 'unavailable'].includes(code)
      ? 'unavailable'
      : code;
    const blocked = { kind: 'blocked', reason };
    expect(await port.readKeySlot({ name: 's' }, call())).toEqual(blocked);
    for (const mode of ['create', 'replace'] as const)
      expect(
        await port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
          ...call(),
          mode,
        }),
      ).toEqual(blocked);
    expect(await port.deleteKeySlot({ name: 's' }, call())).toEqual(blocked);
  });
  test.each([
    ['absent', { kind: 'absent' }],
    ['corrupt', { kind: 'corrupt' }],
    ['ok', { kind: 'corrupt' }],
    ['unknown', { kind: 'blocked', reason: 'unavailable' }],
  ])('read preserves the %s outcome', async (code, result) => {
    const { port } = harness({ code });
    expect(await port.readKeySlot({ name: 's' }, call())).toEqual(result);
  });
  test.each([
    ['ok', 'written', 'deleted'],
    ['conflict', 'conflict', 'uncertain'],
    ['failed', 'failed', 'uncertain'],
    ['absent', 'uncertain', 'absent'],
    ['bad', 'uncertain', 'uncertain'],
  ])('mutations preserve the %s outcome', async (code, write, remove) => {
    const { port } = harness({ code });
    for (const mode of ['create', 'replace'] as const)
      expect(
        await port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
          ...call(),
          mode,
        }),
      ).toEqual({ kind: write });
    expect(await port.deleteKeySlot({ name: 's' }, call())).toEqual({
      kind: remove,
    });
  });
  test.each([0, 1, 1024, 1025])(
    'read transfers ownership of native material of length %i',
    async (length) => {
      const material = Buffer.alloc(length, 13);
      const { port } = harness({ code: 'ok', material });
      const result = await port.readKeySlot({ name: 's' }, call());
      expect(material.every((byte) => byte === 0)).toBe(true);
      if (length === 1 || length === 1024)
        expect(result).toEqual({
          kind: 'present',
          material: new Uint8Array(length).fill(13),
        });
      else expect(result).toEqual({ kind: 'corrupt' });
    },
  );
  test('refused reads erase stray material without exposing diagnostics', async () => {
    const material = new Uint8Array([42]);
    const { port } = harness({
      code: 'denied',
      material,
      diagnostic: 'secret',
    });
    expect(await port.readKeySlot({ name: 's' }, call())).toEqual({
      kind: 'blocked',
      reason: 'denied',
    });
    expect(material[0]).toBe(0);
  });
  test('untrusted reply accessors cannot run through the platform port', async () => {
    const getter = jest.fn(() => {
      throw new Error('untrusted getter');
    });
    const { port } = harness(
      Object.defineProperty({}, 'code', { get: getter }),
    );
    expect(
      await port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).toEqual({ kind: 'uncertain' });
    expect(getter).not.toHaveBeenCalled();
  });
  test.each([
    ['ok', { state: 'available' }],
    ['locked', { state: 'locked', evidence: 'reported' }],
    ['interaction_required', { state: 'unknown' }],
    [
      'unsupported_session',
      { state: 'unavailable', reason: 'unsupported_session' },
    ],
    ['denied', { state: 'denied' }],
    ['unavailable', { state: 'unavailable', reason: 'backend_failed' }],
  ])('status preserves the %s reason', async (code, state) => {
    const { port } = harness({ code });
    expect(await port.status(call())).toEqual(state);
  });
  test.each([
    { reply: null, status: { state: 'unknown' } },
    { reply: {}, status: { state: 'unknown' } },
    { reply: { code: 5 }, status: { state: 'unknown' } },
    {
      reply: { code: 'new_failure' },
      status: { state: 'unavailable', reason: 'backend_failed' },
    },
  ])(
    'malformed or future native replies fail closed: $reply',
    async ({ reply, status }) => {
      const { port } = harness(reply);
      expect(await port.status(call())).toEqual(status);
      expect(await port.readKeySlot({ name: 's' }, call())).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      for (const mode of ['create', 'replace'] as const)
        expect(
          await port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
            ...call(),
            mode,
          }),
        ).toEqual({ kind: 'uncertain' });
      expect(await port.deleteKeySlot({ name: 's' }, call())).toEqual({
        kind: 'uncertain',
      });
    },
  );
  test('returned buffers remain independent across reads', async () => {
    const { port, run } = harness();
    run.mockImplementation(() =>
      Promise.resolve({ code: 'ok', material: Buffer.from([13]) }),
    );
    const one = await port.readKeySlot({ name: 's' }, call());
    const two = await port.readKeySlot({ name: 's' }, call());
    if (one.kind !== 'present' || two.kind !== 'present')
      throw new Error('Expected recovered key material.');
    one.material.fill(0);
    expect(two.material).toEqual(new Uint8Array([13]));
  });
});

describe('Windows prompt-free adapter scheduling', () => {
  test.each(['', '../a', 'A', 'a/b', 'x'.repeat(65), 'a\0'])(
    'rejects slot %j before native access',
    async (name) => {
      const { port, load } = harness();
      await expect(port.readKeySlot({ name }, call())).rejects.toThrow(
        TypeError,
      );
      await expect(
        port.writeKeySlot({ name }, new Uint8Array([1]), {
          ...call(),
          mode: 'create',
        }),
      ).rejects.toThrow(TypeError);
      await expect(port.deleteKeySlot({ name }, call())).rejects.toThrow(
        TypeError,
      );
      expect(load).not.toHaveBeenCalled();
    },
  );
  test.each([0, 1025])(
    'rejects material size %i before native access',
    async (length) => {
      const { port, load } = harness();
      await expect(
        port.writeKeySlot({ name: 'slot' }, new Uint8Array(length), {
          ...call(),
          mode: 'create',
        }),
      ).rejects.toThrow(TypeError);
      expect(load).not.toHaveBeenCalled();
    },
  );
  test('rejects every operation before dispatch when aborted', async () => {
    const { port, load } = harness();
    const controller = new AbortController();
    const error = new Error('cancel');
    controller.abort(error);
    const opts = { signal: controller.signal, interaction: 'never' } as const;
    for (const promise of [
      port.status(opts),
      port.readKeySlot({ name: 's' }, opts),
      port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
        ...opts,
        mode: 'create',
      }),
      port.deleteKeySlot({ name: 's' }, opts),
    ])
      await expect(promise).rejects.toBe(error);
    expect(load).not.toHaveBeenCalled();
  });
  test.each([null, 'cancel', { caller: 'reason' }])(
    'preserves caller-owned non-Error abort reasons %j',
    async (reason) => {
      const { port, load } = harness();
      const controller = new AbortController();
      controller.abort(reason);
      await expect(
        port.readKeySlot(
          { name: 's' },
          { ...call(), signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(load).not.toHaveBeenCalled();
    },
  );

  test('queued cancellation settles without dispatch or waiting', async () => {
    const first = deferred<unknown>();
    const entered = deferred<void>();
    const { port, run } = harness();
    run.mockImplementationOnce(async () => {
      entered.resolve();
      return first.promise;
    });
    const one = port.readKeySlot({ name: 'one' }, call());
    await entered.promise;
    const controller = new AbortController();
    const two = port.writeKeySlot({ name: 'two' }, new Uint8Array([9]), {
      signal: controller.signal,
      interaction: 'never',
      mode: 'create',
    });
    controller.abort(new Error('queued'));
    await expect(two).rejects.toThrow('queued');
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve({ code: 'absent' });
    await one;
    await port.readKeySlot({ name: 'three' }, call());
    expect(run).toHaveBeenCalledTimes(2);
  });
  test('queued writes own their bytes before native entry and erase them on completion', async () => {
    const finish = deferred<unknown>();
    const entered = deferred<void>();
    const { port, run } = harness();
    run.mockImplementationOnce(async () => {
      entered.resolve();
      return finish.promise;
    });
    const first = port.readKeySlot({ name: 'one' }, call());
    await entered.promise;
    const caller = Buffer.from([77]);
    const pending = port.writeKeySlot({ name: 'two' }, caller, {
      ...call(),
      mode: 'create',
    });
    caller.fill(9);
    let submitted: Uint8Array | undefined;
    run.mockImplementationOnce((_op, _target, _mutex, bytes) => {
      submitted = bytes;
      expect(bytes).toEqual(new Uint8Array([77]));
      return Promise.resolve({ code: 'ok' });
    });
    finish.resolve({ code: 'absent' });
    await first;
    expect(await pending).toEqual({ kind: 'written' });
    expect(submitted).toEqual(new Uint8Array([0]));
    expect(caller).toEqual(Buffer.from([9]));
  });
  test('entered mutation does not settle uncertain while it could still land', async () => {
    const finish = deferred<unknown>();
    const entered = deferred<void>();
    const { port, run } = harness();
    let copied: Uint8Array | undefined;
    let cancellation: Uint32Array | undefined;
    run.mockImplementationOnce(
      async (_op, _target, _mutex, bytes, _sid, cancel) => {
        copied = bytes;
        cancellation = cancel;
        entered.resolve();
        return finish.promise;
      },
    );
    const controller = new AbortController();
    const caller = Buffer.from([77]);
    let settled = false;
    const pending = port
      .writeKeySlot({ name: 's' }, caller, {
        signal: controller.signal,
        interaction: 'allowed',
        mode: 'create',
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await entered.promise;
    controller.abort();
    expect(cancellation && Atomics.load(cancellation, 0)).toBe(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    caller.fill(0);
    expect(copied?.[0]).toBe(77);
    finish.resolve({ code: 'ok' });
    expect(await pending).toEqual({ kind: 'written' });
    expect(copied?.[0]).toBe(0);
  });
  test('native cancelled without effects rejects with the original abort reason', async () => {
    const controller = new AbortController();
    const error = new Error('native wait');
    const { port, run } = harness();
    run.mockImplementationOnce(() => {
      controller.abort(error);
      return Promise.resolve({ code: 'cancelled' });
    });
    await expect(
      port.deleteKeySlot(
        { name: 's' },
        { ...call(), signal: controller.signal },
      ),
    ).rejects.toBe(error);
  });
  test.each<Exclude<CredentialOperation, 'status'>>([
    'read',
    'create',
    'replace',
    'delete',
  ])(
    'bounds rejected native %s diagnostics and permits the next call',
    async (operation) => {
      const { port, run } = harness({ code: 'absent' });
      run.mockRejectedValueOnce(new Error('secret backend path'));
      const result =
        operation === 'read'
          ? await port.readKeySlot({ name: 's' }, call())
          : operation === 'delete'
            ? await port.deleteKeySlot({ name: 's' }, call())
            : await port.writeKeySlot({ name: 's' }, new Uint8Array([1]), {
                ...call(),
                mode: operation,
              });
      expect(result).toEqual(
        operation === 'read'
          ? { kind: 'blocked', reason: 'unavailable' }
          : { kind: 'uncertain' },
      );
      expect(await port.readKeySlot({ name: 's' }, call())).toEqual({
        kind: 'absent',
      });
    },
  );
  test('status observes without a synthetic credential', async () => {
    const { port, run } = harness({ code: 'unknown' });
    expect(await port.status(call())).toEqual({ state: 'unknown' });
    expect(run.mock.calls.map(([op]) => op)).toEqual(['status']);
  });
  test('factory refuses missing context and never substitutes a backend', async () => {
    // Method bivariance deliberately permits incomplete runtime input in this test
    // without weakening the production factory's required options.
    const factory: {
      create(
        options: Partial<SecretProtectionOptions>,
      ): PlatformSecretProtectionServices;
    } = { create: createSecretProtectionServices };
    for (const overrides of [
      { authorityId: undefined },
      { windowsPrincipalSid: undefined },
      { brandId: undefined },
      { build: undefined },
    ]) {
      const port = factory.create({ ...options, ...overrides });
      expect(await port.status(call())).toEqual({
        state: 'unavailable',
        reason: 'authority_unavailable',
      });
      expect(await port.readKeySlot({ name: 's' }, call())).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
    }
    const load = jest.spyOn(process, 'dlopen');
    try {
      for (const os of ['freebsd', 'aix']) {
        const port = createSecretProtectionServices({ ...options, os });
        expect(await port.status(call())).toEqual({
          state: 'unavailable',
          reason: 'no_backend',
        });
        expect(await port.readKeySlot({ name: 's' }, call())).toEqual({
          kind: 'blocked',
          reason: 'unavailable',
        });
      }
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });
});

describe('shared factory Windows port selection', () => {
  test('canonical brandId/build inputs retain Windows targets across both brands and every build', async () => {
    const run = jest.fn<Promise<unknown>, Parameters<CredentialNative['run']>>(
      () => Promise.resolve({ code: 'absent' }),
    );
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.defineProperty(module, 'exports', {
        value: { fixture: false, abi: 'windows-credential-v1', run },
      });
    });
    try {
      const targets = new Set<string>();
      for (const brandId of ['canopy', 'unstoppable-code']) {
        for (const build of ['stable', 'internal', 'rc', 'dev'] as const) {
          const port = createSecretProtectionServices({
            ...options,
            applicationId: undefined,
            brandId,
            build,
          });
          expect(port.backend).toBe('windows_credential_manager');
          expect(await port.readKeySlot({ name: 'slot' }, call())).toEqual({
            kind: 'absent',
          });
          const request = run.mock.calls.at(-1);
          expect(request?.[1]).toBe(
            `canopy.vault.v1/${brandId}/${build}/${options.authorityId}/slot`,
          );
          expect(request?.[4]).toBe(identity.principalSid);
          if (!request) throw new Error('No native request.');
          targets.add(request[1]);
          await port.readKeySlot({ name: 'slot' }, call());
        }
      }
      expect(targets.size).toBe(8);
      expect(load).toHaveBeenCalledTimes(8);
      expect(run).toHaveBeenCalledTimes(16);
    } finally {
      load.mockRestore();
    }
  });
  test.each([
    { fixture: true, abi: 'windows-credential-v1' },
    { fixture: false, abi: 'other-version' },
    { fixture: false },
  ])(
    'does not accept a fixture or incompatible native ABI: %p',
    async (metadata) => {
      const run = jest.fn(() => Promise.resolve({ code: 'ok' }));
      const load = jest
        .spyOn(process, 'dlopen')
        .mockImplementation((module) => {
          Object.defineProperty(module, 'exports', {
            value: { ...metadata, run },
          });
        });
      try {
        const port = createSecretProtectionServices(options);
        expect(await port.status(call())).toEqual({
          state: 'unavailable',
          reason: 'backend_failed',
        });
        expect(await port.readKeySlot({ name: 'slot' }, call())).toEqual({
          kind: 'blocked',
          reason: 'unavailable',
        });
        expect(load).toHaveBeenCalledTimes(1);
        expect(run).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
      }
    },
  );
});
