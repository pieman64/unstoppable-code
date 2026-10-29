import {
  getReadableSafeStorage,
  getSafeStorageStatus,
  getWritableSafeStorage,
  SafeStorageWriteError,
  type SafeStorageBackendState,
  type WritableSafeStorage,
} from '../lib/safe-storage';
import type * as SafeStorageModule from '../lib/safe-storage';

const ciphertext = Buffer.from('native-ciphertext');
const mockEncrypt = jest.fn<Buffer, [string]>(() => ciphertext);
const mockDecrypt = jest.fn<string, [Buffer]>(() => 'readable-secret');
const mockAvailable = jest.fn<boolean, []>(() => true);
const mockBackend = jest.fn<unknown, []>(() => 'gnome_libsecret');
const mockReady = jest.fn<unknown, []>(() => true);
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

const secureBackends = ['gnome_libsecret'];
for (const backend of secureBackends) {
  test.each([true, false])(`${backend}, available=%s`, (available) => {
    mockBackend.mockReturnValue(backend);
    mockAvailable.mockReturnValue(available);
    expect(getSafeStorageStatus()).toEqual({
      state: available ? 'secure' : 'locked',
      backend,
    });
    if (available) {
      expect(writer().encryptString('original-secret')).toBe(ciphertext);
      expect(mockEncrypt).toHaveBeenCalledWith('original-secret');
    } else expectRefusal('locked', backend);
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
test('availability exception denies before backend lookup', () => {
  mockAvailable.mockImplementation(() => {
    throw new Error('availability failed');
  });
  expect(getSafeStorageStatus()).toEqual({
    state: 'unavailable',
    backend: null,
  });
  expectRefusal('unavailable', null);
  expect(mockBackend).not.toHaveBeenCalled();
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
    expect(mockBackend).not.toHaveBeenCalled();
  },
);
test('availability is sampled once before backend lookup', () => {
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
    expect(mockBackend).not.toHaveBeenCalled();
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
    if (state === 'locked') mockAvailable.mockReturnValue(false);
    else mockBackend.mockReturnValue(state);
    expect(() => encrypt('after')).toThrow(SafeStorageWriteError);
    expect(mockEncrypt).not.toHaveBeenCalled();
    mockBackend.mockReturnValue('gnome_libsecret');
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
  expect(mockBackend).not.toHaveBeenCalled();
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
