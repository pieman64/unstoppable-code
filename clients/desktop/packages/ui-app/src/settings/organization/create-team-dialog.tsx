'use client';

import { useState, type FormEvent, type JSX } from 'react';
import { DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { createOrganization } from './team-api';

/** Failures of `organization.create` that have their own copy. */
const CREATE_ORGANIZATION_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The viewer already owns as many organizations as their limit allows.
    status: 409,
    copy: "You've reached the limit of organizations you can own. Delete one you no longer use, then try again.",
  },
];

interface CreateTeamDialogProps {
  onClose: () => void;
  /** Invoked with the freshly created org so the caller can navigate to it. */
  onCreated: (detail: OrganizationDetail) => void;
}

/**
 * Modal form for creating a new organization (Organization). Any ACTIVE user
 * may create one and becomes its OWNER. On success the parent navigates to the
 * new `/organization/[orgId]` route.
 */
export function CreateTeamDialog({
  onClose,
  onCreated,
}: CreateTeamDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organizations');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const detail = await createOrganization(client, trimmed);
      onCreated(detail);
    } catch (err) {
      setError(
        errorCopy.actionCopy(err, {
          action: 'create the organization',
          known: CREATE_ORGANIZATION_KNOWN_ERRORS,
        }),
      );
      setSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={onClose}
      title="Create an organization"
      subtitle="Spin up a shared space for your collaborators. You'll be its owner."
      maxWidth="md"
      dataTestId="create-team-dialog"
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 px-5 pb-5 pt-4"
      >
        <ErrorBanner error={error} />
        <label className="flex flex-col gap-1 text-s fg-secondary">
          <span className="font-medium fg-primary">Organization name</span>
          <input
            type="text"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Engineering"
            data-testid="create-team-name-input"
            className="rounded-md border bg-card px-3 py-2 text-s fg-primary"
          />
        </label>
        {/* No Cancel: the dialog closes from its X, Escape, or the backdrop. */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="create-team-submit"
            className="rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create organization'}
          </button>
        </div>
      </form>
    </DialogModal>
  );
}
