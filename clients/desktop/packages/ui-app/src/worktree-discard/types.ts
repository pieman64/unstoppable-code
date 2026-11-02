/** A finished discard, for the host's own list and panel cleanup. */
export interface WorktreeDiscarded {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly warnings: readonly string[];
  /** The temporary project the discard left empty; the host drops it as archive does. */
  readonly removedTemporaryWorkspaceId?: string;
}
