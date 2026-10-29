import { useEffect, useEffectEvent, useState, type JSX } from 'react';
import { DialogModal } from '@/components/shared/DialogModal';

interface ResetToPointDialogProps {
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ResetToPointDialog({
  onConfirm,
  onCancel,
}: ResetToPointDialogProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useEffectEvent(async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revert turn');
      setSubmitting(false);
    }
  });

  const handleCancel = useEffectEvent((): void => {
    if (submitting) {
      return;
    }
    onCancel();
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleConfirm();
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
    // handleCancel and handleConfirm are useEffectEvent-stable; React's
    // exhaustive-deps rule does not require them in deps, and listing them
    // would falsely imply the effect should re-register on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DialogModal
      onClose={handleCancel}
      title="Revert this turn?"
      maxWidth="md"
      headerBorder={false}
      dataTestId="reset-to-point-dialog"
    >
      <div className="flex flex-col gap-4 px-5 pb-5">
        <p className="text-s fg-secondary">
          Roll back code changes from this turn onward? Chat history is
          preserved.
        </p>

        {error && <p className="text-xs fg-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="focus-ring rounded-lg border px-4 py-2 text-s fg-primary transition-colors hover:bg-secondary"
            onClick={handleCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="focus-ring rounded-lg bg-destructive px-4 py-2 text-s fg-emphasis transition-colors hover:bg-destructive/90 disabled:opacity-50"
            onClick={(): void => {
              void handleConfirm();
            }}
            disabled={submitting}
            data-testid="reset-to-point-confirm-btn"
          >
            {submitting ? 'Reverting…' : 'Revert'}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}
