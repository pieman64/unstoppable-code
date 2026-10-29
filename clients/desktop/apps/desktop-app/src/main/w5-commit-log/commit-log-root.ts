import { ensureW5DataRoot as ensureW5DataRootWith } from '@canopy/core-runtime/node/w5/commit-log';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';

/** Prepares the W5 data root, flushing folders with the desktop's durability. */
export function ensureW5DataRoot(
  root: string,
  sync: (folder: string) => Promise<void> = desktopW5Durability.syncDirectory,
): Promise<void> {
  return ensureW5DataRootWith(root, sync);
}
