import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformServices,
  createPlatformEndpointServices,
} from '@canopy/core-platform';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import type {
  PlatformOperatingSystem,
  PlatformPermissionResult,
  PlatformRenameResult,
  PlatformStartupClaim,
  PlatformEndpointListener,
  PlatformNamedPipeAddress,
  PlatformPipeEndpointServices,
  PlatformSocketBindResult,
} from '@canopy/core-runtime';
import {
  publishCanopyDaemon,
  type CanopyDaemonHeldClaim,
  type CanopyDaemonPublicationOptions,
} from '@canopy/core-runtime/node';
import type * as RuntimeNode from '@canopy/core-runtime/node';
import type * as StorageOwnership from '@canopy/core-runtime/storage/storage-ownership.generated';

// Host-native: path rules must match the real temp data root.
const os: PlatformOperatingSystem =
  process.platform === 'darwin' || process.platform === 'win32'
    ? process.platform
    : 'linux';
const posix = process.platform === 'win32' ? test.skip : test;
let dataRoot: string;
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'c5-')));
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function host(): CanopyDaemonPublicationOptions & {
  claims: CanopyStartupClaimPort;
} {
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: 'test-start' },
    inspectProcess: () =>
      Promise.resolve({
        kind: 'alive',
        startIdentity: 'test-start',
      }),
  });
  const platform = createPlatformServices(
    os,
    createPlatformEndpointServices(os, {
      validateStartupClaim: (claim: PlatformStartupClaim): Promise<boolean> =>
        claims.verify(claim),
    }),
  );
  return {
    platform,
    claims,
    dataRoot,
    runtimeMode: 'dev' as const,
    pid: process.pid,
    startIdentity: 'test-start',
    buildVersion: 'test',
    protocolRange: { min: 1, max: 1 },
  };
}

