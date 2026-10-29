import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import { createWorktreeAvoidingCheckedOutBranch, pruneWorktrees } from './git';
import { getWorkspaceWorktreeRepoDir } from './paths';
import { pathExists } from './fs-utils';
import { resolveWorkspaceWorktreeBranchName } from './workspace-worktree-runtime';

export async function addRepoCheckoutToWorktree(
  workspaceId: string,
  worktreeId: string,
  repo: WorkspaceRepoData,
  branchNameOverride?: string,
): Promise<void> {
  const repoWorktreePath = getWorkspaceWorktreeRepoDir(
    workspaceId,
    worktreeId,
    repo.id,
  );
  const branchName =
    branchNameOverride ??
    (await resolveWorkspaceWorktreeBranchName(
      workspaceId,
      worktreeId,
      repo.id,
    ));
  await mkdir(dirname(repoWorktreePath), { recursive: true });

  if (await pathExists(repoWorktreePath)) {
    const entries: string[] | null = await readdir(repoWorktreePath).catch(
      () => null,
    );
    if (!entries || entries.includes('.git') || entries.length > 0) {
      throw new Error(
        `Cannot add repo: ${repoWorktreePath} already exists and is not empty. Remove it manually if this is unexpected.`,
      );
    }
    await rm(repoWorktreePath, { recursive: true, force: true });
    await pruneWorktrees(repo.repoPath).catch(() => {});
  }

  // Fall back to a fresh branch at the seed's tip when the branch is already
  // checked out at another worktree of this repo (e.g. a split destination).
  await createWorktreeAvoidingCheckedOutBranch(
    repo.repoPath,
    repoWorktreePath,
    branchName,
  );
}
