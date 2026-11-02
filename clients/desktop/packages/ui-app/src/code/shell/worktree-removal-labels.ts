import { ORCHESTRATOR_LABEL } from '@canopy/protocol';

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
  /** Confirmation dialog heading without a name, for batch and generic copy. */
  dialogTitle: string;
  /**
   * Confirmation dialog action, a verb and noun. The dialog's title repeats
   * it as a question naming the worktree: `Delete worktree “owl”?`.
   */
  dialogConfirmLabel: string;
  /**
   * The action takes the destructive role: Delete can end in losing the work
   * for good, while Archive keeps it until the archive is deleted.
   */
  dialogDestructive: boolean;
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
      dialogConfirmLabel: 'Archive worktree',
      dialogDestructive: false,
      retentionSummary: 'Kept until you delete the archive.',
      retentionDetail:
        `Archiving removes the worktree from disk and keeps its chats and ` +
        `eligible workflow history until you delete the archive. When a ` +
        `restorable archive can be created, its Git state is kept too, and ` +
        `restoring recreates that state in a new worktree.`,
      localWorkRetentionDetail:
        `Archiving removes the worktree from disk and keeps its chats and ` +
        `eligible workflow history until you delete the archive. When a ` +
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
    dialogConfirmLabel: 'Delete worktree',
    dialogDestructive: true,
    retentionSummary: `Restorable for ${retentionWindow} when an archive can be created.`,
    retentionDetail:
      `Deleting removes the worktree from disk and its chat from the sidebar. ` +
      `When a restorable archive can be created, its Git state, chats, and ` +
      `eligible workflow history are kept for ${retentionWindow}. Otherwise, ` +
      `deletion is permanent.`,
    localWorkRetentionDetail:
      `Deleting removes the worktree from disk and its chat from the ` +
      `sidebar. When a restorable archive can be created, its commits, local ` +
      `changes, chats, and eligible workflow history are kept for ` +
      `${retentionWindow}. Otherwise, deletion is permanent.`,
  };
}

/**
 * The removal confirmation's note under its Keep the local branch switch. An
 * App Advisor request presets the switch and names what it asked for; the
 * user still makes the final choice. Without a request there is no note.
 */
export function getWorktreeBranchChoiceHint(
  requestedDeleteBranch?: boolean,
): string | null {
  if (requestedDeleteBranch === undefined) return null;
  return requestedDeleteBranch
    ? `${ORCHESTRATOR_LABEL} suggested deleting it.`
    : `${ORCHESTRATOR_LABEL} suggested keeping it.`;
}
