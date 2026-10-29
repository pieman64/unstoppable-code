import { type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '../shared';
import type { TeardownFailedError } from '@/stores/projectsStore';

interface TeardownFailureDialogProps {
  error: TeardownFailedError;
  onRetry: () => void;
  onForceDelete: () => void;
  onCancel: () => void;
  isRetrying?: boolean;
}

export function TeardownFailureDialog({
  error,
  onRetry,
  onForceDelete,
  onCancel,
  isRetrying,
}: TeardownFailureDialogProps): JSX.Element {
  return (
    <DialogModal
      onClose={onCancel}
      title="Teardown failed"
      titleId="teardown-failure-title"
      maxWidth="lg"
    >
      <div className="p-5 space-y-4">
        {error.repoName && (
          <p className="text-s fg-primary">
            Teardown script failed for repo{' '}
            <span className="font-medium">{error.repoName}</span>.
          </p>
        )}
        {!error.repoName && (
          <p className="text-s fg-primary">Teardown script failed.</p>
        )}
        {error.timedOut && (
          <p className="text-s fg-warning">
            The script timed out and was terminated.
          </p>
        )}
        {error.output.trim() && (
          <div
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} max-h-48 overflow-auto rounded-md border bg-secondary/30 p-3`}
          >
            <pre className="whitespace-pre-wrap break-words text-xs fg-secondary font-mono">
              {error.output}
            </pre>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded-md px-3 py-1.5 text-xs fg-secondary hover:fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onForceDelete}
            className="focus-ring rounded-md bg-destructive-subtle px-3 py-1.5 text-xs font-medium fg-destructive hover:bg-destructive-subtle/80"
          >
            Force delete
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis disabled:opacity-60"
          >
            {isRetrying ? 'Retrying…' : 'Retry teardown'}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}
