import type { BranchEntry, RepoBranchInfo } from '@canopy/desktop-shared/types';

export interface BranchOption {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  isUsedByWorktree: boolean;
  hasLocalRef: boolean;
  hasRemoteRef: boolean;
}

/**
 * Collapse local/remote duplicates: when a branch has both a local and remote
 * ref, keep only the local entry so the user sees a single option.
 *
 * Returns both local-only and remote-only branches.
 */
export function collapseBranchDuplicates(
  branches: BranchEntry[],
): BranchOption[] {
  const branchOptions = new Map<string, BranchOption>();

  for (const branch of branches) {
    const existingBranch = branchOptions.get(branch.name);
    if (!existingBranch) {
      branchOptions.set(branch.name, { ...branch });
      continue;
    }

    const nextBranch: BranchOption = {
      name: branch.name,
      isRemote: false,
      isCurrent: existingBranch.isCurrent || branch.isCurrent,
      isUsedByWorktree:
        existingBranch.isUsedByWorktree || branch.isUsedByWorktree,
      hasLocalRef: existingBranch.hasLocalRef || branch.hasLocalRef,
      hasRemoteRef: existingBranch.hasRemoteRef || branch.hasRemoteRef,
    };
    nextBranch.isRemote = nextBranch.hasRemoteRef && !nextBranch.hasLocalRef;
    branchOptions.set(branch.name, nextBranch);
  }

  return Array.from(branchOptions.values());
}

export function preserveBranchOption(
  branches: BranchOption[],
  branchName: string | null | undefined,
): BranchOption[] {
  const normalizedBranchName = branchName?.trim();
  if (!normalizedBranchName) {
    return branches;
  }

  if (branches.some((branch) => branch.name === normalizedBranchName)) {
    return branches;
  }

  return [
    {
      name: normalizedBranchName,
      isRemote: false,
      isCurrent: false,
      isUsedByWorktree: false,
      hasLocalRef: false,
      hasRemoteRef: false,
    },
    ...branches,
  ];
}

export function findBranchPresence(
  branches: BranchEntry[],
  branchName: string,
): { hasLocalRef: boolean; hasRemoteRef: boolean } {
  const initialPresence: { hasLocalRef: boolean; hasRemoteRef: boolean } = {
    hasLocalRef: false,
    hasRemoteRef: false,
  };

  return branches.reduce((presence, branch) => {
    if (branch.name !== branchName) {
      return presence;
    }

    return {
      hasLocalRef: presence.hasLocalRef || branch.hasLocalRef,
      hasRemoteRef: presence.hasRemoteRef || branch.hasRemoteRef,
    };
  }, initialPresence);
}

export function getBranchProvenanceBadge(
  branch: Pick<BranchOption, 'hasLocalRef' | 'hasRemoteRef'>,
): 'local' | 'remote' | null {
  if (branch.hasLocalRef && !branch.hasRemoteRef) {
    return 'local';
  }

  if (branch.hasRemoteRef && !branch.hasLocalRef) {
    return 'remote';
  }

  return null;
}

/**
 * Filter branches by a search string (case-insensitive substring match).
 */
export function filterBranchesBySearch(
  branches: BranchOption[],
  search: string,
): BranchOption[] {
  if (!search.trim()) return branches;
  const lowerSearch = search.toLowerCase();
  return branches.filter((b) => b.name.toLowerCase().includes(lowerSearch));
}

export function resolveDisplayedBaseBranch(params: {
  isMultiRepo: boolean | undefined;
  repoBranches: RepoBranchInfo[] | undefined;
  baseBranch: string | null | undefined;
  trackedBaseBranch: string | null | undefined;
}): string | null {
  const { isMultiRepo, repoBranches, baseBranch, trackedBaseBranch } = params;

  if (isMultiRepo && repoBranches && repoBranches.length > 0) {
    const bases = Array.from(
      new Set(
        repoBranches
          .map((branchInfo) => branchInfo.baseBranch)
          .filter((branch): branch is string => Boolean(branch)),
      ),
    );
    return bases.length === 1 ? bases[0] : null;
  }

  if (baseBranch !== undefined) {
    return baseBranch;
  }

  if (trackedBaseBranch !== undefined) {
    return trackedBaseBranch;
  }

  return repoBranches?.[0]?.baseBranch ?? null;
}
