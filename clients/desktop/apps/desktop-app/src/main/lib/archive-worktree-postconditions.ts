import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isErrnoException } from './type-guards';
import { canonicalizePossiblyMissingPath } from './worktree-registration-removal';

const REMOVAL_UNVERIFIED_MESSAGE =
  "Couldn't verify that this worktree was removed from Git. Keep its archive and recovery files for manual recovery.";

/** A successful Git listing and absent checkout entries, including symlinks. */
export async function assertArchiveWorktreeRemoval(
  checkouts: readonly string[],
  listing: string,
): Promise<void> {
  const records = listing.split('\0\0').filter(Boolean);
  if (!listing.endsWith('\0\0') || records.length === 0) {
    throw new Error(REMOVAL_UNVERIFIED_MESSAGE);
  }
  const paths: string[] = [];
  for (const record of records) {
    const [path, ...fields] = record.split('\0');
    if (
      !path.startsWith('worktree ') ||
      !isAbsolute(path.slice('worktree '.length)) ||
      !fields.some(
        (field) => field === 'bare' || /^HEAD [0-9a-f]{40,64}$/.test(field),
      ) ||
      fields.some(
        (field) =>
          !/^(HEAD [0-9a-f]{40,64}|bare|branch .+|detached|locked(?: [\s\S]*)?|prunable(?: [\s\S]*)?)$/.test(
            field,
          ),
      )
    ) {
      throw new Error(REMOVAL_UNVERIFIED_MESSAGE);
    }
    paths.push(
      await canonicalizePossiblyMissingPath(path.slice('worktree '.length)),
    );
  }
  for (const checkout of checkouts) {
    const entry = await lstat(checkout).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      entry ||
      paths.includes(await canonicalizePossiblyMissingPath(checkout))
    ) {
      throw new Error(REMOVAL_UNVERIFIED_MESSAGE);
    }
  }
}
