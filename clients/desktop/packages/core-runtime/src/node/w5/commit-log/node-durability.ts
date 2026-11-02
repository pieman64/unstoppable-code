import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { W5DurabilityPort } from './apply';

/*
 * A node:fs W5 durability port with the desktop's atomic-file writes: a
 * sibling temp file, fsync, a rename retried over transient sharing
 * violations, then a sync of its folder. A host passes its folder flush to
 * match the desktop's (core-platform's `flushDirectory`, CAN-5153); this
 * package cannot import it. The host names its OS; this module reads no
 * platform.
 */

export interface NodeW5DurabilityOptions {
  /**
   * The host's folder flush. Default: fsync on POSIX, skipped on win32.
   */
  readonly flushDirectory?: (directoryPath: string) => Promise<unknown>;
}

// The desktop's rename-with-retry delays and codes.
const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250] as const;
const RETRIED_RENAME_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      // Not instanceof Error: fs errors come from another realm under Jest.
      const code: unknown =
        error !== null && typeof error === 'object'
          ? Reflect.get(error, 'code')
          : undefined;
      const wait = RENAME_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || !RETRIED_RENAME_CODES.includes(String(code)))
        throw error;
      await delay(wait);
    }
  }
}

/** The W5 durability port for a host on `os`. */
export function createNodeW5Durability(
  os: NodeJS.Platform | null,
  options: NodeW5DurabilityOptions = {},
): W5DurabilityPort {
  const { flushDirectory } = options;
  async function syncDirectory(directoryPath: string): Promise<void> {
    if (flushDirectory !== undefined) {
      await flushDirectory(directoryPath);
      return;
    }
    if (os === 'win32') return;
    const handle = await open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function writeFileDurably(
    path: string,
    contents: string,
  ): Promise<void> {
    const tempPath = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(tempPath, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tempPath, path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    await syncDirectory(dirname(path));
  }
  return { syncDirectory, writeFileDurably };
}
