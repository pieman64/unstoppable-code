import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/*
 * The v1 file-annotations state file of one worktree. Electron main is its
 * only writer: the host resolves the file's path with its canonical helper and
 * owns the one engine that writes it (CAN-4104).
 */

const writeLocks = new Map<string, Promise<void>>();

/** Serializes read-modify-write cycles on one state file in this process. */
export async function withAnnotationStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = writeLocks.get(statePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(statePath, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(statePath) === next) {
      writeLocks.delete(statePath);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  // Not `instanceof Error`: fs errors can come from another realm.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** The raw state text, or null before the first write. */
export async function readAnnotationStateText(
  statePath: string,
): Promise<string | null> {
  try {
    return await readFile(statePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** Replaces the state file atomically through a sibling temporary file. */
export async function writeAnnotationStateText(
  statePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = join(
    dirname(statePath),
    `.file-annotations-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, statePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
