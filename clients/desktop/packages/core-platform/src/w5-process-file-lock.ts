import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hostOperatingSystem } from './host-platform';
import type { W5ProcessFileLock } from '@canopy/core-runtime/node/w5/commit-log/apply';
/** Shared with legacy cohort admission; no brand, app or host-registration imports. */
export async function ensureW5PrivateRuntimeDirectory(
  path: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(path);
    const os = hostOperatingSystem();
    const canonicalPath = await realpath(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      identity(canonicalPath) !== identity(path) ||
      (os !== 'win32' && stat.uid !== process.getuid?.())
    ) {
      const error = new Error('The runtime folder is not private.');
      Object.assign(error, { reason: 'runtime-unavailable' });
      throw error;
    }
    // Windows inherits the canonical data root's user ACL. Reparse directory
    // aliases refuse above; POSIX additionally enforces owner and mode.
    if (os !== 'win32' && (stat.mode & 0o077) !== 0) await chmod(path, 0o700);
  } catch (underlying) {
    const error = new Error(
      'The runtime folder cannot be verified as private.',
    );
    Object.assign(error, { reason: 'runtime-unavailable', underlying });
    throw error;
  }
}

import { W5ProcessFileLockTimeoutError } from '@canopy/core-runtime/node/w5/commit-log/errors';
export { W5ProcessFileLockTimeoutError };

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

/** Resolve existing parents too, so a not-yet-created file has one identity. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (code(error) !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
function identity(path: string): string {
  const os = hostOperatingSystem();
  // Conservative on case-sensitive macOS volumes: extra exclusion is safe.
  return os === 'win32' || os === 'darwin' ? path.toLowerCase() : path;
}

/**
 * Local filesystems with SQLite byte-range locking only (POSIX and Windows).
 * The permanent database inode is NEVER renamed or removed. BEGIN EXCLUSIVE
 * belongs to this connection; close/crash releases it through the OS. No PID,
 * age, heartbeat or stale-owner inference, and no inherited async reentrancy.
 * Callers must not recursively acquire these locks or delete runtime/locks
 * while a participating host lives. Other users cannot replace private files.
 */
export async function withW5ProcessFileLocks<T>(
  paths: readonly string[],
  options: { dataRoot: string; timeoutMs?: number },
  work: () => Promise<T>,
): Promise<T> {
  if (!paths.length) return work();
  const { DatabaseSync } = await import('node:sqlite');
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeout) || timeout < 0)
    throw new Error('Invalid W5 lock timeout');
  const root = await canonical(resolve(options.dataRoot));
  const resources = new Map<string, string>();
  for (const path of paths)
    resources.set(identity(await canonical(resolve(path))), path);
  const runtime = join(root, 'runtime');
  await ensureW5PrivateRuntimeDirectory(runtime);
  const directory = join(runtime, 'locks');
  await ensureW5PrivateRuntimeDirectory(directory);
  const held: DatabaseSync[] = [];
  const deadline = performance.now() + timeout;
  try {
    for (const [key, path] of [...resources].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const lockPath = join(
        directory,
        `${createHash('sha256').update(key).digest('hex')}.sqlite`,
      );
      // Private parents prevent replacement by other users. Validate existing
      // files without opening a raw descriptor: closing one would release any
      // active POSIX SQLite locks held by this process, including other threads.
      const stat = await lstat(lockPath).catch((error: unknown) => {
        if (code(error) !== 'ENOENT') throw error;
        return undefined;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
        throw new Error('Unsafe W5 process lock file');
      const db = new DatabaseSync(lockPath);
      held.push(db);
      if (hostOperatingSystem() !== 'win32') await chmod(lockPath, 0o600);
      db.exec('PRAGMA busy_timeout = 0');
      for (;;) {
        try {
          db.exec('BEGIN EXCLUSIVE');
          break;
        } catch (error) {
          const errcode: unknown =
            typeof error === 'object' && error !== null
              ? Reflect.get(error, 'errcode')
              : undefined;
          if (errcode !== 5 && errcode !== 6) throw error;
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new W5ProcessFileLockTimeoutError(path);
          await delay(Math.min(25, remaining));
        }
      }
    }
    return await work();
  } finally {
    // A connection that failed acquisition is also closed. Never unlink files.
    for (const db of held.reverse()) db.close();
  }
}

/** One acquisition layer at the worker that actually decides and applies. */
export function worktreeListProcessLock(dataRoot: string): W5ProcessFileLock {
  return async (paths, work) => {
    const root = await canonical(resolve(dataRoot));
    const applicable: string[] = [];
    for (const path of paths) {
      const parts = relative(root, await canonical(resolve(path))).split(sep);
      if (
        parts.length === 3 &&
        identity(parts[0] ?? '') === 'workspaces' &&
        identity(parts[2] ?? '') === 'worktrees.json'
      )
        applicable.push(path);
    }
    return withW5ProcessFileLocks(applicable, { dataRoot: root }, work);
  };
}
