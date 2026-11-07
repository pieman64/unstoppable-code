import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PlatformProcessInspection,
  PlatformSecureFileServices,
} from '@canopy/core-runtime';
import * as catalog from '../secret-protection/catalog';
import {
  createNativeArtifactAuthorizer,
  nativeArtifactSnapshotRoot,
  type NativeArtifactAuthorizer,
  type PreparedNativeArtifact,
  loadPreparedNativeArtifact,
} from '../secret-protection/authorization';
import { createSecretProtectionServices } from '../secret-protection';
import { createHostTrustGeneration } from '../prepared-trust';

const intended = Buffer.from('product-native-final-signed-bytes');
let directory = '';
let distribution = '';
let data = '';
let owner: PlatformProcessInspection;
let authorizers: NativeArtifactAuthorizer[];
let onObservation: (() => void) | undefined;
let onPermission: ((path: string) => void) | undefined;
const call = (): { signal: AbortSignal } => ({
  signal: new AbortController().signal,
});
function expected(): catalog.NativeArtifactCatalog {
  return {
    schema: 1,
    generation: randomUUID(),
    brandId: 'canopy',
    build: 'dev',
    version: '1',
    buildId: '',
    member: {
      id: 'vault-key-slots',
      filename: catalog.NATIVE_VAULT_FILE,
      platform:
        process.platform === 'darwin'
          ? 'darwin'
          : process.platform === 'win32'
            ? 'win32'
            : 'linux',
      architectures:
        process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch],
      compatibility: 'node-api-8-product-v1',
      dependencyPolicy:
        catalog.NATIVE_DEPENDENCY_POLICIES[
          process.platform === 'darwin'
            ? 'darwin'
            : process.platform === 'win32'
              ? 'win32'
              : 'linux'
        ],
      state: 'present',
      byteLength: intended.length,
      sha256: createHash('sha256').update(intended).digest('hex'),
    },
  };
}
function make(): NativeArtifactAuthorizer {
  const permissions: PlatformSecureFileServices['permissions'] = ({
    path,
    kind,
  }) => {
    onPermission?.(path);
    const stat = lstatSync(path);
    return Promise.resolve(
      !stat.isSymbolicLink() &&
        (kind === 'directory' ? stat.isDirectory() : stat.isFile())
        ? { state: 'private' }
        : { state: 'insecure', reason: 'redirected' },
    );
  };
  const authorizer = createNativeArtifactAuthorizer({
    canonicalDataRoot: data,
    distributionDirectory: distribution,
    supervision: {
      inspectProcess: () => {
        onObservation?.();
        return Promise.resolve(owner);
      },
    },
    secureFiles: { permissions },
  });
  authorizers.push(authorizer);
  return authorizer;
}
function port(
  preparedNative: PreparedNativeArtifact | undefined,
): ReturnType<typeof createSecretProtectionServices> {
  return createSecretProtectionServices({
    os: process.platform,
    preparedNative,
    brandId: 'canopy',
    build: 'dev',
    authorityId: 'a'.repeat(64),
    windowsPrincipalSid: 'S-1-5-21-123',
  });
}
function snapshot(): string {
  const root = nativeArtifactSnapshotRoot(data);
  const name = readdirSync(root).find((name) =>
    existsSync(join(root, name, catalog.NATIVE_VAULT_FILE)),
  );
  if (!name) throw new Error('No snapshot');
  return join(root, name, catalog.NATIVE_VAULT_FILE);
}
beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'native-authorization-')),
  );
  distribution = join(directory, 'distribution');
  data = join(directory, 'application-data');
  mkdirSync(distribution, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(distribution, catalog.NATIVE_VAULT_FILE), intended);
  owner = {
    state: 'running',
    startIdentity: `qualified-process:${process.pid}:instance`,
  };
  authorizers = [];
  onPermission = undefined;
  onObservation = undefined;
  jest
    .spyOn(catalog, 'compiledNativeArtifactCatalog')
    .mockReturnValue(expected());
});
afterEach(async () => {
  await Promise.all(authorizers.map((authorizer) => authorizer.dispose()));
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function native(): jest.SpyInstance {
  return jest.spyOn(process, 'dlopen').mockImplementation((module, path) => {
    expect(readFileSync(path.toString())).toEqual(intended);
    const abi =
      process.platform === 'win32'
        ? 'windows-credential-v1'
        : 'linux-secret-service-v1';
    Object.defineProperty(module, 'exports', {
      value: {
        fixture: false,
        abi,
        run: (): Promise<unknown> => Promise.resolve({ code: 'ok' }),
      },
    });
  });
}

test.each([
  'missing',
  'empty',
  'truncated',
  'wrong',
  'fixture-substitution',
  'symlink',
  'hardlink',
  'directory',
  'forged-receipt',
])('%s cannot authorize native entry', async (failure) => {
  const path = join(distribution, catalog.NATIVE_VAULT_FILE);
  if (['missing', 'symlink', 'directory'].includes(failure)) rmSync(path);
  if (failure === 'empty') writeFileSync(path, Buffer.alloc(0));
  if (failure === 'truncated') writeFileSync(path, intended.subarray(0, -1));
  if (
    failure === 'wrong' ||
    failure === 'fixture-substitution' ||
    failure === 'forged-receipt'
  )
    writeFileSync(path, Buffer.alloc(intended.length, 1));
  if (failure === 'symlink') {
    writeFileSync(join(directory, 'other'), intended);
    symlinkSync(join(directory, 'other'), path);
  }
  if (failure === 'hardlink') linkSync(path, join(directory, 'other'));
  if (failure === 'directory') mkdirSync(path);
  if (failure === 'forged-receipt')
    writeFileSync(
      `${path}.payload.json`,
      JSON.stringify({
        schema: 1,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }),
    );
  const load = native();
  expect(await make().prepare()).toBeUndefined();
  expect((await port(undefined).status(call())).state).toBe('unavailable');
  expect(load).not.toHaveBeenCalled();
});

test('source replacement during preparation cannot change the captured authorized bytes', async () => {
  let replaced = false;
  onPermission = (): void => {
    if (replaced) return;
    replaced = true;
    writeFileSync(
      join(distribution, catalog.NATIVE_VAULT_FILE),
      Buffer.alloc(intended.length, 9),
    );
  };
  const load = native();
  const authorizer = make();
  const capability = await authorizer.prepare();
  expect(capability).toBeDefined();
  expect((await port(capability).status(call())).state).toBe('available');
  expect(load).toHaveBeenCalledTimes(1);
  expect(await authorizer.prepare()).toBe(capability);
  expect(readFileSync(snapshot())).toEqual(intended);
});

test.each(['bytes', 'inode', 'symlink'])(
  'snapshot %s replacement before load refuses',
  async (replacement) => {
    const load = native();
    const capability = await make().prepare();
    const path = snapshot();
    if (replacement === 'bytes') {
      chmodSync(path, 0o600);
      writeFileSync(path, Buffer.alloc(intended.length, 7));
    } else {
      renameSync(path, join(directory, 'old'));
      if (replacement === 'inode')
        writeFileSync(path, intended, { mode: 0o600 });
      else symlinkSync(join(directory, 'old'), path);
    }
    expect((await port(capability).status(call())).state).toBe('unavailable');
    expect(load).not.toHaveBeenCalled();
  },
);

test('opaque scoped membership rejects forgeries, clones, serialization and other evidence scopes', async () => {
  const load = native();
  const capability = await make().prepare();
  for (const candidate of [
    { scope: 'native-preparation' },
    { ...capability },
    structuredClone(capability),
    JSON.parse(JSON.stringify(capability)),
    createHostTrustGeneration('package-admission').issue(),
    createHostTrustGeneration('native-preparation').issue(),
  ]) {
    expect(loadPreparedNativeArtifact(candidate)).toBeUndefined();
  }
  expect(load).not.toHaveBeenCalled();
  expect((await port(capability).status(call())).state).toBe('available');
  expect(load).toHaveBeenCalledTimes(1);
});

test('invalidation revokes both existing wrappers and pending preparation without reload', async () => {
  const load = native();
  const authorizer = make();
  const capability = await authorizer.prepare();
  const services = port(capability);
  expect((await services.status(call())).state).toBe('available');
  authorizer.invalidate();
  expect((await services.status(call())).state).toBe('unavailable');
  expect((await port(capability).status(call())).state).toBe('unavailable');
  expect(await authorizer.prepare()).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
  jest
    .mocked(catalog.compiledNativeArtifactCatalog)
    .mockReturnValue(expected());
  const root = nativeArtifactSnapshotRoot(data);
  const existing = readdirSync(root);
  const pending = make();
  const permission = jest.fn((): void => pending.invalidate());
  onPermission = permission;
  expect(await pending.prepare()).toBeUndefined();
  expect(permission).toHaveBeenCalled();
  expect(readdirSync(root)).toEqual(existing);
  expect(load).toHaveBeenCalledTimes(1);
});

test('development absence is compiled and creates no native storage', async () => {
  const value = expected();
  jest.mocked(catalog.compiledNativeArtifactCatalog).mockReturnValue({
    ...value,
    member: {
      ...value.member,
      state: 'absent',
      reason: 'development-toolchain-unavailable',
    },
  });
  const load = native();
  expect(await make().prepare()).toBeUndefined();
  expect(existsSync(nativeArtifactSnapshotRoot(data))).toBe(false);
  expect((await port(undefined).status(call())).state).toBe('unavailable');
  expect(load).not.toHaveBeenCalled();
});

test('snapshot ownership is outside runtime; mapped images defer cleanup until a dead owner is proven', async () => {
  const authorizer = make();
  const load = native();
  const capability = await authorizer.prepare();
  const path = snapshot();
  const ownerRecord: unknown = JSON.parse(
    readFileSync(join(path, '..', 'owner.json'), 'utf8'),
  );
  expect(ownerRecord).toHaveProperty('pid', process.pid);
  expect(ownerRecord).toHaveProperty(
    'startIdentity',
    expect.stringContaining('instance'),
  );
  expect(path).not.toContain(`${join(data, 'runtime')}/`);
  expect((await port(capability).status(call())).state).toBe('available');
  await authorizer.dispose();
  expect(existsSync(path)).toBe(true);
  const reaper = make();
  await reaper.reap();
  expect(existsSync(path)).toBe(true);
  owner = { state: 'unverifiable', reason: 'cannot observe' };
  await reaper.reap();
  expect(existsSync(path)).toBe(true);
  owner = { state: 'running', startIdentity: 'different-process-instance' };
  await reaper.reap();
  expect(existsSync(path)).toBe(true);
  owner = { state: 'absent' };
  const unknown = join(nativeArtifactSnapshotRoot(data), 'unknown');
  mkdirSync(unknown);
  writeFileSync(join(unknown, 'keep'), 'unknown');
  await reaper.reap();
  expect(existsSync(path)).toBe(false);
  expect(existsSync(unknown)).toBe(true);
  expect(load).toHaveBeenCalledTimes(1);
});

test('an unconsumed snapshot is cleaned without touching unrelated files', async () => {
  const authorizer = make();
  await authorizer.prepare();
  const path = snapshot();
  await authorizer.dispose();
  expect(existsSync(path)).toBe(false);
});

test('another authorizer cannot reopen or replace this run binding', async () => {
  const load = native();
  const authorizer = make();
  const capability = await authorizer.prepare();
  expect((await port(capability).status(call())).state).toBe('available');
  expect(await make().prepare()).toBeUndefined();
  authorizer.invalidate();
  expect(await make().prepare()).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
});

test('storage redirection during process observation refuses before writing a snapshot', async () => {
  const redirected = join(directory, 'redirected');
  mkdirSync(redirected, { mode: 0o700 });
  const root = nativeArtifactSnapshotRoot(data);
  onObservation = (): void => {
    renameSync(root, join(directory, 'prior-root'));
    symlinkSync(redirected, root, 'dir');
  };
  const load = native();
  expect(await make().prepare()).toBeUndefined();
  expect(readdirSync(redirected)).toEqual([]);
  expect(load).not.toHaveBeenCalled();
});

test('a missing compiled anchor never consults receipts or creates snapshot storage', async () => {
  jest.mocked(catalog.compiledNativeArtifactCatalog).mockReturnValue(undefined);
  const load = native();
  expect(await make().prepare()).toBeUndefined();
  expect(existsSync(nativeArtifactSnapshotRoot(data))).toBe(false);
  expect(load).not.toHaveBeenCalled();
});

test.each(['extra-member', 'unknown-owner-schema'])(
  'cleanup retains an owned candidate changed to %s',
  async (change) => {
    const authorizer = make();
    await authorizer.prepare();
    const path = snapshot();
    if (change === 'extra-member')
      writeFileSync(join(path, '..', 'unknown'), 'retain');
    else {
      const ownerFile = join(path, '..', 'owner.json');
      const value: unknown = JSON.parse(readFileSync(ownerFile, 'utf8'));
      if (typeof value !== 'object' || value === null)
        throw new Error('Missing snapshot owner record');
      writeFileSync(ownerFile, JSON.stringify({ ...value, schema: 2 }));
    }
    await authorizer.dispose();
    expect(existsSync(path)).toBe(true);
    owner = { state: 'absent' };
    await make().reap();
    expect(existsSync(path)).toBe(true);
  },
);

test('native entry failure remains unavailable without retrying through a wrapper or another snapshot', async () => {
  const authorizer = make();
  const capability = await authorizer.prepare();
  const load = jest.spyOn(process, 'dlopen').mockImplementation(() => {
    throw new Error('native load failed');
  });
  expect((await port(capability).status(call())).state).toBe('unavailable');
  expect((await port(capability).status(call())).state).toBe('unavailable');
  expect(await make().prepare()).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
});

test('snapshot inode replacement during permission verification refuses preparation', async () => {
  const load = native();
  let replaced = false;
  onPermission = (path: string): void => {
    if (replaced || !path.endsWith(catalog.NATIVE_VAULT_FILE)) return;
    replaced = true;
    renameSync(path, join(directory, 'original-snapshot'));
    writeFileSync(path, intended, { mode: 0o600 });
  };
  expect(await make().prepare()).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});

test('owner record replacement before native entry refuses loading', async () => {
  const load = native();
  const capability = await make().prepare();
  const path = join(snapshot(), '..', 'owner.json');
  writeFileSync(path, '{}');
  expect((await port(capability).status(call())).state).toBe('unavailable');
  expect(load).not.toHaveBeenCalled();
});
