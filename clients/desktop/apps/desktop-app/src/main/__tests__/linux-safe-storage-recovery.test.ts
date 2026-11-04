import {
  decryptWithLinuxSafeStorageRecovery,
  encryptWithLinuxSafeStorageRecovery,
  probeLinuxSafeStorageRecovery,
} from '../lib/linux-safe-storage-recovery';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import type { RmOptions } from 'node:fs';
import type * as FsModule from 'node:fs';

const mockHost = jest.fn(() => 'linux');
const mockSpawn = jest.fn<
  SpawnSyncReturns<Buffer>,
  [string, readonly string[], SpawnSyncOptions]
>();
const mockCreateProfile = jest.fn(
  () => '/private/tmp/canopy-safe-storage-test',
);
const mockChmod = jest.fn<void, [string, number]>();
const mockRemoveProfile = jest.fn<void, [string, RmOptions]>();
const mockReady = jest.fn(() => true);
const mockGetAppPath = jest.fn(() => '/application');
const mockApp = {
  isReady: mockReady,
  isPackaged: true,
  getAppPath: mockGetAppPath,
};
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => mockHost(),
}));
jest.mock('electron', () => ({ app: mockApp }));
jest.mock('node:child_process', () => ({
  spawnSync: (
    file: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ): SpawnSyncReturns<Buffer> => mockSpawn(file, args, options),
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof FsModule>('node:fs'),
  mkdtempSync: (): unknown => mockCreateProfile(),
  chmodSync: (path: string, mode: number): void => mockChmod(path, mode),
  rmSync: (path: string, options: RmOptions): void =>
    mockRemoveProfile(path, options),
}));

const originalElectron = Object.getOwnPropertyDescriptor(
  process.versions,
  'electron',
);
const originalType = Object.getOwnPropertyDescriptor(process, 'type');
const originalEnv = process.env;
const cipher = Buffer.from('v11native-ciphertext');

function reply(value: unknown): void {
  mockSpawn.mockReturnValue(
    childResult({
      output: [null, null, null, Buffer.from(JSON.stringify(value))],
    }),
  );
}

function childResult(
  overrides: Partial<SpawnSyncReturns<Buffer>>,
): SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    status: 0,
    signal: null,
    error: undefined,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    output: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: '42.3.0',
  });
  Object.defineProperty(process, 'type', {
    configurable: true,
    value: 'browser',
  });
  mockHost.mockReturnValue('linux');
  mockApp.isPackaged = true;
  mockReady.mockReturnValue(true);
  mockCreateProfile.mockReturnValue('/private/tmp/canopy-safe-storage-test');
  reply({ version: 1, ok: true, operation: 'probe' });
});

afterAll(() => {
  if (originalElectron)
    Object.defineProperty(process.versions, 'electron', originalElectron);
  else Reflect.deleteProperty(process.versions, 'electron');
  if (originalType) Object.defineProperty(process, 'type', originalType);
  else Reflect.deleteProperty(process, 'type');
});

afterEach(() => {
  process.env = originalEnv;
});

test('recovers a poisoned parent using spawnSync native children for each cipher operation', () => {
  expect(probeLinuxSafeStorageRecovery()).toBe(true);
  reply({
    version: 1,
    ok: true,
    operation: 'encrypt',
    ciphertext: cipher.toString('base64'),
  });
  expect(encryptWithLinuxSafeStorageRecovery('private-value')).toEqual(cipher);
  reply({ version: 1, ok: true, operation: 'decrypt', text: 'private-value' });
  expect(decryptWithLinuxSafeStorageRecovery(cipher)).toBe('private-value');
  expect(mockSpawn).toHaveBeenCalledTimes(3);
  expect(mockCreateProfile).toHaveBeenCalledTimes(3);
  expect(mockRemoveProfile).toHaveBeenCalledTimes(3);
});

test.each(['darwin', 'win32'])('never starts recovery on %s', (platform) => {
  mockHost.mockReturnValue(platform);
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
  expect(() => encryptWithLinuxSafeStorageRecovery('private-value')).toThrow(
    'Secure storage recovery unavailable.',
  );
  expect(mockSpawn).not.toHaveBeenCalled();
  expect(mockCreateProfile).not.toHaveBeenCalled();
});

test('Node, utility and not-ready contexts refuse without spawning', () => {
  Reflect.deleteProperty(process.versions, 'electron');
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: '42.3.0',
  });
  Object.defineProperty(process, 'type', {
    configurable: true,
    value: 'utility',
  });
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
  Object.defineProperty(process, 'type', {
    configurable: true,
    value: 'browser',
  });
  mockReady.mockReturnValue(false);
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
  expect(mockSpawn).not.toHaveBeenCalled();
});

