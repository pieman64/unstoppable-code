/** Actual getEnhancedEnv + both encrypted injectors + policy + native DBus probe. */
jest.unmock('../lib/linux-secret-service');
import type * as Fs from 'node:fs';
import type * as ConfigPaths from '../pipelines/config-paths';
import type * as StoragePolicy from '../lib/secure-storage-policy';

let mockState: 'secure' | 'locked' | 'unavailable' = 'secure';
let mockTime = 0;
let mockPatValue = 'fixture-pat';
let mockEnvironmentValue = 'fixture-value';
let mockTrailingCiphertext: string | null = null;
const mockExecFileSync = jest.fn(
  (file: string, args: readonly string[]): string => {
    if (file !== '/usr/bin/gdbus') throw new Error('Unexpected executable');
    if (mockState === 'unavailable') throw new Error('NameHasNoOwner');
    if (args.includes('org.freedesktop.DBus.GetNameOwner')) return "(':1.42',)";
    if (args.includes('org.freedesktop.Secret.Service.ReadAlias'))
      return "(objectpath '/org/freedesktop/secrets/collection/login',)";
    if (args.includes('org.freedesktop.DBus.Properties.Get'))
      return mockState === 'locked' ? '(<true>,)' : '(<false>,)';
    throw new Error('Unexpected DBus operation');
  },
);
jest.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  execFile: jest.fn(),
}));
const mockDecrypt = jest.fn((bytes: Buffer): string => bytes.toString('utf8'));
const mockEncrypt = jest.fn((text: string): Buffer => Buffer.from(text));
const mockAvailable = jest.fn((): boolean => true);
const mockRecoveryProbe = jest.fn((): boolean => false);
jest.mock('../lib/linux-safe-storage-recovery', () => ({
  probeLinuxSafeStorageRecovery: (): boolean => mockRecoveryProbe(),
  encryptWithLinuxSafeStorageRecovery: (text: string): Buffer =>
    mockEncrypt(text),
  decryptWithLinuxSafeStorageRecovery: (bytes: Buffer): string =>
    mockDecrypt(bytes),
}));
let mockStorage = {
  isEncryptionAvailable: mockAvailable,
  encryptString: mockEncrypt,
  decryptString: mockDecrypt,
  getSelectedStorageBackend: (): string => 'gnome_libsecret',
};
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  get safeStorage(): typeof mockStorage {
    return mockStorage;
  },
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getGitHubPatFilePath: (): string => '/fixture/pat',
  getLegacyGitHubPatFilePath: (): string => '/fixture/legacy-pat',
}));
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  ...jest.requireActual<object>('@canopy/desktop-shared/canopy-paths'),
  getEnvironmentConfigFilePath: (): string => '/fixture/environment',
  getInternalLegacySharedEnvironmentConfigFilePath: (): null => null,
  getLegacyEnvironmentConfigFilePath: (): string =>
    '/fixture/legacy-environment',
  getUserEnvironmentFilePath: (): string => '/fixture/user-environment',
}));
jest.mock('../lib/github-auth', () => ({
  loadStoredPat: (): Promise<string> => Promise.resolve(''),
}));
jest.mock('../lib/user-environment-store', () => ({
  readEnvironmentConfig: (): Promise<never> =>
    Promise.reject(new Error('Skip preload')),
}));
const mockReadFileSync = jest.fn(
  (path: Fs.PathOrFileDescriptor): Buffer | string => {
    if (path === '/fixture/pat') return Buffer.from(mockPatValue);
    if (path === '/fixture/environment')
      return JSON.stringify({
        version: 2,
        data: {
          environments: [
            {
              id: 'default-overall',
              name: 'Overall',
              parentId: null,
              isDefault: true,
              defaultKind: 'overall',
              uiMode: 'key-value',
              encryptedVariables: Buffer.from(
                JSON.stringify([
                  {
                    key: 'SPAWN_SECRET',
                    value: mockEnvironmentValue,
                    secret: true,
                  },
                ]),
              ).toString('base64'),
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            ...(mockTrailingCiphertext === null
              ? []
              : [
                  {
                    id: 'trailing-environment',
                    name: 'Trailing',
                    parentId: null,
                    isDefault: false,
                    uiMode: 'key-value',
                    encryptedVariables: Buffer.from(
                      mockTrailingCiphertext,
                    ).toString('base64'),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                ]),
          ],
          globalRuntimes: {
            canopy: 'default-overall',
            agent: 'default-overall',
            pipeline: 'default-overall',
          },
          workspaceAssignments: [],
        },
      });
    throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
  },
);
jest.mock('node:fs', () => ({
  ...jest.requireActual<object>('node:fs'),
  readFileSync: mockReadFileSync,
  statSync: jest.fn(() => ({ mtimeMs: 1 })),
}));

async function setup(): Promise<{
  env: typeof ConfigPaths.getEnhancedEnv;
  policy: typeof StoragePolicy.getSecretStoragePolicy;
}> {
  const { initializeGitHubPatEnvRuntime } =
    await import('../lib/github-pat-env');
  const { initializeUserEnvironmentRuntime } =
    await import('../lib/user-environment-runtime');
  const { getEnhancedEnv } = await import('../pipelines/config-paths');
  const { getSecretStoragePolicy } =
    await import('../lib/secure-storage-policy');
  initializeGitHubPatEnvRuntime();
  initializeUserEnvironmentRuntime();
  await Promise.resolve();
  await Promise.resolve();
  return { env: getEnhancedEnv, policy: getSecretStoragePolicy };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockTime = 0;
  mockPatValue = 'fixture-pat';
  mockEnvironmentValue = 'fixture-value';
  mockTrailingCiphertext = null;
  mockState = 'secure';
  mockAvailable.mockImplementation((): boolean => true);
  mockRecoveryProbe.mockReturnValue(false);
  mockDecrypt.mockImplementation((bytes: Buffer): string =>
    bytes.toString('utf8'),
  );
  mockStorage = { ...mockStorage };
  jest.spyOn(performance, 'now').mockImplementation(() => mockTime);
});
afterEach(() => jest.restoreAllMocks());

function expectSecrets(env: Record<string, string | undefined>): void {
  expect(env.GH_TOKEN).toBe('fixture-pat');
  expect(env.SPAWN_SECRET).toBe('fixture-value');
}

test('both encrypted injectors share at most three gdbus calls per one-second spawn window', async () => {
  const { env } = await setup();
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 25; i += 1) expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  mockTime = 999;
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  mockTime = 1000;
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(6);
});

