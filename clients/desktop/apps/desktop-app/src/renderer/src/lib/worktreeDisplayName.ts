import {
  DEFAULT_WORKTREE_DISPLAY_NAME,
  isDefaultWorktreeBranchName,
} from '@canopy/desktop-shared/lib/default-worktree-branch';

export function getWorktreeBranchDisplayName(params: {
  rawBranch: string;
  worktreeId: string;
  hasMultipleBranches: boolean;
  getBranchDisplayName: (branchName: string) => string;
  /** Name for a generated default branch; defaults to "New Task". */
  defaultDisplayName?: string;
}): string {
  if (params.hasMultipleBranches) {
    return params.rawBranch;
  }

  if (isDefaultWorktreeBranchName(params.rawBranch, params.worktreeId)) {
    return params.defaultDisplayName ?? DEFAULT_WORKTREE_DISPLAY_NAME;
  }

  return params.getBranchDisplayName(params.rawBranch);
}
