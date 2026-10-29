import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getInternalLegacySharedLinearTokenFilePath,
  getLegacyLinearTokenFilePath,
  getLinearTokenFilePath,
} from './paths';
import type { StoredSecretReadResult } from '@canopy/desktop-shared/types';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from './secure-storage-policy';
import { migrateSecureStorageFile } from './secure-storage-migration';
import { isMissingFileError } from './fs-utils';

const TOKEN_TTL_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let cachedAt = 0;
let cachedBackend: string | null = null;

type StoredTokenRead = StoredSecretReadResult<string> & {
  migrationDeferred?: boolean;
};

export async function readStoredLinearTokenWithStatus(): Promise<
  StoredSecretReadResult<string>
> {
  const result = await readStoredLinearTokenResult();
  if (result.status !== 'ok') return result;
  return {
    status: 'ok',
    value: result.value,
    ...(result.migrationWriteFailure
      ? { migrationWriteFailure: result.migrationWriteFailure }
      : {}),
  };
}

async function readStoredLinearTokenResult(): Promise<StoredTokenRead> {
  const policy = getSecretStoragePolicy();
  const filePath = getLinearTokenFilePath();
  try {
    const migration = await migrateSecureStorageFile<string>({
      currentPath: filePath,
      legacyPath: getInternalLegacySharedLinearTokenFilePath(),
      decode: (raw) => policy.decrypt(raw),
      encode: (token) => policy.encrypt(token),
      storeKind: 'linear-token',
      beforeWrite: async () => {
        await mkdir(dirname(filePath), { recursive: true });
        policy.assertCanWrite();
      },
      writeOptions: { mode: 0o600 },
    });
    switch (migration.status) {
      case 'current':
      case 'migrated':
        return { status: 'ok', value: migration.value };
      case 'legacy-decoded-write-deferred':
        return {
          migrationDeferred: true,
          status: 'ok',
          value: migration.value,
          ...(migration.secureStorageFailure
            ? { migrationWriteFailure: migration.secureStorageFailure }
            : {}),
        };
      case 'storage-error':
        return {
          status: 'storage-error',
          failure: migration.secureStorageFailure,
        };
      case 'current-error':
        return { status: 'error', error: migration.error };
      case 'foreign-legacy-skipped':
        return migration.secureStorageFailure
          ? { status: 'ok', value: null, migrationDeferred: true }
          : { status: 'error', error: new Error('Secure store read failed') };
      case 'absent':
        try {
          return {
            status: 'ok',
            value: policy.decrypt(
              await readFile(getLegacyLinearTokenFilePath()),
            ),
          };
        } catch (error) {
          if (isMissingFileError(error)) return { status: 'ok', value: null };
          throw error;
        }
      default:
        return {
          status: 'error',
          error: new Error('Secure store read failed'),
        };
    }
  } catch (error) {
    const failure = getSecureStorageFailure(error);
    return failure
      ? { status: 'storage-error', failure }
      : { status: 'error', error };
  }
}

function backendIdentity(): string {
  return JSON.stringify([
    hostOperatingSystem(),
    getSecretStoragePolicy().getStatus().backend,
  ]);
}

export async function resolveLinearToken(): Promise<string> {
  const policy = getSecretStoragePolicy();
  if (cachedToken !== null && Date.now() - cachedAt < TOKEN_TTL_MS) {
    try {
      policy.assertCanRead();
      if (cachedBackend === backendIdentity()) return cachedToken;
    } catch {
      return '';
    }
  }
  const result = await readStoredLinearTokenResult();
  if (result.status !== 'ok') return '';
  const token = result.value ?? '';
  if (!result.migrationDeferred) {
    cachedToken = token;
    cachedAt = Date.now();
    cachedBackend = backendIdentity();
  }
  return token;
}

export function invalidateLinearTokenCache(): void {
  cachedToken = null;
  cachedAt = 0;
  cachedBackend = null;
}

/**
 * Build the `LinearClient` constructor options. In production this is just
 * `{ apiKey }`. Under the build-time E2E gate (Doc 9 §2, Doc 11) it also sets
 * `apiUrl` to the mock server so Linear traffic is redirected off
 * api.linear.app. The branch is dead-code-eliminated from production builds, so
 * no runtime env can redirect Linear in a shipped app.
 */
export function buildLinearClientOptions(apiKey: string): {
  apiKey: string;
  apiUrl?: string;
} {
  if (__CANOPY_E2E__ && __CANOPY_LINEAR_API_BASE_URL__) {
    return { apiKey, apiUrl: __CANOPY_LINEAR_API_BASE_URL__ };
  }
  return { apiKey };
}
