import { runLinuxSafeStorageHelper } from '../lib/linux-safe-storage-helper';
import { getRuntimeAppName } from '../lib/app-identity';
import type * as FsModule from 'node:fs';
import {
  LINUX_SAFE_STORAGE_MAX_BYTES,
  parseLinuxSafeStorageRequest,
  parseLinuxSafeStorageResponse,
} from '../lib/linux-safe-storage-helper-protocol';

const mockHost = jest.fn(() => 'linux');
const mockLive = jest.fn(() => 'secure');
const mockNativeAvailable = jest.fn(() => true);
const mockBackend = jest.fn(() => 'gnome_libsecret');
const mockEncrypt = jest.fn<Buffer, [string]>(() =>
  Buffer.from('v11native-ciphertext'),
);
const mockDecrypt = jest.fn<string, [Buffer]>(() => 'private-value');
const mockExit = jest.fn<void, [number]>();
const mockSetName = jest.fn<void, [string]>();
const mockSetPath = jest.fn<void, [string, string]>();
const mockAppendSwitch = jest.fn<void, [string, string]>();
const mockPlaintext = jest.fn<void, [boolean]>();
const mockWhenReady = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockReady = jest.fn(() => false);
const mockStat = jest.fn(() => ({
  isDirectory: (): boolean => true,
  isSymbolicLink: (): boolean => false,
  mode: 0o40700,
  uid: process.getuid?.(),
}));
const mockPipeStat = jest.fn(() => ({
  isFIFO: (): boolean => false,
  isSocket: (): boolean => true,
}));
let mockInput = Buffer.alloc(0);
const mockWrites: Buffer[] = [];
const mockRead = jest.fn(
  (fd: number, buffer: Buffer, offset: number, length: number) => {
    expect(fd).toBe(0);
    const size = Math.min(length, mockInput.length);
    mockInput.copy(buffer, offset, 0, size);
    mockInput = mockInput.subarray(size);
    return size;
  },
);
const mockWrite = jest.fn(
  (fd: number, buffer: Buffer, offset: number, length: number) => {
    expect(fd).toBe(3);
    // A partial write must be completed before exit, not truncated silently.
    const size = Math.min(length, 11);
    mockWrites.push(Buffer.from(buffer.subarray(offset, offset + size)));
    return size;
  },
);
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => mockHost(),
}));
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): string => mockLive(),
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof FsModule>('node:fs'),
  lstatSync: (): unknown => mockStat(),
  fstatSync: (fd: number): unknown => {
    expect(fd).toBe(3);
    return mockPipeStat();
  },
  readSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ): number => mockRead(fd, buffer, offset, length),
  writeSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ): number => mockWrite(fd, buffer, offset, length),
}));
jest.mock('electron', () => ({
  app: {
    isReady: (): boolean => mockReady(),
    whenReady: (): Promise<void> => mockWhenReady(),
    setName: (name: string): void => mockSetName(name),
    setPath: (name: string, path: string): void => mockSetPath(name, path),
    commandLine: {
      appendSwitch: (name: string, value: string): void =>
        mockAppendSwitch(name, value),
    },
    exit: (code: number): void => mockExit(code),
  },
  safeStorage: {
    setUsePlainTextEncryption: (value: boolean): void => mockPlaintext(value),
    isEncryptionAvailable: (): boolean => mockNativeAvailable(),
    getSelectedStorageBackend: (): string => mockBackend(),
    encryptString: (text: string): Buffer => mockEncrypt(text),
    decryptString: (ciphertext: Buffer): string => mockDecrypt(ciphertext),
  },
}));

const originalElectron = Object.getOwnPropertyDescriptor(
  process.versions,
  'electron',
);
const originalType = Object.getOwnPropertyDescriptor(process, 'type');
const originalEnv = process.env;

function request(value: unknown): void {
  mockInput = Buffer.from(JSON.stringify(value));
}
function response(): unknown {
  return JSON.parse(Buffer.concat(mockWrites).toString('utf8'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  request({ version: 1, operation: 'probe' });
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: '42.3.0',
  });
  Object.defineProperty(process, 'type', {
    configurable: true,
    value: 'browser',
  });
  process.env = {
    ...originalEnv,
    CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE: '1',
    CANOPY_LINUX_SAFE_STORAGE_HELPER_PROFILE:
      '/private/tmp/canopy-safe-storage-helper-test',
  };
  mockHost.mockReturnValue('linux');
  mockLive.mockReturnValue('secure');
  mockNativeAvailable.mockReturnValue(true);
  mockBackend.mockReturnValue('gnome_libsecret');
  mockReady.mockReturnValue(false);
  mockEncrypt.mockReturnValue(Buffer.from('v11native-ciphertext'));
  mockPipeStat.mockReturnValue({
    isFIFO: (): boolean => false,
    isSocket: (): boolean => true,
  });
});

