/**
 * Shared copy for worktree removal: action labels, confirmation titles, and
 * retention outcomes for Archive and Delete, plus the branch-choice hint.
 * Desktop and web confirmations both read these so batch and single-row
 * removal describe retention the same way.
 */

/** Which retained state a worktree removal lands in. */
export type WorktreeRemovalMode = 'delete' | 'archive';

export interface WorktreeDeleteLabels {
  /** Hover-revealed destructive action label for non-done worktrees. */
  archiveActionLabel: string;
  /**
   * Label for the always-visible done-worktree action and the standalone
   * delete shortcut (both bypass or precede the confirmation dialog).
   */
  standaloneActionLabel: string;
  /** Confirmation dialog heading. */
  dialogTitle: string;
  /** Confirmation dialog destructive button label. */
  dialogConfirmLabel: string;
  /** One-line retention outcome shown in the confirmation dialog. */
  retentionSummary: string;
  /** Full retention explanation behind the dialog's info button. */
  retentionDetail: string;
  /** {@link retentionDetail} for a worktree with local changes. */
  localWorkRetentionDetail: string;
}

/**
 * Label and confirmation-dialog copy for the two worktree removal actions.
 * Delete retains a restorable archive for `retentionDays` when one can be
 * created; a missing-worktree delete may be permanent. Archive always keeps
 * the available retained state until the user deletes the archive.
 */
export function getWorktreeDeleteLabels(
  mode: WorktreeRemovalMode,
  retentionDays: number,
  branchName: string,
): WorktreeDeleteLabels {
  if (mode === 'archive') {
    return {
      archiveActionLabel: `Archive ${branchName}`,
      standaloneActionLabel: `Archive ${branchName}`,
      dialogTitle: 'Archive worktree?',
      dialogConfirmLabel: 'Archive',
      retentionSummary: 'Kept until you delete the archive.',
      retentionDetail:
        `Archiving removes the worktree from disk and keeps its chats and ` +
        `eligible pipeline history until you delete the archive. When a ` +
        `restorable archive can be created, its Git state is kept too, and ` +
        `restoring recreates that state in a new worktree.`,
      localWorkRetentionDetail:
        `Archiving removes the worktree from disk and keeps its chats and ` +
        `eligible pipeline history until you delete the archive. When a ` +
        `restorable archive can be created, its commits and local changes ` +
        `are kept too, and restoring recreates that state in a new worktree.`,
    };
  }

  const retentionWindow =
    retentionDays === 1 ? '1 day' : `${retentionDays} days`;
  return {
    archiveActionLabel: `Delete ${branchName}`,
    standaloneActionLabel: `Delete ${branchName}`,
    dialogTitle: 'Delete worktree?',
    dialogConfirmLabel: 'Delete',
    retentionSummary: `Restorable for ${retentionWindow} when an archive can be created.`,
    retentionDetail:
      `Deleting removes the worktree from disk and its chat from the sidebar. ` +
      `When a restorable archive can be created, its Git state, chats, and ` +
      `eligible pipeline history are kept for ${retentionWindow}. Otherwise, ` +
      `deletion is permanent.`,
    localWorkRetentionDetail:
      `Deleting removes the worktree from disk and its chat from the ` +
      `sidebar. When a restorable archive can be created, its commits, local ` +
      `changes, chats, and eligible pipeline history are kept for ` +
      `${retentionWindow}. Otherwise, deletion is permanent.`,
  };
}

/**
 * The removal confirmation's branch-choice hint. An App Advisor request names
 * the branch handling it asked for; the hint names that button, but the user
 * still makes the final choice.
 */
export function getWorktreeBranchChoiceHint(
  requestedDeleteBranch?: boolean,
): string {
  const base = 'Choose whether to keep the local Git branch.';
  if (requestedDeleteBranch === undefined) return base;
  return `${base} Advisor suggested ${
    requestedDeleteBranch ? 'Delete local' : 'Preserve local'
  }.`;
}
