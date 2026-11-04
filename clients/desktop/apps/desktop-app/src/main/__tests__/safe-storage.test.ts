import {
  disableSafeStoragePlainTextEncryption,
  getReadableSafeStorage,
  getSafeStorageStatus,
  getWritableSafeStorage,
  SafeStorageWriteError,
  type SafeStorageBackendState,
  type WritableSafeStorage,
} from '../lib/safe-storage';
import type * as SafeStorageModule from '../lib/safe-storage';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from '../lib/secure-storage-policy';

const ciphertext = Buffer.from('native-ciphertext');
const mockEncrypt = jest.fn<Buffer, [string]>(() => ciphertext);
const mockDecrypt = jest.fn<string, [Buffer]>(() => 'readable-secret');
const mockAvailable = jest.fn<boolean, []>(() => true);
const mockBackend = jest.fn<unknown, []>(() => 'gnome_libsecret');
const mockReady = jest.fn<unknown, []>(() => true);
const mockLinuxSecretServiceState = jest.fn<string, []>(() => 'secure');
const mockRecoveryProbe = jest.fn<boolean, []>(() => false);
const mockRecoveryEncrypt = jest.fn<Buffer, [string]>();
const mockRecoveryDecrypt = jest.fn<string, [Buffer]>();
jest.mock('../lib/linux-safe-storage-recovery', () => ({
  probeLinuxSafeStorageRecovery: (): boolean => mockRecoveryProbe(),
  encryptWithLinuxSafeStorageRecovery: (text: string): Buffer =>
    mockRecoveryEncrypt(text),
  decryptWithLinuxSafeStorageRecovery: (bytes: Buffer): string =>
    mockRecoveryDecrypt(bytes),
}));
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): string => mockLinuxSecretServiceState(),
}));
const mockLogMainProcessWarn = jest.fn<void, [string, unknown?]>();
let mockElectron: unknown;
let nativeStorage: Record<string, unknown>;
jest.mock('electron', () => mockElectron);
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (message: string, context?: unknown): void =>
    mockLogMainProcessWarn(message, context),
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}
function writer(): WritableSafeStorage {
  const storage = getWritableSafeStorage();
  if (!storage) throw new Error('Expected writable facade');
  return storage;
}
function expectRefusal(
  state: Exclude<SafeStorageBackendState, 'secure'>,
  backend: string | null,
): void {
  const messages = {
    unavailable: 'Secure storage write refused: encryption unavailable.',
    locked:
      'Secure storage write refused: backend locked or temporarily unavailable.',
  };
  for (const text of ['test-secret', '']) {
    const previousLogCount = mockLogMainProcessWarn.mock.calls.length;
    let caught: unknown;
    try {
      writer().encryptString(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SafeStorageWriteError);
    if (!(caught instanceof SafeStorageWriteError)) {
      throw new Error('Expected typed write refusal');
    }
    expect(caught.code).toBe('SECURE_STORAGE_WRITE_REFUSED');
    expect(caught).toMatchObject({
      name: 'SafeStorageWriteError',
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      state,
      backend,
      message: messages[state],
    });
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(previousLogCount + 1);
    expect(mockLogMainProcessWarn).toHaveBeenLastCalledWith(
      'Secure storage write refused',
      { state, backend },
    );
  }
}

beforeEach(() => {
  jest.resetModules();
  jest.resetAllMocks();
  mockReady.mockReturnValue(true);
  mockLinuxSecretServiceState.mockReturnValue('secure');
  mockRecoveryProbe.mockReturnValue(false);
  mockAvailable.mockReturnValue(true);
  mockBackend.mockReturnValue('gnome_libsecret');
  mockEncrypt.mockReturnValue(ciphertext);
  mockDecrypt.mockReturnValue('readable-secret');
  nativeStorage = {
    isEncryptionAvailable: mockAvailable,
    getSelectedStorageBackend: mockBackend,
    encryptString: mockEncrypt,
    decryptString: mockDecrypt,
    encryptStringAsync: jest.fn(),
    setUsePlainTextEncryption: jest.fn(),
  };
  mockElectron = { app: { isReady: mockReady }, safeStorage: nativeStorage };
  setPlatform('linux');
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
});

test('refusal logs only classified metadata, without secrets or native diagnostics', () => {
  const plaintext = 'private-token-value';
  const keyName = 'private-token-key';
  const diagnostic = 'private-native-diagnostic';
  const nativeCiphertext = ciphertext.toString();
  mockBackend.mockImplementation(() => {
    throw new Error(
      `${plaintext} ${keyName} ${diagnostic} ${nativeCiphertext}`,
    );
  });

  getSafeStorageStatus();
  const storage = writer();
  expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
  expect(() => storage.encryptString(plaintext)).toThrow(SafeStorageWriteError);
  expect(mockLogMainProcessWarn.mock.calls).toEqual([
    ['Secure storage write refused', { state: 'unavailable', backend: null }],
  ]);
  const logged = JSON.stringify(mockLogMainProcessWarn.mock.calls);
  for (const secret of [plaintext, keyName, diagnostic, nativeCiphertext]) {
    expect(logged).not.toContain(secret);
  }
  expect(mockEncrypt).not.toHaveBeenCalled();
});

test.each(['unavailable', 'locked'])(
  'Linux retries after live Secret Service %s without poisoning native initialization',
  (state) => {
    const held = writer();
    // Chromium consumes its initialization config on the first native probe,
    // including failure. Never call it while the real provider cannot serve.
    let initializationFailed = false;
    mockAvailable.mockImplementation(() => {
      if (mockLinuxSecretServiceState() !== 'secure')
        initializationFailed = true;
      return !initializationFailed;
    });
    mockLinuxSecretServiceState.mockReturnValue(state);
    expect(getSafeStorageStatus()).toEqual({
      state,
      backend: 'gnome_libsecret',
    });
    expect(() => held.encryptString('first attempt')).toThrow(
      SafeStorageWriteError,
    );
    expect(mockAvailable).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockRecoveryProbe.mockReturnValue(true);
    mockRecoveryEncrypt.mockReturnValue(ciphertext);
    expect(held.encryptString('one retry')).toBe(ciphertext);
    expect(mockRecoveryEncrypt).toHaveBeenCalledTimes(1);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockAvailable).not.toHaveBeenCalled();
  },
);

