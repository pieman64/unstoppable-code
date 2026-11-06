import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import {
  createDarwinSecretProtection,
  type KeychainNative,
  type NativeOperation,
} from '../secret-protection/darwin';
import {
  createSecretProtectionServices,
  type SecretProtectionOptions,
} from '../secret-protection';
import {
  createLinuxSecretProtection,
  type SecretServiceNative,
} from '../secret-protection/linux';

const namespace = {
  service: 'canopy.stable.vault',
  authorityId: 'a'.repeat(64),
};
const call = (): { signal: AbortSignal; interaction: 'never' } => ({
  signal: new AbortController().signal,
  interaction: 'never',
});
const slot = { name: 'vault-test' };
const options: SecretProtectionOptions = {
  os: 'darwin',
  nativePath: '/missing/keychain.node',
  brandId: 'canopy',
  build: 'stable',
  authorityId: namespace.authorityId,
};

function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => {
    throw new Error('not ready');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(reply: unknown = { code: 'ok' }): {
  port: PlatformSecretProtectionServices;
  run: jest.Mock<Promise<unknown>, Parameters<KeychainNative['run']>>;
} {
  const run = jest.fn<Promise<unknown>, Parameters<KeychainNative['run']>>(() =>
    Promise.resolve(reply),
  );
  return {
    port: createDarwinSecretProtection(() => ({ run }), namespace),
    run,
  };
}

describe('macOS key slots: closed native outcome contract', () => {
  test.each([
    'locked',
    'denied',
    'interaction_required',
    'unavailable',
    'unsupported_session',
  ])('%s never becomes absence', async (code) => {
    const { port } = harness({ code, raw: 'sensitive' });
    const reason = code === 'unsupported_session' ? 'unavailable' : code;
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason,
    });
    expect(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).toEqual({ kind: 'blocked', reason });
    expect(await port.deleteKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason,
    });
  });
  test.each([
    undefined,
    null,
    {},
    { code: -25293 },
    { code: 'new_failure', raw: 'sensitive' },
  ])('unknown failures fail closed without diagnostics: %p', async (value) => {
    const { port, run } = harness();
    run.mockResolvedValue(value);
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(await port.status(call())).toEqual({
      state: 'unavailable',
      reason: 'backend_failed',
    });
    expect(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).toEqual({ kind: 'uncertain' });
    expect(await port.deleteKeySlot(slot, call())).toEqual({
      kind: 'uncertain',
    });
  });
  test.each([
    {
      code: 'unknown',
      read: 'blocked',
      write: 'uncertain',
      remove: 'uncertain',
    },
    { code: 'failed', read: 'blocked', write: 'failed', remove: 'uncertain' },
    { code: 'absent', read: 'absent', write: 'uncertain', remove: 'absent' },
    {
      code: 'conflict',
      read: 'blocked',
      write: 'conflict',
      remove: 'uncertain',
    },
  ])(
    'completed $code outcomes are not invented',
    async ({ code, read, write, remove }) => {
      const { port } = harness({ code });
      expect(await port.readKeySlot(slot, call())).toEqual(
        read === 'blocked'
          ? { kind: 'blocked', reason: 'unavailable' }
          : { kind: read },
      );
      expect(
        await port.writeKeySlot(slot, new Uint8Array([1]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: write });
      expect(await port.deleteKeySlot(slot, call())).toEqual({ kind: remove });
    },
  );
  test.each([
    { code: 'ok', expected: { state: 'available' } },
    { code: 'locked', expected: { state: 'locked', evidence: 'reported' } },
    { code: 'interaction_required', expected: { state: 'unknown' } },
    {
      code: 'absent',
      expected: { state: 'unavailable', reason: 'backend_failed' },
    },
  ])(
    'status observes protection, not slot presence: $code',
    async ({ code, expected }) => {
      const { port } = harness({ code });
      expect(await port.status(call())).toEqual(expected);
    },
  );
  test.each([0, 1025])(
    'malformed recovered material is corrupt and erased (%i bytes)',
    async (length) => {
      const bytes = Buffer.alloc(length, 19);
      const { port } = harness({ code: 'ok', material: bytes });
      expect(await port.readKeySlot(slot, call())).toEqual({ kind: 'corrupt' });
      expect(bytes.every((value) => value === 0)).toBe(true);
    },
  );
  test('read results are fresh, and native material is erased even on failure', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const { port, run } = harness({ code: 'ok', material: bytes });
    const value = await port.readKeySlot(slot, call());
    expect(bytes).toEqual(Buffer.alloc(3));
    expect(value.kind).toBe('present');
    if (value.kind !== 'present') throw new Error('no material');
    expect([...value.material]).toEqual([1, 2, 3]);
    value.material.fill(0);
    const failed = Buffer.from([19]);
    run.mockResolvedValue({ code: 'unavailable', material: failed });
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(failed[0]).toBe(0);
  });
  test('native errors and their secret diagnostics never escape', async () => {
    const { port, run } = harness();
    run.mockRejectedValue(new Error('secret OS failure with path'));
    expect(await port.status(call())).toEqual({
      state: 'unavailable',
      reason: 'backend_failed',
    });
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).toEqual({ kind: 'uncertain' });
    expect(await port.deleteKeySlot(slot, call())).toEqual({
      kind: 'uncertain',
    });
  });
});

