import * as fs from 'node:fs/promises';
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof fs>('node:fs/promises'),
  readFile: jest.fn(),
}));
import { migrateSecureStorageFile } from '../lib/secure-storage-migration';
import {
  getEnvironmentValueWritePolicy,
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from '../lib/secure-storage-policy';
import { SafeStorageWriteError } from '../lib/safe-storage';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types';

const mockEncrypt = jest.fn(() => Buffer.from('native-ciphertext'));
const mockDecrypt = jest.fn(() => 'secret');
const mockAvailable = jest.fn<unknown, []>(() => true);
const mockBackend = jest.fn<unknown, []>(() => 'gnome_libsecret');
const mockReady = jest.fn(() => true);
const mockSecretServiceState = jest.fn<
  'secure' | 'unavailable' | 'locked',
  []
>();
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' | 'unavailable' | 'locked' =>
    mockSecretServiceState(),
}));
const mockRecoveryProbe = jest.fn(() => false);
const mockRecoveryDecrypt = jest.fn<string, [Buffer]>();
jest.mock('../lib/linux-safe-storage-recovery', () => ({
  probeLinuxSafeStorageRecovery: (): boolean => mockRecoveryProbe(),
  decryptWithLinuxSafeStorageRecovery: (bytes: Buffer): string =>
    mockRecoveryDecrypt(bytes),
}));
const mockElectron: { app?: unknown; safeStorage?: unknown } = {};
jest.mock('electron', () => mockElectron);
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected storage failure');
}

beforeEach(() => {
  jest.resetAllMocks();
  mockSecretServiceState.mockReturnValue('secure');
  setPlatform('linux');
  mockEncrypt.mockReturnValue(Buffer.from('native-ciphertext'));
  mockDecrypt.mockReturnValue('secret');
  mockAvailable.mockReturnValue(true);
  mockBackend.mockReturnValue('gnome_libsecret');
  mockReady.mockReturnValue(true);
  Object.assign(mockElectron, {
    app: { isReady: mockReady },
    safeStorage: {
      isEncryptionAvailable: mockAvailable,
      getSelectedStorageBackend: mockBackend,
      encryptString: mockEncrypt,
      decryptString: mockDecrypt,
    },
  });
});

afterAll(() => {
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
});

