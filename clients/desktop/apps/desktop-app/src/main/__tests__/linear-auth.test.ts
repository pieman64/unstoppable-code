jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
}));
jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/paths', () => ({
  getLinearTokenFilePath: jest.fn(() => '/mock/secure/linear-token.enc'),
  getInternalLegacySharedLinearTokenFilePath: jest.fn(() => null),
  getLegacyLinearTokenFilePath: jest.fn(
    () => '/mock/legacy/secure/linear-token.enc',
  ),
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((value: string) =>
      Buffer.from(`internal:${value}`, 'utf8'),
    ),
    decryptString: jest.fn((encrypted: Buffer) =>
      encrypted.toString('utf8').replace(/^legacy:/, ''),
    ),
    getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
  },
}));
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' | 'unavailable' | 'locked' =>
    'secure',
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => 'linux',
}));

import { readFile } from 'node:fs/promises';
import { getInternalLegacySharedLinearTokenFilePath } from '../lib/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  invalidateLinearTokenCache,
  resolveLinearToken,
  readStoredLinearTokenWithStatus,
} from '../lib/linear-auth';

const readFileMock = jest.mocked(readFile);
const internalLegacyPathMock = jest.mocked(
  getInternalLegacySharedLinearTokenFilePath,
);
const atomicWriteMock = jest.mocked(writeFileAtomically);
const mockNativeStorage = jest.requireMock<{
  safeStorage: Record<
    | 'isEncryptionAvailable'
    | 'encryptString'
    | 'decryptString'
    | 'getSelectedStorageBackend',
    jest.Mock
  >;
}>('electron').safeStorage;

function missingFileError(): Error & { code: 'ENOENT' } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' as const });
}

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateLinearTokenCache();
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue(
    'gnome_libsecret',
  );
  mockNativeStorage.decryptString.mockImplementation((encrypted: Buffer) =>
    encrypted.toString('utf8').replace(/^legacy:/, ''),
  );
  internalLegacyPathMock.mockReturnValue(null);
  atomicWriteMock.mockResolvedValue(undefined);
});

it('decrypts and re-encrypts the former shared production Linear token', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/linear-token.enc');
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:legacy-linear-token'));

  await expect(resolveLinearToken()).resolves.toBe('legacy-linear-token');
  expect(atomicWriteMock).toHaveBeenCalledWith(
    '/mock/secure/linear-token.enc',
    Buffer.from('internal:legacy-linear-token'),
    { mode: 0o600, overwrite: false },
  );
});

it('falls back to the legacy Linear token only when the secure token is missing', async () => {
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy-linear-token'));

  await expect(resolveLinearToken()).resolves.toBe('legacy-linear-token');
  expect(readFileMock).toHaveBeenNthCalledWith(
    1,
    '/mock/secure/linear-token.enc',
  );
  expect(readFileMock).toHaveBeenNthCalledWith(
    2,
    '/mock/legacy/secure/linear-token.enc',
  );
});

it('does not fall back to the legacy Linear token on real secure-file read errors', async () => {
  readFileMock.mockRejectedValueOnce(errnoError('EACCES'));

  await expect(resolveLinearToken()).resolves.toBe('');
  expect(readFileMock).toHaveBeenCalledTimes(1);
});

it('retains a typed unavailable read and retries after backend recovery', async () => {
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  await expect(readStoredLinearTokenWithStatus()).resolves.toMatchObject({
    status: 'storage-error',
    failure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
  });
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(true);
  await expect(resolveLinearToken()).resolves.toBe('fixture-token');
  expect(atomicWriteMock).not.toHaveBeenCalled();
});

it('reports unavailable libsecret without persistence or legacy fallback', async () => {
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue('unknown');
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  await expect(readStoredLinearTokenWithStatus()).resolves.toMatchObject({
    status: 'storage-error',
    failure: {
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      state: 'unavailable',
      backend: 'unknown',
      retryable: true,
    },
  });
  expect(readFileMock).toHaveBeenCalledTimes(1);
  expect(mockNativeStorage.decryptString).not.toHaveBeenCalled();
  expect(mockNativeStorage.encryptString).not.toHaveBeenCalled();
  expect(atomicWriteMock).not.toHaveBeenCalled();
});

it('distinguishes disk errors from confirmed absence', async () => {
  readFileMock.mockRejectedValueOnce(errnoError('EACCES'));
  await expect(readStoredLinearTokenWithStatus()).resolves.toMatchObject({
    status: 'error',
  });
  expect(readFileMock).toHaveBeenCalledTimes(1);
});

it('rechecks a cached token and recovers without the missing-token TTL', async () => {
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  await expect(resolveLinearToken()).resolves.toBe('fixture-token');
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  await expect(resolveLinearToken()).resolves.toBe('');
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue(
    'gnome_libsecret',
  );
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(true);
  await expect(resolveLinearToken()).resolves.toBe('fixture-token');
});

it('retains decoded legacy Linear token when migration encryption is refused', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/linear-token.enc');
  mockNativeStorage.decryptString.mockImplementationOnce((raw: Buffer) => {
    mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
    return raw.toString('utf8').replace(/^legacy:/, '');
  });
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:fixture-token'));
  await expect(readStoredLinearTokenWithStatus()).resolves.toMatchObject({
    status: 'ok',
    value: 'fixture-token',
    migrationWriteFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
  });
  expect(atomicWriteMock).not.toHaveBeenCalled();
});

it('retries legacy migration after a temporary filesystem write failure without waiting for cache expiry', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/token.enc');
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:fixture-token'));
  atomicWriteMock.mockRejectedValueOnce(errnoError('EACCES'));
  await resolveLinearToken();
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:fixture-token'));
  await resolveLinearToken();
  expect(atomicWriteMock).toHaveBeenCalledTimes(2);
});
