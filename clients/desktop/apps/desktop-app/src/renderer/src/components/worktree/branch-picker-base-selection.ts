import type { BranchEntry } from '@canopy/desktop-shared/types';

export interface BranchPickerBaseSelection {
  name: string;
  isRemote: boolean;
}

function branchExistsInRemote(
  branches: BranchEntry[],
  branchName: string,
): boolean {
  return branches.some(
    (branch) => branch.name === branchName && branch.hasRemoteRef,
  );
}

export function resolveBranchPickerBaseSelection(
  branches: BranchEntry[],
  preferredBaseBranch: string | null | undefined,
  defaultBranch: string | null,
): BranchPickerBaseSelection {
  const name = preferredBaseBranch ?? defaultBranch ?? 'main';

  return {
    name,
    isRemote: branchExistsInRemote(branches, name),
  };
}
