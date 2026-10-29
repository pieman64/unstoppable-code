import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { isErrnoException } from './type-guards';

const execFileAsync = promisify(execFile);
const ARCHIVE_MOVE_TIMEOUT_MS = 30_000;
const WINDOWS_ARCHIVE_QUARANTINE_RETRY_DELAYS_MS = [
  50, 100, 150, 200, 250, 500, 750, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
  1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
] as const;

export interface ArchivedQuarantineIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function quarantineIdentity(stats: Stats): ArchivedQuarantineIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

function retryableQuarantineMoveCode(
  error: unknown,
): 'EBUSY' | 'EPERM' | 'EACCES' | null {
  if (isErrnoException(error) && typeof error.code === 'string') {
    if (
      error.code === 'EBUSY' ||
      error.code === 'EPERM' ||
      error.code === 'EACCES'
    ) {
      return error.code;
    }
  }
  if (!error || typeof error !== 'object') return null;
  const stderrValue = 'stderr' in error ? error.stderr : undefined;
  const stderr = Buffer.isBuffer(stderrValue)
    ? stderrValue.toString('utf8')
    : typeof stderrValue === 'string'
      ? stderrValue
      : '';
  if (/resource busy|device or resource busy/i.test(stderr)) return 'EBUSY';
  if (/operation not permitted/i.test(stderr)) return 'EPERM';
  if (/permission denied/i.test(stderr)) return 'EACCES';
  return null;
}

export async function renameArchiveQuarantine(
  canonicalPath: string,
  quarantinePath: string,
): Promise<ArchivedQuarantineIdentity> {
  const original = await lstat(canonicalPath);
  const assertOriginalIdentity = async (): Promise<void> => {
    const current = await lstat(canonicalPath);
    if (
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.birthtimeMs !== original.birthtimeMs ||
      current.isSymbolicLink()
    ) {
      throw new Error(
        'The worktree changed identity before entering archive quarantine.',
      );
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await lstat(quarantinePath);
      throw new Error(
        'Archive quarantine already exists; preserve it for recovery.',
      );
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
    await assertOriginalIdentity();
    try {
      await lstat(quarantinePath);
      throw new Error(
        'Archive quarantine appeared during the move; it was preserved for recovery.',
      );
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
    try {
      if (process.platform === 'win32') {
        await rename(canonicalPath, quarantinePath);
      } else {
        await execFileAsync(
          '/bin/mv',
          [
            '-n',
            ...(process.platform === 'linux' ? ['-T', '--'] : []),
            canonicalPath,
            quarantinePath,
          ],
          { timeout: ARCHIVE_MOVE_TIMEOUT_MS, windowsHide: true },
        );
        try {
          await lstat(canonicalPath);
          throw new Error(
            'Archive quarantine appeared during the move; it was preserved for recovery.',
          );
        } catch (error) {
          if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
        }
      }
      const moved = await lstat(quarantinePath);
      if (
        moved.dev !== original.dev ||
        moved.ino !== original.ino ||
        moved.birthtimeMs !== original.birthtimeMs ||
        moved.isSymbolicLink()
      ) {
        const nested = join(quarantinePath, basename(canonicalPath));
        const nestedStats = await lstat(nested).catch(() => null);
        if (
          nestedStats &&
          nestedStats.dev === original.dev &&
          nestedStats.ino === original.ino &&
          nestedStats.birthtimeMs === original.birthtimeMs
        ) {
          try {
            await lstat(canonicalPath);
          } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
              await rename(nested, canonicalPath);
            } else {
              throw error;
            }
          }
        }
        throw new Error(
          'Archive quarantine changed identity during the move; it was preserved for recovery.',
        );
      }
      return quarantineIdentity(moved);
    } catch (error) {
      const retryDelay =
        process.platform === 'win32'
          ? WINDOWS_ARCHIVE_QUARANTINE_RETRY_DELAYS_MS[attempt]
          : [50, 100, 200, 400][attempt];
      if (!retryableQuarantineMoveCode(error) || retryDelay === undefined) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
    }
  }
}
