import type { JSX } from 'react';
import { WorktreeRemovalDialog } from '@canopy/ui-shared/components';
import type { DiffStats } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  getWorktreeBranchChoiceHint,
  type WorktreeDeleteLabels,
} from '@canopy/ui-app';

/** The row identity a removal confirmation was opened for. */
export interface WorktreeArchiveConfirmationTarget {
  workspaceId: string;
  workspaceName: string;
  worktreeId: string;
  worktreeName: string;
  worktreeCreatedAt: string;
  branchName: string;
}

export interface WorktreeRemovalConfirmDialogProps {
  target: WorktreeArchiveConfirmationTarget;
  labels: WorktreeDeleteLabels;
  hasLocalWork: boolean;
  hasLineChanges: boolean;
  stats?: DiffStats;
  archiveInProgress: boolean;
  /** Removal cannot run (active session, split lock, identity drift). */
  blocked: boolean;
  /**
   * The branch handling an App Advisor request asked for. It presets the
   * branch switch and the note names it; the user still makes the final choice.
   */
  requestedDeleteBranch?: boolean;
  /** Suffix for the automation ids on a pinned row copy. */
  testIdSuffix?: string;
  onCancel: () => void;
  onConfirm: (deleteBranch: boolean) => void;
}

/**
 * Desktop's worktree removal confirmation: the shared dialog plus the App
 * Advisor UI-state report for the row being removed. Both the shared rail
 * host and the legacy worktree row render it.
 */
export function WorktreeRemovalConfirmDialog({
  target,
  labels,
  hasLocalWork,
  hasLineChanges,
  stats,
  archiveInProgress,
  blocked,
  requestedDeleteBranch,
  testIdSuffix = '',
  onCancel,
  onConfirm,
}: WorktreeRemovalConfirmDialogProps): JSX.Element {
  useCurrentUiStateReporter(`worktree.archiveDialog.${target.worktreeId}`, {
    open: true,
    workspaceId: target.workspaceId,
    worktreeId: target.worktreeId,
    branchName: target.branchName,
    archiveInProgress,
    blocked,
  });
  return (
    <WorktreeRemovalDialog
      confirmLabel={labels.dialogConfirmLabel}
      destructive={labels.dialogDestructive}
      identity={{
        workspaceName: target.workspaceName,
        worktreeName: target.worktreeName,
        worktreeId: target.worktreeId,
        branchName: target.branchName,
      }}
      localChanges={
        hasLocalWork
          ? hasLineChanges
            ? {
                insertions: stats?.insertions ?? 0,
                deletions: stats?.deletions ?? 0,
              }
            : {}
          : undefined
      }
      retentionSummary={labels.retentionSummary}
      retentionDetail={
        hasLocalWork ? labels.localWorkRetentionDetail : labels.retentionDetail
      }
      branchChoiceHint={getWorktreeBranchChoiceHint(requestedDeleteBranch)}
      requestedDeleteBranch={requestedDeleteBranch}
      disabled={blocked || archiveInProgress}
      testIdSuffix={testIdSuffix}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
