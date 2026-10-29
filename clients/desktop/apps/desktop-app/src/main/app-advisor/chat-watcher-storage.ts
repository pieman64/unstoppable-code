import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fsyncDirectory } from '../lib/fsync-directory';

interface CanonicalWatcherStoreFile {
  [key: string]: unknown;
  version: 1;
  updatedAt: string;
  watchers: unknown[];
}

/**
 * Canonical-only rows never enter the downgrade-readable legacy file. Keep
 * opaque rows intact here; the service owns validation and its mutation queue.
 * Only an absent sidecar initializes empty. An unreadable or future format
 * must not be replaced by an empty store, losing pending deliveries.
 */
export async function readCanonicalWatcherStore(
  filePath: string,
): Promise<unknown[]> {
  return (await readStoreFile(filePath)).watchers;
}

/**
 * Called within the watcher's single mutation queue. Preserve additive envelope
 * fields from the latest file and every supplied row verbatim. The caller must
 * retain rows it cannot interpret when constructing the replacement array.
 */
export async function writeCanonicalWatcherStore(
  filePath: string,
  rows: readonly unknown[],
): Promise<void> {
  const previous = await readStoreFile(filePath);
  const serialized = `${JSON.stringify({
    ...previous,
    version: 1,
    updatedAt: new Date().toISOString(),
    watchers: rows,
  })}\n`;
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

async function readStoreFile(
  filePath: string,
): Promise<CanonicalWatcherStoreFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { version: 1, updatedAt: new Date().toISOString(), watchers: [] };
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('watchers' in parsed) ||
    !Array.isArray(parsed.watchers)
  ) {
    throw new Error('Canonical watcher store has an unsupported format.');
  }
  return {
    ...parsed,
    version: 1,
    updatedAt:
      'updatedAt' in parsed && typeof parsed.updatedAt === 'string'
        ? parsed.updatedAt
        : new Date().toISOString(),
    watchers: parsed.watchers,
  };
}
