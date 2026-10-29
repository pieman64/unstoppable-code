'use client';

import {
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Confirmation for removing an installed item (CAN-4255), shared by the
 * installed-item Status row and the ⋯ menu beside an installed share.
 *
 * Focus lands on Cancel so a reflexive Enter backs out. The confirm button
 * reads `Uninstall`, then `Uninstalling…` while the host writes; a repeated
 * confirm during that write is ignored. A failure keeps the dialog open with
 * its message so the user can retry or cancel.
 */

export interface UninstallConfirmDialogProps {
  readonly title: ReactNode;
  /** What removal does for this item, in the backend's own words. */
  readonly message: ReactNode;
  /**
   * Performs the removal. Resolve `null` on success, or the failure copy to
   * keep the dialog open. A rejection shows `fallbackErrorMessage`.
   */
  readonly onConfirm: () => Promise<string | null>;
  readonly onCancel: () => void;
  /** Called after a confirmed removal; the host closes the dialog here. */
  readonly onUninstalled: () => void;
  readonly fallbackErrorMessage?: string;
  readonly dataTestId?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function UninstallConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  onUninstalled,
  fallbackErrorMessage = 'Could not uninstall. Try again.',
  dataTestId = 'uninstall-confirm-dialog',
  confirmTestId = 'uninstall-confirm-dialog-confirm',
  cancelTestId = 'uninstall-confirm-dialog-cancel',
  restoreFocusRef,
}: UninstallConfirmDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    let failure: string | null;
    try {
      failure = await onConfirm();
    } catch {
      failure = fallbackErrorMessage;
    }
    inFlightRef.current = false;
    setBusy(false);
    if (failure === null) {
      onUninstalled();
      return;
    }
    setError(failure);
  };

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel="Uninstall"
      busyLabel="Uninstalling…"
      busy={busy}
      destructive
      focusCancel
      errorMessage={error}
      dataTestId={dataTestId}
      confirmTestId={confirmTestId}
      cancelTestId={cancelTestId}
      restoreFocusRef={restoreFocusRef}
      onConfirm={(): void => {
        void confirm();
      }}
      onCancel={(): void => {
        if (busy) return;
        setError(null);
        onCancel();
      }}
    />
  );
}
