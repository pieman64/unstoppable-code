import { memo, useCallback, type JSX } from 'react';
import type { RepoBranchInfo } from '@canopy/desktop-shared/types';
import { Button } from '@canopy/ui-shared';
import { DialogModal } from '@/components/shared/DialogModal';

interface LocalOnlyMergeConfirmationModalProps {
  /**
   * The set of local-only repos that are eligible to merge. Each is rendered
   * as `<repoName>: <branch> -> <baseBranch>` in the modal body. The plan
   * requires both `branch` and `baseBranch` to be populated by the caller
   * (the worktree-level synthetic info or per-repo `RepoBranchInfo`).
   */
  candidates: RepoBranchInfo[];
  isSubmitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export const LocalOnlyMergeConfirmationModal = memo(
  function LocalOnlyMergeConfirmationModal({
    candidates,
    isSubmitting,
    onConfirm,
    onClose,
  }: LocalOnlyMergeConfirmationModalProps): JSX.Element {
    const handleConfirm = useCallback((): void => {
      if (isSubmitting) return;
      onConfirm();
    }, [isSubmitting, onConfirm]);

    return (
      <DialogModal
        inset="flush"
        onClose={isSubmitting ? (): void => undefined : onClose}
        title="Merge local branches?"
        maxWidth="md"
        closeOnBackdrop={!isSubmitting}
      >
        <div className="flex flex-col gap-3 p-6 text-s fg-primary">
          <p>
            These local-only repos will be merged into their default branch. The
            worktree branch will not be deleted.
          </p>
          <ul className="flex flex-col gap-1 rounded-md border bg-secondary/30 p-3 font-mono text-xs">
            {candidates.map((repo) => (
              <li key={repo.repoId} className="truncate fg-primary/80">
                <span className="font-semibold">{repo.repoName}</span>:{' '}
                <span>{repo.branch}</span>
                <span className="px-1 fg-secondary">{'->'}</span>
                <span>{repo.baseBranch ?? '(default)'}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-end gap-2 border-t p-4">
          <Button
            variant="secondary"
            size="compact"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Merging…' : 'Merge'}
          </Button>
        </div>
      </DialogModal>
    );
  },
);