describe('consumer secret-storage policy over the native boundary', () => {
  it.each(['gnome_libsecret'])(
    'allows %s and preserves ciphertext bytes and empty secrets',
    (backend) => {
      mockBackend.mockReturnValue(backend);
      const policy = getSecretStoragePolicy();
      expect(Object.isFrozen(policy)).toBe(true);
      expect(policy.getStatus()).toEqual({ state: 'secure', backend });
      expect(policy.isWriteAvailable()).toBe(true);
      expect(policy.nativeEncryptionAvailable()).toBe(true);
      policy.assertCanRead();
      policy.assertCanWrite();
      expect(policy.encrypt('')).toEqual(Buffer.from('native-ciphertext'));
      expect(mockEncrypt).toHaveBeenCalledWith('');
      expect(policy.decrypt(Buffer.from('old-ciphertext'))).toBe('secret');
    },
  );

  it.each([
    ['unknown', 'unavailable', false, true],
    ['gnome_libsecret', 'locked', false, true],
    [null, 'unavailable', false, true],
  ])(
    'refuses writes on %s without giving native storage plaintext',
    (backend, state, available, retryable) => {
      mockBackend.mockReturnValue(backend);
      mockAvailable.mockReturnValue(available);
      if (state === 'locked') mockSecretServiceState.mockReturnValue('locked');
      const policy = getSecretStoragePolicy();
      expect(policy.isWriteAvailable()).toBe(false);
      for (const text of ['', 'sensitive-text']) {
        const error = caught(() => policy.encrypt(text));
        expect(error).toBeInstanceOf(SafeStorageWriteError);
        expect(getSecureStorageFailure(error)).toEqual({
          version: 1,
          code: 'SECURE_STORAGE_WRITE_REFUSED',
          operation: 'write',
          state,
          backend,
          retryable,
        });
      }
      expect(caught(() => policy.assertCanWrite())).toBeInstanceOf(
        SafeStorageWriteError,
      );
      expect(mockEncrypt).not.toHaveBeenCalled();
    },
  );

  it('reads with a native read-only facade even though writes are unavailable', () => {
    mockElectron.safeStorage = {
      isEncryptionAvailable: mockAvailable,
      decryptString: mockDecrypt,
    };
    const policy = getSecretStoragePolicy();
    expect(policy.isWriteAvailable()).toBe(false);
    policy.assertCanRead();
    expect(policy.decrypt(Buffer.from('historical'))).toBe('secret');
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it('recovers original ciphertext after libsecret cannot decrypt it', () => {
    const policy = getSecretStoragePolicy();
    const ciphertext = policy.encrypt('secret');
    mockDecrypt.mockImplementation(() => {
      throw new Error('different key');
    });
    expect(
      getSecureStorageFailure(caught(() => policy.decrypt(ciphertext))),
    ).toMatchObject({
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: false,
    });
    mockDecrypt.mockReturnValue('secret');
    expect(policy.decrypt(ciphertext)).toBe('secret');
    expect(ciphertext).toEqual(Buffer.from('native-ciphertext'));
  });

  it('resolves fresh native instances and permission across a held policy and recovers', () => {
    const policy = getSecretStoragePolicy();
    policy.encrypt('first');
    mockAvailable.mockReturnValue(false);
    mockSecretServiceState.mockReturnValue('locked');
    expect(
      getSecureStorageFailure(
        caught(() => policy.decrypt(Buffer.from('saved'))),
      ),
    ).toMatchObject({
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      state: 'locked',
    });
    expect(mockDecrypt).not.toHaveBeenCalled();
    const nextEncrypt = jest.fn(() => Buffer.from('next-ciphertext'));
    const nextDecrypt = jest.fn(() => 'next-secret');
    mockSecretServiceState.mockReturnValue('secure');
    Object.assign(mockElectron, {
      app: { isReady: () => true },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: nextEncrypt,
        decryptString: nextDecrypt,
      },
    });
    expect(policy.encrypt('next')).toEqual(Buffer.from('next-ciphertext'));
    expect(policy.decrypt(Buffer.from('saved'))).toBe('next-secret');
    expect(mockEncrypt).toHaveBeenCalledTimes(1);
  });

  it('reports missing storage and unavailable native reads without decrypting', () => {
    const policy = getSecretStoragePolicy();
    delete mockElectron.safeStorage;
    expect(policy.nativeEncryptionAvailable()).toBe(false);
    expect(
      getSecureStorageFailure(caught(() => policy.encrypt('secret'))),
    ).toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      state: 'unavailable',
    });
    expect(
      getSecureStorageFailure(caught(() => policy.assertCanRead())),
    ).toMatchObject({
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      state: 'unavailable',
    });
    expect(
      getSecureStorageFailure(
        caught(() => policy.decrypt(Buffer.from('saved'))),
      ),
    ).toMatchObject({ code: 'SECURE_STORAGE_READ_UNAVAILABLE' });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it.each(['throw', 'malformed'])(
    'does not confuse a %s probe with explicit false',
    (kind) => {
      if (kind === 'throw')
        mockAvailable.mockImplementation(() => {
          throw new Error('private native diagnostic');
        });
      else mockAvailable.mockReturnValue('false');
      const policy = getSecretStoragePolicy();
      const environmentPolicy = getEnvironmentValueWritePolicy();
      expect(environmentPolicy.encryptionAvailable).toBe(false);
      for (const action of [
        (): unknown => policy.nativeEncryptionAvailable(),
        (): unknown => policy.assertCanRead(),
        (): unknown => policy.decrypt(Buffer.from('secret-bytes')),
        (): unknown => environmentPolicy.encode('sensitive-value'),
      ]) {
        const error = caught(action);
        expect(error).toMatchObject({
          message: 'Secure storage unavailable',
          code: 'SECURE_STORAGE_PROBE_FAILED',
          operation: 'probe',
        });
        expect(getSecureStorageFailure(error)).toMatchObject({
          code: 'SECURE_STORAGE_PROBE_FAILED',
          retryable: true,
        });
        expect(JSON.stringify(error)).not.toContain(
          'private native diagnostic',
        );
      }
      expect(mockDecrypt).not.toHaveBeenCalled();
    },
  );

  it.each(['encrypt', 'decrypt'])(
    'wraps native %s failure with fresh diagnostics and no secret/cause',
    (operation) => {
      const fail = (): never => {
        mockAvailable.mockReturnValue(false);
        mockSecretServiceState.mockReturnValue('locked');
        throw new Error('secret-ciphertext-native-error');
      };
      const policy = getSecretStoragePolicy();
      const error =
        operation === 'encrypt'
          ? (mockEncrypt.mockImplementation(fail),
            caught(() => policy.encrypt('secret-text')))
          : (mockDecrypt.mockImplementation(fail),
            caught(() => policy.decrypt(Buffer.from('secret-bytes'))));
      expect(error).toMatchObject({
        code:
          operation === 'encrypt'
            ? 'SECURE_STORAGE_ENCRYPT_FAILED'
            : 'SECURE_STORAGE_DECRYPT_FAILED',
        operation: operation === 'encrypt' ? 'write' : 'read',
        state: 'locked',
        backend: 'gnome_libsecret',
        message: `Secure storage ${operation === 'encrypt' ? 'encryption' : 'decryption'} failed`,
      });
      expect(getSecureStorageFailure(error)).toMatchObject({
        version: 1,
        state: 'locked',
        retryable: true,
      });
      expect(JSON.stringify(error)).not.toMatch(/secret-|cause/);
    },
  );

  it.each(['gnome_libsecret'])(
    'marks native decrypt failure non-retryable while %s remains readable',
    (backend) => {
      mockBackend.mockReturnValue(backend);
      mockDecrypt.mockImplementation(() => {
        throw new Error('wrong identity');
      });
      expect(
        getSecureStorageFailure(
          caught(() =>
            getSecretStoragePolicy().decrypt(
              Buffer.from('synthetic-ciphertext'),
            ),
          ),
        ),
      ).toMatchObject({
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        retryable: false,
      });
    },
  );

  it('does not bypass classification before readiness or on unsupported platforms', () => {
    mockReady.mockReturnValue(false);
    expect(
      getSecureStorageFailure(
        caught(() => getSecretStoragePolicy().encrypt('secret')),
      ),
    ).toMatchObject({ state: 'unavailable' });
    expect(mockBackend).not.toHaveBeenCalled();
    mockReady.mockReturnValue(true);
    setPlatform('unsupported');
    expect(getSecretStoragePolicy().isWriteAvailable()).toBe(false);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])(
    'preserves %s native success without Linux backend selection',
    (platform) => {
      setPlatform(platform);
      mockBackend.mockReturnValue('unknown');
      const policy = getSecretStoragePolicy();
      expect(policy.getStatus()).toEqual({ state: 'secure', backend: null });
      policy.encrypt('secret');
      expect(policy.decrypt(Buffer.from('saved'))).toBe('secret');
      expect(mockBackend).not.toHaveBeenCalled();
    },
  );

  it('validates and sanitizes attached domain descriptors', () => {
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: true,
    };
    const domain = Object.assign(new Error('domain message'), {
      secureStorageFailure: {
        ...failure,
        cause: 'native diagnostics',
        token: 'private',
      },
    });
    expect(getSecureStorageFailure(domain)).toEqual(failure);
    expect(JSON.stringify(getSecureStorageFailure(domain))).not.toMatch(
      /cause|token|private/,
    );
    for (const bad of [
      null,
      {},
      { ...failure, version: 2 },
      { ...failure, code: 'other' },
      { ...failure, operation: 'delete' },
      { ...failure, state: 'broken' },
      { ...failure, state: 'plain-text' },
      { ...failure, backend: 42 },
      { ...failure, retryable: 'true' },
    ]) {
      expect(getSecureStorageFailure({ secureStorageFailure: bad })).toBeNull();
    }
    expect(
      getSecureStorageFailure({
        secureStorageFailure: { ...failure, state: 'unknown' },
      }),
    ).toMatchObject({ state: 'unknown' });
    expect(getSecureStorageFailure(new Error('generic'))).toBeNull();
  });
});

