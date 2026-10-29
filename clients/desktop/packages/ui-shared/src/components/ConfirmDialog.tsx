'use client';

import { useRef, type JSX, type ReactNode, type RefObject } from 'react';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { LoadingSpinner } from './LoadingSpinner';

export interface ConfirmDialogProps {
  /** A node, so a caller can mask a user-authored name for session replay. */
  readonly title: ReactNode;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly busyLabel?: string;
  readonly busy?: boolean;
  /**
   * Failure text for a confirm handler that rejected. Rendering it keeps the
   * dialog open so the action can be retried, instead of dismissing on a
   * failure the user never saw.
   */
  readonly errorMessage?: string | null;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  /** Overrides the default confirm-button test id for multi-instance isolation. */
  readonly confirmTestId?: string;
  readonly onCancel: () => void;
  readonly dataTestId?: string;
  /** Overrides the cancel-button test id. */
  readonly cancelTestId?: string;
  /**
   * Contain Tab inside the dialog and land initial focus on Cancel, so a
   * reflexive Enter backs out instead of committing. Off by default for
   * existing callers.
   */
  readonly focusCancel?: boolean;
  /**
   * Where focus goes on close when confirming destroys the control that
   * opened this dialog (revoking a key, removing a member). Point it at a
   * stable ancestor so keyboard users resume somewhere meaningful.
   */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  errorMessage,
  destructive = false,
  onConfirm,
  onCancel,
  dataTestId,
  confirmTestId = 'confirm-dialog-confirm',
  cancelTestId,
  focusCancel = false,
  restoreFocusRef,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <DialogModal
      onClose={busy ? (): void => undefined : onCancel}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={title}
      maxWidth="md"
      dataTestId={dataTestId}
      trapFocus={focusCancel}
      initialFocusRef={focusCancel ? cancelRef : undefined}
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        <div className="text-s fg-secondary">{message}</div>
        {errorMessage && (
          <div
            role="alert"
            data-testid="confirm-dialog-error"
            className="text-s fg-destructive"
          >
            {errorMessage}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            size="lg"
            onClick={onCancel}
            disabled={busy}
            data-testid={cancelTestId}
          >
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            size="lg"
            onClick={onConfirm}
            disabled={busy}
            // The spinner is `decorative` (aria-hidden), and a caller that
            // passes no `busyLabel` leaves the label unchanged — so without
            // this a screen-reader user would get no signal that work started
            // beyond the button going disabled.
            aria-busy={busy}
            data-testid={confirmTestId}
          >
            {/* CAN-2349 decision 5: every async step reports progress with a
                spinner, never a bare label swap. The spinner renders INSIDE the
                button that started the work — leading, before the label — so the
                affordance the user pressed is the thing that reports progress.
                `busyLabel` semantics are unchanged, so no caller has to move;
                this lands the spinner on the #2487 cross-harness continue dialog
                and every other `ConfirmDialog` caller in one place. */}
            {busy && (
              <LoadingSpinner
                className="shrink-0"
                dataTestId="confirm-dialog-spinner"
                decorative
              />
            )}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
