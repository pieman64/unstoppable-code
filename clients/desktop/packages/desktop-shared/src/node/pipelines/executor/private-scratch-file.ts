import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { rmdirSync, unlinkSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  open,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Private scratch files that no process death can leave behind.
 *
 * Record, identity, key-index and frame storage hold raw, pre-masking child
 * output. Removing it on disposal covers every ending the process lives
 * through, but not one it does not: SIGKILL, a crash, power loss. A later
 * sweep cannot fix that safely — telling a dead owner's directory from a live
 * one, a reused process id or someone else's symlink is guesswork — so there
 * is nothing to sweep instead. Each file is opened, then unlinked BEFORE
 * anything is written to it. From then on it has no name: the open descriptor
 * is the only way to reach it, and the kernel frees it when the last
 * descriptor closes, which process death does unconditionally.
 *
 * Setup is ordered so that no step can leave text behind:
 *   - a fresh `0o700` directory from `mkdtemp`, owned from the moment it
 *     exists and removed on any later failure;
 *   - the file created exclusively (`wx+`, `0o600`), so an entry already at
 *     that path — a planted symlink included — fails setup instead of being
 *     followed;
 *   - the name unlinked while the file is still empty. A process killed
 *     before this point leaves at most an empty directory, never content.
 * If unlinking fails, setup fails: a store that cannot drop its name would
 * keep raw text reachable after a crash, and falling back to that silently is
 * the defect this exists to remove.
 *
 * The directory is removed straight away. Where the platform keeps an
 * unlinked-but-open file's entry until it closes (Windows without POSIX delete
 * semantics), that removal fails harmlessly and the caller removes the
 * directory on disposal; the file itself is still deleted when its handle
 * closes, including on process death.
 */
export interface ScratchFile {
  readonly handle: FileHandle;
  /** Where the file was created. Kept for error messages and disposal. */
  readonly directory: string;
  readonly path: string;
}

export async function openScratchFile(
  prefix: string,
  name: string,
): Promise<ScratchFile> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, name);
  let handle: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    handle = await open(path, 'wx+', 0o600);
    await unlink(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  await rmdir(directory).catch(() => undefined);
  return { handle, directory, path };
}

/**
 * `openScratchFile` for a store that keeps several files in one directory it
 * already created and restricted: the key index, whose slot file is replaced
 * as it grows. The same exclusive create and unlink-before-write ordering, so
 * after a hard kill that directory holds no names and no bytes. The directory
 * itself stays until the store is disposed, because later files are created
 * in it.
 */
export async function openScratchFileIn(
  directory: string,
  name: string,
): Promise<FileHandle> {
  const path = join(directory, name);
  const handle = await open(path, 'wx+', 0o600);
  try {
    await unlink(path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  return handle;
}

export interface ScratchDescriptor {
  readonly descriptor: number;
  readonly directory: string;
  readonly path: string;
}

/** `openScratchFile` for the synchronous frame spill. Same ordering. */
export function openScratchFileSync(
  prefix: string,
  name: string,
): ScratchDescriptor {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, name);
  let descriptor: number | undefined;
  try {
    chmodSync(directory, 0o700);
    descriptor = openSync(path, 'wx+', 0o600);
    unlinkSync(path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Already failing; the original error is the one to report.
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Same.
    }
    throw error;
  }
  try {
    rmdirSync(directory);
  } catch {
    // See `openScratchFile`: removed again on disposal.
  }
  return { descriptor, directory, path };
}
