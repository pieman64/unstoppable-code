/**
 * The live worktree state that blocks Split project. A split moves checkouts
 * and tears the source down, so — mirroring the Split PR launch gating —
 * active agent chats and active (running or paused) pipelines block it, as do
 * done worktrees and in-flight setup.
 */
export interface SplitWorkspaceGates {
  readonly hasActiveSession: boolean;
  readonly hasActivePipelines: boolean;
  readonly isDone: boolean;
  readonly isPendingGitSetup: boolean;
  readonly isRunningSetup: boolean;
}

export interface SplitWorkspaceMenuState {
  readonly disabled: boolean;
  /** Why the item is disabled, in precedence order; absent when enabled. */
  readonly tooltip: string | undefined;
}

/** Split project's availability, shared by both sidebar rails' row menus. */
export function getSplitWorkspaceMenuState(
  gates: SplitWorkspaceGates,
): SplitWorkspaceMenuState {
  const tooltip = gates.hasActiveSession
    ? 'Wait for active agent chats to finish'
    : gates.hasActivePipelines
      ? 'Wait for active pipelines to finish'
      : gates.isDone
        ? 'Done worktrees cannot be split'
        : gates.isPendingGitSetup || gates.isRunningSetup
          ? 'Wait for setup to finish before splitting the project'
          : undefined;
  return { disabled: tooltip !== undefined, tooltip };
}
