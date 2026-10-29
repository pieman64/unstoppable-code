jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
}));
jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/paths', () => ({
  getGitHubPatFilePath: jest.fn(() => '/mock/secure/github-pat.enc'),
  getInternalLegacySharedGitHubPatFilePath: jest.fn(() => null),
  getLegacyGitHubPatFilePath: jest.fn(
    () => '/mock/legacy/secure/github-pat.enc',
  ),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledGhBinaryPath: jest.fn(() => '/mock/bin/gh'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/mock/bin' })),
}));

const mockNativeStorage = {
  isEncryptionAvailable: jest.fn(() => true),
  encryptString: jest.fn((value: string) =>
    Buffer.from(`internal:${value}`, 'utf8'),
  ),
  decryptString: jest.fn((encrypted: Buffer) =>
    encrypted.toString('utf8').replace(/^legacy:/, ''),
  ),
  getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
};
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: mockNativeStorage,
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => 'linux',
}));

import { readFile } from 'node:fs/promises';
import { getInternalLegacySharedGitHubPatFilePath } from '../lib/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  loadStoredPat,
  readStoredPatWithStatus,
  invalidateTokenCache,
  resolveGitHubTokenWithSource,
} from '../lib/github-auth';

const readFileMock = jest.mocked(readFile);
const internalLegacyPathMock = jest.mocked(
  getInternalLegacySharedGitHubPatFilePath,
);
const atomicWriteMock = jest.mocked(writeFileAtomically);

function missingFileError(): Error & { code: 'ENOENT' } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' as const });
}

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateTokenCache();
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

it('decrypts and re-encrypts the former shared production PAT', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/github-pat.enc');
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:legacy-token'));

  await expect(loadStoredPat()).resolves.toBe('legacy-token');
  expect(atomicWriteMock).toHaveBeenCalledWith(
    '/mock/secure/github-pat.enc',
    Buffer.from('internal:legacy-token'),
    { mode: 0o600, overwrite: false },
  );
});

it('falls back to the legacy PAT only when the secure PAT is missing', async () => {
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy-token'));

  await expect(loadStoredPat()).resolves.toBe('legacy-token');
  expect(readFileMock).toHaveBeenNthCalledWith(
    1,
    '/mock/secure/github-pat.enc',
  );
  expect(readFileMock).toHaveBeenNthCalledWith(
    2,
    '/mock/legacy/secure/github-pat.enc',
  );
});

it('does not fall back to the legacy PAT on real secure-file read errors', async () => {
  readFileMock.mockRejectedValueOnce(errnoError('EACCES'));

  await expect(loadStoredPat()).resolves.toBe('');
  expect(readFileMock).toHaveBeenCalledTimes(1);
});

it('retains a typed unavailable read and retries after backend recovery', async () => {
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  await expect(readStoredPatWithStatus()).resolves.toMatchObject({
    status: 'storage-error',
    failure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
  });
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(true);
  await expect(loadStoredPat()).resolves.toBe('fixture-token');
  expect(atomicWriteMock).not.toHaveBeenCalled();
});

it('reports unavailable libsecret without persistence or legacy fallback', async () => {
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue('unknown');
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  await expect(readStoredPatWithStatus()).resolves.toMatchObject({
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
  await expect(readStoredPatWithStatus()).resolves.toMatchObject({
    status: 'error',
  });
  expect(readFileMock).toHaveBeenCalledTimes(1);
});

it('rechecks stored PAT cache when the backend changes and retains recoverable data', async () => {
  readFileMock.mockResolvedValue(Buffer.from('fixture-token'));
  await expect(resolveGitHubTokenWithSource()).resolves.toEqual({
    token: 'fixture-token',
    source: 'pat',
  });
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue('unknown');
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
  const failure = await readStoredPatWithStatus();
  expect(failure).toMatchObject({
    status: 'storage-error',
    failure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE', state: 'unavailable' },
  });
  mockNativeStorage.getSelectedStorageBackend.mockReturnValue(
    'gnome_libsecret',
  );
  mockNativeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockNativeStorage.decryptString.mockImplementation((raw: Buffer) =>
    raw.toString('utf8'),
  );
  await expect(resolveGitHubTokenWithSource()).resolves.toEqual({
    token: 'fixture-token',
    source: 'pat',
  });
  expect(atomicWriteMock).not.toHaveBeenCalled();
});

it('retains decoded legacy PAT when migration encryption is refused', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/github-pat.enc');
  mockNativeStorage.decryptString.mockImplementationOnce((raw: Buffer) => {
    mockNativeStorage.isEncryptionAvailable.mockReturnValue(false);
    return raw.toString('utf8').replace(/^legacy:/, '');
  });
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:fixture-token'));
  await expect(readStoredPatWithStatus()).resolves.toMatchObject({
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
  await resolveGitHubTokenWithSource();
  readFileMock
    .mockRejectedValueOnce(missingFileError())
    .mockResolvedValueOnce(Buffer.from('legacy:fixture-token'));
  await resolveGitHubTokenWithSource();
  expect(atomicWriteMock).toHaveBeenCalledTimes(2);
});