afterEach(() => {
  process.env = originalEnv;
});
afterAll(() => {
  if (originalElectron)
    Object.defineProperty(process.versions, 'electron', originalElectron);
  else Reflect.deleteProperty(process.versions, 'electron');
  if (originalType) Object.defineProperty(process, 'type', originalType);
  else Reflect.deleteProperty(process, 'type');
});

test('initializes identical brand identity in an isolated profile and writes only fd3 before exit', async () => {
  await runLinuxSafeStorageHelper();
  expect(mockSetName).toHaveBeenCalledWith(getRuntimeAppName());
  expect(mockSetPath.mock.calls).toEqual([
    ['userData', '/private/tmp/canopy-safe-storage-helper-test'],
    ['sessionData', '/private/tmp/canopy-safe-storage-helper-test'],
  ]);
  expect(mockAppendSwitch.mock.calls).toEqual([
    ['password-store', 'gnome-libsecret'],
  ]);
  expect(mockPlaintext).toHaveBeenCalledWith(false);
  expect(mockSetName.mock.invocationCallOrder[0]).toBeLessThan(
    mockWhenReady.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mockSetPath.mock.invocationCallOrder[1]).toBeLessThan(
    mockWhenReady.mock.invocationCallOrder[0] ?? 0,
  );
  expect(response()).toEqual({ version: 1, ok: true, operation: 'probe' });
  expect(mockEncrypt).not.toHaveBeenCalled();
  expect(mockDecrypt).not.toHaveBeenCalled();
  expect(mockExit).toHaveBeenCalledWith(0);
  expect(
    mockWrite.mock.invocationCallOrder[
      mockWrite.mock.invocationCallOrder.length - 1
    ],
  ).toBeLessThan(mockExit.mock.invocationCallOrder[0] ?? 0);
});

test('refuses regular-file response fd before consuming or decrypting the request', async () => {
  mockPipeStat.mockReturnValueOnce({
    isFIFO: (): boolean => false,
    isSocket: (): boolean => false,
  });
  request({
    version: 1,
    operation: 'decrypt',
    ciphertext: Buffer.from('v11old-ciphertext').toString('base64'),
  });
  await runLinuxSafeStorageHelper();
  expect(mockExit).toHaveBeenCalledWith(1);
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockDecrypt).not.toHaveBeenCalled();
  expect(mockNativeAvailable).not.toHaveBeenCalled();
});

test('accepts an anonymous FIFO response pipe as well as a Unix socketpair', async () => {
  mockPipeStat.mockReturnValueOnce({
    isFIFO: (): boolean => true,
    isSocket: (): boolean => false,
  });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: true, operation: 'probe' });
});

test('delegates encryption/decryption unchanged to real native API, not new cryptography', async () => {
  request({ version: 1, operation: 'encrypt', text: 'private-value' });
  await runLinuxSafeStorageHelper();
  expect(mockEncrypt).toHaveBeenCalledWith('private-value');
  expect(response()).toEqual({
    version: 1,
    ok: true,
    operation: 'encrypt',
    ciphertext: Buffer.from('v11native-ciphertext').toString('base64'),
  });
  mockWrites.length = 0;
  request({
    version: 1,
    operation: 'decrypt',
    ciphertext: Buffer.from('v11old-ciphertext').toString('base64'),
  });
  await runLinuxSafeStorageHelper();
  expect(mockDecrypt).toHaveBeenCalledWith(Buffer.from('v11old-ciphertext'));
  expect(response()).toEqual({
    version: 1,
    ok: true,
    operation: 'decrypt',
    text: 'private-value',
  });
});

test.each(['locked', 'unavailable'])(
  'refuses %s service before native initialization',
  async (state) => {
    mockLive.mockReturnValue(state);
    request({ version: 1, operation: 'encrypt', text: 'private-value' });
    await runLinuxSafeStorageHelper();
    expect(mockNativeAvailable).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(response()).toEqual({
      version: 1,
      ok: false,
      reason: 'unavailable',
    });
    expect(mockExit).toHaveBeenCalledWith(0);
  },
);

test('refuses native failure or basic backend without encryption', async () => {
  mockNativeAvailable.mockReturnValue(false);
  request({ version: 1, operation: 'encrypt', text: 'private-value' });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  mockWrites.length = 0;
  mockNativeAvailable.mockReturnValue(true);
  mockBackend.mockReturnValue('basic_text');
  request({ version: 1, operation: 'encrypt', text: 'private-value' });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(mockEncrypt).not.toHaveBeenCalled();
});

