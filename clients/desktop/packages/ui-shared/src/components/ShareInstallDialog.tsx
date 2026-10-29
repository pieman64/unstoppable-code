'use client';

import type { JSX, ReactNode } from 'react';
import { DialogModal } from './DialogModal';
import { LoadingButton } from './LoadingButton';

/**
 * The install review for a shared resource (CAN-3710): one small dialog with
 * the item's name and type, who shared it, a short plain-text description, any
 * input the install cannot proceed without, and exactly one primary action.
 *
 * There is no Cancel: the close button, Escape and the backdrop dismiss it,
 * and all three are inert while `busy` so an install is never abandoned
 * halfway. Warnings, opt-ins and dependency lists deliberately have no slot;
 * setup a result still needs is shown where the install lands.
 */

export interface ShareInstallDialogPrimary {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Shows the button's own spinner; `busyLabel` replaces the label meanwhile. */
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly testId?: string;
  readonly spinnerTestId?: string;
}

export interface ShareInstallDialogProps {
  /** The item's name, or a placeholder (`Shared skill`) while it loads. */
  readonly title: ReactNode;
  /** The item's type (`Skill`, `Plugin`, `Project`, …). */
  readonly typeLabel?: string;
  /** Who shared it. A node, so the host can block the person's name from replay. */
  readonly publisher?: ReactNode;
  /** Plain text, clamped to about three lines. */
  readonly description?: string;
  /** Required inputs only, with defaults preselected wherever possible. */
  readonly inputs?: ReactNode;
  /** One line for a genuine blocker or the install's progress. */
  readonly blocker?: ReactNode;
  /** A one-line installed status, shown in place of a blocker. */
  readonly status?: ReactNode;
  readonly statusTestId?: string;
  /** The loading state's body. */
  readonly loading?: ReactNode;
  /** Omitted while there is nothing to do (loading, or a dead end). */
  readonly primary?: ShareInstallDialogPrimary;
  /** The installed ⋯ menu, beside the primary. */
  readonly menu?: ReactNode;
  /** True while the install writes: every close affordance is inert. */
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly dataTestId?: string;
  readonly titleId?: string;
}

export function ShareInstallDialog({
  title,
  typeLabel,
  publisher,
  description,
  inputs,
  blocker,
  status,
  statusTestId = 'share-install-status',
  loading,
  primary,
  menu,
  busy = false,
  onClose,
  dataTestId = 'share-install-dialog',
  titleId = 'share-install-dialog-title',
}: ShareInstallDialogProps): JSX.Element {
  const subtitle =
    typeLabel !== undefined || publisher !== undefined ? (
      <>
        {typeLabel !== undefined && (
          <span data-testid="share-install-type-label">{typeLabel}</span>
        )}
        {typeLabel !== undefined && publisher !== undefined && ' · '}
        {publisher}
      </>
    ) : undefined;
  return (
    <DialogModal
      title={title}
      subtitle={subtitle}
      titleId={titleId}
      maxWidth="md"
      onClose={busy ? (): void => undefined : onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeButtonDisabled={busy}
      headerSpacing="tight"
      headerBorder={false}
      dataTestId={dataTestId}
    >
      <div className="flex flex-col gap-3 px-5 pb-5 pt-2">
        {loading}
        {description !== undefined && description !== '' && (
          <p
            data-testid="share-install-description"
            className="line-clamp-3 text-s fg-secondary"
          >
            {description}
          </p>
        )}
        {inputs !== undefined && inputs !== null && (
          <div
            data-testid="share-install-inputs"
            className="flex flex-col gap-2"
          >
            {inputs}
          </div>
        )}
        {blocker !== undefined && blocker !== null && blocker !== '' && (
          <p
            data-testid="share-install-blocker"
            role="status"
            className="text-s fg-secondary"
          >
            {blocker}
          </p>
        )}
        {status !== undefined && status !== null && status !== '' && (
          <p
            data-testid={statusTestId}
            role="status"
            className="text-s fg-secondary"
          >
            {status}
          </p>
        )}
        {(primary !== undefined || menu !== undefined) && (
          <div className="flex items-center justify-end gap-2 pt-1">
            {menu}
            {primary !== undefined && (
              <LoadingButton
                type="button"
                variant="primary"
                size="lg"
                data-testid={primary.testId ?? 'share-install-primary'}
                disabled={primary.disabled === true}
                loading={primary.busy === true}
                {...(primary.busyLabel !== undefined
                  ? { loadingLabel: primary.busyLabel }
                  : {})}
                {...(primary.spinnerTestId !== undefined
                  ? { spinnerTestId: primary.spinnerTestId }
                  : {})}
                onClick={primary.onClick}
              >
                {primary.label}
              </LoadingButton>
            )}
          </div>
        )}
      </div>
    </DialogModal>
  );
}
