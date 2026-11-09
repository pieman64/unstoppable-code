import { readFile } from 'node:fs/promises';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import type { AtomicFileWriteOptions } from './atomic-file';
import { getSecureStorageFailure } from './secure-storage-policy';

export type SecureMigrationResult<T> =
  | { status: 'current'; value: T }
  | { status: 'migrated'; value: T }
  | {
      status: 'legacy-decoded-write-deferred';
      value: T;
      secureStorageFailure?: SecureStorageFailure;
    }
  | {
      status: 'storage-error';
      error: Error;
      secureStorageFailure: SecureStorageFailure;
    }
  | { status: 'absent' }
  | { status: 'unavailable' }
  | {
      status: 'foreign-legacy-skipped';
      secureStorageFailure?: SecureStorageFailure;
    }
  | { status: 'current-error'; error: Error };

interface SecureStorageMigrationOptions<T> {
  currentPath: string;
  legacyPath: string | null;
  decode: (raw: Buffer) => T;
  decodeLegacy?: (raw: Buffer) => T;
  encode: (value: T) => string | Uint8Array;
  storeKind: string;
  isAvailable?: () => boolean;
  isUnavailableError?: (error: unknown) => boolean;
  beforeWrite?: () => Promise<void>;
  writeOptions?: AtomicFileWriteOptions;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Secure store read failed');
}

export async function migrateSecureStorageFile<T>(
  options: SecureStorageMigrationOptions<T>,
): Promise<SecureMigrationResult<T>> {
  if (options.isAvailable && !options.isAvailable()) {
    return { status: 'unavailable' };
  }

  try {
    const raw = await readFile(options.currentPath);
    try {
      return { status: 'current', value: options.decode(raw) };
    } catch (error) {
      const secureStorageFailure = getSecureStorageFailure(error);
      if (secureStorageFailure) {
        return {
          status: 'storage-error',
          error: asError(error),
          secureStorageFailure,
        };
      }
      if (options.isUnavailableError?.(error)) {
        return { status: 'unavailable' };
      }
      return { status: 'current-error', error: asError(error) };
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      return { status: 'current-error', error: asError(error) };
    }
  }

  // V-4: another build's ciphertext is explicit recovery material, not input.
  return { status: 'absent' };
}
