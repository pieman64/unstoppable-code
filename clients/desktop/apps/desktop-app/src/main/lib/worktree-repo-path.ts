import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { getWorkspaceWorktreeRepoDir } from './paths';
import { resolveWorktreeCwd } from './resolve-worktree';

/**
 * The checkout a worktree branch request targets: the worktree root for an
 * absent `repoId` or `WORKSPACE_ROOT_REPO_ID`, otherwise that child repo's
 * checkout under the worktree.
 */
export function resolveWorktreeRepoPath(request: {
  projectId: string;
  worktreeId: string;
  repoId?: string;
}): string {
  if (request.repoId && request.repoId !== WORKSPACE_ROOT_REPO_ID) {
    return getWorkspaceWorktreeRepoDir(
      request.projectId,
      request.worktreeId,
      request.repoId,
    );
  }
  return resolveWorktreeCwd(request.projectId, request.worktreeId);
}
