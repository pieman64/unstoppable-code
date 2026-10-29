import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  getGitHubPatFilePath,
  getInternalLegacySharedGitHubPatFilePath,
  getLegacyGitHubPatFilePath,
} from './paths';
import type { StoredSecretReadResult } from '@canopy/desktop-shared/types';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from './secure-storage-policy';
import { migrateSecureStorageFile } from './secure-storage-migration';
import { isMissingFileError } from './fs-utils';
import {
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';

const execFileAsync = promisify(execFile);

const TOKEN_TTL_MS = 5 * 60 * 1000;

export type GitHubTokenSource = 'pat' | 'gh-cli' | 'none';

let cachedToken: string | null = null;
let cachedSource: GitHubTokenSource = 'none';
let cachedAt = 0;
let cachedBackend: string | null = null;

type StoredTokenRead = StoredSecretReadResult<string> & {
  migrationDeferred?: boolean;
};

export async function readStoredPatWithStatus(): Promise<
  StoredSecretReadResult<string>
> {
  const result = await readStoredPatResult();
  if (result.status !== 'ok') return result;
  return {
    status: 'ok',
    value: result.value,
    ...(result.migrationWriteFailure
      ? { migrationWriteFailure: result.migrationWriteFailure }
      : {}),
  };
}

async function readStoredPatResult(): Promise<StoredTokenRead> {
  const policy = getSecretStoragePolicy();
  const filePath = getGitHubPatFilePath();
  try {
    const migration = await migrateSecureStorageFile<string>({
      currentPath: filePath,
      legacyPath: getInternalLegacySharedGitHubPatFilePath(),
      decode: (raw) => policy.decrypt(raw),
      encode: (token) => policy.encrypt(token),
      storeKind: 'github-pat',
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
            value: policy.decrypt(await readFile(getLegacyGitHubPatFilePath())),
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

export async function loadStoredPat(): Promise<string> {
  const result = await readStoredPatWithStatus();
  return result.status === 'ok' ? (result.value ?? '') : '';
}

export async function loadGhCliToken(): Promise<string> {
  try {
    // Bypass the Canopy-managed PAT injection so this returns gh's own
    // credential-store token, not whatever we injected as GH_TOKEN.
    // Externally-set GH_TOKEN still passes through (we never strip
    // user-provided env vars).
    const { stdout } = await execFileAsync(
      getBundledGhBinaryPath(),
      ['auth', 'token'],
      {
        timeout: 10_000,
        env: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        windowsHide: process.platform === 'win32',
      },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function resolveGitHubToken(): Promise<string> {
  const { token } = await resolveGitHubTokenWithSource();
  return token;
}

export async function resolveGitHubTokenWithSource(): Promise<{
  token: string;
  source: GitHubTokenSource;
}> {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) {
    if (cachedSource === 'gh-cli')
      return { token: cachedToken, source: cachedSource };
    try {
      getSecretStoragePolicy().assertCanRead();
      if (cachedBackend === backendIdentity())
        return { token: cachedToken, source: cachedSource };
    } catch {
      const token = await loadGhCliToken();
      return { token, source: token ? 'gh-cli' : 'none' };
    }
  }

  const stored = await readStoredPatResult();
  let token = stored.status === 'ok' ? (stored.value ?? '') : '';
  let source: GitHubTokenSource = token ? 'pat' : 'none';

  if (!token) {
    token = await loadGhCliToken();
    if (token) {
      source = 'gh-cli';
    }
  }

  if (token && stored.status === 'ok' && !stored.migrationDeferred) {
    cachedToken = token;
    cachedSource = source;
    cachedAt = Date.now();
    cachedBackend = backendIdentity();
  } else if (stored.status === 'ok' && !token) {
    invalidateTokenCache();
  }

  return { token, source };
}

export function invalidateTokenCache(): void {
  cachedToken = null;
  cachedSource = 'none';
  cachedAt = 0;
  cachedBackend = null;
}