posix(
  'real socket is bound before discovery appears; token private; cleanup follows close',
  async () => {
    const options = host();
    const descriptorPath = join(dataRoot, 'runtime', 'core.json');
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong endpoint family');
    const platform = {
      ...options.platform,
      endpoints: {
        ...endpoints,
        bind: async (
          address: Parameters<typeof endpoints.bind>[0],
        ): Promise<PlatformSocketBindResult> => {
          await expect(stat(descriptorPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const result = await endpoints.bind(address);
          await expect(stat(descriptorPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          return result;
        },
      },
    };
    const bound = await publishCanopyDaemon({ ...options, platform });
    expect(bound.descriptor.version).toBe(1);
    expect(JSON.parse(await readFile(descriptorPath, 'utf8'))).toEqual(
      bound.descriptor,
    );
    const socket = await lstat(bound.listener.address.path, { bigint: true });
    expect(bound.descriptor.socketIdentity).toEqual({
      device: String(socket.dev),
      inode: String(socket.ino),
    });
    expect((await stat(bound.descriptor.tokenRef)).mode & 0o777).toBe(0o600);
    expect(await readFile(bound.descriptor.tokenRef, 'utf8')).toBe(
      bound.auth.secret,
    );
    expect(bound.auth.dataRootHash).toBe(
      createHash('sha256').update(dataRoot).digest('hex'),
    );
    await expect(publishCanopyDaemon(host())).rejects.toThrow(
      'Endpoint is live',
    );
    const originalClose = bound.listener.close.bind(bound.listener);
    bound.listener.close = async (): Promise<void> => {
      expect(await readFile(descriptorPath, 'utf8')).toBeTruthy();
      await originalClose();
    };
    await bound.close();
    await expect(stat(descriptorPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(bound.descriptor.tokenRef)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await bound.close();
  },
);

posix(
  'a published descriptor lets a successor recover the socket after its owner dies',
  async () => {
    const crashed = await publishCanopyDaemon(host());
    const socketPath = crashed.listener.address.path;
    // Keeps the bound inode at the path, as a SIGKILLed owner would leave it.
    const pinned = join(dataRoot, 'runtime', 'pinned.sock');
    await link(socketPath, pinned);
    await crashed.listener.close();
    await rename(pinned, socketPath);
    const options = host();
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong endpoint family');
    const unlinkStale = jest.fn(endpoints.unlinkStale.bind(endpoints));
    const successor = await publishCanopyDaemon({
      ...options,
      startIdentity: 'successor-start',
      platform: {
        ...options.platform,
        endpoints: { ...endpoints, unlinkStale },
        supervision: {
          ...options.platform.supervision,
          inspectProcess: () => Promise.resolve({ state: 'absent' }),
        },
      },
    });
    try {
      expect(unlinkStale).toHaveBeenCalledTimes(1);
      await expect(unlinkStale.mock.results[0]?.value).resolves.toBe(
        'unlinked',
      );
      expect(successor.descriptor.endpoint.path).toBe(socketPath);
      expect(
        JSON.parse(
          await readFile(join(dataRoot, 'runtime', 'core.json'), 'utf8'),
        ),
      ).toEqual(successor.descriptor);
      await expect(stat(crashed.descriptor.tokenRef)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await successor.close();
    }
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix.each([
  {
    case: 'a Windows matching incarnation',
    owner: {
      state: 'running',
      startIdentity: 'win32:v1:4242:20261008062326123456',
    },
    identity: 'win32:v1:4242:20261008062326123456',
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 1,
  },
  {
    case: 'a Windows unverifiable incarnation',
    owner: { state: 'unverifiable', reason: 'native receipt unavailable' },
    identity: 'win32:v1:4242:20261008062326123456',
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 1,
  },
  {
    case: 'a Windows changed incarnation',
    owner: {
      state: 'running',
      startIdentity: 'win32:v1:4242:20261008062326123457',
    },
    identity: 'win32:v1:4242:20261008062326123456',
    departed: true,
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 1,
  },
  {
    case: 'a live owner',
    owner: { state: 'running', startIdentity: 'old-start' },
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 1,
  },
  {
    case: 'an unverifiable owner',
    owner: { state: 'unverifiable', reason: 'test' },
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 1,
  },
  {
    case: 'a non-token reference',
    owner: { state: 'absent' },
    token: 'keep.json',
    version: 1,
  },
  {
    case: 'an unversioned descriptor',
    owner: { state: 'absent' },
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: undefined,
  },
  {
    case: 'an unknown-version descriptor',
    owner: { state: 'absent' },
    token: 'core-00000000-0000-4000-8000-000000000000.token',
    version: 2,
  },
] as const)(
  'replacing discovery protects or reclaims the token of $case',
  async (sample) => {
    const { owner, token, version } = sample;
    const startIdentity = 'identity' in sample ? sample.identity : 'old-start';
    const runtime = join(dataRoot, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    const tokenRef = join(runtime, token);
    await writeFile(tokenRef, 'old', { mode: 0o600 });
    await writeFile(
      join(runtime, 'core.json'),
      JSON.stringify({
        version,
        pid: 'identity' in sample ? 4242 : 1,
        startIdentity,
        endpoint: { kind: 'socket', path: join(runtime, 'gone.sock') },
        protocolRange: { min: 1, max: 1 },
        buildVersion: 'test',
        tokenRef,
      }),
      { mode: 0o600 },
    );
    const options = host();
    const bound = await publishCanopyDaemon({
      ...options,
      platform: {
        ...options.platform,
        supervision: {
          ...options.platform.supervision,
          inspectProcess: () => Promise.resolve(owner),
        },
      },
    });
    try {
      if ('departed' in sample && sample.departed)
        await expect(stat(tokenRef)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(tokenRef, 'utf8')).toBe('old');
    } finally {
      await bound.close();
    }
  },
);

posix(
  'refuses to touch the startup claim unless the daemon owns it',
  async () => {
    const generated =
      '@canopy/core-runtime/storage/storage-ownership.generated';
    await jest.isolateModulesAsync(async () => {
      const actual: typeof StorageOwnership = jest.requireActual(generated);
      jest.doMock(generated, () => ({
        ...actual,
        STORAGE_OWNERSHIP: actual.STORAGE_OWNERSHIP.map((row) =>
          row.id === 'daemon_startup_claim'
            ? { ...row, transitionOwner: 'offline' }
            : row,
        ),
      }));
      const isolated: typeof RuntimeNode =
        await import('@canopy/core-runtime/node');
      const options = host();
      const tryAcquire = jest.spyOn(options.claims, 'tryAcquire');
      await expect(isolated.publishCanopyDaemon(options)).rejects.toThrow(
        'daemon_startup_claim',
      );
      expect(tryAcquire).not.toHaveBeenCalled();
    });
  },
);

posix('failed bind publishes no token or descriptor', async () => {
  const options = host();
  const platform = {
    ...options.platform,
    endpoints: {
      ...options.platform.endpoints,
      bind: (): Promise<{ kind: 'in-use' }> =>
        Promise.resolve({ kind: 'in-use' }),
    },
  };
  await expect(publishCanopyDaemon({ ...options, platform })).rejects.toThrow(
    'Endpoint is in use',
  );
  await expect(
    stat(join(dataRoot, 'runtime', 'core.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const acquired = await options.claims.tryAcquire();
  expect(acquired.kind).toBe('acquired');
  if (acquired.kind === 'acquired')
    await options.claims.release(acquired.handle);
});

posix(
  'shutdown refuses an ambiguous claim while preserving listener and descriptor',
  async () => {
    const options = host();
    const bound = await publishCanopyDaemon(options);
    const held = await options.claims.tryAcquire();
    expect(held.kind).toBe('acquired');
    await expect(bound.close()).rejects.toThrow('Startup claim unavailable');
    expect(
      await readFile(join(dataRoot, 'runtime', 'core.json'), 'utf8'),
    ).toBeTruthy();
    if (held.kind === 'acquired') await options.claims.release(held.handle);
    await bound.close();
  },
);

posix(
  'shutdown retries an uncertain claim release before reporting closed',
  async () => {
    const options = host();
    const release = options.claims.release.bind(options.claims);
    let uncertain = false;
    const claims = {
      ...options.claims,
      release: (handle: object): ReturnType<typeof release> => {
        if (uncertain) {
          uncertain = false;
          return Promise.resolve('ambiguous' as const);
        }
        return release(handle);
      },
    };
    const bound = await publishCanopyDaemon({ ...options, claims });
    uncertain = true;
    await expect(bound.close()).rejects.toThrow('release uncertain');
    await bound.close();
    const next = await options.claims.tryAcquire();
    expect(next.kind).toBe('acquired');
    if (next.kind === 'acquired') await release(next.handle);
  },
);

posix(
  'insecure token permissions close the endpoint without publishing discovery',
  async () => {
    const options = host();
    const permissions = options.platform.secureFiles.permissions.bind(
      options.platform.secureFiles,
    );
    const platform = {
      ...options.platform,
      secureFiles: {
        ...options.platform.secureFiles,
        permissions: (
          request: Parameters<typeof permissions>[0],
        ): Promise<PlatformPermissionResult> =>
          request.kind === 'file'
            ? Promise.resolve({ state: 'insecure', reason: 'test' })
            : permissions(request),
      },
    };
    await expect(publishCanopyDaemon({ ...options, platform })).rejects.toThrow(
      'not private',
    );
    await expect(
      stat(join(dataRoot, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const bound = await publishCanopyDaemon(options);
    await bound.close();
  },
);

posix(
  'publication failure closes endpoint and releases the claim for retry',
  async () => {
    const options = host();
    const platform = {
      ...options.platform,
      secureFiles: {
        ...options.platform.secureFiles,
        rename: (): Promise<PlatformRenameResult> =>
          Promise.reject(new Error('injected rename failure')),
      },
    };
    await expect(publishCanopyDaemon({ ...options, platform })).rejects.toThrow(
      'injected rename failure',
    );
    await expect(
      stat(join(dataRoot, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const bound = await publishCanopyDaemon(options);
    await bound.close();
  },
);

posix(
  'published token authenticates the socket and rejects a foreign data root',
  async () => {
    const bound = await publishCanopyDaemon(host());
    const incoming = bound.listener.connections()[Symbol.asyncIterator]();
    try {
      for (const mismatch of [false, true]) {
        const clientWire = createConnection(bound.descriptor.endpoint.path);
        const accepted = await incoming.next();
        if (accepted.done) throw new Error('Listener ended');
        const stream = accepted.value;
        const serverWire = new Duplex({
          read(): void {
            void stream.read().then(
              (bytes) => this.push(bytes === null ? null : Buffer.from(bytes)),
              () => this.destroy(),
            );
          },
          write(bytes: Uint8Array, _encoding, callback): void {
            void stream.write(bytes).then(
              () => callback(),
              () => callback(new Error('Stream write failed')),
            );
          },
          destroy(error, callback): void {
            void stream.close().then(
              () => callback(error),
              () => callback(error),
            );
          },
        });
        const pair = await Promise.allSettled([
          createCanopyFramedConnection(serverWire, {
            role: 'server',
            auth: bound.auth,
            handshakeTimeoutMs: 500,
          }),
          createCanopyFramedConnection(clientWire, {
            role: 'client',
            auth: {
              secret: await readFile(bound.descriptor.tokenRef, 'utf8'),
              dataRootHash: mismatch ? 'f'.repeat(64) : bound.auth.dataRootHash,
            },
            handshakeTimeoutMs: 500,
          }),
        ]);
        expect(pair.map(({ status }) => status)).toEqual(
          mismatch ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
        );
        if (mismatch && pair[1].status === 'rejected')
          expect(pair[1].reason).toMatchObject({
            payload: { kind: 'failed_precondition' },
          });
        for (const result of pair)
          if (result.status === 'fulfilled') result.value.close();
        clientWire.destroy();
        serverWire.destroy();
      }
    } finally {
      await bound.close();
    }
  },
);

posix(
  'startup cleans discovery after a release mutates but reports uncertainty',
  async () => {
    const options = host();
    const release = options.claims.release.bind(options.claims);
    let uncertain = true;
    const claims = {
      ...options.claims,
      release: async (handle: object): ReturnType<typeof release> => {
        const result = await release(handle);
        if (uncertain) {
          uncertain = false;
          return 'ambiguous';
        }
        return result;
      },
    };
    await expect(publishCanopyDaemon({ ...options, claims })).rejects.toThrow(
      'release uncertain',
    );
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix(
  'shutdown removes the token before the descriptor that references it',
  async () => {
    const bound = await publishCanopyDaemon(host());
    const descriptorPath = join(dataRoot, 'runtime', 'core.json');
    // An unremovable descriptor stops shutdown between the two unlinks.
    await rm(descriptorPath);
    await mkdir(descriptorPath);
    await expect(bound.close()).rejects.toThrow();
    await expect(stat(bound.descriptor.tokenRef)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

posix.each([{ claim: 'unverifiable' }, { claim: 'successor' }])(
  'startup rollback removes its own token when the claim is $claim',
  async ({ claim }) => {
    const options = host();
    let successor: object | undefined;
    let uncertain = true;
    let unverifiable = false;
    const port = createCanopyStartupClaimPort({
      dataRoot,
      owner: { pid: process.pid, startIdentity: 'test-start' },
      inspectProcess: () =>
        Promise.resolve(
          unverifiable
            ? { kind: 'unknown' }
            : { kind: 'alive', startIdentity: 'test-start' },
        ),
    });
    const claims = {
      ...port,
      release: async (handle: object): ReturnType<typeof port.release> => {
        if (!uncertain) return port.release(handle);
        uncertain = false;
        if (claim === 'successor') {
          await port.release(handle);
          const next = await port.tryAcquire();
          if (next.kind === 'acquired') successor = next.handle;
        } else unverifiable = true;
        return 'ambiguous';
      },
    };
    await expect(publishCanopyDaemon({ ...options, claims })).rejects.toThrow(
      'rollback failed',
    );
    const runtime = join(dataRoot, 'runtime');
    expect(
      (await readdir(runtime)).filter((name) => /\.(token|tmp)$/.test(name)),
    ).toEqual([]);
    // Shared discovery stays until a claim holder removes it.
    expect(await readdir(runtime)).toContain('core.json');
    if (successor) await port.release(successor);
  },
);

posix(
  'shutdown retries a release whose mutation succeeded but receipt was uncertain',
  async () => {
    const options = host();
    const release = options.claims.release.bind(options.claims);
    let uncertain = false;
    const claims = {
      ...options.claims,
      release: async (handle: object): ReturnType<typeof release> => {
        const result = await release(handle);
        if (uncertain) {
          uncertain = false;
          return 'ambiguous';
        }
        return result;
      },
    };
    const bound = await publishCanopyDaemon({ ...options, claims });
    uncertain = true;
    await expect(bound.close()).rejects.toThrow('release uncertain');
    const next = await options.claims.tryAcquire();
    if (next.kind !== 'acquired') throw new Error('Claim was not released');
    try {
      await bound.close();
      expect(await options.claims.identity(next.handle)).not.toBeNull();
    } finally {
      await release(next.handle);
    }
  },
);

posix.each([
  { case: 'completed', closeFails: false },
  { case: 'incomplete', closeFails: true },
])(
  'shutdown retry keeps its claim when ownership is unverifiable after $case cleanup',
  async ({ closeFails }) => {
    const options = host();
    let unverifiable = false;
    let uncertain = false;
    const claims = {
      ...options.claims,
      // Unchanged claim record; only the receipt is lost.
      release: async (
        handle: object,
      ): ReturnType<typeof options.claims.release> => {
        if (!uncertain) return options.claims.release(handle);
        uncertain = false;
        return 'ambiguous';
      },
      // Owner inspection unknown: identity is null while the record is still ours.
      identity: async (
        handle: object,
      ): ReturnType<typeof options.claims.identity> =>
        unverifiable ? null : options.claims.identity(handle),
    };
    const bound = await publishCanopyDaemon({ ...options, claims });
    const closeListener = bound.listener.close.bind(bound.listener);
    let failClose = closeFails;
    bound.listener.close = async (): Promise<void> => {
      if (failClose) {
        failClose = false;
        throw new Error('close failed');
      }
      await closeListener();
    };
    uncertain = true;
    await expect(bound.close()).rejects.toThrow('release uncertain');
    unverifiable = true;
    if (closeFails)
      await expect(bound.close()).rejects.toThrow('Startup claim unavailable');
    else await bound.close();
    unverifiable = false;
    await bound.close();
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
    const next = await options.claims.tryAcquire();
    if (next.kind !== 'acquired') throw new Error('Claim was abandoned');
    await options.claims.release(next.handle);
  },
);

posix(
  'shutdown retry never cleans up under a successor claim after an uncertain release',
  async () => {
    const options = host();
    const release = options.claims.release.bind(options.claims);
    let uncertain = false;
    const claims = {
      ...options.claims,
      release: async (handle: object): ReturnType<typeof release> => {
        const result = await release(handle);
        if (uncertain) {
          uncertain = false;
          return 'ambiguous';
        }
        return result;
      },
    };
    const bound = await publishCanopyDaemon({ ...options, claims });
    const closeListener = bound.listener.close.bind(bound.listener);
    let closeFails = true;
    bound.listener.close = async (): Promise<void> => {
      if (closeFails) {
        closeFails = false;
        throw new Error('close failed');
      }
      await closeListener();
    };
    uncertain = true;
    await expect(bound.close()).rejects.toThrow('release uncertain');
    const successor = await options.claims.tryAcquire();
    if (successor.kind !== 'acquired')
      throw new Error('Claim was not released');
    const runtime = join(dataRoot, 'runtime');
    const published = (await readdir(runtime)).sort();
    try {
      await expect(bound.close()).rejects.toThrow('Startup claim unavailable');
      expect((await readdir(runtime)).sort()).toEqual(published);
    } finally {
      await release(successor.handle);
    }
    await bound.close();
    expect(await readdir(runtime)).toEqual([]);
  },
);

posix(
  'uncertain rename receipt removes only the published descriptor after close',
  async () => {
    const options = host();
    const rename = options.platform.secureFiles.rename.bind(
      options.platform.secureFiles,
    );
    const platform = {
      ...options.platform,
      secureFiles: {
        ...options.platform.secureFiles,
        rename: async (
          request: Parameters<typeof rename>[0],
        ): Promise<PlatformRenameResult> => {
          await rename(request);
          return { kind: 'renamed', sourceState: 'unknown' };
        },
      },
    };
    await expect(publishCanopyDaemon({ ...options, platform })).rejects.toThrow(
      'publication uncertain',
    );
    await expect(
      stat(join(dataRoot, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix(
  'adopts the launcher claim and releases the same token after publication',
  async () => {
    await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
    const options = host();
    const launcher = createCanopyStartupClaimPort({
      dataRoot,
      owner: { pid: process.pid, startIdentity: 'launcher' },
      inspectProcess: () =>
        Promise.resolve({ kind: 'alive', startIdentity: 'launcher' }),
    });
    const acquired = await launcher.tryAcquire();
    if (acquired.kind !== 'acquired') throw new Error('No launcher claim');
    const bound = await publishCanopyDaemon({
      ...options,
      claimHandle: acquired.handle,
    });
    expect(await launcher.release(acquired.handle)).toBe('not_owner');
    await bound.close();
  },
);

/** The caller's own claim, acquired before publishing (W5b Q8(a)). */
async function heldClaim(
  options: ReturnType<typeof host>,
): Promise<CanopyDaemonHeldClaim> {
  await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
  const acquired = await options.claims.tryAcquire();
  if (acquired.kind !== 'acquired') throw new Error(acquired.kind);
  return { current: acquired.handle, released: false };
}

/** Another starter's view of the claim; releases it again when it got it. */
async function contend(): Promise<string> {
  const contender = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: 'contender' },
    inspectProcess: () =>
      Promise.resolve({ kind: 'alive', startIdentity: 'test-start' }),
  });
  const result = await contender.tryAcquire();
  if (result.kind === 'acquired') await contender.release(result.handle);
  return result.kind;
}

posix(
  'publishes under a held claim and releases it only once published',
  async () => {
    const options = host();
    const held = await heldClaim(options);
    const tryAcquire = jest.spyOn(options.claims, 'tryAcquire');
    const bound = await publishCanopyDaemon({ ...options, heldClaim: held });
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(held.released).toBe(true);
    expect(await options.claims.identity(held.current)).toBeNull();
    expect(await contend()).toBe('acquired');
    await bound.close();
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix(
  'a failed publication keeps a held claim for its caller to release',
  async () => {
    const options = host();
    const held = await heldClaim(options);
    const handle = held.current;
    const platform = {
      ...options.platform,
      secureFiles: {
        ...options.platform.secureFiles,
        rename: (): Promise<PlatformRenameResult> =>
          Promise.reject(new Error('rename failed')),
      },
    };
    await expect(
      publishCanopyDaemon({ ...options, platform, heldClaim: held }),
    ).rejects.toThrow('rename failed');
    expect(held).toEqual({ current: handle, released: false });
    expect(await options.claims.identity(handle)).not.toBeNull();
    expect(await contend()).toBe('held');
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([
      'startup-claim.json',
    ]);
    expect(await options.claims.release(handle)).toBe('released');
  },
);

posix(
  'a held claim follows the reclaim after a release whose receipt was lost',
  async () => {
    const options = host();
    const held = await heldClaim(options);
    const original = held.current;
    let lost = true;
    const claims = {
      ...options.claims,
      release: async (
        handle: object,
      ): ReturnType<CanopyStartupClaimPort['release']> => {
        const result = await options.claims.release(handle);
        if (!lost) return result;
        lost = false;
        throw new Error('receipt lost');
      },
    };
    await expect(
      publishCanopyDaemon({ ...options, claims, heldClaim: held }),
    ).rejects.toThrow('receipt lost');
    expect(held.released).toBe(false);
    expect(held.current).not.toBe(original);
    expect(await options.claims.identity(original)).toBeNull();
    expect(await options.claims.identity(held.current)).not.toBeNull();
    expect(await contend()).toBe('held');
    await expect(
      stat(join(dataRoot, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await options.claims.release(held.current)).toBe('released');
  },
);

posix(
  'refuses a held claim beside a launcher handle or once released',
  async () => {
    const options = host();
    const held = await heldClaim(options);
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong endpoint family');
    const bind = jest.fn(endpoints.bind.bind(endpoints));
    const platform = {
      ...options.platform,
      endpoints: { ...endpoints, bind },
    };
    await expect(
      publishCanopyDaemon({
        ...options,
        platform,
        heldClaim: held,
        claimHandle: {},
      }),
    ).rejects.toThrow('exclusive');
    await expect(
      publishCanopyDaemon({
        ...options,
        platform,
        heldClaim: { ...held, released: true },
      }),
    ).rejects.toThrow('Startup claim unavailable.');
    expect(bind).not.toHaveBeenCalled();
    expect(await options.claims.release(held.current)).toBe('released');
  },
);

posix(
  'foreign adoption fails closed without a fallback acquisition or bind',
  async () => {
    const options = host();
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong endpoint family');
    const bind = jest.fn(endpoints.bind.bind(endpoints));
    const tryAcquire = jest.fn(options.claims.tryAcquire);
    const claims = { ...options.claims, tryAcquire };
    const platform = {
      ...options.platform,
      endpoints: { ...endpoints, bind },
    };
    await expect(
      publishCanopyDaemon({ ...options, claims, platform, claimHandle: {} }),
    ).rejects.toThrow('claim unavailable');
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix(
  'concurrent shutdown callers share endpoint close and publication cleanup',
  async () => {
    const bound = await publishCanopyDaemon(host());
    const close = jest.spyOn(bound.listener, 'close');
    await Promise.all([bound.close(), bound.close(), bound.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix.each(['relative data root', 'unsupported runtime mode'] as const)(
  'rejects missing explicit canonical launch configuration: %s',
  async (fixture) => {
    const options: CanopyDaemonPublicationOptions = { ...host() };
    // Install intentionally invalid runtime input that the public type keeps
    // callers from constructing, and assert validation at the API boundary.
    Object.defineProperty(
      options,
      fixture === 'relative data root' ? 'dataRoot' : 'runtimeMode',
      {
        value: fixture === 'relative data root' ? 'relative' : 'test',
      },
    );
    await expect(publishCanopyDaemon(options)).rejects.toThrow(
      'Explicit canonical',
    );
  },
);

function windowsHost(
  close: () => Promise<void> = jest.fn(() => Promise.resolve()),
): CanopyDaemonPublicationOptions {
  const options = host();
  const address: PlatformNamedPipeAddress = {
    kind: 'named-pipe',
    path: '\\\\.\\pipe\\c5-test',
  };
  const listener: PlatformEndpointListener<PlatformNamedPipeAddress> = {
    address,
    async *connections() {},
    close,
  };
  const endpoints: PlatformPipeEndpointServices = {
    semantics: 'first-instance-pipe',
    address: () => address,
    probe: () => Promise.resolve({ state: 'absent' }),
    bind: () => Promise.resolve({ kind: 'bound', listener }),
  };
  return {
    ...options,
    platform: {
      ...options.platform,
      endpoints,
      secureFiles: {
        ...options.platform.secureFiles,
        permissionModel: 'windows-dacl',
        permissions: () => Promise.resolve({ state: 'private' }),
        syncDirectory: () => Promise.resolve('unsupported'),
      },
    },
  };
}

test('Windows publication trusts the injected file verifier and records a pipe endpoint', async () => {
  const options = windowsHost();
  const bound = await publishCanopyDaemon(options);
  expect(bound.descriptor.endpoint).toEqual({
    kind: 'pipe',
    path: '\\\\.\\pipe\\c5-test',
  });
  expect(bound.descriptor.socketIdentity).toBeUndefined();
  await bound.close();
  expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
});

test('Windows unverified token ACL fails before secret bytes are written', async () => {
  const options = windowsHost();
  const permissions = options.platform.secureFiles.permissions.bind(
    options.platform.secureFiles,
  );
  const checked: string[] = [];
  const platform = {
    ...options.platform,
    secureFiles: {
      ...options.platform.secureFiles,
      permissions: async (
        request: Parameters<typeof permissions>[0],
      ): Promise<PlatformPermissionResult> => {
        if (request.kind !== 'file') return permissions(request);
        checked.push(await readFile(request.path, 'utf8'));
        return { state: 'unverifiable', reason: 'DACL unavailable' };
      },
    },
  };
  await expect(publishCanopyDaemon({ ...options, platform })).rejects.toThrow(
    'not private',
  );
  expect(checked).toEqual(['']);
  expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
});

posix(
  'startup rollback releases its claim even when directory sync fails',
  async () => {
    const options = host();
    const platform = {
      ...options.platform,
      secureFiles: {
        ...options.platform.secureFiles,
        syncDirectory: (): Promise<never> =>
          Promise.reject(new Error('sync failed')),
      },
    };
    await expect(
      publishCanopyDaemon({ ...options, platform }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'sync failed' }),
        expect.objectContaining({ message: 'sync failed' }),
      ],
    });
    const next = await options.claims.tryAcquire();
    try {
      expect(next.kind).toBe('acquired');
    } finally {
      if (next.kind === 'acquired') await options.claims.release(next.handle);
    }
  },
);

test('Windows rejects a launcher claim before acquiring or binding', async () => {
  const options = windowsHost();
  const tryAcquire = jest.spyOn(options.claims, 'tryAcquire');
  const bind = jest.spyOn(options.platform.endpoints, 'bind');
  await expect(
    publishCanopyDaemon({ ...options, claimHandle: {} }),
  ).rejects.toThrow('Windows launcher claim unsupported');
  expect(tryAcquire).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});

// The daemon's W5 host start holds its own claim on every OS (CAN-5530).
test('Windows publishes under a held claim and releases it once published', async () => {
  const options = windowsHost();
  await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
  const acquired = await options.claims.tryAcquire();
  if (acquired.kind !== 'acquired') throw new Error(acquired.kind);
  const held: CanopyDaemonHeldClaim = {
    current: acquired.handle,
    released: false,
  };
  const tryAcquire = jest.spyOn(options.claims, 'tryAcquire');
  const bound = await publishCanopyDaemon({ ...options, heldClaim: held });
  expect(bound.descriptor.endpoint.kind).toBe('pipe');
  expect(tryAcquire).not.toHaveBeenCalled();
  expect(held.released).toBe(true);
  expect(await options.claims.identity(held.current)).toBeNull();
  expect(await contend()).toBe('acquired');
  await bound.close();
  expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
});

test('startup releases the claim when close fails and retains publication proof', async () => {
  const closeError = new Error('close failed');
  const startupError = new Error('rename failed');
  const options = windowsHost(() => Promise.reject(closeError));
  const rename = options.platform.secureFiles.rename.bind(
    options.platform.secureFiles,
  );
  options.platform.secureFiles.rename = async (request): Promise<never> => {
    await rename(request);
    throw startupError;
  };
  const failed = await publishCanopyDaemon(options).catch(
    (error: unknown) => error,
  );
  expect(
    await readFile(join(dataRoot, 'runtime', 'core.json'), 'utf8'),
  ).toBeTruthy();
  expect(await readdir(join(dataRoot, 'runtime'))).toHaveLength(2);
  const next = await options.claims.tryAcquire();
  try {
    expect(next.kind).toBe('acquired');
    expect(failed).toMatchObject({ errors: [startupError, closeError] });
  } finally {
    if (next.kind === 'acquired') await options.claims.release(next.handle);
  }
});

test('startup removes unpublished artifacts when close fails before publication', async () => {
  const closeError = new Error('close failed');
  const options = windowsHost(() => Promise.reject(closeError));
  const permissions = options.platform.secureFiles.permissions.bind(
    options.platform.secureFiles,
  );
  options.platform.secureFiles.permissions = (
    request,
  ): Promise<PlatformPermissionResult> =>
    request.kind === 'file' && request.path.endsWith('.tmp')
      ? Promise.resolve({ state: 'unverifiable', reason: 'DACL unavailable' })
      : permissions(request);
  const failed = await publishCanopyDaemon(options).catch(
    (error: unknown) => error,
  );
  expect(failed).toMatchObject({
    errors: [
      expect.objectContaining({
        message: 'Runtime permissions are not private.',
      }),
      closeError,
    ],
  });
  expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  const next = await options.claims.tryAcquire();
  try {
    expect(next.kind).toBe('acquired');
  } finally {
    if (next.kind === 'acquired') await options.claims.release(next.handle);
  }
});

posix.each(['.token', '.tmp'])(
  'startup reports %s unlink failure, cleans the other file and releases its claim',
  async (suffix) => {
    const options = host();
    const startupError = new Error('rename failed');
    let failedName = '';
    const rename = async (): Promise<never> => {
      const directory = join(dataRoot, 'runtime');
      const filename = (await readdir(directory)).find((name) =>
        name.endsWith(suffix),
      );
      if (!filename) throw new Error('Missing publication artifact');
      failedName = filename;
      const path = join(directory, filename);
      await unlink(path);
      await mkdir(path);
      throw startupError;
    };
    const platform = {
      ...options.platform,
      secureFiles: { ...options.platform.secureFiles, rename },
    };
    const failed = await publishCanopyDaemon({ ...options, platform }).catch(
      (error: unknown) => error,
    );
    expect(failed).toMatchObject({
      errors: [
        startupError,
        expect.objectContaining({
          path: join(dataRoot, 'runtime', failedName),
        }),
      ],
    });
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([failedName]);
    const next = await options.claims.tryAcquire();
    try {
      expect(next.kind).toBe('acquired');
    } finally {
      if (next.kind === 'acquired') await options.claims.release(next.handle);
    }
  },
);