test('Linux refuses a newly locked collection even with a cached native key', () => {
  const held = writer();
  expect(held.encryptString('before lock')).toBe(ciphertext);
  mockLinuxSecretServiceState.mockReturnValue('locked');
  expect(() => held.encryptString('after lock')).toThrow(SafeStorageWriteError);
  expect(mockEncrypt).toHaveBeenCalledTimes(1);
  mockLinuxSecretServiceState.mockReturnValue('secure');
  expect(held.encryptString('after unlock')).toBe(ciphertext);
});

const secureBackends = ['gnome_libsecret'];
for (const backend of secureBackends) {
  test.each([true, false])(`${backend}, available=%s`, (available) => {
    mockBackend.mockReturnValue(backend);
    mockAvailable.mockReturnValue(available);
    expect(getSafeStorageStatus()).toEqual({
      state: available ? 'secure' : 'unavailable',
      backend,
    });
    if (available) {
      expect(writer().encryptString('original-secret')).toBe(ciphertext);
      expect(mockEncrypt).toHaveBeenCalledWith('original-secret');
    } else expectRefusal('unavailable', backend);
  });
}
for (const backend of [
  'basic_text',
  'unknown',
  'future_backend',
  '',
  'gnome-libsecret',
  ' gnome_libsecret',
]) {
  test.each([true, false])(
    `${JSON.stringify(backend)}, available=%s`,
    (available) => {
      mockBackend.mockReturnValue(backend);
      mockAvailable.mockReturnValue(available);
      const state = 'unavailable';
      expect(getSafeStorageStatus()).toEqual({ state, backend });
      expectRefusal(state, backend);
    },
  );
}
test.each([undefined, null, 42, {}, false])(
  'non-string backend %p is unavailable',
  (backend) => {
    mockBackend.mockReturnValue(backend);
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expectRefusal('unavailable', null);
  },
);
test.each(['missing', 'throws'])('backend getter %s is unavailable', (kind) => {
  if (kind === 'missing') delete nativeStorage.getSelectedStorageBackend;
  else
    mockBackend.mockImplementation(() => {
      throw new Error('private native diagnostic');
    });
  expect(getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: null,
  });
  expectRefusal('unavailable', null);
});
for (const platform of ['darwin', 'win32']) {
  test.each([true, false])(
    `${platform} ignores Linux backend, available=%s`,
    (available) => {
      setPlatform(platform);
      delete nativeStorage.getSelectedStorageBackend;
      mockAvailable.mockReturnValue(available);
      expect(getSafeStorageStatus()).toEqual({
        state: available ? 'secure' : 'unavailable',
        backend: null,
      });
      if (available)
        expect(writer().encryptString('native-secret')).toBe(ciphertext);
      else expectRefusal('unavailable', null);
      expect(mockBackend).not.toHaveBeenCalled();
    },
  );
}
test('unsupported platform denies without availability or backend queries', () => {
  setPlatform('freebsd');
  expect(getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: null,
  });
  expectRefusal('unavailable', null);
  expect(mockAvailable).not.toHaveBeenCalled();
  expect(mockBackend).not.toHaveBeenCalled();
});
test('import and getter construction do not probe readiness, availability, or backend', () => {
  jest.isolateModules(() => {
    jest.requireActual('../lib/safe-storage');
  });
  getReadableSafeStorage();
  getWritableSafeStorage();
  expect(mockReady).not.toHaveBeenCalled();
  expect(mockAvailable).not.toHaveBeenCalled();
  expect(mockBackend).not.toHaveBeenCalled();
});
test.each([false, undefined, 1, 'true'])(
  'readiness %p denies before native probes',
  (ready) => {
    mockReady.mockReturnValue(ready);
    const held = writer();
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expectRefusal('unavailable', null);
    expect(mockAvailable).not.toHaveBeenCalled();
    expect(mockBackend).not.toHaveBeenCalled();
    mockReady.mockReturnValue(true);
    expect(held.encryptString('retry')).toBe(ciphertext);
  },
);
test.each(['missing', 'throws', 'malformed'])(
  'readiness API %s denies',
  (kind) => {
    if (kind === 'throws')
      mockReady.mockImplementation(() => {
        throw new Error('ready failed');
      });
    else
      mockElectron = {
        app: kind === 'missing' ? {} : null,
        safeStorage: nativeStorage,
      };
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expectRefusal('unavailable', null);
    expect(mockAvailable).not.toHaveBeenCalled();
    expect(mockBackend).not.toHaveBeenCalled();
  },
);
test('availability exception denies after the live backend check', () => {
  mockAvailable.mockImplementation(() => {
    throw new Error('availability failed');
  });
  expect(getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: null,
  });
  expectRefusal('unavailable', null);
});
test.each(['false', 1, null, undefined, {}])(
  'malformed availability result %p refuses encryption',
  (available) => {
    nativeStorage.isEncryptionAvailable = jest.fn(() => available);
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expectRefusal('unavailable', null);
  },
);
test('availability is sampled once before backend validation', () => {
  getSafeStorageStatus();
  expect(mockAvailable).toHaveBeenCalledTimes(1);
  expect(mockBackend).toHaveBeenCalledTimes(1);
  expect(mockAvailable.mock.invocationCallOrder[0]).toBeLessThan(
    mockBackend.mock.invocationCallOrder[0],
  );
});
test.each([null, undefined, '/node/launcher', 42, {}, { safeStorage: null }])(
  'malformed Electron %p is unavailable',
  (electron) => {
    mockElectron = electron;
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expect(getReadableSafeStorage()).toBeNull();
    expect(getWritableSafeStorage()).toBeNull();
  },
);
test('missing Electron is handled gracefully', () => {
  jest.resetModules();
  jest.doMock('electron', () => {
    throw new Error('module absent');
  });
  const storage: typeof SafeStorageModule = jest.requireActual(
    '../lib/safe-storage',
  );
  expect(storage.getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: null,
  });
  expect(storage.getReadableSafeStorage()).toBeNull();
  expect(storage.getWritableSafeStorage()).toBeNull();
  jest.doMock('electron', () => mockElectron);
  jest.resetModules();
});
test.each(['isEncryptionAvailable', 'decryptString', 'encryptString'])(
  'missing writable method %s is unavailable',
  (method) => {
    const held = writer();
    delete nativeStorage[method];
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expect(() => held.encryptString('secret')).toThrow(SafeStorageWriteError);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(getWritableSafeStorage()).toBeNull();
    expect(getReadableSafeStorage() === null).toBe(method !== 'encryptString');
  },
);
test.each(['basic_text', 'unknown'])(
  'reads remain available on %s',
  (backend) => {
    mockBackend.mockReturnValue(backend);
    const original = Buffer.from('existing ciphertext');
    for (const storage of [getReadableSafeStorage(), writer()]) {
      expect(storage?.isEncryptionAvailable()).toBe(true);
      expect(storage?.decryptString(original)).toBe('readable-secret');
    }
    expect(mockDecrypt).toHaveBeenCalledWith(original);
  },
);
test('native availability retains its meaning and exception identity', () => {
  mockAvailable.mockReturnValue(false);
  expect(writer().isEncryptionAvailable()).toBe(false);
  const failure = new Error('native availability failure');
  mockAvailable.mockImplementation(() => {
    throw failure;
  });
  expect(() => writer().isEncryptionAvailable()).toThrow(failure);
});
test('native encryption and decryption errors propagate unchanged', () => {
  const failure = new Error('native operation failure');
  mockEncrypt.mockImplementation(() => {
    throw failure;
  });
  mockDecrypt.mockImplementation(() => {
    throw failure;
  });
  try {
    writer().encryptString('secret');
  } catch (error) {
    expect(error).toBe(failure);
  }
  try {
    getReadableSafeStorage()?.decryptString(ciphertext);
  } catch (error) {
    expect(error).toBe(failure);
  }
  expect(mockEncrypt).toHaveBeenCalledTimes(1);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
});
test.each(['unknown', 'locked'])(
  'held/detached writer rejects transition to %s and recovers',
  (state) => {
    const held = writer();
    const encrypt = held.encryptString;
    expect(getSafeStorageStatus().state).toBe('secure');
    expect(encrypt('before')).toBe(ciphertext);
    mockEncrypt.mockClear();
    if (state === 'locked')
      mockLinuxSecretServiceState.mockReturnValue('locked');
    else mockBackend.mockReturnValue(state);
    expect(() => encrypt('after')).toThrow(SafeStorageWriteError);
    expect(mockEncrypt).not.toHaveBeenCalled();
    mockBackend.mockReturnValue('gnome_libsecret');
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockAvailable.mockReturnValue(true);
    expect(encrypt('retry')).toBe(ciphertext);
  },
);
test('held writer resolves the current Electron context', () => {
  const encrypt = writer().encryptString;
  mockElectron = null;
  jest.resetModules();
  expect(() => encrypt('secret')).toThrow(SafeStorageWriteError);
  expect(mockEncrypt).not.toHaveBeenCalled();
});
test('unchanged status queries are idempotent without caching authorization', () => {
  expect(getSafeStorageStatus()).toEqual(getSafeStorageStatus());
  expect(mockBackend).toHaveBeenCalledTimes(2);
  expect(mockEncrypt).not.toHaveBeenCalled();
});
test('facades are frozen and expose exactly the permitted own methods', () => {
  const readable = getReadableSafeStorage();
  const writable = writer();
  expect(Object.keys(readable ?? {}).sort()).toEqual([
    'decryptString',
    'isEncryptionAvailable',
  ]);
  expect(Object.keys(writable).sort()).toEqual([
    'decryptString',
    'encryptString',
    'isEncryptionAvailable',
  ]);
  for (const facade of [readable, writable]) {
    expect(facade).not.toBe(nativeStorage);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.getPrototypeOf(facade)).toBe(Object.prototype);
    expect(facade).not.toHaveProperty('encryptStringAsync');
    expect(facade).not.toHaveProperty('setUsePlainTextEncryption');
    expect(facade).not.toHaveProperty('safeStorage');
  }
  expect(readable).not.toHaveProperty('encryptString');
  expect(writable.encryptString).not.toBe(mockEncrypt);
});
test('all native calls preserve their receiver and argument identity', () => {
  const readiness = { isReady: mockReady };
  mockElectron = { app: readiness, safeStorage: nativeStorage };
  const { encryptString, decryptString, isEncryptionAvailable } = writer();
  expect(encryptString('secret')).toBe(ciphertext);
  expect(decryptString(ciphertext)).toBe('readable-secret');
  expect(isEncryptionAvailable()).toBe(true);
  expect(mockReady.mock.contexts[0]).toBe(readiness);
  for (const probe of [mockAvailable, mockBackend, mockEncrypt, mockDecrypt]) {
    expect(probe.mock.contexts[0]).toBe(nativeStorage);
  }
  expect(mockDecrypt.mock.calls[0][0]).toBe(ciphertext);
});
test('secure encryption forwards an empty string unchanged', () => {
  expect(writer().encryptString('')).toBe(ciphertext);
  expect(mockEncrypt).toHaveBeenCalledWith('');
});
test('a held writer preserves a newly resolved native receiver', () => {
  const encrypt = writer().encryptString;
  const replacement = {
    ...nativeStorage,
    encryptString: jest.fn(() => ciphertext),
  };
  mockElectron = { app: { isReady: mockReady }, safeStorage: replacement };
  jest.resetModules();
  expect(encrypt('replacement-secret')).toBe(ciphertext);
  expect(replacement.encryptString.mock.contexts[0]).toBe(replacement);
  expect(mockEncrypt).not.toHaveBeenCalled();
});
test.each(['isEncryptionAvailable', 'decryptString', 'encryptString'])(
  'malformed writable method %s is unavailable',
  (method) => {
    const held = writer();
    nativeStorage[method] = 'not-a-function';
    expect(getSafeStorageStatus()).toEqual({
      state: 'unavailable',
      backend: null,
    });
    expect(() => held.encryptString('secret')).toThrow(SafeStorageWriteError);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(getWritableSafeStorage()).toBeNull();
  },
);
test('a held reader remains independent of readiness and native availability', () => {
  const readable = getReadableSafeStorage();
  mockReady.mockReturnValue(false);
  mockAvailable.mockReturnValue(false);
  expect(readable?.isEncryptionAvailable()).toBe(false);
  expect(readable?.decryptString(ciphertext)).toBe('readable-secret');
  expect(mockReady).not.toHaveBeenCalled();
});
test('encryption uses the native storage instance whose backend was classified', () => {
  const replacement = {
    ...nativeStorage,
    getSelectedStorageBackend: jest.fn(() => 'unknown'),
    encryptString: jest.fn(() => Buffer.from('unapproved-ciphertext')),
  };
  const electron = { app: { isReady: mockReady }, safeStorage: nativeStorage };
  mockElectron = electron;
  mockBackend.mockImplementation(() => {
    electron.safeStorage = replacement;
    return 'gnome_libsecret';
  });
  const held = writer();
  expect(held.encryptString('secret')).toBe(ciphertext);
  expect(mockEncrypt).toHaveBeenCalledWith('secret');
  expect(() => held.encryptString('later-secret')).toThrow(
    SafeStorageWriteError,
  );
  expect(mockEncrypt).toHaveBeenCalledTimes(1);
  expect(replacement.encryptString).not.toHaveBeenCalled();
});