test('live status and write bypass spawn observations, update denial, and retry restored service immediately', async () => {
  const { env, policy } = await setup();
  expectSecrets(env());
  mockState = 'locked';
  expect(policy().getStatus().state).toBe('locked');
  const afterStatus = mockExecFileSync.mock.calls.length;
  expect(env()).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
  expect(env()).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
  expect(mockExecFileSync).toHaveBeenCalledTimes(afterStatus);
  expect(() => policy().encrypt('must-not-reach-native')).toThrow();
  expect(mockExecFileSync.mock.calls.length).toBe(afterStatus + 3);
  expect(mockEncrypt).not.toHaveBeenCalled();
  mockState = 'secure';
  expect(policy().encrypt('retry')).toEqual(Buffer.from('retry'));
  expectSecrets(env());
  mockState = 'unavailable';
  expect(policy().getStatus().state).toBe('unavailable');
  mockState = 'secure';
  expect(policy().getStatus().state).toBe('secure');
  const restored = mockExecFileSync.mock.calls.length;
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(restored);
});

test('stale positive observations cannot initialize a replacement native facade', async () => {
  const { env } = await setup();
  expectSecrets(env());
  const initialized = mockAvailable.mock.calls.length;
  mockStorage = { ...mockStorage };
  mockState = 'locked';
  expect(env()).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
  expect(env()).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
  expect(mockAvailable).toHaveBeenCalledTimes(initialized);
  expect(mockExecFileSync).toHaveBeenCalledTimes(6);
});

test('expired spawn observations detect a lock and bound failed spawn bursts until refreshed', async () => {
  const { env } = await setup();
  expectSecrets(env());
  mockState = 'locked';
  mockTime = 1000;
  for (let i = 0; i < 25; i += 1) {
    const result = env();
    expect(result).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
    expect(result).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
  }
  expect(mockExecFileSync).toHaveBeenCalledTimes(6);
  mockState = 'secure';
  mockTime = 2000;
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(9);
});

