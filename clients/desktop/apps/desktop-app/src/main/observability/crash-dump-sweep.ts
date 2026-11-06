import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMissingFileError } from '../lib/fs-utils';
import { isPathInside } from '../lib/path-safety';

/** Dumps older than this are deleted. */
export const CRASH_DUMP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Of the dumps within the age limit, at most this many newest are kept. */
export const CRASH_DUMP_MAX_KEPT = 20;
/** Deep enough for every Crashpad layout; bounds a hostile directory tree. */
const MAX_DIRECTORY_DEPTH = 8;

export type CrashDumpSweepVerdict = 'process' | 'discard';

export interface CrashDumpSweepDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface CrashDumpSweepStats {
  readonly mtimeMs: number;
  isFile(): boolean;
}

/** The file system calls the sweep makes; injectable for tests. */
export interface CrashDumpSweepFs {
  readonly readdir: (
    directory: string,
    options: { readonly withFileTypes: true },
  ) => Promise<readonly CrashDumpSweepDirent[]>;
  readonly lstat: (filePath: string) => Promise<CrashDumpSweepStats>;
  readonly unlink: (filePath: string) => Promise<void>;
}

export const nodeCrashDumpSweepFs: CrashDumpSweepFs = {
  readdir: (directory) => readdir(directory, { withFileTypes: true }),
  lstat: (filePath) => lstat(filePath),
  unlink: (filePath) => unlink(filePath),
};

export interface CrashDumpSweepOptions {
  /** Absolute path of Electron's `crashDumps` directory. */
  readonly crashDumpsDir: string;
  /**
   * Decides whether a dump is Canopy's (`process`) or a foreign process's
   * (`discard`). Pass the foreign crash-dump filter where it applies; without
   * one, every dump is treated as Canopy's. A throwing classifier keeps the
   * dump and counts an error.
   */
  readonly classify?: (filePath: string) => Promise<CrashDumpSweepVerdict>;
  readonly fs?: CrashDumpSweepFs;
  readonly now?: () => number;
}

/** Counts only; the sweep never reports paths. */
export interface CrashDumpSweepResult {
  /** `.dmp` files found outside `new/`. */
  readonly listed: number;
  /** Deleted because the classifier returned `discard`. */
  readonly discardedForeign: number;
  /** Deleted by the age limit or the newest-count cap. */
  readonly deletedByRetention: number;
  /** Canopy's dumps left in place. */
  readonly kept: number;
  /** Files or directories that could not be read, classified, or deleted. */
  readonly errors: number;
}

interface ListedDump {
  readonly filePath: string;
  readonly mtimeMs: number;
}

export interface CrashDumpFileListing {
  /** Absolute paths of `.dmp` files inside the root, outside `new/`. */
  readonly filePaths: readonly string[];
  /** Directories or entries that could not be listed safely. */
  readonly errors: number;
}

function isInsideCrashDumpsRoot(root: string, candidate: string): boolean {
  return candidate !== root && isPathInside(root, candidate);
}

/**
 * Lists the `.dmp` files under `crashDumpsDir`, recursively, skipping
 * Crashpad's top-level `new/` directory (dumps still being written) and
 * symlinks. A missing directory lists nothing and is not an error.
 */
export async function listCrashDumpFiles(
  crashDumpsDir: string,
  fs: Pick<CrashDumpSweepFs, 'readdir'> = nodeCrashDumpSweepFs,
): Promise<CrashDumpFileListing> {
  const root = resolve(crashDumpsDir);
  const newDirectory = join(root, 'new');
  const filePaths: string[] = [];
  let errors = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: readonly CrashDumpSweepDirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingFileError(error)) errors += 1;
      return;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (!isInsideCrashDumpsRoot(root, entryPath)) {
        errors += 1;
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entryPath === newDirectory || depth >= MAX_DIRECTORY_DEPTH) {
          continue;
        }
        await walk(entryPath, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
        filePaths.push(entryPath);
      }
    }
  };

  await walk(root, 0);
  return { filePaths, errors };
}

/**
 * Deletes foreign crash dumps and applies Canopy's retention to the rest:
 * dumps older than {@link CRASH_DUMP_MAX_AGE_MS} go first, then all but the
 * newest {@link CRASH_DUMP_MAX_KEPT}. Crashpad's `new/` directory holds dumps
 * still being written and is never touched. Only paths inside
 * `crashDumpsDir` are deleted. A file that disappears mid-sweep (Crashpad
 * moves dumps between directories) is already gone, not an error, and is
 * counted only in `listed`. One bad file never stops the sweep.
 */
export async function sweepCrashDumps(
  options: CrashDumpSweepOptions,
): Promise<CrashDumpSweepResult> {
  const fs = options.fs ?? nodeCrashDumpSweepFs;
  const now = options.now ?? Date.now;
  const root = resolve(options.crashDumpsDir);
  const listing = await listCrashDumpFiles(root, fs);
  const listed = listing.filePaths.length;
  let discardedForeign = 0;
  let deletedByRetention = 0;
  let errors = listing.errors;

  /** Deletes one dump inside the root; counts an error when it cannot. */
  const remove = async (
    filePath: string,
  ): Promise<'deleted' | 'gone' | 'failed'> => {
    if (!isInsideCrashDumpsRoot(root, filePath)) {
      errors += 1;
      return 'failed';
    }
    try {
      await fs.unlink(filePath);
      return 'deleted';
    } catch (error) {
      if (isMissingFileError(error)) return 'gone';
      errors += 1;
      return 'failed';
    }
  };

  const dumps: ListedDump[] = [];
  for (const filePath of listing.filePaths) {
    let stats: CrashDumpSweepStats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) errors += 1;
      continue;
    }
    if (!stats.isFile()) continue;

    let verdict: CrashDumpSweepVerdict = 'process';
    if (options.classify !== undefined) {
      try {
        verdict = await options.classify(filePath);
      } catch {
        errors += 1;
        verdict = 'process';
      }
    }
    if (verdict === 'discard') {
      if ((await remove(filePath)) === 'deleted') discardedForeign += 1;
      continue;
    }
    dumps.push({ filePath, mtimeMs: stats.mtimeMs });
  }

  const cutoff = now() - CRASH_DUMP_MAX_AGE_MS;
  const fresh: ListedDump[] = [];
  for (const dump of dumps) {
    if (dump.mtimeMs >= cutoff) {
      fresh.push(dump);
      continue;
    }
    if ((await remove(dump.filePath)) === 'deleted') deletedByRetention += 1;
  }

  fresh.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.filePath.localeCompare(right.filePath),
  );
  let kept = 0;
  for (const [index, dump] of fresh.entries()) {
    if (index < CRASH_DUMP_MAX_KEPT) {
      kept += 1;
      continue;
    }
    if ((await remove(dump.filePath)) === 'deleted') deletedByRetention += 1;
  }

  return { listed, discardedForeign, deletedByRetention, kept, errors };
}
