'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import { ConfirmDialog, LoadingSpinner } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface MarketplaceSourceRemoveDialogProps {
  readonly title: ReactNode;
  readonly message: ReactNode;
  readonly busy: boolean;
  readonly progress?: string;
  readonly error?: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly confirmTestId?: string;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

/** The same accessible removal confirmation in new and retained source views. */
export function MarketplaceSourceRemoveDialog({
  title,
  message,
  busy,
  progress,
  error,
  onCancel,
  onConfirm,
  confirmTestId,
  restoreFocusRef,
}: MarketplaceSourceRemoveDialogProps): JSX.Element {
  return (
    <ConfirmDialog
      title={title}
      message={
        <>
          {message}
          {busy && progress && (
            <p
              role="status"
              data-testid="remove-marketplace-progress"
              className="mt-3 flex items-center gap-2 text-xs fg-secondary"
            >
              <LoadingSpinner decorative />
              <span className={REPLAY_BLOCK_CLASS}>{progress}</span>
            </p>
          )}
          {error && (
            <p
              role="alert"
              className={`mt-3 text-s fg-destructive ${REPLAY_BLOCK_CLASS}`}
            >
              {error}
            </p>
          )}
        </>
      }
      confirmLabel="Remove"
      busyLabel="Removing…"
      busy={busy}
      destructive
      focusCancel
      restoreFocusRef={restoreFocusRef}
      dataTestId="marketplace-source-remove-dialog"
      confirmTestId={confirmTestId ?? 'marketplace-source-remove-confirm'}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
