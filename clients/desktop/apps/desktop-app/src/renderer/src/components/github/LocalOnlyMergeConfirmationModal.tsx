import { memo, useCallback, type JSX } from 'react';
import type { RepoBranchInfo } from '@canopy/desktop-shared/types';
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
        onClose={isSubmitting ? (): void => undefined : onClose}
        title="Merge local branches?"
        maxWidth="md"
        closeOnBackdrop={!isSubmitting}
      >
        <div className="flex flex-col gap-3 p-5 text-s fg-primary">
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
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-xs font-medium fg-primary transition hover:bg-secondary/80 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:bg-accent/90 disabled:opacity-60"
          >
            {isSubmitting ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </DialogModal>
    );
  },
);
