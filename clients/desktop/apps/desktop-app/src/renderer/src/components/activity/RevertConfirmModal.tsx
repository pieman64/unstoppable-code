import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  ActivityFileDiffResponse,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { DiffContentView } from './DiffContentView';

interface RevertConfirmModalProps {
  file: ChangedFileInfo;
  projectId: string;
  worktreeId: string;
  reverting: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function displayPath(file: ChangedFileInfo): string {
  const path = file.repoName ? `${file.repoName}/${file.path}` : file.path;
  if (file.status === 'renamed' && file.previousPath) {
    const prev = file.repoName
      ? `${file.repoName}/${file.previousPath}`
      : file.previousPath;
    return `${prev} → ${path}`;
  }
  return path;
}

export function RevertConfirmModal({
  file,
  projectId,
  worktreeId,
  reverting,
  error,
  onConfirm,
  onCancel,
}: RevertConfirmModalProps): JSX.Element {
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] =
    useState<ActivityFileDiffResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);

    void window.api.activity
      .getFileDiff({
        projectId,
        worktreeId,
        filePath: file.path,
        source: 'uncommitted',
        repoId: file.repoId,
      })
      .then((result: ActivityFileDiffResponse) => {
        if (cancelled) return;
        setPreviewData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreviewError(
          err instanceof Error ? err.message : 'Failed to load diff preview',
        );
      })
      .finally(() => {
        if (cancelled) return;
        setPreviewLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [file.path, file.repoId, projectId, worktreeId]);

  const handleTogglePreview = useCallback((): void => {
    setPreviewExpanded((prev) => !prev);
  }, []);

  const warningText =
    file.status === 'unmerged'
      ? 'This will discard merge conflict markers and restore the HEAD version. This action cannot be undone.'
      : 'This will permanently discard all uncommitted changes to this file. This action cannot be undone.';

  return (
    <DialogModal
      onClose={onCancel}
      title="Revert file"
      subtitle={displayPath(file)}
      maxWidth="xl"
      dataTestId="revert-confirm-modal"
    >
      <div className="flex flex-col gap-4 p-5 pt-3">
        <p className="text-s fg-secondary">{warningText}</p>

        <div className="flex items-center gap-3 text-xs">
          <span className="fg-success-strong">+{file.insertions}</span>
          <span className="fg-destructive-strong">-{file.deletions}</span>
        </div>

        <div>
          <button
            type="button"
            className="text-xs fg-secondary transition-colors hover:fg-primary"
            onClick={handleTogglePreview}
          >
            {previewExpanded ? 'Hide diff preview' : 'Show diff preview'}
          </button>
          <div
            className={`mt-2 max-h-75 overflow-auto rounded-lg border ${previewExpanded ? '' : 'hidden'}`}
          >
            {previewError ? (
              <p className="p-3 text-xs fg-destructive">{previewError}</p>
            ) : (
              <DiffContentView
                oldValue={previewData?.oldValue ?? ''}
                newValue={previewData?.newValue ?? ''}
                viewMode="unified"
                loading={previewLoading}
                truncated={previewData?.truncated ?? false}
                binary={previewData?.binary ?? false}
                imagePreview={previewData?.imagePreview}
              />
            )}
          </div>
        </div>

        {error && <p className="text-xs fg-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="focus-ring rounded-lg border px-4 py-2 text-s fg-primary transition-colors hover:bg-secondary"
            onClick={onCancel}
            disabled={reverting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="focus-ring rounded-lg bg-destructive px-4 py-2 text-s fg-emphasis transition-colors hover:bg-destructive/90 disabled:opacity-50"
            onClick={onConfirm}
            disabled={reverting}
            data-testid="revert-confirm-btn"
          >
            {reverting ? 'Reverting…' : 'Revert'}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}
