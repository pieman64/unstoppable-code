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
      for (const action of [
        (): unknown => policy.nativeEncryptionAvailable(),
        (): unknown => policy.assertCanRead(),
        (): unknown => policy.decrypt(Buffer.from('secret-bytes')),
        (): unknown => getEnvironmentValueWritePolicy(),
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

  it('samples availability once but guards each encrypted field without downgrading', () => {
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
