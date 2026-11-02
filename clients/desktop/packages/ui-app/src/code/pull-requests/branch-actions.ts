/**
 * The worktree header's git action decisions (REG-3025): which branch-sync
 * action applies to a repository, from its git facts alone. Moved from the
 * desktop renderer so the shared `PullRequestActions` decides the same way on
 * every host.
 */

/**
 * The git facts these decisions read for one repository. Desktop's
 * `RepoBranchInfo` satisfies it; other hosts fill what they sample.
 */
export interface PullRequestBranchFacts {
  readonly repoId: string;
  readonly commitsAhead?: boolean;
  readonly hasUncommittedChanges?: boolean;
  readonly hasUnpushedCommits?: boolean;
  readonly hasUnpulledCommits?: boolean;
  readonly hasRemoteTrackingBranch?: boolean;
  readonly hasOriginRemote?: boolean;
  readonly baseBranchExistsLocally?: boolean;
  readonly insertions?: number;
  readonly deletions?: number;
}

export type BranchSyncAction =
  | 'commit'
  | 'commit-and-push'
  | 'pull-commit-and-push'
  | 'push'
  | 'pull';
export type SingleRepoGitAction =
  | 'none'
  | 'create-pr'
  | 'commit'
  | 'merge'
  | 'commit-and-push'
  | 'pull-commit-and-push'
  | 'push'
  | 'pull';

export interface BranchSyncVisibility {
  showCommit: boolean;
  showCommitAndPush: boolean;
  showPullCommitAndPush: boolean;
  showPush: boolean;
  showPull: boolean;
}

export function repoHasChanges(branch?: PullRequestBranchFacts): boolean {
  if (!branch) {
    return false;
  }

  return (
    branch.commitsAhead === true ||
    branch.hasUncommittedChanges === true ||
    branch.hasUnpushedCommits === true ||
    (branch.insertions ?? 0) > 0 ||
    (branch.deletions ?? 0) > 0
  );
}

/** True when `branch.hasOriginRemote === false`. */
export function repoIsLocalOnly(branch?: PullRequestBranchFacts): boolean {
  return branch?.hasOriginRemote === false;
}

/** True when local-only AND `hasUncommittedChanges === true`. */
export function repoRequiresCommitOnly(
  branch?: PullRequestBranchFacts,
): boolean {
  return repoIsLocalOnly(branch) && branch?.hasUncommittedChanges === true;
}

/**
 * True when local-only AND `hasUncommittedChanges !== true` AND
 * `commitsAhead === true` AND `baseBranchExistsLocally === true`.
 */
export function repoCanMergeLocalBranch(
  branch?: PullRequestBranchFacts,
): boolean {
  return (
    repoIsLocalOnly(branch) &&
    branch?.hasUncommittedChanges !== true &&
    branch?.commitsAhead === true &&
    branch?.baseBranchExistsLocally === true
  );
}

export function repoRequiresPullCommitAndPush(
  branch?: PullRequestBranchFacts,
): boolean {
  return (
    branch?.hasRemoteTrackingBranch === true &&
    branch.hasUncommittedChanges === true &&
    branch.hasUnpulledCommits === true
  );
}

export function repoRequiresCommitAndPush(
  branch?: PullRequestBranchFacts,
): boolean {
  return (
    branch?.hasRemoteTrackingBranch === true &&
    branch.hasUncommittedChanges === true &&
    branch.hasUnpulledCommits !== true
  );
}

export function repoRequiresPull(branch?: PullRequestBranchFacts): boolean {
  return (
    branch?.hasRemoteTrackingBranch === true &&
    branch.hasUncommittedChanges !== true &&
    branch.hasUnpulledCommits === true
  );
}

export function repoRequiresPush(branch?: PullRequestBranchFacts): boolean {
  return (
    branch?.hasRemoteTrackingBranch === true &&
    branch.hasUncommittedChanges !== true &&
    branch.hasUnpulledCommits !== true &&
    branch.hasUnpushedCommits === true
  );
}

export function repoCanCreatePr(branch?: PullRequestBranchFacts): boolean {
  if (branch?.hasOriginRemote === false) {
    return false;
  }
  return (
    repoHasChanges(branch) &&
    !repoRequiresCommitAndPush(branch) &&
    !repoRequiresPullCommitAndPush(branch) &&
    !repoRequiresPull(branch) &&
    !repoRequiresPush(branch)
  );
}

export function getSingleRepoBranchSyncVisibility(params: {
  hasRemoteTracking: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasUnpulledCommits: boolean;
}): BranchSyncVisibility {
  const showPullCommitAndPush =
    params.hasRemoteTracking &&
    params.hasUncommittedChanges &&
    params.hasUnpulledCommits;
  const showCommitAndPush =
    params.hasRemoteTracking &&
    params.hasUncommittedChanges &&
    !params.hasUnpulledCommits;
  const showPull =
    params.hasRemoteTracking &&
    !params.hasUncommittedChanges &&
    params.hasUnpulledCommits;
  const showPush =
    params.hasRemoteTracking &&
    !params.hasUncommittedChanges &&
    !params.hasUnpulledCommits &&
    params.hasUnpushedCommits;

  return {
    showCommit: false,
    showCommitAndPush,
    showPullCommitAndPush,
    showPush,
    showPull,
  };
}

export function getSingleRepoGitAction(params: {
  hasOpenPr: boolean;
  hasAnyChanges: boolean;
  hasRemoteTracking: boolean;
  hasOriginRemote?: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasUnpulledCommits: boolean;
  commitsAhead?: boolean;
  baseBranchExistsLocally?: boolean;
}): SingleRepoGitAction {
  // Local-only repos: bypass the remote-backed decision tree entirely.
  if (params.hasOriginRemote === false) {
    if (params.hasUncommittedChanges) {
      return 'commit';
    }
    if (
      params.commitsAhead === true &&
      params.baseBranchExistsLocally === true
    ) {
      return 'merge';
    }
    return 'none';
  }

  if (
    params.hasRemoteTracking &&
    !params.hasUncommittedChanges &&
    params.hasUnpulledCommits
  ) {
    return 'pull';
  }

  if (!params.hasAnyChanges) {
    return 'none';
  }

  if (!params.hasOpenPr) {
    return 'create-pr';
  }

  if (
    params.hasRemoteTracking &&
    params.hasUncommittedChanges &&
    params.hasUnpulledCommits
  ) {
    return 'pull-commit-and-push';
  }

  if (params.hasRemoteTracking && params.hasUncommittedChanges) {
    return 'commit-and-push';
  }

  if (params.hasRemoteTracking && params.hasUnpushedCommits) {
    return 'push';
  }

  return 'none';
}

export function getMultiRepoBranchSyncVisibility(
  repoBranches?: readonly PullRequestBranchFacts[],
  repoIds?: readonly string[],
): BranchSyncVisibility {
  const repoIdSet = repoIds ? new Set(repoIds) : null;
  const scopedBranches = repoIdSet
    ? repoBranches?.filter((branch) => repoIdSet.has(branch.repoId))
    : repoBranches;

  return {
    showCommit:
      scopedBranches?.some((branch) => repoRequiresCommitOnly(branch)) ?? false,
    showCommitAndPush:
      scopedBranches?.some((branch) => repoRequiresCommitAndPush(branch)) ??
      false,
    showPullCommitAndPush:
      scopedBranches?.some((branch) => repoRequiresPullCommitAndPush(branch)) ??
      false,
    showPush:
      scopedBranches?.some((branch) => repoRequiresPush(branch)) ?? false,
    showPull:
      scopedBranches?.some((branch) => repoRequiresPull(branch)) ?? false,
  };
}
