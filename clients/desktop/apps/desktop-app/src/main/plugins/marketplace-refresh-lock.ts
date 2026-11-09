import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ensurePrivateLockDirectory,
  withOwnerLockFile,
} from '@canopy/execution-engine/node/lib/owner-lock-file';
import { getDataDir } from '../lib/paths';

const LOCK_MAX_WAIT_MS = 10 * 60 * 1000;

async function canonicalizeProviderRoot(root: string): Promise<string> {
  const suffix: string[] = [];
  let existingAncestor = path.resolve(root);
  while (true) {
    try {
      return path.join(await realpath(existingAncestor), ...suffix.reverse());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return path.resolve(root);
      suffix.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function canonicalProviderStateRoots(): Promise<string[]> {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
  const roots = await Promise.all(
    [claudeConfigDir, codexHome].map(canonicalizeProviderRoot),
  );
  return Array.from(
    new Set(
      roots.map((root) =>
        process.platform === 'win32' ? root.toLowerCase() : root,
      ),
    ),
  ).sort();
}

function marketplaceRefreshLockPath(
  lockRoot: string,
  providerRoot: string,
): string {
  const testScope = process.env.NODE_ENV === 'test' ? `:${process.pid}` : '';
  const identityHash = createHash('sha256')
    .update(`${providerRoot}${testScope}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(lockRoot, `provider-${identityHash}.lock`);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

async function ensurePrivateLockRoot(): Promise<string> {
  const lockRoot = path.join(getDataDir(), 'locks', 'marketplace-refresh');
  await ensurePrivateLockDirectory(lockRoot);
  return lockRoot;
}

/** Serializes provider mutations by acquiring each canonical state-root lock. */
export async function withMarketplaceRefreshLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockRoot = await ensurePrivateLockRoot();
  const lockPaths = (await canonicalProviderStateRoots()).map((providerRoot) =>
    marketplaceRefreshLockPath(lockRoot, providerRoot),
  );
  const acquireAt = (index: number): Promise<T> =>
    index === lockPaths.length
      ? operation()
      : withOwnerLockFile(lockPaths[index], () => acquireAt(index + 1), {
          maxWaitMs: LOCK_MAX_WAIT_MS,
          timeoutMessage:
            'Timed out waiting for the provider marketplace refresh lock.',
        });
  return acquireAt(0);
}