describe('explicit environment-only write decision', () => {
  it.each([false, 'missing'])(
    'keeps historical plaintext availability decision %s',
    (availability) => {
      if (availability === 'missing') delete mockElectron.safeStorage;
      else mockAvailable.mockReturnValue(false);
      const policy = getEnvironmentValueWritePolicy();
      expect(Object.isFrozen(policy)).toBe(true);
      expect(policy.encryptionAvailable).toBe(false);
      expect(policy.encode('value')).toEqual({
        kind: 'plain-text',
        value: 'value',
      });
      expect(mockEncrypt).not.toHaveBeenCalled();
    },
  );

  it('keeps the display snapshot but guards each encrypted field without downgrading', () => {
    const policy = getEnvironmentValueWritePolicy();
    expect(policy.encode('first')).toEqual({
      kind: 'encrypted',
      value: Buffer.from('native-ciphertext'),
    });
    mockBackend.mockReturnValue('unknown');
    mockAvailable.mockReturnValue(false);
    expect(
      getSecureStorageFailure(caught(() => policy.encode('second'))),
    ).toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      state: 'unavailable',
    });
    expect(policy.encryptionAvailable).toBe(true);
    expect(mockEncrypt).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, 'locked'],
    [false, 'unavailable'],
    ['missing', 'locked'],
    ['missing', 'unavailable'],
  ] as const)(
    'rechecks historical plaintext decision %s when the provider becomes %s',
    (availability, state) => {
      if (availability === 'missing') delete mockElectron.safeStorage;
      else mockAvailable.mockReturnValue(false);
      const policy = getEnvironmentValueWritePolicy();
      expect(policy.encryptionAvailable).toBe(false);
      mockSecretServiceState.mockReturnValue(state);

      const error = caught(() => policy.encode('sensitive-value'));
      expect(error).toBeInstanceOf(SafeStorageWriteError);
      expect(getSecureStorageFailure(error)).toEqual({
        version: 1,
        code: 'SECURE_STORAGE_WRITE_REFUSED',
        operation: 'write',
        state,
        backend: availability === 'missing' ? null : 'gnome_libsecret',
        retryable: true,
      });
      expect(mockEncrypt).not.toHaveBeenCalled();
    },
  );

  it('displays provider denial without throwing and retains refusal until a new Retry attempt', () => {
    expect(getSecretStoragePolicy().nativeEncryptionAvailable()).toBe(true);
    mockSecretServiceState.mockReturnValue('locked');
    const policy = getEnvironmentValueWritePolicy();
    expect(policy.encryptionAvailable).toBe(false);
    mockSecretServiceState.mockReturnValue('unavailable');

    const error = caught(() => policy.encode('sensitive-value'));
    expect(error).toBeInstanceOf(SafeStorageWriteError);
    expect(getSecureStorageFailure(error)).toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      state: 'locked',
      retryable: true,
    });
    expect(mockEncrypt).not.toHaveBeenCalled();

    mockSecretServiceState.mockReturnValue('secure');
    const retry = getEnvironmentValueWritePolicy();
    expect(retry.encode('sensitive-value')).toEqual({
      kind: 'encrypted',
      value: Buffer.from('native-ciphertext'),
    });
  });

  it('refuses failed recovery readiness rather than mistaking it for native false', () => {
    mockSecretServiceState.mockReturnValue('unavailable');
    expect(getSecretStoragePolicy().nativeEncryptionAvailable()).toBe(false);
    mockSecretServiceState.mockReturnValue('secure');
    mockRecoveryProbe.mockReturnValue(false);
    mockAvailable.mockImplementation(() => {
      throw new Error('Native initialization must not run before recovery');
    });

    const policy = getEnvironmentValueWritePolicy();
    expect(policy.encryptionAvailable).toBe(false);
    const error = caught(() => policy.encode('sensitive-value'));
    expect(error).toBeInstanceOf(SafeStorageWriteError);
    expect(getSecureStorageFailure(error)).toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      state: 'unavailable',
      backend: 'gnome_libsecret',
      retryable: true,
    });
    expect(mockRecoveryProbe).toHaveBeenCalled();
    expect(mockAvailable).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it('propagates native encryption failures rather than returning plaintext', () => {
    const policy = getEnvironmentValueWritePolicy();
    mockEncrypt.mockImplementation(() => {
      throw new Error('private');
    });
    expect(
      getSecureStorageFailure(caught(() => policy.encode('value'))),
    ).toMatchObject({ code: 'SECURE_STORAGE_ENCRYPT_FAILED' });
  });
});