test('spawn-policy writes never reuse a positive spawn observation', async () => {
  const { env, policy } = await setup();
  expectSecrets(env());
  const spawn = policy({ forSpawn: true });
  mockState = 'locked';
  expect(spawn.isWriteAvailable()).toBe(false);
  expect(() => spawn.assertCanWrite()).toThrow();
  expect(() => spawn.encrypt('never write from a stale observation')).toThrow();
  expect(mockExecFileSync).toHaveBeenCalledTimes(12);
  expect(mockEncrypt).not.toHaveBeenCalled();
});

test('default read and native-failure diagnostics supersede a spawn observation immediately', async () => {
  const { env, policy } = await setup();
  expectSecrets(env());
  mockState = 'locked';
  expect(() => policy().assertCanRead()).toThrow();
  const denied = mockExecFileSync.mock.calls.length;
  expect(env()).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
  expect(mockExecFileSync).toHaveBeenCalledTimes(denied);
  mockState = 'secure';
  expect(policy().decrypt(Buffer.from('retry'))).toBe('retry');
  expectSecrets(env());
  mockDecrypt.mockImplementationOnce(() => {
    mockState = 'locked';
    throw new Error('private native failure');
  });
  expect(() => policy().decrypt(Buffer.from('ciphertext'))).toThrow(
    'Secure storage decryption failed',
  );
  const diagnosed = mockExecFileSync.mock.calls.length;
  expect(env()).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
  expect(mockExecFileSync).toHaveBeenCalledTimes(diagnosed);
});

test('failed initial native availability never authorizes initialization from a stale positive', async () => {
  const { env, policy } = await setup();
  mockAvailable.mockReturnValue(false);
  const result = env();
  expect(result).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
  expect(result).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
  const attempted = mockAvailable.mock.calls.length;
  const calls = mockExecFileSync.mock.calls.length;
  mockAvailable.mockReturnValue(true);
  mockState = 'locked';
  env();
  expect(mockAvailable).toHaveBeenCalledTimes(attempted);
  expect(mockExecFileSync).toHaveBeenCalledTimes(calls + 3);
  mockState = 'secure';
  mockRecoveryProbe.mockReturnValue(true);
  expect(policy().getStatus().state).toBe('secure');
  const retried = mockExecFileSync.mock.calls.length;
  expectSecrets(env());
  expect(mockExecFileSync).toHaveBeenCalledTimes(retried);
});

