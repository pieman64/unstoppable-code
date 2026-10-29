import { useEffect, type JSX } from 'react';
import { DialogModal } from '@/components/shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useIsWorktreeSurfaceVisible } from '@/lib/worktreeSurfaceVisibility';
import { useBaseBranchChangeStore } from '@/stores/baseBranchChangeStore';

export function BaseBranchChangeConfirmationModalHost(): JSX.Element | null {
  const request = useBaseBranchChangeStore((state) => state.pending);
  const visible = useIsWorktreeSurfaceVisible(request);
  const pending = visible ? request : null;
  const resolveConfirmation = useBaseBranchChangeStore(
    (state) => state.resolveConfirmation,
  );
  // Only ask while the worktree is on screen; otherwise the change must not
  // wait on the user, so it applies locally and leaves the PR untouched.
  useEffect(() => {
    if (request && !visible) resolveConfirmation('local-only');
  }, [request, visible, resolveConfirmation]);
  useCurrentUiStateReporter(
    'worktree.baseBranchChangeConfirmationModal',
    pending
      ? {
          open: true,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          ...(pending.repoId ? { repoId: pending.repoId } : {}),
          baseBranch: pending.baseBranch,
          prNumber: pending.prNumber,
        }
      : null,
  );
  if (!pending) return null;

  return (
    <DialogModal
      onClose={() => resolveConfirmation(null)}
      title="Update PR base branch?"
      maxWidth="sm"
      dataTestId="base-branch-change-confirmation"
    >
      <div className="flex flex-col gap-3 px-5 pb-5 text-s fg-primary">
        <p className="fg-secondary">
          {pending.repoName} has open PR #{pending.prNumber}. Would you also
          like to update its PR base branch to{' '}
          <strong>{pending.baseBranch}</strong>?
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => resolveConfirmation('local-only')}
            className="focus-ring rounded-md border px-3 py-1.5 text-xs font-medium fg-primary/80 transition hover:bg-fg-primary/5"
          >
            No, just locally
          </button>
          <button
            type="button"
            onClick={() => resolveConfirmation('update-pr')}
            className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:bg-accent/90"
          >
            Yes, update PR
          </button>
        </div>
      </div>
    </DialogModal>
  );
}
