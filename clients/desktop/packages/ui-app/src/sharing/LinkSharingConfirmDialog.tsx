import type { JSX } from 'react';
import { DialogModal } from '@canopy/ui-shared/components';

/**
 * Confirmation before an owner takes access away from people who opened a
 * share with its link: turning the link off, resetting it, or limiting it to
 * the organization.
 *
 * A sibling of `RemovePublicLinkConfirmDialog`, not a variant of it: "Public"
 * is reserved for the invite-by-email audience, and link sharing copy always
 * talks about "the link".
 */

export type LinkSharingConfirmVariant = 'off' | 'reset' | 'narrow';

interface LinkSharingConfirmCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
}

const CANCEL_LABEL = 'Cancel';

/** The dialog's copy for one variant. Exported for host tests and parity. */
export function linkSharingConfirmCopy(
  variant: LinkSharingConfirmVariant,
  organizationName: string,
): LinkSharingConfirmCopy {
  if (variant === 'off') {
    return {
      title: 'Turn off link?',
      body: 'Anyone who opened it with this link will lose access. People you invited stay.',
      confirmLabel: 'Turn off link',
      busyLabel: 'Turning off…',
    };
  }
  if (variant === 'reset') {
    return {
      title: 'Reset link?',
      body: 'The current link will stop working, and anyone who opened it with the link will lose access. People you invited stay.',
      confirmLabel: 'Reset link',
      busyLabel: 'Resetting…',
    };
  }
  return {
    title: `Limit link to ${organizationName}?`,
    body: `People outside ${organizationName} who opened it with this link will lose access.`,
    confirmLabel: 'Limit access',
    busyLabel: 'Limiting…',
  };
}

export interface LinkSharingConfirmDialogProps {
  readonly variant: LinkSharingConfirmVariant;
  /** Owning organization, named by the `narrow` variant. */
  readonly organizationName: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** True while the change is in flight. */
  readonly busy?: boolean;
  /** Test-id prefix of the owning share dialog. */
  readonly testIdPrefix: string;
  /** Document that owns the modal portal/focus trap. */
  readonly ownerDocument?: Document;
}

export function LinkSharingConfirmDialog({
  variant,
  organizationName,
  onCancel,
  onConfirm,
  busy = false,
  testIdPrefix,
  ownerDocument,
}: LinkSharingConfirmDialogProps): JSX.Element {
  const p = testIdPrefix;
  const copy = linkSharingConfirmCopy(variant, organizationName);
  return (
    <DialogModal
      onClose={busy ? (): void => {} : onCancel}
      title={copy.title}
      maxWidth="sm"
      closeOnBackdrop={!busy}
      dataTestId={`${p}-link-confirm`}
      ownerDocument={ownerDocument}
    >
      <div className="px-5 py-4">
        <p
          className="text-s fg-secondary"
          data-testid={`${p}-link-confirm-body`}
        >
          {copy.body}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid={`${p}-link-confirm-cancel`}
          className="rounded-lg px-4 py-1.5 text-s fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {CANCEL_LABEL}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid={`${p}-link-confirm-action`}
          data-variant={variant}
          className="rounded-lg bg-destructive px-4 py-1.5 text-s font-medium fg-emphasis transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? copy.busyLabel : copy.confirmLabel}
        </button>
      </div>
    </DialogModal>
  );
}
