/**
 * Build the composite scope key for a code-review chat sentinel scope.
 *
 * Worktree ids are only unique *within* a workspace (they are animal-name
 * placeholders assigned per workspace), so keying the code-review sidecar on a
 * bare worktreeId lets two workspaces that happen to share a worktree name
 * silently cross-wire: an open review chat could re-point at the other
 * workspace's checkout mid-session. Composing the real projectId with the real
 * worktreeId yields a globally-unique key.
 *
 * Both ids already match `/^[a-z0-9][a-z0-9-]*$/`, so the `--` separated
 * composite still satisfies `validateId` and is safe as a file name / chat
 * scope worktreeId.
 */
export function buildCodeReviewScopeKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}--${worktreeId}`;
}
