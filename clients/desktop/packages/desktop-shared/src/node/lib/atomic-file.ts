import { renameWithRetry } from './rename-with-retry';
import {
  admitStorageWrite,
  type StorageAdmissionTarget,
} from './storage-admission';
import {
  assertStorageWriteAllowed,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export { renameWithRetry };

export interface AtomicFileWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  /** Install only when the destination is absent. */
  overwrite?: boolean;
  /**
   * Sync the complete file before installing it, then its directory, so the
   * new content survives a crash once the write resolves. A failed directory
   * sync fails the write. Directories are not synced on Windows, where Node
   * cannot open them.
   */
  durable?: boolean;
  /** A W5 write: ownership-checked, and admitted by its operation. */
  storage?: StorageAdmissionTarget;
}

export type AtomicFileStorage = NonNullable<AtomicFileWriteOptions['storage']>;

/** fsync a folder so entries created or removed in it are durable; Windows cannot. */
export async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write a complete sibling file, then atomically install it at `targetPath`. */
export async function writeFileAtomically(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteOptions,
): Promise<void> {
  const storage = options?.storage;
  if (!storage) return installFile(targetPath, data, options);
  assertStorageWriteAllowed(
    storage.namespace,
    storage.writer,
    STORAGE_OWNERSHIP,
  );
  return admitStorageWrite(storage, () =>
    installFile(targetPath, data, options),
  );
}

async function installFile(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteOptions,
): Promise<void> {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let installed = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(tempPath, 'wx', options?.mode);
    try {
      await handle.writeFile(data, options?.encoding);
      if (options?.mode !== undefined) {
        await handle.chmod(options.mode).catch(() => undefined);
      }
      if (options?.durable === true) await handle.sync();
    } finally {
      await handle.close();
      handle = null;
    }
    if (options?.overwrite === false) {
      // A same-directory hard link atomically publishes the already-complete
      // temporary file without replacing a destination created by another
      // writer. This is supported by the local filesystems used on macOS and
      // Windows; callers can handle EEXIST as a compare-and-install loss.
      await link(tempPath, targetPath);
      await unlink(tempPath).catch(() => undefined);
    } else {
      await renameWithRetry(tempPath, targetPath);
    }
    installed = true;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!installed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
  if (options?.durable === true) await syncDirectory(dirname(targetPath));
}
