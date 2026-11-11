import type { RmOptions } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import { validateId } from '@canopy/execution-engine/node/lib/validation';

export const WORKTREE_DATA_REMOVE_MAX_RETRIES = 20;
export const WORKTREE_DATA_REMOVE_RETRY_DELAY_MS = 100;

export async function removePersistedWorktreeDataDirectory(
  workspaceId: string,
  worktreeId: string,
  options?: {
    /**
     * Absolute worktree-data root for this workspace. Callers that route
     * app-managed chat workspaces through `app-workspaces/{id}/worktree-data`
     * (the desktop app's `getWorktreeDataRootDir`) must pass the resolved
     * root; the default covers user workspaces only.
     */
    worktreeDataRootDir?: string;
    /** Host filesystem adapter; Electron must unlink ASAR files physically. */
    removeTree?: (path: string, options: RmOptions) => Promise<void>;
  },
): Promise<void> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const root =
    options?.worktreeDataRootDir ??
    join(getCanopyDataDir(), 'workspaces', workspaceId, 'worktree-data');
  const target = join(root, worktreeId);
  if (target === root || !isPathInside(root, target)) {
    throw new Error('Invalid worktree data cleanup path');
  }
  const removeTree = options?.removeTree ?? rm;
  await removeTree(target, {
    recursive: true,
    force: true,
    maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
    retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
  });
}
