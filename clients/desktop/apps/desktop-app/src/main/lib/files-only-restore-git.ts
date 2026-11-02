import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { isErrnoException } from './type-guards';

async function hasGitPointer(checkoutPath: string): Promise<boolean> {
  try {
    await lstat(join(checkoutPath, '.git'));
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return false;
    throw error;
  }
}

/**
 * Whether a checkout restored from a files-only archive is still Git-less: no
 * `.git` pointer at its root nor, for multi-repo, in any `repos/` entry. Its
 * archive then keeps the files through the files-only recovery; an installed
 * pointer takes the Git capture. Shared by that archive and project deletion's
 * admission (CAN-4985).
 */
export async function isFilesOnlyRestoreGitless(
  checkoutPath: string,
  workspaceType: 'single-repo' | 'multi-repo',
): Promise<boolean> {
  if (await hasGitPointer(checkoutPath)) return false;
  if (workspaceType === 'single-repo') return true;
  const repoNames = await readdir(join(checkoutPath, 'repos')).catch(
    (error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const repoPointers = await settleAll(
    repoNames.map((name) => hasGitPointer(join(checkoutPath, 'repos', name))),
  );
  return !repoPointers.some(Boolean);
}