describe('macOS key slots: validation, ownership and cancellation', () => {
  test.each([
    '',
    '-leading',
    'UPPER',
    '../x',
    'a/b',
    'nul\0',
    'x\n',
    'x'.repeat(65),
  ])('invalid name never reaches native: %p', async (name) => {
    const { port, run } = harness();
    await expect(port.readKeySlot({ name }, call())).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      port.writeKeySlot({ name }, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(port.deleteKeySlot({ name }, call())).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(run).not.toHaveBeenCalled();
  });
  test.each([0, 1025])(
    'invalid size never reaches native: %i',
    async (size) => {
      const { port, run } = harness();
      await expect(
        port.writeKeySlot(slot, new Uint8Array(size), {
          ...call(),
          mode: 'create',
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(run).not.toHaveBeenCalled();
    },
  );
  test.each([1, 1024])(
    'valid size with Buffer view is copied immediately and erased after completion: %i',
    async (size) => {
      const { port, run } = harness();
      const input = Buffer.alloc(size + 2, 42).subarray(1, size + 1);
      const pending = held<unknown>();
      run.mockReturnValue(pending.promise);
      const writing = port.writeKeySlot(slot, input, {
        ...call(),
        mode: 'create',
      });
      input.fill(20);
      await Promise.resolve();
      const owned = run.mock.calls[0]?.[3];
      expect(owned).toEqual(new Uint8Array(size).fill(42));
      pending.resolve({ code: 'ok' });
      expect(await writing).toEqual({ kind: 'written' });
      expect(owned).toEqual(new Uint8Array(size));
      expect(input.every((value) => value === 20)).toBe(true);
    },
  );
  test('pre-aborted calls start no native work', async () => {
    const { port, run } = harness();
    const control = new AbortController();
    const reason = new Error('abort');
    control.abort(reason);
    const aborted = { ...call(), signal: control.signal };
    await expect(port.status(aborted)).rejects.toBe(reason);
    await expect(port.readKeySlot(slot, aborted)).rejects.toBe(reason);
    await expect(
      port.writeKeySlot(slot, new Uint8Array([1]), {
        ...aborted,
        mode: 'create',
      }),
    ).rejects.toBe(reason);
    await expect(port.deleteKeySlot(slot, aborted)).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });
  test('queued-aborted calls start no native work; serialization recovers', async () => {
    const { port, run } = harness();
    const pending = held<unknown>();
    run.mockReturnValueOnce(pending.promise);
    const first = port.readKeySlot(slot, call());
    const control = new AbortController();
    const reason = new Error('queued abort');
    const queued = port.writeKeySlot(slot, Buffer.from([9]), {
      ...call(),
      signal: control.signal,
      mode: 'create',
    });
    const rejected = expect(queued).rejects.toBe(reason);
    control.abort(reason);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    pending.resolve({ code: 'absent' });
    await first;
    await rejected;
    await port.status(call());
    expect(run).toHaveBeenCalledTimes(2);
  });
  test.each<NativeOperation>(['create', 'replace', 'delete'])(
    'in-flight %s cancellation awaits actual native completion',
    async (operation) => {
      const { port, run } = harness();
      const pending = held<unknown>();
      run.mockReturnValueOnce(pending.promise);
      const control = new AbortController();
      const active = { ...call(), signal: control.signal };
      const work =
        operation === 'delete'
          ? port.deleteKeySlot(slot, active)
          : port.writeKeySlot(slot, new Uint8Array([9]), {
              ...active,
              mode: operation === 'create' ? 'create' : 'replace',
            });
      let settled = false;
      void work.then(() => {
        settled = true;
      });
      await Promise.resolve();
      control.abort(new Error('in flight'));
      await Promise.resolve();
      expect(settled).toBe(false);
      if (operation !== 'delete')
        expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([9]));
      pending.resolve({ code: 'ok' });
      expect(await work).toEqual({
        kind: operation === 'delete' ? 'deleted' : 'written',
      });
      if (operation !== 'delete')
        expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
    },
  );
  test('a completed uncertain mutation cannot land later and a later abort has no effect', async () => {
    const { port, run } = harness({ code: 'uncertain' });
    const control = new AbortController();
    expect(
      await port.writeKeySlot(slot, Buffer.from([1]), {
        ...call(),
        signal: control.signal,
        mode: 'create',
      }),
    ).toEqual({ kind: 'uncertain' });
    control.abort();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
  });
  test('allowed access to an unlocked backend preserves namespace snapshots', async () => {
    const { run } = harness();
    const selected = { ...namespace };
    const port = createDarwinSecretProtection(() => ({ run }), selected);
    const name = { name: 'original' };
    const work = port.readKeySlot(name, { ...call(), interaction: 'allowed' });
    name.name = 'changed';
    selected.service = 'canopy.internal.vault';
    selected.authorityId = 'b'.repeat(64);
    await work;
    expect(run.mock.calls[0]).toEqual([
      'read',
      namespace.service,
      `${namespace.service}/${namespace.authorityId}/original`,
      new Uint8Array(),
    ]);
  });
  test('invalid mode/interaction fails before the backend', async () => {
    const { port, run } = harness();
    const loose: {
      readKeySlot(...args: unknown[]): Promise<unknown>;
      writeKeySlot(...args: unknown[]): Promise<unknown>;
    } = port;
    await expect(
      loose.readKeySlot(slot, { ...call(), interaction: 'ask' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      loose.writeKeySlot(slot, Buffer.from([1]), { ...call(), mode: 'upsert' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('macOS key slots: trusted composition refuses unsupported access', () => {
  test.each<Partial<SecretProtectionOptions>>([
    { os: 'linux' },
    { authorityId: undefined },
    { nativePath: 'relative.node' },
    {},
  ])('unavailable composition never falls back: %p', async (overrides) => {
    const port = createSecretProtectionServices({ ...options, ...overrides });
    expect((await port.status(call())).state).toBe('unavailable');
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
  });
  test('malformed authority/brand identities reject before loading', () => {
    expect(() =>
      createSecretProtectionServices({ ...options, authorityId: '../root' }),
    ).toThrow(TypeError);
    expect(() =>
      createSecretProtectionServices({ ...options, brandId: 'x/evil' }),
    ).toThrow(TypeError);
  });
});

describe('macOS key slots: V-3 and V-6 brand + build policy', () => {
  const brands = ['canopy', 'unstoppable-code'] as const;
  const builds = ['stable', 'internal', 'rc', 'dev'] as const;
  test('all eight pairs have distinct service AND account names at the same authority', async () => {
    const services = new Set<string>();
    const accounts = new Set<string>();
    let requests = 0;
    const run = jest.fn<Promise<unknown>, Parameters<KeychainNative['run']>>(
      () => Promise.resolve({ code: 'absent' }),
    );
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.defineProperty(module, 'exports', {
        value: { fixture: false, run },
      });
    });
    try {
      for (const brandId of brands) {
        for (const build of builds) {
          const selected = {
            ...options,
            brandId,
            build,
            nativePath: '/missing/brand-build-isolation.node',
          };
          const port = createSecretProtectionServices(selected);
          expect(await port.readKeySlot(slot, call())).toEqual({
            kind: 'absent',
          });
          expect(run).toHaveBeenCalledTimes(++requests);
          const request = run.mock.calls.at(-1);
          expect(request?.[1]).toBe(`${brandId}.${build}.vault`);
          expect(request?.[2]).toBe(
            `${brandId}.${build}.vault/${options.authorityId}/${slot.name}`,
          );
          if (!request) throw new Error('No native request');
          services.add(request[1]);
          accounts.add(request[2]);
          const second = createSecretProtectionServices(selected);
          expect(await second.readKeySlot(slot, call())).toEqual({
            kind: 'absent',
          });
          expect(run).toHaveBeenCalledTimes(++requests);
          expect(run.mock.calls.at(-1)).toEqual(request);
        }
      }
      expect(services.size).toBe(8);
      expect(accounts.size).toBe(8);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });
  test.each(builds)(
    '%s loads the backend without a separate dev/signing gate',
    async (build) => {
      const run = jest.fn(() => Promise.resolve({ code: 'ok' }));
      const load = jest
        .spyOn(process, 'dlopen')
        .mockImplementation((module) => {
          Object.defineProperty(module, 'exports', {
            value: { fixture: false, run },
          });
        });
      try {
        const port = createSecretProtectionServices({
          ...options,
          build,
          nativePath: `/missing/${build}.node`,
        });
        expect(await port.status(call())).toEqual({ state: 'available' });
        expect(load).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        const second = createSecretProtectionServices({
          ...options,
          build,
          nativePath: `/missing/${build}.node`,
        });
        expect(await second.status(call())).toEqual({ state: 'available' });
        expect(load).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(2);
      } finally {
        load.mockRestore();
      }
    },
  );
  test.each([
    { brandId: '' },
    { brandId: 'Canopy' },
    { brandId: 'other-brand' },
    { brandId: 'canopy\0' },
    { brandId: 'canopy\n' },
    { build: '' },
    { build: 'prod' },
    { build: 'development' },
    { build: 'stable/other' },
    { build: 'stable\0' },
    { build: 'stable\n' },
    { brandId: undefined },
    { build: undefined },
    { authorityId: 'a'.repeat(64) + '\n' },
    { authorityId: 'A'.repeat(64) },
    { authorityId: '' },
    { authorityId: 'a'.repeat(63) },
    { authorityId: 'a'.repeat(65) },
  ])('invalid brand/build rejects before backend loading: %p', (invalid) => {
    const load = jest.spyOn(process, 'dlopen');
    const loose = (value: object): unknown =>
      Reflect.apply(createSecretProtectionServices, undefined, [value]);
    try {
      expect(() => loose({ ...options, ...invalid })).toThrow(TypeError);
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });
});

describe('macOS key slots: coalesced OS unlock phase', () => {
  const allowed = (): { signal: AbortSignal; interaction: 'allowed' } => ({
    ...call(),
    interaction: 'allowed',
  });
  function lockedHarness(): {
    run: jest.Mock<Promise<unknown>, Parameters<KeychainNative['run']>>;
    make: () => PlatformSecretProtectionServices;
    port: PlatformSecretProtectionServices;
    answer: ReturnType<typeof held<unknown>>;
    started: Promise<void>;
  } {
    const answer = held<unknown>();
    const started = held<void>();
    let locked = true;
    const run = jest.fn<Promise<unknown>, Parameters<KeychainNative['run']>>(
      async (operation) => {
        if (operation === 'unlock') {
          started.resolve(undefined);
          const value = await answer.promise;
          if (
            typeof value === 'object' &&
            value !== null &&
            Reflect.get(value, 'code') === 'ok'
          )
            locked = false;
          return value;
        }
        if (operation === 'status') return { code: locked ? 'locked' : 'ok' };
        if (locked) return { code: 'locked' };
        return { code: operation === 'read' ? 'absent' : 'ok' };
      },
    );
    const make = (): PlatformSecretProtectionServices =>
      createDarwinSecretProtection(() => ({ run }), namespace);
    return { run, make, port: make(), answer, started: started.promise };
  }
  test.each(['read', 'create', 'replace', 'delete'] as const)(
    '%s can unlock, then run the slot operation with a final outcome',
    async (operation) => {
      const { port, answer, started, run } = lockedHarness();
      const work =
        operation === 'read'
          ? port.readKeySlot(slot, allowed())
          : operation === 'delete'
            ? port.deleteKeySlot(slot, allowed())
            : port.writeKeySlot(slot, new Uint8Array([1]), {
                ...allowed(),
                mode: operation,
              });
      await started;
      expect(run.mock.calls.map(([op]) => op)).toEqual([operation, 'unlock']);
      expect(run.mock.calls[1]?.[3].byteLength).toBe(0);
      answer.resolve({ code: 'ok' });
      expect(await work).toEqual({
        kind:
          operation === 'read'
            ? 'absent'
            : operation === 'delete'
              ? 'deleted'
              : 'written',
      });
      expect(run.mock.calls.map(([op]) => op)).toEqual([
        operation,
        'unlock',
        operation,
      ]);
    },
  );
  test.each(['locked', 'denied', 'unavailable', 'unknown'])(
    'unlock %s never becomes absence, a conflict or an uncertain mutation',
    async (code) => {
      const { port, answer, started, run } = lockedHarness();
      const work = port.writeKeySlot(slot, new Uint8Array([1]), {
        ...allowed(),
        mode: 'create',
      });
      await started;
      answer.resolve({ code });
      expect(await work).toEqual({
        kind: 'blocked',
        reason:
          code === 'locked' || code === 'denied' ? 'locked' : 'unavailable',
      });
      expect(run.mock.calls.map(([op]) => op)).toEqual(['create', 'unlock']);
      expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
    },
  );
  test('status bypasses an open dialog; queued never calls stay abortable and never reach native', async () => {
    const { port, answer, started, run, make } = lockedHarness();
    const control = new AbortController();
    const work = port.writeKeySlot(slot, new Uint8Array([9]), {
      ...allowed(),
      signal: control.signal,
      mode: 'replace',
    });
    await started;
    const other = make();
    expect(await other.status(call())).toEqual({
      state: 'locked',
      evidence: 'reported',
    });
    const queued = new AbortController();
    const waiting = other.readKeySlot(slot, {
      ...call(),
      signal: queued.signal,
    });
    const reason = new Error('queued');
    queued.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    const aborted = new Error('unlock abort');
    control.abort(aborted);
    await expect(work).rejects.toBe(aborted);
    expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
    expect(run.mock.calls.map(([op]) => op)).toEqual([
      'replace',
      'unlock',
      'status',
    ]);
    answer.resolve({ code: 'ok' });
    expect(await other.readKeySlot(slot, call())).toEqual({ kind: 'absent' });
    expect(run.mock.calls.filter(([op]) => op === 'replace')).toHaveLength(1);
  });
  test.each(['ok', 'locked'])(
    'concurrent allowed calls join one %s unlock even after the first caller aborts',
    async (code) => {
      const { port, make, answer, started, run } = lockedHarness();
      const control = new AbortController();
      const first = port.readKeySlot(slot, {
        ...allowed(),
        signal: control.signal,
      });
      await started;
      control.abort('abort');
      await expect(first).rejects.toBe('abort');
      const second = make().readKeySlot(slot, allowed());
      const third = make().deleteKeySlot(slot, allowed());
      answer.resolve({ code });
      expect(await second).toEqual(
        code === 'ok'
          ? { kind: 'absent' }
          : { kind: 'blocked', reason: 'locked' },
      );
      expect(await third).toEqual(
        code === 'ok'
          ? { kind: 'deleted' }
          : { kind: 'blocked', reason: 'locked' },
      );
      expect(run.mock.calls.filter(([op]) => op === 'unlock')).toHaveLength(1);
    },
  );
  test('an unlocked allowed mutation still awaits native completion on abort', async () => {
    const { port, run } = harness();
    const pending = held<unknown>();
    run.mockReturnValueOnce(pending.promise);
    const control = new AbortController();
    const work = port.writeKeySlot(slot, new Uint8Array([9]), {
      ...allowed(),
      signal: control.signal,
      mode: 'create',
    });
    await Promise.resolve();
    control.abort();
    pending.resolve({ code: 'ok' });
    expect(await work).toEqual({ kind: 'written' });
    expect(run.mock.calls.map(([op]) => op)).toEqual(['create']);
  });
  test.each(['ok', 'uncertain'])(
    'after unlock, phase-B cancellation preserves the completed %s mutation',
    async (code) => {
      const { port, answer, started, run } = lockedHarness();
      const mutation = held<unknown>();
      const mutationStarted = held<void>();
      const control = new AbortController();
      const work = port.writeKeySlot(slot, new Uint8Array([9]), {
        ...allowed(),
        signal: control.signal,
        mode: 'replace',
      });
      await started;
      run.mockImplementationOnce(() => {
        mutationStarted.resolve(undefined);
        return mutation.promise;
      });
      answer.resolve({ code: 'ok' });
      await mutationStarted.promise;
      let settled = false;
      void work.then(() => {
        settled = true;
      });
      control.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      mutation.resolve({ code });
      expect(await work).toEqual({
        kind: code === 'ok' ? 'written' : 'uncertain',
      });
      expect(run.mock.calls.map(([op]) => op)).toEqual([
        'replace',
        'unlock',
        'replace',
      ]);
      expect(run.mock.calls[2]?.[3]).toEqual(new Uint8Array([0]));
    },
  );
});

describe('Linux key slots: native phase ownership and closed results', () => {
  function linuxHarness(reply: unknown = { code: 'ok' }): {
    run: jest.Mock<Promise<unknown>, Parameters<SecretServiceNative['run']>>;
    port: PlatformSecretProtectionServices;
  } {
    const run = jest.fn<
      Promise<unknown>,
      Parameters<SecretServiceNative['run']>
    >(() => Promise.resolve(reply));
    return {
      run,
      port: createLinuxSecretProtection(() => ({ run }), namespace),
    };
  }

  test.each([
    'locked',
    'denied',
    'interaction_required',
    'unavailable',
    'unsupported_session',
  ])('%s never becomes absence or uncertainty', async (code) => {
    const { port } = linuxHarness({ code, diagnostic: 'secret path' });
    const blocked = {
      kind: 'blocked',
      reason: code === 'unsupported_session' ? 'unavailable' : code,
    };
    expect(await port.readKeySlot(slot, call())).toEqual(blocked);
    expect(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
    ).toEqual(blocked);
    expect(await port.deleteKeySlot(slot, call())).toEqual(blocked);
    if (code === 'unsupported_session')
      expect(await port.status(call())).toEqual({
        state: 'unavailable',
        reason: 'unsupported_session',
      });
  });
  test.each(['', '-x', 'UPPER', '../x', 'x/y', 'x\n', 'x\0', 'x'.repeat(65)])(
    'invalid name %p never reaches native',
    async (name) => {
      const { port, run } = linuxHarness();
      await expect(port.readKeySlot({ name }, call())).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(
        port.writeKeySlot({ name }, new Uint8Array([1]), {
          ...call(),
          mode: 'create',
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(port.deleteKeySlot({ name }, call())).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );
  test.each([0, 1025])(
    'invalid material size %i never reaches native',
    async (length) => {
      const { port, run } = linuxHarness();
      await expect(
        port.writeKeySlot(slot, new Uint8Array(length), {
          ...call(),
          mode: 'replace',
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(run).not.toHaveBeenCalled();
    },
  );
  test.each([1, 1024])(
    'writes own and erase a %i-byte Buffer view',
    async (length) => {
      const { port, run } = linuxHarness();
      const answer = held<unknown>();
      run.mockReturnValueOnce(answer.promise);
      const input = Buffer.alloc(length + 2, 7).subarray(1, length + 1);
      const work = port.writeKeySlot(slot, input, {
        ...call(),
        mode: 'create',
      });
      input.fill(9);
      const owned = run.mock.calls[0]?.[3];
      expect(owned).toEqual(new Uint8Array(length).fill(7));
      answer.resolve({ code: 'ok' });
      expect(await work).toEqual({ kind: 'written' });
      expect(owned).toEqual(new Uint8Array(length));
      expect(input.every((byte) => byte === 9)).toBe(true);
    },
  );
  test.each([0, 1, 1024, 1025])(
    'reads copy and erase native material of length %i',
    async (length) => {
      const material = new Uint8Array(length).fill(8);
      const { port } = linuxHarness({ code: 'ok', material });
      const result = await port.readKeySlot(slot, call());
      expect(result).toEqual(
        length === 1 || length === 1024
          ? { kind: 'present', material: new Uint8Array(length).fill(8) }
          : { kind: 'corrupt' },
      );
      expect(material).toEqual(new Uint8Array(length));
    },
  );
  test('duplicate reads remain corrupt without cleanup', async () => {
    const { port, run } = linuxHarness({ code: 'corrupt' });
    expect(await port.readKeySlot(slot, call())).toEqual({ kind: 'corrupt' });
    expect(run.mock.calls.map(([op]) => op)).toEqual(['read']);
  });
  test('duplicate mutation refusal does not prevent authoritative corrupt reads', async () => {
    const { port, run } = linuxHarness({ code: 'corrupt' });
    expect(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'replace',
      }),
    ).toEqual({ kind: 'uncertain' });
    expect(await port.deleteKeySlot(slot, call())).toEqual({
      kind: 'uncertain',
    });
    expect(await port.readKeySlot(slot, call())).toEqual({ kind: 'corrupt' });
    expect(run.mock.calls.map(([op]) => op)).toEqual([
      'replace',
      'delete',
      'read',
    ]);
  });
  test('pre-abort never even loads the backend', async () => {
    const load = jest.fn();
    const port = createLinuxSecretProtection(load, namespace);
    const controller = new AbortController();
    const reason = new Error('pre-abort');
    controller.abort(reason);
    const aborted = { ...call(), signal: controller.signal };
    await expect(port.status(aborted)).rejects.toBe(reason);
    await expect(port.readKeySlot(slot, aborted)).rejects.toBe(reason);
    await expect(
      port.writeKeySlot(slot, new Uint8Array([1]), {
        ...aborted,
        mode: 'create',
      }),
    ).rejects.toBe(reason);
    await expect(port.deleteKeySlot(slot, aborted)).rejects.toBe(reason);
    expect(load).not.toHaveBeenCalled();
  });
  test.each(['create', 'replace', 'delete'] as const)(
    '%s abort drains native completion and forwards the real signal',
    async (operation) => {
      const { port, run } = linuxHarness();
      const answer = held<unknown>();
      run.mockReturnValueOnce(answer.promise);
      const controller = new AbortController();
      const active = {
        signal: controller.signal,
        interaction: 'allowed',
      } as const;
      const work =
        operation === 'delete'
          ? port.deleteKeySlot(slot, active)
          : port.writeKeySlot(slot, new Uint8Array([1]), {
              ...active,
              mode: operation,
            });
      let settled = false;
      void work.then(() => {
        settled = true;
      });
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(run.mock.calls[0]?.slice(4)).toEqual([
        'allowed',
        controller.signal,
      ]);
      answer.resolve({ code: 'ok' });
      expect(await work).toEqual({
        kind: operation === 'delete' ? 'deleted' : 'written',
      });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  test('native prompt-abort rejection is preserved without another unlock or dismiss', async () => {
    const { port, run } = linuxHarness();
    const reason = new Error('unlock abort');
    run.mockImplementation(
      (_op, _service, _account, _bytes, _interaction, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const work = port.writeKeySlot(slot, new Uint8Array([9]), {
      signal: controller.signal,
      interaction: 'allowed',
      mode: 'create',
    });
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
    run.mockResolvedValue({ code: 'absent' });
    expect(await port.readKeySlot(slot, call())).toEqual({ kind: 'absent' });
  });
  test.each(['reply', 'throw'] as const)(
    'transport %s settles uncertain even on abort and latches every adapter sharing the binding',
    async (failure) => {
      const { port, run } = linuxHarness();
      const controller = new AbortController();
      run.mockImplementation(() => {
        controller.abort(new Error('abort'));
        return failure === 'throw'
          ? Promise.reject(new Error('sensitive transport detail'))
          : Promise.resolve({ code: 'uncertain' });
      });
      expect(
        await port.writeKeySlot(slot, new Uint8Array([7]), {
          ...call(),
          signal: controller.signal,
          mode: 'replace',
        }),
      ).toEqual({ kind: 'uncertain' });
      const other = createLinuxSecretProtection(() => ({ run }), namespace);
      expect(await other.status(call())).toEqual({
        state: 'unavailable',
        reason: 'backend_failed',
      });
      expect(await other.readKeySlot(slot, call())).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect(await other.deleteKeySlot(slot, call())).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect(
        await other.writeKeySlot(slot, new Uint8Array([8]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'blocked', reason: 'unavailable' });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  test('read transport exception is unavailable, never absence; later calls stay blocked', async () => {
    const { port, run } = linuxHarness();
    run.mockRejectedValueOnce(new Error('secret transport path'));
    expect(await port.readKeySlot(slot, call())).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(await port.status(call())).toEqual({
      state: 'unavailable',
      reason: 'backend_failed',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('Linux key slots: trusted factory and V-3 identity', () => {
  test.each(
    (['create', 'replace', 'delete'] as const).flatMap((operation) =>
      (
        [
          'unrecognized native reply',
          'transport reply',
          'transport rejection',
        ] as const
      ).map((failure) => ({ operation, failure })),
    ),
  )(
    '$operation with $failure latches the cached factory binding',
    async ({ operation, failure }) => {
      const run = jest.fn<
        Promise<unknown>,
        Parameters<SecretServiceNative['run']>
      >(() =>
        failure === 'transport rejection'
          ? Promise.reject(new Error('sensitive native transport detail'))
          : Promise.resolve({
              code:
                failure === 'transport reply'
                  ? 'uncertain'
                  : 'future-transport-failure',
            }),
      );
      const load = jest
        .spyOn(process, 'dlopen')
        .mockImplementation((module) => {
          Object.defineProperty(module, 'exports', {
            value: { fixture: false, abi: 'linux-secret-service-v1', run },
          });
        });
      const make = (): PlatformSecretProtectionServices =>
        createSecretProtectionServices({
          ...options,
          os: 'linux',
          nativePath: `/missing/ambiguous-${operation}-${failure}.node`,
        });
      try {
        const port = make();
        const outcome =
          operation === 'delete'
            ? await port.deleteKeySlot(slot, call())
            : await port.writeKeySlot(slot, new Uint8Array([7]), {
                ...call(),
                mode: operation,
              });
        expect(outcome).toEqual({ kind: 'uncertain' });
        run.mockResolvedValue({ code: 'ok' });
        const other = make();
        for (const adapter of [port, other]) {
          expect(await adapter.status(call())).toEqual({
            state: 'unavailable',
            reason: 'backend_failed',
          });
          expect(await adapter.readKeySlot(slot, call())).toEqual({
            kind: 'blocked',
            reason: 'unavailable',
          });
          for (const mode of ['create', 'replace'] as const)
            expect(
              await adapter.writeKeySlot(slot, new Uint8Array([8]), {
                ...call(),
                mode,
              }),
            ).toEqual({ kind: 'blocked', reason: 'unavailable' });
          expect(await adapter.deleteKeySlot(slot, call())).toEqual({
            kind: 'blocked',
            reason: 'unavailable',
          });
        }
        expect(load).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        load.mockRestore();
      }
    },
  );
  test('cached factory adapters leave prompt and queued abort phases with native', async () => {
    const reason = new Error('native unlock abort');
    const run = jest.fn<
      Promise<unknown>,
      Parameters<SecretServiceNative['run']>
    >(
      (_op, _service, _account, _bytes, _interaction, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', (): void => reject(reason), {
            once: true,
          });
        }),
    );
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.defineProperty(module, 'exports', {
        value: { fixture: false, abi: 'linux-secret-service-v1', run },
      });
    });
    const make = (): PlatformSecretProtectionServices =>
      createSecretProtectionServices({
        ...options,
        os: 'linux',
        nativePath: '/missing/native-phase-owner.node',
      });
    const head = new AbortController();
    const queued = new AbortController();
    let headSettled = false;
    try {
      const first = make().writeKeySlot(slot, new Uint8Array([9]), {
        signal: head.signal,
        interaction: 'allowed',
        mode: 'create',
      });
      const firstRejection = expect(first).rejects.toBe(reason);
      void first.then(
        (): void => {
          headSettled = true;
        },
        (): void => {
          headSettled = true;
        },
      );
      const second = make().readKeySlot(slot, {
        signal: queued.signal,
        interaction: 'never',
      });
      expect(run.mock.calls.map(([op]) => op)).toEqual(['create', 'read']);
      expect(run.mock.calls.map((args) => args[5])).toEqual([
        head.signal,
        queued.signal,
      ]);
      queued.abort(reason);
      await expect(second).rejects.toBe(reason);
      expect(headSettled).toBe(false);
      head.abort(reason);
      await firstRejection;
      expect(run.mock.calls[0]?.[3]).toEqual(new Uint8Array([0]));
      run.mockResolvedValue({ code: 'absent' });
      expect(await make().readKeySlot(slot, call())).toEqual({
        kind: 'absent',
      });
      expect(load).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      head.abort(reason);
      queued.abort(reason);
      load.mockRestore();
    }
  });
  test.each([
    { fixture: true, abi: 'linux-secret-service-v1' },
    { fixture: false },
    { fixture: false, abi: 'other-backend' },
  ])('refuses a fixture or incompatible ABI: %p', async (properties) => {
    const run = jest.fn();
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.defineProperty(module, 'exports', {
        value: { ...properties, run },
      });
    });
    try {
      const port = createSecretProtectionServices({
        ...options,
        os: 'linux',
        nativePath: `/missing/refused-${JSON.stringify(properties)}.node`,
      });
      expect(port.backend).toBe('linux_secret_service');
      expect(await port.status(call())).toEqual({
        state: 'unavailable',
        reason: 'backend_failed',
      });
      expect(await port.readKeySlot(slot, call())).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect(run).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });
  test.each<Partial<SecretProtectionOptions>>([
    { authorityId: undefined },
    { nativePath: 'relative.node' },
  ])(
    'refuses incomplete host composition without loading: %p',
    async (overrides) => {
      const load = jest.spyOn(process, 'dlopen');
      try {
        const port = createSecretProtectionServices({
          ...options,
          os: 'linux',
          ...overrides,
        });
        expect(await port.status(call())).toEqual({
          state: 'unavailable',
          reason:
            overrides.authorityId === undefined && !overrides.nativePath
              ? 'authority_unavailable'
              : 'backend_failed',
        });
        expect(load).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
      }
    },
  );
  test('all eight brand/build pairs are distinct; data-root and addon location do not select storage identity', async () => {
    const run = jest.fn<
      Promise<unknown>,
      Parameters<SecretServiceNative['run']>
    >(() => Promise.resolve({ code: 'absent' }));
    const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.defineProperty(module, 'exports', {
        value: { fixture: false, abi: 'linux-secret-service-v1', run },
      });
    });
    const services = new Set<string>();
    const accounts = new Set<string>();
    try {
      for (const brandId of ['canopy', 'unstoppable-code']) {
        for (const build of ['stable', 'internal', 'rc', 'dev'] as const) {
          for (const root of ['/first/data', '/moved/data']) {
            const port = createSecretProtectionServices({
              ...options,
              os: 'linux',
              brandId,
              build,
              nativePath: `${root}/secret.node`,
            });
            expect(port.backend).toBe('linux_secret_service');
            expect(await port.readKeySlot(slot, call())).toEqual({
              kind: 'absent',
            });
            const request = run.mock.calls.at(-1);
            expect(request?.[1]).toBe(`${brandId}.${build}.vault`);
            expect(request?.[2]).toBe(
              `${brandId}.${build}.vault/${namespace.authorityId}/${slot.name}`,
            );
            if (!request) throw new Error('No native request');
            services.add(request[1]);
            accounts.add(request[2]);
          }
        }
      }
      expect(services.size).toBe(8);
      expect(accounts.size).toBe(8);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      load.mockRestore();
    }
  });
});
