jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  statSync: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getGitHubPatFilePath: jest.fn(() => '/mock/secure/github-pat.enc'),
  getLegacyGitHubPatFilePath: jest.fn(
    () => '/mock/legacy/secure/github-pat.enc',
  ),
}));
let mockBackend = 'gnome_libsecret';
const mockAvailable = jest.fn(() => true);
const mockDecrypt = jest.fn((encrypted: Buffer) => encrypted.toString('utf8'));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: mockAvailable,
    decryptString: mockDecrypt,
    encryptString: jest.fn(),
    getSelectedStorageBackend: (): string => mockBackend,
  },
}));
jest.mock('../pipelines/config-paths', () => ({
  registerSecretsEnvInjector: jest.fn(),
}));
let migrationLoadCount = 0;
const mockLoadStoredPat = jest.fn((): Promise<string> => {
  migrationLoadCount += 1;
  return Promise.resolve('');
});
jest.mock('../lib/github-auth', () => ({
  loadStoredPat: mockLoadStoredPat,
}));

import { readFileSync, statSync, type Stats } from 'node:fs';
import { registerSecretsEnvInjector } from '../pipelines/config-paths';
import {
  initializeGitHubPatEnvRuntime,
  invalidateGitHubPatEnvCache,
} from '../lib/github-pat-env';

const readFileSyncMock = jest.mocked(readFileSync);
const registerSecretsEnvInjectorMock = jest.mocked(registerSecretsEnvInjector);
const statSyncMock = jest.mocked(statSync);
let injector: () => Record<string, string>;

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function statWithMtime(mtimeMs: number): Stats {
  const timestamp = new Date(mtimeMs);
  const stats: Stats = {
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: mtimeMs,
    mtimeMs,
    ctimeMs: mtimeMs,
    birthtimeMs: mtimeMs,
    atime: timestamp,
    mtime: timestamp,
    ctime: timestamp,
    birthtime: timestamp,
    isFile: () => true,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
  return stats;
}

beforeAll(() => {
  initializeGitHubPatEnvRuntime();
  const registered = registerSecretsEnvInjectorMock.mock.calls[0]?.[0];
  if (!registered) {
    throw new Error('Expected GitHub PAT environment injector registration');
  }
  injector = registered;
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateGitHubPatEnvCache();
  mockBackend = 'gnome_libsecret';
  mockAvailable.mockReturnValue(true);
  mockDecrypt.mockImplementation((encrypted) => encrypted.toString('utf8'));
});

it('does not key PAT injection to the legacy file when the secure file has a real stat error', () => {
  statSyncMock.mockImplementation((path: string) => {
    if (path === '/mock/secure/github-pat.enc') {
      throw errnoError('EACCES');
    }
    return statWithMtime(123);
  });
  readFileSyncMock.mockImplementation((path: string) => {
    if (path === '/mock/secure/github-pat.enc') {
      throw errnoError('EACCES');
    }
    return Buffer.from('legacy-token');
  });

  expect(injector()).toEqual({});
  expect(statSyncMock).toHaveBeenCalledTimes(1);
  expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  expect(statSyncMock).not.toHaveBeenCalledWith(
    '/mock/legacy/secure/github-pat.enc',
  );
  expect(readFileSyncMock).not.toHaveBeenCalledWith(
    '/mock/legacy/secure/github-pat.enc',
  );
});

it('primes the asynchronous secure-store migration during initialization', () => {
  expect(migrationLoadCount).toBe(1);
});

it('reuses the decrypted PAT and refreshes immediately after explicit invalidation', () => {
  statSyncMock.mockReturnValue(statWithMtime(123));
  readFileSyncMock.mockReturnValue(Buffer.from('first-token'));

  expect(injector()).toEqual({ GH_TOKEN: 'first-token' });
  expect(injector()).toEqual({ GH_TOKEN: 'first-token' });
  expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  expect(statSyncMock).toHaveBeenCalledTimes(1);

  readFileSyncMock.mockReturnValue(Buffer.from('refreshed-token'));
  invalidateGitHubPatEnvCache();

  expect(injector()).toEqual({ GH_TOKEN: 'refreshed-token' });
  expect(readFileSyncMock).toHaveBeenCalledTimes(2);
  expect(statSyncMock).toHaveBeenCalledTimes(2);
});

it('detects an out-of-band PAT edit after the mtime safety interval', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  statSyncMock.mockReturnValue(statWithMtime(123));
  readFileSyncMock.mockReturnValue(Buffer.from('first-token'));

  expect(injector()).toEqual({ GH_TOKEN: 'first-token' });

  statSyncMock.mockReturnValue(statWithMtime(124));
  readFileSyncMock.mockReturnValue(Buffer.from('external-token'));
  now.mockReturnValue(11_001);

  expect(injector()).toEqual({ GH_TOKEN: 'external-token' });
  expect(readFileSyncMock).toHaveBeenCalledTimes(2);
  now.mockRestore();
});

it('omits cached secrets while locked and retries unchanged bytes on unlock', () => {
  statSyncMock.mockReturnValue(statWithMtime(123));
  readFileSyncMock.mockReturnValue(Buffer.from('original-token'));
  expect(injector()).toEqual({ GH_TOKEN: 'original-token' });
  mockAvailable.mockReturnValue(false);
  expect(injector()).toEqual({});
  mockAvailable.mockReturnValue(true);
  expect(injector()).toEqual({ GH_TOKEN: 'original-token' });
});
it('retries failed decryption with unchanged mtime on the next spawn', () => {
  statSyncMock.mockReturnValue(statWithMtime(123));
  readFileSyncMock.mockReturnValue(Buffer.from('original-token'));
  mockDecrypt.mockImplementationOnce(() => {
    throw new Error('private native diagnostic');
  });
  expect(injector()).toEqual({});
  expect(injector()).toEqual({ GH_TOKEN: 'original-token' });
});
it('reloads the same file after libsecret becomes unavailable and recovers', () => {
  statSyncMock.mockReturnValue(statWithMtime(123));
  readFileSyncMock.mockReturnValue(Buffer.from('original-token'));
  expect(injector()).toEqual({ GH_TOKEN: 'original-token' });
  mockBackend = 'unknown';
  mockAvailable.mockReturnValue(false);
  expect(injector()).toEqual({});
  mockBackend = 'gnome_libsecret';
  mockAvailable.mockReturnValue(true);
  expect(injector()).toEqual({ GH_TOKEN: 'original-token' });
});
