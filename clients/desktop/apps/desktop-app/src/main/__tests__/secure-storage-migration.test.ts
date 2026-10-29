import { readFile } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
}));

import { writeFileAtomically } from '../lib/atomic-file';
import { migrateSecureStorageFile } from '../lib/secure-storage-migration';
import { SafeStorageWriteError } from '../lib/safe-storage';
import {
  getSecureStorageFailure,
  SecureStorageOperationError,
} from '../lib/secure-storage-policy';

const readFileMock = jest.mocked(readFile);
const writeFileAtomicallyMock = jest.mocked(writeFileAtomically);
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

describe('migrateSecureStorageFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    writeFileAtomicallyMock.mockResolvedValue(undefined);
  });

  const decode = (raw: Buffer): string => {
    const value = raw.toString('utf8');
    if (!value.startsWith('readable:')) throw new Error('foreign');
    return value.slice('readable:'.length);
  };

  it('uses an existing current destination without consulting legacy', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('readable:current'));

    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => Buffer.from(`new:${value}`),
        storeKind: 'test',
      }),
    ).resolves.toEqual({ status: 'current', value: 'current' });

    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it('decodes and re-encodes a valid legacy source without modifying it', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));

    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => Buffer.from(`new:${value}`),
        storeKind: 'test',
      }),
    ).resolves.toEqual({ status: 'migrated', value: 'legacy' });

    expect(writeFileAtomicallyMock).toHaveBeenCalledWith(
      '/internal/token',
      Buffer.from('new:legacy'),
      { overwrite: false },
    );
  });

  it('treats an unreadable legacy source as foreign but a current one as an error', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('foreign'));
    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => value,
        storeKind: 'test',
      }),
    ).resolves.toEqual({ status: 'foreign-legacy-skipped' });

    readFileMock.mockReset();
    readFileMock.mockResolvedValueOnce(Buffer.from('foreign'));
    const current = await migrateSecureStorageFile({
      currentPath: '/internal/token',
      legacyPath: '/stable/token',
      decode,
      encode: (value) => value,
      storeKind: 'test',
    });
    expect(current.status).toBe('current-error');
  });

  it('keeps temporary decoder unavailability distinct from foreign ciphertext', async () => {
    const unavailable = new Error('temporarily unavailable');
    const decodeUnavailable = (): string => {
      throw unavailable;
    };
    const options = {
      currentPath: '/internal/token',
      legacyPath: '/stable/token',
      decode: decodeUnavailable,
      encode: (value: string): string => value,
      storeKind: 'test',
      isUnavailableError: (error: unknown): boolean => error === unavailable,
    };

    readFileMock.mockResolvedValueOnce(Buffer.from('current'));
    await expect(migrateSecureStorageFile(options)).resolves.toEqual({
      status: 'unavailable',
    });

    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('legacy'));
    await expect(migrateSecureStorageFile(options)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
  });

  it('returns the decoded value when the atomic destination write is deferred', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));
    writeFileAtomicallyMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => value,
        storeKind: 'test',
      }),
    ).resolves.toEqual({
      status: 'legacy-decoded-write-deferred',
      value: 'legacy',
    });
  });

  it('retries a deferred migration on the next load', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'))
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));
    writeFileAtomicallyMock
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const options = {
      currentPath: '/internal/token',
      legacyPath: '/stable/token',
      decode,
      encode: (value: string): string => value,
      storeKind: 'test',
    };

    await expect(migrateSecureStorageFile(options)).resolves.toMatchObject({
      status: 'legacy-decoded-write-deferred',
    });
    await expect(migrateSecureStorageFile(options)).resolves.toMatchObject({
      status: 'migrated',
    });

    expect(writeFileAtomicallyMock).toHaveBeenCalledTimes(2);
  });

  it('uses a destination created while legacy data is being decoded', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'))
      .mockResolvedValueOnce(Buffer.from('readable:new-current'));
    writeFileAtomicallyMock.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'EEXIST' }),
    );

    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => Buffer.from(`new:${value}`),
        storeKind: 'test',
      }),
    ).resolves.toEqual({ status: 'current', value: 'new-current' });

    expect(writeFileAtomicallyMock).toHaveBeenCalledWith(
      '/internal/token',
      Buffer.from('new:legacy'),
      { overwrite: false },
    );
  });

  it('skips wrong-identity internal shared legacy ciphertext without writing', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('foreign'));
    const failure = new SecureStorageOperationError({
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: false,
    });
    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode: () => {
          throw failure;
        },
        encode: (value: string) => value,
        storeKind: 'test',
      }),
    ).resolves.toEqual({
      status: 'foreign-legacy-skipped',
      secureStorageFailure: getSecureStorageFailure(failure),
    });
    expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
  });

  const storageError = new SecureStorageOperationError({
    version: 1,
    code: 'SECURE_STORAGE_DECRYPT_FAILED',
    operation: 'read',
    state: 'locked',
    backend: 'gnome_libsecret',
    retryable: true,
  });

  it.each(['current', 'legacy', 'destination-race'])(
    'keeps typed %s decode failure distinct from absence and foreign data',
    async (source) => {
      const decodeFailure = jest.fn((): string => {
        throw storageError;
      });
      if (source === 'current')
        readFileMock.mockResolvedValueOnce(Buffer.from('current'));
      else if (source === 'legacy')
        readFileMock
          .mockRejectedValueOnce(missing)
          .mockResolvedValueOnce(Buffer.from('legacy'));
      else {
        readFileMock
          .mockRejectedValueOnce(missing)
          .mockResolvedValueOnce(Buffer.from('readable:legacy'))
          .mockResolvedValueOnce(Buffer.from('new-current'));
        writeFileAtomicallyMock.mockRejectedValueOnce(
          Object.assign(new Error('exists'), { code: 'EEXIST' }),
        );
      }
      const beforeWrite = jest.fn((): Promise<void> => Promise.resolve());
      await expect(
        migrateSecureStorageFile({
          currentPath: '/internal/token',
          legacyPath: '/stable/token',
          decode: decodeFailure,
          decodeLegacy: source === 'destination-race' ? decode : decodeFailure,
          encode: (value) => value,
          storeKind: 'test',
          beforeWrite,
          // Typed failures take precedence even for legacy boolean predicates.
          isUnavailableError: () => true,
        }),
      ).resolves.toEqual({
        status: 'storage-error',
        error: storageError,
        secureStorageFailure: getSecureStorageFailure(storageError),
      });
      expect(readFileMock).toHaveBeenCalledTimes(
        source === 'current' ? 1 : source === 'legacy' ? 2 : 3,
      );
      if (source !== 'destination-race') {
        expect(beforeWrite).not.toHaveBeenCalled();
        expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
      }
    },
  );

  it('retains usable legacy data and attaches refused re-encryption for retry', async () => {
    const refusal = new SafeStorageWriteError({
      state: 'locked',
      backend: 'gnome_libsecret',
    });
    const encode = jest.fn((): string => {
      throw refusal;
    });
    const beforeWrite = jest.fn((): Promise<void> => Promise.resolve());
    const options = {
      currentPath: '/internal/token',
      legacyPath: '/stable/token',
      decode,
      encode,
      storeKind: 'test',
      beforeWrite,
    };
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));
    await expect(migrateSecureStorageFile(options)).resolves.toEqual({
      status: 'legacy-decoded-write-deferred',
      value: 'legacy',
      secureStorageFailure: getSecureStorageFailure(refusal),
    });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));
    encode.mockReturnValue('new:legacy');
    await expect(migrateSecureStorageFile(options)).resolves.toEqual({
      status: 'migrated',
      value: 'legacy',
    });
    expect(writeFileAtomicallyMock).toHaveBeenCalledTimes(1);
  });

  it('encodes the complete multi-field payload before preparing a destination', async () => {
    readFileMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(Buffer.from('readable:legacy'));
    const secondFieldFailure = new SecureStorageOperationError({
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: true,
    });
    const beforeWrite = jest.fn((): Promise<void> => Promise.resolve());
    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: () => {
          Buffer.from('first-encoded-field');
          throw secondFieldFailure;
        },
        storeKind: 'test',
        beforeWrite,
      }),
    ).resolves.toEqual({
      status: 'legacy-decoded-write-deferred',
      value: 'legacy',
      secureStorageFailure: getSecureStorageFailure(secondFieldFailure),
    });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
  });

  it('preserves the old boolean unavailable contract without reading files', async () => {
    await expect(
      migrateSecureStorageFile({
        currentPath: '/internal/token',
        legacyPath: '/stable/token',
        decode,
        encode: (value) => value,
        storeKind: 'test',
        isAvailable: () => false,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