test('uses the same packaged executable, private pipes and sanitized environment, never secret argv', () => {
  process.env = {
    HOME: '/home/native-user',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require evil',
    LD_PRELOAD: 'evil.so',
    BASH_ENV: '/evil',
    GH_TOKEN: 'unrelated-secret',
    LC_API_KEY: 'unrelated-secret',
    LC_ALL: 'C.UTF-8',
  };
  reply({
    version: 1,
    ok: true,
    operation: 'encrypt',
    ciphertext: cipher.toString('base64'),
  });
  encryptWithLinuxSafeStorageRecovery('private-value');
  const call = mockSpawn.mock.calls[0];
  expect(call?.[0]).toBe(process.execPath);
  expect(call?.[1]).toEqual([]);
  const options = call?.[2];
  if (!options) throw new Error('Expected child options.');
  expect(options).toMatchObject({
    input: JSON.stringify({
      version: 1,
      operation: 'encrypt',
      text: 'private-value',
    }),
    stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    timeout: 8000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(options.env).toMatchObject({
    HOME: '/home/native-user',
    DISPLAY: ':1',
    CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE: '1',
    CANOPY_LINUX_SAFE_STORAGE_HELPER_PROFILE:
      '/private/tmp/canopy-safe-storage-test',
  });
  expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  expect(options.env).not.toHaveProperty('NODE_OPTIONS');
  expect(options.env).not.toHaveProperty('LD_PRELOAD');
  expect(options.env).not.toHaveProperty('BASH_ENV');
  expect(options.env).not.toHaveProperty('GH_TOKEN');
  expect(options.env).not.toHaveProperty('LC_API_KEY');
  expect(options.env?.LC_ALL).toBe('C.UTF-8');
  expect(mockChmod).toHaveBeenCalledWith(
    '/private/tmp/canopy-safe-storage-test',
    0o700,
  );
  expect(mockRemoveProfile).toHaveBeenCalledWith(
    '/private/tmp/canopy-safe-storage-test',
    { recursive: true, force: true },
  );
});

test('development passes only the existing application path, never flags', () => {
  mockApp.isPackaged = false;
  expect(probeLinuxSafeStorageRecovery()).toBe(true);
  expect(mockSpawn.mock.calls[0]?.[1]).toEqual(['/application']);
});

test('a timed-out child is opaque, cleaned up and retried with a fresh child', () => {
  mockSpawn.mockReturnValue(
    childResult({
      status: null,
      signal: 'SIGKILL',
      error: new Error('private-value'),
      output: [],
    }),
  );
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
  let error: unknown;
  try {
    encryptWithLinuxSafeStorageRecovery('private-value');
  } catch (caught) {
    error = caught;
  }
  expect(error).toEqual(new Error('Secure storage recovery unavailable.'));
  expect(error).not.toHaveProperty('cause');
  reply({ version: 1, ok: true, operation: 'probe' });
  expect(probeLinuxSafeStorageRecovery()).toBe(true);
  expect(mockSpawn).toHaveBeenCalledTimes(3);
  expect(mockRemoveProfile).toHaveBeenCalledTimes(3);
});

test.each([
  { version: 1, ok: true, operation: 'probe', extra: 'private-value' },
  { version: 1, ok: false, cause: 'private-value' },
  { version: 2, ok: true, operation: 'probe' },
  { version: 1, ok: true, operation: 'decrypt', text: 'private-value' },
])('rejects malformed or mismatched private responses', (response) => {
  reply(response);
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
});

test.each(['YQ', 'YQ===', 'YR==', 'Y Q==', '!!!!'])(
  'rejects noncanonical base64 %s',
  (ciphertext) => {
    reply({ version: 1, ok: true, operation: 'encrypt', ciphertext });
    expect(() => encryptWithLinuxSafeStorageRecovery('private-value')).toThrow(
      'Secure storage recovery unavailable.',
    );
  },
);

test('rejects oversized requests before creating a child and oversized responses', () => {
  expect(() =>
    encryptWithLinuxSafeStorageRecovery('x'.repeat(4 * 1024 * 1024)),
  ).toThrow('Secure storage recovery unavailable.');
  expect(mockSpawn).not.toHaveBeenCalled();
  mockSpawn.mockReturnValue(
    childResult({
      status: 0,
      signal: null,
      output: [null, null, null, Buffer.alloc(4 * 1024 * 1024 + 1)],
    }),
  );
  expect(probeLinuxSafeStorageRecovery()).toBe(false);
});

test.each(['unavailable', 'decrypt-failed'])(
  'projects %s into portable read metadata without native diagnostics',
  (reason) => {
    reply(
      reason === 'decrypt-failed'
        ? { version: 1, ok: false, reason, operation: 'decrypt' }
        : { version: 1, ok: false, reason },
    );
    let error: unknown;
    try {
      decryptWithLinuxSafeStorageRecovery(cipher);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      secureStorageFailure: {
        version: 1,
        operation: 'read',
        backend: 'gnome_libsecret',
        code:
          reason === 'decrypt-failed'
            ? 'SECURE_STORAGE_DECRYPT_FAILED'
            : 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: reason === 'decrypt-failed' ? 'secure' : 'unavailable',
        retryable: reason !== 'decrypt-failed',
      },
    });
    expect(error).not.toHaveProperty('cause');
  },
);

test('timeout carrying an apparent decrypt failure remains transport unavailability', () => {
  mockSpawn.mockReturnValue(
    childResult({
      status: null,
      signal: 'SIGKILL',
      error: new Error('private'),
      output: [
        null,
        null,
        null,
        Buffer.from(
          JSON.stringify({
            version: 1,
            ok: false,
            reason: 'decrypt-failed',
            operation: 'decrypt',
          }),
        ),
      ],
    }),
  );
  let error: unknown;
  try {
    decryptWithLinuxSafeStorageRecovery(cipher);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    secureStorageFailure: {
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      state: 'unavailable',
      retryable: true,
    },
  });
});
