import { renameBranch } from '../../lib/git';
import type { WorktreeBranchRenameGit } from '../../lib/worktree-branch-rename';
import { resolveWorktreeRepoPath } from '../../lib/worktree-repo-path';

/**
 * The W5 rename command's Git port without the dispatcher: the checkout the
 * desktop host resolves, renamed by the desktop helper the worker's port
 * runs. Suites that pin the command's records and ordering use it; the
 * dispatch itself is pinned by worktree-branch-rename-ipc.test.ts.
 */
export const inProcessBranchRenameGit: WorktreeBranchRenameGit = {
  renameCheckoutBranch: ({ workspaceId, worktreeId, repoId }, newBranchName) =>
    renameBranch(
      resolveWorktreeRepoPath({
        projectId: workspaceId,
        worktreeId,
        ...(repoId === undefined ? {} : { repoId }),
      }),
      newBranchName,
    ),
};
