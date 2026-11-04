import { execFileSync, spawnSync } from 'node:child_process';
import { getLinuxSecretServiceState } from '../lib/linux-secret-service';
import { getSafeStorageStatus } from '../lib/safe-storage';

const mockAvailable = jest.fn<unknown, []>(() => true);
let mockStorage: object | undefined;
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  get safeStorage(): object | undefined {
    return mockStorage;
  },
}));
jest.mock('node:child_process', () => ({
  execFileSync: jest.fn(() => {
    throw new Error('Unit storage must not probe the host');
  }),
  spawnSync: jest.fn(() => {
    throw new Error('Unit storage must not launch a helper');
  }),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
beforeEach(() => {
  jest.clearAllMocks();
  mockAvailable.mockReturnValue(true);
  mockStorage = {
    isEncryptionAvailable: mockAvailable,
    getSelectedStorageBackend: (): string => 'gnome_libsecret',
    encryptString: (text: string): Buffer => Buffer.from(text),
    decryptString: (bytes: Buffer): string => bytes.toString(),
  };
  Object.defineProperty(process, 'platform', { value: 'linux' });
});
afterEach(() => {
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test('pairs mocked native availability with a live synthetic provider', () => {
  expect(getLinuxSecretServiceState()).toBe('secure');
  expect(getSafeStorageStatus()).toEqual({
    state: 'secure',
    backend: 'gnome_libsecret',
  });
  mockAvailable.mockReturnValue(false);
  expect(getLinuxSecretServiceState()).toBe('unavailable');
  mockAvailable.mockReturnValue(true);
  expect(getLinuxSecretServiceState()).toBe('secure');
});

test.each([false, undefined, null, 'true'])(
  'does not authorize mocked availability %p',
  (available) => {
    mockAvailable.mockReturnValue(available);
    expect(getLinuxSecretServiceState()).toBe('unavailable');
  },
);

test('missing and throwing native mocks remain unavailable', () => {
  mockStorage = undefined;
  expect(getLinuxSecretServiceState()).toBe('unavailable');
  mockStorage = { isEncryptionAvailable: mockAvailable };
  mockAvailable.mockImplementationOnce(() => {
    throw new Error('mock native unavailable');
  });
  expect(getLinuxSecretServiceState()).toBe('unavailable');
});
