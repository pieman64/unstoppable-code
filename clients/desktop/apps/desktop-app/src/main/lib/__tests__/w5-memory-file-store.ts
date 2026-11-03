import type { W5FileStore } from '../w5-file-store';

/** An in-memory W5 file store with injectable read and write faults. */
export interface MemoryFileStore {
  store: W5FileStore;
  files: Map<string, string>;
  /** Paths whose next reads fail. */
  unreadable: Set<string>;
  /** Paths whose next writes fail. */
  failingWrites: Set<string>;
  /** Every successful replace, in order. */
  writes: string[];
}

export function createMemoryFileStore(
  initial: Record<string, string> = {},
): MemoryFileStore {
  const files = new Map(Object.entries(initial));
  const unreadable = new Set<string>();
  const failingWrites = new Set<string>();
  const writes: string[] = [];
  const store: W5FileStore = {
    async read(filePath) {
      // Yield, so an unserialized read-modify-write would interleave.
      await new Promise((resolve) => setImmediate(resolve));
      if (unreadable.has(filePath)) return { state: 'unreadable' };
      const raw = files.get(filePath);
      return raw === undefined
        ? { state: 'absent' }
        : { state: 'present', raw };
    },
    async remove(filePath) {
      await new Promise((resolve) => setImmediate(resolve));
      if (failingWrites.has(filePath)) throw new Error('ENOSPC');
      files.delete(filePath);
      writes.push(filePath);
    },
    async replace(filePath, contents, _storage, replacement) {
      await new Promise((resolve) => setImmediate(resolve));
      if (failingWrites.has(filePath)) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      }
      if (replacement.backup) {
        if (failingWrites.has(replacement.backup.path))
          throw new Error('ENOSPC');
        files.set(replacement.backup.path, replacement.backup.contents);
        writes.push(replacement.backup.path);
      }
      files.set(filePath, contents);
      writes.push(filePath);
    },
  };
  return { store, files, unreadable, failingWrites, writes };
}
