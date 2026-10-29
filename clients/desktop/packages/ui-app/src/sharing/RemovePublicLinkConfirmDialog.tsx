import type { JSX } from 'react';
import { DialogModal } from '@canopy/ui-shared/components';

/**
 * Confirmation before an owner unpublishes a public share. Removing the link
 * is destructive for everyone holding it, and the resource also leaves shared
 * lists (a share without a public link is hidden), so the consequence is
 * spelled out before anything happens.
 */

const TITLE = 'Remove public link?';
const BODY_LEAVES_LISTS =
  "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.";
/** A team or organization share keeps its audience; only the link goes. */
const BODY_KEEPS_AUDIENCE =
  'Anyone with the link will lose access. People it is shared with keep access.';
const CANCEL_LABEL = 'Cancel';
const CONFIRM_LABEL = 'Remove link';
const CONFIRM_BUSY_LABEL = 'Removing…';

interface RemovePublicLinkConfirmDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the removal is in flight. */
  busy?: boolean;
  /** Test-id prefix of the owning share dialog. */
  testIdPrefix: string;
  /** Document that owns the modal portal/focus trap. */
  ownerDocument?: Document;
  /**
   * True when removing the link leaves the resource private-only, which also
   * takes it out of shared lists. False for a team or organization share.
   */
  leavesSharedLists?: boolean;
}

export function RemovePublicLinkConfirmDialog({
  onCancel,
  onConfirm,
  busy = false,
  testIdPrefix,
  ownerDocument,
  leavesSharedLists = true,
}: RemovePublicLinkConfirmDialogProps): JSX.Element {
  const p = testIdPrefix;
  return (
    <DialogModal
      onClose={busy ? (): void => {} : onCancel}
      title={TITLE}
      maxWidth="sm"
      closeOnBackdrop={!busy}
      dataTestId={`${p}-remove-public-link-confirm`}
      ownerDocument={ownerDocument}
    >
      <div className="px-5 py-4">
        <p className="text-s fg-secondary">
          {leavesSharedLists ? BODY_LEAVES_LISTS : BODY_KEEPS_AUDIENCE}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid={`${p}-remove-public-link-cancel`}
          className="rounded-lg px-4 py-1.5 text-s fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {CANCEL_LABEL}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid={`${p}-remove-public-link-confirm-action`}
          className="rounded-lg bg-destructive px-4 py-1.5 text-s font-medium fg-emphasis transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? CONFIRM_BUSY_LABEL : CONFIRM_LABEL}
        </button>
      </div>
    </DialogModal>
  );
}
