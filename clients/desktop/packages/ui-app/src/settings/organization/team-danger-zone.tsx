'use client';

import { useState, type JSX } from 'react';
import { DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { deleteOrganization } from './team-api';

/** Failures of `organization.delete` that have their own copy. */
const DELETE_ORGANIZATION_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // A live (active, past-due or unpaid) subscription blocks the delete.
    status: 409,
    copy: "Couldn't delete this organization while it has a live subscription. Cancel the subscription in Billing, then try again.",
  },
];

interface TeamDangerZoneProps {
  detail: OrganizationDetail;
  /** Called after the org is deleted so the page can navigate away. */
  onDeleted: () => void;
}

/**
 * OWNER-only panel at the bottom of the team page for deleting the organization.
 * Returns `null` for non-owners so the destructive action is never rendered
 * for members or admins.
 */
export function TeamDangerZone({
  detail,
  onDeleted,
}: TeamDangerZoneProps): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.delete');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detail.viewerRole !== 'OWNER') {
    return null;
  }

  const handleDelete = async (): Promise<void> => {
    try {
      setDeleting(true);
      setError(null);
      await deleteOrganization(client, detail.id);
      onDeleted();
    } catch (err) {
      setError(
        errorCopy.actionCopy(err, {
          action: 'delete the organization',
          known: DELETE_ORGANIZATION_KNOWN_ERRORS,
        }),
      );
      setDeleting(false);
      // Close the dialog on failure. The ErrorBanner renders in the section
      // behind the modal, so leaving the dialog open hides the reason the
      // delete was refused (e.g. the 409 for a live subscription).
      setConfirmingDelete(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-line-destructive/40 bg-destructive/5 p-8"
      data-testid="team-danger-zone"
    >
      <ErrorBanner className="mb-4" error={error} />

      <h2 className="text-xl font-semibold fg-primary">Danger zone</h2>
      <p className="mt-1 text-s fg-secondary">
        Deleting this organization removes access for everyone in it, along with
        its teams, pending invites, and settings. Billing and usage history is
        kept for your records. If the organization has an active subscription,
        cancel it first. You cannot get the organization back.
      </p>
      <button
        type="button"
        onClick={() => setConfirmingDelete(true)}
        data-testid="team-delete"
        className="mt-4 rounded-md border border-line-destructive px-3 py-2 text-s font-medium fg-destructive transition-colors hover:bg-destructive hover:fg-emphasis"
      >
        Delete organization
      </button>

      {confirmingDelete && (
        <DialogModal
          onClose={() => (deleting ? undefined : setConfirmingDelete(false))}
          title="Delete this organization?"
          subtitle={`“${detail.name}” will stop being available to you and everyone else in it. Billing and usage history is kept, and this cannot be reversed.`}
          maxWidth="md"
          dataTestId="team-delete-dialog"
        >
          <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-4">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
              className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting}
              data-testid="team-delete-confirm"
              className="rounded-md bg-destructive px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete organization'}
            </button>
          </div>
        </DialogModal>
      )}
    </section>
  );
}
