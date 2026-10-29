import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically, type AtomicFileStorage } from './atomic-file';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';

export interface W5FileReplacement {
  operation: string;
  advance: readonly W5Resource[];
  /** Exact text read inside the repository queue/lock; null means absent. */
  previousRaw: string | null;
  /** The rolling index backup belongs to the same decision, without revisions. */
  backup?: { path: string; contents: string; previousRaw: string | null };
}

/** One read of a W5 file: missing, its contents, or a read that failed. */
export type W5FileRead =
  | { state: 'absent' }
  | { state: 'present'; raw: string }
  | { state: 'unreadable'; error?: Error };

/**
 * The storage the W5 repositories read and replace their files through
 * (CAN-3800). Production commits through the CAN-3805 worker;
 * tests inject read and write faults.
 */
export interface W5FileStore {
  read(filePath: string): Promise<W5FileRead>;
  /**
   * Commits the replacement once storage admits it, then atomically installs
   * each file before resolving. Injected direct stores retain atomic replace.
   */
  replace(
    filePath: string,
    contents: string,
    storage: AtomicFileStorage,
    replacement: W5FileReplacement,
  ): Promise<void>;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

export const nodeW5FileStore: W5FileStore = {
  async read(filePath: string): Promise<W5FileRead> {
    try {
      return { state: 'present', raw: await readFile(filePath, 'utf8') };
    } catch (error) {
      return { state: errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable' };
    }
  },
  async replace(
    filePath: string,
    contents: string,
    storage: AtomicFileStorage,
    replacement: W5FileReplacement,
  ): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    if (replacement.backup) {
      await writeFileAtomically(
        replacement.backup.path,
        replacement.backup.contents,
        {
          encoding: 'utf8',
          storage,
        },
      );
    }
    await writeFileAtomically(filePath, contents, {
      encoding: 'utf8',
      storage,
    });
  },
};

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `next` plus every field of `previous` outside `knownKeys`. A W5 write keeps
 * data this version does not know, such as a field a newer app added, while
 * a known field `next` leaves undefined stays cleared.
 */
export function withUnknownFields(
  next: object,
  previous: Record<string, unknown> | undefined,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...next };
  if (previous === undefined) return merged;
  for (const [key, value] of Object.entries(previous)) {
    if (
      !knownKeys.has(key) &&
      !Object.prototype.hasOwnProperty.call(merged, key)
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

/** A serial queue: each task starts after every earlier one settles. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(
      (): void => undefined,
      (): void => undefined,
    );
    return run;
  };
}