test.each(['availability', 'decrypt'] as const)(
  'spawn %s exceptions classify without additional live subprocesses',
  async (kind) => {
    const { env, policy } = await setup();
    expectSecrets(env());
    if (kind === 'availability')
      mockAvailable.mockImplementation(() => {
        throw new Error('private native diagnostic');
      });
    else
      mockDecrypt.mockImplementation(() => {
        throw new Error('private native diagnostic');
      });
    const spawn = policy({ forSpawn: true });
    expect(() => spawn.decrypt(Buffer.from('ciphertext'))).toThrow(
      'Secure storage',
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    // Explicit/default diagnostics are still fresh, even within that TTL.
    expect(() => policy().decrypt(Buffer.from('ciphertext'))).toThrow(
      'Secure storage',
    );
    expect(mockExecFileSync.mock.calls.length).toBeGreaterThan(3);
  },
);

test.each(['environment', 'pat'] as const)(
  'unreadable %s ciphertext never suppresses its healthy sibling injector',
  async (unreadable) => {
    const { env, policy } = await setup();
    mockAvailable.mockReturnValue(false);
    mockRecoveryProbe.mockReturnValue(true);
    const failingBytes = Buffer.from(
      unreadable === 'pat'
        ? 'fixture-pat'
        : JSON.stringify([
            { key: 'SPAWN_SECRET', value: 'fixture-value', secret: true },
          ]),
    );
    mockDecrypt.mockImplementation((bytes: Buffer): string => {
      if (bytes.equals(failingBytes)) {
        throw Object.assign(new Error('Unreadable ciphertext'), {
          secureStorageFailure: Object.freeze({
            version: 1,
            code: 'SECURE_STORAGE_DECRYPT_FAILED',
            operation: 'read',
            state: 'secure',
            backend: 'gnome_libsecret',
            retryable: false,
          }),
        });
      }
      return bytes.toString('utf8');
    });
    for (let i = 0; i < 25; i += 1) {
      const child = env();
      if (unreadable === 'environment') {
        expect(child.GH_TOKEN).toBe('fixture-pat');
        expect(child).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
      } else {
        expect(child.SPAWN_SECRET).toBe('fixture-value');
        expect(child).not.toHaveProperty('GH_TOKEN', 'fixture-pat');
      }
    }
    // One failed helper decrypt, plus the healthy sibling's cached success.
    expect(mockDecrypt).toHaveBeenCalledTimes(2);
    mockTime = 999;
    env();
    expect(mockDecrypt).toHaveBeenCalledTimes(2);
    mockTime = 1000;
    const expired = env();
    expect(expired[unreadable === 'pat' ? 'SPAWN_SECRET' : 'GH_TOKEN']).toBe(
      unreadable === 'pat' ? 'fixture-value' : 'fixture-pat',
    );
    expect(mockDecrypt).toHaveBeenCalledTimes(3);
    expect(policy({ forSpawn: true }).getStatus().state).toBe('secure');
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);

    // A replacement file/bytes recovers immediately, inside the failed TTL.
    mockTime = 1001;
    if (unreadable === 'pat') mockPatValue = 'replacement-pat';
    else mockEnvironmentValue = 'replacement-value';
    const replacement = env();
    expect(replacement.GH_TOKEN).toBe(mockPatValue);
    expect(replacement.SPAWN_SECRET).toBe(mockEnvironmentValue);
    expect(mockDecrypt).toHaveBeenCalledTimes(4);

    const live = policy();
    expect(live.getStatus().state).toBe('secure');
    live.assertCanRead();
    expect(() => live.decrypt(failingBytes)).toThrow(
      'Secure storage decryption failed',
    );
    expect(mockDecrypt).toHaveBeenCalledTimes(5);
    mockDecrypt.mockImplementation((bytes: Buffer): string =>
      bytes.toString('utf8'),
    );
    expect(live.decrypt(failingBytes)).toBe(failingBytes.toString('utf8'));
    expect(mockDecrypt).toHaveBeenCalledTimes(6);
    // Successful explicit Retry also releases a still-unexpired spawn failure.
    expect(policy({ forSpawn: true }).decrypt(failingBytes)).toBe(
      failingBytes.toString('utf8'),
    );
    expect(mockDecrypt).toHaveBeenCalledTimes(7);
  },
);

function unreadableFailure(): Error {
  return Object.assign(new Error('Unreadable ciphertext'), {
    secureStorageFailure: Object.freeze({
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: false,
    }),
  });
}

test('a healthy environment before a corrupt record does not relaunch helpers throughout a both-injector burst', async () => {
  mockTrailingCiphertext = 'corrupt trailing record';
  const { env, policy } = await setup();
  mockAvailable.mockReturnValue(false);
  mockRecoveryProbe.mockReturnValue(true);
  mockDecrypt.mockImplementation((bytes: Buffer): string => {
    if (bytes.toString('utf8') === 'corrupt trailing record')
      throw unreadableFailure();
    return bytes.toString('utf8');
  });
  for (let i = 0; i < 25; i += 1) {
    const child = env();
    expect(child.GH_TOKEN).toBe('fixture-pat');
    expect(child).not.toHaveProperty('SPAWN_SECRET', 'fixture-value');
  }
  // Includes the healthy environment decrypted BEFORE the corrupt record.
  expect(mockDecrypt).toHaveBeenCalledTimes(3);
  mockTime = 999;
  env();
  expect(mockDecrypt).toHaveBeenCalledTimes(3);
  mockTime = 1000;
  expect(env().GH_TOKEN).toBe('fixture-pat');
  expect(mockDecrypt).toHaveBeenCalledTimes(5);
  expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
  expect(policy().getStatus().state).toBe('secure');
  mockTime = 1001;
  mockTrailingCiphertext = '[]';
  expectSecrets(env());
  expect(mockDecrypt).toHaveBeenCalledTimes(6);
});

