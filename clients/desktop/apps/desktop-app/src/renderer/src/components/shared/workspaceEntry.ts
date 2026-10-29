interface WorkspaceEntrySubtitleParams {
  isMultiRepo: boolean;
  repoCount: number;
  temporary: boolean;
}

/**
 * Subtitle for a workspace entry in the worktree-join pickers. Multi-repo
 * workspaces show "N repos" (with "• Temporary" appended for transient adhoc
 * workspaces); single-repo workspaces have no subtitle. Shared so the New
 * Worktrees and Existing Worktrees pickers render identical labels.
 */
export function describeWorkspaceSubtitle({
  isMultiRepo,
  repoCount,
  temporary,
}: WorkspaceEntrySubtitleParams): string | null {
  if (!isMultiRepo) {
    return null;
  }
  const baseLabel = `${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}`;
  return temporary ? `${baseLabel} • Temporary` : baseLabel;
}
