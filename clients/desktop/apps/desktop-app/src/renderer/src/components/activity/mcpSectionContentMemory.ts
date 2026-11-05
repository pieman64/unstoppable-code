/**
 * Whether the Activity panel's MCP section last resolved with content, per
 * worktree and most recently overall, so a restarted detection can keep
 * showing that answer instead of guessing.
 */
const byWorktree = new Map<string, boolean>();
let latest: boolean | undefined;

export function rememberMcpSectionContent(
  worktreeKey: string,
  hasContent: boolean,
): void {
  byWorktree.set(worktreeKey, hasContent);
  latest = hasContent;
}

export function recallMcpSectionContent(
  worktreeKey: string,
): boolean | undefined {
  return byWorktree.get(worktreeKey) ?? latest;
}