test.each(['darwin', 'win32'])(
  'refuses %s without native initialization',
  async (platform) => {
    mockHost.mockReturnValue(platform);
    await runLinuxSafeStorageHelper();
    expect(response()).toEqual({
      version: 1,
      ok: false,
      reason: 'unavailable',
    });
    expect(mockSetName).not.toHaveBeenCalled();
    expect(mockNativeAvailable).not.toHaveBeenCalled();
  },
);

test('requires real Electron and helper mode and a private newly created profile', async () => {
  Reflect.deleteProperty(process.versions, 'electron');
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(mockSetPath).not.toHaveBeenCalled();
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: '42.3.0',
  });
  process.env.CANOPY_LINUX_SAFE_STORAGE_HELPER_PROFILE =
    '/real/application/profile';
  mockWrites.length = 0;
  request({ version: 1, operation: 'probe' });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(mockSetPath).not.toHaveBeenCalled();
});

test('native errors never escape the private failure response', async () => {
  mockEncrypt.mockImplementationOnce(() => {
    throw new Error('private-value');
  });
  request({ version: 1, operation: 'encrypt', text: 'private-value' });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(Buffer.concat(mockWrites).toString()).not.toContain('private-value');
});

test.each([
  { version: 1, operation: 'probe', extra: true },
  { version: 1, operation: 'encrypt', text: 7 },
  { version: 1, operation: 'decrypt', ciphertext: 'YR==' },
  { version: 1, operation: 'delete' },
])('malformed requests never reach native storage', async (value) => {
  request(value);
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(mockSetName).not.toHaveBeenCalled();
  expect(mockNativeAvailable).not.toHaveBeenCalled();
});

test('bounds request/response bytes and rejects plaintext fallback ciphertext', async () => {
  mockInput = Buffer.alloc(LINUX_SAFE_STORAGE_MAX_BYTES + 1, 32);
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  expect(mockNativeAvailable).not.toHaveBeenCalled();
  mockWrites.length = 0;
  request({ version: 1, operation: 'encrypt', text: 'private-value' });
  mockEncrypt.mockReturnValue(Buffer.from('v10insecure'));
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
  mockWrites.length = 0;
  request({ version: 1, operation: 'decrypt', ciphertext: '' });
  mockDecrypt.mockReturnValueOnce('x'.repeat(LINUX_SAFE_STORAGE_MAX_BYTES));
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({ version: 1, ok: false, reason: 'unavailable' });
});

test('strict wire protocol rejects trailing messages, extra keys and invalid UTF8', () => {
  expect(
    parseLinuxSafeStorageRequest(
      Buffer.from('{"version":1,"version":1,"operation":"probe"}'),
    ),
  ).toBeNull();
  expect(
    parseLinuxSafeStorageRequest(
      Buffer.from('{"version":1,"operation":"probe"}{}'),
    ),
  ).toBeNull();
  expect(
    parseLinuxSafeStorageResponse(
      Buffer.from('{"version":1,"ok":false,"cause":"private"}'),
    ),
  ).toBeNull();
  expect(
    parseLinuxSafeStorageRequest(
      Buffer.concat([
        Buffer.from('{"version":1,"operation":"encrypt","text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    ),
  ).toBeNull();
});

test('accepts canonical ciphertext near the wire limit without regex stack overflow', () => {
  const ciphertext = Buffer.alloc(3 * 1024 * 1024 - 128).toString('base64');
  expect(
    parseLinuxSafeStorageRequest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          operation: 'decrypt',
          ciphertext,
        }),
      ),
    ),
  ).toEqual({ version: 1, operation: 'decrypt', ciphertext });
});

test('only a native decrypt exception after secure preflight reports genuine ciphertext failure', async () => {
  request({
    version: 1,
    operation: 'decrypt',
    ciphertext: Buffer.from('v11bad').toString('base64'),
  });
  mockDecrypt.mockImplementationOnce(() => {
    throw new Error('private native cause');
  });
  await runLinuxSafeStorageHelper();
  expect(response()).toEqual({
    version: 1,
    ok: false,
    reason: 'decrypt-failed',
    operation: 'decrypt',
  });
  expect(mockExit).toHaveBeenCalledWith(0);
  expect(Buffer.concat(mockWrites).toString()).not.toContain('private');
});

test.each([
  { version: 1, ok: false },
  { version: 1, ok: false, reason: 'other' },
  { version: 1, ok: false, reason: 'decrypt-failed' },
  { version: 1, ok: false, reason: 'decrypt-failed', operation: 'encrypt' },
  { version: 1, ok: false, reason: 'unavailable', cause: 'private' },
])('rejects malformed failure responses', (value) => {
  expect(
    parseLinuxSafeStorageResponse(Buffer.from(JSON.stringify(value))),
  ).toBeNull();
});