test('spawn recovery results are isolated by native storage instance and explicit reads stay live', async () => {
  const { policy } = await setup();
  mockAvailable.mockReturnValue(false);
  mockRecoveryProbe.mockReturnValue(true);
  const bad = Buffer.from('bad');
  const good = Buffer.from('good');
  mockDecrypt.mockImplementation((bytes: Buffer): string => {
    if (bytes.equals(bad)) throw unreadableFailure();
    return bytes.toString('utf8');
  });
  const spawn = policy({ forSpawn: true });
  expect(() => spawn.decrypt(bad)).toThrow('Secure storage decryption failed');
  expect(spawn.decrypt(good)).toBe('good');
  expect(() => spawn.decrypt(Buffer.from(bad))).toThrow(
    'Secure storage decryption failed',
  );
  expect(spawn.decrypt(Buffer.from(good))).toBe('good');
  expect(mockDecrypt).toHaveBeenCalledTimes(2);
  mockStorage = { ...mockStorage };
  expect(() => spawn.decrypt(bad)).toThrow('Secure storage decryption failed');
  expect(spawn.decrypt(good)).toBe('good');
  expect(mockDecrypt).toHaveBeenCalledTimes(4);
  mockDecrypt.mockImplementation(() => {
    throw unreadableFailure();
  });
  expect(() => policy().decrypt(good)).toThrow(
    'Secure storage decryption failed',
  );
  expect(mockDecrypt).toHaveBeenCalledTimes(5);
  expect(() => spawn.decrypt(good)).toThrow('Secure storage decryption failed');
  expect(mockDecrypt).toHaveBeenCalledTimes(6);
});

test('spawn recovery retention bounds both distinct outcomes and plaintext bytes', async () => {
  const { policy } = await setup();
  mockAvailable.mockReturnValue(false);
  mockRecoveryProbe.mockReturnValue(true);
  const spawn = policy({ forSpawn: true });
  mockDecrypt.mockImplementation(() => {
    throw unreadableFailure();
  });
  for (let i = 0; i < 65; i += 1) {
    expect(() => spawn.decrypt(Buffer.from(`bad-${i}`))).toThrow(
      'Secure storage decryption failed',
    );
  }
  expect(mockDecrypt).toHaveBeenCalledTimes(65);
  // Oldest metadata is evicted; recent failure still retains its typed result.
  let cachedFailure: unknown;
  try {
    spawn.decrypt(Buffer.from('bad-64'));
  } catch (error: unknown) {
    cachedFailure = error;
  }
  expect(cachedFailure).toMatchObject({
    secureStorageFailure: {
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      retryable: false,
      state: 'secure',
    },
  });
  expect(mockDecrypt).toHaveBeenCalledTimes(65);
  expect(() => spawn.decrypt(Buffer.from('bad-0'))).toThrow(
    'Secure storage decryption failed',
  );
  expect(mockDecrypt).toHaveBeenCalledTimes(66);

  // Positive capacity churn cannot evict the corrupt record's backoff.
  mockDecrypt.mockReturnValue('small');
  for (let i = 0; i < 65; i += 1) spawn.decrypt(Buffer.from(`good-${i}`));
  expect(mockDecrypt).toHaveBeenCalledTimes(131);
  expect(() => spawn.decrypt(Buffer.from('bad-64'))).toThrow(
    'Secure storage decryption failed',
  );
  expect(mockDecrypt).toHaveBeenCalledTimes(131);

  // Two 600 KB UTF-16 results cannot both occupy the 1 MiB plaintext budget.
  mockDecrypt.mockReturnValue('x'.repeat(300_000));
  spawn.decrypt(Buffer.from('large-a'));
  spawn.decrypt(Buffer.from('large-b'));
  spawn.decrypt(Buffer.from('large-a'));
  expect(mockDecrypt).toHaveBeenCalledTimes(134);
  // Nor can positive byte-budget pressure evict an unrelated failure.
  expect(() => spawn.decrypt(Buffer.from('bad-64'))).toThrow(
    'Secure storage decryption failed',
  );
  expect(mockDecrypt).toHaveBeenCalledTimes(134);
});
