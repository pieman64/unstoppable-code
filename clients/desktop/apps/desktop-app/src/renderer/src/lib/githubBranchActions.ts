// The header's git action decisions now live in `@canopy/ui-app` so the
// shared PR actions decide the same way on desktop and web (REG-3025).
// Re-exported here to keep existing `@/lib/githubBranchActions` imports
// stable.
export {
  getMultiRepoBranchSyncVisibility,
  getSingleRepoBranchSyncVisibility,
  getSingleRepoGitAction,
  repoCanCreatePr,
  repoCanMergeLocalBranch,
  repoHasChanges,
  repoIsLocalOnly,
  repoRequiresCommitAndPush,
  repoRequiresCommitOnly,
  repoRequiresPush,
  type BranchSyncAction,
  type BranchSyncVisibility,
  type PullRequestBranchFacts,
  type SingleRepoGitAction,
} from '@canopy/ui-app/pull-requests';