describe('helper failure routing through the actual facade and policy', () => {
  function recoveryFailure(genuine: boolean): Error {
    const failure: SecureStorageFailure = {
      version: 1,
      code: genuine
        ? 'SECURE_STORAGE_DECRYPT_FAILED'
        : 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: genuine ? 'secure' : 'unavailable',
      backend: 'gnome_libsecret',
      retryable: !genuine,
    };
    return Object.assign(new Error('Secure storage recovery unavailable.'), {
      secureStorageFailure: failure,
    });
  }

  it.each([false, true])(
    'preserves helper failure classification (genuine=%s) before a successful fresh probe',
    (genuine) => {
      mockAvailable.mockReturnValue(false);
      mockRecoveryProbe.mockReturnValue(true);
      const source = Buffer.from('retained-ciphertext');
      mockRecoveryDecrypt.mockImplementationOnce(() => {
        throw recoveryFailure(genuine);
      });
      const policy = getSecretStoragePolicy();
      const failure = getSecureStorageFailure(
        caught(() => policy.decrypt(source)),
      );
      expect(failure).toEqual(
        getSecureStorageFailure(recoveryFailure(genuine)),
      );
      // A healthy cipher failure is local to those bytes; only an unavailable
      // helper needs a fresh probe before its next operation.
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
      expect(policy.getStatus().state).toBe('secure');
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(genuine ? 1 : 2);
      expect(source).toEqual(Buffer.from('retained-ciphertext'));
      expect(mockDecrypt).not.toHaveBeenCalled();
    },
  );

  it('does not skip valid legacy bytes as foreign after a transient helper failure', async () => {
    mockAvailable.mockReturnValue(false);
    mockRecoveryProbe.mockReturnValue(true);
    mockRecoveryDecrypt.mockImplementationOnce(() => {
      throw recoveryFailure(false);
    });
    const read = jest
      .mocked(fs.readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(Buffer.from('retained-legacy-ciphertext'));
    try {
      const policy = getSecretStoragePolicy();
      const encode = jest.fn((value: string) => Buffer.from(value));
      const result = await migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode: (bytes) => policy.decrypt(bytes),
        encode,
        storeKind: 'test',
      });
      expect(result).toMatchObject({
        status: 'storage-error',
        secureStorageFailure: {
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          state: 'unavailable',
          retryable: true,
        },
      });
      expect(encode).not.toHaveBeenCalled();
      expect(policy.getStatus().state).toBe('secure');
    } finally {
      read.mockReset();
    }
  });
});
