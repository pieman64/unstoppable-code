import type { RepoBranchInfo } from '@canopy/desktop-shared/types';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';

export interface UnrenamedRepo {
  repoId: string;
  repoName: string;
  branchName: string;
}

interface BranchRenameWarningResult {
  shouldWarn: boolean;
  unrenamedRepos: UnrenamedRepo[];
}

export function shouldWarnBranchNotRenamed(params: {
  worktreeId: string;
  worktreeBranchName: string;
  isMultiRepo: boolean;
  hasBranchBeenPushed: boolean;
  repoBranches?: RepoBranchInfo[];
}): BranchRenameWarningResult {
  if (params.isMultiRepo) {
    const unrenamedRepos: UnrenamedRepo[] = (params.repoBranches ?? [])
      .filter(
        (rb) =>
          isDefaultWorktreeBranchName(rb.branch, params.worktreeId) &&
          !rb.hasBranchBeenPushed,
      )
      .map((rb) => ({
        repoId: rb.repoId,
        repoName: rb.repoName,
        branchName: rb.branch,
      }));

    return {
      shouldWarn: unrenamedRepos.length > 0,
      unrenamedRepos,
    };
  }

  const shouldWarn =
    isDefaultWorktreeBranchName(params.worktreeBranchName, params.worktreeId) &&
    !params.hasBranchBeenPushed;

  return { shouldWarn, unrenamedRepos: [] };
}
