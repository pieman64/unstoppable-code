import { lstat, opendir, realpath } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Worker-only traversal. No native database contents or paths leave this module. */
export interface BrowserInventoryTotals {
  approximateBytes: number | null;
  files: number;
  directories: number;
  skippedEntries: number;
  partial: boolean;
}

export async function scanBrowserProfileDirectory(
  directory: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (totals: BrowserInventoryTotals) => void;
    maxEntries?: number;
  } = {},
): Promise<BrowserInventoryTotals> {
  const totals: BrowserInventoryTotals = {
    approximateBytes: 0,
    files: 0,
    directories: 0,
    skippedEntries: 0,
    partial: false,
  };
  const rootStat = await lstat(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (!rootStat) return totals;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Browser storage is not an owned directory.');
  const root = await realpath(directory);
  const limit = options.maxEntries ?? 2_000_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000_000)
    throw new Error('Invalid inventory limit.');
  const stack: { path: string; entries: Dir }[] = [];
  const push = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    const inside = relative(root, await realpath(path));
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      isAbsolute(inside) ||
      inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      stack.length >= 64
    ) {
      totals.skippedEntries++;
      totals.partial = true;
      return;
    }
    stack.push({ path, entries: await opendir(path, { bufferSize: 32 }) });
    totals.directories++;
  };
  let visited = 0;
  let lastProgress = 0;
  await push(root);
  try {
    while (stack.length) {
      options.signal?.throwIfAborted();
      const current = stack[stack.length - 1];
      const entry = await current.entries.read().catch(() => {
        totals.skippedEntries++;
        totals.partial = true;
        return null;
      });
      if (!entry) {
        stack.pop();
        await current.entries.close();
        continue;
      }
      if (++visited > limit) {
        totals.partial = true;
        break;
      }
      const path = join(current.path, entry.name);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
          totals.skippedEntries++;
          totals.partial = true;
        } else if (stat.isDirectory()) await push(path);
        else if (stat.isFile()) {
          totals.files++;
          if (totals.approximateBytes !== null) {
            const nextBytes = totals.approximateBytes + stat.size;
            totals.approximateBytes = Number.isSafeInteger(nextBytes)
              ? nextBytes
              : null;
            if (totals.approximateBytes === null) totals.partial = true;
          }
        } else {
          totals.skippedEntries++;
          totals.partial = true;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        totals.skippedEntries++;
        totals.partial = true;
      }
      if (Date.now() - lastProgress >= 200) {
        lastProgress = Date.now();
        options.onProgress?.({ ...totals });
      }
    }
  } finally {
    await Promise.allSettled(stack.map(({ entries }) => entries.close()));
  }
  return totals;
}
