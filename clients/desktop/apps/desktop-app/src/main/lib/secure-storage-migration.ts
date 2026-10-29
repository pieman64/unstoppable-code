import { readFile } from 'node:fs/promises';
import { BRAND } from '@canopy/brand/current';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import {
  writeFileAtomically,
  type AtomicFileWriteOptions,
} from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { getSecureStorageFailure } from './secure-storage-policy';

declare const __CANOPY_RELEASE_FLAVOR__: string | undefined;

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

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Secure store read failed');
}

function releaseFlavor(): string {
  return typeof __CANOPY_RELEASE_FLAVOR__ === 'undefined'
    ? 'development'
    : __CANOPY_RELEASE_FLAVOR__;
}

function logOutcome(storeKind: string, outcome: string): void {
  logMainProcessWarn(
    '[secure-storage-migration] Secure store migration outcome',
    {
      storeKind,
      source: 'legacy-production-secure-root',
      brandId: BRAND.id,
      releaseFlavor: releaseFlavor(),
      outcome,
    },
  );
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

  if (!options.legacyPath) {
    return { status: 'absent' };
  }

  let value: T;
  try {
    value = (options.decodeLegacy ?? options.decode)(
      await readFile(options.legacyPath),
    );
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    // This source belongs to the former production identity. A readable
    // backend cannot decrypt its foreign ciphertext; leave the source intact.
    if (
      secureStorageFailure?.code === 'SECURE_STORAGE_DECRYPT_FAILED' &&
      secureStorageFailure.state !== 'unavailable' &&
      secureStorageFailure.state !== 'locked'
    ) {
      logOutcome(options.storeKind, 'foreign-legacy-skipped');
      return { status: 'foreign-legacy-skipped', secureStorageFailure };
    }
    if (secureStorageFailure) {
      return {
        status: 'storage-error',
        error: asError(error),
        secureStorageFailure,
      };
    }
    if (isMissingFileError(error)) {
      return { status: 'absent' };
    }
    if (options.isUnavailableError?.(error)) {
      return { status: 'unavailable' };
    }
    logOutcome(options.storeKind, 'foreign-legacy-skipped');
    return { status: 'foreign-legacy-skipped' };
  }

  try {
    // Serialize every field before destination preparation or persistence.
    const encoded = options.encode(value);
    await options.beforeWrite?.();
    await writeFileAtomically(options.currentPath, encoded, {
      ...options.writeOptions,
      overwrite: false,
    });
    logOutcome(options.storeKind, 'migrated');
    return { status: 'migrated', value };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      try {
        const raw = await readFile(options.currentPath);
        try {
          return { status: 'current', value: options.decode(raw) };
        } catch (decodeError) {
          const secureStorageFailure = getSecureStorageFailure(decodeError);
          if (secureStorageFailure) {
            return {
              status: 'storage-error',
              error: asError(decodeError),
              secureStorageFailure,
            };
          }
          if (options.isUnavailableError?.(decodeError)) {
            return { status: 'unavailable' };
          }
          return { status: 'current-error', error: asError(decodeError) };
        }
      } catch (readError) {
        if (!isMissingFileError(readError)) {
          return { status: 'current-error', error: asError(readError) };
        }
      }
    }
    logOutcome(options.storeKind, 'legacy-decoded-write-deferred');
    const secureStorageFailure = getSecureStorageFailure(error);
    return {
      status: 'legacy-decoded-write-deferred',
      value,
      ...(secureStorageFailure ? { secureStorageFailure } : {}),
    };
  }
}