test('unavailable libsecret reports unavailable without a plaintext fallback', () => {
  mockBackend.mockReturnValue('unknown');
  mockAvailable.mockReturnValue(false);
  expect(getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: 'unknown',
  });
  expectRefusal('unavailable', 'unknown');
  expect(nativeStorage.setUsePlainTextEncryption).not.toHaveBeenCalled();
});

describe('fresh-helper recovery of poisoned Linux native storage', () => {
  beforeEach(() => {
    mockAvailable.mockReturnValue(false);
    mockRecoveryProbe.mockReturnValue(true);
    mockRecoveryEncrypt.mockImplementation(
      (text: string): Buffer => Buffer.from(`recovered:${text}`),
    );
    mockRecoveryDecrypt.mockImplementation((bytes: Buffer): string =>
      bytes.toString().replace(/^recovered:/, ''),
    );
  });

  test('held raw decrypt provider race remains retryable when a later diagnostic is healthy', () => {
    const policy = getSecretStoragePolicy();
    mockLinuxSecretServiceState.mockReturnValue('unavailable');
    expect(policy.getStatus().state).toBe('unavailable');
    mockLinuxSecretServiceState.mockReturnValue('secure');
    expect(policy.getStatus().state).toBe('secure');
    mockLinuxSecretServiceState
      .mockReturnValueOnce('secure')
      .mockReturnValueOnce('unavailable');
    const retained = Buffer.from('recovered:retained');
    let error: unknown;
    try {
      policy.decrypt(retained);
    } catch (caught) {
      error = caught;
    }
    expect(getSecureStorageFailure(error)).toMatchObject({
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'unavailable',
      backend: 'gnome_libsecret',
      retryable: true,
    });
    expect(policy.getStatus().state).toBe('secure');
    expect(mockRecoveryDecrypt).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(retained).toEqual(Buffer.from('recovered:retained'));
  });

  test.each(['unavailable', 'locked'])(
    'cold %s observation routes restored status/read/write before touching poisoned native availability',
    (state) => {
      const held = writer();
      const readable = getReadableSafeStorage();
      mockLinuxSecretServiceState.mockReturnValue(state);
      expect(getSafeStorageStatus().state).toBe(state);
      mockAvailable.mockImplementation((): never => {
        throw new Error('Unbounded parent native availability sentinel');
      });
      mockLinuxSecretServiceState.mockReturnValue('secure');
      expect(getSafeStorageStatus().state).toBe('secure');
      expect(readable?.isEncryptionAvailable()).toBe(true);
      expect(held.isEncryptionAvailable()).toBe(true);
      expect(held.encryptString('retry')).toEqual(
        Buffer.from('recovered:retry'),
      );
      expect(readable?.decryptString(Buffer.from('recovered:retained'))).toBe(
        'retained',
      );
      expect(held.decryptString(Buffer.from('recovered:retained'))).toBe(
        'retained',
      );
      expect(mockAvailable).not.toHaveBeenCalled();
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(mockDecrypt).not.toHaveBeenCalled();
    },
  );

  test('startup opt-out seeds absent-provider recovery before app readiness', () => {
    mockReady.mockReturnValue(false);
    mockLinuxSecretServiceState.mockReturnValue('unavailable');
    disableSafeStoragePlainTextEncryption();
    expect(nativeStorage.setUsePlainTextEncryption).toHaveBeenCalledWith(false);
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockReady.mockReturnValue(true);
    mockAvailable.mockImplementation((): never => {
      throw new Error('Unbounded startup sentinel');
    });
    expect(writer().encryptString('retry')).toEqual(
      Buffer.from('recovered:retry'),
    );
    expect(mockAvailable).not.toHaveBeenCalled();
  });

  test('a raw held reader observed during absence never decrypts through poisoned parent after restoration', () => {
    const held = getReadableSafeStorage();
    mockLinuxSecretServiceState.mockReturnValue('unavailable');
    expect(held?.isEncryptionAvailable()).toBe(false);
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockAvailable.mockImplementation((): never => {
      throw new Error('Unbounded raw reader sentinel');
    });
    expect(held?.decryptString(Buffer.from('recovered:retained'))).toBe(
      'retained',
    );
    expect(mockAvailable).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  test('confirmed healthy native instance retains native lock/unlock path independently of helper readiness', () => {
    mockAvailable.mockReturnValue(true);
    expect(writer().encryptString('native before lock')).toBe(ciphertext);
    mockLinuxSecretServiceState.mockReturnValue('locked');
    expect(getSafeStorageStatus().state).toBe('locked');
    mockLinuxSecretServiceState.mockReturnValue('secure');
    expect(writer().encryptString('native after unlock')).toBe(ciphertext);
    expect(mockRecoveryProbe).not.toHaveBeenCalled();
    expect(mockEncrypt).toHaveBeenCalledTimes(2);
  });

  test('helper readiness never becomes native confirmation and cipher failure preserves the required recovery route', () => {
    mockLinuxSecretServiceState.mockReturnValue('unavailable');
    expect(getSafeStorageStatus().state).toBe('unavailable');
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockAvailable.mockImplementation((): never => {
      throw new Error('Parent must remain untouched');
    });
    expect(getSafeStorageStatus().state).toBe('secure');
    mockLinuxSecretServiceState.mockReturnValue('locked');
    expect(getSafeStorageStatus().state).toBe('locked');
    mockLinuxSecretServiceState.mockReturnValue('secure');
    mockRecoveryEncrypt.mockImplementationOnce((): never => {
      throw new Error('Helper failed');
    });
    expect(() => writer().encryptString('failed')).toThrow(
      SafeStorageWriteError,
    );
    expect(writer().encryptString('retry')).toEqual(
      Buffer.from('recovered:retry'),
    );
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(2);
    expect(mockAvailable).not.toHaveBeenCalled();
  });

  test('required recovery is bound to the observed native object, not a healthy replacement', () => {
    mockLinuxSecretServiceState.mockReturnValue('unavailable');
    expect(getSafeStorageStatus().state).toBe('unavailable');
    const replacementEncrypt = jest.fn((): Buffer => ciphertext);
    mockElectron = {
      app: { isReady: mockReady },
      safeStorage: {
        ...nativeStorage,
        isEncryptionAvailable: (): boolean => true,
        encryptString: replacementEncrypt,
      },
    };
    jest.resetModules();
    mockLinuxSecretServiceState.mockReturnValue('secure');
    expect(writer().encryptString('replacement')).toBe(ciphertext);
    expect(replacementEncrypt).toHaveBeenCalledWith('replacement');
    expect(mockRecoveryProbe).not.toHaveBeenCalled();
  });

  test('held facades consistently route availability, status and both cipher directions', () => {
    const held = writer();
    const readable = getReadableSafeStorage();
    expect(getSafeStorageStatus()).toEqual({
      state: 'secure',
      backend: 'gnome_libsecret',
    });
    expect(held.isEncryptionAvailable()).toBe(true);
    expect(readable?.isEncryptionAvailable()).toBe(true);
    const encrypted = held.encryptString('fixture-secret');
    expect(encrypted).toEqual(Buffer.from('recovered:fixture-secret'));
    expect(held.decryptString(encrypted)).toBe('fixture-secret');
    expect(readable?.decryptString(encrypted)).toBe('fixture-secret');
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
    const replacement = { ...nativeStorage };
    mockElectron = { app: { isReady: mockReady }, safeStorage: replacement };
    jest.resetModules();
    mockRecoveryProbe.mockReturnValue(false);
    expect(getSafeStorageStatus().state).toBe('unavailable');
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(2);
    mockRecoveryProbe.mockReturnValue(true);
    expect(held.encryptString('replacement retry')).toEqual(
      Buffer.from('recovered:replacement retry'),
    );
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(3);
  });

  test.each(['unknown', 'basic_text', '', null])(
    'backend %p cannot activate recovery',
    (backend) => {
      mockBackend.mockReturnValue(backend);
      expect(getSafeStorageStatus().state).toBe('unavailable');
      expect(writer().isEncryptionAvailable()).toBe(false);
      expect(() => writer().encryptString('secret')).toThrow(
        SafeStorageWriteError,
      );
      expect(mockRecoveryProbe).not.toHaveBeenCalled();
    },
  );

  test.each(['darwin', 'win32'])('%s never uses Linux recovery', (platform) => {
    setPlatform(platform);
    expect(getSafeStorageStatus().state).toBe('unavailable');
    expect(writer().isEncryptionAvailable()).toBe(false);
    expect(mockRecoveryProbe).not.toHaveBeenCalled();
  });

  test.each(['locked', 'unavailable'])(
    'live provider %s refuses before recovery and retries immediately after restoration',
    (state) => {
      const held = writer();
      mockLinuxSecretServiceState.mockReturnValue(state);
      expect(getSafeStorageStatus().state).toBe(state);
      expect(held.isEncryptionAvailable()).toBe(false);
      expect(() => held.encryptString('secret')).toThrow(SafeStorageWriteError);
      expect(mockRecoveryProbe).not.toHaveBeenCalled();
      mockLinuxSecretServiceState.mockReturnValue('secure');
      expect(held.encryptString('retry')).toEqual(
        Buffer.from('recovered:retry'),
      );
    },
  );

  test('healthy native availability retains the original cipher path without helper', () => {
    mockAvailable.mockReturnValue(true);
    expect(writer().encryptString('native')).toBe(ciphertext);
    expect(writer().isEncryptionAvailable()).toBe(true);
    expect(getReadableSafeStorage()?.decryptString(ciphertext)).toBe(
      'readable-secret',
    );
    expect(mockRecoveryProbe).not.toHaveBeenCalled();
    expect(mockRecoveryEncrypt).not.toHaveBeenCalled();
    expect(mockRecoveryDecrypt).not.toHaveBeenCalled();
  });

  test.each(['encrypt', 'decrypt'])(
    'helper %s failure preserves ciphertext, invalidates readiness and retries fresh',
    (operation) => {
      expect(getSafeStorageStatus().state).toBe('secure');
      const original = Buffer.from('recovered:retained');
      const fail = (): never => {
        throw new Error('private native diagnostic');
      };
      if (operation === 'encrypt')
        mockRecoveryEncrypt.mockImplementationOnce(fail);
      else mockRecoveryDecrypt.mockImplementationOnce(fail);
      expect(() =>
        operation === 'encrypt'
          ? writer().encryptString('secret')
          : writer().decryptString(original),
      ).toThrow();
      expect(original).toEqual(Buffer.from('recovered:retained'));
      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(mockDecrypt).not.toHaveBeenCalled();
      expect(writer().encryptString('retry')).toEqual(
        Buffer.from('recovered:retry'),
      );
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(2);
    },
  );

  test.each(['false', 'timeout'])(
    'failed helper %s is bounded across background read/status bursts with non-sliding expiry and live Retry',
    (failure) => {
      let now = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockRecoveryProbe.mockImplementation((): boolean => {
        if (failure === 'timeout') throw new Error('helper timeout');
        return false;
      });
      const held = getReadableSafeStorage({ forSpawn: true });
      expect(held?.isEncryptionAvailable()).toBe(false);
      for (let i = 0; i < 25; i += 1) {
        now = i * 30;
        expect(held?.isEncryptionAvailable()).toBe(false);
        expect(getSafeStorageStatus({ forSpawn: true }).state).toBe(
          'unavailable',
        );
      }
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
      now = 999;
      expect(held?.isEncryptionAvailable()).toBe(false);
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
      now = 1000;
      expect(held?.isEncryptionAvailable()).toBe(false);
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(2);
      // Explicit diagnostics/write Retry bypass even a just-recorded denial.
      expect(getSafeStorageStatus().state).toBe('unavailable');
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(3);
      mockRecoveryProbe.mockReturnValue(true);
      expect(writer().encryptString('retry')).toEqual(
        Buffer.from('recovered:retry'),
      );
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(4);
      const liveChecks = mockLinuxSecretServiceState.mock.calls.length;
      for (let i = 0; i < 25; i += 1) {
        expect(held?.isEncryptionAvailable()).toBe(true);
        expect(getSafeStorageStatus({ forSpawn: true }).state).toBe('secure');
      }
      expect(mockRecoveryProbe).toHaveBeenCalledTimes(4);
      expect(mockLinuxSecretServiceState).toHaveBeenCalledTimes(liveChecks);
    },
  );

  test('failed helper backoff never blocks healthy native recovery', () => {
    mockRecoveryProbe.mockReturnValue(false);
    const held = getReadableSafeStorage({ forSpawn: true });
    expect(held?.isEncryptionAvailable()).toBe(false);
    mockAvailable.mockReturnValue(true);
    expect(held?.isEncryptionAvailable()).toBe(true);
    expect(mockRecoveryProbe).toHaveBeenCalledTimes(1);
  });
});
