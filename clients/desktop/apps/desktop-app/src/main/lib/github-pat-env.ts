import { readFileSync, statSync } from 'node:fs';
import { registerSecretsEnvInjector } from '../pipelines/config-paths';
import { getGitHubPatFilePath, getLegacyGitHubPatFilePath } from './paths';
import { getSecretStoragePolicy } from './secure-storage-policy';
import { isMissingFileError } from './fs-utils';
import { loadStoredPat } from './github-auth';

// In-memory cache of the decrypted PAT, keyed by file mtime. The PAT file
// changes only via the Settings UI (saveGitHubPat IPC), which calls
// `invalidateGitHubPatEnvCache` directly — the mtime check is a safety net
// for out-of-band edits.
let cached: Record<string, string> | null = null;
let cachedMtimeMs: number | null = null;
let cachedBackend: string | null = null;
let cachedRequiresDecryption = false;
let nextMtimeCheckAt = 0;
// Settings writes invalidate explicitly. Throttle the fallback stat for
// out-of-band edits so a burst of process launches does not perform sync I/O
// on Electron main for every child.
const MTIME_RECHECK_INTERVAL_MS = 1_000;

function currentMtime(): number | null {
  try {
    return statSync(getGitHubPatFilePath()).mtimeMs;
  } catch (error) {
    if (!isMissingFileError(error)) {
      return null;
    }
    try {
      return statSync(getLegacyGitHubPatFilePath()).mtimeMs;
    } catch {
      return null;
    }
  }
}

function loadPatSync(): string | null {
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(getGitHubPatFilePath());
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    try {
      encrypted = readFileSync(getLegacyGitHubPatFilePath());
    } catch (legacyError) {
      if (isMissingFileError(legacyError)) return null;
      throw legacyError;
    }
  }
  return getSecretStoragePolicy({ forSpawn: true }).decrypt(encrypted).trim();
}

function getGitHubPatSecretsForInjection(): Record<string, string> {
  try {
    const policy = getSecretStoragePolicy({ forSpawn: true });
    if (cached !== null && cachedRequiresDecryption) {
      policy.assertCanRead();
      if (policy.getStatus().backend !== cachedBackend) {
        invalidateGitHubPatEnvCache();
      }
    }
    const now = Date.now();
    if (cached === null || now >= nextMtimeCheckAt) {
      const mtime = currentMtime();
      if (cached === null || mtime !== cachedMtimeMs) {
        const pat = loadPatSync();
        // Publish only after a successful read, including empty ciphertext.
        cached = pat ? { GH_TOKEN: pat } : {};
        cachedRequiresDecryption = pat !== null;
        cachedBackend = cachedRequiresDecryption
          ? policy.getStatus().backend
          : null;
        cachedMtimeMs = mtime;
      }
      nextMtimeCheckAt = now + MTIME_RECHECK_INTERVAL_MS;
    }
    return cached ?? {};
  } catch {
    // Omission is spawn-local, not confirmed absence. Retry next normal spawn.
    invalidateGitHubPatEnvCache();
    return {};
  }
}

/**
 * Drop the in-memory PAT cache so the next `getEnhancedEnv()` source-path
 * call picks up a fresh decryption. Called by the save IPC handler after a
 * successful write.
 */
export function invalidateGitHubPatEnvCache(): void {
  cached = null;
  cachedMtimeMs = null;
  cachedBackend = null;
  cachedRequiresDecryption = false;
  nextMtimeCheckAt = 0;
}

let initialized = false;

/**
 * Wire the PAT-derived secrets injector into `getEnhancedEnv()`. Idempotent
 * and safe to call multiple times — only the first call actually registers
 * the injector. Must run after Electron `app.whenReady()` so `safeStorage`
 * is available before the first spawn.
 */
export function initializeGitHubPatEnvRuntime(): void {
  if (initialized) return;
  initialized = true;
  registerSecretsEnvInjector(getGitHubPatSecretsForInjection);
  void loadStoredPat()
    .then(() => {
      invalidateGitHubPatEnvCache();
    })
    .catch(() => undefined);
}
