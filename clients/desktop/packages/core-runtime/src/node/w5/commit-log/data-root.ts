import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Creates the W5 data root when it is missing, then flushes the entry of the
 * root and of each folder above it, so a commit applied inside the root never
 * outlives the root itself. Commits are applied only inside an existing root,
 * so without it a first commit would land as awaiting recovery.
 *
 * The flush runs on every start, not only when this call created the root: a
 * worker that stopped between creating it and flushing it leaves a root that
 * already exists.
 */
export async function ensureW5DataRoot(
  root: string,
  /** The host's folder sync: its durability port's `syncDirectory`. */
  sync: (folder: string) => Promise<void>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (
    let folder = resolve(root);
    dirname(folder) !== folder;
    folder = dirname(folder)
  ) {
    await sync(dirname(folder));
  }
}
