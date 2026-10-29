import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Files larger than this are skipped so artifacts cannot inflate line counts
 * or stall the changed-files projection.
 */
export const MAX_UNTRACKED_FILE_BYTES = 512_000;
export const MAX_UNTRACKED_FILES = 200;
const MAX_CONCURRENT_UNTRACKED_FILE_READS = 16;
const MAX_UNTRACKED_INSERTIONS = 100_000;
/** Git's binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

/** One untracked file's estimated added lines, and whether it is binary. */
export interface UntrackedChange {
  readonly insertions: number;
  readonly binary: boolean;
}

const NO_CHANGE: UntrackedChange = { insertions: 0, binary: false };

async function estimateOneUntrackedFile(
  filePath: string,
): Promise<UntrackedChange> {
  const initialStats = await lstat(filePath);
  if (!initialStats.isFile()) return NO_CHANGE;
  if (initialStats.size > MAX_UNTRACKED_FILE_BYTES) {
    return NO_CHANGE;
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return NO_CHANGE;
    if (openedStats.size > MAX_UNTRACKED_FILE_BYTES) {
      return NO_CHANGE;
    }
    const buffer = Buffer.allocUnsafe(MAX_UNTRACKED_FILE_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > MAX_UNTRACKED_FILE_BYTES) {
      return NO_CHANGE;
    }
    if (
      buffer
        .subarray(0, Math.min(totalBytesRead, BINARY_SNIFF_BYTES))
        .includes(0)
    ) {
      // Binary, as git classifies it: it has no lines to count.
      return { insertions: 0, binary: true };
    }
    const content = buffer.toString('utf8', 0, totalBytesRead);
    return {
      insertions:
        content.length === 0
          ? 0
          : content.split('\n').length - (content.endsWith('\n') ? 1 : 0),
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Line counts for untracked files, which `git diff --numstat` never lists
 * because they have no HEAD side. Every changed-files surface (the desktop
 * activity panel, the Portal `changed_files` entity read by web and mobile)
 * uses this so an added file shows `+N` like a tracked one.
 *
 * Unreadable files count as 0 rather than failing the whole listing.
 */
export async function estimateUntrackedInsertions(
  worktreePath: string,
  files: readonly string[],
): Promise<number[]> {
  return (await estimateUntrackedChanges(worktreePath, files)).map(
    (change) => change.insertions,
  );
}

/**
 * {@link estimateUntrackedInsertions} with each file's binary classification,
 * so a changed-files row can say "Binary" instead of a line count (REG-3024).
 */
export async function estimateUntrackedChanges(
  worktreePath: string,
  files: readonly string[],
): Promise<UntrackedChange[]> {
  const counts = new Array<UntrackedChange>(files.length);
  let nextIndex = 0;
  const workers = Array.from(
    {
      length: Math.min(files.length, MAX_CONCURRENT_UNTRACKED_FILE_READS),
    },
    async () => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        const file = files[index];
        if (file === undefined) continue;
        let count = NO_CHANGE;
        try {
          count = await estimateOneUntrackedFile(join(worktreePath, file));
        } catch {
          // Unreadable files count as zero without failing the whole listing.
        }
        counts[index] = count;
      }
    },
  );
  await Promise.all(workers);
  // Apply the ceiling after reads finish so filesystem timing cannot change
  // which files contribute to the displayed aggregate.
  let remaining = MAX_UNTRACKED_INSERTIONS;
  return counts.map((change) => {
    const insertions = Math.min(change.insertions, remaining);
    remaining -= insertions;
    return { ...change, insertions };
  });
}
