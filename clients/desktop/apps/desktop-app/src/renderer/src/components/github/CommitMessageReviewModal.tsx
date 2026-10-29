import { memo, useState, useCallback, useEffect, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { useGitHubStore } from '@/stores/githubStore';
import { DialogModal } from '@/components/shared/DialogModal';

interface CommitMessageReviewModalProps {
  projectId: string;
  worktreeId: string;
}

export function CommitMessageReviewModalHost(): JSX.Element | null {
  const pendingKey = useGitHubStore(
    (state) => Object.keys(state.commitReviewPending)[0],
  );
  if (!pendingKey) return null;

  const separator = pendingKey.indexOf('/');
  if (separator < 1 || separator === pendingKey.length - 1) return null;

  return (
    <CommitMessageReviewModal
      projectId={pendingKey.slice(0, separator)}
      worktreeId={pendingKey.slice(separator + 1)}
    />
  );
}

export const CommitMessageReviewModal = memo(function CommitMessageReviewModal({
  projectId,
  worktreeId,
}: CommitMessageReviewModalProps): JSX.Element | null {
  const key = `${projectId}/${worktreeId}`;
  const pendingEntry = useGitHubStore(
    useShallow((state) => state.commitReviewPending[key]),
  );

  const [editedMessages, setEditedMessages] = useState<Record<number, string>>(
    {},
  );

  useEffect(() => {
    setEditedMessages({});
  }, [pendingEntry]);

  const handleConfirm = useCallback((): void => {
    if (!pendingEntry) return;
    const messages = pendingEntry.repos.map((repo, index) => ({
      repoId: repo.repoId,
      repoName: repo.repoName,
      message: editedMessages[index] ?? repo.message,
    }));
    useGitHubStore
      .getState()
      .resolveCommitReview(projectId, worktreeId, true, messages);
  }, [pendingEntry, editedMessages, projectId, worktreeId]);

  const handleCancel = useCallback((): void => {
    useGitHubStore.getState().resolveCommitReview(projectId, worktreeId, false);
  }, [projectId, worktreeId]);

  const handleMessageChange = useCallback(
    (index: number, value: string): void => {
      setEditedMessages((prev) => ({ ...prev, [index]: value }));
    },
    [],
  );

  if (!pendingEntry) return null;

  const isMultiRepo = pendingEntry.repos.length > 1;
  const allMessagesValid = pendingEntry.repos.every((repo, index) => {
    const msg = editedMessages[index] ?? repo.message;
    return msg.trim().length > 0;
  });
  const actionLabel = pendingEntry.actionLabel ?? 'Commit & push';

  return (
    <DialogModal
      onClose={handleCancel}
      title="Review commit messages"
      subtitle={
        isMultiRepo
          ? `${pendingEntry.repos.length} repositories will be committed`
          : undefined
      }
      maxWidth="xl"
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-5">
        {pendingEntry.repos.map((repo, index) => (
          <div
            key={repo.repoId ?? repo.repoName}
            className="flex flex-col gap-1.5"
          >
            {isMultiRepo && (
              <label className="text-xs font-medium fg-secondary">
                {repo.repoName}
              </label>
            )}
            <textarea
              className="min-h-25 w-full resize-y rounded-md border bg-secondary/50 px-3 py-2 text-s fg-primary placeholder:fg-secondary focus:border-line-accent focus:outline-none focus:ring-1 focus:ring-line-accent"
              value={editedMessages[index] ?? repo.message}
              onChange={(e) => handleMessageChange(index, e.target.value)}
              placeholder="Enter commit message…"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t p-4">
        <button
          type="button"
          onClick={handleCancel}
          className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-xs font-medium fg-primary transition hover:bg-secondary/80"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!allMessagesValid}
          className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:bg-accent/90 disabled:opacity-60"
        >
          {actionLabel}
        </button>
      </div>
    </DialogModal>
  );
});
