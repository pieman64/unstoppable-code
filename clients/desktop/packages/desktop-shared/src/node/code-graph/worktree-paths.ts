import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';

/**
 * Directory holding a single worktree's code-graph database (and any sqlite
 * -wal/-shm sidecars). Lives under the shared `worktree-data/{worktreeId}/`
 * sibling tree so `worktree-data-cleanup.ts`'s recursive removal deletes it
 * along with every other worktree-scoped artifact.
 *
 * This helper intentionally lives in `packages/desktop-shared` (not
 * `apps/desktop-app/src/main/lib/paths.ts`, which is Electron-main-only) so
 * both the desktop app and the headless CLI compute the identical path from
 * the same `getCanopyDataDir()` root.
 */
export function getWorktreeCodeGraphDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return path.join(
    getCanopyDataDir(),
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'code-graph',
  );
}

export function getWorktreeCodeGraphDbPath(
  workspaceId: string,
  worktreeId: string,
): string {
  return path.join(
    getWorktreeCodeGraphDir(workspaceId, worktreeId),
    'graph.db',
  );
}
