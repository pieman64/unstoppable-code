import { type JSX, type ReactNode } from 'react';
import { Button } from './Button';
import { DialogModal } from './DialogModal';

interface DeleteConfirmModalProps {
  title: string;
  /** Body shown above the action buttons. Strings render in muted-foreground. */
  message: ReactNode;
  confirmLabel?: string;
  /** Label shown while the confirm callback is pending. */
  pendingLabel?: string;
  pending?: boolean;
  /** Inline error rendered above the action row. */
  error?: string | null;
  /**
   * Visual tone of the confirm button. Defaults to `destructive` (red) for the
   * common delete/remove case; use `primary` for non-destructive confirmations
   * (e.g. sign out) so the danger affordance isn't misleading.
   */
  confirmTone?: 'destructive' | 'primary';
  /** Stable test ID placed on the dialog card element. */
  dataTestId?: string;
  /** Stable test ID placed on the confirmation button. */
  confirmTestId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  pendingLabel = 'Deleting…',
  pending = false,
  error,
  confirmTone = 'destructive',
  dataTestId,
  confirmTestId,
  onConfirm,
  onCancel,
}: DeleteConfirmModalProps): JSX.Element {
  return (
    <DialogModal
      onClose={pending ? (): void => {} : onCancel}
      title={title}
      maxWidth="md"
      headerBorder={false}
      closeOnBackdrop={!pending}
      dataTestId={dataTestId}
    >
      <div className="flex flex-col gap-4 px-5 pb-5">
        {typeof message === 'string' ? (
          <p className="text-s fg-secondary">{message}</p>
        ) : (
          message
        )}

        {error && <p className="text-xs fg-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant={confirmTone}
            size="lg"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
